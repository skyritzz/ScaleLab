/**
 * Causal Simulation Calculation Engine
 * 
 * Implements strict architectural separation:
 * 1. Reads vs Writes
 * 2. Primary DB (Writes) vs Read Replica Pool (Reads)
 * 3. Cache HIT vs Cache MISS
 * 4. Capacity ceilings & explainable queueing delay
 */

export class SimulationModel {
  constructor(config) {
    this.config = { ...config };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Run the deterministic causal simulation based on current state.
   */
  calculate(state) {
    const cfg = this.config;
    const traffic = Math.max(1, Math.round(state.traffic));
    const readRatio = state.readRatio ?? cfg.readRatio;
    const writeRatio = 1 - readRatio;

    // 1. Separate Read and Write Traffic
    const totalReads = Math.round(traffic * readRatio);
    const totalWrites = Math.round(traffic * writeRatio);

    // 2. Active Nodes considering Failures
    const isOneApiDead = Boolean(state.failures?.oneApiNodeDead);
    const activeApiServers = isOneApiDead ? Math.max(0, state.apiServers - 1) : state.apiServers;
    const isOneReplicaDead = Boolean(state.failures?.oneReplicaDead);
    const activeReplicas = isOneReplicaDead ? Math.max(0, state.readReplicas - 1) : state.readReplicas;
    const isRedisActive = state.redisEnabled && !state.failures?.redisDown;
    const isDbDown = Boolean(state.failures?.dbDown);
    const isDbIndexed = Boolean(state.dbIndexed);

    // 3. Redis Cache Calculations
    const hitRate = isRedisActive ? state.cacheHitRate : 0;
    const missRate = 1 - hitRate;
    const cacheHits = isRedisActive ? Math.round(totalReads * hitRate) : 0;
    const cacheMisses = isRedisActive ? Math.round(totalReads * missRate) : totalReads;
    
    // Dynamic multiplier for "What if Redis is removed?"
    const cacheMultiplier = isRedisActive ? (1 / Math.max(0.001, (1 - state.cacheHitRate))) : 1;
    const redisOps = isRedisActive ? (totalReads + cacheMisses) : 0; // GETs + SETEX writebacks
    const redisLoad = isRedisActive ? (redisOps / cfg.redisCapacity) : 0;

    // 4. Database Traffic & Capacity Modeling
    const dbReadTraffic = isDbDown ? 0 : cacheMisses;
    const dbWriteTraffic = isDbDown ? 0 : totalWrites;

    // Index efficiency penalty: Full table scan takes ~8x more CPU cycles
    const indexCapacityMultiplier = isDbIndexed ? 1.0 : 0.15;

    // Primary DB Write Capacity
    const primaryWriteCap = cfg.dbPrimaryWriteCapacity;
    const dbWriteLoad = isDbDown ? 1.0 : (totalWrites / primaryWriteCap);

    // Read Replica Pool vs Standalone Primary Read Capacity
    let totalReadCap = 0;
    let dbReadLoad = 0;

    if (activeReplicas > 0) {
      totalReadCap = activeReplicas * cfg.dbReplicaReadCapacity * indexCapacityMultiplier;
      dbReadLoad = isDbDown ? 1.0 : (cacheMisses / totalReadCap);
    } else {
      // 0 replicas: Primary handles both writes and reads
      // If 1 replica was killed when readReplicas was 0, it degrades standalone capacity by 50%
      const standaloneMultiplier = (isOneReplicaDead && state.readReplicas === 0) ? 0.5 : 1.0;
      totalReadCap = cfg.dbPrimaryStandaloneReadCap * indexCapacityMultiplier * standaloneMultiplier;
      dbReadLoad = isDbDown ? 1.0 : (cacheMisses / totalReadCap);
    }

    // Combined DB bottleneck indicator
    const maxDbLoad = Math.max(dbWriteLoad, dbReadLoad);

    // 5. API Cluster Capacity & Load
    const totalApiCapacity = activeApiServers * cfg.apiNodeCapacity;
    const isApiCompletelyDown = (activeApiServers === 0);
    const apiLoad = isApiCompletelyDown ? 10.0 : (traffic / totalApiCapacity);

    // 6. Overall System Bottleneck Identification
    const utilizations = [
      { name: isApiCompletelyDown ? 'API Cluster (0 Servers Online)' : 'API Cluster', load: apiLoad, capacity: totalApiCapacity, current: traffic },
      { name: 'Database (Writes)', load: dbWriteLoad, capacity: primaryWriteCap, current: totalWrites },
      { name: 'Database (Reads)', load: dbReadLoad, capacity: totalReadCap, current: cacheMisses },
      { name: 'Redis Cache', load: redisLoad, capacity: cfg.redisCapacity, current: redisOps }
    ];

    utilizations.sort((a, b) => b.load - a.load);
    const primaryBottleneck = utilizations[0];
    const systemMaxUtilization = isApiCompletelyDown ? 10.0 : primaryBottleneck.load;

    // 7. Throughput & Dropped Requests (Throughput Ceiling)
    let throughput = traffic;
    let droppedTraffic = 0;
    let errorRate = 0;

    if (isApiCompletelyDown) {
      // 0 API servers = 100% 502 Bad Gateway
      throughput = 0;
      droppedTraffic = traffic;
      errorRate = 1.0;
    } else if (isDbDown) {
      // If DB is down, cache hits still succeed! Misses and writes fail.
      throughput = cacheHits;
      droppedTraffic = cacheMisses + totalWrites;
      errorRate = droppedTraffic / traffic;
    } else if (systemMaxUtilization > 1.0) {
      // Demand exceeds capacity: throughput plateaus at maximum capacity
      const capacityRatio = 1.0 / systemMaxUtilization;
      throughput = Math.round(traffic * capacityRatio);
      droppedTraffic = traffic - throughput;
      errorRate = droppedTraffic / traffic;
    }

    // 8. Explainable Latency Model (M/M/1-inspired queueing approximation)
    // Base latencies
    const dbReadBaseLatency = isDbIndexed ? cfg.dbIndexedReadLatency : cfg.dbUnindexedReadLatency;
    const hitLatency = cfg.baseNetworkLatency + cfg.apiProcessingLatency + cfg.redisLatency;
    const missLatency = cfg.baseNetworkLatency + cfg.apiProcessingLatency + (isRedisActive ? cfg.redisLatency : 0) + dbReadBaseLatency + (isRedisActive ? cfg.redisLatency : 0);
    const writeBaseLatency = cfg.baseNetworkLatency + cfg.apiProcessingLatency + cfg.dbWriteLatency;

    // Weighted base processing latency
    let weightedBaseLatency = 0;
    if (traffic > 0) {
      const readComponent = totalReads * (hitRate * hitLatency + (1 - hitRate) * missLatency);
      const writeComponent = totalWrites * writeBaseLatency;
      weightedBaseLatency = (readComponent + writeComponent) / traffic;
    }

    // Queueing delay increases sharply as utilization approaches and exceeds 100%
    let queueingDelay = 0;
    if (systemMaxUtilization > 0.65) {
      const u = Math.min(systemMaxUtilization, 0.999);
      // Normalized queueing approximation: 3ms * (u / (1 - u))
      queueingDelay = Math.min(1200, 3.5 * (u / (1 - u)));
    }
    if (systemMaxUtilization >= 1.0) {
      queueingDelay += Math.min(2000, (systemMaxUtilization - 1.0) * 800);
    }
    if (state.failures?.extraLatencyMs) {
      queueingDelay += state.failures.extraLatencyMs;
    }

    const avgLatency = isDbDown 
      ? (cacheHits > 0 ? (hitLatency * (cacheHits / traffic) + 1500 * (droppedTraffic / traffic)) : 1500)
      : Math.round((weightedBaseLatency + queueingDelay) * 10) / 10;

    // 9. Causal "Why?" Math Breakdowns for each UI Card
    const mathBreakdowns = {
      api: {
        summary: `${traffic.toLocaleString()} req/s ÷ (${activeApiServers} servers × ${cfg.apiNodeCapacity.toLocaleString()} cap) = ${(apiLoad * 100).toFixed(1)}%`,
        steps: [
          `Total Incoming Demand: ${traffic.toLocaleString()} req/s`,
          `Active API Nodes: ${activeApiServers} ${state.failures?.oneApiNodeDead ? '(1 node failed)' : ''}`,
          `Node Capacity: ${cfg.apiNodeCapacity.toLocaleString()} req/s each`,
          `Total Cluster Capacity: ${totalApiCapacity.toLocaleString()} req/s`,
          `Formula: ${traffic.toLocaleString()} ÷ ${totalApiCapacity.toLocaleString()} = ${(apiLoad * 100).toFixed(1)}% load`
        ]
      },
      redis: {
        summary: isRedisActive
          ? `${totalReads.toLocaleString()} reads × ${(hitRate * 100).toFixed(0)}% hit = ${cacheHits.toLocaleString()} hits/s (absorbs ${(hitRate * 100).toFixed(0)}% of traffic)`
          : `Redis is DISABLED / DOWN → 0 hits, all ${totalReads.toLocaleString()} reads fall through to Database`,
        steps: isRedisActive ? [
          `Total Read Demand: ${totalReads.toLocaleString()} req/s (${(readRatio * 100).toFixed(0)}% of total)`,
          `Cache Hit Rate: ${(hitRate * 100).toFixed(1)}%`,
          `Cache Hits Absorbed: ${cacheHits.toLocaleString()} req/s (~${cfg.redisLatency}ms)`,
          `Cache Misses Leaked: ${cacheMisses.toLocaleString()} req/s (${(missRate * 100).toFixed(1)}%)`,
          `If Redis was removed: DB reads would spike by ${cacheMultiplier.toFixed(1)}× (${cacheMisses.toLocaleString()} → ${totalReads.toLocaleString()}/s)`
        ] : [
          `Redis is currently DISABLED or OFFLINE`,
          `Cache Hit Rate: 0%`,
          `All ${totalReads.toLocaleString()} reads/s hit Database directly`,
          `Enabling Redis at ${(state.cacheHitRate * 100).toFixed(0)}% would reduce DB reads by ${((1 - (1 - state.cacheHitRate)) * 100).toFixed(0)}%`
        ]
      },
      dbWrites: {
        summary: `${totalWrites.toLocaleString()} writes/s ÷ ${primaryWriteCap.toLocaleString()} primary capacity = ${(dbWriteLoad * 100).toFixed(1)}%`,
        steps: [
          `Total Write Demand: ${totalWrites.toLocaleString()} req/s (${(writeRatio * 100).toFixed(0)}% of total)`,
          `Primary DB Write Limit: ${primaryWriteCap.toLocaleString()} writes/s`,
          `Formula: ${totalWrites.toLocaleString()} ÷ ${primaryWriteCap.toLocaleString()} = ${(dbWriteLoad * 100).toFixed(1)}% primary write load`,
          `Note: Read replicas CANNOT absorb write traffic.`
        ]
      },
      dbReads: {
        summary: `${cacheMisses.toLocaleString()} cache misses/s ÷ ${totalReadCap.toLocaleString()} read capacity = ${(dbReadLoad * 100).toFixed(1)}%`,
        steps: [
          `Cache Misses Reaching DB: ${cacheMisses.toLocaleString()} reads/s`,
          activeReplicas > 0 
            ? `Active Read Replicas: ${activeReplicas} × ${(cfg.dbReplicaReadCapacity * indexCapacityMultiplier).toLocaleString()} cap each = ${totalReadCap.toLocaleString()} total`
            : `Standalone Primary DB Read Capacity: ${totalReadCap.toLocaleString()} reads/s`,
          `Index Status: ${isDbIndexed ? '✅ B-Tree Index Active (O(log N) fast lookup)' : '⚠️ UNINDEXED (Full table scan reduces throughput ~85%)'}`,
          `Formula: ${cacheMisses.toLocaleString()} ÷ ${totalReadCap.toLocaleString()} = ${(dbReadLoad * 100).toFixed(1)}% read pool load`
        ]
      },
      latency: {
        summary: `Base RTT (~${weightedBaseLatency.toFixed(1)}ms) + Queueing Delay (${queueingDelay.toFixed(1)}ms) = ${avgLatency.toFixed(1)}ms`,
        steps: [
          `Base Network RTT: ~${cfg.baseNetworkLatency}ms`,
          `API Serialization & Logic: ~${cfg.apiProcessingLatency}ms`,
          isRedisActive ? `Redis Hit Path (~${(hitRate * 100).toFixed(0)}%): ~${hitLatency.toFixed(1)}ms` : 'Redis: Bypassed (0% hits)',
          `DB Miss Path (~${(missRate * 100).toFixed(0)}%): ~${missLatency.toFixed(1)}ms (${isDbIndexed ? 'Indexed' : 'Unindexed Scan'})`,
          `System Utilization: ${(systemMaxUtilization * 100).toFixed(1)}% → Queueing Delay: +${queueingDelay.toFixed(1)}ms`
        ]
      }
    };

    return {
      traffic,
      readRatio,
      writeRatio,
      totalReads,
      totalWrites,
      activeApiServers,
      activeReplicas,
      isRedisActive,
      isDbDown,
      isDbIndexed,
      hitRate,
      missRate,
      cacheHits,
      cacheMisses,
      cacheMultiplier,
      redisOps,
      redisLoad,
      dbReadTraffic,
      dbWriteTraffic,
      totalApiCapacity,
      primaryWriteCap,
      totalReadCap,
      apiLoad,
      dbWriteLoad,
      dbReadLoad,
      maxDbLoad,
      systemMaxUtilization,
      primaryBottleneck,
      throughput,
      droppedTraffic,
      errorRate,
      weightedBaseLatency,
      queueingDelay,
      avgLatency,
      mathBreakdowns
    };
  }
}
