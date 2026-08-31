/**
 * Application Controller: Production Edition
 * Connects Model, Tracer, Bottleneck Engine, Chaos Lab, Challenges, Graph, and UI.
 */

import { SimulationModel } from './model.js';
import { DEFAULT_CONFIG, SCENARIO_PRESETS } from './config.js';
import { RequestTracer } from './tracer.js';
import { BottleneckEngine } from './bottleneck.js';
import { ChallengeModeManager } from './challenges.js';
import { ChaosLabManager } from './chaos.js';
import { TrafficGraph } from './graph.js';

class ApplicationController {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.state = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.model = new SimulationModel(this.config);
    this.bottleneckEngine = new BottleneckEngine();

    this.tracer = null;
    this.graph = null;
    this.challengeManager = null;
    this.chaosManager = null;

    this.activeMode = 'how-it-works';
    this.prevMetrics = null;
    this.prevState = null;

    // Toast state
    this.currentToastTimer = null;

    // History & Threshold Tracking
    this.eventHistory = [];
    this.lastUtilizationBracket = 0;
    this.lastBottleneckName = 'None';
  }

  init() {
    this.cacheDom();
    this.initModules();
    this.attachEventListeners();
    this.updateSimulation(true);
    this.updateRedirectExplanation();
  }

  cacheDom() {
    // Mode Buttons & Views
    this.modeButtons = document.querySelectorAll('.nav-tab-btn');
    this.modeViews = document.querySelectorAll('.app-mode-view');

    // Controls
    this.trafficSlider = document.getElementById('slider-traffic');
    this.readRatioSlider = document.getElementById('slider-read-ratio');
    this.apiServersSlider = document.getElementById('slider-api-servers');
    this.redisToggle = document.getElementById('toggle-redis');
    this.hitRateSlider = document.getElementById('slider-hit-rate');
    this.replicasSlider = document.getElementById('slider-replicas');
    this.indexToggle = document.getElementById('toggle-db-index');
    this.redirectRadios = document.querySelectorAll('input[name="redirect_mode"]');
    this.redirectExplanationEl = document.getElementById('redirect-explanation-text');
    this.presetButtons = document.querySelectorAll('.btn-preset');

    // Value Labels
    this.trafficValueLabel = document.getElementById('val-traffic');
    this.readRatioValueLabel = document.getElementById('val-read-ratio');
    this.apiServersValueLabel = document.getElementById('val-api-servers');
    this.hitRateValueLabel = document.getElementById('val-hit-rate');
    this.replicasValueLabel = document.getElementById('val-replicas');

    // Panels
    this.systemStatePanel = document.getElementById('system-state-panel');
    this.metricsGrid = document.getElementById('metrics-grid');
    this.historyTimelineEl = document.getElementById('history-timeline');
    this.historyCountEl = document.getElementById('history-count');
    this.btnClearHistory = document.getElementById('btn-clear-history');

    // Trace Containers
    this.tracePipelineEl = document.getElementById('trace-pipeline-container');
    this.hopInspectorEl = document.getElementById('hop-inspector-container');
    this.dbTableEl = document.getElementById('db-table-container');
    this.dbRecordCount = document.getElementById('db-record-count');
    this.dbTableDisclosure = document.getElementById('db-table-disclosure');

    // Canvas
    this.graphCanvas = document.getElementById('traffic-graph-canvas');

    // ⚡ System Events Activity Feed & Global Alert Bar
    this.systemEventsList = document.getElementById('events-stream-list');
    this.globalAlertBar = document.getElementById('global-critical-alert-bar');
    this.alertBarIcon = document.getElementById('alert-bar-icon');
    this.alertBarTitle = document.getElementById('alert-bar-title');
    this.alertBarSub = document.getElementById('alert-bar-sub');
    this.btnAlertBarView = document.getElementById('btn-alert-bar-view');
    this.btnJumpHistory = document.getElementById('btn-jump-history');
    this.historyFilterChips = document.querySelectorAll('.history-filter-chip');

    // Scale Tab Active Chaos Banner
    this.scaleChaosBanner = document.getElementById('scale-chaos-banner');
    this.scaleChaosBannerText = document.getElementById('scale-chaos-banner-text');
    this.btnGotoChaos = document.getElementById('btn-goto-chaos');

    // Reference Elements
    this.trafficHeadlineVal = document.getElementById('val-traffic-display');
    this.apiCountVal = document.getElementById('val-api-count');
    this.replicaCountVal = document.getElementById('val-replica-count');
    this.btnAddCache = document.getElementById('btn-toggle-redis');
    this.btnCacheText = document.getElementById('btn-cache-text');
    this.btnResetInfra = document.getElementById('btn-reset-infra');

    this.btnApiMinus = document.getElementById('btn-api-minus');
    this.btnApiPlus = document.getElementById('btn-api-plus');
    this.btnReplicaMinus = document.getElementById('btn-replica-minus');
    this.btnReplicaPlus = document.getElementById('btn-replica-plus');

    // Other Containers
    this.challengeContainer = document.getElementById('challenge-container');
    this.chaosContainer = document.getElementById('chaos-container');
    this.assumptionsModal = document.getElementById('assumptions-modal');
  }

  initModules() {
    // Request Tracer
    this.tracer = new RequestTracer(
      this.tracePipelineEl,
      this.hopInspectorEl,
      this.dbTableEl,
      (newRecord) => {
        if (this.dbRecordCount) {
          this.dbRecordCount.textContent = this.tracer.databaseRecords.length;
        }
      }
    );
    this.tracer.renderDatabaseTable();
    if (this.dbRecordCount) this.dbRecordCount.textContent = this.tracer.databaseRecords.length;

    // Traffic Graph with interactive scrub callback
    if (this.graphCanvas) {
      this.graph = new TrafficGraph(this.graphCanvas, this.model, (newTraffic) => {
        this.state.traffic = Math.round(newTraffic);
        const trafficSlider = document.getElementById('slider-traffic');
        if (trafficSlider) trafficSlider.value = this.state.traffic;
        this.updateSimulation(false);
      });
    }

    // Challenge Manager
    if (this.challengeContainer) {
      this.challengeManager = new ChallengeModeManager(
        this.challengeContainer,
        (newState) => {
          this.applyExternalState(newState, 'Challenge Scenario Loaded');
        },
        (action) => {
          const prevState = { ...this.state };
          const prevMetrics = { ...this.currentMetrics };
          let updatedState = action.apply(this.state);
          if (action.customEffect) {
            this.model.updateConfig(action.customEffect);
          }
          this.state = updatedState;
          this.syncControlsWithState();
          this.updateSimulation(false, `Challenge Action: ${action.label}`);
        }
      );
    }

    // Chaos Lab Manager
    if (this.chaosContainer) {
      this.chaosManager = new ChaosLabManager(
        this.chaosContainer,
        (update) => {
          if (update.failures) {
            this.state.failures = { ...this.state.failures, ...update.failures };
          }
          if (update.redisEnabled !== undefined) this.state.redisEnabled = update.redisEnabled;
          if (update.dbIndexed !== undefined) this.state.dbIndexed = update.dbIndexed;
          this.syncControlsWithState();
          this.updateSimulation(false, 'Chaos Lab Failure Injected');
        },
        this.model
      );
    }
  }

  attachEventListeners() {
    // Mode Switcher
    this.modeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.getAttribute('data-mode');
        this.switchMode(mode);
      });
    });

    // Preset Buttons
    this.presetButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const presetKey = e.currentTarget.getAttribute('data-preset');
        const preset = SCENARIO_PRESETS[presetKey];
        if (preset) {
          this.applyExternalState({
            traffic: preset.traffic,
            readRatio: preset.readRatio,
            apiServers: preset.apiServers,
            redisEnabled: preset.redisEnabled,
            cacheHitRate: preset.cacheHitRate,
            readReplicas: preset.readReplicas,
            dbIndexed: preset.dbIndexed,
            redirectType: preset.redirectType,
            failures: { ...(preset.failures || DEFAULT_CONFIG.failures) }
          }, `Preset Loaded: ${preset.name}`);

          this.presetButtons.forEach(b => b.classList.remove('preset-active'));
          btn.classList.add('preset-active');
        }
      });
    });

    // Traffic Slider
    if (this.trafficSlider) {
      this.trafficSlider.addEventListener('input', (e) => {
        this.state.traffic = parseInt(e.target.value, 10);
        this.updateSimulation();
      });
    }

    // Steppers & Action Buttons
    if (this.btnApiMinus) {
      this.btnApiMinus.addEventListener('click', () => {
        this.state.apiServers = Math.max(1, this.state.apiServers - 1);
        this.syncControlsWithState();
        this.updateSimulation(false, `API servers reduced to ${this.state.apiServers}`);
      });
    }
    if (this.btnApiPlus) {
      this.btnApiPlus.addEventListener('click', () => {
        this.state.apiServers = Math.min(25, this.state.apiServers + 1);
        this.syncControlsWithState();
        this.updateSimulation(false, `API servers increased to ${this.state.apiServers}`);
      });
    }

    if (this.btnReplicaMinus) {
      this.btnReplicaMinus.addEventListener('click', () => {
        this.state.readReplicas = Math.max(0, this.state.readReplicas - 1);
        this.syncControlsWithState();
        this.updateSimulation(false, `Read replicas reduced to ${this.state.readReplicas}`);
      });
    }
    if (this.btnReplicaPlus) {
      this.btnReplicaPlus.addEventListener('click', () => {
        this.state.readReplicas = Math.min(8, this.state.readReplicas + 1);
        this.syncControlsWithState();
        this.updateSimulation(false, `Read replicas increased to ${this.state.readReplicas}`);
      });
    }

    if (this.btnAddCache) {
      this.btnAddCache.addEventListener('click', () => {
        this.state.redisEnabled = !this.state.redisEnabled;
        this.state.failures.redisDown = !this.state.redisEnabled;
        this.syncControlsWithState();
        this.updateSimulation(false, `Redis Cache ${this.state.redisEnabled ? 'Enabled' : 'Disabled'}`);
      });
    }

    if (this.btnResetInfra) {
      this.btnResetInfra.addEventListener('click', () => {
        this.state = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        if (this.chaosManager) {
          this.chaosManager.failures = {
            redisDown: false,
            oneApiNodeDead: false,
            oneReplicaDead: false,
            dbDown: false,
            dbIndexDropped: false,
            extraLatencyMs: 0
          };
          this.chaosManager.updateContext(this.state, null, this.model);
        }
        this.syncControlsWithState();
        this.updateSimulation(false, 'System reset to startup baseline (1.0k req/s, 1 server, 0 replicas)');
        if (this.graph) {
          this.graph.updateState(this.state);
        }
      });
    }

    // Advanced Tunables
    if (this.readRatioSlider) {
      this.readRatioSlider.addEventListener('input', (e) => {
        this.state.readRatio = parseInt(e.target.value, 10) / 100;
        this.updateSimulation(false, `Read/Write Split set to ${Math.round(this.state.readRatio * 100)}% Reads`);
      });
    }

    if (this.hitRateSlider) {
      this.hitRateSlider.addEventListener('input', (e) => {
        this.state.cacheHitRate = parseInt(e.target.value, 10) / 100;
        this.updateSimulation(false, `Cache hit rate set to ${Math.round(this.state.cacheHitRate * 100)}%`);
      });
    }

    if (this.indexToggle) {
      this.indexToggle.addEventListener('change', (e) => {
        this.state.dbIndexed = e.target.checked;
        this.updateSimulation(false, `Database B-Tree index ${e.target.checked ? 'Enabled' : 'Dropped'}`);
      });
    }

    // Clear History Button
    if (this.btnClearHistory) {
      this.btnClearHistory.addEventListener('click', (e) => {
        e.stopPropagation();
        this.eventHistory = [];
        this.renderHistoryTimeline();
        this.renderSystemEventsFeed();
      });
    }

    // Jump to Full History Button
    if (this.btnJumpHistory) {
      this.btnJumpHistory.addEventListener('click', () => {
        const historyDetails = document.getElementById('ledger-details');
        if (historyDetails) {
          historyDetails.open = true;
          historyDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    // Global Critical Alert Bar View Details Button
    if (this.btnAlertBarView) {
      this.btnAlertBarView.addEventListener('click', () => {
        const bottleneckCard = document.querySelector('.arch-card.is-bottleneck') || document.getElementById('arch-node-db');
        if (bottleneckCard) {
          bottleneckCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          bottleneckCard.style.transition = 'transform 0.2s';
          bottleneckCard.style.transform = 'scale(1.03)';
          setTimeout(() => { bottleneckCard.style.transform = 'scale(1)'; }, 400);
        }
      });
    }

    // Timeline Filter Chips
    this.currentHistoryFilter = 'all';
    if (this.historyFilterChips) {
      this.historyFilterChips.forEach(chip => {
        chip.addEventListener('click', (e) => {
          this.historyFilterChips.forEach(c => c.classList.remove('active'));
          e.currentTarget.classList.add('active');
          this.currentHistoryFilter = e.currentTarget.getAttribute('data-filter');
          this.renderHistoryTimeline();
        });
      });
    }

    // Live Relative Timestamp Refresh Timer (every 5 seconds)
    setInterval(() => {
      this.renderSystemEventsFeed();
    }, 5000);

    // Jump from Scale Tab to Chaos Tab
    if (this.btnGotoChaos) {
      this.btnGotoChaos.addEventListener('click', () => {
        this.switchMode('chaos-lab');
      });
    }

    // Redirect Mode Radios
    this.redirectRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.state.redirectType = e.target.value;
        this.updateRedirectExplanation();
      });
    });

    // Shorten Form Submission
    const shortenForm = document.getElementById('form-shorten-url');
    if (shortenForm) {
      shortenForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const urlInput = document.getElementById('input-long-url');
        const strategySelect = document.getElementById('select-strategy');
        let longUrl = urlInput.value.trim();
        const strategy = strategySelect.value;
        if (longUrl) {
          // Security: Block unsafe protocols (javascript:, data:, vbscript:, etc.)
          const lowerUrl = longUrl.toLowerCase();
          if (lowerUrl.startsWith('javascript:') || lowerUrl.startsWith('data:') || lowerUrl.startsWith('vbscript:') || lowerUrl.startsWith('file:')) {
            alert('Invalid URL scheme. Only HTTP and HTTPS destination URLs are supported.');
            return;
          }

          // Auto-prefix if protocol is omitted
          if (!/^https?:\/\//i.test(longUrl)) {
            longUrl = 'https://' + longUrl;
            urlInput.value = longUrl;
          }

          this.tracer.runWriteTrace(longUrl, strategy, this.state.redirectType, this.state);

          setTimeout(() => {
            const traceSection = document.querySelector('.trace-section');
            if (traceSection) {
              traceSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 120);
        }
      });
    }

    // Quick Sample URL Chips
    document.querySelectorAll('.sample-url-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        const url = e.currentTarget.getAttribute('data-url');
        const input = document.getElementById('input-long-url');
        if (input) input.value = url;
      });
    });

    // Theme Toggle
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
        html.setAttribute('data-theme', nextTheme);
        const text = themeBtn.querySelector('.theme-toggle-text');
        if (text) text.textContent = nextTheme === 'light' ? 'Dark' : 'Light';
        window.dispatchEvent(new CustomEvent('themeChanged'));
      });
    }

    // Assumptions Modal Open / Close
    const btnOpenAssumptions = document.getElementById('btn-open-assumptions');
    const btnCloseAssumptions = document.getElementById('btn-close-assumptions');
    const btnSaveAssumptions = document.getElementById('btn-save-assumptions');

    if (btnOpenAssumptions && this.assumptionsModal) {
      btnOpenAssumptions.addEventListener('click', () => {
        this.populateAssumptionsForm();
        this.assumptionsModal.classList.remove('modal-hidden');
      });
    }

    if (btnCloseAssumptions && this.assumptionsModal) {
      btnCloseAssumptions.addEventListener('click', () => {
        this.assumptionsModal.classList.add('modal-hidden');
      });
    }

    if (btnSaveAssumptions && this.assumptionsModal) {
      btnSaveAssumptions.addEventListener('click', () => {
        this.saveAssumptionsForm();
        this.assumptionsModal.classList.add('modal-hidden');
      });
    }
  }

  switchMode(mode) {
    this.activeMode = mode;

    this.modeButtons.forEach(btn => {
      if (btn.getAttribute('data-mode') === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    this.modeViews.forEach(view => {
      if (view.getAttribute('id') === `view-${mode}`) {
        view.classList.remove('view-hidden');
      } else {
        view.classList.add('view-hidden');
      }
    });

    if (mode === 'scale-simulator' && this.graph) {
      setTimeout(() => this.graph.render(), 50);
    } else if (mode === 'challenges' && this.challengeManager) {
      this.challengeManager.render();
    } else if (mode === 'chaos-lab' && this.chaosManager) {
      this.chaosManager.updateContext(this.state, this.currentMetrics, this.model);
    }
  }

  applyExternalState(newState, reason = '') {
    this.state = { ...this.state, ...newState };
    this.syncControlsWithState();
    this.updateSimulation(false, reason);
  }

  syncControlsWithState() {
    if (this.trafficSlider) this.trafficSlider.value = this.state.traffic;
    if (this.readRatioSlider) this.readRatioSlider.value = Math.round(this.state.readRatio * 100);
    if (this.apiServersSlider) this.apiServersSlider.value = this.state.apiServers;
    if (this.redisToggle) this.redisToggle.checked = this.state.redisEnabled;
    if (this.hitRateSlider) this.hitRateSlider.value = Math.round(this.state.cacheHitRate * 100);
    if (this.replicasSlider) this.replicasSlider.value = this.state.readReplicas;
    if (this.indexToggle) this.indexToggle.checked = this.state.dbIndexed;

    if (this.apiCountVal) this.apiCountVal.textContent = this.state.apiServers;
    if (this.replicaCountVal) this.replicaCountVal.textContent = this.state.readReplicas;
    if (this.trafficHeadlineVal) {
      const tStr = this.state.traffic >= 1000 ? `${(this.state.traffic / 1000).toFixed(1)}k` : `${this.state.traffic}`;
      this.trafficHeadlineVal.innerHTML = `${tStr} <span class="unit">req/sec</span>`;
    }

    if (this.btnAddCache && this.btnCacheText) {
      if (this.state.redisEnabled) {
        this.btnAddCache.classList.add('active');
        this.btnCacheText.textContent = `Redis Active (${Math.round(this.state.cacheHitRate * 100)}% Hit Rate)`;
      } else {
        this.btnAddCache.classList.remove('active');
        this.btnCacheText.textContent = 'Add Cache (Redis)';
      }
    }

    if (this.readRatioValueLabel) {
      this.readRatioValueLabel.textContent = `${Math.round(this.state.readRatio * 100)}% Reads`;
    }
    if (this.hitRateValueLabel) {
      this.hitRateValueLabel.textContent = `${Math.round(this.state.cacheHitRate * 100)}%`;
    }

    this.redirectRadios.forEach(r => {
      r.checked = (r.value === this.state.redirectType);
    });
    this.updateRedirectExplanation();
  }

  updateSimulation(isInitial = false, changeReason = '') {
    // 1. Calculate deterministic metrics
    const metrics = this.model.calculate(this.state);
    this.currentMetrics = metrics;

    // 2. Evaluate System State & Bottleneck
    const health = this.bottleneckEngine.evaluate(metrics, this.state);
    this.renderSystemStatePanel(health, metrics);
    this.renderGlobalAlertBar(health, metrics);

    // 3. Render Reference Controls, 2x2 Metrics, and Arch Stack
    this.renderMetricCards(metrics);
    this.renderArchDiagram(metrics);
    this.renderDetailedBreakdown(metrics);

    // 4. Intelligent Event Notification & Activity Feed Recording
    if (!isInitial) {
      const util = metrics.systemMaxUtilization;
      const currentBracket = util >= 1.0 ? 3 : (util >= 0.8 ? 2 : (util >= 0.5 ? 1 : 0));
      const bottleneck = metrics.primaryBottleneck ? metrics.primaryBottleneck.name : 'None';

      let eventOccurred = false;
      let eventPayload = null;

      if (changeReason) {
        // User changed infrastructure / preset / setting
        eventOccurred = true;
        let category = 'config';
        let priority = 'info';
        let icon = '⚙️';
        let targetComponent = null;

        if (changeReason.toLowerCase().includes('api')) {
          category = 'scaling';
          targetComponent = 'api';
          icon = changeReason.includes('increased') || changeReason.includes('scaled') ? '↑' : '↓';
          priority = metrics.apiLoad >= 1.0 ? 'critical' : (metrics.apiLoad >= 0.75 ? 'warning' : 'info');
        } else if (changeReason.toLowerCase().includes('replica')) {
          category = 'scaling';
          targetComponent = 'db';
          icon = changeReason.includes('increased') ? '↑' : '↓';
          priority = metrics.dbReadLoad >= 1.0 ? 'critical' : (metrics.dbReadLoad >= 0.75 ? 'warning' : 'info');
        } else if (changeReason.toLowerCase().includes('redis') || changeReason.toLowerCase().includes('cache')) {
          category = 'cache';
          targetComponent = 'redis';
          icon = this.state.redisEnabled ? '✓' : '⚡';
          priority = this.state.redisEnabled ? 'success' : 'warning';
        }

        eventPayload = {
          title: changeReason,
          detail: `API: ${(metrics.apiLoad * 100).toFixed(0)}% load · DB: ${(Math.max(metrics.dbReadLoad, metrics.dbWriteLoad) * 100).toFixed(0)}% · Latency: ${Math.round(metrics.avgLatency)}ms`,
          category,
          priority,
          icon,
          targetComponent
        };
      } else if (currentBracket !== this.lastUtilizationBracket || (currentBracket >= 2 && bottleneck !== this.lastBottleneckName)) {
        // Meaningful utilization threshold crossed
        eventOccurred = true;
        if (currentBracket === 3) {
          eventPayload = {
            title: `${bottleneck} Bottleneck`,
            detail: `Queue building rapidly · ${(util * 100).toFixed(0)}% load · +${Math.round(metrics.droppedTraffic/1000)}k/s unserved`,
            category: 'bottleneck',
            priority: 'critical',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            targetComponent: bottleneck.toLowerCase().includes('api') ? 'api' : 'db'
          };
        } else if (currentBracket === 2) {
          eventPayload = {
            title: `High load on ${bottleneck}`,
            detail: `Capacity pressure crossed 80% (now ${(util * 100).toFixed(0)}% CPU)`,
            category: 'bottleneck',
            priority: 'warning',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            targetComponent: bottleneck.toLowerCase().includes('api') ? 'api' : 'db'
          };
        } else if (currentBracket === 1) {
          eventPayload = {
            title: `Traffic reached ${(metrics.traffic / 1000).toFixed(1)}k req/s`,
            detail: `API load at ${(metrics.apiLoad * 100).toFixed(0)}% · System operating normally`,
            category: 'scaling',
            priority: 'info',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
            targetComponent: 'api'
          };
        } else {
          eventPayload = {
            title: `All tiers within safe capacity`,
            detail: `Nominal throughput with low latency (${Math.round(metrics.avgLatency)}ms)`,
            category: 'scaling',
            priority: 'success',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
            targetComponent: null
          };
        }
      }

      if (eventOccurred && eventPayload) {
        this.recordActivityEvent(eventPayload);
        this.lastUtilizationBracket = currentBracket;
        this.lastBottleneckName = bottleneck;
      }
    }

    // 5. Active Chaos Banner (Inside Scale Tab)
    if (this.scaleChaosBanner) {
      const activeFailuresCount = Object.entries(this.state.failures || {}).filter(([k, v]) => Boolean(v)).length + (this.state.dbIndexed === false ? 1 : 0);
      if (activeFailuresCount > 0) {
        this.scaleChaosBanner.style.display = 'flex';
        if (this.scaleChaosBannerText) {
          this.scaleChaosBannerText.textContent = `${activeFailuresCount} Active Outage${activeFailuresCount > 1 ? 's' : ''} Injected in Chaos Lab`;
        }
      } else {
        this.scaleChaosBanner.style.display = 'none';
      }
    }

    // 6. Sync Chaos Lab Console Twin & Impact
    if (this.chaosManager) {
      this.chaosManager.updateContext(this.state, metrics, this.model);
    }

    // 7. Update Graph
    if (this.graph) {
      this.graph.updateState(this.state);
    }

    this.prevMetrics = { ...metrics };
    this.prevState = JSON.parse(JSON.stringify(this.state));
  }

  renderSystemStatePanel(health, metrics) {
    if (!this.systemStatePanel) return;

    if (health.status === 'HEALTHY') {
      this.systemStatePanel.className = 'system-state-box hidden';
      this.systemStatePanel.innerHTML = '';
      return;
    }

    this.systemStatePanel.className = `system-state-box state-${health.statusColor} compact`;
    this.systemStatePanel.innerHTML = `
      <div class="state-summary-row">
        <div class="state-summary-left">
          <span class="status-icon">${health.statusIcon}</span>
          <span class="status-title">${health.title}</span>
          <span class="bottleneck-tag">${health.bottleneckComponent}</span>
        </div>
        <div class="state-summary-right">
          <span class="quick-stat-item"><strong>${metrics.throughput.toLocaleString()}</strong>/${metrics.traffic.toLocaleString()} req/s</span>
          <span class="quick-stat-item"><strong>${Math.round(metrics.avgLatency)}ms</strong></span>
        </div>
      </div>
    `;
  }

  renderArchDiagram(metrics) {
    const maxDbLoad = Math.max(metrics.dbReadLoad || 0, metrics.dbWriteLoad || 0);

    // 1. Client / Browser Node
    const clientOffered = document.getElementById('arch-client-offered');
    const clientReads = document.getElementById('arch-client-reads');
    if (clientOffered) {
      clientOffered.textContent = metrics.traffic >= 1000 ? `${(metrics.traffic / 1000).toFixed(0) === (metrics.traffic / 1000).toFixed(1) ? (metrics.traffic / 1000).toFixed(0) : (metrics.traffic / 1000).toFixed(1)}k req/s` : `${metrics.traffic} req/s`;
      if (metrics.traffic >= 100000) clientOffered.textContent = '100k req/s';
    }
    if (clientReads) {
      clientReads.textContent = `${Math.round(this.state.readRatio * 100)}%`;
    }

    // 2. Load Balancer Node (Only shown when apiServers > 1)
    const lbNode = document.getElementById('arch-node-lb');
    const lbConnector = document.getElementById('flow-conn-lb-api');
    const lbServers = document.getElementById('arch-lb-servers');

    if (lbNode && lbConnector) {
      if (metrics.activeApiServers > 1) {
        lbNode.style.display = 'flex';
        lbConnector.style.display = 'flex';
        if (lbServers) lbServers.textContent = metrics.activeApiServers;
      } else {
        lbNode.style.display = 'none';
        lbConnector.style.display = 'none';
      }
    }

    // 3. API Server Node
    const apiBadge = document.getElementById('arch-api-badge');
    const apiBottleneckBadge = document.getElementById('arch-api-bottleneck-badge');
    const apiFill = document.getElementById('arch-api-fill');
    const apiLoadPct = document.getElementById('arch-api-load-pct');
    const apiLatency = document.getElementById('arch-api-latency');
    const apiCapacity = document.getElementById('arch-api-capacity');
    const apiNode = document.getElementById('arch-node-api');

    const isApiBottleneck = (metrics.primaryBottleneck?.name === 'API Cluster' && metrics.apiLoad >= 1.0);

    if (apiBadge) {
      apiBadge.textContent = `x${metrics.activeApiServers}`;
      apiBadge.style.display = (metrics.activeApiServers > 1 && !isApiBottleneck) ? 'inline-block' : 'none';
    }
    if (apiBottleneckBadge) {
      apiBottleneckBadge.style.display = isApiBottleneck ? 'inline-block' : 'none';
    }

    const apiPctVal = Math.round(metrics.apiLoad * 100);
    if (apiLoadPct) {
      apiLoadPct.textContent = metrics.apiLoad > 1.0 ? `${apiPctVal}% · OVER` : `${apiPctVal}%`;
      apiLoadPct.style.color = metrics.apiLoad >= 1.0 ? '#f43f5e' : (metrics.apiLoad >= 0.75 ? '#fb923c' : '#94a3b8');
    }

    if (apiLatency) {
      const lat = metrics.apiLoad >= 1.0 ? 200 : Math.max(1, Math.round(metrics.avgLatency * 0.08));
      apiLatency.textContent = `${lat}ms`;
      apiLatency.className = metrics.apiLoad >= 1.0 ? 'highlight-red' : 'highlight-green';
    }
    if (apiCapacity) apiCapacity.textContent = `${Math.round(metrics.totalApiCapacity / 1000)}k/s`;

    if (apiFill) {
      const fillW = Math.min(100, apiPctVal);
      apiFill.style.width = `${fillW}%`;
      apiFill.className = `arch-bar-fill ${ metrics.apiLoad >= 1.0 ? 'fill-danger' : (metrics.apiLoad >= 0.75 ? 'fill-warning' : '') }`;
    }
    if (apiNode) {
      apiNode.dataset.status = metrics.apiLoad >= 1.0 ? 'danger' : (metrics.apiLoad >= 0.75 ? 'warning' : 'healthy');
      if (isApiBottleneck) {
        apiNode.classList.add('is-bottleneck');
      } else {
        apiNode.classList.remove('is-bottleneck');
      }
    }

    // 4. Redis Cache Node (Show if enabled)
    const redisNode = document.getElementById('arch-node-redis');
    const redisConnector = document.getElementById('arch-redis-connector-top');
    const redisHitRate = document.getElementById('arch-redis-hitrate');
    const redisBadge = document.getElementById('arch-redis-badge');
    const redisSub = document.getElementById('arch-redis-sub');

    if (redisNode && redisConnector) {
      if (this.state.redisEnabled) {
        redisNode.style.display = 'flex';
        redisConnector.style.display = 'flex';
        if (redisHitRate) redisHitRate.textContent = `${Math.round(metrics.hitRate * 100)}%`;
        if (redisBadge) redisBadge.textContent = 'Active';
        if (redisSub) redisSub.textContent = `absorbs ${Math.round(metrics.hitRate * 100)}% read traffic`;
      } else {
        redisNode.style.display = 'none';
        redisConnector.style.display = 'none';
      }
    }

    // 5. Database Node
    const dbBadge = document.getElementById('arch-db-badge');
    const dbBottleneckBadge = document.getElementById('arch-db-bottleneck-badge');
    const dbFill = document.getElementById('arch-db-fill');
    const dbLoadPct = document.getElementById('arch-db-load-pct');
    const dbReads = document.getElementById('arch-db-reads');
    const dbLatency = document.getElementById('arch-db-latency');
    const dbCapacity = document.getElementById('arch-db-capacity');
    const dbNode = document.getElementById('arch-node-db');
    const dbOverloadAlert = document.getElementById('arch-db-overload-alert');
    const dbOverloadSub = document.getElementById('arch-db-overload-sub');

    const isDbBottleneck = (metrics.isDbDown || (metrics.primaryBottleneck?.name?.includes('Database') && maxDbLoad >= 1.0));

    if (dbBadge) {
      dbBadge.textContent = `1 + ${metrics.activeReplicas} replicas`;
      dbBadge.style.display = (metrics.activeReplicas > 0 && !isDbBottleneck) ? 'inline-block' : 'none';
    }
    if (dbBottleneckBadge) {
      dbBottleneckBadge.style.display = isDbBottleneck ? 'inline-block' : 'none';
    }

    const dbPctVal = Math.round(maxDbLoad * 100);
    if (dbLoadPct) {
      dbLoadPct.textContent = maxDbLoad > 1.0 ? `${dbPctVal}% · OVER` : `${dbPctVal}%`;
      dbLoadPct.style.color = maxDbLoad >= 1.0 ? '#f43f5e' : (maxDbLoad >= 0.75 ? '#fb923c' : '#94a3b8');
    }

    if (dbReads) {
      dbReads.textContent = metrics.totalReads >= 1000 ? `${(metrics.totalReads / 1000).toFixed(0)}k/s` : `${metrics.totalReads}/s`;
      if (metrics.totalReads >= 1000 && (metrics.totalReads % 1000 !== 0)) {
        dbReads.textContent = `${(metrics.totalReads / 1000).toFixed(1)}k/s`;
      }
    }

    if (dbLatency) {
      if (metrics.avgLatency >= 1000) {
        dbLatency.textContent = `${(metrics.avgLatency / 1000).toFixed(2)}s`;
        dbLatency.className = 'highlight-red';
      } else {
        dbLatency.textContent = `${Math.round(metrics.avgLatency)}ms`;
        dbLatency.className = maxDbLoad >= 0.75 ? 'highlight-amber' : 'highlight-green';
      }
    }

    if (dbCapacity) dbCapacity.textContent = `${Math.round(metrics.totalReadCap / 1000)}k/s`;

    if (dbFill) {
      const fillW = Math.min(100, dbPctVal);
      dbFill.style.width = `${fillW}%`;
      dbFill.className = `arch-bar-fill ${ maxDbLoad >= 1.0 ? 'fill-danger' : (maxDbLoad >= 0.75 ? 'fill-warning' : '') }`;
    }
    if (dbNode) {
      dbNode.dataset.status = isDbBottleneck ? 'danger' : (maxDbLoad >= 0.75 ? 'warning' : 'healthy');
      if (isDbBottleneck) {
        dbNode.classList.add('is-bottleneck');
      } else {
        dbNode.classList.remove('is-bottleneck');
      }
    }

    // Requests piling up alert card under Database
    if (dbOverloadAlert) {
      if (maxDbLoad >= 1.0 && metrics.traffic >= 10000) {
        dbOverloadAlert.style.display = 'flex';
        const unserved = Math.max(0, metrics.traffic - metrics.throughput);
        const queuedEst = Math.round(unserved * 3.6);
        if (dbOverloadSub) {
          dbOverloadSub.textContent = `~${queuedEst >= 1000 ? (queuedEst/1000).toFixed(0)+'k' : queuedEst} requests queued & waiting · +${(unserved/1000).toFixed(0)}k/s and climbing`;
        }
      } else {
        dbOverloadAlert.style.display = 'none';
      }
    }

    // 6. Modern Progressive Data-Flow State & Variable Path Styling
    const flowClientLb = document.getElementById('flow-conn-client-lb');
    const flowLbApi = document.getElementById('flow-conn-lb-api');
    const flowApiRedis = document.getElementById('arch-redis-connector-top');
    const flowApiDb = document.getElementById('flow-conn-api-db');

    const congestionApi = document.getElementById('congestion-api');
    const congestionDb = document.getElementById('congestion-db');

    const getFlowState = (load) => {
      if (load >= 1.0) return 'critical';
      if (load >= 0.75) return 'pressure';
      if (load >= 0.40) return 'moderate';
      return 'healthy';
    };

    if (flowClientLb) {
      const tNorm = metrics.traffic / 100000;
      flowClientLb.dataset.flow = getFlowState(tNorm);
    }

    if (flowLbApi) {
      flowLbApi.dataset.flow = getFlowState(metrics.apiLoad);
      if (congestionApi) {
        congestionApi.style.display = (metrics.apiLoad >= 0.85 || isApiBottleneck) ? 'block' : 'none';
      }
    }

    if (flowApiRedis) {
      flowApiRedis.dataset.flow = getFlowState(metrics.redisLoad || 0);
    }

    if (flowApiDb) {
      flowApiDb.dataset.flow = isDbBottleneck ? 'critical' : getFlowState(maxDbLoad);
      if (congestionDb) {
        congestionDb.style.display = (maxDbLoad >= 0.85 || isDbBottleneck) ? 'block' : 'none';
      }
    }
  }

  renderMetricCards(m) {
    const maxDbLoad = Math.max(m.dbReadLoad || 0, m.dbWriteLoad || 0);

    // 1. Right Column Traffic & Steppers Display
    if (this.trafficHeadlineVal) {
      const tStr = m.traffic >= 1000 ? `${(m.traffic / 1000).toFixed(0) === (m.traffic / 1000).toFixed(1) ? (m.traffic / 1000).toFixed(0) : (m.traffic / 1000).toFixed(1)}k` : `${m.traffic}`;
      if (m.traffic >= 100000) this.trafficHeadlineVal.innerHTML = `100k <span class="unit">req/sec</span>`;
      else this.trafficHeadlineVal.innerHTML = `${tStr} <span class="unit">req/sec</span>`;
    }
    if (this.apiCountVal) this.apiCountVal.textContent = m.activeApiServers;
    if (this.replicaCountVal) this.replicaCountVal.textContent = m.activeReplicas;

    // Cache button state
    if (this.btnAddCache && this.btnCacheText) {
      if (this.state.redisEnabled) {
        this.btnAddCache.classList.add('active');
        this.btnCacheText.textContent = `Redis Active (${Math.round(m.hitRate * 100)}% Hit Rate)`;
      } else {
        this.btnAddCache.classList.remove('active');
        this.btnCacheText.textContent = 'Add Cache (Redis)';
      }
    }

    // 2. 2x2 Metric Tiles
    const metricLatency = document.getElementById('metric-avg-latency');
    const metricThroughput = document.getElementById('metric-throughput');
    const metricThroughputSub = document.getElementById('metric-throughput-sub');
    const metricDbLoad = document.getElementById('metric-db-load');
    const metricDbLoadSub = document.getElementById('metric-db-load-sub');
    const metricCacheHit = document.getElementById('metric-cache-hit');
    const metricCacheSub = document.getElementById('metric-cache-sub');

    if (metricLatency) {
      if (m.avgLatency >= 1000) {
        metricLatency.textContent = `${(m.avgLatency / 1000).toFixed(2)}s`;
        metricLatency.style.color = '#f43f5e';
      } else {
        metricLatency.textContent = `${Math.round(m.avgLatency)}ms`;
        metricLatency.style.color = m.avgLatency >= 100 ? '#fb923c' : '#34d399';
      }
    }

    if (metricThroughput) {
      const tpStr = m.throughput >= 1000 ? `${(m.throughput / 1000).toFixed(0)}k/s` : `${m.throughput}/s`;
      metricThroughput.textContent = tpStr;
      metricThroughput.style.color = (m.throughput < m.traffic) ? '#f43f5e' : '#34d399';
    }
    if (metricThroughputSub) {
      if (m.throughput < m.traffic) {
        const offStr = m.traffic >= 1000 ? `${(m.traffic / 1000).toFixed(0)}k` : `${m.traffic}`;
        metricThroughputSub.textContent = `of ${offStr} offered`;
        metricThroughputSub.style.color = '#fda4af';
      } else {
        metricThroughputSub.textContent = 'all requests served';
        metricThroughputSub.style.color = '#64748b';
      }
    }

    if (metricDbLoad) {
      const dbStr = m.totalReads >= 1000 ? `${(m.totalReads / 1000).toFixed(0)}k/s` : `${m.totalReads}/s`;
      metricDbLoad.textContent = dbStr;
      metricDbLoad.style.color = maxDbLoad >= 1.0 ? '#f43f5e' : '#34d399';
    }
    if (metricDbLoadSub) {
      metricDbLoadSub.textContent = `${Math.round(maxDbLoad * 100)}% CPU`;
      metricDbLoadSub.style.color = maxDbLoad >= 1.0 ? '#fda4af' : '#64748b';
    }

    if (metricCacheHit) {
      metricCacheHit.textContent = m.isRedisActive ? `${Math.round(m.hitRate * 100)}%` : 'N/A';
    }
    if (metricCacheSub) {
      metricCacheSub.textContent = m.isRedisActive ? 'saves DB reads' : 'no cache yet';
    }

    // 3. Bottom Educational Lesson Card
    const lessonCard = document.getElementById('system-lesson-card');
    const lessonTitle = document.getElementById('lesson-title');
    const lessonBody = document.getElementById('lesson-body');
    const lessonAction = document.getElementById('lesson-action');

    if (lessonCard && lessonTitle && lessonBody && lessonAction) {
      if (maxDbLoad >= 1.0) {
        lessonCard.className = 'system-lesson-card danger';
        lessonTitle.textContent = '🔥 Database is melting down';
        const unservedStr = Math.round((m.traffic - m.throughput) / 1000);
        lessonBody.textContent = `The DB is past 100% CPU and ~${unservedStr}k req/s are piling up unserved. Remember the read path: every visit was a SELECT. Most of them are for the same popular links.`;
        lessonAction.textContent = '↳ Add Redis so repeat reads never reach the DB.';
      } else if (m.apiLoad >= 1.0) {
        lessonCard.className = 'system-lesson-card danger';
        lessonTitle.textContent = '🔥 API cluster is saturated';
        lessonBody.textContent = `The API cluster is past 100% CPU and cannot process the incoming HTTP connection rate.`;
        lessonAction.textContent = '↳ Scale API servers to distribute compute load.';
      } else if (this.state.redisEnabled) {
        lessonCard.className = 'system-lesson-card healthy';
        lessonTitle.textContent = `⚡ Redis is absorbing ${Math.round(m.hitRate * 100)}% of reads`;
        lessonBody.textContent = `Database load is drastically reduced because cached items are served directly from fast in-memory RAM in ~1ms.`;
        lessonAction.textContent = `↳ Drag traffic up toward 100k to see how far Redis can scale.`;
      } else {
        lessonCard.className = 'system-lesson-card healthy';
        lessonTitle.textContent = '🟢 All systems healthy';
        lessonBody.textContent = 'Lots of headroom. Drag traffic up toward 10k+ and watch the database CPU bar.';
        lessonAction.textContent = "↳ The DB breaks first: that is the lesson.";
      }
    }
  }

  /* 📊 Detailed Breakdown Render (Unified Metric Strip) */
  renderDetailedBreakdown(m) {
    if (!this.metricsGrid) return;

    const cards = [
      {
        id: 'api',
        title: 'API Cluster',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="13" rx="2" ry="2"/><line x1="6" x2="6.01" y1="7" y2="7"/><line x1="6" x2="6.01" y1="17" y2="17"/></svg>',
        currentVal: `${m.traffic.toLocaleString()} / ${m.totalApiCapacity.toLocaleString()} req/s`,
        percentage: Math.min(100, Math.round(m.apiLoad * 100)),
        loadClass: m.apiLoad >= 1.0 ? 'bar-danger' : (m.apiLoad >= 0.75 ? 'bar-warning' : ''),
        subtitle: `${m.activeApiServers} active server nodes`,
        math: m.mathBreakdowns.api
      },
      {
        id: 'redis',
        title: 'Redis Cache',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        currentVal: m.isRedisActive 
          ? `${m.cacheHits.toLocaleString()} hits / ${m.totalReads.toLocaleString()} reads`
          : `Offline / Disabled (0 hits)`,
        percentage: m.isRedisActive ? Math.round(m.hitRate * 100) : 0,
        loadClass: m.isRedisActive ? '' : 'bar-danger',
        subtitle: m.isRedisActive 
          ? `Hit Rate: ${(m.hitRate * 100).toFixed(0)}% (Absorbs ${(m.hitRate * 100).toFixed(0)}% reads)`
          : `100% of reads fall through to DB`,
        math: m.mathBreakdowns.redis
      },
      {
        id: 'dbWrites',
        title: 'DB Primary (Writes)',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>',
        currentVal: `${m.totalWrites.toLocaleString()} / ${m.primaryWriteCap.toLocaleString()} writes/s`,
        percentage: Math.min(100, Math.round(m.dbWriteLoad * 100)),
        loadClass: m.dbWriteLoad >= 1.0 ? 'bar-danger' : (m.dbWriteLoad >= 0.75 ? 'bar-warning' : ''),
        subtitle: `Master write capacity: ${m.primaryWriteCap.toLocaleString()}/s`,
        math: m.mathBreakdowns.dbWrites
      },
      {
        id: 'dbReads',
        title: 'DB Read Pool',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        currentVal: `${m.cacheMisses.toLocaleString()} / ${m.totalReadCap.toLocaleString()} reads/s`,
        percentage: Math.min(100, Math.round(m.dbReadLoad * 100)),
        loadClass: m.dbReadLoad >= 1.0 ? 'bar-danger' : (m.dbReadLoad >= 0.75 ? 'bar-warning' : ''),
        subtitle: `${m.activeReplicas} Replicas ${m.isDbIndexed ? '(Indexed B-Tree)' : '⚠️ (Unindexed Scan)'}`,
        math: m.mathBreakdowns.dbReads
      },
      {
        id: 'latency',
        title: 'End-to-End Latency',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        currentVal: `${Math.round(m.avgLatency)}ms avg latency`,
        percentage: Math.min(100, Math.round((m.avgLatency / 300) * 100)),
        loadClass: m.avgLatency > 150 ? 'bar-danger' : (m.avgLatency > 40 ? 'bar-warning' : ''),
        subtitle: `Throughput: ${m.throughput.toLocaleString()} req/s ${m.droppedTraffic > 0 ? `(${m.droppedTraffic.toLocaleString()} dropped)` : ''}`,
        math: m.mathBreakdowns.latency
      }
    ];

    let html = '';
    cards.forEach(c => {
      html += `
        <div class="metric-column" id="card-${c.id}">
          <div class="metric-column-header">
            <div class="metric-column-title">
              ${c.icon}
              <span>${c.title}</span>
            </div>
            <span class="metric-percentage ${c.loadClass}">${c.percentage}%</span>
          </div>
          <div class="metric-main-value">${c.currentVal}</div>
          <div class="metric-progress-bar">
            <div class="metric-progress-fill ${c.loadClass}" style="width: ${c.percentage}%"></div>
          </div>
          <div class="metric-sub">${c.subtitle}</div>

          <details class="metric-why-accordion">
            <summary class="why-toggle-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>Explain calculation</span>
            </summary>
            <div class="why-math-body">
              <div class="math-formula-tag">${c.math.summary}</div>
              <ol class="math-steps-list">
                ${c.math.steps.map(s => `<li>${s}</li>`).join('')}
              </ol>
            </div>
          </details>
        </div>
      `;
    });

    this.metricsGrid.innerHTML = html;
  }

  /* =====================================================
     ⚡ SYSTEM EVENTS & INTERACTIVE ACTIVITY STREAM
     ===================================================== */
  recordActivityEvent({ title, detail, category = 'config', priority = 'info', icon = '⚡', targetComponent = null }) {
    const event = {
      id: 'evt-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title,
      detail,
      category,
      priority,
      icon,
      targetComponent,
      timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    this.eventHistory.unshift(event);
    if (this.eventHistory.length > 50) {
      this.eventHistory.pop();
    }

    this.renderSystemEventsFeed();
    this.renderHistoryTimeline();
  }

  /* ⚡ Render Live System Events Feed (Right Rail) */
  renderSystemEventsFeed() {
    if (!this.systemEventsList) return;

    if (this.eventHistory.length === 0) {
      this.systemEventsList.innerHTML = `
        <div class="event-stream-row event-info">
          <div class="event-row-left">
            <span class="event-row-icon">🚀</span>
            <div class="event-row-meta">
              <span class="event-row-title">Simulator initialized</span>
              <span class="event-row-sub">Operating at baseline traffic</span>
            </div>
          </div>
          <span class="event-row-time">just now</span>
        </div>
      `;
      return;
    }

    const now = Date.now();
    const recentEvents = this.eventHistory.slice(0, 6);

    let html = '';
    recentEvents.forEach(evt => {
      const elapsedSec = Math.max(0, Math.floor((now - evt.timestamp) / 1000));
      let timeAgo = 'just now';
      if (elapsedSec >= 60) {
        timeAgo = `${Math.floor(elapsedSec / 60)}m ago`;
      } else if (elapsedSec >= 5) {
        timeAgo = `${elapsedSec}s ago`;
      }

      html += `
        <div class="event-stream-row event-${evt.priority}" data-target="${evt.targetComponent || ''}">
          <div class="event-row-left">
            <span class="event-row-icon">${evt.icon}</span>
            <div class="event-row-meta">
              <span class="event-row-title">${evt.title}</span>
              <span class="event-row-sub">${evt.detail}</span>
            </div>
          </div>
          <span class="event-row-time">${timeAgo}</span>
        </div>
      `;
    });

    this.systemEventsList.innerHTML = html;

    // Attach click-to-highlight on activity feed rows
    this.systemEventsList.querySelectorAll('.event-stream-row').forEach(row => {
      row.addEventListener('click', () => {
        const target = row.getAttribute('data-target');
        if (target) {
          this.highlightArchitectureNode(target);
        }
      });
    });
  }

  /* 🚨 Render Single Global Critical Alert Bar */
  renderGlobalAlertBar(health, metrics) {
    if (!this.globalAlertBar) return;

    const isCritical = (metrics.isDbDown || metrics.systemMaxUtilization >= 1.0);

    if (isCritical) {
      this.globalAlertBar.style.display = 'flex';
      const bottleneckName = metrics.isDbDown ? 'DATABASE DOWN' : `${metrics.primaryBottleneck?.name?.toUpperCase() || 'SYSTEM'} BOTTLENECK`;
      if (this.alertBarTitle) this.alertBarTitle.textContent = bottleneckName;
      if (this.alertBarSub) {
        const unserved = Math.max(0, metrics.traffic - metrics.throughput);
        this.alertBarSub.textContent = `Traffic exceeded capacity (${(metrics.traffic/1000).toFixed(0)}k req/s) · Queue growing rapidly (+${Math.round(unserved/1000)}k/s unserved)`;
      }
    } else {
      this.globalAlertBar.style.display = 'none';
    }
  }

  /* 📋 Render Full Interactive Timeline with Filters */
  renderHistoryTimeline() {
    if (!this.historyTimelineEl) return;

    if (this.historyCountEl) {
      this.historyCountEl.textContent = this.eventHistory.length;
    }

    const filter = this.currentHistoryFilter || 'all';
    const filtered = this.eventHistory.filter(evt => {
      if (filter === 'all') return true;
      if (filter === 'scaling' && evt.category === 'scaling') return true;
      if (filter === 'bottleneck' && evt.category === 'bottleneck') return true;
      if (filter === 'cache' && evt.category === 'cache') return true;
      return false;
    });

    if (filtered.length === 0) {
      this.historyTimelineEl.innerHTML = `<div class="history-empty">No events matching "${filter}" recorded yet.</div>`;
      return;
    }

    let html = '';
    filtered.forEach(item => {
      html += `
        <div class="timeline-event-item" data-target="${item.targetComponent || ''}">
          <div class="timeline-time-col">${item.timeFormatted}</div>
          <div class="timeline-dot dot-${item.priority}"></div>
          <div class="timeline-info">
            <div class="timeline-title">${item.title}</div>
            <div class="timeline-detail">${item.detail}</div>
          </div>
        </div>
      `;
    });

    this.historyTimelineEl.innerHTML = html;

    // Attach click-to-highlight on timeline items
    this.historyTimelineEl.querySelectorAll('.timeline-event-item').forEach(item => {
      item.addEventListener('click', () => {
        const target = item.getAttribute('data-target');
        if (target) {
          this.highlightArchitectureNode(target);
        }
      });
    });
  }

  /* Highlight corresponding architecture component */
  highlightArchitectureNode(target) {
    let nodeEl = null;
    if (target === 'api') nodeEl = document.getElementById('arch-node-api');
    else if (target === 'db') nodeEl = document.getElementById('arch-node-db');
    else if (target === 'redis') nodeEl = document.getElementById('arch-node-redis');
    else if (target === 'lb') nodeEl = document.getElementById('arch-node-lb');

    if (nodeEl) {
      nodeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nodeEl.style.transition = 'transform 0.2s, box-shadow 0.2s';
      nodeEl.style.transform = 'scale(1.04)';
      nodeEl.style.boxShadow = '0 0 28px rgba(56, 189, 248, 0.6)';
      setTimeout(() => {
        nodeEl.style.transform = 'scale(1)';
        nodeEl.style.boxShadow = '';
      }, 500);
    }
  }

  updateRedirectExplanation() {
    if (!this.redirectExplanationEl) return;
    if (this.state.redirectType === '301') {
      this.redirectExplanationEl.innerHTML = `
        <strong>301 Moved Permanently:</strong> Browser and intermediate proxies permanently cache the redirect. Subsequent visits do NOT hit our API or Database, drastically lowering server load. <em>Trade-off:</em> You cannot track individual click counts, geographic analytics, or revoke the link.
      `;
    } else {
      this.redirectExplanationEl.innerHTML = `
        <strong>302 Found (Temporary):</strong> Browser sends a fresh GET request to our server on every single click. <em>Advantage:</em> Allows real-time click tracking, rate limiting, and instant destination updates. <em>Trade-off:</em> Generates higher read query traffic.
      `;
    }
  }

  visitShortUrl(shortCode, redirectType) {
    this.switchMode('how-it-works');
    this.tracer.runReadTrace(shortCode, redirectType, this.state);
  }

  populateAssumptionsForm() {
    document.getElementById('input-asm-api-cap').value = this.config.apiNodeCapacity;
    document.getElementById('input-asm-redis-cap').value = this.config.redisCapacity;
    document.getElementById('input-asm-db-write-cap').value = this.config.dbPrimaryWriteCapacity;
    document.getElementById('input-asm-db-read-cap').value = this.config.dbReplicaReadCapacity;
    document.getElementById('input-asm-net-lat').value = this.config.baseNetworkLatency;
    document.getElementById('input-asm-db-lat').value = this.config.dbIndexedReadLatency;
  }

  saveAssumptionsForm() {
    this.config.apiNodeCapacity = parseInt(document.getElementById('input-asm-api-cap').value, 10) || 10000;
    this.config.redisCapacity = parseInt(document.getElementById('input-asm-redis-cap').value, 10) || 500000;
    this.config.dbPrimaryWriteCapacity = parseInt(document.getElementById('input-asm-db-write-cap').value, 10) || 10000;
    this.config.dbReplicaReadCapacity = parseInt(document.getElementById('input-asm-db-read-cap').value, 10) || 50000;
    this.config.baseNetworkLatency = parseFloat(document.getElementById('input-asm-net-lat').value) || 6;
    this.config.dbIndexedReadLatency = parseFloat(document.getElementById('input-asm-db-lat').value) || 12;

    this.model.updateConfig(this.config);
    this.updateSimulation(false, 'Simulation Assumptions Updated');
  }
}

// Instantiate and boot on DOM load
window.addEventListener('DOMContentLoaded', () => {
  const app = new ApplicationController();
  app.init();
});
