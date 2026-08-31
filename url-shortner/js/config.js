/**
 * Simulation Configuration & Default Assumptions
 * All values are inspectable and adjustable via the "Simulation Assumptions" panel.
 */
export const DEFAULT_CONFIG = {
  // Infrastructure Unit Capacities (Tuned to reference simulator)
  apiNodeCapacity: 30000,          // 30k req/s per API node instance
  redisCapacity: 500000,           // 500k ops/s for Redis in-memory cache
  dbPrimaryWriteCapacity: 10000,   // 10k write req/s for Primary DB
  dbReplicaReadCapacity: 25000,    // 25k read req/s per Read Replica
  dbPrimaryStandaloneReadCap: 10000,// 10k read req/s if 0 replicas (Standalone DB)

  // Default System Architecture State (Clean starting baseline: 1 server, 0 replicas, 1.0k traffic)
  traffic: 1000,                   // 1.0k requests/sec
  readRatio: 0.95,                 // 95% reads, 5% writes
  apiServers: 1,                   // 1 API server instance on startup
  redisEnabled: false,             // Redis caching disabled by default
  cacheHitRate: 0.94,              // 94% cache hit rate when enabled
  readReplicas: 0,                 // 0 read replicas on startup
  dbIndexed: true,                 // B-Tree index on short_code is active
  redirectType: '302',             // '302' Found (temporary) vs '301' (permanent)

  // Latency Constants (milliseconds)
  baseNetworkLatency: 6,           // client-to-gateway round trip (ms)
  apiProcessingLatency: 2.5,       // API compute & serialization (ms)
  redisLatency: 1.2,               // in-memory key-value lookup (ms)
  dbIndexedReadLatency: 12,        // indexed B-Tree point query (ms)
  dbUnindexedReadLatency: 140,     // unindexed full-table sequential scan (ms)
  dbWriteLatency: 18,              // primary write + WAL commit (ms)

  // Active Failure Injections
  failures: {
    redisDown: false,
    oneApiNodeDead: false,
    oneReplicaDead: false,
    dbDown: false,
    extraLatencyMs: 0
  }
};

export const SCENARIO_PRESETS = {
  startup: {
    name: '🌱 Small Startup',
    description: '100 req/s, 1 API server, No Redis, 1 Standalone DB (0 replicas)',
    traffic: 100,
    readRatio: 0.95,
    apiServers: 1,
    redisEnabled: false,
    cacheHitRate: 0.90,
    readReplicas: 0,
    dbIndexed: true,
    redirectType: '302',
    failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
  },
  growing: {
    name: '🚀 Growing System',
    description: '10,000 req/s, 3 API servers, Redis ON (90% hit rate), 1 DB (0 replicas)',
    traffic: 10000,
    readRatio: 0.95,
    apiServers: 3,
    redisEnabled: true,
    cacheHitRate: 0.90,
    readReplicas: 0,
    dbIndexed: true,
    redirectType: '302',
    failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
  },
  viral: {
    name: '🔥 Viral Traffic Surge',
    description: '250,000 req/s, 14 API servers, Redis ON (94% hit rate), 3 Read Replicas',
    traffic: 250000,
    readRatio: 0.95,
    apiServers: 14,
    redisEnabled: true,
    cacheHitRate: 0.94,
    readReplicas: 3,
    dbIndexed: true,
    redirectType: '302',
    failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: false, extraLatencyMs: 0 }
  },
  cacheFailure: {
    name: '⚠️ Cache Failure',
    description: '100,000 req/s, Redis abruptly crashes. Observe database read stampede!',
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
  dbFailure: {
    name: '💥 Primary DB Outage',
    description: 'Database is down. Cache hits continue serving; misses & writes fail.',
    traffic: 100000,
    readRatio: 0.95,
    apiServers: 12,
    redisEnabled: true,
    cacheHitRate: 0.94,
    readReplicas: 2,
    dbIndexed: true,
    redirectType: '302',
    failures: { redisDown: false, oneApiNodeDead: false, oneReplicaDead: false, dbDown: true, extraLatencyMs: 0 }
  }
};
