/**
 * Distributed Multi-Gateway Topology & State Coordination Simulator
 *
 * Visually and interactively demonstrates:
 *  1. Multi-Gateway Topology: Traffic splitting across multiple gateway instances.
 *  2. Local Memory Mode: Each gateway owns independent in-memory state, causing distributed
 *     limit leakage when an identity distributes traffic across gateways.
 *  3. Redis Shared State Mode: Gateways coordinate through a shared Redis key, enforcing
 *     the global rate limit without distributed leakage under healthy coordination.
 *  4. Educational Causal Explanation & Real Model Source of Truth.
 */

import { rlIconBadge, rlIcon } from './icons.js';

export class DistributedSimulator {
  constructor(containerEl, model, initialState = {}, onStorageChange = null) {
    this.containerEl = containerEl;
    this.model = model;
    this.onStorageChange = onStorageChange;

    this.storage = initialState.tokenStore === 'local_memory' ? 'local_memory' : 'redis';
    this.gatewayCount = Math.max(2, Math.min(6, initialState.gatewayNodes || 3));
    this.traffic = 300;
    this.limit = initialState.limitPerUser || 100;
    this.isAtomic = initialState.atomicityMode !== 'non_atomic';
  }

  updateContext(state) {
    if (!state) return;
    let changed = false;
    if (state.tokenStore && state.tokenStore !== this.storage) {
      this.storage = state.tokenStore;
      changed = true;
    }
    if (state.gatewayNodes && state.gatewayNodes !== this.gatewayCount) {
      this.gatewayCount = Math.max(2, Math.min(6, state.gatewayNodes));
      changed = true;
    }
    if (state.limitPerUser && state.limitPerUser !== this.limit) {
      this.limit = state.limitPerUser;
      changed = true;
    }
    if (changed) {
      this.render();
    }
  }

  render() {
    if (!this.containerEl) return;

    // Evaluate current scenario strictly from Model
    const data = this.model
      ? this.model.evaluateDistributedTopology({
          storage: this.storage,
          gatewayCount: this.gatewayCount,
          traffic: this.traffic,
          limit: this.limit,
          isAtomic: this.isAtomic
        })
      : {
          storage: this.storage,
          gatewayCount: this.gatewayCount,
          identityTraffic: this.traffic,
          intendedPolicy: this.limit,
          totalAllowed: this.storage === 'local_memory' ? Math.min(this.traffic, this.limit * this.gatewayCount) : Math.min(this.traffic, this.limit),
          totalRejected: 0,
          leakage: this.storage === 'local_memory' ? Math.max(0, this.traffic - this.limit) : 0,
          perGwResults: [],
          explanation: { title: '', points: [] }
        };

    const isLocal = (this.storage === 'local_memory');

    this.containerEl.innerHTML = `
      <div class="dist-sim-card">
        <!-- Header -->
        <div class="dist-sim-header">
          <div class="dist-header-title-row">
            <span class="dist-header-icon">${rlIconBadge('network', { color: '#38bdf8', size: 34, iconSize: 17 })}</span>
            <div class="dist-header-text">
              <span class="dist-eyebrow">DISTRIBUTED LAB</span>
              <h3 class="dist-title">Why does local memory fail when multiple gateways share traffic?</h3>
              <p class="dist-desc">
                Toggle between independent local memory and shared Redis to observe how traffic splitting causes distributed limit leakage.
              </p>
            </div>
          </div>
        </div>

        <!-- Experiment Controls Bar -->
        <div class="dist-controls-bar">
          <!-- Storage Toggle -->
          <div class="dist-toggle-group">
            <span class="dist-control-label">Storage Backend:</span>
            <div class="dist-mode-pills">
              <button type="button" class="dist-pill-btn ${isLocal ? 'active' : ''}" data-dist-storage="local_memory">
                ${rlIcon('server', { size: 14 })} Local Memory (Independent)
              </button>
              <button type="button" class="dist-pill-btn ${!isLocal ? 'active' : ''}" data-dist-storage="redis">
                ${rlIcon('database', { size: 14 })} Redis (Shared State)
              </button>
            </div>
          </div>

          <!-- Presets -->
          <div class="dist-presets-group">
            <span class="dist-control-label">Traffic Presets:</span>
            <div class="dist-preset-btns">
              <button type="button" class="dist-preset-btn ${this.traffic === 60 ? 'active' : ''}" data-traffic="60">
                A: 60 RPS <span class="preset-tag">0 Leakage</span>
              </button>
              <button type="button" class="dist-preset-btn ${this.traffic === 300 ? 'active' : ''}" data-traffic="300">
                B: 300 RPS <span class="preset-tag tag-alert">+200 Leakage</span>
              </button>
            </div>
          </div>

          <!-- Gateway & Traffic Details -->
          <div class="dist-config-pills">
            <div class="dist-config-pill">
              <span class="pill-label">Gateways:</span>
              <button type="button" class="gw-step-btn" id="gw-minus" ${this.gatewayCount <= 2 ? 'disabled' : ''}>−</button>
              <strong id="gw-count-disp">${this.gatewayCount}</strong>
              <button type="button" class="gw-step-btn" id="gw-plus" ${this.gatewayCount >= 6 ? 'disabled' : ''}>+</button>
            </div>
            <div class="dist-config-pill">
              <span class="pill-label">Global Limit:</span>
              <strong>${this.limit} RPS</strong>
            </div>
          </div>
        </div>

        <!-- Multi-Gateway Visual Topology -->
        <div class="dist-topology-wrap">
          ${this._renderTopologyHtml(data)}
        </div>

        <!-- Clear Visual Consequence Alert -->
        <div class="dist-consequence-card ${isLocal ? 'consequence-leak' : 'consequence-clean'}">
          <div class="dist-consequence-badge">${isLocal ? rlIcon('alertTriangle', { size: 14 }) + ' LOCAL MEMORY CONSEQUENCE' : rlIcon('shield', { size: 14 }) + ' REDIS SHARED CONSEQUENCE'}</div>
          <div class="dist-consequence-text">
            ${isLocal
              ? `<strong>Each gateway thinks it has capacity:</strong> Because each gateway tracks an independent counter in its own memory, ${this.gatewayCount} gateways × ${this.limit} limit = <strong>${data.totalAllowed} RPS admitted</strong> against a configured ${this.limit} RPS limit (<strong>+${data.leakage} RPS leakage</strong>)!`
              : `<strong>All gateways see the same limit:</strong> Gateways coordinate atomically through a shared Redis key. Result: <strong>${data.totalAllowed} admitted</strong>, <strong>${data.totalRejected} rejected (429)</strong>, strictly <strong>0 RPS leakage</strong>.`
            }
          </div>
        </div>

        <!-- 3 Primary Outcome Chips (Scannable at a Glance) -->
        <div class="dist-summary-strip">
          <div class="dist-summary-chip">
            <div class="summary-chip-label">CONFIGURED LIMIT</div>
            <div class="summary-chip-val mono">${data.intendedPolicy} RPS</div>
            <div class="summary-chip-sub">Target per-identity limit</div>
          </div>

          <div class="dist-summary-chip">
            <div class="summary-chip-label">ACTUAL ADMITTED</div>
            <div class="summary-chip-val mono ${data.totalAllowed > data.intendedPolicy ? 'val-danger' : 'val-success'}">
              ${data.totalAllowed} RPS
            </div>
            <div class="summary-chip-sub">${isLocal ? `Sum across ${this.gatewayCount} independent nodes` : 'Central coordination'}</div>
          </div>

          <div class="dist-summary-chip ${data.leakage > 0 ? 'chip-leak-alert' : 'chip-clean'}">
            <div class="summary-chip-label">DISTRIBUTED LEAKAGE</div>
            <div class="summary-chip-val mono">
              ${data.leakage > 0 ? `+${data.leakage} RPS` : '0 RPS'}
            </div>
            <div class="summary-chip-sub">${data.leakage > 0 ? 'Excess admitted over policy' : 'Strictly enforced'}</div>
          </div>
        </div>

        <!-- Secondary: Derivation only. Facts already shown in the chips/topology above are
             filtered out so this doesn't just restate the same numbers a third time. -->
        <details class="dist-tech-details">
          <summary class="dist-tech-summary">How is this derived?</summary>
          <div class="dist-explanation-card ${data.isLeaking ? 'exp-leak' : 'exp-clean'}">
            <div class="dist-exp-header">
              <span class="exp-icon">${rlIcon(data.isLeaking ? 'alertTriangle' : 'shield', { size: 14 })}</span>
              <strong class="exp-title">${data.explanation.title}</strong>
            </div>
            <ul class="dist-exp-list">
              ${data.explanation.points
                .filter(pt => !/^(Global policy|Traffic):/.test(pt))
                .map(pt => `<li>${pt}</li>`).join('')}
            </ul>
          </div>
        </details>
      </div>`;

    this._bindEvents();
  }

  _renderTopologyHtml(data) {
    const isLocal = (this.storage === 'local_memory');
    const perGw = data.perGwResults || [];

    return `
      <div class="topology-grid ${isLocal ? 'topo-local' : 'topo-redis'}">
        <!-- 1. Client Offer Node -->
        <div class="topo-col topo-client-col">
          <div class="topo-node topo-client-node">
            <div class="node-icon">${rlIconBadge('client', { color: '#38bdf8', size: 40, iconSize: 20 })}</div>
            <div class="node-title">Client Traffic</div>
            <div class="node-metric mono">${data.identityTraffic} RPS</div>
            <div class="node-sub">user_42 (representative identity class)</div>
          </div>
          <div class="fan-out-label">Distributed across ${this.gatewayCount} Gateways ↓</div>
        </div>

        <!-- 2. Gateway Tier (Fan-out) -->
        <div class="topo-col topo-gw-col">
          <div class="gw-fan-container">
            ${perGw.map((gw, idx) => `
              <div class="gw-card ${isLocal ? 'gw-local-mode' : 'gw-redis-mode'}">
                <div class="gw-card-header">
                  <span class="gw-badge">${gw.id}</span>
                  <span class="gw-traffic mono">${gw.traffic} RPS</span>
                </div>
                ${isLocal ? `
                  <!-- Local In-Memory Counter Box -->
                  <div class="gw-local-box">
                    <div class="local-box-title">${rlIcon('server', { size: 13 })} Local In-Memory State</div>
                    <div class="local-box-detail mono">Counter: ${gw.allowed} / ${gw.localLimit}</div>
                    <div class="local-box-status ${gw.allowed > 0 ? 'status-ok' : ''}">
                      ${gw.allowed} Allowed locally
                    </div>
                  </div>
                ` : `
                  <!-- Forwarding to Redis -->
                  <div class="gw-redis-link">
                    <div class="redis-link-text">Queries centralized Redis →</div>
                    <div class="redis-link-traffic mono">${gw.traffic} RPS evaluated</div>
                  </div>
                `}
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 3. Convergence / Hub Tier -->
        <div class="topo-col topo-hub-col">
          ${isLocal ? `
            <!-- Local Memory: Uncoordinated egress -->
            <div class="topo-node topo-uncoordinated-node">
              <div class="node-icon">${rlIconBadge('unlock', { color: '#f43f5e', size: 40, iconSize: 20 })}</div>
              <div class="node-title">Uncoordinated Egress</div>
              <div class="node-metric mono val-danger">${data.totalAllowed} RPS Total</div>
              <div class="node-sub">Each node allowed up to its local limit</div>
              <div class="node-tag tag-alert">Leakage: +${data.leakage} RPS</div>
            </div>
          ` : `
            <!-- Redis Shared State Hub -->
            <div class="topo-node topo-redis-hub-node">
              <div class="node-icon">${rlIconBadge('database', { color: '#34d399', size: 40, iconSize: 20 })}</div>
              <div class="node-title">Redis Shared State</div>
              <div class="node-key-badge mono">Key: ratelimit:user_42</div>
              <div class="node-metric mono val-success">Global Limit: ${data.intendedPolicy} RPS</div>
              <div class="node-sub">Shared state, healthy coordination</div>
              <div class="redis-decision-row">
                <span class="decision-allow">${rlIcon('checkCircle', { size: 13 })} ${data.totalAllowed} Allowed</span>
                <span class="decision-reject">${rlIcon('xCircle', { size: 13 })} ${data.totalRejected} Rejected (429)</span>
              </div>
            </div>
          `}
        </div>
      </div>`;
  }

  _bindEvents() {
    // Storage switch
    this.containerEl.querySelectorAll('.dist-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-dist-storage');
        if (target && target !== this.storage) {
          this.storage = target;
          if (this.onStorageChange) this.onStorageChange(this.storage);
          this.render();
        }
      });
    });

    // Presets
    this.containerEl.querySelectorAll('.dist-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = parseInt(btn.getAttribute('data-traffic'), 10);
        if (!isNaN(t)) {
          this.traffic = t;
          this.render();
        }
      });
    });

    // Gateway steppers
    const minusBtn = this.containerEl.querySelector('#gw-minus');
    if (minusBtn) {
      minusBtn.addEventListener('click', () => {
        if (this.gatewayCount > 2) {
          this.gatewayCount--;
          this.render();
        }
      });
    }

    const plusBtn = this.containerEl.querySelector('#gw-plus');
    if (plusBtn) {
      plusBtn.addEventListener('click', () => {
        if (this.gatewayCount < 6) {
          this.gatewayCount++;
          this.render();
        }
      });
    }
  }
}
