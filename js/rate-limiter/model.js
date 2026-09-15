/**
 * Rate Limiter Simulation Model
 *
 * MODELING ARCHITECTURE: IDENTITY-CLASS SIMULATION
 * Rather than simulating thousands of individual Redis keys in browser memory,
 * this causal engine models distributed traffic using 3 canonical identity cohorts:
 *   1. 'normal': Baseline users operating well within limits (N - heavy - 1)
 *   2. 'heavy':  Power users (top 1%) operating near limit boundaries
 *   3. 'top':    The highest-volume identity (or abusive actor) generating topIdentityRatio of traffic
 *
 * Each class maintains deterministic state (token bucket tokens, refill timestamps,
 * window counts) of a representative identity, scaled by the identity count in that cohort.
 *
 * CAUSAL PRINCIPLES IMPLEMENTED:
 *  1. Persistent Token Bucket: stateful tokens, capacity, refill rate, and timestamps across ticks.
 *  2. Traffic vs Identity: Total traffic != per-identity traffic. Total offered traffic is preserved.
 *  3. Distributed State: Local memory has independent state per gateway (leaks global limit);
 *     Redis provides shared coordination across gateways (storage/coordination, not algorithm).
 *  4. Atomicity: Non-atomic (READ-then-WRITE) race overflow vs atomic (Redis Lua script: atomic check + increment + decision) strict bounds.
 *  5. Independent Bottlenecks: Gateway, Rate Limiter, Redis Shard, Downstream, and Policy (429).
 *  6. Fail Policy: Redis outage with fail-open allows traffic; fail-closed returns HTTP 503 (never 500).
 */

import { RL_ASSUMPTIONS, decomposeTraffic } from './config.js';

/* ── Helper ── */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class RateLimiterModel {
  constructor(assumptions) {
    this.cfg = { ...RL_ASSUMPTIONS, ...(assumptions || {}) };

    /* Persisted algorithm state per identity class */
    this.identityState = {
      normal: this._freshIdentityState(200, 100),
      heavy:  this._freshIdentityState(200, 100),
      top:    this._freshIdentityState(200, 100),
    };

    /* Persisted local-memory state per gateway per identity class */
    this.localGatewayStates = {
      normal: [],
      heavy:  [],
      top:    [],
    };

    this.tick = 0;
    this.simTime = 0.0;
    this.lastTimestampSec = null;
  }

  _freshIdentityState(bucketCapacity = 200, refillRate = 100, timestampSec = null) {
    const ts = timestampSec != null ? timestampSec : 0.0;
    return {
      // Token Bucket state
      tokens: bucketCapacity,          // current available tokens
      bucketCapacity,                  // burst capacity (maximum tokens bucket can store)
      refillRate,                      // sustained limit (tokens added per second)
      lastRefillTimestamp: ts,         // last simulation timestamp in seconds

      // Window algorithms state
      windowStart: ts,
      windowCount: 0,
      prevWindowCount: 0,
      currWindowCount: 0,
    };
  }

  resetState(bucketCapacity, refillRate) {
    const B = bucketCapacity || 200;
    const r = refillRate || 100;
    this.simTime = 0.0;
    this.tick = 0;
    this.lastTimestampSec = null;
    for (const cls of ['normal', 'heavy', 'top']) {
      this.identityState[cls] = this._freshIdentityState(B, r, 0.0);
      this.localGatewayStates[cls] = [];
    }
  }

  /* ── Interactive Simulation Clock Refill (Single Source of Truth) ── */
  advanceSimulationTime(seconds = 0.5, state = null) {
    this.simTime = Math.round((this.simTime + seconds) * 1000) / 1000;
    const r = state?.refillRate || this.identityState.top.refillRate || 100;
    const B = state?.bucketCapacity || this.identityState.top.bucketCapacity || 200;
    const W = state?.windowSizeSec || 1.0;

    const prevTokens = this.identityState.top.tokens;
    const elapsed = seconds;
    const newTokens = elapsed * r;

    let didReset = false;
    // Refill all identity states based on elapsed time
    for (const cls of ['normal', 'heavy', 'top']) {
      const iState = this.identityState[cls];
      iState.bucketCapacity = B;
      iState.refillRate = r;
      iState.tokens = Math.min(B, Math.round((iState.tokens + newTokens) * 10) / 10);
      iState.lastRefillTimestamp = this.simTime;

      // Check window reset
      if (this.simTime - iState.windowStart >= W) {
        didReset = true;
        iState.prevWindowCount = iState.currWindowCount || iState.windowCount || 0;
        iState.currWindowCount = 0;
        iState.windowCount = 0;
        iState.windowStart = this.simTime;
      }
    }

    const topState = this.identityState.top;
    return {
      elapsed,
      newTokens: Math.round(newTokens * 10) / 10,
      prevTokens,
      tokens: topState.tokens,
      capacity: B,
      refillRate: r,
      simTime: this.simTime,
      windowReset: didReset,
      windowStart: topState.windowStart || 0.0,
      windowCount: topState.windowCount || 0,
      prevWindowCount: topState.prevWindowCount || 0,
      currWindowCount: topState.currWindowCount || 0
    };
  }

  /* ── Interactive Request Execution (Single Source of Truth) ── */
  evaluateInteractiveRequests(count = 1, state = {}, dtSeconds = 0.0) {
    const iState = this.identityState.top;
    const B = state.bucketCapacity || iState.bucketCapacity || 200;
    const r = state.refillRate || iState.refillRate || 100;
    const L = state.limitPerUser || 100;
    const W = state.windowSizeSec || 1.0;
    const algo = state.algorithm || 'token_bucket';

    iState.bucketCapacity = B;
    iState.refillRate = r;

    // Step simulation time if dtSeconds > 0
    if (dtSeconds > 0) {
      this.simTime = Math.round((this.simTime + dtSeconds) * 1000) / 1000;
      const newTokens = dtSeconds * r;
      if (algo === 'token_bucket') {
        iState.tokens = Math.min(B, Math.round((iState.tokens + newTokens) * 10) / 10);
      }
      iState.lastRefillTimestamp = this.simTime;
    }

    const tokensBeforeConsume = iState.tokens;
    let allowed = 0;
    let rejected = 0;

    const isRedis = state.tokenStore === 'redis';
    const isRedisOutage = Boolean(state.failures?.redisOutage);

    if (isRedis && isRedisOutage) {
      if (state.failPolicy === 'fail_open') {
        allowed = count;
        rejected = 0;
      } else {
        allowed = 0;
        rejected = count;
      }
    } else {
      for (let i = 0; i < count; i++) {
        if (algo === 'token_bucket') {
          if (iState.tokens >= 1.0) {
            iState.tokens = Math.max(0, Math.round((iState.tokens - 1.0) * 10) / 10);
            allowed++;
          } else {
            rejected++;
          }
        } else if (algo === 'fixed_window') {
          if (this.simTime - iState.windowStart >= W) {
            iState.windowStart = this.simTime;
            iState.windowCount = 0;
          }
          if (iState.windowCount < L) {
            iState.windowCount++;
            allowed++;
          } else {
            rejected++;
          }
        } else {
          // Sliding window counter
          const elapsed = (this.simTime - iState.windowStart) % W;
          const f = W > 0 ? (elapsed / W) : 0;
          const est = (iState.prevWindowCount || 0) * (1 - f) + (iState.currWindowCount || 0);
          if (est < L) {
            iState.currWindowCount = (iState.currWindowCount || 0) + 1;
            allowed++;
          } else {
            rejected++;
          }
        }
      }
    }

    const isFailClosed = (isRedis && isRedisOutage && state.failPolicy !== 'fail_open');
    const statusCode = (rejected === 0) ? 200 : (isFailClosed ? 503 : 429);

    const winStart = iState.windowStart || 0.0;
    const winEnd = winStart + W;
    const elapsedInWindow = (this.simTime - winStart) % W;
    const overlapWeight = W > 0 ? Math.max(0, Math.min(1, 1 - (elapsedInWindow / W))) : 0;
    const effectiveSlidingCount = (iState.prevWindowCount || 0) * overlapWeight + (iState.currWindowCount || 0);

    return {
      count,
      allowed,
      rejected,
      tokensBefore: tokensBeforeConsume,
      tokensAfter: iState.tokens,
      capacity: B,
      refillRate: r,
      limit: L,
      algorithm: algo,
      simTime: this.simTime,
      statusCode,
      isAllowed: (statusCode === 200),
      isFailClosed,
      windowStart: winStart,
      windowEnd: winEnd,
      windowCount: iState.windowCount || 0,
      prevWindowCount: iState.prevWindowCount || 0,
      currWindowCount: iState.currWindowCount || 0,
      overlapWeight: Math.round(overlapWeight * 100) / 100,
      effectiveSlidingCount: Math.round(effectiveSlidingCount * 10) / 10
    };
  }

  /* ── Force Limit Reached (Single Source of Truth) ──
   * Jumps the limiter directly to its exhausted boundary WITHOUT sending
   * any simulated request: no allowed/rejected count, no simTime advance.
   * The very next evaluateInteractiveRequests() call must be rejected (429).
   */
  forceExhaustLimit(state = {}) {
    const iState = this.identityState.top;
    const B = state.bucketCapacity || iState.bucketCapacity || 200;
    const r = state.refillRate || iState.refillRate || 100;
    const L = state.limitPerUser || 100;
    const W = state.windowSizeSec || 1.0;
    const algo = state.algorithm || 'token_bucket';

    iState.bucketCapacity = B;
    iState.refillRate = r;

    if (algo === 'token_bucket') {
      const before = iState.tokens;
      iState.tokens = 0;
      return { algorithm: algo, capacity: B, refillRate: r, limit: L, simTime: this.simTime,
        tokensBefore: before, tokensAfter: iState.tokens };
    }

    if (algo === 'fixed_window') {
      if (iState.windowStart == null || (this.simTime - iState.windowStart) >= W) {
        iState.windowStart = this.simTime;
      }
      const before = iState.windowCount || 0;
      iState.windowCount = L;
      return { algorithm: algo, limit: L, windowSizeSec: W, simTime: this.simTime,
        windowStart: iState.windowStart, windowEnd: iState.windowStart + W,
        windowCountBefore: before, windowCountAfter: iState.windowCount };
    }

    // Sliding window: raise currWindowCount so the weighted estimate reaches the limit.
    if (iState.windowStart == null || (this.simTime - iState.windowStart) >= W) {
      iState.prevWindowCount = iState.currWindowCount || 0;
      iState.currWindowCount = 0;
      iState.windowStart = this.simTime;
    }
    const elapsed = (this.simTime - iState.windowStart) % W;
    const f = W > 0 ? (elapsed / W) : 0;
    const overlapWeight = Math.max(0, Math.min(1, 1 - f));
    const before = (iState.prevWindowCount || 0) * overlapWeight + (iState.currWindowCount || 0);
    const neededCurr = Math.max(iState.currWindowCount || 0, L - (iState.prevWindowCount || 0) * overlapWeight);
    iState.currWindowCount = Math.round(neededCurr * 10) / 10;
    const after = (iState.prevWindowCount || 0) * overlapWeight + (iState.currWindowCount || 0);
    return { algorithm: algo, limit: L, windowSizeSec: W, simTime: this.simTime,
      overlapWeight: Math.round(overlapWeight * 100) / 100,
      prevWindowCount: iState.prevWindowCount || 0, currWindowCount: iState.currWindowCount,
      effectiveCountBefore: Math.round(before * 10) / 10, effectiveCountAfter: Math.round(after * 10) / 10 };
  }

  /* ── Distributed Topology & State Coordination Evaluation ── */
  evaluateDistributedTopology(options = {}) {
    const G = Math.max(1, options.gatewayCount || 3);
    const traffic = options.traffic ?? 300;
    const limit = options.limit || 100;
    const storage = options.storage || 'local_memory';
    const isAtomic = options.isAtomic !== false;
    const failures = options.failures || {};

    // Use calculate() with single-identity top user to ensure exact model parity
    const m = new RateLimiterModel(this.cfg);
    m.resetState(limit, limit);
    const res = m.calculate({
      ...this.cfg,
      traffic,
      activeIdentities: 1,
      topIdentityRatio: 1.0,
      limitPerUser: limit,
      bucketCapacity: limit,
      refillRate: limit,
      algorithm: 'fixed_window', // exact window limit behavior for steady-state rate
      tokenStore: storage,
      gatewayNodes: G,
      atomicityMode: isAtomic ? 'atomic' : 'non_atomic',
      dt: 1.0,
      failures
    });

    const allowed = res.allowedRPS;
    const rejected = res.rejectedRPS;
    const leaked = res.leakedRPS;

    // Compute per-gateway round-robin traffic breakdown
    const baseGwT = Math.floor(traffic / G);
    const remGwT = traffic % G;
    const perGwResults = [];

    for (let g = 0; g < G; g++) {
      const gwTraffic = baseGwT + (g < remGwT ? 1 : 0);
      let gwAllowed = 0;
      let gwRejected = 0;

      if (storage === 'local_memory') {
        // Independent local limiter per gateway
        gwAllowed = Math.min(gwTraffic, limit);
        gwRejected = Math.max(0, gwTraffic - gwAllowed);
      } else {
        // Shared Redis coordination: all gateways query shared pool
        if (traffic > 0) {
          gwAllowed = Math.round(allowed * (gwTraffic / traffic));
          gwRejected = Math.max(0, gwTraffic - gwAllowed);
        }
      }

      perGwResults.push({
        id: `Gateway ${g + 1}`,
        gatewayId: `gw-${String(g + 1).padStart(2, '0')}`,
        traffic: gwTraffic,
        allowed: gwAllowed,
        rejected: gwRejected,
        status: gwRejected > 0 ? 'throttling' : 'allowing',
        localLimit: limit
      });
    }

    // Build educational causal explanation
    let explanation;
    if (storage === 'local_memory') {
      if (leaked > 0) {
        explanation = {
          title: 'WHY DID THE LIMIT LEAK?',
          isLeak: true,
          points: [
            `Global policy: ${limit} RPS per identity`,
            `Gateway-local state: ${G} independent limiters`,
            `Traffic: ${traffic} RPS across ${G} gateways (~${Math.round(traffic / G)} RPS each)`,
            `Each gateway sees only its local slice (~${Math.round(traffic / G)} RPS), staying within its LOCAL limit (${limit} RPS)`,
            `Each gateway allows requests locally without awareness of sibling gateway traffic`,
            `Local enforcement: ${perGwResults.map(g => g.allowed).join(' + ')} = ${allowed} allowed`,
            `Global policy: ${limit} RPS`,
            `Distributed leakage: +${leaked} RPS allowed beyond configured global limit`
          ]
        };
      } else {
        explanation = {
          title: 'NO LEAKAGE (TRAFFIC WITHIN LIMIT)',
          isLeak: false,
          points: [
            `Global policy: ${limit} RPS per identity`,
            `Traffic: ${traffic} RPS across ${G} gateways (~${Math.round(traffic / G)} RPS each)`,
            `Total traffic does not exceed the global limit (${limit} RPS)`,
            `Total allowed: ${allowed} RPS | Leakage: 0 RPS`
          ]
        };
      }
    } else {
      explanation = {
        title: 'SHARED STATE IS HEALTHY',
        isLeak: false,
        points: [
          `Global policy: ${limit} RPS per identity`,
          `Storage: Centralized Redis key (ratelimit:user_42) shared across all ${G} gateways`,
          `Traffic: ${traffic} RPS across ${G} gateways`,
          `All ${G} gateways query the same centralized Redis counter`,
          `Shared global decision: exactly ${allowed} allowed, ${rejected} rejected (HTTP 429)`,
          `Distributed leakage: 0 RPS, global rate limit strictly enforced`
        ]
      };
    }

    return {
      storage,
      gatewayCount: G,
      identityTraffic: traffic,
      intendedPolicy: limit,
      totalAllowed: allowed,
      totalRejected: rejected,
      leakage: leaked,
      isLeaking: leaked > 0,
      perGwResults,
      redisKey: 'ratelimit:user_42',
      explanation,
      isAtomic
    };
  }

  updateAssumptions(a) {
    this.cfg = { ...this.cfg, ...a };
  }

  /* ────────────────────────────────────────────────────────
     MAIN CALCULATE
     ──────────────────────────────────────────────────────── */
  calculate(state) {
    const cfg = this.cfg;
    const T = Math.max(1, Math.round(state.traffic));
    this.tick++;

    // Determine elapsed time dt for this tick
    const nowSec = (typeof state.timestampSec === 'number')
      ? state.timestampSec
      : (Date.now() / 1000);

    let dt = 1.0;
    if (typeof state.dt === 'number' && state.dt > 0) {
      dt = state.dt;
    } else if (this.lastTimestampSec != null) {
      const elapsed = nowSec - this.lastTimestampSec;
      dt = clamp(elapsed, 0.05, 5.0);
    }
    this.lastTimestampSec = nowSec;

    /* ── Stage 1: Traffic Decomposition (Identity-Class Simulation) ── */
    const dist = decomposeTraffic(
      T, state.activeIdentities, state.trafficProfile, state.topIdentityRatio);

    /* ── Stage 2: Gateway Tier ── */
    const isOneGwDead = Boolean(state.failures?.oneGatewayDead);
    const activeGw = isOneGwDead ? Math.max(0, state.gatewayNodes - 1) : state.gatewayNodes;
    const gwCapTotal = activeGw * cfg.gatewayCapacity;
    const gwUtil = activeGw === 0 ? 10.0 : T / Math.max(1, gwCapTotal);

    /* ── Stage 3: Rate Limiter Daemon Tier ── */
    const isOneLimDead = Boolean(state.failures?.oneLimiterDead);
    const activeLim = isOneLimDead ? Math.max(0, state.rateLimiterNodes - 1) : state.rateLimiterNodes;
    const rlCapTotal = activeLim * cfg.rateLimiterCapacity;
    const rlUtil = activeLim === 0 ? 10.0 : T / Math.max(1, rlCapTotal);

    /* ── Stage 4: Storage & Chaos Context ── */
    const isRedis = state.tokenStore === 'redis';
    const redisOutage = Boolean(state.failures?.redisOutage);
    const netPartition = Boolean(state.failures?.networkPartition);
    const configStale = Boolean(state.failures?.configPropagationDelay);
    const clockDrift = state.failures?.clockDriftMs || 0;
    const isAtomic = state.atomicityMode === 'atomic';

    /* ── Stage 5: Per-Identity Algorithm Evaluation ── */
    const classes = [
      { key: 'normal', count: dist.normalCount, rate: dist.normalRate },
      { key: 'heavy',  count: dist.heavyCount,  rate: dist.heavyRate },
      { key: 'top',    count: dist.topCount,     rate: dist.topRate },
    ];

    let totalAllowed = 0;
    let totalRejected429 = 0;
    let totalFailClosed503 = 0;
    let totalLeaked = 0;

    let topAllowed = 0;
    let topRejected429 = 0;
    let topLeaked = 0;

    for (const cls of classes) {
      if (cls.count === 0 || cls.rate === 0) continue;
      const iState = this.identityState[cls.key];
      const ratePerUser = cls.rate;

      let classAllowed = 0;
      let classRejected429 = 0;
      let classFailClosed503 = 0;
      let classLeaked = 0;

      if (isRedis && !redisOutage && !netPartition) {
        /* ── REDIS MODE: Shared global rate-limit state across gateways ──
         * Redis coordinates single counter/bucket per identity.
         * The algorithm operates on this shared state.
         */
        const evalRes = this._evalAlgorithm(state.algorithm, iState, ratePerUser, state, dt, nowSec);
        let allowed = evalRes.allowed;
        let rejected = evalRes.rejected;

        /* Atomicity check:
         * Non-atomic: READ-then-WRITE race condition allows concurrent requests near
         * or exceeding the limit to interleave and pass before write commits.
         * Atomic: Redis Lua script atomically performs CHECK + INCREMENT + DECISION; zero race leakage.
         */
        if (!isAtomic) {
          const raceOvf = this._raceOverflow(ratePerUser, state.limitPerUser, activeGw);
          allowed += raceOvf;
          rejected = Math.max(0, rejected - raceOvf);
          classLeaked = raceOvf * cls.count;
        }

        classAllowed = allowed * cls.count;
        classRejected429 = rejected * cls.count;

      } else if (isRedis && redisOutage) {
        /* ── REDIS OUTAGE: Fail Policy ──
         * fail-open: requests continue to downstream (allowed).
         * fail-closed: rate limiter cannot verify tokens -> reject with HTTP 503 (NOT 500, NOT 429).
         */
        if (state.failPolicy === 'fail_open') {
          classAllowed = ratePerUser * cls.count;
          classRejected429 = 0;
          classFailClosed503 = 0;
        } else {
          classAllowed = 0;
          classRejected429 = 0;
          classFailClosed503 = ratePerUser * cls.count; // HTTP 503 Service Unavailable
        }

      } else if (isRedis && netPartition) {
        /* ── NETWORK PARTITION: Half gateways isolated from Redis ── */
        const healthyFrac = Math.floor(activeGw / 2) / Math.max(1, activeGw);
        const isolatedFrac = 1.0 - healthyFrac;

        // Healthy partition talks to Redis
        const evalRes = this._evalAlgorithm(state.algorithm, iState, ratePerUser * healthyFrac, state, dt, nowSec);
        let healthyAllowed = evalRes.allowed;
        let healthyRejected = evalRes.rejected;

        // Isolated partition applies fail policy
        let isoAllowed = 0;
        let isoFailClosed = 0;
        if (state.failPolicy === 'fail_open') {
          isoAllowed = ratePerUser * isolatedFrac;
        } else {
          isoFailClosed = ratePerUser * isolatedFrac; // HTTP 503
        }

        classAllowed = (healthyAllowed + isoAllowed) * cls.count;
        classRejected429 = healthyRejected * cls.count;
        classFailClosed503 = isoFailClosed * cls.count;

      } else {
        /* ── LOCAL MEMORY MODE: Each gateway has independent rate-limit state ──
         * Because gateways do not share memory, traffic is split across G gateways.
         * An identity's effective limit leaks up to G × limitPerUser.
         */
        const G = Math.max(1, activeGw);
        const perGwRate = ratePerUser / G;

        // Ensure gateway states array exists
        while (this.localGatewayStates[cls.key].length < G) {
          this.localGatewayStates[cls.key].push(
            this._freshIdentityState(state.bucketCapacity, state.refillRate, nowSec)
          );
        }

        let perUserAllowedTotal = 0;
        let perUserRejectedTotal = 0;

        for (let g = 0; g < G; g++) {
          const gwState = this.localGatewayStates[cls.key][g];
          let effectiveLimit = state.limitPerUser;
          let effectiveCapacity = state.bucketCapacity;
          let effectiveRefill = state.refillRate;

          // Config propagation chaos: 1 gateway has stale config
          if (configStale && g === G - 1) {
            effectiveLimit = state.failures?.staleLimitValue || 500;
            effectiveCapacity = Math.max(effectiveLimit * 2, state.bucketCapacity);
            effectiveRefill = effectiveLimit;
          }

          const gwConfig = {
            ...state,
            limitPerUser: effectiveLimit,
            bucketCapacity: effectiveCapacity,
            refillRate: effectiveRefill
          };

          const evalRes = this._evalAlgorithm(
            state.algorithm, gwState, perGwRate, gwConfig, dt, nowSec, clockDrift, g);

          perUserAllowedTotal += evalRes.allowed;
          perUserRejectedTotal += evalRes.rejected;
        }

        // Non-atomic local memory race condition
        if (!isAtomic) {
          const raceOvf = this._raceOverflow(ratePerUser, state.limitPerUser, G);
          perUserAllowedTotal += raceOvf;
          perUserRejectedTotal = Math.max(0, perUserRejectedTotal - raceOvf);
        }

        classAllowed = perUserAllowedTotal * cls.count;
        classRejected429 = perUserRejectedTotal * cls.count;

        // Calculate leaked traffic: allowed beyond what a single global limit would permit
        const globalPolicyLimit = state.algorithm === 'token_bucket'
          ? Math.min(ratePerUser, (iState.tokens + state.refillRate * dt) / dt)
          : Math.min(ratePerUser, state.limitPerUser);

        const singleUserAllowed = perUserAllowedTotal;
        if (singleUserAllowed > globalPolicyLimit) {
          classLeaked = (singleUserAllowed - globalPolicyLimit) * cls.count;
        }

        // Also advance global identity state for tracking/metrics
        this._evalAlgorithm(state.algorithm, iState, singleUserAllowed, state, dt, nowSec);
      }

      totalAllowed += classAllowed;
      totalRejected429 += classRejected429;
      totalFailClosed503 += classFailClosed503;
      totalLeaked += classLeaked;

      if (cls.key === 'top') {
        topAllowed = classAllowed;
        topRejected429 = classRejected429;
        topLeaked = classLeaked;
      }
    }

    totalAllowed = Math.round(totalAllowed);
    totalRejected429 = Math.round(totalRejected429);
    totalFailClosed503 = Math.round(totalFailClosed503);
    totalLeaked = Math.round(totalLeaked);

    /* ── Stage 6: Redis Shard Load & Hot Key ── */
    const redisOps = isRedis && !redisOutage ? T : 0;
    const redisClusterCap = state.redisShards * cfg.redisShardCapacity;
    let redisClusterUtil = 0, redisHotShardUtil = 0, redisColdShardUtil = 0, hotKeyConcentration = 0;

    const hotKeyActive = Boolean(state.failures?.hotKeyActive);
    if (isRedis && !redisOutage && redisOps > 0) {
      if (hotKeyActive && state.redisShards > 1) {
        const T_top_ops = Math.round(T * state.topIdentityRatio);
        const T_rest_ops = Math.max(0, T - T_top_ops);
        const perShardRest = T_rest_ops / state.redisShards;
        const hotOps = perShardRest + T_top_ops;
        const coldOps = perShardRest;
        redisHotShardUtil = hotOps / cfg.redisShardCapacity;
        redisColdShardUtil = coldOps / cfg.redisShardCapacity;
        redisClusterUtil = redisOps / redisClusterCap;
        hotKeyConcentration = T_top_ops / Math.max(1, redisOps);
      } else {
        const perShard = redisOps / state.redisShards;
        redisClusterUtil = redisOps / redisClusterCap;
        redisHotShardUtil = perShard / cfg.redisShardCapacity;
        redisColdShardUtil = redisHotShardUtil;
      }
    }

    const redisEffectiveUtil = hotKeyActive ? redisHotShardUtil : redisClusterUtil;

    /* ── Stage 7: Infrastructure Drops vs Policy Rejections ──
     * If Gateway or Rate Limiter nodes exceed 100% capacity, hardware drops occur.
     * 429 is rate-limit policy, distinct from infrastructure drops!
     */
    let infraDropped = 0;
    let passedToDownstream = totalAllowed;

    const infraOverUtil = Math.max(gwUtil, rlUtil);
    if (infraOverUtil > 1.0) {
      const capFraction = 1.0 / infraOverUtil;
      const maxPassable = Math.round(totalAllowed * capFraction);
      infraDropped = Math.max(0, totalAllowed - maxPassable);
      passedToDownstream = maxPassable;
    }

    if (activeGw === 0 || activeLim === 0) {
      infraDropped = totalAllowed;
      passedToDownstream = 0;
    }

    /* ── Stage 8: Downstream Service Tier ── */
    const dsCap = cfg.downstreamCapacity;
    const dsUtil = passedToDownstream / dsCap;
    let downstreamAccepted = Math.min(passedToDownstream, dsCap);
    let downstreamDropped = Math.max(0, passedToDownstream - dsCap); // Overload 503

    /* ── Stage 9: Independent Bottlenecks (5 Independent Constraints) ──
     *  1. API Gateway Capacity
     *  2. Rate Limiter Daemon Capacity
     *  3. Redis Shard Capacity (Cluster or Hot Shard)
     *  4. Per-User Rate-Limit Policy (HTTP 429)
     *  5. Downstream Service Capacity
     */
    const policyUtil = T > 0 ? (totalRejected429 / T) : 0;

    const tiers = [
      {
        id: 'gateway',
        name: 'API Gateway',
        load: gwUtil,
        capacity: gwCapTotal,
        current: T,
        metric: `${(gwUtil * 100).toFixed(1)}% load (${gwCapTotal.toLocaleString()} req/s cap)`
      },
      {
        id: 'rate_limiter',
        name: 'Rate Limiter Daemon',
        load: rlUtil,
        capacity: rlCapTotal,
        current: T,
        metric: `${(rlUtil * 100).toFixed(1)}% load (${rlCapTotal.toLocaleString()} checks/s cap)`
      },
    ];

    if (isRedis && !redisOutage) {
      tiers.push({
        id: 'redis',
        name: hotKeyActive ? 'Redis (Hot Shard Saturation)' : 'Redis Storage Tier',
        load: redisEffectiveUtil,
        capacity: hotKeyActive ? cfg.redisShardCapacity : redisClusterCap,
        current: hotKeyActive ? Math.round(redisHotShardUtil * cfg.redisShardCapacity) : redisOps,
        metric: `${(redisEffectiveUtil * 100).toFixed(1)}% load (${(hotKeyActive ? cfg.redisShardCapacity : redisClusterCap).toLocaleString()} ops/s cap)`
      });
    }

    tiers.push({
      id: 'downstream',
      name: 'Downstream Service',
      load: dsUtil,
      capacity: dsCap,
      current: passedToDownstream,
      metric: `${(dsUtil * 100).toFixed(1)}% load (${dsCap.toLocaleString()} req/s cap)`
    });

    // Per-User Rate Limit Policy constraint
    tiers.push({
      id: 'policy',
      name: 'Per-User Rate Limit Policy (429)',
      load: policyUtil,
      capacity: state.limitPerUser,
      current: totalRejected429,
      metric: `${totalRejected429.toLocaleString()} req/s throttled (Limit: ${state.limitPerUser}/user)`
    });

    // Sort by stress level (utilization)
    tiers.sort((a, b) => b.load - a.load);
    const primaryBottleneck = tiers[0];
    const systemMaxUtil = Math.max(gwUtil, rlUtil, redisEffectiveUtil, dsUtil);

    /* ── Stage 10: Latency Derivation ── */
    let dAllowedBase, dRejectedBase;
    if (isRedis && !redisOutage) {
      dAllowedBase = cfg.gatewayLatency + cfg.redisNetLatency + cfg.redisExecLatency + cfg.downstreamLatency;
      dRejectedBase = cfg.gatewayLatency + cfg.redisNetLatency + cfg.redisExecLatency;
    } else if (isRedis && redisOutage) {
      dAllowedBase = cfg.gatewayLatency + 2.0 + cfg.downstreamLatency; // timeout detect + downstream
      dRejectedBase = cfg.gatewayLatency + 2.0;                         // fast 503
    } else {
      dAllowedBase = cfg.gatewayLatency + cfg.localMemoryLatency + cfg.downstreamLatency;
      dRejectedBase = cfg.gatewayLatency + cfg.localMemoryLatency;
    }

    const dWeightedBase = T > 0
      ? (totalAllowed * dAllowedBase + totalRejected429 * dRejectedBase) / T
      : dAllowedBase;

    // Queueing delay M/M/1-inspired approximation
    const Ub = Math.max(gwUtil, rlUtil, redisEffectiveUtil, dsUtil);
    let dQueue = 0;
    if (Ub > 0.65 && Ub < 1.0) {
      const u = Math.min(Ub, 0.99);
      dQueue = 4.0 * (u / (1.0 - u));
    } else if (Ub >= 1.0) {
      dQueue = 4.0 * (0.99 / 0.01) + (Ub - 1.0) * 600;
    }
    dQueue = Math.min(dQueue, 3000);
    if (state.failures?.redisLatencyMs) dQueue += state.failures.redisLatencyMs;

    const avgLatency = Math.round((dWeightedBase + dQueue) * 10) / 10;
    const p95Latency = Math.round((avgLatency * 1.8 + dQueue * 0.6) * 10) / 10;
    const p99Latency = Math.round((avgLatency * 2.8 + dQueue * 1.2) * 10) / 10;

    /* ── Token Bucket Specific Metrics ── */
    const topBucket = this.identityState.top;
    const burstCapUsed = Math.max(0, state.bucketCapacity - topBucket.tokens);

    /* ── Mathematical Explanations ── */
    const mathBreakdowns = {
      identity: {
        summary: `Identity-Class Simulation: ${state.activeIdentities.toLocaleString()} users modeled across 3 cohorts`,
        steps: [
          `Simulation Mode: Identity-Class Cohort Simulation`,
          `Configured Traffic: ${T.toLocaleString()} req/s across ${state.activeIdentities.toLocaleString()} identities`,
          `Top Identity: 1 entity generating ${(dist.topIdentityRatio * 100).toFixed(1)}% = ${dist.topRate.toLocaleString()} req/s`,
          dist.heavyCount > 0
            ? `Heavy Cohort: ${dist.heavyCount} users generating ${dist.heavyRate.toFixed(1)} req/s each`
            : `Heavy Cohort: 0 users`,
          `Normal Cohort: ${dist.normalCount} users generating ${dist.normalRate.toFixed(2)} req/s each`,
          `Total Offered Invariant: ${Math.round(dist.topRate + dist.heavyCount * dist.heavyRate + dist.normalCount * dist.normalRate).toLocaleString()} req/s == ${T.toLocaleString()} req/s`
        ]
      },
      tokenBucket: {
        summary: `Sustained limit: ${state.refillRate}/s | Burst capacity: ${state.bucketCapacity} tokens | Current available: ${Math.round(topBucket.tokens)}`,
        steps: [
          `Sustained refill rate (r): ${state.refillRate} tokens/sec`,
          `Burst capacity (B): ${state.bucketCapacity} max tokens`,
          `Refill formula: newTokens = elapsedSeconds (${dt.toFixed(2)}s) × ${state.refillRate}/s = ${(dt * state.refillRate).toFixed(1)} tokens`,
          `Token state: min(${state.bucketCapacity}, previousTokens + newTokens) = ${Math.round(topBucket.tokens)} tokens available`,
          `Consumption rule: 1 token per request. If tokens >= 1 → ALLOW; otherwise → HTTP 429`
        ]
      },
      gateway: {
        summary: `${T.toLocaleString()} req/s ÷ (${activeGw} gateways × ${cfg.gatewayCapacity.toLocaleString()}) = ${(gwUtil * 100).toFixed(1)}%`,
        steps: [
          `Incoming Traffic: ${T.toLocaleString()} req/s`,
          `Active Gateways: ${activeGw}${isOneGwDead ? ' (1 node down)' : ''}`,
          `Total Gateway Capacity: ${gwCapTotal.toLocaleString()} req/s`,
          `Utilization: ${(gwUtil * 100).toFixed(1)}%`,
          gwUtil > 1.0 ? `⚠ Gateway saturated: dropping ${(T - gwCapTotal).toLocaleString()} req/s` : 'Gateway healthy'
        ]
      },
      rateLimiter: {
        summary: `${T.toLocaleString()} checks/s ÷ (${activeLim} nodes × ${cfg.rateLimiterCapacity.toLocaleString()}) = ${(rlUtil * 100).toFixed(1)}%`,
        steps: [
          `Rate-limit checks demanded: ${T.toLocaleString()} checks/s`,
          `Active RL Daemons: ${activeLim}${isOneLimDead ? ' (1 daemon down)' : ''}`,
          `Total Daemon Capacity: ${rlCapTotal.toLocaleString()} checks/s`,
          `Utilization: ${(rlUtil * 100).toFixed(1)}%`
        ]
      },
      redis: {
        summary: isRedis && !redisOutage
          ? `${redisOps.toLocaleString()} ops/s across ${state.redisShards} shards${hotKeyActive ? ' (HOT KEY CONCENTRATION!)' : ''}`
          : (redisOutage ? `Redis is DOWN. Fail Policy: ${state.failPolicy === 'fail_open' ? 'Fail Open (allow)' : 'Fail Closed (HTTP 503)'}` : 'Local Memory mode (no Redis)'),
        steps: isRedis && !redisOutage ? [
          `Redis ops: ${redisOps.toLocaleString()} ops/s (shared global coordination)`,
          `Cluster Capacity: ${state.redisShards} × ${cfg.redisShardCapacity.toLocaleString()} = ${redisClusterCap.toLocaleString()} ops/s`,
          `Cluster Utilization: ${(redisClusterUtil * 100).toFixed(1)}%`,
          hotKeyActive
            ? `Hot Shard: ${(redisHotShardUtil * 100).toFixed(1)}% | Cold Shards: ${(redisColdShardUtil * 100).toFixed(1)}%`
            : `Per-Shard Load: ${(redisHotShardUtil * 100).toFixed(1)}% (uniform hash distribution)`
        ] : []
      },
      downstream: {
        summary: `${passedToDownstream.toLocaleString()} req/s forwarded ÷ ${dsCap.toLocaleString()} cap = ${(dsUtil * 100).toFixed(1)}%`,
        steps: [
          `Allowed & forwardable traffic: ${passedToDownstream.toLocaleString()} req/s`,
          `Downstream Capacity: ${dsCap.toLocaleString()} req/s`,
          `Accepted by Downstream: ${downstreamAccepted.toLocaleString()} req/s`,
          downstreamDropped > 0
            ? `⚠ Overloaded: ${downstreamDropped.toLocaleString()} req/s dropped with HTTP 503`
            : 'Downstream capacity adequate'
        ]
      },
      leakage: {
        summary: totalLeaked > 0
          ? `${totalLeaked.toLocaleString()} req/s leaked beyond per-user limit`
          : 'No leakage, global rate limit strictly enforced',
        steps: isRedis && !redisOutage
          ? [
              `Storage: Redis Shared State across ${activeGw} gateways`,
              `Atomicity: ${state.atomicityMode === 'atomic' ? 'Atomic (Redis Lua script: atomic check + increment + decision) with zero race leakage' : 'Non-Atomic (GET/SET) with race condition leakage active'}`,
              `Leaked traffic: ${totalLeaked.toLocaleString()} req/s`
            ]
          : [
              `Storage: Local In-Memory State`,
              `Each of ${activeGw} gateways maintains an independent counter/bucket`,
              `Per-gateway limit: ${state.limitPerUser}/s`,
              `Effective aggregate limit across ${activeGw} gateways: ${activeGw * state.limitPerUser}/s`,
              `Leaked traffic: ${totalLeaked.toLocaleString()} req/s beyond single global limit`
            ]
      },
      latency: {
        summary: `Base ${dWeightedBase.toFixed(1)}ms + Queue ${dQueue.toFixed(1)}ms = ${avgLatency}ms avg`,
        steps: [
          `Gateway latency: ${cfg.gatewayLatency}ms`,
          isRedis && !redisOutage
            ? `Redis latency: ${cfg.redisNetLatency}ms network + ${cfg.redisExecLatency}ms execution`
            : `Local memory latency: ${cfg.localMemoryLatency}ms`,
          `Downstream latency: ${cfg.downstreamLatency}ms`,
          `Bottleneck queueing delay: +${dQueue.toFixed(1)}ms`,
          `Percentiles: p95 = ${p95Latency}ms, p99 = ${p99Latency}ms`
        ]
      }
    };

    return {
      // Traffic flow metrics
      offeredRPS: T,
      allowedRPS: totalAllowed,
      rejectedRPS: totalRejected429,          // 429 policy rejections
      failClosed503RPS: totalFailClosed503,   // 503 storage failure rejections (fail-closed)
      rejectionRate: T > 0 ? totalRejected429 / T : 0,
      leakedRPS: totalLeaked,
      infraDroppedRPS: infraDropped,
      downstreamReceivedRPS: passedToDownstream,
      downstreamAcceptedRPS: downstreamAccepted,
      downstreamDroppedRPS: downstreamDropped,

      // Identity & Simulation clarity
      modelingApproach: 'identity-class simulation',
      activeIdentities: state.activeIdentities,
      distribution: dist,
      topIdentityOfferedRPS: dist.topRate,
      topIdentityAllowedRPS: Math.round(topAllowed),
      topIdentityRejectedRPS: Math.round(topRejected429),
      topIdentityLeaked: Math.round(topLeaked),

      // Algorithm & Token Bucket state
      algorithm: state.algorithm,
      sustainedLimit: state.refillRate,
      burstCapacity: state.bucketCapacity,
      currentAvailableTokens: Math.max(0, Math.round(topBucket.tokens * 10) / 10),
      tokensRemaining: Math.max(0, Math.round(topBucket.tokens * 10) / 10),
      burstCapacityUsed: Math.max(0, Math.round(burstCapUsed * 10) / 10),
      windowCountCurrent: Math.round(topBucket.currWindowCount || topBucket.windowCount || 0),

      // Tier utilizations & capacities
      gatewayUtilization: gwUtil,
      gatewayCapacity: gwCapTotal,
      activeGateways: activeGw,
      rateLimiterUtilization: rlUtil,
      rateLimiterCapacity: rlCapTotal,
      activeRateLimiters: activeLim,
      redisOpsPerSec: redisOps,
      redisClusterUtilization: redisClusterUtil,
      redisHotShardUtilization: redisHotShardUtil,
      redisColdShardUtilization: redisColdShardUtil,
      hotKeyConcentration,
      downstreamUtilization: dsUtil,

      // Bottlenecks
      primaryBottleneck,
      systemMaxUtilization: systemMaxUtil,
      tiers,

      // Latency
      avgLatency,
      p95Latency,
      p99Latency,

      // Configuration & Status
      tokenStore: state.tokenStore,
      isRedisOutage: redisOutage,
      failPolicy: state.failPolicy,
      atomicityMode: state.atomicityMode,

      // Mathematical breakdowns
      mathBreakdowns,
    };
  }

  /* ────────────────────────────────────────────────────────
     ALGORITHM EVALUATION (Per-identity stateful enforcement)
     ──────────────────────────────────────────────────────── */
  _evalAlgorithm(algorithm, iState, ratePerUser, state, dt, nowSec, clockDrift = 0, gwIndex = 0) {
    switch (algorithm) {
      case 'token_bucket':
        return this._evalTokenBucket(iState, ratePerUser, state, dt, nowSec);
      case 'fixed_window':
        return this._evalFixedWindow(iState, ratePerUser, state, dt, nowSec, clockDrift, gwIndex);
      case 'sliding_window':
        return this._evalSlidingWindow(iState, ratePerUser, state, dt, nowSec, clockDrift, gwIndex);
      default:
        return this._evalTokenBucket(iState, ratePerUser, state, dt, nowSec);
    }
  }

  /* ── 1. Token Bucket ──
   * Refill:
   *   newTokens = elapsedSeconds * refillRate
   *   tokens = min(bucketCapacity, previousTokens + newTokens)
   *
   * Request consumption:
   *   1 request consumes 1 token.
   *   If tokens >= 1 -> ALLOW.
   *   Otherwise -> 429.
   *
   * Distinguishes:
   *   sustained limit = refillRate
   *   burst capacity = bucketCapacity
   *   current available tokens = iState.tokens
   */
  _evalTokenBucket(iState, ratePerUser, state, dt, nowSec) {
    const B = state.bucketCapacity;
    const r = state.refillRate;

    // Persist configuration
    iState.bucketCapacity = B;
    iState.refillRate = r;

    // 1. Refill
    const previousTokens = (typeof iState.tokens === 'number') ? iState.tokens : B;
    const elapsedSeconds = dt;
    const newTokens = elapsedSeconds * r;
    const availableTokens = Math.min(B, previousTokens + newTokens);

    // 2. Consume
    const demand = ratePerUser * dt;
    const allowed = Math.min(demand, availableTokens);
    const rejected = Math.max(0, demand - allowed);

    // Update persistent state
    iState.tokens = Math.max(0, availableTokens - allowed);
    iState.lastRefillTimestamp = nowSec;

    return {
      allowed: dt > 0 ? (allowed / dt) : allowed,
      rejected: dt > 0 ? (rejected / dt) : rejected,
      tokens: iState.tokens
    };
  }

  /* ── 2. Fixed Window Counter ── */
  _evalFixedWindow(iState, ratePerUser, state, dt, nowSec, clockDrift = 0, gwIndex = 0) {
    const W = state.windowSizeSec || 1.0;
    let L = state.limitPerUser * W;

    // Clock drift chaos: drifted gateway has shifted boundary window
    if (clockDrift > 0 && gwIndex === 0) {
      const overlapFrac = Math.min(clockDrift / 1000, W) / W;
      L = L * (1.0 + overlapFrac);
    }

    if (iState.windowStart == null || (nowSec - iState.windowStart) >= W) {
      iState.windowStart = nowSec;
      iState.windowCount = 0;
    }

    const demand = ratePerUser * dt;
    const remaining = Math.max(0, L - iState.windowCount);
    const allowed = Math.min(demand, remaining);
    iState.windowCount += allowed;
    const rejected = Math.max(0, demand - allowed);

    return {
      allowed: dt > 0 ? (allowed / dt) : allowed,
      rejected: dt > 0 ? (rejected / dt) : rejected
    };
  }

  /* ── 3. Sliding Window Counter ── */
  _evalSlidingWindow(iState, ratePerUser, state, dt, nowSec, clockDrift = 0, gwIndex = 0) {
    const W = state.windowSizeSec || 1.0;
    let L = state.limitPerUser * W;

    if (clockDrift > 0 && gwIndex === 0) {
      const overlapFrac = Math.min(clockDrift / 1000, W) / W;
      L = L * (1.0 + overlapFrac * 0.5);
    }

    if (iState.windowStart == null || (nowSec - iState.windowStart) >= W) {
      iState.prevWindowCount = iState.currWindowCount || 0;
      iState.currWindowCount = 0;
      iState.windowStart = nowSec;
    }

    const elapsed = (nowSec - iState.windowStart) % W;
    const f = W > 0 ? (elapsed / W) : 0;
    const estimatedCount = (iState.prevWindowCount || 0) * (1.0 - f) + (iState.currWindowCount || 0);

    const demand = ratePerUser * dt;
    const remaining = Math.max(0, L - estimatedCount);
    const allowed = Math.min(demand, remaining);
    iState.currWindowCount = (iState.currWindowCount || 0) + allowed;
    const rejected = Math.max(0, demand - allowed);

    return {
      allowed: dt > 0 ? (allowed / dt) : allowed,
      rejected: dt > 0 ? (rejected / dt) : rejected
    };
  }

  /* ── Race Condition Overflow (Non-Atomic READ-then-WRITE) ──
   * Non-atomic: concurrent requests within network RTT window both read the same counter,
   * both evaluate <= limit, and both get allowed (lost update upon write).
   * Over-admission scales with concurrency and proximity to limit.
   */
  _raceOverflow(rate, limit, gateways) {
    if (rate < limit * 0.75) return 0;
    const nearLimitFrac = clamp((rate / limit - 0.75) / 0.25, 0, 1);
    const concurrency = Math.min(gateways * 2, Math.max(1, Math.ceil(rate / 500)));
    // Up to concurrency - 1 requests can slip through per collision interval
    return Math.min(rate * 0.08, nearLimitFrac * (concurrency * 2.5));
  }
}
