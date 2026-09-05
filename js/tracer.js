/**
 * Request Tracer & Hop Inspector
 * Makes the request the protagonist:
 * - Animates packet movement through Browser -> API -> Redis -> Database -> Response
 * - Visual branching for Cache HIT vs Cache MISS
 * - Interactive Hop Inspector detailing HTTP headers, SQL statements, and architectural rationale
 * - Realistic 301 vs 302 redirect responses and database state management
 */

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class RequestTracer {
  constructor(containerEl, inspectorEl, tableEl, onRecordCreated) {
    this.containerEl = containerEl;
    this.inspectorEl = inspectorEl;
    this.tableEl = tableEl;
    this.onRecordCreated = onRecordCreated;

    this.counter = 125193; // Starting counter for Base62
    this.databaseRecords = [
      {
        id: 1,
        shortCode: 'aB92x',
        longUrl: 'https://github.com/torvalds/linux',
        createdAt: new Date(Date.now() - 3600000).toLocaleTimeString(),
        accessCount: 42,
        inCache: true
      },
      {
        id: 2,
        shortCode: 'k9L0z',
        longUrl: 'https://blog.bytebytego.com/p/ep1-url-shortener',
        createdAt: new Date(Date.now() - 1800000).toLocaleTimeString(),
        accessCount: 15,
        inCache: true
      },
      {
        id: 3,
        shortCode: 'm4X7w',
        longUrl: 'https://news.ycombinator.com',
        createdAt: new Date(Date.now() - 600000).toLocaleTimeString(),
        accessCount: 8,
        inCache: false
      }
    ];

    this.activeTrace = null;
    this.selectedHop = null;
    this.isTracing = false;
  }

  /**
   * Fetch real stored database records from GET /api/v1/urls
   */
  async loadDatabaseRecords() {
    try {
      const res = await fetch('/api/v1/urls');
      if (!res.ok) return;
      const json = await res.json();
      if (json && Array.isArray(json.data) && json.data.length > 0) {
        this.databaseRecords = json.data.map(r => ({
          id: r.id,
          shortCode: r.short_code,
          longUrl: r.long_url,
          createdAt: new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          accessCount: r.access_count || 0,
          inCache: true
        }));
        this.renderDatabaseTable();
        if (this.onRecordCreated) this.onRecordCreated();
      }
    } catch (err) {
      console.warn('[Tracer] Using fallback simulator records (backend unreachable):', err.message);
    }
  }

  /**
   * Base62 encoding utility
   */
  encodeBase62(num) {
    let s = '';
    while (num > 0) {
      s = BASE62_CHARS[num % 62] + s;
      num = Math.floor(num / 62);
    }
    return s || '0';
  }

  /**
   * Simple hash generator (simulates MD5/SHA256 truncated)
   */
  hashUrl(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash) + url.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36).substring(0, 6);
  }

  /**
   * Generate Short Code based on selected strategy
   */
  generateShortCode(longUrl, strategy) {
    if (strategy === 'hash') {
      return this.hashUrl(longUrl + Date.now());
    } else if (strategy === 'snowflake') {
      // 64-bit distributed snowflake ID simulation
      const timestamp = (Date.now() - 1600000000000) & 0x1FFFFFFFFFF;
      const workerId = 1;
      const sequence = (this.counter++ % 4096);
      const snowflakeId = (timestamp * 4096) + sequence;
      return this.encodeBase62(snowflakeId).substring(0, 7);
    } else {
      // Default: Counter + Base62
      this.counter += Math.floor(Math.random() * 5) + 1;
      return this.encodeBase62(this.counter);
    }
  }

  /**
   * Run Write Trace: POST /api/v1/urls
   */
  /**
   * Run Write Trace: POST /api/v1/urls
   * Sequence: Browser -> API -> Idempotency Check -> ID Generator -> Collision Check -> PostgreSQL -> Redis -> HTTP Response
   */
  async runWriteTrace(longUrl, strategy, redirectType, appState, realData = null, clientRttMs = 0, idempotencyKey = null) {
    if (this.isTracing) return;
    this.isTracing = true;

    const isReal = Boolean(realData && realData.telemetry);
    const tel = realData?.telemetry || {};
    const isReplay = Boolean(tel.idempotency_hit);
    const hasCollision = Boolean(tel.collision_detected);
    const collisionAttempts = Number(tel.collision_attempts) || 1;

    const shortCode = realData?.short_code || this.generateShortCode(longUrl, strategy);
    const shortUrl = realData?.short_url || `/${shortCode}`;
    const createdAt = realData?.created_at
      ? new Date(realData.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString();
    const httpStatus = tel.http_status || (isReplay ? 200 : 201);
    const keyDisplay = idempotencyKey || (isReal ? 'none' : 'sim-uuid-9b42');

    // Define the sequence of 8 hops for URL Creation
    const hops = [
      {
        id: 'client',
        label: 'Browser / Client',
        icon: '💻',
        role: 'Originating Client',
        isRealExecution: isReal,
        durationMs: clientRttMs || 14,
        request: `POST /api/v1/urls HTTP/1.1\nHost: ${window.location.host || 'api.sho.rt'}\nContent-Type: application/json\nIdempotency-Key: ${keyDisplay}\n\n{\n  "url": "${longUrl}",\n  "strategy": "${strategy}",\n  "redirect_mode": ${redirectType}\n}`,
        whatIsHappening: isReal
          ? `REAL HTTP POST dispatched over network with Idempotency-Key: '${keyDisplay}'. Browser performance API measured round-trip time (RTT) at ${clientRttMs}ms.`
          : `Client serializes target URL into JSON payload and sends HTTP POST with Idempotency-Key: '${keyDisplay}' over TLS to the API gateway.`,
        whyExists: 'Users and upstream services initiate shortening requests here. Supplying an idempotency key guarantees that accidental retries or network blips never produce duplicate short links.',
        commandOrSql: null,
        response: `HTTP/1.1 ${httpStatus} ${isReplay ? 'OK' : 'Created'}\nContent-Type: application/json\n${isReplay ? 'Idempotent-Replay: true\n' : ''}\n{\n  "status": "success",\n  "short_code": "${shortCode}",\n  "short_url": "${shortUrl}"\n}`
      },
      {
        id: 'api',
        label: 'API Server',
        icon: '⚙️',
        role: 'Stateless Application Server',
        isRealExecution: isReal,
        durationMs: tel.server_duration_ms || 4,
        request: `POST /api/v1/urls\nHeaders: [Idempotency-Key: ${keyDisplay}]\nPayload: { "url": "${longUrl}", "strategy": "${strategy}", "redirect_mode": ${redirectType} }`,
        whatIsHappening: isReal
          ? `REAL SERVER EXECUTION: Gateway parsed JSON payload, validated URL syntax, extracted Idempotency-Key: '${keyDisplay}', and coordinated persistence in ${tel.server_duration_ms}ms.`
          : `Validates URL syntax and SSRF safety, extracts Idempotency-Key, and routes request to the deduplication and generation pipeline.`,
        whyExists: 'Stateless API servers handle business logic, rate limiting, request validation, and orchestrate transactions across database and cache layers.',
        commandOrSql: null,
        response: `Payload Validated -> Extracted Idempotency-Key '${keyDisplay}' -> Proceeding to Idempotency Verification`
      },
      {
        id: 'idempotency',
        label: isReplay ? 'Idempotency Check (KEY HIT)' : 'Idempotency Check (NEW KEY)',
        icon: '🛡️',
        role: 'Durable Request Deduplication',
        isRealExecution: isReal,
        durationMs: isReplay ? (tel.db_duration_ms || 2.4) : 1.2,
        isHit: isReplay,
        isMiss: !isReplay,
        commandOrSql: `-- PostgreSQL Concurrency-Safe Advisory Lock & Lookup:\nSELECT pg_advisory_xact_lock(hashtext('${keyDisplay}'));\nSELECT idempotency_key, request_hash, response_code, response_body\nFROM idempotency_keys\nWHERE idempotency_key = '${keyDisplay}';`,
        whatIsHappening: isReal
          ? (isReplay
              ? `REAL IDEMPOTENCY HIT: Key '${keyDisplay}' was found in database with matching SHA-256 payload hash. Returned cached response with 'Idempotent-Replay: true'. Zero duplicate URL records created.`
              : `REAL IDEMPOTENCY CHECK: Key '${keyDisplay}' is new. Transaction advisory lock acquired in PostgreSQL to guarantee concurrent duplicate requests cannot create multiple URLs.`)
          : 'Checks durable idempotency store before touching core data tables. Ensures at-most-once creation semantics.',
        whyExists: 'Guarantees at-most-once semantics. Distributed clients frequently retry requests upon network timeouts or transient errors; the idempotency guard ensures safe, replayable responses.',
        response: isReplay
          ? `MATCH FOUND -> Returning original cached HTTP ${httpStatus} response with 'Idempotent-Replay: true'`
          : `NEW KEY -> Verified no prior submission. Proceeding to ID generator`
      },
      {
        id: 'id_gen',
        label: `ID Generator (${strategy.toUpperCase()})`,
        icon: '🎲',
        role: 'Candidate Slug Synthesis',
        isRealExecution: isReal,
        durationMs: isReplay ? 0 : 0.3,
        commandOrSql: isReplay
          ? '// Skipped: Request was resolved by idempotency cache'
          : (strategy === 'hash'
              ? `// SHA-256 Hash Generation (Attempt ${collisionAttempts}):\nseed = "${longUrl}"${collisionAttempts > 1 ? ` + ":salt:${collisionAttempts}"` : ''};\nhash = crypto.createHash('sha256').update(seed).digest('base64url');\ncandidate = hash.replace(/[^0-9a-zA-Z]/g, '').substring(0, 7); // '${shortCode}'`
              : (strategy === 'snowflake'
                  ? `// Snowflake Strategy:\nsnowflakeId = (timestamp << 22n) | (workerId << 12n) | sequence;\ncandidate = encodeBase62(snowflakeId).substring(0, 7); // '${shortCode}'`
                  : `// Base62 Strategy:\nnextId = SELECT nextval('urls_id_seq'); // atomic sequence\ncandidate = encodeBase62(14776336n + nextId); // '${shortCode}'`)),
        whatIsHappening: isReal
          ? (isReplay
              ? 'BYPASSED: Request was resolved directly by idempotency replay without generating a new ID.'
              : `REAL GENERATOR: Generated candidate slug '${shortCode}' using ${strategy.toUpperCase()} strategy (attempt ${collisionAttempts}).`)
          : `Generates a compact alphanumeric short code using the selected '${strategy}' algorithm.`,
        whyExists: 'Different ID generation strategies balance coordination overhead, length, determinism, and vulnerability to enumeration attacks.',
        response: isReplay ? 'BYPASSED (Replay)' : `Candidate Code: '${shortCode}'`
      },
      {
        id: 'collision_check',
        label: hasCollision
          ? `Collision Check (${collisionAttempts} ATTEMPTS)`
          : (isReplay ? 'Collision Check (BYPASSED)' : 'Collision Check (UNIQUE)'),
        icon: '🔍',
        role: 'Collision Detection & Recovery',
        isRealExecution: isReal,
        durationMs: isReplay ? 0 : (hasCollision ? Math.round(collisionAttempts * 1.8 * 10) / 10 : 0.4),
        isHit: hasCollision,
        commandOrSql: isReplay
          ? '// Skipped: Request was resolved by idempotency cache'
          : (hasCollision
              ? `-- Attempt 1: INSERT failed with 23505 (unique_violation) on idx_urls_short_code\n-- PostgreSQL SAVEPOINT rollback executed cleanly\n-- Attempt ${collisionAttempts}: Regenerated candidate with salt '${longUrl}:salt:${collisionAttempts}'\n-- Succeeded with short_code: '${shortCode}'`
              : `-- PostgreSQL UNIQUE(short_code) check:\nAttempt 1: Candidate '${shortCode}' passed UNIQUE constraint check`),
        whatIsHappening: isReal
          ? (isReplay
              ? 'BYPASSED: Replay response required no collision checking.'
              : (hasCollision
                  ? `REAL HASH COLLISION DETECTED & RESOLVED: Initial candidate collided with an existing row (PostgreSQL 23505). Service caught error with SAVEPOINT, salted the hash, and successfully resolved on attempt ${collisionAttempts}.`
                  : `REAL UNIQUENESS CONFIRMATION: Candidate '${shortCode}' passed UNIQUE constraint on attempt 1 without collisions.`))
          : 'Verifies candidate short code against existing records in PostgreSQL. On collision, applies salt and retries up to 5 attempts.',
        whyExists: 'Hash truncation introduces non-zero collision risk (Birthday Problem). Systems must detect database UNIQUE constraint violations and gracefully recover without overwriting data.',
        response: isReplay
          ? 'BYPASSED (Replay)'
          : (hasCollision
              ? `COLLISION DETECTED -> Successfully resolved on attempt ${collisionAttempts} with '${shortCode}'`
              : `UNIQUE: Candidate '${shortCode}' confirmed`)
      },
      {
        id: 'db',
        label: isReplay ? 'PostgreSQL (LOOKUP ONLY)' : 'Primary Database (PostgreSQL)',
        icon: '🗄️',
        role: 'Relational Database (Write Master)',
        isRealExecution: isReal,
        durationMs: tel.db_duration_ms || 14,
        request: isReplay
          ? `SELECT idempotency_key, request_hash, response_code, response_body FROM idempotency_keys WHERE idempotency_key = '${keyDisplay}';`
          : `INSERT INTO urls (short_code, long_url, redirect_mode, access_count, created_at, updated_at)\nVALUES ('${shortCode}', '${longUrl}', ${redirectType}, 0, NOW(), NOW())\nRETURNING id, short_code, created_at;`,
        whatIsHappening: isReal
          ? (isReplay
              ? `REAL DB EXECUTION: Queried idempotency record from PostgreSQL in ${tel.db_duration_ms}ms. INSERT was safely skipped.`
              : `REAL DB TRANSACTION: Executed atomic transaction in PostgreSQL in ${tel.db_duration_ms}ms. Persisted URL record to 'urls' and idempotency record to 'idempotency_keys' with UNIQUE constraint protection.`)
          : 'Primary database acquires write lock, inserts mapping record into urls table, updates B-Tree index, and flushes to WAL.',
        whyExists: 'Relational databases guarantee ACID durability and uniqueness constraints (UNIQUE index on short_code) so short URLs are never overwritten.',
        commandOrSql: isReplay
          ? `SELECT idempotency_key, request_hash, response_code, response_body\nFROM idempotency_keys WHERE idempotency_key = '${keyDisplay}';`
          : `BEGIN;\nINSERT INTO urls (short_code, long_url, redirect_mode, access_count, created_at, updated_at)\nVALUES ('${shortCode}', '${longUrl}', ${redirectType}, 0, NOW(), NOW())\nRETURNING id, short_code, created_at;\n\nINSERT INTO idempotency_keys (idempotency_key, request_hash, response_code, response_body)\nVALUES ('${keyDisplay}', 'sha256_hash', 201, ...);\nCOMMIT;`,
        response: isReplay
          ? `Query OK: Retrieved cached idempotency record in ${tel.db_duration_ms}ms`
          : `Query OK: 1 row affected (Duration: ${tel.db_duration_ms}ms)\nCommitted short_code: '${shortCode}'`
      },
      {
        id: 'redis_optional',
        label: isReplay ? 'Redis Cache (BYPASSED)' : 'Redis Cache (Pre-warm)',
        icon: '⚡',
        role: 'In-Memory Key-Value Store',
        isRealExecution: isReal,
        durationMs: isReplay ? 0 : (tel.redis_duration_ms || 1.2),
        request: isReplay
          ? `// Cache pre-warming already completed on original creation`
          : `SETEX urls:${shortCode} 86400 "{\\"id\\":${realData?.id || 1},\\"longUrl\\":\\"${longUrl}\\",\\"redirectMode\\":${redirectType}}"`,
        whatIsHappening: isReal
          ? (isReplay
              ? 'BYPASSED: Cache pre-warming already occurred when the URL was originally created.'
              : (tel.redis_cached !== false
                  ? `REAL CACHE PRE-WARM: API pre-warmed Redis key 'urls:${shortCode}' with a 24-hour TTL in ${tel.redis_duration_ms}ms. Next visitor gets an instant CACHE HIT without querying the database.`
                  : 'Bypassed or degraded.'))
          : 'API pre-warms Redis with the new short code mapping with a 24h TTL to ensure future reads are instant cache hits.',
        whyExists: 'Pre-warming newly created links prevents immediate cache misses if the URL is shared and visited immediately.',
        commandOrSql: isReplay
          ? `// Redis cache already warm`
          : `SETEX urls:${shortCode} 86400 "{\\"longUrl\\":\\"${longUrl}\\",\\"redirectMode\\":${redirectType}}"`,
        response: isReplay
          ? 'BYPASSED (Replay)'
          : (tel.redis_cached !== false ? `OK (Cached in ${tel.redis_duration_ms || 1.2}ms)` : `Bypassed/Degraded`)
      },
      {
        id: 'response',
        label: isReplay ? 'HTTP 200 Replay' : 'HTTP 201 Created',
        icon: '✅',
        role: 'Client Response Delivery',
        isRealExecution: isReal,
        durationMs: 1,
        request: `HTTP/1.1 ${httpStatus} ${isReplay ? 'OK' : 'Created'}\nLocation: ${shortUrl}\nServer-Timing: server;dur=${tel.server_duration_ms || 15}, db;dur=${tel.db_duration_ms || 12}, redis;dur=${tel.redis_duration_ms || 1}\n${isReplay ? 'Idempotent-Replay: true\n' : ''}`,
        whatIsHappening: isReal
          ? (isReplay
              ? `REAL REPLAY RESPONSE: API delivered cached HTTP ${httpStatus} response with header 'Idempotent-Replay: true'. Zero database mutations.`
              : `REAL RESPONSE: API delivered HTTP 201 Created with short URL '${shortUrl}' and full server-timing telemetry headers.`)
          : 'API returns response with JSON metadata and the ready-to-use short URL.',
        whyExists: 'Informs client that the resource was durably persisted, or returned safely via idempotent replay.',
        commandOrSql: null,
        response: `{\n  "status": "success",\n  "short_code": "${shortCode}",\n  "short_url": "${shortUrl}",\n  "long_url": "${longUrl}"\n}`
      }
    ];

    // Store record in local database if not already present
    if (!this.databaseRecords.some(r => r.shortCode === shortCode)) {
      const newRecord = {
        id: realData?.id || (this.databaseRecords.length > 0 ? Math.max(...this.databaseRecords.map(r => r.id || 0)) + 1 : 1),
        shortCode,
        longUrl,
        createdAt,
        accessCount: 0,
        inCache: true
      };
      this.databaseRecords.unshift(newRecord);
    }

    await this.animateTrace(hops, 'write');
    this.renderDatabaseTable();
    if (this.onRecordCreated) {
      const record = this.databaseRecords.find(r => r.shortCode === shortCode);
      if (record) this.onRecordCreated(record);
    }
    this.isTracing = false;
    return this.databaseRecords.find(r => r.shortCode === shortCode);
  }

  /**
   * Run Read Trace: GET /:short_code (REAL Telemetry via Accept: application/json)
   */
  async runReadTrace(shortCode, redirectType, appState, chaosOverride = null) {
    if (this.isTracing) return;
    this.isTracing = true;

    // Find record in DB
    let record = this.databaseRecords.find(r => r.shortCode === shortCode);
    if (!record) {
      record = {
        id: this.databaseRecords.length + 1,
        shortCode,
        longUrl: 'https://example.com/demo-destination',
        createdAt: new Date().toLocaleTimeString(),
        accessCount: 0,
        inCache: false
      };
      this.databaseRecords.push(record);
    }

    // Determine if chaos should be injected for this specific trace
    let chaosConfig = chaosOverride;
    if (!chaosConfig && appState?.liveChaosEnabled) {
      if (appState.failures?.redisDown) {
        chaosConfig = { fault: 'redis_failure', delayMs: 0 };
      } else if (appState.failures?.extraLatencyMs > 0) {
        chaosConfig = { fault: 'redis_latency', delayMs: appState.failures.extraLatencyMs };
      } else if (appState.failures?.oneApiNodeDead) {
        chaosConfig = { fault: 'api_latency', delayMs: 200 };
      } else if (appState.failures?.dbDown || !appState.dbIndexed) {
        chaosConfig = { fault: 'db_latency', delayMs: 200 };
      }
    }

    const reqHeaders = { 'Accept': 'application/json' };
    if (chaosConfig && chaosConfig.fault) {
      reqHeaders['X-Chaos-Fault'] = chaosConfig.fault;
      reqHeaders['X-Chaos-Delay-Ms'] = String(chaosConfig.delayMs || 0);
      reqHeaders['X-Chaos-Key'] = 'scale-lab-chaos-demo-2026';
    }

    // Call actual GET /:shortCode endpoint with Accept: application/json and chaos headers if active
    let realReadData = null;
    let clientRttMs = 0;
    const clientReqStart = performance.now();

    try {
      const response = await fetch(`/${shortCode}`, {
        method: 'GET',
        headers: reqHeaders
      });
      clientRttMs = Math.round((performance.now() - clientReqStart) * 10) / 10;
      if (response.ok) {
        realReadData = await response.json();
      }
    } catch (err) {
      console.warn('[Tracer] Read trace fetch failed, using fallback simulator:', err.message);
    }

    const isReal = Boolean(realReadData && realReadData.telemetry);
    const tel = realReadData?.telemetry || {};
    const isChaos = Boolean(tel.chaos_enabled ?? realReadData?.chaos_enabled);
    const injectedFault = tel.injected_fault ?? realReadData?.injected_fault ?? null;
    const injectedDelay = tel.injected_delay_ms ?? realReadData?.injected_delay_ms ?? 0;
    const isRedisFailure = (injectedFault === 'redis_failure');

    const isCacheHit = isReal
      ? Boolean(tel.redis_hit ?? realReadData.cache_hit)
      : (appState.redisEnabled && !appState.failures?.redisDown && record.inCache && !isRedisFailure);

    const dbFallback = isReal
      ? Boolean(tel.db_fallback ?? realReadData.db_fallback)
      : (!isCacheHit || isRedisFailure);

    const destinationUrl = realReadData?.destination || record.longUrl;
    const effectiveRedirectMode = String(realReadData?.redirect_mode || redirectType || '302');
    const redirectStatus = effectiveRedirectMode === '301' ? '301 Moved Permanently' : '302 Found';
    const cacheControlHeader = effectiveRedirectMode === '301' 
      ? 'Cache-Control: public, max-age=31536000, immutable' 
      : 'Cache-Control: no-cache, no-store, must-revalidate';

    // Mark as warm in local records if not simulating an outage
    if (!isRedisFailure) {
      record.inCache = true;
    }
    record.accessCount = (record.accessCount || 0) + 1;

    const hops = [];

    // Hop 1: Client Request
    hops.push({
      id: 'client_get',
      label: 'Browser / Client',
      icon: '💻',
      role: 'User Visiting Short URL',
      isRealExecution: isReal,
      isChaos,
      injectedFault,
      durationMs: clientRttMs || 6,
      request: `GET /${shortCode} HTTP/1.1\nHost: ${window.location.host || 'sho.rt'}\nAccept: text/html,application/json\nUser-Agent: Mozilla/5.0${chaosConfig && chaosConfig.fault ? `\nX-Chaos-Fault: ${chaosConfig.fault}\nX-Chaos-Delay-Ms: ${chaosConfig.delayMs}` : ''}`,
      whatIsHappening: isReal
        ? `REAL HTTP GET request dispatched to /${shortCode}. Round-trip network latency measured at ${clientRttMs}ms.${isChaos ? ` (Chaos Mode: Injected Fault '${injectedFault}')` : ''}`
        : `User clicks or navigates to https://sho.rt/${shortCode}. Browser sends a standard GET request to the shortener gateway.`,
      whyExists: 'Every URL access starts with an HTTP GET request from an originating client.',
      commandOrSql: null,
      response: `Resolving redirect to ${destinationUrl}...`
    });

    // Hop 2: API Routing
    const apiDuration = tel.actual_server_duration_ms ?? tel.server_duration_ms ?? 2;
    hops.push({
      id: 'api_lookup',
      label: injectedFault === 'api_latency' ? `API Server (+${injectedDelay}ms Latency)` : 'API Server',
      icon: '⚙️',
      role: 'Routing & Cache Dispatcher',
      isRealExecution: isReal,
      isChaos: injectedFault === 'api_latency',
      injectedFault,
      durationMs: apiDuration,
      request: `GET /${shortCode}\nExtracted Key: urls:${shortCode}${injectedFault === 'api_latency' ? `\n[INJECTED API DELAY: +${injectedDelay}ms]` : ''}`,
      whatIsHappening: isReal
        ? `REAL API DISPATCH: Server extracted key 'urls:${shortCode}'. Coordinated cache evaluation and fallback resolution in ${apiDuration}ms.${injectedFault === 'api_latency' ? ` Injected ${injectedDelay}ms API latency successfully.` : ''}`
        : `API server extracts short code '${shortCode}'. Checks in-memory Redis cache first to avoid an expensive database query.`,
      whyExists: 'In read-heavy architectures (95%+ reads), checking cache first protects the database from read saturation.',
      commandOrSql: `redis.get("urls:${shortCode}")`,
      response: isRedisFailure 
        ? `Simulated Redis crash -> Cascading to PostgreSQL storage` 
        : (isCacheHit ? `Found key in Redis RAM -> Preparing redirect` : `Cache MISS -> Querying Primary Database`)
    });

    // Hop 3: Redis Cache Check or Outage
    if (isRedisFailure) {
      hops.push({
        id: 'redis_outage',
        label: 'Redis [SIMULATED OUTAGE]',
        icon: '⚡',
        role: 'In-Memory Cache (Crash Injected)',
        isRealExecution: isReal,
        isFailed: true,
        isChaos: true,
        injectedFault: 'redis_failure',
        durationMs: tel.actual_redis_duration_ms ?? tel.redis_duration_ms ?? 1.0,
        request: `GET urls:${shortCode}\n[SIMULATED FAULT: redis_failure]`,
        whatIsHappening: `REAL EXECUTION: Real Redis operation intercepted by controlled chaos experiment. Failed fast in ${tel.actual_redis_duration_ms ?? 1.0}ms. API caught outage and cascaded to PostgreSQL fallback.`,
        whyExists: 'SIMULATED CONTEXT: Cache layers can suffer transient evictions, memory exhaustion, or network partitions. Safe architecture dictates an automatic database fallback to prevent 500 errors.',
        commandOrSql: `GET urls:${shortCode} -> [SIMULATED_CACHE_CRASH]`,
        response: 'ERR: Redis Offline -> Fallback to PostgreSQL'
      });
    } else if (injectedFault === 'redis_latency') {
      hops.push({
        id: 'redis_check',
        label: `Redis Cache (+${injectedDelay}ms Latency)`,
        icon: '⏱️',
        role: 'In-Memory Cache with Injected Jitter',
        isRealExecution: isReal,
        isChaos: true,
        injectedFault: 'redis_latency',
        durationMs: tel.actual_redis_duration_ms ?? tel.redis_duration_ms ?? (1.2 + injectedDelay),
        isHit: isCacheHit,
        isMiss: !isCacheHit,
        request: `GET urls:${shortCode}\n[CHAOS JITTER: +${injectedDelay}ms]`,
        whatIsHappening: `REAL EXECUTION: Real Redis command executed with +${injectedDelay}ms latency injected. Measured total Redis duration: ${tel.actual_redis_duration_ms ?? tel.redis_duration_ms}ms.`,
        whyExists: 'SIMULATED CONTEXT: Cross-AZ transit latency or lock contention adds jitter to memory cache queries.',
        commandOrSql: `GET urls:${shortCode}`,
        response: isCacheHit ? `"${destinationUrl}" (+${injectedDelay}ms delay)` : `(nil)`
      });
    } else {
      hops.push({
        id: 'redis_check',
        label: isCacheHit ? 'Redis Cache (CACHE HIT ✅)' : 'Redis Cache (CACHE MISS ⚠️)',
        icon: isCacheHit ? '⚡' : '🔍',
        role: 'In-Memory Cache (RAM)',
        isRealExecution: isReal,
        durationMs: tel.actual_redis_duration_ms ?? tel.redis_duration_ms ?? 1.2,
        isHit: isCacheHit,
        isMiss: !isCacheHit,
        request: `GET urls:${shortCode}`,
        whatIsHappening: isCacheHit 
          ? (isReal
              ? `REAL CACHE HIT: Key 'urls:${shortCode}' found in Redis in ${tel.actual_redis_duration_ms ?? tel.redis_duration_ms}ms! Database query completely bypassed.`
              : `CACHE HIT (94% of reads): Key 'urls:${shortCode}' found in Redis memory! Returning long URL in 1.2ms without touching the database.`)
          : (isReal
              ? `REAL CACHE MISS: Key 'urls:${shortCode}' was not found in Redis (${tel.actual_redis_duration_ms ?? tel.redis_duration_ms}ms). Executing fallback query to PostgreSQL.`
              : `CACHE MISS (6% of reads): Key 'urls:${shortCode}' was not found in Redis RAM (expired or first access). Request must fall through to the database.`),
        whyExists: 'Redis holds active working sets in RAM. Avoiding DB lookups keeps read latency under 2ms and shields the DB replica pool.',
        commandOrSql: `GET urls:${shortCode}`,
        response: isCacheHit ? `"${destinationUrl}" (Latency: ${tel.actual_redis_duration_ms ?? tel.redis_duration_ms ?? 1.2}ms)` : `(nil) [Key Not Found]`
      });
    }

    // Hop 4: Database Lookup on Cache Miss OR on Redis Failure
    if (!isCacheHit || isRedisFailure) {
      const dbDuration = tel.actual_db_duration_ms ?? tel.db_duration_ms ?? 12;
      hops.push({
        id: 'db_miss_lookup',
        label: isRedisFailure 
          ? 'PostgreSQL [FALLBACK]' 
          : (injectedFault === 'db_latency' ? `PostgreSQL (+${injectedDelay}ms Latency)` : 'Primary Database (PostgreSQL)'),
        icon: '🗄️',
        role: isRedisFailure ? 'Resilient Fallback Read' : 'Database Read Query (Fallback)',
        isRealExecution: isReal,
        isChaos: isRedisFailure || injectedFault === 'db_latency',
        injectedFault,
        durationMs: dbDuration,
        request: `SELECT id, long_url, redirect_mode, access_count\nFROM urls\nWHERE short_code = '${shortCode}'\nLIMIT 1;`,
        whatIsHappening: isRedisFailure
          ? `REAL EXECUTION: PostgreSQL primary storage successfully resolved short_code in ${dbDuration}ms as cache fallback, preserving 100% link availability!`
          : (injectedFault === 'db_latency'
              ? `REAL EXECUTION: PostgreSQL query executed with +${injectedDelay}ms injected latency. Measured duration: ${dbDuration}ms.`
              : `REAL DB LOOKUP: Executed SELECT query on PostgreSQL 'urls' table in ${dbDuration}ms. Retrieved destination URL and redirect mode.`),
        whyExists: 'SIMULATED CONTEXT: The database is the durable source of truth. All cache misses and cache outages fall back to the DB to resolve destinations.',
        commandOrSql: `SELECT id, long_url, redirect_mode, access_count FROM urls WHERE short_code = '${shortCode}' LIMIT 1;`,
        response: `1 row returned in ${dbDuration}ms:\nlong_url = "${destinationUrl}"`
      });

      // Hop 5: Cache Population (Write-back) - only when Redis is alive!
      if (!isRedisFailure) {
        hops.push({
          id: 'redis_populate',
          label: 'Redis Write-Back (SETEX)',
          icon: '💾',
          role: 'Cache Warming on Miss',
          isRealExecution: isReal,
          durationMs: tel.actual_redis_duration_ms ? Math.max(1, Math.round(tel.actual_redis_duration_ms / 2 * 10) / 10) : 1.2,
          request: `SETEX urls:${shortCode} 86400 "${destinationUrl}"`,
          whatIsHappening: isReal
            ? `REAL CACHE-ASIDE: Populated Redis key 'urls:${shortCode}' with 24-hour TTL (86400s). Subsequent requests are now instant CACHE HITS.`
            : `API populates Redis cache with the resolved long URL and sets a 24-hour TTL (Time-To-Live). Next lookup for '${shortCode}' will be an instant CACHE HIT!`,
          whyExists: 'Cache-aside pattern: on miss, populate cache so subsequent reads do not hit the database.',
          commandOrSql: `SETEX urls:${shortCode} 86400 "${destinationUrl}"`,
          response: `OK (Key cached for 86400s)`
        });
      }
    }

    // Final Redirect Response
    hops.push({
      id: 'redirect_response',
      label: `HTTP ${effectiveRedirectMode} Redirect`,
      icon: '↪️',
      role: 'Client Redirection Response',
      isRealExecution: isReal,
      isChaos,
      injectedFault,
      durationMs: 1,
      request: `HTTP/1.1 ${redirectStatus}\nLocation: ${destinationUrl}\n${cacheControlHeader}\nX-Cache: ${isCacheHit ? 'HIT' : 'MISS'}\nX-Redirect-Mode: ${effectiveRedirectMode}\nX-Db-Fallback: ${dbFallback}${isChaos ? `\nX-Chaos-Fault: ${injectedFault}` : ''}`,
      whatIsHappening: isRedisFailure
        ? `REAL 302 REDIRECT: API returned HTTP ${effectiveRedirectMode} redirect with DB fallback guarantee (X-Db-Fallback: true, X-Chaos-Fault: redis_failure). Target: ${destinationUrl}.`
        : (isReal
            ? (effectiveRedirectMode === '301'
                ? `REAL 301 REDIRECT: Permanent redirect to destination. Observability headers set (X-Cache: ${isCacheHit ? 'HIT' : 'MISS'}, X-Db-Fallback: ${dbFallback}). Access counter updated in ${tel.access_update_duration_ms || 4}ms.`
                : `REAL 302 REDIRECT: Temporary redirect to destination. Observability headers set (X-Cache: ${isCacheHit ? 'HIT' : 'MISS'}, X-Db-Fallback: ${dbFallback}). Access counter updated in ${tel.access_update_duration_ms || 4}ms.`)
            : (effectiveRedirectMode === '301'
                ? `Returns 301 Moved Permanently: Browser will permanently cache this destination. Subsequent visits bypass our servers entirely.`
                : `Returns 302 Found: Browser performs a temporary redirect. Future clicks still hit our API server for real-time analytics.`)),
      whyExists: 'Transports the browser to the long URL destination via standard HTTP redirect headers.',
      commandOrSql: `UPDATE urls SET access_count = access_count + 1, updated_at = NOW() WHERE short_code = '${shortCode}';`,
      response: `HTTP/1.1 ${redirectStatus}\nLocation: ${destinationUrl}\n${cacheControlHeader}\nX-Cache: ${isCacheHit ? 'HIT' : 'MISS'}\nX-Redirect-Mode: ${effectiveRedirectMode}\nAccess Count Incremented: ✅`
    });

    await this.animateTrace(hops, isRedisFailure ? 'read-miss' : (isCacheHit ? 'read-hit' : 'read-miss'));

    // Refresh database table so access_count is immediately current from PostgreSQL
    await this.loadDatabaseRecords();

    this.isTracing = false;
  }

  /**
   * Animate the request packet moving across hops
   */
  async animateTrace(hops, traceType) {
    this.activeTrace = { hops, traceType, currentIndex: 0 };
    this.renderTracePipeline(hops, 0);
    this.openHopInspector(hops[0]);

    for (let i = 0; i < hops.length; i++) {
      this.activeTrace.currentIndex = i;
      this.renderTracePipeline(hops, i);
      this.openHopInspector(hops[i]);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  /**
   * Render the visual pipeline in the DOM
   * Each component type gets its own color identity via CSS custom props.
   */
  renderTracePipeline(hops, activeIndex) {
    if (!this.containerEl) return;

    // Color map: hop id → [hex, r,g,b string]
    const hopColors = {
      client:            ['#38bdf8', '56,189,248'],
      client_get:        ['#38bdf8', '56,189,248'],
      api:               ['#a78bfa', '167,139,250'],
      api_lookup:        ['#a78bfa', '167,139,250'],
      idempotency:       ['#38bdf8', '56,189,248'],
      id_gen:            ['#c084fc', '192,132,252'],
      collision_check:   ['#f472b6', '244,114,182'],
      db:                ['#fb923c', '251,146,60'],
      db_miss_lookup:    ['#fb923c', '251,146,60'],
      redis_optional:    ['#f59e0b', '245,158,11'],
      redis_check:       ['#f59e0b', '245,158,11'],
      redis_populate:    ['#f59e0b', '245,158,11'],
      redis_outage:      ['#ef4444', '239,68,68'],
      response:          ['#34d399', '52,211,153'],
      redirect_response: ['#34d399', '52,211,153'],
    };

    let html = `<div class="pipeline-flow ${this.activeTrace?.traceType || ''}">`;

    hops.forEach((hop, idx) => {
      const isCompleted = idx < activeIndex;
      const isActive    = idx === activeIndex;
      let stateClass  = isActive ? 'hop-active' : (isCompleted ? 'hop-completed' : 'hop-pending');
      if (hop.isFailed) {
        stateClass += ' hop-failed';
      }

      let hitMissBadge = '';
      if (hop.isFailed) {
        hitMissBadge = '<span class="badge-outage">✕ OUTAGE</span>';
      } else if (hop.id === 'idempotency' && hop.isHit) {
        hitMissBadge = '<span class="badge-replay">↺ REPLAY</span>';
      } else if (hop.id === 'collision_check' && hop.isHit) {
        hitMissBadge = '<span class="badge-collision">⚠ COLLISION</span>';
      } else if (hop.isHit) {
        hitMissBadge = '<span class="badge-hit">● HIT</span>';
      } else if (hop.isMiss) {
        hitMissBadge = '<span class="badge-miss">○ MISS</span>';
      }

      const [hex, rgb] = hopColors[hop.id] || ['#6366f1', '99,102,241'];
      const colorStyle = `--hop-color:${hex};--hop-color-rgb:${rgb};`;

      let tagClass = hop.isRealExecution ? 'tag-real' : 'tag-simulated';
      let tagText = hop.isRealExecution ? 'REAL' : 'SIM';
      if (hop.isChaos) {
        tagClass = 'tag-chaos';
        tagText = 'CHAOS';
      }

      html += `
        <div class="pipeline-hop ${stateClass}" data-hop-index="${idx}" style="${colorStyle}">
          <div class="hop-inner">
            <div class="hop-icon-bubble">${this.getHopSvgIcon(hop.id)}</div>
            <div class="hop-info">
              <div class="hop-title">${hop.label} ${hitMissBadge}</div>
              <div class="hop-role">${hop.role}</div>
              <div class="hop-latency">
                ${hop.durationMs}ms
                <span class="hop-telemetry-tag ${tagClass}">${tagText}</span>
              </div>
            </div>
          </div>
          ${idx < hops.length - 1 ? `
            <div class="hop-connector">
              <div class="packet-dot"></div>
              <div class="hop-connector-arrow"></div>
            </div>
          ` : ''}
        </div>
      `;
    });

    html += `</div>`;
    this.containerEl.innerHTML = html;

    // Attach click handlers to each hop for interactive manual inspection
    const hopEls = this.containerEl.querySelectorAll('.pipeline-hop');
    hopEls.forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-hop-index'), 10);
        if (hops[idx]) {
          this.openHopInspector(hops[idx]);
          hopEls.forEach(h => h.classList.remove('hop-selected'));
          el.classList.add('hop-selected');
        }
      });
    });
  }

  /**
   * Open the detailed Hop Inspector Drawer
   */
  openHopInspector(hop) {
    if (!this.inspectorEl || !hop) return;
    this.selectedHop = hop;

    const hopColors = {
      client:            ['#60a5fa', '96,165,250'],
      client_get:        ['#60a5fa', '96,165,250'],
      api:               ['#a78bfa', '167,139,250'],
      api_lookup:        ['#a78bfa', '167,139,250'],
      idempotency:       ['#38bdf8', '56,189,248'],
      id_gen:            ['#c084fc', '192,132,252'],
      collision_check:   ['#f472b6', '244,114,182'],
      db:                ['#fb923c', '251,146,60'],
      db_miss_lookup:    ['#fb923c', '251,146,60'],
      redis_optional:    ['#34d399', '52,211,153'],
      redis_check:       ['#34d399', '52,211,153'],
      redis_populate:    ['#34d399', '52,211,153'],
      redis_outage:      ['#ef4444', '239,68,68'],
      response:          ['#4ade80', '74,222,128'],
      redirect_response: ['#f472b6', '244,114,182'],
    };
    const [hex, rgb] = hopColors[hop.id] || ['#6366f1', '99,102,241'];

    // Build code sections with modern icons and labels
    const codeSections = [];
    if (hop.request) {
      codeSections.push({
        label: 'Incoming Request',
        icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
        code: this.escapeHtml(hop.request),
        lang: 'language-http',
        color: hex, rgb
      });
    }
    if (hop.commandOrSql) {
      codeSections.push({
        label: 'Executed Command / Query',
        icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
        code: this.escapeHtml(hop.commandOrSql),
        lang: 'language-sql',
        color: '#fb923c', rgb: '251,146,60'
      });
    }
    if (hop.response) {
      codeSections.push({
        label: 'Response Payload / Headers',
        icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
        code: this.escapeHtml(hop.response),
        lang: 'language-http',
        color: '#4ade80', rgb: '74,222,128'
      });
    }

    const isReal = Boolean(hop.isRealExecution);

    this.inspectorEl.innerHTML = `
      <div class="insp-header" style="--hop-color:${hex};--hop-color-rgb:${rgb};">
        <div class="insp-header-left">
          <div class="insp-icon-box">${this.getHopSvgIcon(hop.id)}</div>
          <div class="insp-meta">
            <div class="insp-name-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="insp-component-name">${this.escapeHtml(hop.label)}</span>
              <span class="badge-telemetry ${isReal ? 'real' : 'simulated'}">
                ${isReal ? '● REAL EXECUTION' : '○ SIMULATED CONTEXT'}
              </span>
              ${hop.isChaos || hop.injectedFault ? `
                <span class="badge-chaos-fault">⚡ FAULT: ${hop.injectedFault || 'redis_failure'}</span>
              ` : ''}
            </div>
            <span class="insp-role-text">${this.escapeHtml(hop.role)}</span>
          </div>
        </div>
        <div class="insp-header-right">
          <div class="insp-latency-badge" title="${isReal ? 'Real measured execution duration' : 'Estimated processing latency'}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span class="insp-latency-num">${Number(hop.durationMs) || 0}</span>
            <span class="insp-latency-unit">ms</span>
          </div>
        </div>
      </div>

      <div class="insp-telemetry-banner ${isReal ? '' : 'simulated-banner'}" style="${hop.isChaos ? 'border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.06);' : ''}">
        <div class="telemetry-banner-title" style="${hop.isChaos ? 'color: #fbbf24;' : ''}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            ${isReal 
              ? '<polyline points="20 6 9 17 4 12"/>' 
              : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'}
          </svg>
          <span>${isReal ? (hop.isChaos ? `REAL CHAOS EXECUTION TELEMETRY (${hop.injectedFault || 'ACTIVE'})` : 'REAL BACKEND OPERATION TELEMETRY') : 'SIMULATED SYSTEM DESIGN CONTEXT'}</span>
        </div>
        <div class="telemetry-banner-timing">Measured: <strong>${hop.durationMs}ms</strong></div>
      </div>

      <div class="insp-cards-row">
        <div class="insp-card insp-card-what">
          <div class="insp-card-label">
            <svg class="insp-label-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
            <span>${isReal ? 'What happened (Actual Execution)' : 'What is happening'}</span>
          </div>
          <div class="insp-card-text">${this.escapeHtml(hop.whatIsHappening)}</div>
        </div>
        <div class="insp-card insp-card-why">
          <div class="insp-card-label">
            <svg class="insp-label-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span>SIMULATED CONTEXT (Architectural Rationale)</span>
          </div>
          <div class="insp-card-text">${this.escapeHtml(hop.whyExists)}</div>
        </div>
      </div>

      ${codeSections.length > 0 ? `
        <div class="insp-code-sections">
          ${codeSections.map(s => `
            <div class="insp-code-block">
              <div class="insp-code-label" style="color:${s.color || hex}">
                ${s.icon}
                <span>${s.label}</span>
              </div>
              <pre class="code-block ${s.lang}"><code>${s.code}</code></pre>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  }

  /**
   * Helper to return clean, modern geometric SVG icons
   */
  getHopSvgIcon(id) {
    switch (id) {
      case 'client':
      case 'client_get':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="15" x="2" y="3" rx="2"/><line x1="2" x2="22" y1="8" y2="8"/><circle cx="5" cy="5.5" r="0.75" fill="currentColor"/><circle cx="8" cy="5.5" r="0.75" fill="currentColor"/></svg>`;
      case 'api':
      case 'api_lookup':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="13" rx="2"/><line x1="6" x2="6.01" y1="7" y2="7"/><line x1="6" x2="6.01" y1="17" y2="17"/><line x1="18" x2="18.01" y1="7" y2="7"/><line x1="18" x2="18.01" y1="17" y2="17"/></svg>`;
      case 'idempotency':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
      case 'id_gen':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
      case 'collision_check':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
      case 'db':
      case 'db_miss_lookup':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`;
      case 'redis_optional':
      case 'redis_check':
      case 'redis_populate':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
      case 'redis_outage':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/><line x1="2" y1="2" x2="22" y2="22" stroke="#ef4444" stroke-width="2.5"/></svg>`;
      case 'response':
      case 'redirect_response':
      default:
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 9 10 15 7 12"/></svg>`;
    }
  }

  /**
   * Render Database Table view
   */
  renderDatabaseTable() {
    if (!this.tableEl) return;

    let html = `
      <div class="db-table-wrapper">
        <div class="db-table-header">
          <h4>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:6px;"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>
            Stored URL Records (PostgreSQL / MySQL Schema)
          </h4>
          <span class="db-table-count">${this.databaseRecords.length} records</span>
        </div>
        <table class="db-records-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Short Code</th>
              <th>Destination (Long URL)</th>
              <th>Created</th>
              <th>Clicks</th>
              <th>Cache State</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
    `;

    this.databaseRecords.forEach(rec => {
      const safeShortCode = this.escapeHtml(rec.shortCode);
      const safeLongUrl = this.escapeHtml(rec.longUrl);
      const safeCreatedAt = this.escapeHtml(rec.createdAt);
      html += `
        <tr>
          <td><span class="db-id">#${Number(rec.id) || 1}</span></td>
          <td>
            <a href="/${safeShortCode}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;" title="Open real short URL (/${safeShortCode})">
              <code class="short-code-badge" style="cursor:pointer;">${safeShortCode} ↗</code>
            </a>
          </td>
          <td class="long-url-cell" title="${safeLongUrl}">${safeLongUrl}</td>
          <td class="text-muted">${safeCreatedAt}</td>
          <td><span class="access-pill">${Number(rec.accessCount) || 0}</span></td>
          <td>
            <span class="cache-status-pill ${rec.inCache ? 'in-cache' : 'not-cached'}">
              ${rec.inCache ? '● In Redis RAM' : '○ DB Only'}
            </span>
          </td>
          <td>
            <div style="display:inline-flex;gap:6px;align-items:center;">
              <a href="/${safeShortCode}" target="_blank" rel="noopener noreferrer" class="btn-visit-short" style="text-decoration:none;" title="Open real redirect in new tab">
                Visit ↗
              </a>
              <button class="btn-visit-short btn-trace-inspect" data-short-code="${safeShortCode}" title="Simulate and inspect request trace in playground">
                Trace
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    this.tableEl.innerHTML = html;

    // Update the badge count in the collapsed summary
    const countEl = document.getElementById('db-record-count');
    if (countEl) countEl.textContent = this.databaseRecords.length;

    // Pulse-glow the DB table disclosure to draw attention to it
    const disclosure = document.getElementById('db-table-disclosure');
    if (disclosure) {
      disclosure.classList.remove('new-record');
      // Force reflow to restart animation
      void disclosure.offsetWidth;
      disclosure.classList.add('new-record');
      setTimeout(() => disclosure.classList.remove('new-record'), 2600);
    }

    // Attach Trace inspection button click handlers
    this.tableEl.querySelectorAll('.btn-trace-inspect').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-short-code');
        const redirectType = document.querySelector('input[name="redirect_mode"]:checked')?.value || '302';
        window.appDispatcher?.visitShortUrl(code, redirectType);
      });
    });
  }

  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
