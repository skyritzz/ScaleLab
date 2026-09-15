/**
 * Rate Limiter Request Tracer & Interactive Causal Pipeline
 *
 * Visualizes the causal journey of single and burst requests:
 *   Client → API Gateway → Rate Limiter → Token Store (Redis) → Downstream API → HTTP Response
 *
 * Algorithm Experiences:
 *   - Token Bucket: Burst capacity, refill rate, token consumption, sustained rate.
 *   - Fixed Window: Fixed time boundaries, counter, boundary burst vulnerability.
 *   - Sliding Window: 1-second rolling interval, weighted overlap calculation.
 *   - Algorithm Comparison Table: Burst, boundary problem, and state comparison.
 *
 * Distinguishes:
 *   - Allowed: Downstream CALLED (HTTP 200)
 *   - Rejected: Downstream NOT CALLED (HTTP 429 or 503)
 *   - Causal step-by-step reasoning per algorithm
 *   - Simulation Clock (T = 0.000s) and boundary / refill calculation
 *   - Single Source of Truth: All metrics derived from model.js
 */

import { rlIconBadge, rlIcon } from './icons.js';

export class RateLimiterTracer {
  constructor(containerEl, inspectorEl, storeEl, model = null) {
    this.containerEl = containerEl;
    this.inspectorEl = inspectorEl;
    this.storeEl = storeEl;
    this.model = model;

    this.requestCount = 0;
    this.isTracing = false;

    // Default metadata
    this.identity = 'user_42 (top identity class)';
    this.algorithm = 'token_bucket';
    this.limit = 100;
    this.windowSize = 1.0;
    this.ttl = 60;
  }

  /* ── Getters delegating to model as Single Source of Truth ── */
  get tokens() {
    return this.model?.identityState?.top?.tokens ?? 200;
  }

  get capacity() {
    return this.model?.identityState?.top?.bucketCapacity ?? 200;
  }

  get refillRate() {
    return this.model?.identityState?.top?.refillRate ?? 100;
  }

  get simTime() {
    return this.model?.simTime ?? 0.0;
  }

  get windowStart() {
    return this.model?.identityState?.top?.windowStart ?? 0.0;
  }

  get windowEnd() {
    return this.windowStart + this.windowSize;
  }

  get windowCount() {
    return this.model?.identityState?.top?.windowCount ?? 0;
  }

  get prevWindowCount() {
    return this.model?.identityState?.top?.prevWindowCount ?? 0;
  }

  get currWindowCount() {
    return this.model?.identityState?.top?.currWindowCount ?? 0;
  }

  get overlapWeight() {
    const W = this.windowSize || 1.0;
    const elapsed = (this.simTime - this.windowStart) % W;
    return W > 0 ? Math.max(0, Math.min(1, 1 - (elapsed / W))) : 0;
  }

  get effectiveSlidingCount() {
    return Math.round((this.prevWindowCount * this.overlapWeight + this.currWindowCount) * 10) / 10;
  }

  /* ── Synchronize with simulator state & metrics ── */
  syncWithState(state, metrics) {
    if (!state) return;
    this.algorithm = state.algorithm || 'token_bucket';
    this.limit = state.limitPerUser || 100;
    this.windowSize = state.windowSizeSec || 1.0;

    if (this.model?.identityState?.top) {
      this.model.identityState.top.bucketCapacity = state.bucketCapacity || 200;
      this.model.identityState.top.refillRate = state.refillRate || 100;
      if (this.model.identityState.top.tokens > state.bucketCapacity) {
        this.model.identityState.top.tokens = state.bucketCapacity;
      }
    }

    this.updateTokenVisualWidget();
    this.renderTokenStoreInspector(state);
  }

  updateAlgorithmState(state, metrics) {
    this.syncWithState(state, metrics);
  }

  traceRequest(state, isRejected = false) {
    return this.executeRequests(1, state, isRejected);
  }

  /* ── Step Simulation Clock (e.g. +0.5s) ── */
  stepSimulationTime(seconds = 0.5, state = null) {
    let res;
    if (this.model) {
      res = this.model.advanceSimulationTime(seconds, state);
    } else {
      res = {
        elapsed: seconds,
        newTokens: seconds * this.refillRate,
        tokens: this.tokens,
        capacity: this.capacity,
        simTime: this.simTime + seconds,
        windowReset: false,
        windowStart: 0,
        windowCount: 0
      };
    }

    this.updateTokenVisualWidget();
    this.renderTokenStoreInspector(state);

    // Show causal clock banner
    const banner = document.getElementById('rl-causal-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.className = 'rl-causal-banner causal-allow';

      if (this.algorithm === 'token_bucket') {
        banner.innerHTML = `
          <div class="causal-step-row">
            <span>⏱️ <strong>Simulation clock advanced +${res.elapsed.toFixed(3)}s</strong> (T = ${res.simTime.toFixed(3)}s)</span>
            <span style="margin-left:auto;">Tokens: <strong>${Math.round(res.tokens)} / ${res.capacity}</strong></span>
          </div>
          <div class="causal-step-row">
            <span>Refill formula: elapsed (${res.elapsed.toFixed(3)}s) × ${res.refillRate}/s = <strong>+${res.newTokens.toFixed(1)} tokens</strong> (capped at burst capacity ${res.capacity})</span>
          </div>`;
      } else if (this.algorithm === 'fixed_window') {
        if (res.windowReset) {
          banner.innerHTML = `
            <div class="causal-step-row">
              <span>⏱️ <strong>Simulation clock advanced +${res.elapsed.toFixed(3)}s</strong> (T = ${res.simTime.toFixed(3)}s)</span>
              <span class="causal-highlight" style="margin-left:auto;">🔄 Boundary Crossed!</span>
            </div>
            <div class="causal-step-row">
              <span>Fixed Window boundary reached: Counter reset to <strong>0 / ${this.limit}</strong>. New window: [${res.windowStart.toFixed(3)}s → ${(res.windowStart + this.windowSize).toFixed(3)}s].</span>
            </div>`;
        } else {
          banner.innerHTML = `
            <div class="causal-step-row">
              <span>⏱️ <strong>Simulation clock advanced +${res.elapsed.toFixed(3)}s</strong> (T = ${res.simTime.toFixed(3)}s)</span>
              <span style="margin-left:auto;">Window Count: <strong>${res.windowCount} / ${this.limit}</strong></span>
            </div>
            <div class="causal-step-row">
              <span>Inside window [${res.windowStart.toFixed(3)}s → ${(res.windowStart + this.windowSize).toFixed(3)}s]. Boundary resets in ${(res.windowStart + this.windowSize - res.simTime).toFixed(3)}s.</span>
            </div>`;
        }
      } else {
        // Sliding window
        banner.innerHTML = `
          <div class="causal-step-row">
            <span>⏱️ <strong>Simulation clock advanced +${res.elapsed.toFixed(3)}s</strong> (T = ${res.simTime.toFixed(3)}s)</span>
            <span style="margin-left:auto;">Overlap Weight: <strong>${this.overlapWeight.toFixed(2)}</strong></span>
          </div>
          <div class="causal-step-row">
            <span>Rolling window advanced. Weighted count: <strong>${this.prevWindowCount} × ${this.overlapWeight.toFixed(2)} + ${this.currWindowCount} = ${this.effectiveSlidingCount.toFixed(1)} / ${this.limit}</strong>.</span>
          </div>`;
      }
    }
  }

  /* ── Reset Interactive Token State ── */
  resetTokens(state = null) {
    const B = state?.bucketCapacity || this.capacity || 200;
    const r = state?.refillRate || this.refillRate || 100;

    if (this.model) {
      this.model.resetState(B, r);
    }
    this.requestCount = 0;

    this.updateTokenVisualWidget();
    this.renderTokenStoreInspector(state);
    this.renderIdleState();

    const banner = document.getElementById('rl-causal-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.className = 'rl-causal-banner causal-allow';
      banner.innerHTML = `<div>↺ <strong>State Reset:</strong> Model reset. Simulation clock at T = 0.000s.</div>`;
    }
  }

  /* ── Force Limit Reached: jump directly to the boundary, no request sent ── */
  forceLimitReached(state = {}) {
    if (this.isTracing) return;

    const res = this.model
      ? this.model.forceExhaustLimit(state)
      : { algorithm: this.algorithm, capacity: this.capacity, limit: this.limit,
          tokensBefore: this.tokens, tokensAfter: 0, simTime: this.simTime };

    this.updateTokenVisualWidget();
    this.renderTokenStoreInspector(state);

    let whyLine;
    if (res.algorithm === 'token_bucket') {
      whyLine = `Tokens forced from ${Math.round(res.tokensBefore ?? this.tokens)} to 0 / ${res.capacity ?? this.capacity}.`;
    } else if (res.algorithm === 'fixed_window') {
      whyLine = `Window counter forced to ${res.windowCountAfter ?? this.limit} / ${res.limit ?? this.limit}. Window resets in ${Math.max(0, (res.windowEnd ?? 0) - (res.simTime ?? this.simTime)).toFixed(2)}s.`;
    } else {
      whyLine = `Weighted count forced to ${res.effectiveCountAfter ?? this.limit} / ${res.limit ?? this.limit}.`;
    }

    const banner = document.getElementById('rl-causal-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.className = 'rl-causal-banner causal-warn';
      banner.innerHTML = `
        <div class="rl-causal-inner">
          <div class="causal-top">
            <span class="causal-verdict causal-verdict--warn">
              ${rlIcon('alertTriangle', { size: 20 })}
              <span class="causal-verdict-word">Limit reached</span>
              <span class="causal-verdict-code">no request sent</span>
            </span>
            <span class="causal-sim-clock">T = ${(res.simTime ?? this.simTime).toFixed(3)}s</span>
          </div>
          <p class="causal-headline">The limiter was forced straight to its exhausted boundary.</p>
          <p class="causal-why">${whyLine}</p>
          <div class="causal-next">
            <span class="causal-next-label">Try next</span>
            <span class="causal-next-text">Hit <strong>Send Request</strong> and it will come back 429.</span>
          </div>
        </div>`;
    }
  }

  /* ── Reset banner/pipeline to a clean, idle state for a newly selected algorithm ── */
  resetForNewAlgorithm(state = null) {
    this.syncWithState(state);

    const banner = document.getElementById('rl-causal-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.className = 'rl-causal-banner causal-allow';
      const algoName = (this.algorithm || 'token_bucket').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      banner.innerHTML = `<div>🔄 <strong>New ${algoName} experiment started.</strong> Send a request to see how it behaves.</div>`;
    }

    this.renderIdleState();
  }

  /* ── Send Single or Burst Requests (Model-driven) ── */
  async executeRequests(count = 1, state = {}, simulateLimitHit = false) {
    if (this.isTracing) return;
    this.isTracing = true;

    try {
      // Advance simulation time per batch (2ms per request). The floor matters:
      // at a 10ms floor a single request refilled exactly one token at 100/s, so
      // an exhausted bucket would allow the very next request instead of 429ing.
      const dt = Math.min(0.2, count * 0.002);

      // Execute via Model as Single Source of Truth
      let res;
      if (this.model) {
        res = this.model.evaluateInteractiveRequests(count, state, dt, simulateLimitHit);
      } else {
        res = {
          count,
          allowed: count,
          rejected: 0,
          tokensBefore: 200,
          tokensAfter: 199,
          capacity: 200,
          refillRate: 100,
          limit: 100,
          algorithm: this.algorithm,
          simTime: dt,
          statusCode: 200,
          isAllowed: true,
          isFailClosed: false,
          windowStart: 0,
          windowEnd: 1,
          windowCount: 1,
          prevWindowCount: 0,
          currWindowCount: 1,
          overlapWeight: 1,
          effectiveSlidingCount: 1
        };
      }

      this.requestCount += res.count;
      const reqId = `REQ-${String(this.requestCount).padStart(4, '0')}`;

      const isRedis = state.tokenStore !== 'local_memory';
      const isRedisOutage = Boolean(state.failures?.redisOutage);

      this.updateTokenVisualWidget();
      this.renderTokenStoreInspector(state);

      const isAllowed = res.isAllowed;
      const isFailClosed = res.isFailClosed;
      const statusCode = res.statusCode;

      // Educational RateLimit headers: relative duration (seconds until reset/refill)
      const secondsToReset = this.algorithm === 'token_bucket'
        ? ((res.tokensAfter < res.capacity && res.refillRate > 0)
            ? Math.max(0.01, (1.0 - (res.tokensAfter % 1.0)) / res.refillRate).toFixed(2)
            : '0.00')
        : Math.max(0.01, res.windowEnd - res.simTime).toFixed(2);
      // Raw sim-time window boundary (not a Unix epoch, kept as techDetail only)
      const windowEndAbsolute = res.windowEnd != null ? res.windowEnd.toFixed(3) : secondsToReset;

      let whatHappened = '';
      let whyHappened = '';
      let whatNext = '';

      if (isRedis && isRedisOutage) {
        if (state.failPolicy === 'fail_open') {
          whatHappened = 'Request admitted under the fail-open policy.';
          whyHappened = 'Redis cluster is unreachable. System fail-open policy prioritizes user availability by bypassing rate checks and forwarding to downstream.';
          whatNext = 'Switch to Fail-Closed policy in Scale Controls to observe downstream protection during outage.';
        } else {
          whatHappened = 'Fast-rejected before reaching downstream.';
          whyHappened = 'Redis cluster is unreachable. Fail-Closed policy prevents unmetered traffic storms from overwhelming backend databases.';
          whatNext = 'Restore Redis connection in Chaos Lab to resume normal traffic routing.';
        }
      } else if (res.count === 1) {
        if (this.algorithm === 'token_bucket') {
          if (isAllowed) {
            whatHappened = '1 request sent, 1 allowed through.';
            whyHappened = `A token was available. The bucket held ${res.tokensBefore.toFixed(1)}, one was consumed, and ${res.tokensAfter.toFixed(1)} are left.`;
            whatNext = 'Send Burst (50) or Force Limit Reached to test how the system reacts under sudden load spikes.';
          } else {
            whatHappened = '1 request sent, 0 allowed through.';
            whyHappened = `The bucket held only ${res.tokensBefore.toFixed(1)} tokens, less than the 1 a request costs. Downstream was never called.`;
            whatNext = 'Click "+0.5s Refill" to replenish tokens over time, or click "↺ Reset".';
          }
        } else if (this.algorithm === 'fixed_window') {
          if (isAllowed) {
            whatHappened = '1 request sent, 1 allowed through.';
            whyHappened = `This window still had room. The counter sits at ${res.windowCount} of ${res.limit} and resets at ${res.windowEnd.toFixed(2)}s.`;
            whatNext = 'Send repeated requests to observe counter incrementing toward limit.';
          } else {
            whatHappened = '1 request sent, 0 allowed through.';
            whyHappened = `The window is full at ${res.limit} of ${res.limit}. Downstream was never called. The counter resets in ${Math.max(0.01, res.windowEnd - res.simTime).toFixed(2)}s.`;
            whatNext = 'Click "+0.5s Advance" to cross boundary and witness counter reset to 0.';
          }
        } else {
          // Sliding window
          if (isAllowed) {
            whatHappened = '1 request sent, 1 allowed through.';
            whyHappened = `The rolling 1s window is carrying ${res.effectiveSlidingCount.toFixed(1)} of ${res.limit}, still under the limit.`;
            whatNext = 'Notice how rolling calculation smooths traffic without hard boundary resets.';
          } else {
            whatHappened = '1 request sent, 0 allowed through.';
            whyHappened = `The rolling 1s window is carrying ${res.effectiveSlidingCount.toFixed(1)} of ${res.limit}, which is the limit. Downstream was never called.`;
            whatNext = 'Click "+0.5s Advance" to allow older window traffic weight to decay.';
          }
        }
      } else {
        whatHappened = res.rejected > 0
          ? `${res.count} requests sent, ${res.allowed} allowed through, ${res.rejected} throttled.`
          : `${res.count} requests sent, all ${res.allowed} allowed through.`;
        whyHappened = res.rejected > 0
          ? `Capacity ran out after ${res.allowed} requests. The remaining ${res.rejected} were throttled before they could reach downstream.`
          : `There was enough capacity to absorb the whole batch, so nothing was throttled.`;
        whatNext = res.rejected > 0
          ? 'Capacity exhausted. Click "+0.5s Refill" or switch algorithms to observe recovery.'
          : 'System handled load within burst limits. Try sending a larger batch or Force Limit Reached.';
      }

      // Update banner
      const banner = document.getElementById('rl-causal-banner');
      if (banner) {
        banner.style.display = 'block';
        banner.className = `rl-causal-banner ${isAllowed ? 'causal-allow' : isFailClosed ? 'causal-warn' : 'causal-reject'}`;
        const verdict = isAllowed
          ? { icon: 'checkCircle', word: 'Allowed', code: 'HTTP 200', tone: 'allow' }
          : isFailClosed
            ? { icon: 'alertTriangle', word: 'Fail-closed', code: 'HTTP 503', tone: 'warn' }
            : { icon: 'xCircle', word: 'Blocked', code: 'HTTP 429', tone: 'reject' };

        banner.innerHTML = `
          <div class="rl-causal-inner">
            <div class="causal-top">
              <span class="causal-verdict causal-verdict--${verdict.tone}">
                ${rlIcon(verdict.icon, { size: 20 })}
                <span class="causal-verdict-word">${verdict.word}</span>
                <span class="causal-verdict-code">${verdict.code}</span>
              </span>
              <span class="causal-sim-clock">T = ${res.simTime.toFixed(3)}s</span>
            </div>
            <p class="causal-headline">${whatHappened}</p>
            <p class="causal-why">${whyHappened}</p>
            <div class="causal-next">
              <span class="causal-next-label">Try next</span>
              <span class="causal-next-text">${whatNext}</span>
            </div>
          </div>`;
      }

      // Build visual pipeline hops
      const gwLatency = 1.0;
      const rlLatency = 0.5;
      const redisLatency = isRedis ? 2.0 : 0.2;
      const dsLatency = isAllowed ? 12.0 : 0.0;
      const totalLatency = (gwLatency + rlLatency + redisLatency + dsLatency).toFixed(1);

      const hops = [
        {
          name: 'Client',
          icon: 'client',
          color: '#38bdf8',
          latency: 0,
          status: 'sent',
          operation: `GET /api/resource${count > 1 ? ` (×${count})` : ''}`,
          detail: `Initiated by identity ${this.identity}`,
          metadata: {
            'Identity': this.identity,
            'Requests': String(count),
            'Simulated-Time': `T = ${this.simTime.toFixed(3)}s`
          },
          techDetails: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'X-Forwarded-For': '192.168.1.42',
            'X-Request-ID': reqId
          }
        },
        {
          name: 'API Gateway',
          icon: 'gateway',
          color: '#a78bfa',
          latency: gwLatency,
          status: 'routed',
          operation: 'Route → Rate Limiter',
          detail: `Gateway node received request, routed to Rate Limiter daemon`,
          metadata: {
            'Gateway Node': 'gw-01',
            'Routing Latency': `${gwLatency}ms`
          },
          techDetails: {
            'TLS Terminated': 'true',
            'Protocol': 'HTTP/2'
          }
        },
        {
          name: 'Rate Limiter',
          icon: 'shield',
          color: isAllowed ? '#34d399' : '#f43f5e',
          latency: rlLatency,
          status: isAllowed ? 'allowed' : isFailClosed ? 'error_503' : 'rejected',
          operation: isRedisOutage
            ? (isFailClosed ? 'REDIS DOWN → FAIL-CLOSED (503)' : 'REDIS DOWN → FAIL-OPEN (200)')
            : isAllowed
              ? `CHECK (${this.algorithm.replace('_', ' ')}) → ALLOW`
              : `CHECK (${this.algorithm.replace('_', ' ')}) → REJECT 429`,
          detail: whyHappened,
          metadata: {
            'Algorithm': this.algorithm.replace('_', ' ').toUpperCase(),
            'Check Metric': this.algorithm === 'token_bucket'
              ? `${res.tokensBefore.toFixed(1)} tokens available`
              : this.algorithm === 'fixed_window'
              ? `Count: ${res.windowCount} / ${res.limit}`
              : `Weighted Count: ${res.effectiveSlidingCount} / ${res.limit}`,
            'Outcome': isAllowed ? 'ALLOW' : isFailClosed ? 'REJECT (503)' : 'REJECT (429)'
          },
          techDetails: {
            'Limiter Node': 'rl-node-01',
            'Evaluation Latency': `${rlLatency}ms`
          }
        },
        {
          name: isRedis ? 'Redis Token Store' : 'Local Memory Store',
          icon: 'database',
          color: '#f59e0b',
          latency: redisLatency,
          status: isRedisOutage ? (isFailClosed ? 'rejected' : 'allowed') : isAllowed ? 'allowed' : 'rejected',
          operation: isRedisOutage
            ? 'STORAGE UNREACHABLE'
            : isRedis
              ? 'EVAL (Redis Lua atomic check & decr)'
              : 'In-Memory HashMap lookup',
          detail: isRedisOutage
            ? `Connection timeout to Redis shard. Fallback policy invoked.`
            : this.algorithm === 'token_bucket'
            ? (isAllowed
                ? `State updated: ${Math.round(this.tokens)} tokens remaining / ${this.capacity} capacity`
                : `State observed: ${Math.round(this.tokens)} / ${this.capacity} tokens, so none were consumed (rejected)`)
            : (isAllowed
                ? `State updated: ${this.algorithm === 'fixed_window' ? this.windowCount : this.effectiveSlidingCount.toFixed(1)} / ${this.limit} requests recorded`
                : `State observed: ${this.algorithm === 'fixed_window' ? this.windowCount : this.effectiveSlidingCount.toFixed(1)} / ${this.limit}, counter not incremented (rejected)`),
          metadata: {
            'Storage': isRedis ? 'Redis Cluster (Shared)' : 'Local Process Memory',
            'Key': `ratelimit:user_42`,
            'State Metric': this.algorithm === 'token_bucket'
              ? `${Math.round(this.tokens)} / ${this.capacity} tokens`
              : `Counter: ${this.algorithm === 'fixed_window' ? this.windowCount : this.effectiveSlidingCount} / ${this.limit}`
          },
          techDetails: {
            'Storage TTL': `${this.ttl}s`,
            'Command': isRedis ? 'EVAL (Lua check+decr)' : 'O(1) Map.set'
          }
        },
        {
          name: 'Downstream API',
          icon: 'zap',
          color: isAllowed ? '#34d399' : '#f43f5e',
          latency: dsLatency,
          status: isAllowed ? 'processed' : 'not_called',
          operation: isAllowed ? 'Process Business Logic' : 'NOT CALLED',
          detail: isAllowed
            ? 'Request permitted through rate limiter. Downstream service executed business logic.'
            : 'Rate limit exceeded! Downstream service was NOT CALLED, protecting backend resources.',
          metadata: {
            'Status': isAllowed ? 'CALLED & PROCESSED' : 'NOT CALLED (PROTECTED)',
            'Execution Latency': isAllowed ? `${dsLatency}ms` : '0.0ms (bypassed)',
            'Service': 'protected-api-service'
          },
          techDetails: {
            'Backend Worker': isAllowed ? 'app-worker-03' : 'none',
            'Database Queries': isAllowed ? '1 query executed' : '0 queries'
          }
        },
        {
          name: isAllowed ? '200 OK' : isFailClosed ? '503 Service Unavailable' : '429 Too Many Requests',
          icon: isAllowed ? 'checkCircle' : 'xCircle',
          color: isAllowed ? '#34d399' : '#f43f5e',
          latency: 0,
          status: isAllowed ? 'success' : isFailClosed ? 'error_503' : 'rate_limited',
          operation: isAllowed ? 'HTTP 200 OK' : isFailClosed ? 'HTTP 503 Service Unavailable' : 'HTTP 429 Too Many Requests',
          detail: isAllowed
            ? 'Request completed successfully within rate limits.'
            : isFailClosed
              ? 'Token store unavailable under fail-closed policy. Client receives 503.'
              : 'Rate limit exceeded. Client receives 429 and must retry after reset window.',
          metadata: {
            'RateLimit-Limit': String(this.limit),
            'RateLimit-Remaining': String(Math.max(0, this.algorithm === 'token_bucket' ? Math.floor(this.tokens) : this.limit - (this.algorithm === 'fixed_window' ? this.windowCount : Math.ceil(this.effectiveSlidingCount)))),
            'RateLimit-Reset': `${secondsToReset}s (relative)`,
            ...(isAllowed ? {} : { 'Retry-After': '1s' })
          },
          techDetails: {
            'Total Latency': `${totalLatency}ms`,
            'Status Code': String(statusCode),
            'Window-End (sim)': `T = ${windowEndAbsolute}s`,
            'Reset Timestamp (Unix)': `${(Math.floor(Date.now() / 1000) + parseFloat(secondsToReset)).toFixed(0)}`
          }
        }
      ];

      // Render animated pipeline
      await this._renderPipeline(hops, statusCode, isAllowed);
    } catch (err) {
      console.error('[RateLimiterTracer] executeRequests failed:', err);
    } finally {
      this.isTracing = false;
    }
  }

  /* ── Animate and Render Pipeline ── */
  async _renderPipeline(hops, statusCode, isAllowed) {
    if (!this.containerEl) return;

    const accentColor = isAllowed ? '#34d399' : '#f43f5e';
    const accentGlow  = isAllowed ? 'rgba(52,211,153,0.3)' : 'rgba(244,63,94,0.3)';

    // ── Horizontal flow strip ──
    let flowHtml = `<div class="rlpf-flow-strip">`;
    for (let i = 0; i < hops.length; i++) {
      const h = hops[i];
      const isNotCalled  = h.status === 'not_called';
      const isRejected   = h.status === 'rejected' || h.status === 'rate_limited';
      const isError503   = h.status === 'error_503';
      const isOk         = h.status === 'allowed' || h.status === 'success' || h.status === 'processed' || h.status === 'sent' || h.status === 'routed';

      const nodeAccent = isNotCalled ? '#475569' : h.color;
      const nodeMod = isNotCalled ? 'rlpf-node--ghost' : isRejected || isError503 ? 'rlpf-node--reject' : isOk ? 'rlpf-node--ok' : '';

      flowHtml += `
        <div class="rlpf-node ${nodeMod}" data-hop="${i}" data-status="${h.status}"
             style="--na:${nodeAccent}; opacity:0; transform:translateY(12px);">
          <div class="rlpf-node-icon">${rlIconBadge(h.icon, { color: nodeAccent, size: 38, iconSize: 19 })}</div>
          <div class="rlpf-node-meta">
            <span class="rlpf-node-name">${h.name}</span>
            <span class="rlpf-node-op">${isNotCalled ? '⊘ NOT CALLED' : h.operation}</span>
          </div>
          ${h.latency > 0 ? `<div class="rlpf-latency-pill">${h.latency}ms</div>` : ''}
        </div>`;

      if (i < hops.length - 1) {
        const connectorClass = isNotCalled ? 'rlpf-connector--ghost' : '';
        flowHtml += `
          <div class="rlpf-connector ${connectorClass}" style="opacity:0;">
            <div class="rlpf-connector-line"></div>
            <div class="rlpf-connector-dot"></div>
            <svg class="rlpf-arrow-svg" width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 5 L8 5 M6 3 L8 5 L6 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>`;
      }
    }
    flowHtml += `</div>`;

    // ── Result banner ──
    const resultIcon  = isAllowed ? '✓' : statusCode === 503 ? '⚠' : '✕';
    const resultLabel = isAllowed ? 'ALLOWED · HTTP 200 OK' : statusCode === 503 ? 'FAIL-CLOSED · HTTP 503' : 'RATE LIMITED · HTTP 429';
    const resultClass = isAllowed ? 'rlpf-result--ok' : 'rlpf-result--reject';
    flowHtml += `
      <div class="rlpf-result-bar ${resultClass}">
        <span class="rlpf-result-icon">${resultIcon}</span>
        <span class="rlpf-result-label">${resultLabel}</span>
        <span class="rlpf-result-sub">${isAllowed ? 'Downstream was called · Business logic executed' : statusCode === 503 ? 'Storage unreachable · Downstream protected' : 'Downstream NOT CALLED · Backend protected'}</span>
      </div>`;

    this.containerEl.innerHTML = flowHtml;

    // ── Animate nodes & connectors sequentially ──
    const nodes     = this.containerEl.querySelectorAll('.rlpf-node');
    const connectors = this.containerEl.querySelectorAll('.rlpf-connector');
    for (let i = 0; i < nodes.length; i++) {
      await this._delay(120);
      nodes[i].style.opacity    = '1';
      nodes[i].style.transform  = 'translateY(0)';
      nodes[i].style.transition = 'opacity 0.35s ease, transform 0.35s cubic-bezier(0.34,1.56,0.64,1)';
      if (connectors[i]) {
        connectors[i].style.opacity    = '1';
        connectors[i].style.transition = 'opacity 0.2s ease';
      }
    }

    // ── Render hop inspector below ──
    this._renderHopInspector(hops, isAllowed);
  }

  /* ── Render Hop Inspector: vertical timeline layout ── */
  _renderHopInspector(hops, isAllowed) {
    if (!this.inspectorEl) return;

    let html = `<div class="rlhi-timeline">`;
    for (let idx = 0; idx < hops.length; idx++) {
      const h = hops[idx];
      const isNotCalled = h.status === 'not_called';
      const isReject    = h.status === 'rejected' || h.status === 'rate_limited' || h.status === 'error_503';
      const isOk        = !isNotCalled && !isReject;
      const isLast      = idx === hops.length - 1;

      const dotClass  = isNotCalled ? 'rlhi-dot--ghost' : isReject ? 'rlhi-dot--reject' : 'rlhi-dot--ok';
      const cardClass = isNotCalled ? 'rlhi-card--ghost' : isReject ? 'rlhi-card--reject' : 'rlhi-card--ok';
      const statusLabel = isNotCalled ? 'SKIPPED' : h.status.toUpperCase().replace('_', ' ');
      const statusBadge = isNotCalled ? 'rlhi-badge--ghost' : isReject ? 'rlhi-badge--reject' : 'rlhi-badge--ok';

      html += `
        <div class="rlhi-row">
          <!-- Left: step indicator -->
          <div class="rlhi-step">
            <div class="rlhi-dot ${dotClass}">
              <span class="rlhi-dot-icon">${rlIcon(h.icon, { size: 16 })}</span>
            </div>
            ${!isLast ? `<div class="rlhi-line ${isNotCalled ? 'rlhi-line--ghost' : ''}"></div>` : ''}
          </div>

          <!-- Right: card -->
          <div class="rlhi-card ${cardClass}">
            <div class="rlhi-card-header">
              <div class="rlhi-header-left">
                <span class="rlhi-node-name">${h.name}</span>
                <span class="rlhi-badge ${statusBadge}">${statusLabel}</span>
              </div>
              <div class="rlhi-header-right">
                ${h.latency > 0 ? `<span class="rlhi-latency">${h.latency}ms</span>` : '<span class="rlhi-latency" style="opacity:0.35">·</span>'}
              </div>
            </div>

            <div class="rlhi-op-line"><code>${isNotCalled ? '⊘ ' : ''}${h.operation}</code></div>
            <div class="rlhi-detail-text">${h.detail}</div>

            ${Object.keys(h.metadata || {}).length > 0 ? `
              <div class="rlhi-meta-grid">
                ${Object.entries(h.metadata).map(([k, v]) => `
                  <div class="rlhi-meta-pill">
                    <span class="rlhi-meta-key">${k}</span>
                    <span class="rlhi-meta-val">${v}</span>
                  </div>`).join('')}
              </div>` : ''}

            ${Object.keys(h.techDetails || {}).length > 0 ? `
              <details class="rlhi-tech-details">
                <summary>Technical details</summary>
                <div class="rlhi-tech-grid">
                  ${Object.entries(h.techDetails).map(([k, v]) => `
                    <div class="rlhi-meta-pill rlhi-meta-pill--dim">
                      <span class="rlhi-meta-key">${k}</span>
                      <span class="rlhi-meta-val">${v}</span>
                    </div>`).join('')}
                </div>
              </details>` : ''}
          </div>
        </div>`;
    }
    html += `</div>`;
    this.inspectorEl.innerHTML = html;
  }

  /* ── Interactive Algorithm Cards + Secondary Technical Details ── */
  renderTokenStoreInspector(state = {}) {
    if (!this.storeEl) return;
    const isRedis = state?.tokenStore !== 'local_memory';
    const isRedisOutage = Boolean(state?.failures?.redisOutage);
    const algoName = (this.algorithm || 'token_bucket').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    this.storeEl.innerHTML = `
      <!-- Interactive Algorithm Cards (Click to switch) -->
      <div class="algo-comp-section">
        <div class="algo-comp-header">
          <div class="algo-comp-title-row">
            <span class="algo-comp-title">Algorithm Comparison</span>
            <span class="algo-comp-sub">Select an algorithm to observe how it shapes traffic under identical load</span>
          </div>
        </div>

        <div class="algo-card-grid">
          <!-- Card 1: Token Bucket -->
          <div class="algo-card ${this.algorithm === 'token_bucket' ? 'algo-card--active' : ''}" data-algo="token_bucket">
            <div class="algo-card-top">
              <div class="algo-card-badge ${this.algorithm === 'token_bucket' ? 'badge--active' : ''}">
                ${this.algorithm === 'token_bucket' ? '✓ Active' : 'Select'}
              </div>
              <h4 class="algo-card-name">Token Bucket</h4>
              <p class="algo-card-tagline">"Smooth refill + controlled bursts"</p>
            </div>
            <p class="algo-card-desc">
              Tokens accumulate at a steady refill rate up to burst capacity. Ideal for handling temporary spikes while strictly enforcing an average limit.
            </p>
            <div class="algo-card-footer">
              <span class="algo-property-tag">Burst: Allowed</span>
              <span class="algo-property-tag">Boundary: Smooth</span>
            </div>
          </div>

          <!-- Card 2: Fixed Window -->
          <div class="algo-card ${this.algorithm === 'fixed_window' ? 'algo-card--active' : ''}" data-algo="fixed_window">
            <div class="algo-card-top">
              <div class="algo-card-badge ${this.algorithm === 'fixed_window' ? 'badge--active' : ''}">
                ${this.algorithm === 'fixed_window' ? '✓ Active' : 'Select'}
              </div>
              <h4 class="algo-card-name">Fixed Window</h4>
              <p class="algo-card-tagline">"Simple, but boundary bursts"</p>
            </div>
            <p class="algo-card-desc">
              Maintains an integer counter reset at fixed clock intervals. Low computational overhead, but vulnerable to 2× spikes right at window edges.
            </p>
            <div class="algo-card-footer">
              <span class="algo-property-tag tag-warn">Boundary Spikes</span>
              <span class="algo-property-tag">Counter-based</span>
            </div>
          </div>

          <!-- Card 3: Sliding Window -->
          <div class="algo-card ${this.algorithm === 'sliding_window' ? 'algo-card--active' : ''}" data-algo="sliding_window">
            <div class="algo-card-top">
              <div class="algo-card-badge ${this.algorithm === 'sliding_window' ? 'badge--active' : ''}">
                ${this.algorithm === 'sliding_window' ? '✓ Active' : 'Select'}
              </div>
              <h4 class="algo-card-name">Sliding Window</h4>
              <p class="algo-card-tagline">"More accurate rolling limit"</p>
            </div>
            <p class="algo-card-desc">
              Computes a weighted average of preceding and current window counts. Eliminates boundary spikes for strict protection.
            </p>
            <div class="algo-card-footer">
              <span class="algo-property-tag">Rolling Rate</span>
              <span class="algo-property-tag">Weighted Overlap</span>
            </div>
          </div>
        </div>

        <!-- Secondary: Technical Details (Progressive Disclosure) -->
        <details class="rl-tech-details-collapse">
          <summary class="rl-tech-summary">▸ Technical Details: Algorithm State & Storage Backend</summary>
          <div class="rl-store-inspector-grid">
            <!-- 1. ALGORITHM STATE -->
            <div class="rl-inspector-card">
              <div class="ts-header algo-header">
                <span class="ts-header-icon">⚙️</span>
                <span class="ts-header-title">Algorithm Internal State</span>
                <span class="ts-header-badge">${algoName}</span>
              </div>
              <div class="ts-body">
                ${this.algorithm === 'token_bucket' ? `
                  <div class="ts-row"><span class="ts-key">Burst Capacity</span><span class="ts-val">${this.capacity} max tokens</span></div>
                  <div class="ts-row"><span class="ts-key">Current Available</span><span class="ts-val ${this.tokens <= 10 ? 'ts-val-danger' : ''}">${Math.round(this.tokens)} tokens</span></div>
                  <div class="ts-row"><span class="ts-key">Refill Rate</span><span class="ts-val">${this.refillRate} tokens/sec</span></div>
                  <div class="ts-row"><span class="ts-key">Sustained Limit</span><span class="ts-val">${this.refillRate} req/s</span></div>
                  <div class="ts-row"><span class="ts-key">Burst Status</span><span class="ts-val">${this.tokens >= this.capacity ? 'FULL' : this.tokens > 0 ? 'PARTIAL' : 'DEPLETED (429)'}</span></div>
                ` : this.algorithm === 'fixed_window' ? `
                  <div class="ts-row"><span class="ts-key">Current Window</span><span class="ts-val mono">[${this.windowStart.toFixed(3)}s → ${this.windowEnd.toFixed(3)}s]</span></div>
                  <div class="ts-row"><span class="ts-key">Window Limit</span><span class="ts-val">${this.limit} requests / ${this.windowSize}s</span></div>
                  <div class="ts-row"><span class="ts-key">Window Counter</span><span class="ts-val mono ${this.windowCount >= this.limit ? 'ts-val-danger' : ''}">${this.windowCount} / ${this.limit}</span></div>
                  <div class="ts-row"><span class="ts-key">Reset In</span><span class="ts-val mono">${Math.max(0, this.windowEnd - this.simTime).toFixed(2)}s</span></div>
                  <div class="ts-row ts-row-note">
                    <span class="ts-note-text">⚠️ <em>Boundary Behavior:</em> Counter resets cleanly at boundary; bursts can span adjacent windows.</span>
                  </div>
                ` : `
                  <div class="ts-row"><span class="ts-key">Rolling Interval</span><span class="ts-val mono">&lt;── ${this.windowSize.toFixed(1)}s rolling window ──&gt;</span></div>
                  <div class="ts-row"><span class="ts-key">Prev Window Count</span><span class="ts-val mono">${this.prevWindowCount} reqs</span></div>
                  <div class="ts-row"><span class="ts-key">Curr Window Count</span><span class="ts-val mono">${this.currWindowCount} reqs</span></div>
                  <div class="ts-row"><span class="ts-key">Overlap Weight</span><span class="ts-val mono">${this.overlapWeight.toFixed(2)}</span></div>
                  <div class="ts-row"><span class="ts-key">Weighted Count</span><span class="ts-val mono ${this.effectiveSlidingCount >= this.limit ? 'ts-val-danger' : ''}">${this.prevWindowCount} × ${this.overlapWeight.toFixed(2)} + ${this.currWindowCount} = <strong>${this.effectiveSlidingCount.toFixed(1)} / ${this.limit}</strong></span></div>
                `}
              </div>
            </div>

            <!-- 2. STORAGE & COORDINATION STATE -->
            <div class="rl-inspector-card">
              <div class="ts-header storage-header">
                <span class="ts-header-icon">🗄️</span>
                <span class="ts-header-title">Storage & Coordination</span>
                <span class="ts-header-badge">${isRedis ? (isRedisOutage ? 'Redis OUTAGE' : 'Redis Shared') : 'Local Memory'}</span>
              </div>
              <div class="ts-body">
                <div class="ts-row"><span class="ts-key">Storage Backend</span><span class="ts-val">${isRedis ? 'Redis Cluster' : 'In-Memory HashMap'}</span></div>
                <div class="ts-row"><span class="ts-key">Redis Key</span><span class="ts-val ts-val-code">ratelimit:user_42</span></div>
                <div class="ts-row"><span class="ts-key">Key TTL</span><span class="ts-val">${this.ttl}s</span></div>
                <div class="ts-row"><span class="ts-key">Atomicity</span><span class="ts-val">${isRedis ? 'Redis Lua Script (EVAL)' : 'Process Local Lock'}</span></div>
                <div class="ts-row"><span class="ts-key">Cross-Gateway State</span><span class="ts-val">${isRedis ? 'Globally Synchronized' : 'Independent (leaks limit)'}</span></div>
              </div>
            </div>
          </div>
        </details>
      </div>`;

    // Bind card clicks to switch algorithm
    this.storeEl.querySelectorAll('.algo-card').forEach(card => {
      card.addEventListener('click', () => {
        const targetAlgo = card.getAttribute('data-algo');
        if (targetAlgo && targetAlgo !== this.algorithm) {
          this._switchAlgorithm(targetAlgo, state);
        }
      });
    });
  }

  _switchAlgorithm(algo, state = null) {
    this.algorithm = algo;
    if (state) state.algorithm = algo;
    const algoSelect = document.getElementById('rl-hiw-algorithm');
    if (algoSelect) {
      algoSelect.value = algo;
      algoSelect.dispatchEvent(new Event('change'));
    }
  }

  /* ── Update Token Visual Progress Widget & Visual State Indicators ── */
  updateTokenVisualWidget() {
    const clockEl = document.getElementById('rl-sim-clock');
    if (clockEl) clockEl.textContent = `${this.simTime.toFixed(3)}s`;

    const clockBtn = document.getElementById('rl-btn-step-clock');
    const barEl = document.getElementById('rl-token-progress-bar');
    const infoEl = document.getElementById('rl-token-info-wrap');
    const dotEl = document.getElementById('rl-vstate-dot');
    const labelEl = document.getElementById('rl-vstate-label');
    const nowEl = document.getElementById('rl-capacity-now');
    const ofEl = document.getElementById('rl-capacity-of');

    /* Fill level drives one shared visual language: healthy → strained → blocked */
    const applyMeter = (pct, tone) => {
      if (!barEl) return;
      barEl.style.width = `${pct}%`;
      barEl.dataset.tone = tone;
    };
    /* Tone tracks remaining headroom. The token bucket meter shows what's left,
       the window meters show what's used, hence pctIsUsage. */
    const toneFor = (pct, pctIsUsage) => {
      const headroom = pctIsUsage ? 100 - pct : pct;
      if (headroom <= 5) return 'blocked';
      if (headroom <= 35) return 'strained';
      return 'healthy';
    };
    const flash = () => {
      if (!nowEl) return;
      nowEl.classList.remove('rl-capacity-pop');
      void nowEl.offsetWidth;                  // restart the animation
      nowEl.classList.add('rl-capacity-pop');
    };

    if (this.algorithm === 'token_bucket') {
      if (clockBtn) clockBtn.textContent = '+0.5s Refill';
      const pct = Math.max(0, Math.min(100, (this.tokens / Math.max(1, this.capacity)) * 100));

      if (nowEl) nowEl.textContent = Math.round(this.tokens);
      if (ofEl) ofEl.textContent = `/ ${this.capacity} tokens`;
      if (infoEl) {
        infoEl.innerHTML = `
          <span>Refilling at <strong>${this.refillRate}/s</strong></span>
          <span class="rl-token-rate">Burst ceiling <strong>${this.capacity}</strong></span>`;
      }
      applyMeter(pct, toneFor(pct, false));
      flash();

      if (labelEl && dotEl) {
        if (this.tokens >= this.capacity * 0.9) {
          labelEl.textContent = 'Bucket full';
          dotEl.className = 'rl-vstate-dot dot-success';
        } else if (this.tokens <= 0.5) {
          labelEl.textContent = 'Depleted, next request is 429';
          dotEl.className = 'rl-vstate-dot dot-danger';
        } else {
          labelEl.textContent = 'Consuming tokens';
          dotEl.className = 'rl-vstate-dot dot-active';
        }
      }
    } else if (this.algorithm === 'fixed_window') {
      if (clockBtn) clockBtn.textContent = '+0.5s Advance';
      const pct = Math.max(0, Math.min(100, (this.windowCount / Math.max(1, this.limit)) * 100));

      if (nowEl) nowEl.textContent = this.windowCount;
      if (ofEl) ofEl.textContent = `/ ${this.limit} used this window`;
      if (infoEl) {
        infoEl.innerHTML = `
          <span>Window <strong>${this.windowStart.toFixed(2)}s → ${this.windowEnd.toFixed(2)}s</strong></span>
          <span class="rl-token-rate">Resets in <strong>${Math.max(0, this.windowEnd - this.simTime).toFixed(2)}s</strong></span>`;
      }
      applyMeter(pct, toneFor(pct, true) === 'healthy' ? 'window' : toneFor(pct, true));
      flash();

      if (labelEl && dotEl) {
        if (this.windowCount >= this.limit) {
          labelEl.textContent = 'Window full, next request is 429';
          dotEl.className = 'rl-vstate-dot dot-danger';
        } else {
          labelEl.textContent = 'Window active';
          dotEl.className = 'rl-vstate-dot dot-active';
        }
      }
    } else {
      // Sliding window
      if (clockBtn) clockBtn.textContent = '+0.5s Advance';
      const pct = Math.max(0, Math.min(100, (this.effectiveSlidingCount / Math.max(1, this.limit)) * 100));

      if (nowEl) nowEl.textContent = this.effectiveSlidingCount.toFixed(1);
      if (ofEl) ofEl.textContent = `/ ${this.limit} weighted`;
      if (infoEl) {
        infoEl.innerHTML = `
          <span>Previous window <strong>${this.prevWindowCount}</strong> · current <strong>${this.currWindowCount}</strong></span>
          <span class="rl-token-rate">Overlap weight <strong>${this.overlapWeight.toFixed(2)}</strong></span>`;
      }
      applyMeter(pct, toneFor(pct, true) === 'healthy' ? 'rolling' : toneFor(pct, true));
      flash();

      if (labelEl && dotEl) {
        if (this.effectiveSlidingCount >= this.limit) {
          labelEl.textContent = 'Rolling limit reached, next request is 429';
          dotEl.className = 'rl-vstate-dot dot-danger';
        } else {
          labelEl.textContent = 'Rolling window active';
          dotEl.className = 'rl-vstate-dot dot-active';
        }
      }
    }
  }

  /* ── Initial Standby Pipeline ── */
  renderIdleState() {
    if (!this.containerEl) return;

    const idleNodes = [
      { icon: 'client',   name: 'Client',       sub: 'API consumer',    color: '#38bdf8' },
      { icon: 'gateway',  name: 'API Gateway',  sub: 'Route & forward', color: '#a78bfa' },
      { icon: 'shield',   name: 'Rate Limiter', sub: 'Decision engine', color: '#fb923c' },
      { icon: 'database', name: 'Token Store',  sub: 'Redis / Lua',     color: '#f59e0b' },
      { icon: 'zap',      name: 'Downstream',   sub: 'Protected API',   color: '#34d399' },
    ];

    let html = `<div class="rlpf-flow-strip rlpf-idle">`;
    idleNodes.forEach((n, i) => {
      html += `
        <div class="rlpf-node rlpf-node--idle" style="--na:${n.color};">
          <div class="rlpf-node-icon">${rlIconBadge(n.icon, { color: n.color, size: 38, iconSize: 19 })}</div>
          <div class="rlpf-node-meta">
            <span class="rlpf-node-name">${n.name}</span>
            <span class="rlpf-node-op">${n.sub}</span>
          </div>
        </div>`;
      if (i < idleNodes.length - 1) {
        html += `<div class="rlpf-connector rlpf-connector--idle">
          <div class="rlpf-connector-line"></div>
          <div class="rlpf-connector-dot"></div>
          <svg class="rlpf-arrow-svg" width="10" height="10" viewBox="0 0 10 10">
            <path d="M2 5 L8 5 M6 3 L8 5 L6 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>`;
      }
    });
    html += `</div>
      <div class="rlpf-idle-footer">
        <span class="flow-pulse-dot"></span>
        <span class="flow-footer-text">Pipeline ready · Click <strong>Send 1</strong>, <strong>Send 10</strong>, <strong>Send Burst (50)</strong>, or <strong>Force Limit Reached</strong> to observe causal decisions</span>
      </div>`;

    this.containerEl.innerHTML = html;
    if (this.inspectorEl) this.inspectorEl.innerHTML = '';
    this.updateTokenVisualWidget();
    this.renderTokenStoreInspector();
  }

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}
