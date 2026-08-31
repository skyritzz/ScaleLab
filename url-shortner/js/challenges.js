/**
 * Engineering Challenges & Problem Solving Mode
 * Hands-on scenario challenges where the user must diagnose the bottleneck
 * and apply the correct architectural fix. Bad decisions are explicitly allowed
 * and explained with causal before/after metrics.
 */

import confetti from 'canvas-confetti';

export const CHALLENGES = [
  {
    id: 'challenge_viral',
    title: 'Challenge 1: The Viral Product Launch',
    difficulty: 'Intermediate',
    badge: '🔥 250k RPS Surge',
    goal: 'Scale the system to handle 250,000 req/s with latency < 30ms and 0% error rate.',
    description: 'Your URL shortener was featured on the front page of a major tech publication. Traffic spiked from 10k to 250k req/s. The database read pool is saturated and users are seeing latency spikes.',
    initialState: {
      traffic: 250000,
      readRatio: 0.95,
      apiServers: 15,
      redisEnabled: true,
      cacheHitRate: 0.94,
      readReplicas: 0,
      dbIndexed: true,
      redirectType: '302',
      failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
    },
    actions: [
      {
        id: 'add_api_servers',
        label: '➕ Add 10 API Servers',
        description: 'Increase API cluster size from 15 to 25 instances',
        apply: (state) => ({ ...state, apiServers: state.apiServers + 10 }),
        isCorrect: false,
        explanation: '❌ DID NOT SOLVE THE BOTTLENECK\n\nBefore: API 83% | DB Read Pool 100% (Saturated)\nAfter: API 50% | DB Read Pool 100% (Still Saturated)\n\nWhy?\nAPI capacity was already sufficient. The bottleneck was the Standalone Database receiving 14,250 cache misses/s with 0 read replicas.'
      },
      {
        id: 'add_read_replicas',
        label: '➕ Add 2 Read Replicas',
        description: 'Deploy 2 database read replicas to distribute query load',
        apply: (state) => ({ ...state, readReplicas: state.readReplicas + 2 }),
        isCorrect: true,
        explanation: '✅ BOTTLENECK RESOLVED!\n\nBefore: DB Read Load: 100% (25k cap) | Latency: 340ms\nAfter: DB Read Load: 14.3% (100k cap across 2 replicas) | Latency: 14.2ms\n\nWhy it worked:\nRead replicas scaled total read capacity to 100k reads/s, easily absorbing the 14,250 cache misses/s.'
      },
      {
        id: 'disable_redis',
        label: '⚡ Disable Redis Cache',
        description: 'Bypass Redis to reduce caching complexity',
        apply: (state) => ({ ...state, redisEnabled: false }),
        isCorrect: false,
        explanation: '❌ CATASTROPHIC CHOICE!\n\nDisabling Redis caused DB read traffic to jump by 16.7× (14.2k → 237.5k reads/s). The database crashed immediately.'
      },
      {
        id: 'drop_index',
        label: '🗑️ Drop B-Tree Index',
        description: 'Drop short_code index to speed up write inserts',
        apply: (state) => ({ ...state, dbIndexed: false }),
        isCorrect: false,
        explanation: '❌ DISASTER!\n\nDropping the index forced every read to perform a full table scan (140ms), reducing DB throughput by 85%.'
      }
    ]
  },
  {
    id: 'challenge_cache_outage',
    title: 'Challenge 2: The Midnight Cache Collapse',
    difficulty: 'Advanced',
    badge: '⚠️ Redis Crash',
    goal: 'Restore system health during an abrupt Redis cache failure under 100,000 req/s.',
    description: 'A network partition crashed the Redis cluster. 95,000 raw read req/s are stampeding directly into the database. System latency is exceeding 800ms.',
    initialState: {
      traffic: 100000,
      readRatio: 0.95,
      apiServers: 12,
      redisEnabled: false,
      cacheHitRate: 0.94,
      readReplicas: 1,
      dbIndexed: true,
      redirectType: '302',
      failures: { redisDown: true, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
    },
    actions: [
      {
        id: 'restore_redis',
        label: '🔄 Restore & Warm Redis Cluster',
        description: 'Bring Redis nodes back online and resume in-memory caching',
        apply: (state) => ({
          ...state,
          redisEnabled: true,
          failures: { ...state.failures, redisDown: false }
        }),
        isCorrect: true,
        explanation: '✅ SYSTEM FULLY RECOVERED!\n\nBefore: DB Read Traffic: 95,000 reads/s (190% DB Load) | Latency: 920ms\nAfter: DB Read Traffic: 5,700 reads/s (11.4% DB Load) | Latency: 11.8ms\n\nWhy it worked:\nRestoring Redis immediately absorbed 89,300 reads/s (94%), reducing DB load by 16.7×.'
      },
      {
        id: 'add_more_replicas',
        label: '➕ Add 3 Read Replicas',
        description: 'Scale replica pool to absorb the stampede in raw SQL',
        apply: (state) => ({ ...state, readReplicas: state.readReplicas + 3 }),
        isCorrect: false,
        explanation: '🟡 EXPENSIVE WORKAROUND (Suboptimal)\n\nAdding 3 replicas (total 4) allows the DB to handle 95k reads/s (load drops to ~47%), but latency remains high (~22ms) and infrastructure costs quadruple compared to running an in-memory cache.'
      },
      {
        id: 'add_api_servers_ch2',
        label: '➕ Add 8 API Servers',
        description: 'Add compute instances to process requests faster',
        apply: (state) => ({ ...state, apiServers: state.apiServers + 8 }),
        isCorrect: false,
        explanation: '❌ DID NOT SOLVE THE BOTTLENECK\n\nAPI nodes were at 42% CPU. The bottleneck is the saturated database receiving 95,000 un-cached reads/s.'
      }
    ]
  },
  {
    id: 'challenge_write_spike',
    title: 'Challenge 3: Write-Heavy Flash Sale',
    difficulty: 'Expert',
    badge: '⚡ 80% Writes',
    goal: 'Scale an unprecedented write-heavy workload (80% URL creations, 20% reads) at 60,000 req/s.',
    description: 'During a marketing campaign, automated bots are generating millions of custom short URLs. Writes surged to 48,000 writes/s, exceeding Primary DB write capacity (10,000 writes/s).',
    initialState: {
      traffic: 60000,
      readRatio: 0.20, // 80% writes!
      apiServers: 10,
      redisEnabled: true,
      cacheHitRate: 0.94,
      readReplicas: 3,
      dbIndexed: true,
      redirectType: '302',
      failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
    },
    actions: [
      {
        id: 'add_replicas_ch3',
        label: '➕ Add 4 Read Replicas',
        description: 'Add database read replicas',
        apply: (state) => ({ ...state, readReplicas: state.readReplicas + 4 }),
        isCorrect: false,
        explanation: '❌ CORE SYSTEM DESIGN LESSON!\n\nRead replicas ONLY process read queries (`SELECT`). All 48,000 write operations (`INSERT INTO urls...`) must still go to the Primary DB master. Primary DB write load remained pegged at 480%!'
      },
      {
        id: 'scale_primary_write',
        label: '🚀 Scale Primary DB Write Capacity',
        description: 'Upgrade primary instance & enable WAL write batching to handle 50k writes/s',
        apply: (state) => ({ ...state, apiServers: 12 }),
        customEffect: { dbPrimaryWriteCapacity: 60000 },
        isCorrect: true,
        explanation: '✅ WRITE BOTTLENECK SOLVED!\n\nBefore: Primary Write Load: 480% (10k cap) | Dropped writes: 38k/s\nAfter: Primary Write Load: 80% (60k cap) | Dropped writes: 0\n\nKey Takeaway:\nWrite-heavy workloads require scaling write master capacity, sharding, or asynchronous message queuing. Read replicas do not help writes!'
      },
      {
        id: 'increase_cache_hit_rate',
        label: '⚡ Increase Redis Memory',
        description: 'Enlarge Redis cache size to hit 99% hit rate',
        apply: (state) => ({ ...state, cacheHitRate: 0.99 }),
        isCorrect: false,
        explanation: '❌ INEFFECTIVE FOR WRITES!\n\nEven with 99% cache hit rate, reads were only 20% of traffic (12k/s). The 48,000 writes/s bypass read cache entirely and overload the primary database.'
      }
    ]
  }
];

export class ChallengeModeManager {
  constructor(containerEl, onStateChange, onActionApplied) {
    this.containerEl = containerEl;
    this.onStateChange = onStateChange;
    this.onActionApplied = onActionApplied;
    this.activeChallengeIndex = 0;
    this.lastFeedback = null;
  }

  render() {
    if (!this.containerEl) return;
    const challenge = CHALLENGES[this.activeChallengeIndex];

    let html = `
      <div class="challenge-wrapper">
        <div class="challenge-header-bar">
          <div class="challenge-selector-tabs">
    `;

    CHALLENGES.forEach((c, idx) => {
      const activeClass = idx === this.activeChallengeIndex ? 'tab-active' : '';
      html += `
        <button class="btn-challenge-tab ${activeClass}" data-challenge-index="${idx}">
          ${c.title.split(':')[0]}
        </button>
      `;
    });

    html += `
          </div>
          <span class="challenge-badge">${challenge.badge}</span>
        </div>

        <div class="challenge-card">
          <div class="challenge-title-row">
            <div>
              <h3>${challenge.title}</h3>
              <div class="challenge-meta">
                <span class="diff-badge">${challenge.difficulty}</span>
                <span class="goal-text"><strong>🎯 Goal:</strong> ${challenge.goal}</span>
              </div>
            </div>
            <button class="btn-secondary" id="btn-reset-challenge" style="font-size: 0.8rem; font-weight: 600;">
              🔄 Load Challenge State
            </button>
          </div>

          <div class="challenge-goal-box">
            <div class="goal-label">Mission Briefing:</div>
            <p class="challenge-desc">${challenge.description}</p>
          </div>

          <div class="challenge-actions-section">
            <h4>🛠️ What do you want to try? (Choose an architectural action)</h4>
            <div class="actions-grid">
    `;

    challenge.actions.forEach((act, actIdx) => {
      html += `
        <div class="action-card" data-action-index="${actIdx}">
          <div class="action-header">
            <div class="action-title">${act.label}</div>
            <div class="action-desc">${act.description}</div>
          </div>
          <button class="btn-execute-action">Apply Decision</button>
        </div>
      `;
    });

    html += `
            </div>
          </div>

          ${this.lastFeedback ? `
            <div class="feedback-box ${this.lastFeedback.isCorrect ? 'feedback-success' : 'feedback-failure'}">
              <div style="font-weight: 700; font-size: 0.95rem; margin-bottom: 0.5rem;">
                ${this.lastFeedback.isCorrect ? '🎉 EXCELLENT ARCHITECTURAL DECISION!' : '❌ THIS DID NOT SOLVE THE BOTTLENECK'}
              </div>
              <div>${this.lastFeedback.explanation}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    this.containerEl.innerHTML = html;
    this.attachListeners();
  }

  attachListeners() {
    // Challenge Tab switching
    this.containerEl.querySelectorAll('.btn-challenge-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-challenge-index'), 10);
        this.activeChallengeIndex = idx;
        this.lastFeedback = null;
        this.loadCurrentChallenge();
      });
    });

    // Reset/Load button
    const resetBtn = this.containerEl.querySelector('#btn-reset-challenge');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.lastFeedback = null;
        this.loadCurrentChallenge();
      });
    }

    // Action cards
    this.containerEl.querySelectorAll('.action-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const actIdx = parseInt(e.currentTarget.getAttribute('data-action-index'), 10);
        this.applyAction(actIdx);
      });
    });
  }

  loadCurrentChallenge() {
    const challenge = CHALLENGES[this.activeChallengeIndex];
    if (this.onStateChange) {
      this.onStateChange(challenge.initialState);
    }
    this.render();
  }

  applyAction(actionIndex) {
    const challenge = CHALLENGES[this.activeChallengeIndex];
    const action = challenge.actions[actionIndex];
    if (!action) return;

    this.lastFeedback = {
      isCorrect: action.isCorrect,
      explanation: action.explanation
    };

    if (action.isCorrect) {
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 }
        });
      } catch {
        // graceful fallback if canvas blocked
      }
    }

    if (this.onActionApplied) {
      this.onActionApplied(action);
    }

    this.render();
  }
}
