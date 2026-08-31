/**
 * Intelligent Bottleneck Engine & Dynamic "Why?" Explanations
 * Analyzes active simulation metrics, determines exact root causes,
 * generates dynamic remediation tips, and logs causal event transitions.
 */

export class BottleneckEngine {
  constructor() {
    this.previousState = null;
    this.previousMetrics = null;
    this.history = [];
  }

  /**
   * Evaluate health and pinpoint the active system bottleneck.
   */
  evaluate(metrics, state) {
    let status = 'HEALTHY';
    let statusColor = 'emerald';
    let statusIcon = '🟢';
    let title = 'SYSTEM HEALTHY & BALANCED';
    let bottleneckComponent = 'None';
    let why = [];
    let tryTip = '';

    // Check Failures first
    if (metrics.isDbDown) {
      status = 'OUTAGE';
      statusColor = 'rose';
      statusIcon = '💥';
      title = 'PRIMARY DATABASE OUTAGE';
      bottleneckComponent = 'Database (Offline)';
      why = [
        `Database is completely unreachable.`,
        metrics.isRedisActive 
          ? `Cache hits (${metrics.cacheHits.toLocaleString()} req/s) are still being served from in-memory Redis! This demonstrates cache resilience.`
          : `Redis is also disabled, so 100% of requests are failing.`,
        `All writes (${metrics.totalWrites.toLocaleString()}/s) and cache misses (${metrics.cacheMisses.toLocaleString()}/s) are failing with HTTP 500/503.`
      ];
      tryTip = 'Restore the database service in the Failure Lab panel.';
    } else if (metrics.systemMaxUtilization >= 1.0) {
      status = 'BOTTLENECK';
      statusColor = 'rose';
      statusIcon = '🔴';

      if (metrics.primaryBottleneck.name === 'API Cluster') {
        title = 'API CLUSTER SATURATED';
        bottleneckComponent = 'API Servers';
        why = [
          `Total traffic (${metrics.traffic.toLocaleString()} req/s) exceeds API cluster capacity (${metrics.totalApiCapacity.toLocaleString()} req/s).`,
          `API nodes are running at ${(metrics.apiLoad * 100).toFixed(0)}% CPU, causing HTTP connection backlog.`,
          `Database is operating smoothly (${(metrics.maxDbLoad * 100).toFixed(0)}% load), so the database is NOT the bottleneck.`
        ];
        tryTip = `Add more API server instances to scale cluster throughput.`;
      } else if (metrics.primaryBottleneck.name === 'Database (Writes)') {
        title = 'PRIMARY DB WRITE BOTTLENECK';
        bottleneckComponent = 'Database Primary (Writes)';
        why = [
          `Write traffic (${metrics.totalWrites.toLocaleString()} writes/s) exceeds primary write capacity (${metrics.primaryWriteCap.toLocaleString()} writes/s).`,
          `Write utilization is ${(metrics.dbWriteLoad * 100).toFixed(0)}%. Note: Read replicas CANNOT process writes.`,
          `API servers have spare capacity (${(metrics.apiLoad * 100).toFixed(0)}% load).`
        ];
        tryTip = `Scale primary write capacity, enable async write batching, or adjust read/write ratio.`;
      } else if (metrics.primaryBottleneck.name === 'Database (Reads)') {
        title = 'DATABASE READ POOL BOTTLENECK';
        bottleneckComponent = 'Database (Reads)';
        why = [
          `Cache misses (${metrics.cacheMisses.toLocaleString()} reads/s) exceed DB read capacity (${metrics.totalReadCap.toLocaleString()} reads/s).`,
          !metrics.isRedisActive 
            ? `Redis is DISABLED: 100% of read traffic is hitting the database directly.`
            : `Even with ${(metrics.hitRate * 100).toFixed(0)}% cache hit rate, the remaining ${(metrics.missRate * 100).toFixed(0)}% miss traffic overwhelms the database.`,
          !metrics.isDbIndexed ? `⚠️ Database index is MISSING: Full table scans reduce DB capacity drastically.` : `Database read load is ${(metrics.dbReadLoad * 100).toFixed(0)}%.`
        ];
        tryTip = !metrics.isRedisActive 
          ? `Enable Redis caching to absorb ~${(state.cacheHitRate * 100).toFixed(0)}% of read queries.`
          : (!metrics.isDbIndexed 
              ? `Re-enable B-Tree index on short_code for O(log N) lookups.` 
              : `Add read replicas to distribute query load across multiple replica nodes.`);
      } else {
        title = 'REDIS CACHE SATURATED';
        bottleneckComponent = 'Redis Cluster';
        why = [
          `Redis operations (${metrics.redisOps.toLocaleString()} ops/s) exceed configured Redis cluster capacity.`,
          `Memory bus or network bandwidth saturation on cache nodes.`
        ];
        tryTip = `Scale Redis cluster nodes or implement client-side local caching.`;
      }
    } else if (metrics.systemMaxUtilization >= 0.75) {
      status = 'WARNING';
      statusColor = 'amber';
      statusIcon = '🟡';
      title = 'SYSTEM NEARING CAPACITY';
      bottleneckComponent = `${metrics.primaryBottleneck.name} (${(metrics.primaryBottleneck.load * 100).toFixed(0)}%)`;
      why = [
        `${metrics.primaryBottleneck.name} is operating at ${(metrics.primaryBottleneck.load * 100).toFixed(0)}% utilization.`,
        `Latency is beginning to elevate (+${metrics.queueingDelay.toFixed(0)}ms queueing) due to request concurrency.`,
        `System is currently healthy, but traffic spikes could induce a bottleneck.`
      ];
      tryTip = `Consider scaling ${metrics.primaryBottleneck.name.toLowerCase()} before traffic increases further.`;
    } else {
      // HEALTHY
      status = 'HEALTHY';
      statusColor = 'emerald';
      statusIcon = '🟢';
      title = 'SYSTEM HEALTHY & BALANCED';
      bottleneckComponent = 'None';
      why = [
        metrics.isRedisActive 
          ? `Redis absorbs ${(metrics.hitRate * 100).toFixed(0)}% of read traffic (${metrics.cacheHits.toLocaleString()} req/s) in ~1.2ms.`
          : `Traffic is low enough that database handles raw reads without caching.`,
        `API cluster has spare capacity (${(metrics.apiLoad * 100).toFixed(0)}% load across ${metrics.activeApiServers} servers).`,
        `Database primary write load is ${(metrics.dbWriteLoad * 100).toFixed(0)}% and read load is ${(metrics.dbReadLoad * 100).toFixed(0)}%.`
      ];
      tryTip = `Try increasing traffic slider to find the next bottleneck threshold!`;
    }

    return {
      status,
      statusColor,
      statusIcon,
      title,
      bottleneckComponent,
      why,
      tryTip
    };
  }

  /**
   * Generates a structured "What Just Happened?" causal step-by-step summary
   */
  generateWhatJustHappened(prevMetrics, currMetrics, prevState, currState) {
    if (!prevMetrics) return null;

    const changes = [];
    const causalSteps = [];
    let lesson = '';

    // Detect parameter changes
    if (currState.traffic !== prevState.traffic) {
      const ratio = (currState.traffic / prevState.traffic).toFixed(1);
      changes.push(`Traffic changed from ${prevState.traffic.toLocaleString()} → ${currState.traffic.toLocaleString()} req/s (${ratio}×)`);
    }
    if (currState.apiServers !== prevState.apiServers) {
      changes.push(`API servers changed from ${prevState.apiServers} → ${currState.apiServers}`);
    }
    if (currState.redisEnabled !== prevState.redisEnabled) {
      changes.push(`Redis cache toggled ${currState.redisEnabled ? 'ON' : 'OFF'}`);
    }
    if (currState.readReplicas !== prevState.readReplicas) {
      changes.push(`Read replicas changed from ${prevState.readReplicas} → ${currState.readReplicas}`);
    }
    if (currState.dbIndexed !== prevState.dbIndexed) {
      changes.push(`B-Tree Database Index toggled ${currState.dbIndexed ? 'ON' : 'OFF'}`);
    }

    if (changes.length === 0) return null;

    // Step 1: Upstream Demand
    causalSteps.push(`1. ${changes.join(', ')}.`);

    // Step 2: API Layer Response
    const apiDiff = (currMetrics.apiLoad - prevMetrics.apiLoad) * 100;
    causalSteps.push(`2. API cluster load ${apiDiff >= 0 ? 'increased' : 'decreased'} by ${Math.abs(apiDiff).toFixed(1)}% (now at ${(currMetrics.apiLoad * 100).toFixed(1)}%).`);

    // Step 3: Cache Behavior
    if (currMetrics.isRedisActive) {
      causalSteps.push(`3. Redis absorbed ${currMetrics.cacheHits.toLocaleString()} read req/s (${(currMetrics.hitRate * 100).toFixed(0)}% hits) in memory.`);
    } else {
      causalSteps.push(`3. Redis is OFF: all ${currMetrics.totalReads.toLocaleString()} reads/s fell through directly to the database.`);
    }

    // Step 4: Database Layer Impact
    const dbDiff = (currMetrics.maxDbLoad - prevMetrics.maxDbLoad) * 100;
    causalSteps.push(`4. Database workload shifted to ${currMetrics.cacheMisses.toLocaleString()} reads/s and ${currMetrics.totalWrites.toLocaleString()} writes/s (DB load: ${(currMetrics.maxDbLoad * 100).toFixed(1)}%).`);

    // Step 5: System Result
    const latDiff = currMetrics.avgLatency - prevMetrics.avgLatency;
    causalSteps.push(`5. Average end-to-end latency moved from ${prevMetrics.avgLatency.toFixed(1)}ms → ${currMetrics.avgLatency.toFixed(1)}ms (${latDiff >= 0 ? '+' : ''}${latDiff.toFixed(1)}ms).`);

    // Educational Lesson
    if (prevState.apiServers < currState.apiServers && prevMetrics.primaryBottleneck.name.includes('Database') && currMetrics.primaryBottleneck.name.includes('Database')) {
      lesson = `⚠️ Scaling the API layer when the database is the bottleneck does NOT increase throughput. Always scale the limiting constraint.`;
    } else if (prevState.redisEnabled && !currState.redisEnabled) {
      lesson = `💡 Disabling cache forced database reads to spike by ${currMetrics.cacheMultiplier.toFixed(1)}×. In read-heavy systems (95%+ reads), in-memory caching is foundational.`;
    } else if (!prevState.redisEnabled && currState.redisEnabled) {
      lesson = `✨ Enabling Redis shielded the database from ${(currMetrics.hitRate * 100).toFixed(0)}% of queries, drastically lowering DB load and p99 latency.`;
    } else if (currState.readReplicas > prevState.readReplicas && prevMetrics.dbReadLoad > 0.8) {
      lesson = `✅ Read replicas successfully distributed query traffic across ${currState.readReplicas} nodes, relieving read pressure. Note: Replicas do not scale write capacity.`;
    } else if (currMetrics.systemMaxUtilization < 0.80) {
      lesson = `🎯 All layers operating comfortably below capacity with balanced throughput and minimal queueing delay.`;
    } else {
      lesson = `🔍 Identifying where requests spend time (API vs Cache vs DB vs Queue) is key to diagnosing distributed bottlenecks.`;
    }

    return {
      changes,
      causalSteps,
      lesson
    };
  }

  /**
   * Log a before/after snapshot for the Comparison Ledger
   */
  recordTransition(prevState, currState, prevMetrics, currMetrics, changeDescription, whyItHelped) {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      changeDescription,
      whyItHelped,
      before: {
        traffic: prevState.traffic,
        apiLoad: (prevMetrics.apiLoad * 100).toFixed(1) + '%',
        dbLoad: (prevMetrics.maxDbLoad * 100).toFixed(1) + '%',
        latency: prevMetrics.avgLatency.toFixed(1) + 'ms',
        throughput: prevMetrics.throughput.toLocaleString() + ' req/s',
        bottleneck: prevMetrics.primaryBottleneck.name
      },
      after: {
        traffic: currState.traffic,
        apiLoad: (currMetrics.apiLoad * 100).toFixed(1) + '%',
        dbLoad: (currMetrics.maxDbLoad * 100).toFixed(1) + '%',
        latency: currMetrics.avgLatency.toFixed(1) + 'ms',
        throughput: currMetrics.throughput.toLocaleString() + ' req/s',
        bottleneck: currMetrics.primaryBottleneck.name
      }
    };

    this.history.unshift(entry);
    if (this.history.length > 8) {
      this.history.pop();
    }
    return entry;
  }
}
