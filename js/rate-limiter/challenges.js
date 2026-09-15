/**
 * Rate Limiter Engineering Challenges
 *
 * 3 interactive scenario challenges:
 *  1. Flash Sale Burst: protect downstream with burst absorption
 *  2. Distributed Botnet: discover local-memory leakage, fix with Redis
 *  3. Midnight Redis Partition: navigate Fail Open vs Fail Closed
 */

import confetti from 'canvas-confetti';
import { RL_ICONS } from './icons.js';

export const RL_CHALLENGES = [
  {
    id: 'rl_flash_sale',
    title: 'The flash sale burst',
    difficulty: 'Intermediate',
    badge: '50k req/s spike',
    icon: 'zap',
    goal: 'Survive a 50,000 req/s burst without taking down the order service behind it.',
    description: 'A flash sale just went live and traffic jumped from 5,000 to 50,000 req/s. The order service behind your API can only take 15,000. Your job is to keep it standing.',
    criteria: [
      { label: 'Order service stays below its capacity', target: 'below 100%',
        test: m => m.downstreamUtilization < 1.0,
        now: m => `${(m.downstreamUtilization * 100).toFixed(0)}%` },
      { label: 'Average response time stays fast', target: 'below 50ms',
        test: m => m.avgLatency < 50,
        now: m => `${m.avgLatency}ms` },
      { label: 'No requests dropped by overloaded machines', target: 'exactly 0',
        test: m => m.infraDroppedRPS === 0,
        now: m => `${m.infraDroppedRPS.toLocaleString()} dropped` },
    ],
    initialState: {
      traffic: 50000, activeIdentities: 3000, trafficProfile: 'heavy_tail',
      topIdentityRatio: 0.10, algorithm: 'token_bucket',
      limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
      gatewayNodes: 3, rateLimiterNodes: 2, tokenStore: 'redis', redisShards: 4,
      atomicityMode: 'atomic', failPolicy: 'fail_open',
      failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
        oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
        staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
    },
    actions: [
      {
        id: 'add_gateways',
        label: 'Add 3 more gateways',
        description: 'Scale gateway fleet from 3 to 6 instances',
        apply: (state) => ({ ...state, gatewayNodes: state.gatewayNodes + 3 }),
        explanation: (prev, curr) => {
          const gwFixed = curr.gatewayUtilization < 1.0;
          const dsOk = curr.downstreamUtilization < 1.0;
          return gwFixed && dsOk
            ? `good|Gateway bottleneck resolved (${(curr.gatewayUtilization*100).toFixed(0)}%). But check: is the downstream still safe at ${(curr.downstreamUtilization*100).toFixed(0)}%?`
            : gwFixed
            ? `warn|Gateway load reduced to ${(curr.gatewayUtilization*100).toFixed(0)}%, but downstream is at ${(curr.downstreamUtilization*100).toFixed(0)}%, so the problem may be elsewhere.`
            : `bad|Gateways still overloaded at ${(curr.gatewayUtilization*100).toFixed(0)}%. More gateways or lower traffic needed.`;
        }
      },
      {
        id: 'lower_limit',
        label: 'Lower the per-user limit to 30/s',
        description: 'Reduce per-user rate limit from 100 to 30 req/s',
        apply: (state) => ({ ...state, limitPerUser: 30, refillRate: 30 }),
        explanation: (prev, curr) => {
          const dsOk = curr.downstreamUtilization < 1.0;
          return dsOk
            ? `good|Downstream protected at ${(curr.downstreamUtilization*100).toFixed(0)}%. More requests get a 429 (${(curr.rejectionRate*100).toFixed(1)}% of them), and the order service survives the burst.`
            : `warn|Downstream still at ${(curr.downstreamUtilization*100).toFixed(0)}%. The limit may need to go even lower, or add more rate limiter capacity.`;
        }
      },
      {
        id: 'add_limiters',
        label: 'Add 2 rate limiter nodes',
        description: 'Scale rate limiter daemons from 2 to 4',
        apply: (state) => ({ ...state, rateLimiterNodes: state.rateLimiterNodes + 2 }),
        explanation: (prev, curr) =>
          `Rate limiter capacity increased. RL utilization: ${(curr.rateLimiterUtilization*100).toFixed(0)}%. This helps if the RL tier was the bottleneck, but doesn't change how many requests reach downstream.`
      },
      {
        id: 'disable_redis',
        label: 'Switch to local memory',
        description: 'Bypass Redis and use in-process counters',
        apply: (state) => ({ ...state, tokenStore: 'local_memory' }),
        explanation: (prev, curr) =>
          `bad|Local memory mode causes distributed leakage. Leaked: ${curr.leakedRPS.toLocaleString()} req/s above configured limits. Each gateway independently allows up to the per-user limit. Downstream: ${(curr.downstreamUtilization*100).toFixed(0)}%.`
      }
    ]
  },
  {
    id: 'rl_botnet',
    title: 'The distributed botnet',
    difficulty: 'Advanced',
    badge: 'one key, 9.3k req/s',
    icon: 'unlock',
    goal: 'Shut down a botnet that is beating your per-user limit by spreading itself across your gateways.',
    criteria: [
      { label: 'Nothing leaks past the configured limit', target: 'exactly 0',
        test: m => m.leakedRPS === 0,
        now: m => `${m.leakedRPS.toLocaleString()} req/s over` },
      { label: 'Order service keeps comfortable headroom', target: 'below 80%',
        test: m => m.downstreamUtilization < 0.8,
        now: m => `${(m.downstreamUtilization * 100).toFixed(0)}%` },
    ],
    description: 'A botnet is abusing your API with 9,300 req/s from one API key, distributed across your 3 gateways. With local memory counters, each gateway sees ~3,100 req/s and allows up to 100 req/s locally, so 300 req/s leaks through instead of the configured 100 limit.',
    initialState: {
      traffic: 20000, activeIdentities: 1000, trafficProfile: 'abusive_spike',
      topIdentityRatio: 0.465, algorithm: 'token_bucket',
      limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
      gatewayNodes: 3, rateLimiterNodes: 2, tokenStore: 'local_memory', redisShards: 4,
      atomicityMode: 'non_atomic', failPolicy: 'fail_open',
      failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
        oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
        staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
    },
    actions: [
      {
        id: 'enable_redis',
        label: 'Switch to Redis shared state',
        description: 'Use centralized Redis for globally coordinated rate limiting',
        apply: (state) => ({ ...state, tokenStore: 'redis', atomicityMode: 'atomic' }),
        explanation: (prev, curr) => {
          return curr.leakedRPS === 0
            ? `good|Leaked traffic eliminated. Redis provides a single shared counter across all ${curr.activeGateways} gateways. The botnet is now strictly limited to ${curr.topIdentityAllowedRPS} req/s (vs ${prev.topIdentityAllowedRPS} with local memory). Downstream: ${(curr.downstreamUtilization*100).toFixed(0)}%.`
            : `warn|Still leaking ${curr.leakedRPS} req/s. Check atomicity mode.`;
        }
      },
      {
        id: 'add_gateways',
        label: 'Add 2 more gateways',
        description: 'Scale gateway fleet from 3 to 5',
        apply: (state) => ({ ...state, gatewayNodes: state.gatewayNodes + 2 }),
        explanation: (prev, curr) =>
          `bad|Adding gateways makes the leak worse. With local memory, ${curr.activeGateways} gateways × ${curr.distribution?.topRate ? Math.round(curr.topIdentityOfferedRPS / curr.activeGateways) : '?'} req/s per GW each allow up to the limit independently. Leaked: ${curr.leakedRPS.toLocaleString()} req/s. Adding servers does not fix distributed coordination.`
      },
      {
        id: 'lower_limit',
        label: 'Lower the limit to 30/s',
        description: 'Reduce per-user limit hoping to catch the botnet',
        apply: (state) => ({ ...state, limitPerUser: 30, refillRate: 30, bucketCapacity: 60 }),
        explanation: (prev, curr) =>
          `warn|Limit reduced, but local memory still leaks: ${curr.leakedRPS.toLocaleString()} req/s. Each gateway allows 30/s × ${curr.activeGateways} gateways = ${curr.activeGateways * 30} effective. Legitimate heavy users are now throttled too. The root cause is the lack of shared state, not the limit value.`
      },
      {
        id: 'enable_atomic',
        label: 'Enable atomic check and increment',
        description: 'Switch from read-then-write to atomic INCR',
        apply: (state) => ({ ...state, atomicityMode: 'atomic' }),
        explanation: (prev, curr) =>
          state.tokenStore === 'local_memory'
            ? `warn|Atomic operations help prevent race conditions, but with local memory each gateway still has independent state. Leaked: ${curr.leakedRPS.toLocaleString()} req/s. You need shared state (Redis) first.`
            : `good|Atomic plus Redis gives strictly enforced limits. Leaked: ${curr.leakedRPS.toLocaleString()} req/s.`
      }
    ]
  },
  {
    id: 'rl_redis_failure',
    title: 'The midnight partition',
    difficulty: 'Expert',
    badge: 'Redis unreachable',
    icon: 'alertTriangle',
    goal: 'Redis is unreachable at peak traffic. Keep the service behind you standing without locking every user out.',
    description: 'It is midnight, traffic is at 30,000 req/s, and Redis just became unreachable. Your limiter has no shared state to consult. Let everyone through and risk melting the service, or reject everyone and serve nobody. There is a third option.',
    criteria: [
      { label: 'Order service stays below its capacity', target: 'below 100%',
        test: m => m.downstreamUtilization < 1.0,
        now: m => `${(m.downstreamUtilization * 100).toFixed(0)}%` },
      { label: 'Real users are still being served', target: 'more than 0',
        test: m => m.allowedRPS > 0,
        now: m => `${m.allowedRPS.toLocaleString()} req/s` },
    ],
    initialState: {
      traffic: 30000, activeIdentities: 2000, trafficProfile: 'heavy_tail',
      topIdentityRatio: 0.15, algorithm: 'token_bucket',
      limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
      gatewayNodes: 4, rateLimiterNodes: 3, tokenStore: 'redis', redisShards: 4,
      atomicityMode: 'atomic', failPolicy: 'fail_open',
      failures: { redisOutage: true, redisLatencyMs: 0, oneGatewayDead: false,
        oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
        staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
    },
    actions: [
      {
        id: 'fail_closed',
        label: 'Switch to fail closed',
        description: 'Reject all requests with 503 while Redis is unavailable',
        apply: (state) => ({ ...state, failPolicy: 'fail_closed' }),
        explanation: (prev, curr) =>
          `warn|The order service is protected (${(curr.downstreamUtilization*100).toFixed(0)}% utilization). But every one of the ${curr.offeredRPS.toLocaleString()} requests now gets a 503 and nobody is served. This is the safest choice for data integrity but worst for availability.`
      },
      {
        id: 'fail_open',
        label: 'Switch to fail open',
        description: 'Allow all traffic through while Redis is unavailable',
        apply: (state) => ({ ...state, failPolicy: 'fail_open' }),
        explanation: (prev, curr) =>
          `bad|All ${curr.allowedRPS.toLocaleString()} req/s pass straight through. Downstream: ${(curr.downstreamUtilization*100).toFixed(0)}%. ${curr.downstreamUtilization > 1.0 ? 'DOWNSTREAM OVERLOADED, service degrading with 503 errors.' : 'Downstream surviving but unprotected from abuse.'} No rate limiting in effect.`
      },
      {
        id: 'fallback_local',
        label: 'Fall back to local memory',
        description: 'Switch to local in-process counters as emergency measure',
        apply: (state) => ({
          ...state, tokenStore: 'local_memory',
          failures: { ...state.failures, redisOutage: false }
        }),
        explanation: (prev, curr) =>
          `warn|Emergency local rate limiting is active. Downstream: ${(curr.downstreamUtilization*100).toFixed(0)}%. Distributed leakage is now ${curr.leakedRPS.toLocaleString()} req/s. Local counters provide imperfect protection, better than nothing during an outage, but limits are not globally enforced. Treat it as a stopgap and get Redis back.`
      },
      {
        id: 'restore_redis',
        label: 'Restore the Redis cluster',
        description: 'Bring Redis back online and resume global enforcement',
        apply: (state) => ({
          ...state, tokenStore: 'redis',
          failures: { ...state.failures, redisOutage: false }
        }),
        explanation: (prev, curr) =>
          `good|Redis is back. Global enforcement active. Leaked: ${curr.leakedRPS} req/s. Downstream: ${(curr.downstreamUtilization*100).toFixed(0)}%. This is the real fix, though in production Redis recovery may take minutes. The question was: what do you do in the meantime?`
      }
    ]
  }
];

export class RateLimiterChallengeManager {
  constructor(containerEl, onApplyState, onApplyAction) {
    this.containerEl = containerEl;
    this.onApplyState = onApplyState;
    this.onApplyAction = onApplyAction;
    this.activeChallenge = null;
    this.actionResults = {};
    this.solved = {};
    this.currentMetrics = null;
  }

  /* Solved means every objective on the checklist is green. Nothing else. */
  _isSolved(ch, metrics) {
    if (!metrics || !ch?.criteria?.length) return false;
    return ch.criteria.every(cr => cr.test(metrics));
  }

  /* The controller feeds live metrics in so objectives can tick in real time. */
  updateMetrics(metrics) {
    this.currentMetrics = metrics;
    if (this.activeChallenge && this.containerEl?.querySelector('.rl-mission')) {
      this._renderActiveChallenge();
    }
  }

  render() {
    if (!this.containerEl) return;
    if (this.activeChallenge) { this._renderActiveChallenge(); return; }

    const solvedCount = RL_CHALLENGES.filter(ch => this.solved[ch.id]).length;

    this.containerEl.innerHTML = `
      <div class="rl-scale-wrap">
        <section class="rl-scale-hero">
          <div class="rl-scale-hero-copy">
            <h2 class="rl-scale-title">Three incidents. <span class="rl-gradient-inline">Ship the fix.</span></h2>
            <p class="rl-scale-sub">
              Each one is a real outage pattern with a real trade-off hiding inside it.
              Pick a fix, watch what it actually does, and find out whether your instinct was right.
            </p>
          </div>
          <div class="rl-scenario-row">
            <span class="rl-scenario-label">Progress</span>
            <div class="rl-progress-pill">
              <span class="rl-progress-track"><span class="rl-progress-fill" style="width:${(solvedCount / RL_CHALLENGES.length) * 100}%"></span></span>
              <strong>${solvedCount} of ${RL_CHALLENGES.length} solved</strong>
            </div>
          </div>
        </section>

        <section class="rl-challenge-grid">
          ${RL_CHALLENGES.map((ch, i) => {
            const solved = this.solved[ch.id];
            return `
              <article class="rl-challenge-card ${solved ? 'is-solved' : ''}">
                <header class="rl-challenge-head">
                  <span class="rl-challenge-num">${String(i + 1).padStart(2, '0')}</span>
                  <span class="rl-challenge-icon">${RL_ICONS[ch.icon] || ''}</span>
                  ${solved
                    ? `<span class="rl-challenge-diff is-solved">${RL_ICONS.checkCircle} Solved</span>`
                    : `<span class="rl-challenge-diff" data-diff="${ch.difficulty.toLowerCase()}">${ch.difficulty}</span>`}
                </header>

                <h3 class="rl-challenge-title">${ch.title}</h3>
                <span class="rl-challenge-badge">${ch.badge}</span>
                <p class="rl-challenge-desc">${ch.description}</p>

                <div class="rl-challenge-goal">
                  <span class="rl-challenge-goal-label">Your job</span>
                  <p>${ch.goal}</p>
                </div>

                <ul class="rl-challenge-criteria">
                  ${(ch.criteria || []).map(cr => `<li>${cr.label}</li>`).join('')}
                </ul>

                <button class="rl-btn-primary-send rl-challenge-start" data-challenge-id="${ch.id}">
                  ${solved ? 'Play it again' : 'Take the call'}
                </button>
              </article>`;
          }).join('')}
        </section>
      </div>`;

    this.containerEl.querySelectorAll('.rl-challenge-start').forEach(btn => {
      btn.addEventListener('click', () => this._startChallenge(btn.getAttribute('data-challenge-id')));
    });
  }

  _startChallenge(id) {
    const ch = RL_CHALLENGES.find(c => c.id === id);
    if (!ch) return;
    this.activeChallenge = ch;
    this.actionResults = {};

    if (this.onApplyState) {
      this.onApplyState({ ...ch.initialState, failures: { ...ch.initialState.failures } });
    }
    this._renderActiveChallenge();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  _renderActiveChallenge() {
    const ch = this.activeChallenge;
    if (!ch || !this.containerEl) return;

    const m = this.currentMetrics;
    const criteria = (ch.criteria || []).map(cr => ({
      label: cr.label,
      target: cr.target || '',
      met: m ? !!cr.test(m) : false,
      now: m ? cr.now(m) : 'waiting',
    }));
    const metCount = criteria.filter(c => c.met).length;
    const allMet = criteria.length > 0 && metCount === criteria.length;

    /* Re-rendering swaps innerHTML, which would otherwise throw the reader back
       to the top mid-experiment. Hold the scroll position across the swap. */
    const keepScroll = window.scrollY;

    this.containerEl.innerHTML = `
      <div class="rl-scale-wrap rl-mission-wrap">
        <div class="rl-mission-layout">

          <aside class="rl-mission-side">
            <button class="rl-btn-ghost rl-mission-back" id="rl-challenge-back">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              <span>All challenges</span>
            </button>

            <div class="rl-mission-head">
              <span class="rl-mission-icon">${RL_ICONS[ch.icon] || ''}</span>
              <div>
                <h2 class="rl-mission-title">${ch.title}</h2>
                <span class="rl-challenge-badge">${ch.badge}</span>
              </div>
            </div>

            <p class="rl-mission-desc">${ch.description}</p>

            <section class="rl-objectives ${allMet ? 'is-complete' : ''}">
              <header class="rl-objectives-head">
                <h3>Objectives</h3>
                <span class="rl-objectives-count">${metCount} of ${criteria.length} met</span>
              </header>
              <p class="rl-objectives-legend">
                Green means you have already hit that target. The number on the right is
                where you are right now, next to what it needs to be.
              </p>
              <ul class="rl-objective-list">
                ${criteria.map(cr => `
                  <li class="rl-objective ${cr.met ? 'met' : ''}">
                    <span class="rl-objective-mark">${cr.met ? RL_ICONS.checkCircle : RL_ICONS.xCircle}</span>
                    <span class="rl-objective-text">
                      <span class="rl-objective-label">${cr.label}</span>
                      <span class="rl-objective-status">${cr.met ? 'Target met' : 'Not there yet'}</span>
                    </span>
                    <span class="rl-objective-nums">
                      <strong>${cr.now}</strong>
                      ${cr.target ? `<em>needs ${cr.target}</em>` : ''}
                    </span>
                  </li>`).join('')}
              </ul>
              ${allMet
                ? `<p class="rl-objectives-done">Solved. Every objective is green, and the trade-off you made is one a real on-call engineer would defend.</p>`
                : `<p class="rl-objectives-pending">Try an option on the right. These numbers update the moment you do.</p>`}
            </section>
          </aside>

          <section class="rl-mission-main">
            <div class="rl-block-head">
              <h3 class="rl-block-title">Your options</h3>
              <p class="rl-block-hint">Some of these make it worse. That is the point, so try them anyway.</p>
            </div>
            <div class="rl-fix-grid">
              ${ch.actions.map(a => {
                const result = this.actionResults[a.id];
                const [tone, ...rest] = result
                  ? (result.includes('|') ? result.split('|') : ['warn', result])
                  : [null];
                return `
                  <article class="rl-fix-card ${result ? 'is-applied' : ''}">
                    <header class="rl-fix-head">
                      <h4>${a.label}</h4>
                      <button class="rl-btn-secondary rl-fix-btn" data-action-id="${a.id}" ${result ? 'disabled' : ''}>
                        ${result ? 'Applied' : 'Try it'}
                      </button>
                    </header>
                    <p class="rl-fix-desc">${a.description}</p>
                    ${result ? `<div class="rl-fix-result" data-tone="${tone}">${rest.join('|')}</div>` : ''}
                  </article>`;
              }).join('')}
            </div>
          </section>
        </div>
      </div>`;

    window.scrollTo(0, keepScroll);

    this.containerEl.querySelector('#rl-challenge-back')?.addEventListener('click', () => {
      this.activeChallenge = null;
      this.actionResults = {};
      this.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    this.containerEl.querySelectorAll('.rl-fix-btn').forEach(btn => {
      btn.addEventListener('click', () => this._applyAction(btn.getAttribute('data-action-id')));
    });
  }

  _applyAction(actionId) {
    const ch = this.activeChallenge;
    if (!ch) return;
    const action = ch.actions.find(a => a.id === actionId);
    if (!action) return;

    if (this.onApplyAction) {
      this.onApplyAction(action, (prevMetrics, currMetrics) => {
        this.actionResults[actionId] = action.explanation(prevMetrics, currMetrics);

        /* The objective checklist is the only definition of success, so what the
           user sees on screen and what triggers the celebration cannot disagree.
           Fire once, on the transition into solved, not on every later action. */
        const wasSolved = !!this.solved[ch.id];
        const nowSolved = this._isSolved(ch, currMetrics);
        if (nowSolved && !wasSolved) {
          this.solved[ch.id] = true;
          try { confetti({ particleCount: 120, spread: 80, origin: { y: 0.7 } }); } catch (e) {}
        }

        this._renderActiveChallenge();
      });
    }
  }
}
