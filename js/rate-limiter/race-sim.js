/**
 * Atomicity & Race Condition Playground
 *
 * Visually and interactively demonstrates why atomicity matters when multiple gateways
 * check and update the same shared counter concurrently.
 *
 * Visibly DIFFERENT execution paths:
 *  1. Non-Atomic (READ then WRITE):
 *     - Visualizes concurrency: Request A and Request B concurrently read stale value (99).
 *     - Both allow, both write 100 → Lost update / over-admission (101 requests served).
 *  2. Atomic (Redis Lua Script):
 *     - Visualizes serialization: Request A executes [CHECK + INCREMENT] as a single isolated block (99→100, ALLOW).
 *     - Request B executes [CHECK + INCREMENT] next, sees 100≥100, REJECT 429. Strict enforcement.
 */

import { rlIconBadge, rlIcon } from './icons.js';

export class RaceConditionSimulator {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.mode = 'non_atomic'; // 'non_atomic' | 'atomic'
    this.isRunning = false;
    this.initialCounter = 99;
    this.limit = 100;
  }

  render() {
    if (!this.containerEl) return;

    this.containerEl.innerHTML = `
      <div class="race-sim-card">
        <!-- Header -->
        <div class="race-sim-header">
          <div class="race-sim-title-row">
            <span class="race-sim-icon">${rlIconBadge('pulse', { color: '#a78bfa', size: 34, iconSize: 17 })}</span>
            <div class="race-header-text">
              <h3 class="race-sim-title">Race Condition & Atomicity Playground</h3>
              <p class="race-sim-desc">
                When multiple gateways handle concurrent traffic, can they check and increment shared counters without corrupting state?
              </p>
            </div>
          </div>
        </div>

        <!-- Mode Toggle -->
        <div class="race-sim-mode-toggle">
          <button type="button" class="race-mode-btn ${this.mode === 'non_atomic' ? 'active' : ''}"
                  data-race-mode="non_atomic">
            ${rlIcon('unlock', { size: 14 })} Non-Atomic (Separate READ then WRITE)
          </button>
          <button type="button" class="race-mode-btn ${this.mode === 'atomic' ? 'active' : ''}"
                  data-race-mode="atomic">
            ${rlIcon('lock', { size: 14 })} Atomic (Redis Lua Script: CHECK + INCREMENT)
          </button>
        </div>

        <!-- Visual Architecture Note: Connecting to Redis & Gateways -->
        <div class="race-concept-banner">
          <span class="concept-badge">Distributed Context</span>
          <span class="concept-text">
            <strong>Multiple gateways can check the same shared counter concurrently.</strong>
            ${this.mode === 'non_atomic'
              ? 'In non-atomic mode, CHECK and UPDATE are separate network operations, creating a race window.'
              : 'With Redis Lua, CHECK + UPDATE executes as a single, isolated, atomic operation on the Redis engine.'}
          </span>
        </div>

        <!-- Execution Arena (Visibly Different Layouts) -->
        <div class="race-sim-arena" id="rl-race-arena">
          ${this._renderArena()}
        </div>

        <!-- Controls -->
        <div class="race-sim-controls">
          <button type="button" class="btn-primary race-run-btn" id="rl-race-run-btn">
            ▶ Run Concurrent Requests
          </button>
          <button type="button" class="btn-ref-reset race-reset-btn" id="rl-race-reset-btn">↺ Reset</button>
        </div>

        <!-- Result Summary Strip & Explanation -->
        <div class="race-sim-result" id="rl-race-result"></div>
      </div>`;

    this._bindEvents();
  }

  _renderArena() {
    if (this.mode === 'non_atomic') {
      // Non-atomic: Emphasizes concurrency with interleaved timeline
      return `
        <div class="race-arena-wrap arena-concurrent">
          <div class="arena-subtitle">Concurrent Race Window (Overlapping READ before WRITE)</div>
          <div class="race-lanes lanes-concurrent">
            <!-- Request A Lane (Gateway 1) -->
            <div class="race-lane" id="rl-race-lane-a">
              <div class="race-lane-header">
                <span class="race-lane-badge badge-gw1">GW 1</span>
                <span>Request A</span>
              </div>
              <div class="race-lane-steps" id="rl-race-steps-a">
                <div class="step-placeholder">Ready to execute...</div>
              </div>
            </div>

            <!-- Central Counter Display -->
            <div class="race-lane-divider">
              <div class="race-counter-display">
                <div class="race-counter-label">Shared Redis Counter</div>
                <div class="race-counter-value mono" id="rl-race-counter">${this.initialCounter}</div>
                <div class="race-counter-limit mono">Limit: ${this.limit}</div>
                <div class="race-counter-sub" id="rl-counter-state">Stale read window open</div>
              </div>
            </div>

            <!-- Request B Lane (Gateway 2) -->
            <div class="race-lane" id="rl-race-lane-b">
              <div class="race-lane-header">
                <span class="race-lane-badge badge-gw2">GW 2</span>
                <span>Request B</span>
              </div>
              <div class="race-lane-steps" id="rl-race-steps-b">
                <div class="step-placeholder">Ready to execute...</div>
              </div>
            </div>
          </div>
        </div>`;
    } else {
      // Atomic: Emphasizes serialization and single-block atomic evaluation
      return `
        <div class="race-arena-wrap arena-atomic">
          <div class="arena-subtitle">Serialized Atomic Execution (Redis Lua Script Isolation)</div>
          <div class="race-atomic-flow">
            <!-- Central Redis Single-Threaded Worker -->
            <div class="atomic-counter-card">
              <div class="atomic-header">
                <span class="atomic-icon">${rlIcon('database', { size: 16 })}</span>
                <span class="atomic-title">Redis Single-Threaded Execution Queue</span>
              </div>
              <div class="atomic-counter-row">
                <div class="race-counter-value mono" id="rl-race-counter">${this.initialCounter}</div>
                <div class="atomic-counter-meta">
                  <div class="mono">Limit: ${this.limit}</div>
                  <div class="atomic-status" id="rl-counter-state">Atomic script engine idle</div>
                </div>
              </div>
            </div>

            <!-- Sequential Atomic Execution Pipeline -->
            <div class="atomic-pipeline-steps" id="rl-atomic-pipeline">
              <div class="step-placeholder">Click 'Run Concurrent Requests' to execute atomic Lua script...</div>
            </div>
          </div>
        </div>`;
    }
  }

  _bindEvents() {
    this.containerEl.querySelectorAll('.race-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-race-mode');
        if (target && target !== this.mode) {
          this.mode = target;
          this.render();
        }
      });
    });

    const runBtn = this.containerEl.querySelector('#rl-race-run-btn');
    if (runBtn) runBtn.addEventListener('click', () => this.runSimulation());

    const resetBtn = this.containerEl.querySelector('#rl-race-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => this.render());
  }

  async runSimulation() {
    if (this.isRunning) return;
    this.isRunning = true;

    const runBtn = this.containerEl.querySelector('#rl-race-run-btn');
    const counterEl = this.containerEl.querySelector('#rl-race-counter');
    const stateEl = this.containerEl.querySelector('#rl-counter-state');
    const resultEl = this.containerEl.querySelector('#rl-race-result');

    if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Executing...'; }
    if (resultEl) resultEl.innerHTML = '';

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    if (this.mode === 'non_atomic') {
      const stepsA = this.containerEl.querySelector('#rl-race-steps-a');
      const stepsB = this.containerEl.querySelector('#rl-race-steps-b');
      if (stepsA) stepsA.innerHTML = '';
      if (stepsB) stepsB.innerHTML = '';

      // Step 1: Both READ 99 concurrently
      this._addStep(stepsA, '1. READ counter → 99', 'read', 0);
      await delay(150);
      this._addStep(stepsB, '1. READ counter → 99 (stale read concurrent with A!)', 'read', 0);
      if (stateEl) stateEl.textContent = 'Race condition triggered: Both read 99';
      await delay(700);

      // Step 2: Both CHECK 99 < 100 → ALLOW
      this._addStep(stepsA, '2. CHECK: 99 < 100 → ALLOW ✓', 'allow', 0);
      await delay(150);
      this._addStep(stepsB, '2. CHECK: 99 < 100 → ALLOW ✓ (neither knew of other)', 'allow', 0);
      await delay(700);

      // Step 3: Both WRITE 100
      this._addStep(stepsA, '3. WRITE counter ← 100', 'write', 0);
      if (counterEl) { counterEl.textContent = '100'; counterEl.className = 'race-counter-value mono race-counter-flash'; }
      await delay(400);

      this._addStep(stepsB, '3. WRITE counter ← 100 (Lost Update: overwrites A)', 'write', 0);
      if (counterEl) { counterEl.textContent = '100'; counterEl.className = 'race-counter-value mono race-counter-over'; }
      if (stateEl) stateEl.textContent = 'Stored counter = 100 (over-admission: 2 admitted)';
      await delay(600);

      // Clean Narrative Result Summary
      if (resultEl) {
        resultEl.innerHTML = `
          <!-- Primary Narrative Card -->
          <div class="race-narrative-card race-bad">
            <div class="narrative-header">
              <span class="narrative-badge badge-danger">${rlIcon('alertTriangle', { size: 14 })} RACE CONDITION: OVER-ADMISSION</span>
              <span class="narrative-stat mono">+1 Over Limit</span>
            </div>
            <div class="narrative-steps">
              <div class="narrative-step"><strong>1. Stale Reads:</strong> Request A reads <strong>99</strong> · Request B reads <strong>99</strong> (both see capacity)</div>
              <div class="narrative-step"><strong>2. Decisions:</strong> A evaluates 99 &lt; 100 (ALLOW) · B evaluates 99 &lt; 100 (ALLOW)</div>
              <div class="narrative-step"><strong>3. Writes:</strong> A writes 100 · B writes 100 (lost update / overwrite)</div>
            </div>
            <div class="narrative-summary">
              <strong>Consequence:</strong> <strong>2 requests admitted</strong> when remaining capacity was <strong>1</strong> → Counter stores 100, but 101 total requests served!
            </div>
          </div>

          <!-- Secondary Scannable Strip -->
          <div class="dist-summary-strip" style="margin-top: 0.75rem;">
            <div class="dist-summary-chip">
              <div class="summary-chip-label">CONFIGURED LIMIT</div>
              <div class="summary-chip-val mono">100</div>
              <div class="summary-chip-sub">Target policy</div>
            </div>
            <div class="dist-summary-chip">
              <div class="summary-chip-label">ADMITTED</div>
              <div class="summary-chip-val mono val-danger">2 Admitted</div>
              <div class="summary-chip-sub">Both concurrent requests allowed</div>
            </div>
            <div class="dist-summary-chip chip-leak-alert">
              <div class="summary-chip-label">OVER-ADMISSION</div>
              <div class="summary-chip-val mono">+1 Over Limit</div>
              <div class="summary-chip-sub">Limit violated</div>
            </div>
          </div>`;
      }
    } else {
      // Atomic mode (Redis Lua script: check + increment)
      const pipelineEl = this.containerEl.querySelector('#rl-atomic-pipeline');
      if (pipelineEl) pipelineEl.innerHTML = '';

      // Request A atomic check+incr block
      this._addAtomicBlock(pipelineEl, {
        req: 'Request A (Gateway 1)',
        action: rlIcon('lock', { size: 13 }) + ' Redis Lua EVAL: [ CHECK counter < 100 + INCR ] atomically',
        detail: 'Evaluates 99 < 100 → Increments 99 → 100 in single indivisible step',
        outcome: 'ALLOW ✓ (HTTP 200)',
        status: 'allow'
      });
      if (counterEl) { counterEl.textContent = '100'; counterEl.className = 'race-counter-value mono race-counter-flash'; }
      if (stateEl) stateEl.textContent = 'Atomic step 1 complete: Counter = 100 (Limit reached)';
      await delay(800);

      // Request B atomic check+incr block
      this._addAtomicBlock(pipelineEl, {
        req: 'Request B (Gateway 2)',
        action: rlIcon('lock', { size: 13 }) + ' Redis Lua EVAL: [ CHECK counter < 100 + INCR ] atomically',
        detail: 'Evaluates 100 ≥ 100 → Rejection condition met; counter remains 100',
        outcome: 'REJECT 429 🚫 (Too Many Requests)',
        status: 'reject'
      });
      if (stateEl) stateEl.textContent = 'Atomic step 2 complete: Strict limit enforced';
      await delay(600);

      // Clean Narrative Result Summary
      if (resultEl) {
        resultEl.innerHTML = `
          <!-- Primary Narrative Card -->
          <div class="race-narrative-card race-good">
            <div class="narrative-header">
              <span class="narrative-badge badge-success">${rlIcon('shield', { size: 14 })} REDIS LUA: STRICT ATOMICITY</span>
              <span class="narrative-stat mono">0 Over-Admission</span>
            </div>
            <div class="narrative-steps">
              <div class="narrative-step"><strong>1. Atomic Execution:</strong> Request A checks 99 &lt; 100 & increments to 100 in a single step → <strong>ALLOW ✓ (HTTP 200)</strong></div>
              <div class="narrative-step"><strong>2. Serialized Check:</strong> Request B evaluates next, sees 100 ≥ 100 → <strong>REJECT 🚫 (HTTP 429)</strong></div>
            </div>
            <div class="narrative-summary">
              <strong>Consequence:</strong> <strong>1 admitted, 1 rejected</strong> → Redis Lua eliminates the race window. Exact limit strictly enforced!
            </div>
          </div>

          <!-- Secondary Scannable Strip -->
          <div class="dist-summary-strip" style="margin-top: 0.75rem;">
            <div class="dist-summary-chip">
              <div class="summary-chip-label">CONFIGURED LIMIT</div>
              <div class="summary-chip-val mono">100</div>
              <div class="summary-chip-sub">Target policy</div>
            </div>
            <div class="dist-summary-chip">
              <div class="summary-chip-label">ADMITTED</div>
              <div class="summary-chip-val mono val-success">1 Admitted</div>
              <div class="summary-chip-sub">Request A</div>
            </div>
            <div class="dist-summary-chip chip-clean">
              <div class="summary-chip-label">HTTP 429 REJECTED</div>
              <div class="summary-chip-val mono val-warning">1 Rejected</div>
              <div class="summary-chip-sub">Request B throttled</div>
            </div>
          </div>`;
      }
    }

    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run Again'; }
    this.isRunning = false;
  }

  _addStep(container, text, type, delayMs = 0) {
    if (!container) return;
    const step = document.createElement('div');
    step.className = `race-step race-step-${type}`;
    step.style.opacity = '0';
    step.style.transform = 'translateY(6px)';
    step.textContent = text;
    container.appendChild(step);

    setTimeout(() => {
      step.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
      step.style.opacity = '1';
      step.style.transform = 'translateY(0)';
    }, delayMs || 10);
  }

  _addAtomicBlock(container, data) {
    if (!container) return;
    const block = document.createElement('div');
    block.className = `atomic-step-card status-${data.status}`;
    block.style.opacity = '0';
    block.style.transform = 'translateY(8px)';
    block.innerHTML = `
      <div class="atomic-step-header">
        <span class="atomic-step-req">${data.req}</span>
        <span class="atomic-step-outcome badge-${data.status}">${data.outcome}</span>
      </div>
      <div class="atomic-step-action mono">${data.action}</div>
      <div class="atomic-step-detail">${data.detail}</div>`;
    container.appendChild(block);

    setTimeout(() => {
      block.style.transition = 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
      block.style.opacity = '1';
      block.style.transform = 'translateY(0)';
    }, 20);
  }
}
