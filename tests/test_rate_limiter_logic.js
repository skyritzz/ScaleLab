/**
 * Verification Test Suite: Rate Limiter Mathematical & Causal Logic (Batch 1/4)
 *
 * Tests:
 *  1. Token Bucket persistence: burst absorption -> depletion -> refill -> recovery.
 *  2. Traffic vs Identity: Aggregate traffic preserved; no naive aggregate min(T, limit).
 *  3. Distributed state: Local memory multi-gateway leakage vs Redis coordination.
 *  4. Atomicity: Non-atomic race condition leakage vs atomic zero leakage.
 *  5. Independent bottlenecks: 429 policy vs infrastructure drops vs downstream drops.
 *  6. Fail policy: Redis outage fail-open vs fail-closed (HTTP 503, never 500).
 *  7. Identity-class simulation abstraction.
 */

import assert from 'node:assert/strict';
import { RateLimiterModel } from '../js/rate-limiter/model.js';
import { decomposeTraffic, RL_DEFAULT_STATE } from '../js/rate-limiter/config.js';

console.log('🧪 Starting Rate Limiter Logic Tests (Batch 1/4)...\n');

/* ── 1. Token Bucket Persistence ── */
{
  console.log('Test 1: Token Bucket stateful persistence across simulation ticks');
  const model = new RateLimiterModel();
  const B = 200;
  const r = 100;
  model.resetState(B, r);

  const baseState = {
    ...RL_DEFAULT_STATE,
    traffic: 5000,
    activeIdentities: 500,
    trafficProfile: 'uniform',
    topIdentityRatio: 0.04, // top identity offered: 200 req/s
    algorithm: 'token_bucket',
    bucketCapacity: B,
    refillRate: r,
    limitPerUser: r,
    tokenStore: 'redis',
    atomicityMode: 'atomic',
    dt: 1.0,
    timestampSec: 1000.0,
  };

  // Tick 1: Top identity demands 200 req/s with full bucket (200 tokens).
  // Bucket absorbs the full 200 burst: 200 allowed, 0 rejected.
  const m1 = model.calculate({ ...baseState, timestampSec: 1001.0 });
  assert.equal(m1.topIdentityOfferedRPS, 200, 'Top identity offered should be 200 req/s');
  assert.equal(m1.topIdentityAllowedRPS, 200, 'Initial burst of 200 must be fully absorbed');
  assert.equal(m1.topIdentityRejectedRPS, 0, 'No rejections during initial burst');
  assert.equal(m1.currentAvailableTokens, 0, 'Tokens must be depleted after burst');

  // Tick 2: Top identity demands another 200 req/s.
  // Tokens were 0. Refill over 1s is r = 100 tokens. Only 100 can be allowed!
  const m2 = model.calculate({ ...baseState, timestampSec: 1002.0 });
  assert.equal(m2.topIdentityAllowedRPS, 100, 'Subsequent second must be throttled to sustained refill rate (100)');
  assert.equal(m2.topIdentityRejectedRPS, 100, 'Excess 100 req/s must be rejected with 429');
  assert.equal(m2.currentAvailableTokens, 0, 'Tokens remain at 0 under continuous overload');

  // Tick 3: Top identity backs off to 40 req/s.
  // Demand 40 < refill 100. Bucket recovers 60 tokens.
  const backoffState = {
    ...baseState,
    traffic: 1000,
    topIdentityRatio: 0.04, // 40 req/s
    timestampSec: 1003.0,
  };
  const m3 = model.calculate(backoffState);
  assert.equal(m3.topIdentityAllowedRPS, 40, 'All 40 req/s allowed during backoff');
  assert.equal(m3.topIdentityRejectedRPS, 0, 'Zero rejections during backoff');
  assert.equal(m3.currentAvailableTokens, 60, 'Bucket must recover 60 tokens (0 + 100 refill - 40 consumed)');

  console.log('  ✓ Initial burst absorbed (200/200 allowed)');
  console.log('  ✓ Sustained limit enforced on depletion (100 allowed, 100 rejected)');
  console.log('  ✓ Token recovery verified (recovered to 60 available tokens)\n');
}

/* ── 2. Traffic Preservation & Identity Independence ── */
{
  console.log('Test 2: Traffic preservation and per-identity limit isolation');
  for (const profile of ['uniform', 'heavy_tail', 'abusive_spike']) {
    const T = 25000;
    const N = 1200;
    const dist = decomposeTraffic(T, N, profile, 0.15);
    const reconstructed = Math.round(
      dist.topCount * dist.topRate +
      dist.heavyCount * dist.heavyRate +
      dist.normalCount * dist.normalRate
    );
    assert.equal(reconstructed, T, `Total offered traffic for profile ${profile} must equal ${T}`);
  }

  // Verify normal users with 10 req/s are NOT throttled even under 50,000 aggregate traffic
  const model = new RateLimiterModel();
  const res = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 50000,
    activeIdentities: 5000,
    trafficProfile: 'uniform', // each normal user ~9 req/s << 100 limit
    topIdentityRatio: 0.02,    // top user = 1000 req/s >> 100 limit
    limitPerUser: 100,
    bucketCapacity: 100,
    refillRate: 100,
    tokenStore: 'redis',
    dt: 1.0,
  });

  // Total allowed should NOT be min(50000, 100) = 100!
  assert.ok(res.allowedRPS > 45000, `Allowed RPS (${res.allowedRPS}) must serve all normal users, not be capped at 100`);
  assert.ok(res.topIdentityRejectedRPS > 800, 'Abusive top user must be throttled');
  console.log('  ✓ Total traffic preserved across all profiles');
  console.log(`  ✓ Allowed RPS is ${res.allowedRPS} (normal users served, abusive user isolated)\n`);
}

/* ── 3. Distributed State: Local Memory Leakage vs Redis Coordination ── */
{
  console.log('Test 3: Distributed state leakage in local memory vs Redis');
  const T = 10000;
  const N = 100;
  const limit = 100;
  const topRatio = 0.30; // Top user sending 3,000 req/s
  const G = 4; // 4 gateways

  // Case A: Local memory mode (no cross-gateway coordination)
  const localModel = new RateLimiterModel();
  localModel.resetState(limit, limit);
  const mLocal = localModel.calculate({
    ...RL_DEFAULT_STATE,
    traffic: T,
    activeIdentities: N,
    topIdentityRatio: topRatio,
    limitPerUser: limit,
    bucketCapacity: limit,
    refillRate: limit,
    tokenStore: 'local_memory',
    gatewayNodes: G,
    atomicityMode: 'atomic',
    dt: 1.0,
  });

  // Case B: Redis mode (shared state across all gateways)
  const redisModel = new RateLimiterModel();
  redisModel.resetState(limit, limit);
  const mRedis = redisModel.calculate({
    ...RL_DEFAULT_STATE,
    traffic: T,
    activeIdentities: N,
    topIdentityRatio: topRatio,
    limitPerUser: limit,
    bucketCapacity: limit,
    refillRate: limit,
    tokenStore: 'redis',
    gatewayNodes: G,
    atomicityMode: 'atomic',
    dt: 1.0,
  });

  assert.ok(mLocal.leakedRPS > 0, `Local memory must leak across ${G} gateways (leaked: ${mLocal.leakedRPS})`);
  assert.equal(mRedis.leakedRPS, 0, 'Redis shared state must produce 0 leakage');
  assert.ok(mLocal.allowedRPS > mRedis.allowedRPS, 'Local memory allows more traffic than Redis due to leakage');
  console.log(`  ✓ Local memory leaked: ${mLocal.leakedRPS} req/s across ${G} gateways`);
  console.log('  ✓ Redis global coordination: 0 req/s leaked');

  // Explicit verification of User Example 1:
  // 3 gateways, user traffic = 60 RPS, limit = 100 RPS -> Allowed = 60 (NOT 300), leaked = 0
  const mEx1Model = new RateLimiterModel();
  mEx1Model.resetState(100, 100);
  const mEx1 = mEx1Model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 60,
    activeIdentities: 1,
    topIdentityRatio: 1.0, // 1 user with 60 RPS
    limitPerUser: 100,
    bucketCapacity: 100,
    refillRate: 100,
    gatewayNodes: 3,
    tokenStore: 'local_memory',
    atomicityMode: 'atomic',
    dt: 1.0,
  });
  assert.equal(mEx1.allowedRPS, 60, 'Example 1: 60 RPS across 3 gateways with limit 100 must allow 60, NOT 300');
  assert.equal(mEx1.leakedRPS, 0, 'Example 1: 60 RPS under 100 limit has 0 leakage');
  console.log('  ✓ Example 1: 3 gateways, 60 RPS user traffic, limit 100 → allowed = 60 (NOT 300), leaked = 0');

  // Explicit verification of User Example 2:
  // 3 gateways, user traffic = 300 RPS, limit = 100 RPS
  // With Fixed Window (or Token Bucket at steady state where burst is depleted):
  // Each gateway receives 300 / 3 = 100 RPS <= 100 limit, so each allows 100 -> Total allowed = 300.
  // Single global limit = 100 RPS -> Resulting leakage = 300 - 100 = 200 RPS!
  const mEx2Model = new RateLimiterModel();
  mEx2Model.resetState(100, 100);
  const mEx2 = mEx2Model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 300,
    activeIdentities: 1,
    topIdentityRatio: 1.0, // 1 user with 300 RPS
    algorithm: 'fixed_window',
    limitPerUser: 100,
    gatewayNodes: 3,
    tokenStore: 'local_memory',
    atomicityMode: 'atomic',
    dt: 1.0,
  });
  assert.equal(mEx2.allowedRPS, 300, 'Example 2: 300 RPS across 3 gateways with limit 100 allows 300 (100 per gateway)');
  assert.equal(mEx2.leakedRPS, 200, 'Example 2 (Fixed Window): 300 allowed - 100 global limit = 200 leaked RPS');
  console.log('  ✓ Example 2: 3 gateways, 300 RPS user traffic, limit 100 → allowed = 300, leaked = 200\n');
}

/* ── 4. Atomicity: Non-Atomic Race Leakage vs Atomic Strict Bounds ── */
{
  console.log('Test 4: Atomicity race condition leakage');
  const model = new RateLimiterModel();

  // Non-atomic mode near limit
  const mNonAtomic = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 10000,
    limitPerUser: 100,
    atomicityMode: 'non_atomic',
    tokenStore: 'redis',
    dt: 1.0,
  });

  // Atomic mode
  const mAtomic = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 10000,
    limitPerUser: 100,
    atomicityMode: 'atomic',
    tokenStore: 'redis',
    dt: 1.0,
  });

  assert.ok(mNonAtomic.leakedRPS > 0, `Non-atomic mode must suffer race condition leakage (leaked: ${mNonAtomic.leakedRPS})`);
  assert.equal(mAtomic.leakedRPS, 0, 'Atomic mode must have 0 race condition leakage');
  console.log(`  ✓ Non-atomic mode race leakage: ${mNonAtomic.leakedRPS} req/s`);
  console.log('  ✓ Atomic mode (Lua/INCR): 0 req/s leakage\n');
}

/* ── 5. Independent Bottlenecks & 429 vs Infra Drops ── */
{
  console.log('Test 5: Independent bottlenecks (429 policy vs infra drops vs downstream drops)');
  // Gateway saturation test (Gateway capacity = 2 gateways * 25,000 = 50,000 req/s)
  // Downstream capacity set high (100,000) so Gateway is the primary constraint
  const model = new RateLimiterModel({ downstreamCapacity: 100000 });

  // Offered traffic = 70,000 req/s
  const mInfra = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 70000,
    gatewayNodes: 2,
    rateLimiterNodes: 4,
    redisShards: 10,
    limitPerUser: 1000, // Very high limit so policy doesn't throttle
    bucketCapacity: 1000,
    refillRate: 1000,
    tokenStore: 'redis',
    dt: 1.0,
  });

  assert.ok(mInfra.infraDroppedRPS > 0, `Gateway overload must cause infrastructure drops (dropped: ${mInfra.infraDroppedRPS})`);
  assert.equal(mInfra.primaryBottleneck.id, 'gateway', 'Primary bottleneck must be Gateway Tier');
  console.log(`  ✓ Gateway saturation detected: ${mInfra.infraDroppedRPS} req/s dropped at gateway`);
  console.log(`  ✓ Primary bottleneck: ${mInfra.primaryBottleneck.name}\n`);
}

/* ── 6. Fail Policy: Fail-Open vs Fail-Closed (HTTP 503, never 500) ── */
{
  console.log('Test 6: Redis outage fail policy (fail-open vs fail-closed 503)');
  const model = new RateLimiterModel();

  // Fail-Open: traffic passes through
  const mOpen = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 5000,
    tokenStore: 'redis',
    failPolicy: 'fail_open',
    failures: { redisOutage: true },
    dt: 1.0,
  });
  assert.equal(mOpen.allowedRPS, 5000, 'Fail-open must allow all traffic through during Redis outage');
  assert.equal(mOpen.failClosed503RPS, 0, 'Fail-open has 0 fail-closed 503s');

  // Fail-Closed: traffic rejected with HTTP 503 (NOT 429, NOT 500)
  const mClosed = model.calculate({
    ...RL_DEFAULT_STATE,
    traffic: 5000,
    tokenStore: 'redis',
    failPolicy: 'fail_closed',
    failures: { redisOutage: true },
    dt: 1.0,
  });
  assert.equal(mClosed.allowedRPS, 0, 'Fail-closed must block all traffic when Redis is down');
  assert.equal(mClosed.failClosed503RPS, 5000, 'Fail-closed must generate 5,000 HTTP 503 responses');
  assert.equal(mClosed.rejectedRPS, 0, 'Redis outage is NOT a rate-limit policy 429 rejection');
  console.log('  ✓ Fail-open: all traffic passed to downstream');
  console.log(`  ✓ Fail-closed: ${mClosed.failClosed503RPS} req/s rejected with HTTP 503 (never 500, distinct from 429)\n`);
}

/* ── 7. Identity-Class Simulation Clarity ── */
{
  console.log('Test 7: Identity-Class Simulation abstraction');
  const model = new RateLimiterModel();
  const res = model.calculate(RL_DEFAULT_STATE);
  assert.equal(res.modelingApproach, 'identity-class simulation', 'Must explicitly declare identity-class simulation');
  assert.ok(res.mathBreakdowns.identity != null, 'Must provide mathematical breakdown for identity classes');
  console.log('  ✓ Verified identity-class simulation declaration and breakdowns\n');
}

/* ── 8. Distributed Topology & Coordination Evaluation (Batch 3) ── */
{
  console.log('Test 8: Distributed topology evaluation (Single Source of Truth)');
  const model = new RateLimiterModel();

  // Case A: Local Memory, 3 gateways, 60 RPS, limit 100 -> allowed = 60, leakage = 0
  const distA = model.evaluateDistributedTopology({
    storage: 'local_memory',
    gatewayCount: 3,
    traffic: 60,
    limit: 100
  });
  assert.equal(distA.totalAllowed, 60, 'Case A: 60 RPS under 100 limit must allow 60');
  assert.equal(distA.leakage, 0, 'Case A: 60 RPS under 100 limit must have 0 leakage');
  assert.equal(distA.perGwResults.length, 3, 'Must have 3 gateway results');
  assert.equal(distA.perGwResults[0].traffic, 20, 'Each gateway sees 20 RPS');
  assert.equal(distA.perGwResults[0].allowed, 20, 'Each gateway allows 20 RPS');
  console.log('  ✓ Case A verified: 3 gateways, 60 RPS, limit 100 → 60 allowed, 0 leakage');

  // Case B: Local Memory, 3 gateways, 300 RPS, limit 100 -> allowed = 300, leakage = 200
  const distB = model.evaluateDistributedTopology({
    storage: 'local_memory',
    gatewayCount: 3,
    traffic: 300,
    limit: 100
  });
  assert.equal(distB.totalAllowed, 300, 'Case B: 300 RPS across 3 gateways allows 300 in local memory');
  assert.equal(distB.leakage, 200, 'Case B: Distributed leakage must be 200 RPS');
  assert.equal(distB.isLeaking, true, 'Case B: isLeaking flag must be true');
  assert.equal(distB.perGwResults[0].allowed, 100, 'Gateway 1 allows 100 locally');
  console.log('  ✓ Case B verified: 3 gateways, 300 RPS, limit 100 → 300 allowed, +200 leakage');

  // Case C: Redis, 3 gateways, 300 RPS, limit 100 -> allowed = 100, rejected = 200, leakage = 0
  const distC = model.evaluateDistributedTopology({
    storage: 'redis',
    gatewayCount: 3,
    traffic: 300,
    limit: 100
  });
  assert.equal(distC.totalAllowed, 100, 'Case C: Redis shared state must enforce 100 global limit');
  assert.equal(distC.totalRejected, 200, 'Case C: Redis shared state rejects 200 with HTTP 429');
  assert.equal(distC.leakage, 0, 'Case C: Redis shared state has 0 leakage');
  assert.equal(distC.isLeaking, false, 'Case C: isLeaking flag must be false');
  console.log('  ✓ Case C verified: 3 gateways, 300 RPS, limit 100 (Redis) → 100 allowed, 200 rejected, 0 leakage\n');
}

/* ── 9. Final Algorithm Experiences (Batch 4) ── */
{
  console.log('Test 9: Algorithm Experiences (Token Bucket, Fixed Window, Sliding Window)');

  // 1. Token Bucket
  const tbModel = new RateLimiterModel();
  tbModel.resetState(200, 100);
  const tbBurst = tbModel.evaluateInteractiveRequests(150, { algorithm: 'token_bucket', bucketCapacity: 200, refillRate: 100, limitPerUser: 100 }, 0.0);
  assert.equal(tbBurst.allowed, 150, 'Token Bucket allows initial burst up to capacity');
  assert.equal(Math.round(tbBurst.tokensAfter), 50, '50 tokens remaining after 150 burst');

  // Deplete remainder
  const tbDeplete = tbModel.evaluateInteractiveRequests(60, { algorithm: 'token_bucket', bucketCapacity: 200, refillRate: 100, limitPerUser: 100 }, 0.0);
  assert.equal(tbDeplete.allowed, 50, 'Allows remaining 50 tokens');
  assert.equal(tbDeplete.rejected, 10, 'Rejects 10 requests when bucket reaches 0');
  assert.equal(tbDeplete.statusCode, 429, 'Returns 429 on rejection');

  // Refill via simulation clock advance
  const tbRefill = tbModel.advanceSimulationTime(0.5, { refillRate: 100, bucketCapacity: 200 });
  assert.equal(tbRefill.newTokens, 50, '+0.5s adds exactly 50 tokens at 100/s');
  assert.equal(Math.round(tbRefill.tokens), 50, 'Token count refilled to 50');
  console.log('  ✓ Token Bucket: Burst (150 allowed) → Depletion (429 rejected) → Clock Refill (+50 tokens)');

  // 2. Fixed Window
  const fwModel = new RateLimiterModel();
  fwModel.resetState(100, 100);
  const fw1 = fwModel.evaluateInteractiveRequests(99, { algorithm: 'fixed_window', limitPerUser: 100, windowSizeSec: 1.0 }, 0.0);
  assert.equal(fw1.allowed, 99, 'Fixed window allows 99 inside window');
  assert.equal(fw1.windowCount, 99, 'Window count is 99');

  // Exceed window limit
  const fw2 = fwModel.evaluateInteractiveRequests(5, { algorithm: 'fixed_window', limitPerUser: 100, windowSizeSec: 1.0 }, 0.0);
  assert.equal(fw2.allowed, 1, 'Allows 1 more before hitting 100 limit');
  assert.equal(fw2.rejected, 4, 'Rejects 4 requests with 429');

  // Cross window boundary at T = 1.0s
  const fwAdvance = fwModel.advanceSimulationTime(1.0, { windowSizeSec: 1.0 });
  assert.equal(fwAdvance.windowReset, true, 'Window boundary crossing triggers windowReset');
  assert.equal(fwAdvance.windowCount, 0, 'Window counter reset to 0 at boundary');
  console.log('  ✓ Fixed Window: 100 limit enforced in window → Boundary crossed at T=1.0s resets counter to 0');

  // 3. Sliding Window
  const swModel = new RateLimiterModel();
  swModel.resetState(100, 100);
  // Send 50 requests in Window 1
  swModel.evaluateInteractiveRequests(50, { algorithm: 'sliding_window', limitPerUser: 100, windowSizeSec: 1.0 }, 0.0);
  // Advance by 1.0s (moves Window 1 count to prevWindowCount = 50)
  swModel.advanceSimulationTime(1.0, { windowSizeSec: 1.0 });
  // Advance by 0.4s into current window (overlap weight is 1 - 0.4 = 0.60)
  swModel.advanceSimulationTime(0.4, { windowSizeSec: 1.0 });
  // Send 20 requests in current window
  const swRes = swModel.evaluateInteractiveRequests(20, { algorithm: 'sliding_window', limitPerUser: 100, windowSizeSec: 1.0 }, 0.0);
  assert.equal(swRes.prevWindowCount, 50, 'Prev window count preserved');
  assert.equal(swRes.currWindowCount, 20, 'Curr window count is 20');
  assert.equal(swRes.overlapWeight, 0.6, 'Overlap weight is 0.60');
  // Expected effective count: 50 * 0.6 + 20 = 50
  assert.equal(swRes.effectiveSlidingCount, 50, 'Effective sliding count is 50 * 0.6 + 20 = 50');
  console.log('  ✓ Sliding Window: Weighted overlap calculation verified (50 × 0.60 + 20 = 50.0 / 100)\n');
}

/* ── 10. Force Limit Reached: no fabricated request, real state jump ── */
{
  console.log('Test 10: Force Limit Reached (forceExhaustLimit) with no fabricated request');

  // Token Bucket
  const tbModel = new RateLimiterModel();
  tbModel.resetState(200, 100);
  const tbState = { algorithm: 'token_bucket', bucketCapacity: 200, refillRate: 100, limitPerUser: 100 };
  const tbForce = tbModel.forceExhaustLimit(tbState);
  assert.equal(tbForce.tokensBefore, 200, 'Tokens before forcing should reflect real prior state (full bucket)');
  assert.equal(tbForce.tokensAfter, 0, 'Tokens must be forced to 0 (exhausted)');
  assert.equal(tbModel.simTime, 0, 'forceExhaustLimit must not advance the simulation clock');
  const tbNext = tbModel.evaluateInteractiveRequests(1, tbState, 0.0);
  assert.equal(tbNext.allowed, 0, 'The next request after forcing must be rejected');
  assert.equal(tbNext.rejected, 1, 'The next request after forcing must be rejected');
  assert.equal(tbNext.statusCode, 429, 'Next request must return HTTP 429');
  console.log('  ✓ Token Bucket: forced to 0/200, next request rejected (429), simTime unchanged');

  // Fixed Window
  const fwModel = new RateLimiterModel();
  fwModel.resetState(100, 100);
  const fwState = { algorithm: 'fixed_window', limitPerUser: 100, windowSizeSec: 1.0 };
  const fwForce = fwModel.forceExhaustLimit(fwState);
  assert.equal(fwForce.windowCountBefore, 0, 'Window count before forcing should be 0');
  assert.equal(fwForce.windowCountAfter, 100, 'Window count must be forced to the limit');
  const fwNext = fwModel.evaluateInteractiveRequests(1, fwState, 0.0);
  assert.equal(fwNext.allowed, 0, 'The next request after forcing must be rejected');
  assert.equal(fwNext.statusCode, 429, 'Next request must return HTTP 429');
  console.log('  ✓ Fixed Window: forced to 100/100, next request rejected (429)');

  // Sliding Window
  const swModel = new RateLimiterModel();
  swModel.resetState(100, 100);
  const swState = { algorithm: 'sliding_window', limitPerUser: 100, windowSizeSec: 1.0 };
  const swForce = swModel.forceExhaustLimit(swState);
  assert.ok(swForce.effectiveCountAfter >= 100, 'Weighted effective count must reach the limit');
  const swNext = swModel.evaluateInteractiveRequests(1, swState, 0.0);
  assert.equal(swNext.allowed, 0, 'The next request after forcing must be rejected');
  assert.equal(swNext.statusCode, 429, 'Next request must return HTTP 429');
  console.log('  ✓ Sliding Window: weighted count forced to limit, next request rejected (429)\n');
}

/* ── 11. Two-Clock Regression Guard ──
 * Mirrors the real controller wiring: an interactive model driven purely by
 * simTime-based methods must never be corrupted by a SEPARATE model's
 * calculate() calls (which use real wall-clock time internally). This is
 * the root cause of the Fixed Window Unix-timestamp desync bug.
 */
{
  console.log('Test 11: Interactive model stays on sim-clock even while a separate scale model runs calculate()');

  const interactiveModel = new RateLimiterModel();
  const scaleModel = new RateLimiterModel();

  const fwState = { ...RL_DEFAULT_STATE, algorithm: 'fixed_window', limitPerUser: 100, windowSizeSec: 1.0 };

  // Drive the interactive model purely via the simulation clock.
  interactiveModel.evaluateInteractiveRequests(10, fwState, 0.0);
  interactiveModel.advanceSimulationTime(0.5, { windowSizeSec: 1.0 });
  const interactiveWindowStart = interactiveModel.identityState.top.windowStart;
  assert.ok(interactiveWindowStart < 10, `Interactive windowStart must stay within sim-time bounds, got ${interactiveWindowStart}`);

  // Drive the SEPARATE scale model via calculate() using real wall-clock time
  // (no dt/timestampSec passed, matching how the live controller calls it).
  scaleModel.calculate({ ...fwState, traffic: 5000, activeIdentities: 500 });
  scaleModel.calculate({ ...fwState, traffic: 6000, activeIdentities: 500 });

  // The interactive model must be completely unaffected by the scale model's
  // real-time-derived windowStart. They must never share identityState.
  assert.equal(
    interactiveModel.identityState.top.windowStart, interactiveWindowStart,
    'Interactive model windowStart must be untouched by a separate scale model calculate() call'
  );
  assert.ok(
    interactiveModel.identityState.top.windowStart < 100,
    'Interactive model windowStart must never become a Unix epoch value'
  );
  console.log('  ✓ Interactive model windowStart isolated from scale model calculate() with no epoch leakage\n');
}

/* ── 12. Force Limit holds through the UI's own time step ──
 * The tracer advances the sim clock by 2ms per request before evaluating.
 * At a 10ms step and 100 tokens/s that refilled exactly one whole token, so an
 * exhausted bucket wrongly allowed the very next request. Guard the promise
 * the UI makes: after Force Limit Reached, the next request really is a 429.
 */
{
  console.log('Test 12: Force Limit Reached survives the interactive time step');

  const uiStep = (count) => Math.min(0.2, count * 0.002); // mirrors tracer.js

  for (const [algo, extra] of [
    ['token_bucket', { bucketCapacity: 200, refillRate: 100 }],
    ['fixed_window', { windowSizeSec: 1.0 }],
    ['sliding_window', { windowSizeSec: 1.0 }],
  ]) {
    const model = new RateLimiterModel();
    model.resetState(200, 100);
    const state = { algorithm: algo, limitPerUser: 100, ...extra };

    model.forceExhaustLimit(state);
    const next = model.evaluateInteractiveRequests(1, state, uiStep(1));

    assert.equal(next.allowed, 0, `${algo}: request after Force Limit must not be allowed`);
    assert.equal(next.statusCode, 429, `${algo}: request after Force Limit must return 429`);
    console.log(`  ✓ ${algo}: exhausted → next request rejected (429) even after the UI time step`);
  }
  console.log('');
}

console.log('🎉 ALL RATE LIMITER LOGIC TESTS PASSED SUCCESSFULLY!');
