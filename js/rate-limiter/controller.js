/**
 * Rate Limiter Simulator Controller
 *
 * Coordinates: model, views, tracer, race-sim, chaos, challenges, graph.
 * All DOM elements are rl-* namespaced to avoid collisions with URL Shortener.
 */

import { RL_DEFAULT_STATE, RL_PRESETS } from './config.js';
import { RateLimiterModel } from './model.js';
import { RateLimiterTracer } from './tracer.js';
import { DistributedSimulator } from './distributed-sim.js';
import { RaceConditionSimulator } from './race-sim.js';
import { RateLimiterChaosManager } from './chaos.js';
import { RateLimiterChallengeManager } from './challenges.js';
import { RL_ICONS } from './icons.js';

/* ── Helpers ── */
const $ = id => document.getElementById(id);
const fmt = n => {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};
const pct = n => (n == null || isNaN(n)) ? '0%' : (n * 100).toFixed(1) + '%';
/* Load → one shared severity vocabulary used by bars, tiles and the verdict card */
const toneFor = u => u >= 1.0 ? 'critical' : u >= 0.7 ? 'warning' : 'ok';

export class RateLimiterController {
  constructor() {
    this.state = JSON.parse(JSON.stringify(RL_DEFAULT_STATE));
    // Two separate model instances, two separate clocks:
    //  - this.model drives the Scale System (calculate(), real-time-derived dt)
    //  - this.interactiveModel drives the How It Works tracer (simTime-based)
    // They must never share identityState, or Fixed Window's window boundary
    // gets corrupted by whichever clock touched it last (see model.js).
    this.model = new RateLimiterModel();
    this.interactiveModel = new RateLimiterModel();
    this.metrics = null;
    this.tracer = null;
    this.distributedSim = null;
    this.raceSim = null;
    this.chaosManager = null;
    this.challengeManager = null;
    this.currentView = 'how-it-works';
    this.graphHistory = [];
    this.graphCanvas = null;
    this.graphCtx = null;
    this.changeLog = [];
  }

  /* ────────────────────────────────────────────────────────
     INITIALIZATION
     ──────────────────────────────────────────────────────── */
  init() {
    this._bindNavTabs();
    this._bindScaleControls();
    this._bindHowItWorks();

    // Initialize tracer with the interactive model (sim-clock) as single source of truth
    this.tracer = new RateLimiterTracer(
      $('rl-trace-pipeline'),
      $('rl-hop-inspector'),
      $('rl-token-store-inspector'),
      this.interactiveModel
    );
    this.tracer.renderIdleState();

    // Initialize distributed topology experiment
    this.distributedSim = new DistributedSimulator(
      $('rl-distributed-experiment-container'),
      this.model,
      this.state,
      (newStorage) => {
        this.state.tokenStore = newStorage;
        const storeSel = $('rl-select-store');
        if (storeSel) storeSel.value = newStorage;
        this.updateSimulation(false, `Storage changed to ${newStorage}`);
      }
    );
    this.distributedSim.render();

    // Initialize race condition sim
    this.raceSim = new RaceConditionSimulator($('rl-race-sim-container'));
    this.raceSim.render();

    // Initialize chaos
    this.chaosManager = new RateLimiterChaosManager(
      $('rl-chaos-container'),
      (update) => this._handleChaosUpdate(update),
      this.model
    );

    // Initialize challenges
    this.challengeManager = new RateLimiterChallengeManager(
      $('rl-challenges-container'),
      (newState) => this._applyChallengeState(newState),
      (action, callback) => this._applyChallengeAction(action, callback)
    );
    this.challengeManager.render();

    // Graph
    this.graphCanvas = $('rl-traffic-graph-canvas');
    if (this.graphCanvas) {
      this.graphCtx = this.graphCanvas.getContext('2d');
    }

    this._hydrateIcons();
    this._syncSliderFills();
    this._updateContextHelp();

    // Initial simulation
    this.updateSimulation(false, 'Rate Limiter Simulator Initialized');
    this.switchView('how-it-works');
  }

  /* ────────────────────────────────────────────────────────
     VIEW SWITCHING
     ──────────────────────────────────────────────────────── */
  switchView(view) {
    this.currentView = view;
    const views = ['how-it-works', 'scale-simulator', 'challenges', 'chaos-lab'];
    views.forEach(v => {
      const el = $(`rl-view-${v}`);
      if (el) el.classList.toggle('view-hidden', v !== view);
    });

    // Update nav tabs
    document.querySelectorAll('.rl-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-rl-mode') === view);
    });

    // Render submodules on entry
    if (view === 'chaos-lab' && this.chaosManager) {
      this.chaosManager.updateContext(this.state, this.metrics, this.model);
    }
    if (view === 'challenges' && this.challengeManager) {
      this.challengeManager.render();
    }
    if (view === 'how-it-works' && this.distributedSim) {
      this.distributedSim.render();
    }
    if (view === 'scale-simulator') {
      this._resizeGraph();
    }
  }

  /* ────────────────────────────────────────────────────────
     NAVIGATION
     ──────────────────────────────────────────────────────── */
  _bindNavTabs() {
    document.querySelectorAll('.rl-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-rl-mode');
        if (!mode) return;
        this.switchView(mode);
        // Land at the top of the new view rather than wherever the last one was scrolled
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  /* ────────────────────────────────────────────────────────
     HOW IT WORKS
     ──────────────────────────────────────────────────────── */
  _bindHowItWorks() {
    // Multi-request / burst buttons
    const bindBtn = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener('click', fn);
    };

    bindBtn('rl-btn-send-1', () => this.tracer?.executeRequests(1, this.state));
    bindBtn('rl-btn-send-10', () => this.tracer?.executeRequests(10, this.state));
    bindBtn('rl-btn-send-100', () => this.tracer?.executeRequests(100, this.state));
    bindBtn('rl-btn-send-burst', () => this.tracer?.executeRequests(50, this.state));
    bindBtn('rl-btn-simulate-limit', () => this.tracer?.forceLimitReached(this.state));
    bindBtn('rl-btn-reset-tokens', () => this.tracer?.resetTokens(this.state));
    bindBtn('rl-btn-step-clock', () => this.tracer?.stepSimulationTime(0.5, this.state));

    // Fallbacks if existing buttons are rendered
    bindBtn('rl-btn-send-request', () => this.tracer?.executeRequests(1, this.state));
    bindBtn('rl-btn-send-rejected', () => this.tracer?.forceLimitReached(this.state));

    // Algorithm select in how-it-works
    const algoSelect = $('rl-hiw-algorithm');
    if (algoSelect) {
      algoSelect.addEventListener('change', () => this._switchAlgorithm(algoSelect.value));
    }

    // Algorithm pill buttons
    document.querySelectorAll('.rl-algo-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const algo = btn.getAttribute('data-algo');
        if (algo && algo !== this.state.algorithm) {
          if (algoSelect) {
            algoSelect.value = algo;
            algoSelect.dispatchEvent(new Event('change'));
          }
        }
      });
    });
  }

  _syncAlgoPills(algo) {
    document.querySelectorAll('.rl-algo-pill').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-algo') === algo);
    });
  }

  /* ── Swap [data-icon="name"] placeholders for real SVGs (see icons.js) ── */
  _hydrateIcons() {
    document.querySelectorAll('#sim-rate-limiter [data-icon]').forEach(el => {
      const svg = RL_ICONS[el.getAttribute('data-icon')];
      if (svg) el.innerHTML = svg;
    });
  }

  /* ── Sliders paint their own filled track via a --fill custom property ── */
  _setSliderFill(el) {
    if (!el) return;
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const val = parseFloat(el.value) || 0;
    const p = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', `${p}%`);
  }

  _syncSliderFills() {
    document.querySelectorAll('#sim-rate-limiter .rl-slider').forEach(el => this._setSliderFill(el));
  }

  /* ── Plain-English help that follows whatever option is selected ── */
  _updateContextHelp() {
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };

    set('rl-algo-help', {
      token_bucket: 'Tokens refill steadily; a full bucket absorbs a sudden burst.',
      fixed_window: 'A counter resets on a fixed clock, so a burst can straddle the reset and land double.',
      sliding_window: 'Blends the last window with this one, so the limit rolls smoothly instead of snapping.',
    }[this.state.algorithm]);

    set('rl-store-help', this.state.tokenStore === 'redis'
      ? 'One shared source of truth, so the global limit actually holds.'
      : `Each gateway counts alone, so the real ceiling becomes ${this.state.gatewayNodes} × your limit.`);

    set('rl-atomicity-help', this.state.atomicityMode === 'atomic'
      ? 'Nothing can slip between the check and the increment.'
      : 'Two gateways can read the same count and both say yes, which over-admits.');

    set('rl-failpolicy-help', this.state.failPolicy === 'fail_open'
      ? 'Availability over protection: downstream takes the hit.'
      : 'Protection over availability: users see 503 while the store is down.');
  }

  /* ── Single entry point for every algorithm-switch trigger ──
   * (How It Works select/pills, Scale System select, algo-card clicks all
   * funnel here). Starts a clean experiment: both models reset, and the
   * tracer's banner/pipeline are reset instead of showing stale state from
   * whichever algorithm was previously selected.
   */
  _switchAlgorithm(algo) {
    if (!algo || algo === this.state.algorithm) return;
    this.state.algorithm = algo;

    const hiwAlgo = $('rl-hiw-algorithm');
    if (hiwAlgo) hiwAlgo.value = algo;
    const scaleAlgo = $('rl-select-algorithm');
    if (scaleAlgo) scaleAlgo.value = algo;

    this.interactiveModel.resetState(this.state.bucketCapacity, this.state.refillRate);
    this.model.resetState(this.state.bucketCapacity, this.state.refillRate);

    this.tracer?.resetForNewAlgorithm(this.state);
    this.updateSimulation(false, `Algorithm → ${algo.replace('_', ' ')}`);
    this._updateAlgoDetails();
    this._syncAlgoPills(algo);
  }

  /* ────────────────────────────────────────────────────────
     SCALE SYSTEM CONTROLS
     ──────────────────────────────────────────────────────── */
  _bindScaleControls() {
    // Traffic slider
    this._bindSlider('rl-slider-traffic', val => {
      this.state.traffic = val;
      if ($('rl-val-traffic-display')) $('rl-val-traffic-display').innerHTML = `${fmt(val)} <span class="unit">req/s</span>`;
    }, 'Traffic');

    // Per-user limit slider
    this._bindSlider('rl-slider-limit', val => {
      this.state.limitPerUser = val;
      this.state.refillRate = val;
      this.state.bucketCapacity = val * 2;
      if ($('rl-val-limit-display')) $('rl-val-limit-display').textContent = `${val}/s`;
    }, 'Per-User Limit');

    // Active identities slider
    this._bindSlider('rl-slider-identities', val => {
      this.state.activeIdentities = val;
      if ($('rl-val-identities-display')) $('rl-val-identities-display').textContent = fmt(val);
    }, 'Active Identities');

    // Top identity ratio slider
    this._bindSlider('rl-slider-top-ratio', val => {
      this.state.topIdentityRatio = val / 100;
      if ($('rl-val-top-ratio-display')) $('rl-val-top-ratio-display').textContent = `${val}%`;
    }, 'Top Identity %');

    // Algorithm selector
    const algoSel = $('rl-select-algorithm');
    if (algoSel) {
      algoSel.addEventListener('change', () => this._switchAlgorithm(algoSel.value));
    }

    // Traffic profile
    const profileSel = $('rl-select-profile');
    if (profileSel) {
      profileSel.addEventListener('change', () => {
        this.state.trafficProfile = profileSel.value;
        this.updateSimulation(false, `Traffic Profile → ${this.state.trafficProfile}`);
      });
    }

    // Token store toggle
    const storeSel = $('rl-select-store');
    if (storeSel) {
      storeSel.addEventListener('change', () => {
        this.state.tokenStore = storeSel.value;
        this.updateSimulation(false, `Token Store → ${this.state.tokenStore}`);
        this._updateStoreDetails();
      });
    }

    // Atomicity
    const atomSel = $('rl-select-atomicity');
    if (atomSel) {
      atomSel.addEventListener('change', () => {
        this.state.atomicityMode = atomSel.value;
        this.updateSimulation(false, `Atomicity → ${this.state.atomicityMode}`);
      });
    }

    // Stepper controls
    this._bindStepper('rl-btn-gw', 'rl-val-gw-count', val => {
      this.state.gatewayNodes = val;
    }, 1, 10, 'Gateway Nodes');

    this._bindStepper('rl-btn-rl', 'rl-val-rl-count', val => {
      this.state.rateLimiterNodes = val;
    }, 1, 8, 'Rate Limiter Nodes');

    this._bindStepper('rl-btn-shard', 'rl-val-shard-count', val => {
      this.state.redisShards = val;
    }, 1, 16, 'Redis Shards');

    // Fail policy
    const fpSel = $('rl-select-fail-policy');
    if (fpSel) {
      fpSel.addEventListener('change', () => {
        this.state.failPolicy = fpSel.value;
        this.updateSimulation(false, `Fail Policy → ${this.state.failPolicy}`);
      });
    }

    // Reset button
    const resetBtn = $('rl-btn-reset-infra');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.state = JSON.parse(JSON.stringify(RL_DEFAULT_STATE));
        this.model.resetState(this.state.bucketCapacity);
        this.graphHistory = [];
        this.changeLog = [];
        this._syncControlsToState();
        this.updateSimulation(false, 'Reset to Initial State');
      });
    }

    // Preset buttons
    document.querySelectorAll('.rl-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-rl-preset');
        const preset = RL_PRESETS[key];
        if (preset) {
          this.state = { ...this.state, ...preset, failures: { ...preset.failures } };
          this.model.resetState(this.state.bucketCapacity);
          this._syncControlsToState();
          this.updateSimulation(false, `Preset: ${preset.name}`);
        }
      });
    });

    // Assumptions modal
    const asmBtn = $('rl-btn-assumptions');
    if (asmBtn) {
      asmBtn.addEventListener('click', () => this._openAssumptions());
    }

    // Bucket capacity / refill rate (advanced)
    this._bindSlider('rl-slider-burst-cap', val => {
      this.state.bucketCapacity = val;
      if ($('rl-val-burst-cap')) $('rl-val-burst-cap').textContent = val;
    }, 'Bucket Capacity');

    this._bindSlider('rl-slider-refill-rate', val => {
      this.state.refillRate = val;
      if ($('rl-val-refill-rate')) $('rl-val-refill-rate').textContent = `${val}/s`;
    }, 'Refill Rate');
  }

  _bindSlider(id, onChange, label) {
    const el = $(id);
    if (!el) return;
    const handler = () => {
      const val = parseFloat(el.value);
      this._setSliderFill(el);
      onChange(val);
      this._updateContextHelp();
      this.updateSimulation(false, `${label}: ${val}`);
    };
    el.addEventListener('input', handler);
  }

  _bindStepper(btnPrefix, valId, onChange, min, max, label) {
    const valEl = $(valId);
    const minusBtn = $(`${btnPrefix}-minus`);
    const plusBtn = $(`${btnPrefix}-plus`);
    if (!valEl) return;
    if (minusBtn) {
      minusBtn.addEventListener('click', () => {
        let v = parseInt(valEl.textContent, 10) || 1;
        v = Math.max(min, v - 1);
        valEl.textContent = v;
        onChange(v);
        this.updateSimulation(false, `${label}: ${v}`);
      });
    }
    if (plusBtn) {
      plusBtn.addEventListener('click', () => {
        let v = parseInt(valEl.textContent, 10) || 1;
        v = Math.min(max, v + 1);
        valEl.textContent = v;
        onChange(v);
        this.updateSimulation(false, `${label}: ${v}`);
      });
    }
  }

  _syncControlsToState() {
    const s = this.state;
    const set = (id, val) => { const el = $(id); if (el) el.value = val; };
    const txt = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    const htm = (id, val) => { const el = $(id); if (el) el.innerHTML = val; };

    set('rl-slider-traffic', s.traffic);
    htm('rl-val-traffic-display', `${fmt(s.traffic)} <span class="unit">req/s</span>`);
    set('rl-slider-limit', s.limitPerUser);
    txt('rl-val-limit-display', `${s.limitPerUser}/s`);
    set('rl-slider-identities', s.activeIdentities);
    txt('rl-val-identities-display', fmt(s.activeIdentities));
    set('rl-slider-top-ratio', Math.round(s.topIdentityRatio * 100));
    txt('rl-val-top-ratio-display', `${Math.round(s.topIdentityRatio * 100)}%`);
    set('rl-select-algorithm', s.algorithm);
    set('rl-select-profile', s.trafficProfile);
    set('rl-select-store', s.tokenStore);
    set('rl-select-atomicity', s.atomicityMode);
    set('rl-select-fail-policy', s.failPolicy);
    txt('rl-val-gw-count', s.gatewayNodes);
    txt('rl-val-rl-count', s.rateLimiterNodes);
    txt('rl-val-shard-count', s.redisShards);
    set('rl-slider-burst-cap', s.bucketCapacity);
    txt('rl-val-burst-cap', s.bucketCapacity);
    set('rl-slider-refill-rate', s.refillRate);
    txt('rl-val-refill-rate', `${s.refillRate}/s`);

    this._syncSliderFills();
    this._updateContextHelp();
    this._updateAlgoDetails();
    this._updateStoreDetails();
  }

  _updateAlgoDetails() {
    const tbDetails = $('rl-algo-token-bucket-details');
    const wDetails = $('rl-algo-window-details');
    if (tbDetails) tbDetails.style.display = this.state.algorithm === 'token_bucket' ? '' : 'none';
    if (wDetails) wDetails.style.display = this.state.algorithm !== 'token_bucket' ? '' : 'none';
  }

  _updateStoreDetails() {
    const redisDetails = $('rl-redis-details');
    if (redisDetails) redisDetails.style.display = this.state.tokenStore === 'redis' ? '' : 'none';
  }

  /* ────────────────────────────────────────────────────────
     SIMULATION UPDATE: core loop
     ──────────────────────────────────────────────────────── */
  updateSimulation(skipGraph = false, changeNote = '') {
    this.metrics = this.model.calculate(this.state);
    const m = this.metrics;

    // Update tracer algorithm state
    if (this.tracer) {
      this.tracer.updateAlgorithmState(this.state, m);
    }

    // Update chaos context
    if (this.chaosManager && this.currentView === 'chaos-lab') {
      this.chaosManager.updateContext(this.state, m, this.model);
    }

    // Update distributed simulation context
    if (this.distributedSim) {
      this.distributedSim.updateContext(this.state);
    }

    // Challenge objectives tick live off the same metrics
    if (this.challengeManager) this.challengeManager.updateMetrics(m);

    this._updateContextHelp();
    this._updateArchDiagram(m);
    this._updateMetrics(m);
    this._updateBreakdown(m);
    this._updateLesson(m);

    if (!skipGraph) {
      this._pushGraphPoint(m);
      this._renderGraph();
    }

    if (changeNote) {
      this._addChangeLog(changeNote, m);
    }
  }

  /* ────────────────────────────────────────────────────────
     ARCHITECTURE DIAGRAM
     ──────────────────────────────────────────────────────── */
  _updateArchDiagram(m) {
    /* One stage = one load bar + one caption. Tone is shared with the tiles. */
    const stage = (fillId, pctId, metaId, util, metaHtml, pctText) => {
      const fill = $(fillId), pctEl = $(pctId), meta = $(metaId);
      if (fill) {
        fill.style.width = `${Math.max(2, Math.min(100, util * 100))}%`;
        fill.dataset.tone = toneFor(util);
      }
      if (pctEl) {
        pctEl.textContent = pctText ?? pct(util);
        pctEl.dataset.tone = toneFor(util);
      }
      if (meta) meta.innerHTML = metaHtml;
    };

    const clientMetric = $('rl-arch-client-metric');
    if (clientMetric) clientMetric.textContent = `${fmt(m.offeredRPS)} req/s`;

    stage('rl-arch-gw-fill', 'rl-arch-gw-pct', 'rl-arch-gw-meta', m.gatewayUtilization,
      `<span>${m.activeGateways} nodes</span><span>cap ${fmt(m.gatewayCapacity)}/s</span>`);

    stage('rl-arch-rl-fill', 'rl-arch-rl-pct', 'rl-arch-rl-meta', m.rateLimiterUtilization,
      `<span>${m.activeRateLimiters} daemons</span><span>cap ${fmt(m.rateLimiterCapacity)}/s</span>`);

    const isRedis = m.tokenStore === 'redis';
    const storeName = $('rl-arch-store-name');
    if (storeName) storeName.textContent = isRedis ? 'Redis Store' : 'Local Memory';
    const storeUtil = isRedis
      ? Math.max(m.redisClusterUtilization, m.redisHotShardUtilization)
      : 0.05;
    stage('rl-arch-redis-fill', 'rl-arch-redis-pct', 'rl-arch-redis-meta', storeUtil,
      isRedis
        ? `<span>${this.state.redisShards} shards</span><span>${fmt(m.redisOpsPerSec)} ops/s</span>`
        : `<span>${m.activeGateways} copies</span><span>no coordination</span>`,
      isRedis
        ? (m.redisHotShardUtilization > m.redisClusterUtilization ? `${pct(m.redisHotShardUtilization)} hot` : pct(m.redisClusterUtilization))
        : 'in-process');

    stage('rl-arch-ds-fill', 'rl-arch-ds-pct', 'rl-arch-ds-meta', m.downstreamUtilization,
      `<span>${fmt(m.downstreamReceivedRPS)} req/s</span><span>cap ${fmt(this.model.cfg.downstreamCapacity)}/s</span>`);

    // Mark the single worst stage so the bottleneck is visually unmistakable
    const worst = m.primaryBottleneck?.id;
    const stageByBottleneck = { gateway: 'rl-arch-gw-card', rate_limiter: 'rl-arch-rl-card', redis: 'rl-arch-redis-card', downstream: 'rl-arch-ds-card' };
    Object.values(stageByBottleneck).forEach(id => $(id)?.classList.remove('is-bottleneck'));
    if (m.systemMaxUtilization > 0.7 && stageByBottleneck[worst]) {
      $(stageByBottleneck[worst])?.classList.add('is-bottleneck');
    }

    const hotAlert = $('rl-hot-key-alert');
    if (hotAlert) {
      hotAlert.style.display = (m.redisHotShardUtilization > 1.0 && this.state.failures?.hotKeyActive) ? '' : 'none';
      const hotSub = $('rl-hot-key-sub');
      if (hotSub) hotSub.textContent = `That one shard is at ${pct(m.redisHotShardUtilization)} while the cluster average sits at ${pct(m.redisClusterUtilization)}. Averages hide this completely.`;
    }

    const leakAlert = $('rl-leakage-alert');
    if (leakAlert) {
      leakAlert.style.display = m.leakedRPS > 0 ? '' : 'none';
      const leakSub = $('rl-leakage-sub');
      if (leakSub) {
        leakSub.textContent = m.tokenStore === 'local_memory'
          ? `${fmt(m.leakedRPS)} req/s slip past the limit because each of your ${m.activeGateways} gateways counts on its own.`
          : `${fmt(m.leakedRPS)} req/s slip past the limit because concurrent check-then-write lets requests interleave.`;
      }
    }
  }

  /* ────────────────────────────────────────────────────────
     OUTCOME TILES
     ──────────────────────────────────────────────────────── */
  _updateMetrics(m) {
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    const meter = (id, ratio) => {
      const el = $(id);
      if (el) el.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
    };
    const tone = (id, t) => { const el = $(id); if (el) el.dataset.state = t; };

    const offered = Math.max(1, m.offeredRPS);

    set('rl-metric-throughput', `${fmt(m.allowedRPS)}/s`);
    set('rl-metric-throughput-sub', m.rejectionRate > 0.01
      ? `${pct(1 - m.rejectionRate)} of everything offered`
      : 'everything offered is getting through');
    meter('rl-meter-allowed', m.allowedRPS / offered);
    tone('rl-tile-allowed', m.rejectionRate > 0.5 ? 'warn' : 'ok');

    set('rl-metric-rejection', pct(m.rejectionRate));
    set('rl-metric-rejection-sub', m.rejectedRPS > 0
      ? `${fmt(m.rejectedRPS)} req/s told to slow down`
      : 'nobody is being throttled');
    meter('rl-meter-rejected', m.rejectionRate);
    tone('rl-tile-rejected', m.rejectionRate > 0.25 ? 'warn' : 'idle');

    set('rl-metric-leaked', m.leakedRPS > 0 ? `${fmt(m.leakedRPS)}/s` : '0');
    set('rl-metric-leaked-sub', m.leakedRPS > 0
      ? 'your limit is not holding'
      : 'the limit is holding exactly');
    meter('rl-meter-leaked', m.leakedRPS / offered);
    tone('rl-tile-leaked', m.leakedRPS > 0 ? 'bad' : 'ok');

    set('rl-metric-latency', `${m.avgLatency}ms`);
    set('rl-metric-latency-sub', `p99 ${m.p99Latency}ms · ${m.systemMaxUtilization > 0.7 ? 'queueing has started' : 'no queueing yet'}`);
    meter('rl-meter-latency', Math.min(1, m.avgLatency / 200));
    tone('rl-tile-latency', m.avgLatency > 80 ? 'warn' : 'idle');
  }

  /* ────────────────────────────────────────────────────────
     THE MATH: one readable card per derived number
     ──────────────────────────────────────────────────────── */
  _updateBreakdown(m) {
    const grid = $('rl-metrics-grid');
    if (!grid) return;

    /* Each card leads with the equation, then says what it means in plain
       English, then shows the working. Same shape every time. */
    const cards = [
      {
        icon: 'network',
        title: 'Gateway load',
        equation: `${fmt(m.offeredRPS)} req/s ÷ (${m.activeGateways} × ${fmt(this.model.cfg.gatewayCapacity)}) = ${pct(m.gatewayUtilization)}`,
        plain: `Your ${m.activeGateways} gateways can handle ${fmt(m.gatewayCapacity)} req/s between them. Right now they are ${pct(m.gatewayUtilization)} full.`,
        steps: m.mathBreakdowns.gateway.steps,
        tone: toneFor(m.gatewayUtilization),
      },
      {
        icon: 'shield',
        title: 'Rate limiter load',
        equation: `${fmt(m.offeredRPS)} checks/s ÷ (${m.activeRateLimiters} × ${fmt(this.model.cfg.rateLimiterCapacity)}) = ${pct(m.rateLimiterUtilization)}`,
        plain: `Every request costs one limit check. ${m.activeRateLimiters} daemons can do ${fmt(m.rateLimiterCapacity)} checks/s.`,
        steps: m.mathBreakdowns.rateLimiter.steps,
        tone: toneFor(m.rateLimiterUtilization),
      },
      {
        icon: 'client',
        title: 'Who is actually sending',
        equation: `${fmt(m.offeredRPS)} req/s spread over ${fmt(m.activeIdentities)} users · heaviest sends ${fmt(m.topIdentityOfferedRPS)}`,
        plain: `Limits apply per user, not to the total. That is why ${fmt(m.offeredRPS)} req/s can be fine while one user still gets throttled.`,
        steps: m.mathBreakdowns.identity.steps,
        tone: 'ok',
      },
      {
        icon: m.algorithm === 'token_bucket' ? 'database' : 'pulse',
        title: 'The algorithm',
        equation: m.algorithm === 'token_bucket'
          ? `${m.sustainedLimit}/s sustained · ${m.burstCapacity} burst · ${m.currentAvailableTokens} left`
          : `${m.windowCountCurrent} used of ${this.state.limitPerUser} this window`,
        plain: m.algorithm === 'token_bucket'
          ? 'Tokens arrive at the sustained rate and pile up to the burst ceiling. One request spends one token.'
          : 'A counter tracks requests inside the window and resets when the window rolls over.',
        steps: m.mathBreakdowns.tokenBucket.steps,
        tone: 'ok',
      },
      {
        icon: 'database',
        title: m.tokenStore === 'redis' ? 'Redis coordination' : 'Local memory',
        equation: m.tokenStore === 'redis'
          ? `${fmt(m.redisOpsPerSec)} ops/s ÷ ${this.state.redisShards} shards = ${pct(m.redisClusterUtilization)} cluster load`
          : `${m.activeGateways} independent counters · no coordination`,
        plain: m.tokenStore === 'redis'
          ? 'Every gateway asks the same Redis key, so the global limit is enforced once, centrally.'
          : `Each gateway keeps its own count, so the real ceiling is ${m.activeGateways} × your limit.`,
        steps: m.mathBreakdowns.redis.steps,
        tone: toneFor(m.redisClusterUtilization),
      },
      {
        icon: 'unlock',
        title: 'Leakage',
        equation: m.leakedRPS > 0
          ? `${fmt(m.allowedRPS)} allowed − ${this.state.limitPerUser}/s intended = ${fmt(m.leakedRPS)} req/s over`
          : 'allowed ≤ limit · 0 req/s over',
        plain: m.leakedRPS > 0
          ? 'More traffic is getting through than your policy promises. This is the distributed coordination bug.'
          : 'Nothing is getting through above the configured limit.',
        steps: m.mathBreakdowns.leakage.steps,
        tone: m.leakedRPS > 0 ? 'critical' : 'ok',
      },
      {
        icon: 'zap',
        title: 'Downstream pressure',
        equation: `${fmt(m.downstreamReceivedRPS)} req/s ÷ ${fmt(this.model.cfg.downstreamCapacity)} cap = ${pct(m.downstreamUtilization)}`,
        plain: 'Only allowed traffic reaches downstream, which is the whole point of the limiter.',
        steps: m.mathBreakdowns.downstream.steps,
        tone: toneFor(m.downstreamUtilization),
      },
      {
        icon: 'pulse',
        title: 'Latency',
        equation: `${m.avgLatency}ms average · p95 ${m.p95Latency}ms · p99 ${m.p99Latency}ms`,
        plain: m.systemMaxUtilization > 0.7
          ? 'A tier is above 70% full, so requests start queueing and the tail gets much worse than the average.'
          : 'Nothing is congested, so latency is just the sum of each hop.',
        steps: m.mathBreakdowns.latency.steps,
        tone: m.avgLatency > 80 ? 'warning' : 'ok',
      },
    ];

    grid.innerHTML = cards.map(c => `
      <article class="rl-math-card" data-tone="${c.tone}">
        <header class="rl-math-card-head">
          <span class="rl-math-card-icon">${RL_ICONS[c.icon] || ''}</span>
          <h4>${c.title}</h4>
        </header>
        <div class="rl-math-equation">${c.equation}</div>
        <p class="rl-math-plain">${c.plain}</p>
        <details class="rl-math-steps">
          <summary>Step by step</summary>
          <ol>${(c.steps || []).map(s => `<li>${s}</li>`).join('')}</ol>
        </details>
      </article>`).join('');
  }

  /* ────────────────────────────────────────────────────────
     VERDICT CARD: what is happening, why, and what to try
     ──────────────────────────────────────────────────────── */
  _updateLesson(m) {
    const card = $('rl-lesson-card');
    const icon = $('rl-lesson-icon');
    const title = $('rl-lesson-title');
    const body = $('rl-lesson-body');
    const action = $('rl-lesson-action');
    if (!card || !title || !body || !action) return;

    let v;
    if (m.isRedisOutage) {
      const isOpen = m.failPolicy === 'fail_open';
      v = {
        tone: 'critical', icon: 'alertTriangle',
        title: isOpen ? 'Redis is down and the limiter is wide open' : 'Redis is down and everyone is locked out',
        body: isOpen
          ? `With no store to check, every request is waved through. All ${fmt(m.allowedRPS)} req/s are hitting downstream with no protection at all, and downstream is ${pct(m.downstreamUtilization)} full.`
          : `With no store to check, the limiter refuses everything. Downstream is perfectly safe, and not a single user is being served.`,
        action: isOpen
          ? 'This is the availability-over-safety trade. Switch "If the store dies" to fail closed to see the other side of it.'
          : 'This is the safety-over-availability trade. Switch to fail open to see what downstream pays for that.',
      };
    } else if (m.leakedRPS > 100) {
      v = {
        tone: 'critical', icon: 'unlock',
        title: 'Your rate limit is not holding',
        body: m.tokenStore === 'local_memory'
          ? `You promised ${this.state.limitPerUser} req/s per user, but ${fmt(m.leakedRPS)} req/s are getting through on top of that. Each of your ${m.activeGateways} gateways keeps its own private counter, so a user who spreads traffic across them is really allowed ${m.activeGateways} × ${this.state.limitPerUser} req/s.`
          : `${fmt(m.leakedRPS)} req/s are getting through above your limit. Gateways read the counter, decide, then write. In that gap other requests read the same stale number and also say yes.`,
        action: m.tokenStore === 'local_memory'
          ? 'Switch "Where counters live" to Redis. One shared count means one real limit.'
          : 'Switch "Check & increment" to atomic so the read and the write cannot be split apart.',
      };
    } else if (this.state.failures?.hotKeyActive
               && m.redisHotShardUtilization > 1.0
               && m.redisHotShardUtilization > m.redisClusterUtilization * 1.3) {
      /* Only a real hot key: the shard must be meaningfully worse than the
         cluster average, otherwise this is just ordinary Redis overload. */
      v = {
        tone: 'warning', icon: 'database',
        title: 'One Redis shard is melting while the average looks fine',
        body: `Your cluster average is ${pct(m.redisClusterUtilization)}, which looks survivable. But every request from your heaviest user hashes to the same key, so that one shard is at ${pct(m.redisHotShardUtilization)}. Averages hide this completely.`,
        action: 'Spread the hot identity across sub-keys, or cache its decision at the gateway so it stops hammering one shard.',
      };
    } else if (m.systemMaxUtilization > 1.0) {
      v = {
        tone: 'critical', icon: 'alertTriangle',
        title: `${m.primaryBottleneck?.name || 'A tier'} is overloaded and dropping traffic`,
        body: `${m.primaryBottleneck?.name} is at ${pct(m.primaryBottleneck?.load)} of capacity, so ${fmt(m.infraDroppedRPS)} req/s are being dropped by the infrastructure itself. These are not 429s. Nobody decided to throttle them, the machines simply ran out.`,
        action: 'Add capacity to that tier with the steppers, or pull traffic down until it fits.',
      };
    } else if (m.systemMaxUtilization > 0.7) {
      v = {
        tone: 'warning', icon: 'pulse',
        title: `${m.primaryBottleneck?.name || 'A tier'} is filling up`,
        body: `The busiest tier is ${pct(m.systemMaxUtilization)} full. Queueing has begun, which is why your p99 is ${m.p99Latency}ms against an average of just ${m.avgLatency}ms. The tail always goes first.`,
        action: 'Scale it now, before it tips over. Or push traffic higher and watch exactly where it breaks.',
      };
    } else {
      v = {
        tone: 'healthy', icon: 'checkCircle',
        title: 'Everything is holding',
        body: `The limiter is enforcing ${this.state.limitPerUser} req/s per user exactly as promised. ${fmt(m.allowedRPS)} req/s are getting through${m.rejectedRPS > 0 ? ` and ${fmt(m.rejectedRPS)} req/s are being throttled` : ' and nobody is being throttled'}, with nothing leaking past the limit.`,
        action: 'Now break it: drag traffic up, or switch "Where counters live" to local memory and watch the limit stop holding.',
      };
    }

    card.className = `rl-verdict-card ${v.tone}`;
    if (icon) icon.innerHTML = RL_ICONS[v.icon] || '';
    title.textContent = v.title;
    body.textContent = v.body;
    action.textContent = v.action;
  }

  /* ────────────────────────────────────────────────────────
     GRAPH
     ──────────────────────────────────────────────────────── */
  _pushGraphPoint(m) {
    this.graphHistory.push({
      allowed: m.allowedRPS,
      rejected: m.rejectedRPS,
      offered: m.offeredRPS,
      latency: m.avgLatency,
      maxUtil: m.systemMaxUtilization
    });
    if (this.graphHistory.length > 60) this.graphHistory.shift();
  }

  _resizeGraph() {
    if (!this.graphCanvas) return;
    const wrap = this.graphCanvas.parentElement;
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight || 180;
    this.graphCanvas.width = w * dpr;
    this.graphCanvas.height = h * dpr;
    this.graphCanvas.style.width = w + 'px';
    this.graphCanvas.style.height = h + 'px';
    this.graphCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._renderGraph();
  }

  _renderGraph() {
    const ctx = this.graphCtx;
    const canvas = this.graphCanvas;
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    const data = this.graphHistory;
    const empty = $('rl-graph-empty');
    if (data.length < 2) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    const pad = { top: 10, right: 2, bottom: 6, left: 2 };
    const plotH = h - pad.top - pad.bottom;
    const plotW = w - pad.left - pad.right;
    // 15% headroom so a flat "allowed == offered" line reads as a line, not a slab
    const maxOff = Math.max(...data.map(d => d.offered), 1000) * 1.15;
    const n = data.length;
    const dx = plotW / (n - 1);
    const yOf = v => pad.top + plotH - (v / maxOff) * plotH;
    const xOf = i => pad.left + i * dx;

    /* Horizontal guides give the eye a baseline to read the split against */
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.07)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = pad.top + (plotH / 4) * g;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    /* Smooth curve through the points, no jagged polylines */
    const curve = (key) => {
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(data[0][key]));
      for (let i = 0; i < n - 1; i++) {
        const cx = (xOf(i) + xOf(i + 1)) / 2;
        ctx.bezierCurveTo(cx, yOf(data[i][key]), cx, yOf(data[i + 1][key]), xOf(i + 1), yOf(data[i + 1][key]));
      }
    };

    // Allowed: filled gradient area
    const grad = ctx.createLinearGradient(0, pad.top, 0, h);
    grad.addColorStop(0, 'rgba(52, 211, 153, 0.34)');
    grad.addColorStop(1, 'rgba(52, 211, 153, 0.02)');
    curve('allowed');
    ctx.lineTo(xOf(n - 1), pad.top + plotH);
    ctx.lineTo(xOf(0), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    curve('allowed');
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Offered: dashed reference, the gap to allowed IS the throttling
    ctx.setLineDash([5, 4]);
    curve('offered');
    ctx.strokeStyle = isLight ? 'rgba(71,85,105,0.55)' : 'rgba(148,163,184,0.5)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.setLineDash([]);

    // Rejected
    curve('rejected');
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // Leading dot on allowed, so "now" is obvious
    const lastX = xOf(n - 1), lastY = yOf(data[n - 1].allowed);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#34d399';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.18)';
    ctx.fill();
  }

  /* ────────────────────────────────────────────────────────
     CHANGE LOG
     ──────────────────────────────────────────────────────── */
  _addChangeLog(note, m) {
    this.changeLog.push({
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      note,
      allowed: m.allowedRPS,
      rejected: m.rejectedRPS,
      latency: m.avgLatency,
      bottleneck: m.primaryBottleneck?.name || 'none'
    });
    this._renderChangeLog();
  }

  _renderChangeLog() {
    const timeline = $('rl-history-timeline');
    const count = $('rl-history-count');
    if (!timeline) return;
    if (count) count.textContent = this.changeLog.length;

    timeline.innerHTML = this.changeLog.slice().reverse().slice(0, 30).map(e => `
      <div class="history-timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-action">${e.note}</span>
            <span class="timeline-time">${e.time}</span>
          </div>
          <div class="timeline-stats">
            <span>allowed: ${fmt(e.allowed)}/s</span>
            <span>rejected: ${fmt(e.rejected)}/s</span>
            <span>latency: ${e.latency}ms</span>
            <span>bottleneck: ${e.bottleneck}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  /* ────────────────────────────────────────────────────────
     CHAOS HANDLER
     ──────────────────────────────────────────────────────── */
  _handleChaosUpdate(update) {
    if (update.failures) {
      this.state.failures = { ...this.state.failures, ...update.failures };
    }
    if (update.failPolicy) {
      this.state.failPolicy = update.failPolicy;
    }
    this.updateSimulation(false, 'Chaos Lab Update');
  }

  /* ────────────────────────────────────────────────────────
     CHALLENGE HANDLERS
     ──────────────────────────────────────────────────────── */
  _applyChallengeState(newState) {
    this.state = JSON.parse(JSON.stringify(newState));
    this.model.resetState(this.state.bucketCapacity);
    this._syncControlsToState();
    this.updateSimulation(false, 'Challenge Started');
  }

  _applyChallengeAction(action, callback) {
    const prevMetrics = { ...this.metrics };
    this.state = action.apply(this.state);
    this._syncControlsToState();
    this.updateSimulation(false, `Challenge Action: ${action.label}`);
    callback(prevMetrics, this.metrics);
  }

  /* ────────────────────────────────────────────────────────
     ASSUMPTIONS MODAL
     ──────────────────────────────────────────────────────── */
  _openAssumptions() {
    let existing = $('rl-assumptions-modal');
    if (existing) { existing.remove(); return; }

    const c = this.model.cfg;
    const modal = document.createElement('div');
    modal.id = 'rl-assumptions-modal';
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
      <div class="modal-shell">
        <div class="modal-header">
          <h3>⚙ Rate Limiter Assumptions</h3>
          <button class="modal-close" id="rl-asm-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="asm-grid">
            <label>Gateway Capacity (req/s)<input type="number" id="rl-asm-gw-cap" value="${c.gatewayCapacity}"></label>
            <label>RL Node Capacity (checks/s)<input type="number" id="rl-asm-rl-cap" value="${c.rateLimiterCapacity}"></label>
            <label>Redis Shard Capacity (ops/s)<input type="number" id="rl-asm-shard-cap" value="${c.redisShardCapacity}"></label>
            <label>Downstream Capacity (req/s)<input type="number" id="rl-asm-ds-cap" value="${c.downstreamCapacity}"></label>
            <label>Gateway Latency (ms)<input type="number" step="0.1" id="rl-asm-gw-lat" value="${c.gatewayLatency}"></label>
            <label>Local Memory Check (ms)<input type="number" step="0.1" id="rl-asm-local-lat" value="${c.localMemoryLatency}"></label>
            <label>Redis Net Latency (ms)<input type="number" step="0.1" id="rl-asm-redis-lat" value="${c.redisNetLatency}"></label>
            <label>Redis Exec (ms)<input type="number" step="0.1" id="rl-asm-redis-exec" value="${c.redisExecLatency}"></label>
            <label>Downstream Latency (ms)<input type="number" step="0.1" id="rl-asm-ds-lat" value="${c.downstreamLatency}"></label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" id="rl-asm-save">Save & Recalculate</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    $('rl-asm-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    $('rl-asm-save').addEventListener('click', () => {
      this.model.updateAssumptions({
        gatewayCapacity: parseInt($('rl-asm-gw-cap').value) || c.gatewayCapacity,
        rateLimiterCapacity: parseInt($('rl-asm-rl-cap').value) || c.rateLimiterCapacity,
        redisShardCapacity: parseInt($('rl-asm-shard-cap').value) || c.redisShardCapacity,
        downstreamCapacity: parseInt($('rl-asm-ds-cap').value) || c.downstreamCapacity,
        gatewayLatency: parseFloat($('rl-asm-gw-lat').value) || c.gatewayLatency,
        localMemoryLatency: parseFloat($('rl-asm-local-lat').value) || c.localMemoryLatency,
        redisNetLatency: parseFloat($('rl-asm-redis-lat').value) || c.redisNetLatency,
        redisExecLatency: parseFloat($('rl-asm-redis-exec').value) || c.redisExecLatency,
        downstreamLatency: parseFloat($('rl-asm-ds-lat').value) || c.downstreamLatency,
      });
      this.updateSimulation(false, 'Assumptions Updated');
      modal.remove();
    });
  }

  /* ── Destroy (cleanup) ── */
  destroy() {
    // Nothing persistent to tear down in vanilla JS
  }
}
