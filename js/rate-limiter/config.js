/**
 * Rate Limiter Simulator Configuration & Presets
 * All values are inspectable via the "Assumptions" panel.
 */

/* ── Static Unit Capacities (Assumptions Modal) ── */
export const RL_ASSUMPTIONS = {
  gatewayCapacity:      25000,   // req/s per gateway node
  rateLimiterCapacity:  50000,   // checks/s per rate-limiter daemon
  redisShardCapacity:   10000,   // ops/s per Redis hash shard
  downstreamCapacity:   15000,   // req/s the downstream service can handle

  gatewayLatency:       1.0,     // ms, gateway processing
  localMemoryLatency:   0.2,     // ms, in-process hash-map check
  redisNetLatency:      2.0,     // ms, network round-trip to Redis
  redisExecLatency:     0.5,     // ms, Redis command execution
  downstreamLatency:    12.0,    // ms, downstream service processing
};

/* ── Default Simulation State ── */
export const RL_DEFAULT_STATE = {
  // Traffic & Identity Distribution
  traffic:            5000,
  activeIdentities:   500,
  trafficProfile:     'uniform',   // 'uniform' | 'heavy_tail' | 'abusive_spike'
  topIdentityRatio:   0.05,

  // Per-Identity Rate Limiting Policy
  algorithm:          'token_bucket', // 'token_bucket' | 'fixed_window' | 'sliding_window'
  limitPerUser:       100,
  bucketCapacity:     200,
  refillRate:         100,
  windowSizeSec:      1.0,

  // Infrastructure Topology
  gatewayNodes:       3,
  rateLimiterNodes:   2,
  tokenStore:         'redis',       // 'local_memory' | 'redis'
  redisShards:        4,
  atomicityMode:      'atomic',      // 'atomic' | 'non_atomic'
  failPolicy:         'fail_open',   // 'fail_open' | 'fail_closed'

  // Chaos Failures
  failures: {
    redisOutage:               false,
    redisLatencyMs:            0,
    oneGatewayDead:            false,
    oneLimiterDead:            false,
    clockDriftMs:              0,
    configPropagationDelay:    false,
    staleLimitValue:           500,
    hotKeyActive:              false,
    networkPartition:          false
  }
};

/* ── Traffic Profiles (Identity-Class Simulation) ──
 * Rather than simulating thousands of individual Redis keys, traffic is decomposed
 * into 3 canonical identity cohorts:
 *   - 'normal': baseline users operating well within limits
 *   - 'heavy': power users (top 1%) operating near limits
 *   - 'top': the single highest-volume identity or abusive actor
 *
 * CRITICAL INVARIANT: The sum of offered traffic across all cohorts must equal
 * the configured aggregate traffic T exactly.
 */
export function decomposeTraffic(traffic, activeIdentities, profile, topIdentityRatio) {
  const T = Math.max(1, Math.round(traffic));
  const N = Math.max(1, Math.round(activeIdentities));
  const topRatio = Math.max(0, Math.min(0.99, topIdentityRatio));
  const T_top = Math.round(T * topRatio);
  const T_rest = Math.max(0, T - T_top);

  let normalCount, heavyCount, normalRate, heavyRate;

  if (N <= 1) {
    // Single identity carries all traffic
    return {
      normalCount: 0,
      normalRate: 0,
      heavyCount: 0,
      heavyRate: 0,
      topCount: 1,
      topRate: T,
      topIdentityRatio: 1.0,
      totalOfferedRPS: T,
      simulationType: 'identity-class simulation'
    };
  }

  switch (profile) {
    case 'heavy_tail': {
      heavyCount = Math.max(1, Math.round(N * 0.01));
      normalCount = Math.max(1, N - heavyCount - 1);
      // Allocate heavy traffic (~25% of rest or bounded rate)
      const targetHeavyTotal = Math.min(T_rest * 0.4, heavyCount * 90);
      heavyRate = heavyCount > 0 ? targetHeavyTotal / heavyCount : 0;
      const actualHeavyTotal = heavyCount * heavyRate;
      const normalTotal = Math.max(0, T_rest - actualHeavyTotal);
      normalRate = normalCount > 0 ? normalTotal / normalCount : 0;
      break;
    }

    case 'abusive_spike': {
      heavyCount = Math.max(1, Math.round(N * 0.009));
      normalCount = Math.max(1, N - heavyCount - 1);
      const heavyTotal = T_rest * 0.15;
      heavyRate = heavyCount > 0 ? heavyTotal / heavyCount : 0;
      const normalTotal = Math.max(0, T_rest - heavyTotal);
      normalRate = normalCount > 0 ? normalTotal / normalCount : 0;
      break;
    }

    case 'uniform':
    default: {
      normalCount = Math.max(1, N - 1);
      heavyCount = 0;
      heavyRate = 0;
      normalRate = normalCount > 0 ? T_rest / normalCount : 0;
      break;
    }
  }

  normalRate = Math.max(0, normalRate);
  heavyRate = Math.max(0, heavyRate);

  return {
    normalCount: Math.max(0, normalCount),
    normalRate,
    heavyCount: Math.max(0, heavyCount),
    heavyRate,
    topCount: 1,
    topRate: T_top,
    topIdentityRatio: topRatio,
    totalOfferedRPS: T,
    simulationType: 'identity-class simulation'
  };
}

/* ── Scenario Presets ── */
export const RL_PRESETS = {
  normal: {
    name: '🌱 Normal API Traffic',
    description: '5,000 req/s, 500 users, 3 gateways, Redis active, uniform traffic',
    traffic: 5000, activeIdentities: 500, trafficProfile: 'uniform',
    topIdentityRatio: 0.05, algorithm: 'token_bucket',
    limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
    gatewayNodes: 3, rateLimiterNodes: 2, tokenStore: 'redis', redisShards: 4,
    atomicityMode: 'atomic', failPolicy: 'fail_open',
    failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
      oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
      staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
  },
  flash_sale: {
    name: '🔥 Flash Sale Burst',
    description: '40,000 req/s burst, 2000 users, Token Bucket burst absorption test',
    traffic: 40000, activeIdentities: 2000, trafficProfile: 'heavy_tail',
    topIdentityRatio: 0.15, algorithm: 'token_bucket',
    limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
    gatewayNodes: 5, rateLimiterNodes: 3, tokenStore: 'redis', redisShards: 4,
    atomicityMode: 'atomic', failPolicy: 'fail_open',
    failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
      oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
      staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
  },
  botnet: {
    name: '🤖 Distributed API Abuse',
    description: '20,000 req/s, 1 abusive user = 45% traffic, local memory leakage demo',
    traffic: 20000, activeIdentities: 1000, trafficProfile: 'abusive_spike',
    topIdentityRatio: 0.465, algorithm: 'token_bucket',
    limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
    gatewayNodes: 3, rateLimiterNodes: 2, tokenStore: 'local_memory', redisShards: 4,
    atomicityMode: 'non_atomic', failPolicy: 'fail_open',
    failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
      oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
      staleLimitValue: 500, hotKeyActive: false, networkPartition: false }
  },
  global_spike: {
    name: '🌍 Global Traffic Spike',
    description: '80,000 req/s, hot-key shard saturation, Redis bottleneck',
    traffic: 80000, activeIdentities: 5000, trafficProfile: 'abusive_spike',
    topIdentityRatio: 0.40, algorithm: 'sliding_window',
    limitPerUser: 100, bucketCapacity: 200, refillRate: 100, windowSizeSec: 1.0,
    gatewayNodes: 6, rateLimiterNodes: 4, tokenStore: 'redis', redisShards: 4,
    atomicityMode: 'atomic', failPolicy: 'fail_closed',
    failures: { redisOutage: false, redisLatencyMs: 0, oneGatewayDead: false,
      oneLimiterDead: false, clockDriftMs: 0, configPropagationDelay: false,
      staleLimitValue: 500, hotKeyActive: true, networkPartition: false }
  }
};
