/**
 * Chaos & Failure Simulation Lab: SRE Incident Console
 * 
 * 2-Column Professional Architecture:
 * - Top: Compact Command Bar (Title, Active Badge, Reset Button)
 * - Left (~65%): Categorized Incident Library with 2-column inner card grid
 * - Right (~35%): Sticky Live System Impact Dashboard
 * - Bottom: Incident Timeline & System Consequences Log
 */

export class ChaosLabManager {
  constructor(containerEl, onStateChange, model = null) {
    this.containerEl = containerEl;
    this.onStateChange = onStateChange;
    this.model = model;
    this.currentState = null;
    this.currentMetrics = null;

    this.failures = {
      redisDown: false,
      oneApiNodeDead: false,
      oneReplicaDead: false,
      dbDown: false,
      dbIndexDropped: false,
      extraLatencyMs: 0
    };

    this.incidentTimeline = [
      {
        id: 'init',
        timestamp: Date.now(),
        timeFormatted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: 'info',
        icon: '🛡️',
        title: 'Chaos Console Initialized',
        detail: 'System operating normally under baseline traffic.'
      }
    ];
  }

  updateContext(state, metrics, model) {
    this.currentState = JSON.parse(JSON.stringify(state || {}));
    this.currentMetrics = metrics ? { ...metrics } : null;
    if (model) this.model = model;
    if (state && state.failures) {
      this.failures = {
        redisDown: Boolean(state.failures.redisDown),
        oneApiNodeDead: Boolean(state.failures.oneApiNodeDead),
        oneReplicaDead: Boolean(state.failures.oneReplicaDead),
        dbDown: Boolean(state.failures.dbDown),
        dbIndexDropped: !state.dbIndexed,
        extraLatencyMs: state.failures.extraLatencyMs || 0
      };
    }
    this.render();
  }

  updateFailures(failures, dbIndexed, metrics = null, state = null) {
    this.failures = { ...this.failures, ...failures };
    this.failures.dbIndexDropped = !dbIndexed;
    if (metrics) this.currentMetrics = { ...metrics };
    if (state) this.currentState = JSON.parse(JSON.stringify(state));
    this.render();
  }

  getActiveFailuresList() {
    const active = [];
    if (this.failures.redisDown) active.push({ key: 'redisDown', name: 'Redis Cache Crash', icon: '⚡', scope: 'Cache Cluster' });
    if (this.failures.oneApiNodeDead) active.push({ key: 'oneApiNodeDead', name: '1 API Pod Dead', icon: '⚙️', scope: 'API Stateless' });
    if (this.failures.oneReplicaDead) active.push({ key: 'oneReplicaDead', name: '1 Replica Offline', icon: '🗄️', scope: 'DB Read Pool' });
    if (this.failures.dbDown) active.push({ key: 'dbDown', name: 'Primary DB Outage', icon: '💥', scope: 'Storage Master' });
    if (this.failures.dbIndexDropped) active.push({ key: 'dropIndex', name: 'Index Dropped', icon: '🔍', scope: 'Query Optimizer' });
    if (this.failures.extraLatencyMs > 0) active.push({ key: 'extraLatency', name: '+150ms Latency Spike', icon: '⏱️', scope: 'Cross-AZ I/O' });
    return active;
  }

  render() {
    if (!this.containerEl) return;

    // Compute fresh metrics if not provided or to guarantee precision
    let m = this.currentMetrics;
    const s = this.currentState || { traffic: 1000, apiServers: 1, readReplicas: 0, redisEnabled: false, cacheHitRate: 0.94, dbIndexed: true, failures: {} };
    if (!m && this.model) {
      m = this.model.calculate(s);
      this.currentMetrics = m;
    }
    m = m || {};

    const activeFailures = this.getActiveFailuresList();
    const isDegraded = activeFailures.length > 0;
    const isCritical = (m.isDbDown || m.systemMaxUtilization >= 1.0 || m.errorRate > 0.05);

    const healthStatus = isCritical
      ? { label: 'CRITICAL', color: 'status-danger', icon: '🔴', text: 'Requests failing or severe queue backlog' }
      : isDegraded
      ? { label: 'DEGRADED', color: 'status-warning', icon: '🟠', text: 'Elevated latency or reduced tier capacity' }
      : { label: 'HEALTHY', color: 'status-healthy', icon: '🟢', text: 'All components within normal operating tolerances' };

    let html = `
      <div class="chaos-workspace-container">
        
        <!-- 1. TOP COMPACT COMMAND HEADER -->
        <div class="chaos-command-header">
          <div class="header-brand-side">
            <div class="chaos-title-line">
              <span class="chaos-badge">CHAOS LAB</span>
              <h2 class="chaos-title">Incident Simulation Console</h2>
            </div>
            <p class="chaos-desc">Inject targeted infrastructure failures to evaluate blast radius, causal degradation, and fault tolerance.</p>
          </div>

          <div class="header-actions-side">
            <div class="active-counter-badge ${activeFailures.length > 0 ? 'badge-tripped' : 'badge-nominal'}">
              <span class="pulse-indicator">●</span>
              <span>${activeFailures.length === 0 ? '0 Active Incidents' : `${activeFailures.length} Active Incident${activeFailures.length > 1 ? 's' : ''}`}</span>
            </div>
            <button type="button" class="btn-reset-chaos" id="btn-reset-chaos" ${activeFailures.length === 0 ? 'disabled' : ''}>
              ↺ Reset All
            </button>
          </div>
        </div>

        <!-- 2. 2-COLUMN RESPONSIVE WORKSPACE -->
        <div class="chaos-2col-layout">
          
          <!-- LEFT COLUMN (~65%): INCIDENT LIBRARY -->
          <div class="chaos-library-panel">
            
            <!-- Category 1: Infrastructure -->
            <div class="library-category-block">
              <div class="category-header">
                <span class="category-name">INFRASTRUCTURE TIER</span>
                <span class="category-line"></span>
              </div>
              <div class="category-card-grid">

                <!-- 1. Redis Cache Crash -->
                <div class="sre-failure-card ${this.failures.redisDown ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">⚡</span>
                      <div>
                        <div class="sre-name">Redis Cache Crash</div>
                        <div class="sre-scope">In-Memory Cache Cluster</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.redisDown ? 'badge-off' : 'badge-on'}">
                      ${this.failures.redisDown ? 'OFFLINE' : 'ONLINE'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.redisDown ? 'Cache bypassed · 100% of read queries falling through to DB' : 'Absorbs 94% of read queries directly from RAM'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.redisDown ? 'btn-restore' : 'btn-inject'}" data-failure="redisDown">
                    ${this.failures.redisDown ? '✓ Restore Redis Cache' : 'Simulate Cache Crash'}
                  </button>
                </div>

                <!-- 2. API Server Pod Crash -->
                <div class="sre-failure-card ${this.failures.oneApiNodeDead ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">⚙️</span>
                      <div>
                        <div class="sre-name">1 API Server Crash</div>
                        <div class="sre-scope">Stateless API Node</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.oneApiNodeDead ? 'badge-warn' : 'badge-on'}">
                      ${this.failures.oneApiNodeDead ? '-1 NODE' : 'HEALTHY'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.oneApiNodeDead ? 'Container OOM-killed · Compute pool capacity down by 30k/s' : 'API cluster distributing incoming HTTP requests'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.oneApiNodeDead ? 'btn-restore' : 'btn-inject'}" data-failure="oneApiNodeDead">
                    ${this.failures.oneApiNodeDead ? '✓ Revive API Node' : 'Kill 1 API Server'}
                  </button>
                </div>

                <!-- 3. Read Replica Offline -->
                <div class="sre-failure-card ${this.failures.oneReplicaDead ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">🗄️</span>
                      <div>
                        <div class="sre-name">1 Read Replica Down</div>
                        <div class="sre-scope">Database Replica Pool</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.oneReplicaDead ? 'badge-warn' : 'badge-on'}">
                      ${this.failures.oneReplicaDead ? '-1 REPLICA' : 'HEALTHY'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.oneReplicaDead ? 'Replica removed · Query volume concentrated on survivors' : 'Read traffic load-balanced across replicas'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.oneReplicaDead ? 'btn-restore' : 'btn-inject'}" data-failure="oneReplicaDead">
                    ${this.failures.oneReplicaDead ? '✓ Reconnect Replica' : 'Kill 1 Read Replica'}
                  </button>
                </div>

              </div>
            </div>

            <!-- Category 2: Storage & Query Optimizer -->
            <div class="library-category-block">
              <div class="category-header">
                <span class="category-name">STORAGE & QUERY OPTIMIZER</span>
                <span class="category-line"></span>
              </div>
              <div class="category-card-grid">

                <!-- 4. Primary DB Outage -->
                <div class="sre-failure-card ${this.failures.dbDown ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">💥</span>
                      <div>
                        <div class="sre-name">Primary DB Outage</div>
                        <div class="sre-scope">Postgres Master Storage</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.dbDown ? 'badge-off' : 'badge-on'}">
                      ${this.failures.dbDown ? 'DOWN' : 'ONLINE'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.dbDown ? 'Master unreachable · Cached reads survive; link writes fail' : 'Accepts writes, generates WAL, syncs replicas'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.dbDown ? 'btn-restore' : 'btn-inject'}" data-failure="dbDown">
                    ${this.failures.dbDown ? '✓ Restore Database' : 'Simulate Master DB Outage'}
                  </button>
                </div>

                <!-- 5. Drop short_code Index -->
                <div class="sre-failure-card ${this.failures.dbIndexDropped ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">🔍</span>
                      <div>
                        <div class="sre-name">Drop short_code Index</div>
                        <div class="sre-scope">B-Tree Query Optimizer</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.dbIndexDropped ? 'badge-warn' : 'badge-on'}">
                      ${this.failures.dbIndexDropped ? 'UNINDEXED' : 'INDEXED'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.dbIndexDropped ? 'Forces sequential full-table scans (140ms latency, -85% cap)' : 'O(log N) indexed point lookups (~12ms query latency)'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.dbIndexDropped ? 'btn-restore' : 'btn-inject'}" data-failure="dropIndex">
                    ${this.failures.dbIndexDropped ? '✓ Rebuild B-Tree Index' : 'Drop B-Tree Index'}
                  </button>
                </div>

              </div>
            </div>

            <!-- Category 3: Network & Transit -->
            <div class="library-category-block">
              <div class="category-header">
                <span class="category-name">NETWORK & I/O</span>
                <span class="category-line"></span>
              </div>
              <div class="category-card-grid">

                <!-- 6. Latency Spike -->
                <div class="sre-failure-card ${this.failures.extraLatencyMs > 0 ? 'card-tripped' : ''}">
                  <div class="card-top-row">
                    <div class="card-icon-title">
                      <span class="sre-icon">⏱️</span>
                      <div>
                        <div class="sre-name">+150ms Latency Spike</div>
                        <div class="sre-scope">Cross-AZ Transit / Disk I/O</div>
                      </div>
                    </div>
                    <span class="sre-status-badge ${this.failures.extraLatencyMs > 0 ? 'badge-warn' : 'badge-on'}">
                      ${this.failures.extraLatencyMs > 0 ? '+150ms' : 'LOW RTT'}
                    </span>
                  </div>
                  <div class="sre-consequence">
                    ${this.failures.extraLatencyMs > 0 ? 'Injects artificial round-trip packet queueing delay' : 'Normal packet latency (~6ms baseline)'}
                  </div>
                  <button type="button" class="btn-sre-action ${this.failures.extraLatencyMs > 0 ? 'btn-restore' : 'btn-inject'}" data-failure="extraLatency">
                    ${this.failures.extraLatencyMs > 0 ? '✓ Clear Network Jitter' : 'Inject 150ms Delay'}
                  </button>
                </div>

              </div>
            </div>

          </div>

          <!-- RIGHT COLUMN (~35%): LIVE SYSTEM IMPACT (STICKY) -->
          <div class="chaos-impact-panel">
            
            <div class="impact-panel-header">
              <span class="impact-header-title">⚡ LIVE SYSTEM IMPACT</span>
              <span class="health-pill ${healthStatus.color}">${healthStatus.icon} ${healthStatus.label}</span>
            </div>

            <!-- Primary Bottleneck -->
            <div class="sre-metric-box bottleneck-box">
              <span class="metric-mini-title">PRIMARY BOTTLENECK</span>
              <div class="bottleneck-text ${isCritical ? 'text-danger' : ''}">
                ${m.isDbDown ? 'Storage Layer Disaster (DB Down)' : (m.primaryBottleneck ? m.primaryBottleneck.name : 'None (Balanced Capacity)')}
              </div>
              <div class="bottleneck-sub">${healthStatus.text}</div>
            </div>

            <!-- Metric 2x2 Grid -->
            <div class="impact-metrics-matrix">
              
              <!-- Avg Latency -->
              <div class="matrix-tile">
                <span class="matrix-label">AVG LATENCY</span>
                <div class="matrix-value ${(m.avgLatency >= 200 || this.failures.extraLatencyMs > 0 || this.failures.dbIndexDropped) ? 'val-danger' : (m.avgLatency >= 80 ? 'val-warning' : 'val-healthy')}">
                  ${m.isDbDown && !s.redisEnabled 
                    ? 'Timeout'
                    : (m.avgLatency >= 1000 ? `${(m.avgLatency/1000).toFixed(2)}s` : `${Math.round(m.avgLatency || 46)}ms`)}
                </div>
                <span class="matrix-sub">
                  ${this.failures.extraLatencyMs > 0 
                    ? '⚠️ +150ms injected delay' 
                    : (this.failures.dbIndexDropped ? '⚠️ +128ms full scan' : 'client → API → DB')}
                </span>
              </div>

              <!-- Throughput -->
              <div class="matrix-tile">
                <span class="matrix-label">THROUGHPUT</span>
                <div class="matrix-value ${(m.throughput < (s.traffic || 1000)) ? 'val-danger' : 'val-healthy'}">
                  ${m.throughput >= 1000 ? `${(m.throughput/1000).toFixed(1)}k/s` : `${m.throughput ?? 1000}/s`}
                </div>
                <span class="matrix-sub">
                  ${(m.droppedTraffic > 0) ? `🔴 ${(m.droppedTraffic/1000).toFixed(1)}k/s dropped` : '100% served'}
                </span>
              </div>

              <!-- API Load -->
              <div class="matrix-tile">
                <span class="matrix-label">API LOAD</span>
                <div class="matrix-value ${(m.apiLoad >= 1.0 || (m.activeApiServers === 0)) ? 'val-danger' : (m.apiLoad >= 0.75 ? 'val-warning' : 'val-healthy')}">
                  ${m.activeApiServers === 0 ? '1000%' : `${Math.round((m.apiLoad || 0.03) * 100)}%`}
                </div>
                <span class="matrix-sub">
                  ${m.activeApiServers === 0 ? '🔴 0 / 1 servers (502 Bad Gateway)' : `${m.activeApiServers ?? (s.apiServers || 1)} active node(s)`}
                </span>
              </div>

              <!-- DB Load -->
              <div class="matrix-tile">
                <span class="matrix-label">DB LOAD</span>
                <div class="matrix-value ${(this.failures.dbDown || (Math.max(m.dbReadLoad||0, m.dbWriteLoad||0)) >= 1.0) ? 'val-danger' : ((Math.max(m.dbReadLoad||0, m.dbWriteLoad||0)) >= 0.5 ? 'val-warning' : 'val-healthy')}">
                  ${this.failures.dbDown ? '1000%' : `${Math.round(Math.max(m.dbReadLoad || 0, m.dbWriteLoad || 0) * 100)}%`}
                </div>
                <span class="matrix-sub">
                  ${this.failures.dbDown 
                    ? '🔴 Storage offline' 
                    : (this.failures.dbIndexDropped ? '⚠️ Unindexed scan (1.5k cap)' : (this.failures.redisDown ? '⚡ 100% reads on DB' : 'Read/Write pool'))}
                </span>
              </div>

            </div>

            <!-- Active Incidents Summary List -->
            <div class="active-incidents-section">
              <span class="active-sec-title">ACTIVE INCIDENTS (${activeFailures.length})</span>
              ${activeFailures.length === 0 ? `
                <div class="no-incidents-msg">No active outages. Click any scenario on the left to inject.</div>
              ` : `
                <div class="active-pills-list">
                  ${activeFailures.map(f => `
                    <div class="active-pill-item">
                      <span class="pill-left">${f.icon} <strong>${f.name}</strong> <span class="pill-scope">(${f.scope})</span></span>
                      <button type="button" class="btn-pill-clear" data-failure="${f.key}" title="Restore">✕</button>
                    </div>
                  `).join('')}
                </div>
              `}
            </div>

            <!-- Link to Scale Tab -->
            <button type="button" class="btn-inspect-scale" id="btn-chaos-jump-scale">
              Inspect Live Flow in Scale Simulator →
            </button>

          </div>

        </div>

        <!-- 3. INCIDENT TIMELINE & SYSTEM CONSEQUENCES -->
        <div class="chaos-timeline-box">
          <div class="timeline-box-header">
            <div class="timeline-header-left">
              <span class="timeline-title-text">📋 INCIDENT TIMELINE & SYSTEM CONSEQUENCES</span>
              <span class="timeline-count-badge">${this.incidentTimeline.length} events</span>
            </div>
            <button type="button" class="btn-clear-sre-log" id="btn-clear-chaos-timeline">Clear Log</button>
          </div>

          <div class="sre-timeline-stream" id="chaos-timeline-list">
            ${this.incidentTimeline.map(item => `
              <div class="sre-timeline-row row-${item.type}">
                <span class="sre-time-col">${item.timeFormatted}</span>
                <span class="sre-event-icon">${item.icon}</span>
                <div class="sre-event-meta">
                  <div class="sre-event-title">${item.title}</div>
                  <div class="sre-event-detail">${item.detail}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

      </div>
    `;

    this.containerEl.innerHTML = html;
    this.attachListeners();
  }

  attachListeners() {
    // Reset All button
    const resetBtn = this.containerEl.querySelector('#btn-reset-chaos');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.failures = {
          redisDown: false,
          oneApiNodeDead: false,
          oneReplicaDead: false,
          dbDown: false,
          dbIndexDropped: false,
          extraLatencyMs: 0
        };

        this.addTimelineEvent({
          type: 'success',
          icon: '🔄',
          title: 'All Failures Restored by Operator',
          detail: 'System returned to nominal operating health.'
        });

        if (this.onStateChange) {
          this.onStateChange({
            failures: { ...this.failures },
            redisEnabled: true,
            dbIndexed: true
          });
        }
      });
    }

    // Toggle failure buttons
    this.containerEl.querySelectorAll('.btn-sre-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const failureType = e.currentTarget.getAttribute('data-failure');
        this.toggleFailure(failureType);
      });
    });

    // Remove pill buttons
    this.containerEl.querySelectorAll('.btn-pill-clear').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const failureType = e.currentTarget.getAttribute('data-failure');
        this.toggleFailure(failureType);
      });
    });

    // Clear Timeline Log
    const clearTimelineBtn = this.containerEl.querySelector('#btn-clear-chaos-timeline');
    if (clearTimelineBtn) {
      clearTimelineBtn.addEventListener('click', () => {
        this.incidentTimeline = [];
        this.render();
      });
    }

    // Jump to Scale Simulator tab button
    const jumpScaleBtn = this.containerEl.querySelector('#btn-chaos-jump-scale');
    if (jumpScaleBtn) {
      jumpScaleBtn.addEventListener('click', () => {
        const scaleTabBtn = document.querySelector('[data-mode="scale-simulator"]');
        if (scaleTabBtn) scaleTabBtn.click();
      });
    }
  }

  toggleFailure(failureType) {
    const nextFailures = { ...this.failures };
    let nextRedisEnabled = this.currentState ? this.currentState.redisEnabled : false;
    let nextDbIndexed = this.currentState ? this.currentState.dbIndexed : true;

    if (failureType === 'redisDown') {
      nextFailures.redisDown = !this.failures.redisDown;
      nextRedisEnabled = !nextFailures.redisDown;
      this.addTimelineEvent({
        type: nextFailures.redisDown ? 'critical' : 'success',
        icon: nextFailures.redisDown ? '⚡' : '✓',
        title: nextFailures.redisDown ? 'Redis Cache Crash Injected' : 'Redis Cache Restored',
        detail: nextFailures.redisDown ? '100% of read queries now cascade directly onto DB' : 'In-memory cache now absorbing ~94% of lookups'
      });
    } else if (failureType === 'oneApiNodeDead') {
      nextFailures.oneApiNodeDead = !this.failures.oneApiNodeDead;
      this.addTimelineEvent({
        type: nextFailures.oneApiNodeDead ? 'critical' : 'success',
        icon: nextFailures.oneApiNodeDead ? '⚙️' : '✓',
        title: nextFailures.oneApiNodeDead ? '1 API Server Node Killed' : 'API Server Node Restored',
        detail: nextFailures.oneApiNodeDead ? 'Compute capacity dropped to 0 req/s (502 Bad Gateway)' : 'Compute pool capacity fully restored'
      });
    } else if (failureType === 'oneReplicaDead') {
      nextFailures.oneReplicaDead = !this.failures.oneReplicaDead;
      this.addTimelineEvent({
        type: nextFailures.oneReplicaDead ? 'warning' : 'success',
        icon: nextFailures.oneReplicaDead ? '🗄️' : '✓',
        title: nextFailures.oneReplicaDead ? '1 Read Replica Instance Killed' : 'Read Replica Reconnected',
        detail: nextFailures.oneReplicaDead ? 'Query load concentrated onto surviving replica pool' : 'Replica pool load rebalanced'
      });
    } else if (failureType === 'dbDown') {
      nextFailures.dbDown = !this.failures.dbDown;
      this.addTimelineEvent({
        type: nextFailures.dbDown ? 'critical' : 'success',
        icon: nextFailures.dbDown ? '💥' : '✓',
        title: nextFailures.dbDown ? 'Primary Database Outage Injected' : 'Primary Database Restored Online',
        detail: nextFailures.dbDown ? 'Storage layer offline. Cached reads succeed; writes & misses fail' : 'Database connection pool and WAL commits online'
      });
    } else if (failureType === 'dropIndex') {
      nextDbIndexed = Boolean(this.failures.dbIndexDropped); // toggle
      nextFailures.dbIndexDropped = !nextDbIndexed;
      this.addTimelineEvent({
        type: nextFailures.dbIndexDropped ? 'warning' : 'success',
        icon: nextFailures.dbIndexDropped ? '🔍' : '✓',
        title: nextFailures.dbIndexDropped ? 'short_code Index Dropped' : 'B-Tree Index Rebuilt',
        detail: nextFailures.dbIndexDropped ? 'Point queries degrade to sequential full-table scans (~140ms)' : 'O(log N) index scan restored (~12ms query latency)'
      });
    } else if (failureType === 'extraLatency') {
      nextFailures.extraLatencyMs = (this.failures.extraLatencyMs > 0) ? 0 : 150;
      this.addTimelineEvent({
        type: nextFailures.extraLatencyMs > 0 ? 'warning' : 'success',
        icon: nextFailures.extraLatencyMs > 0 ? '⏱️' : '✓',
        title: nextFailures.extraLatencyMs > 0 ? '+150ms Network/Disk Latency Injected' : 'Network Jitter Cleared',
        detail: nextFailures.extraLatencyMs > 0 ? 'Cross-AZ transit delayed by 150ms RTT' : 'Nominal network RTT restored (~6ms)'
      });
    }

    this.failures = nextFailures;

    if (this.onStateChange) {
      this.onStateChange({
        failures: { ...nextFailures },
        redisEnabled: nextRedisEnabled,
        dbIndexed: nextDbIndexed
      });
    }
  }

  addTimelineEvent({ type = 'info', icon = '●', title, detail }) {
    this.incidentTimeline.unshift({
      id: 'evt-' + Date.now() + '-' + Math.floor(Math.random()*1000),
      timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type,
      icon,
      title,
      detail
    });

    if (this.incidentTimeline.length > 25) {
      this.incidentTimeline.pop();
    }
  }
}
