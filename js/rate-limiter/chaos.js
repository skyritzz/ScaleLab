/**
 * Rate Limiter Chaos Lab Manager
 *
 * Failure injections specific to distributed rate limiting:
 *  1. Redis Outage (Fail Open vs Fail Closed)
 *  2. Redis Latency Spike (+120ms)
 *  3. Gateway Node Crash
 *  4. Rate Limiter Node Crash
 *  5. Clock Drift (affects window algorithms)
 *  6. Configuration Propagation Delay (stale limit)
 *  7. Hot Key Saturation
 *  8. Network Partition (split brain)
 */

import { RL_ICONS } from './icons.js';

export class RateLimiterChaosManager {
  constructor(containerEl, onStateChange, model = null) {
    this.containerEl = containerEl;
    this.onStateChange = onStateChange;
    this.model = model;
    this.currentState = null;
    this.currentMetrics = null;

    this.failures = {
      redisOutage: false,
      redisLatencyMs: 0,
      oneGatewayDead: false,
      oneLimiterDead: false,
      clockDriftMs: 0,
      configPropagationDelay: false,
      staleLimitValue: 500,
      hotKeyActive: false,
      networkPartition: false
    };

    this.failPolicy = 'fail_open';

    this.incidentTimeline = [{
      id: 'init', timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'info', title: 'Chaos console ready',
      detail: 'The rate limiter is operating normally. Nothing is broken yet.'
    }];
  }

  updateContext(state, metrics, model) {
    this.currentState = state ? JSON.parse(JSON.stringify(state)) : null;
    this.currentMetrics = metrics ? { ...metrics } : null;
    if (model) this.model = model;
    if (state?.failures) {
      this.failures = { ...this.failures, ...state.failures };
    }
    if (state?.failPolicy) this.failPolicy = state.failPolicy;
    this.render();
  }

  getActiveFailures() {
    const active = [];
    if (this.failures.redisOutage) active.push({ key: 'redisOutage', name: 'Redis is down', scope: 'token store' });
    if (this.failures.redisLatencyMs > 0) active.push({ key: 'redisLatency', name: `Redis +${this.failures.redisLatencyMs}ms slower`, scope: 'every request' });
    if (this.failures.oneGatewayDead) active.push({ key: 'oneGatewayDead', name: 'One gateway down', scope: 'gateway tier' });
    if (this.failures.oneLimiterDead) active.push({ key: 'oneLimiterDead', name: 'One limiter down', scope: 'limiter tier' });
    if (this.failures.clockDriftMs > 0) active.push({ key: 'clockDrift', name: `Clock off by ${this.failures.clockDriftMs}ms`, scope: 'one gateway' });
    if (this.failures.configPropagationDelay) active.push({ key: 'configPropagation', name: 'Stale config', scope: 'one gateway' });
    if (this.failures.hotKeyActive) active.push({ key: 'hotKey', name: 'Hot key', scope: 'one shard' });
    if (this.failures.networkPartition) active.push({ key: 'networkPartition', name: 'Network split', scope: 'half the fleet' });
    return active;
  }

  /* Each incident teaches three things: what it simulates in the real world,
     what the user should watch happen, and how bad it is. */
  _incidentCatalogue() {
    return [
      {
        key: 'redisOutage', title: 'Redis goes down', icon: 'database', category: 'Storage',
        severity: 'critical', blast: 'all gateways',
        real: 'Your shared counter store dies. No gateway can check or record anything.',
        watch: 'Whichever fail policy you pick decides everything: traffic floods through unchecked, or every user gets a 503.',
        active: this.failures.redisOutage,
        hasPolicy: true
      },
      {
        key: 'redisLatency', title: 'Redis gets slow', icon: 'pulse', category: 'Network',
        severity: 'warning', blast: 'all requests',
        real: 'Redis moved to another availability zone, so every lookup now crosses the network.',
        watch: 'Nothing is rejected, but every single request pays the extra 120ms. Watch response time, not throughput.',
        active: this.failures.redisLatencyMs > 0
      },
      {
        key: 'oneGatewayDead', title: 'A gateway crashes', icon: 'gateway', category: 'Compute',
        severity: 'warning', blast: 'gateway tier',
        real: 'One of your API gateway pods dies, so the survivors absorb its share of traffic.',
        watch: 'Gateway load jumps by roughly half. If it crosses 100%, requests get dropped by the machines, not throttled by policy.',
        active: this.failures.oneGatewayDead
      },
      {
        key: 'oneLimiterDead', title: 'A limiter crashes', icon: 'shield', category: 'Compute',
        severity: 'warning', blast: 'limiter tier',
        real: 'One rate limiter daemon dies, cutting how many limit checks per second you can perform.',
        watch: 'Limiter load climbs. The policy still works, you just have less headroom to run it.',
        active: this.failures.oneLimiterDead
      },
      {
        key: 'clockDrift', title: 'Clocks drift apart', icon: 'pulse', category: 'Time',
        severity: 'warning', blast: 'one gateway',
        real: 'NTP fails on one gateway, so it thinks the time is 600ms different from everyone else.',
        watch: 'Fixed and Sliding Window start and end their windows at the wrong moment, so extra traffic slips through. Token Bucket does not care about wall clocks and is immune.',
        active: this.failures.clockDriftMs > 0
      },
      {
        key: 'configPropagation', title: 'Config goes stale', icon: 'layers', category: 'Config',
        severity: 'warning', blast: 'one gateway',
        real: `You lowered the limit, but one gateway never got the memo and is still enforcing ${this.failures.staleLimitValue}/s.`,
        watch: 'Leakage appears out of nowhere. Most gateways behave, one is far too generous, and the total blows past your policy.',
        active: this.failures.configPropagationDelay
      },
      {
        key: 'hotKey', title: 'One key gets hot', icon: 'database', category: 'Sharding',
        severity: 'warning', blast: 'one shard',
        real: 'Your biggest customer always hashes to the same Redis shard, so that one node takes the beating.',
        watch: 'The cluster average stays calm while a single shard melts. This is the failure your dashboards hide from you.',
        active: this.failures.hotKeyActive
      },
      {
        key: 'networkPartition', title: 'The network splits', icon: 'network', category: 'Network',
        severity: 'critical', blast: 'half the fleet',
        real: 'Half your gateways can still reach Redis and half cannot, so the fleet disagrees about reality.',
        watch: 'One half enforces properly while the other falls back to your fail policy. You get both behaviours at once.',
        active: this.failures.networkPartition
      }
    ];
  }

  render() {
    if (!this.containerEl) return;

    const m = this.currentMetrics || {};
    const activeFailures = this.getActiveFailures();
    const isDegraded = activeFailures.length > 0;
    const isCritical = m.isRedisOutage || m.systemMaxUtilization >= 1.0 || (m.rejectionRate > 0.5);

    const health = isCritical
      ? { tone: 'critical', icon: 'alertTriangle', label: 'Something is badly broken',
          text: 'The limiter cannot do its job right now. Read the numbers below to see who is paying for it.' }
      : isDegraded
      ? { tone: 'warning', icon: 'pulse', label: 'Running degraded',
          text: 'An incident is live. The system still serves traffic, but not the way you designed it to.' }
      : { tone: 'healthy', icon: 'checkCircle', label: 'Everything is nominal',
          text: 'No incidents injected. Turn one on below and watch exactly what it costs you.' };

    const fmtN = n => (n || 0).toLocaleString();
    const offered = Math.max(1, m.offeredRPS || 1);
    const meterPct = v => Math.max(0, Math.min(100, (v / offered) * 100));
    const incidents = this._incidentCatalogue();
    /* Toggling re-renders the whole panel; hold the reader's place. */
    const keepScroll = window.scrollY;

    const groups = [
      { name: 'Storage and coordination', keys: ['redisOutage', 'redisLatency', 'hotKey', 'networkPartition'] },
      { name: 'Machines and config', keys: ['oneGatewayDead', 'oneLimiterDead', 'clockDrift', 'configPropagation'] },
    ];

    const card = inc => `
      <article class="rl-chaos-card ${inc.active ? 'is-active' : ''}" data-severity="${inc.severity}">
        <header class="rl-chaos-card-head">
          <span class="rl-chaos-icon">${RL_ICONS[inc.icon] || ''}</span>
          <div class="rl-chaos-titles">
            <h4>${inc.title}</h4>
            <span class="rl-chaos-cat">${inc.category} <span class="rl-chaos-dot"></span> hits ${inc.blast}</span>
          </div>
          <button type="button" class="rl-chaos-switch ${inc.active ? 'on' : ''}"
                  role="switch" aria-checked="${inc.active}" aria-label="Toggle ${inc.title}"
                  data-chaos-toggle="${inc.key}"><span class="rl-chaos-knob"></span></button>
        </header>
        <p class="rl-chaos-real">${inc.real}</p>
        <div class="rl-chaos-watch">
          <span class="rl-chaos-watch-label">Watch for</span>
          <span>${inc.watch}</span>
        </div>
        ${inc.hasPolicy ? `
          <div class="rl-chaos-policy" ${this.failures.redisOutage ? '' : 'hidden'}>
            <span class="rl-chaos-policy-label">When the store is unreachable</span>
            <div class="rl-chaos-policy-btns">
              <button type="button" class="rl-chaos-policy-btn ${this.failPolicy === 'fail_open' ? 'active' : ''}" data-policy="fail_open">
                <strong>Fail open</strong><span>let everyone through</span>
              </button>
              <button type="button" class="rl-chaos-policy-btn ${this.failPolicy === 'fail_closed' ? 'active' : ''}" data-policy="fail_closed">
                <strong>Fail closed</strong><span>reject everyone with 503</span>
              </button>
            </div>
          </div>` : ''}
      </article>`;

    this.containerEl.innerHTML = `
      <div class="rl-scale-wrap">

        <section class="rl-scale-hero">
          <div class="rl-scale-hero-copy">
            <h2 class="rl-scale-title">Break it <span class="rl-gradient-inline">on purpose</span>.</h2>
            <p class="rl-scale-sub">
              Real systems fail in specific, repeatable ways. Turn one of these on and watch exactly
              which number moves, so the first time you see it in production it is not a surprise.
            </p>
          </div>
          <div class="rl-scenario-row">
            <span class="rl-scenario-label">${activeFailures.length} incident${activeFailures.length === 1 ? '' : 's'} live</span>
            <button type="button" class="rl-preset-btn" id="rl-chaos-reset">Recover everything</button>
          </div>
        </section>

        <section class="rl-outcome-grid" aria-label="Live impact">
          <article class="rl-outcome-tile" data-tone="ok">
            <header class="rl-outcome-head"><span class="rl-outcome-icon">${RL_ICONS.checkCircle}</span><span class="rl-outcome-name">Getting through</span></header>
            <div class="rl-outcome-value">${fmtN(m.allowedRPS)}</div>
            <div class="rl-outcome-sub">of ${fmtN(m.offeredRPS)} req/s offered</div>
            <div class="rl-outcome-meter"><span class="rl-outcome-meter-fill" style="width:${meterPct(m.allowedRPS)}%"></span></div>
          </article>
          <article class="rl-outcome-tile" data-tone="reject" data-state="${(m.rejectedRPS || 0) > 0 ? 'warn' : 'idle'}">
            <header class="rl-outcome-head"><span class="rl-outcome-icon">${RL_ICONS.xCircle}</span><span class="rl-outcome-name">Turned away</span></header>
            <div class="rl-outcome-value">${fmtN(m.rejectedRPS)}</div>
            <div class="rl-outcome-sub">${(m.failClosed503RPS || 0) > 0 ? `plus ${fmtN(m.failClosed503RPS)} hitting 503` : 'throttled with 429'}</div>
            <div class="rl-outcome-meter"><span class="rl-outcome-meter-fill" style="width:${meterPct(m.rejectedRPS)}%"></span></div>
          </article>
          <article class="rl-outcome-tile" data-tone="leak" data-state="${(m.leakedRPS || 0) > 0 ? 'bad' : 'ok'}">
            <header class="rl-outcome-head"><span class="rl-outcome-icon">${RL_ICONS.unlock}</span><span class="rl-outcome-name">Leaked past limit</span></header>
            <div class="rl-outcome-value">${fmtN(m.leakedRPS)}</div>
            <div class="rl-outcome-sub">${(m.leakedRPS || 0) > 0 ? 'your policy is not holding' : 'the limit is holding'}</div>
            <div class="rl-outcome-meter"><span class="rl-outcome-meter-fill" style="width:${meterPct(m.leakedRPS)}%"></span></div>
          </article>
          <article class="rl-outcome-tile" data-tone="latency" data-state="${(m.avgLatency || 0) > 80 ? 'warn' : 'idle'}">
            <header class="rl-outcome-head"><span class="rl-outcome-icon">${RL_ICONS.pulse}</span><span class="rl-outcome-name">Response time</span></header>
            <div class="rl-outcome-value">${m.avgLatency || 0}ms</div>
            <div class="rl-outcome-sub">p99 ${m.p99Latency || 0}ms</div>
            <div class="rl-outcome-meter"><span class="rl-outcome-meter-fill" style="width:${Math.min(100, (m.avgLatency || 0) / 2)}%"></span></div>
          </article>
        </section>

        <section class="rl-verdict-card ${health.tone}">
          <div class="rl-verdict-icon">${RL_ICONS[health.icon] || ''}</div>
          <div class="rl-verdict-body">
            <h3 class="rl-verdict-title">${health.label}</h3>
            <p class="rl-verdict-text">${health.text}</p>
            ${activeFailures.length ? `
              <div class="rl-chaos-active-tags">
                ${activeFailures.map(f => `<span class="rl-chaos-tag">${f.name}<em>${f.scope}</em></span>`).join('')}
              </div>` : ''}
          </div>
        </section>

        ${groups.map(g => `
          <section class="rl-stage-block">
            <div class="rl-block-head">
              <h3 class="rl-block-title">${g.name}</h3>
              <p class="rl-block-hint">Flip a switch. Everything above updates instantly.</p>
            </div>
            <div class="rl-chaos-grid">
              ${g.keys.map(k => card(incidents.find(i => i.key === k))).join('')}
            </div>
          </section>`).join('')}

        <section class="rl-stage-block">
          <details class="rl-math-disclosure" ${this.incidentTimeline.length > 1 ? 'open' : ''}>
            <summary class="rl-math-summary">
              <span class="rl-math-summary-left">
                <strong>Incident log (${this.incidentTimeline.length})</strong>
                <span class="rl-math-summary-hint">Everything you have broken and repaired, most recent first</span>
              </span>
              <svg class="rl-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </summary>
            <div class="rl-math-body">
              <div class="rl-chaos-timeline">
                ${this.incidentTimeline.slice().reverse().slice(0, 12).map(ev => `
                  <div class="rl-chaos-event" data-type="${ev.type}">
                    <span class="rl-chaos-event-dot"></span>
                    <div class="rl-chaos-event-body">
                      <strong>${ev.title}</strong>
                      <span>${ev.detail}</span>
                    </div>
                    <time>${ev.timeFormatted}</time>
                  </div>`).join('')}
              </div>
            </div>
          </details>
        </section>
      </div>`;

    window.scrollTo(0, keepScroll);

    this.containerEl.querySelectorAll('[data-chaos-toggle]').forEach(btn => {
      btn.addEventListener('click', () => this._toggleFailure(btn.getAttribute('data-chaos-toggle')));
    });

    this.containerEl.querySelectorAll('[data-policy]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.failPolicy = btn.getAttribute('data-policy');
        this._emitUpdate();
      });
    });

    this.containerEl.querySelector('#rl-chaos-reset')?.addEventListener('click', () => {
      this.failures = {
        redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
        oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
        staleLimitValue: 500, hotKeyActive: false, networkPartition: false
      };
      this.failPolicy = 'fail_open';
      this._addTimelineEvent('recovery', 'All incidents cleared', 'Every failure switched off. The system is back to normal.');
      this._emitUpdate();
    });
  }

  _toggleFailure(key) {
    switch (key) {
      case 'redisOutage':
        this.failures.redisOutage = !this.failures.redisOutage;
        this._addTimelineEvent(
          this.failures.redisOutage ? 'critical' : 'recovery',
          this.failures.redisOutage ? 'Redis went down' : 'Redis came back',
          this.failures.redisOutage
            ? `No gateway can read or write limit state. Policy in force: ${this.failPolicy === 'fail_open' ? 'fail open' : 'fail closed'}.`
            : 'The cluster is reachable again and limits are being enforced normally.'
        );
        break;
      case 'redisLatency':
        this.failures.redisLatencyMs = this.failures.redisLatencyMs > 0 ? 0 : 120;
        this._addTimelineEvent('warning',
          this.failures.redisLatencyMs > 0 ? 'Redis slowed down' : 'Redis latency recovered',
          this.failures.redisLatencyMs > 0
            ? 'Every limit check now crosses an availability zone and costs an extra 120ms.'
            : 'Lookups are local again and the extra latency is gone.');
        break;
      case 'oneGatewayDead':
        this.failures.oneGatewayDead = !this.failures.oneGatewayDead;
        this._addTimelineEvent('warning',
          this.failures.oneGatewayDead ? 'A gateway crashed' : 'The gateway came back',
          this.failures.oneGatewayDead
            ? 'The surviving gateways now carry its share of the traffic.'
            : 'Capacity is restored across the gateway tier.');
        break;
      case 'oneLimiterDead':
        this.failures.oneLimiterDead = !this.failures.oneLimiterDead;
        this._addTimelineEvent('warning',
          this.failures.oneLimiterDead ? 'A limiter crashed' : 'The limiter came back',
          this.failures.oneLimiterDead
            ? 'You can run fewer limit checks per second than before.'
            : 'Full check throughput is available again.');
        break;
      case 'clockDrift':
        this.failures.clockDriftMs = this.failures.clockDriftMs > 0 ? 0 : 600;
        this._addTimelineEvent('warning',
          this.failures.clockDriftMs > 0 ? 'Clocks drifted apart' : 'Clocks resynchronised',
          this.failures.clockDriftMs > 0
            ? 'One gateway is 600ms out of step, so its windows open and close at the wrong time. Token Bucket is unaffected.'
            : 'Every gateway agrees on the time again.');
        break;
      case 'configPropagation':
        this.failures.configPropagationDelay = !this.failures.configPropagationDelay;
        this._addTimelineEvent('warning',
          this.failures.configPropagationDelay ? 'One gateway is on stale config' : 'Config synced everywhere',
          this.failures.configPropagationDelay
            ? `That gateway is still enforcing ${this.failures.staleLimitValue}/s instead of your current limit.`
            : 'Every gateway is enforcing the same limit again.');
        break;
      case 'hotKey':
        this.failures.hotKeyActive = !this.failures.hotKeyActive;
        this._addTimelineEvent('warning',
          this.failures.hotKeyActive ? 'A key went hot' : 'The hot key cooled off',
          this.failures.hotKeyActive
            ? 'Your heaviest identity is hammering a single Redis shard while the cluster average stays calm.'
            : 'Traffic is spread evenly across the shards again.');
        break;
      case 'networkPartition':
        this.failures.networkPartition = !this.failures.networkPartition;
        this._addTimelineEvent(
          this.failures.networkPartition ? 'critical' : 'recovery',
          this.failures.networkPartition ? 'The network split' : 'The partition healed',
          this.failures.networkPartition
            ? 'Half your gateways can reach Redis and half cannot, so the fleet no longer agrees on the count.'
            : 'Every gateway can reach Redis again.');
        break;
    }
    this._emitUpdate();
  }

  _addTimelineEvent(type, title, detail) {
    this.incidentTimeline.push({
      id: `evt-${Date.now()}`, timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type, title, detail
    });
  }

  _emitUpdate() {
    if (this.onStateChange) {
      this.onStateChange({
        failures: { ...this.failures },
        failPolicy: this.failPolicy
      });
    }
  }
}
