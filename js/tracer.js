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
  async runWriteTrace(longUrl, strategy, redirectType, appState) {
    if (this.isTracing) return;
    this.isTracing = true;

    const shortCode = this.generateShortCode(longUrl, strategy);
    const shortUrl = `https://sho.rt/${shortCode}`;

    // Define the sequence of hops for URL Creation
    const hops = [
      {
        id: 'client',
        label: 'Browser / Client',
        icon: '💻',
        role: 'Originating Client',
        request: `POST /api/v1/urls HTTP/1.1\nHost: api.sho.rt\nContent-Type: application/json\nUser-Agent: Mozilla/5.0\n\n{\n  "url": "${longUrl}",\n  "custom_alias": null\n}`,
        whatIsHappening: 'Client serializes the target URL into a JSON payload and sends an HTTP POST request over TLS to the API load balancer.',
        whyExists: 'Users and upstream services initiate shortening requests here. Clients require quick HTTP 201 Created responses containing the short link.',
        commandOrSql: null,
        response: `HTTP/1.1 201 Created\nContent-Type: application/json\n\n{\n  "short_code": "${shortCode}",\n  "short_url": "${shortUrl}",\n  "created_at": "${new Date().toISOString()}"\n}`,
        durationMs: 4
      },
      {
        id: 'api',
        label: 'API Server',
        icon: '⚙️',
        role: 'Stateless Application Server',
        request: `POST /api/v1/urls\nPayload: { "url": "${longUrl}" }`,
        whatIsHappening: `Validates URL syntax, applies rate limiting, generates unique short code '${shortCode}' using strategy '${strategy}'.`,
        whyExists: 'Stateless API servers handle business logic, authentication, request validation, and encoding. They can scale horizontally by adding nodes.',
        commandOrSql: strategy === 'base62' 
          ? `// Base62 Encoding:\nID = atomic_next_id(); // ${this.counter}\nshort_code = base62_encode(ID); // '${shortCode}'`
          : `// Hash & Collision Check:\nhash = sha256("${longUrl}").take(7); // '${shortCode}'`,
        response: `Generated Short Code: '${shortCode}' -> Dispatches write to Primary DB`,
        durationMs: 2
      },
      {
        id: 'db',
        label: 'Primary Database',
        icon: '🗄️',
        role: 'Relational Database (Write Master)',
        request: `INSERT INTO urls (short_code, long_url, created_at, access_count)\nVALUES ('${shortCode}', '${longUrl}', NOW(), 0);`,
        whatIsHappening: `Primary database acquires a write lock, inserts the mapping record into the 'urls' table, updates the B-Tree index, and flushes to the Write-Ahead Log (WAL).`,
        whyExists: 'Relational databases guarantee ACID durability and uniqueness constraints (UNIQUE index on short_code) so short URLs are never overwritten.',
        commandOrSql: `INSERT INTO urls (short_code, long_url, created_at, access_count)\nVALUES ('${shortCode}', '${longUrl}', NOW(), 0)\nRETURNING id, short_code, created_at;`,
        response: `Query OK, 1 row affected (0.014 sec)\nInserted Record ID: ${this.databaseRecords.length + 1}`,
        durationMs: 14
      },
      {
        id: 'redis_optional',
        label: 'Redis Cache (Optional Pre-warm)',
        icon: '⚡',
        role: 'In-Memory Key-Value Store',
        request: `SETEX urls:${shortCode} 86400 "${longUrl}"`,
        whatIsHappening: appState.redisEnabled 
          ? `API optionally pre-warms Redis with the new short code mapping with a 24h TTL to ensure future reads are instant cache hits.`
          : `Redis is DISABLED. Skipping cache warm-up.`,
        whyExists: 'Pre-warming newly created links prevents immediate cache misses if the URL is shared and visited immediately.',
        commandOrSql: appState.redisEnabled ? `SETEX urls:${shortCode} 86400 "${longUrl}"` : `// Caching disabled`,
        response: appState.redisEnabled ? `OK` : `Bypassed`,
        durationMs: appState.redisEnabled ? 1 : 0
      },
      {
        id: 'response',
        label: 'HTTP 201 Response',
        icon: '✅',
        role: 'Client Response Delivery',
        request: `HTTP/1.1 201 Created\nLocation: /api/v1/urls/${shortCode}`,
        whatIsHappening: 'API returns HTTP 201 Created with JSON metadata and the ready-to-use short URL.',
        whyExists: 'Informs client that the resource was durably persisted.',
        commandOrSql: null,
        response: `{\n  "status": "success",\n  "short_code": "${shortCode}",\n  "short_url": "${shortUrl}",\n  "long_url": "${longUrl}"\n}`,
        durationMs: 2
      }
    ];

    // Store record in local database
    const newRecord = {
      id: this.databaseRecords.length + 1,
      shortCode,
      longUrl,
      createdAt: new Date().toLocaleTimeString(),
      accessCount: 0,
      inCache: Boolean(appState.redisEnabled)
    };
    this.databaseRecords.unshift(newRecord);

    await this.animateTrace(hops, 'write');
    this.renderDatabaseTable();
    if (this.onRecordCreated) this.onRecordCreated(newRecord);
    this.isTracing = false;
    return newRecord;
  }

  /**
   * Run Read Trace: GET /:short_code
   */
  async runReadTrace(shortCode, redirectType, appState) {
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

    record.accessCount++;

    const isRedisActive = appState.redisEnabled && !appState.failures?.redisDown;
    const isCacheHit = isRedisActive && record.inCache;
    const redirectStatus = redirectType === '301' ? '301 Moved Permanently' : '302 Found';
    const cacheControlHeader = redirectType === '301' 
      ? 'Cache-Control: public, max-age=31536000, immutable' 
      : 'Cache-Control: no-cache, no-store, must-revalidate';

    const hops = [];

    // Hop 1: Client Request
    hops.push({
      id: 'client_get',
      label: 'Browser / Client',
      icon: '💻',
      role: 'User Visiting Short URL',
      request: `GET /${shortCode} HTTP/1.1\nHost: sho.rt\nUser-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)\nAccept: text/html`,
      whatIsHappening: `User clicks or navigates to https://sho.rt/${shortCode}. Browser sends a standard GET request to the shortener gateway.`,
      whyExists: 'Every URL access starts with an HTTP GET request.',
      commandOrSql: null,
      response: `Pending redirect to ${record.longUrl}...`,
      durationMs: 5
    });

    // Hop 2: API Routing
    hops.push({
      id: 'api_lookup',
      label: 'API Server',
      icon: '⚙️',
      role: 'Routing & Cache Dispatcher',
      request: `GET /${shortCode}\nExtracted Key: urls:${shortCode}`,
      whatIsHappening: `API server extracts short code '${shortCode}'. Checks in-memory Redis cache first to avoid an expensive database query.`,
      whyExists: 'In read-heavy architectures (95%+ reads), checking cache first protects the database from read saturation.',
      commandOrSql: isRedisActive ? `redis.get("urls:${shortCode}")` : `// Redis disabled -> query DB directly`,
      response: isRedisActive ? `Querying Redis Cluster...` : `Bypassing Redis -> Forwarding to DB`,
      durationMs: 2
    });

    // Hop 3: Redis Cache Check
    if (isRedisActive) {
      hops.push({
        id: 'redis_check',
        label: isCacheHit ? 'Redis (CACHE HIT ✅)' : 'Redis (CACHE MISS ⚠️)',
        icon: isCacheHit ? '⚡' : '🔍',
        role: 'In-Memory Cache (RAM)',
        request: `GET urls:${shortCode}`,
        whatIsHappening: isCacheHit 
          ? `CACHE HIT (94% of reads): Key 'urls:${shortCode}' found in Redis memory! Returning long URL in 1.2ms without touching the database.`
          : `CACHE MISS (6% of reads): Key 'urls:${shortCode}' was not found in Redis RAM (expired or first access). Request must fall through to the database.`,
        whyExists: 'Redis holds active working sets in RAM. Avoiding DB lookups keeps read latency under 2ms and shields the DB replica pool.',
        commandOrSql: `GET urls:${shortCode}`,
        response: isCacheHit ? `"${record.longUrl}"` : `(nil) [Key Not Found]`,
        durationMs: 1.2,
        isHit: isCacheHit,
        isMiss: !isCacheHit
      });
    }

    // Hop 4: Database Lookup on Cache Miss (or if Redis is disabled)
    if (!isCacheHit) {
      const replicaLabel = appState.readReplicas > 0 ? `Read Replica Pool (${appState.readReplicas} nodes)` : `Primary Database (Standalone)`;
      hops.push({
        id: 'db_miss_lookup',
        label: replicaLabel,
        icon: '🗄️',
        role: 'Database Read Query',
        request: `SELECT long_url, access_count\nFROM urls\nWHERE short_code = '${shortCode}'\nLIMIT 1;`,
        whatIsHappening: `Database searches the 'urls' table for short_code = '${shortCode}'. ${appState.dbIndexed ? 'Uses B-Tree index for O(log N) fast point lookup (12ms).' : '⚠️ Table is UNINDEXED: executes a full table scan scanning all rows (140ms)!'}`,
        whyExists: 'The database is the durable source of truth. All cache misses must query the database to resolve the target destination.',
        commandOrSql: `SELECT long_url, access_count FROM urls WHERE short_code = '${shortCode}' LIMIT 1;`,
        response: `1 row returned:\nlong_url = "${record.longUrl}"\naccess_count = ${record.accessCount}`,
        durationMs: appState.dbIndexed ? 12 : 140
      });

      // Hop 5: Cache Population (Write-back)
      if (isRedisActive) {
        hops.push({
          id: 'redis_populate',
          label: 'Redis Write-Back (SETEX)',
          icon: '💾',
          role: 'Cache Warming on Miss',
          request: `SETEX urls:${shortCode} 86400 "${record.longUrl}"`,
          whatIsHappening: `API populates Redis cache with the resolved long URL and sets a 24-hour TTL (Time-To-Live). Next lookup for '${shortCode}' will be an instant CACHE HIT!`,
          whyExists: 'Cache-aside pattern: on miss, populate cache so subsequent reads do not hit the database.',
          commandOrSql: `SETEX urls:${shortCode} 86400 "${record.longUrl}"`,
          response: `OK (Key cached for 86400s)`,
          durationMs: 1.2
        });
        record.inCache = true; // Mark as warm in local records
      }
    }

    // Hop 6: Final Redirect Response
    hops.push({
      id: 'redirect_response',
      label: `HTTP ${redirectType} Redirect`,
      icon: '↪️',
      role: 'Client Redirection Response',
      request: `HTTP/1.1 ${redirectStatus}\nLocation: ${record.longUrl}\n${cacheControlHeader}\nX-Cache: ${isCacheHit ? 'HIT' : 'MISS'}`,
      whatIsHappening: redirectType === '301'
        ? `Returns 301 Moved Permanently: Browser will permanently cache this destination. Subsequent visits bypass our servers entirely (reduces server load, but loses click analytics).`
        : `Returns 302 Found: Browser performs a temporary redirect. Future clicks still hit our API server, allowing real-time analytics and click tracking.`,
      whyExists: 'Transports the browser to the long URL destination via standard HTTP redirect headers.',
      commandOrSql: null,
      response: `HTTP/1.1 ${redirectStatus}\nLocation: ${record.longUrl}\n${cacheControlHeader}\nServer: sho.rt-edge\nX-Cache: ${isCacheHit ? 'HIT (1.2ms)' : 'MISS (DB: ' + (appState.dbIndexed ? '12ms' : '140ms') + ')'}`,
      durationMs: 3
    });

    await this.animateTrace(hops, isCacheHit ? 'read-hit' : 'read-miss');
    this.renderDatabaseTable();
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
      db:                ['#fb923c', '251,146,60'],
      db_miss_lookup:    ['#fb923c', '251,146,60'],
      redis_optional:    ['#f59e0b', '245,158,11'],
      redis_check:       ['#f59e0b', '245,158,11'],
      redis_populate:    ['#f59e0b', '245,158,11'],
      response:          ['#34d399', '52,211,153'],
      redirect_response: ['#34d399', '52,211,153'],
    };

    let html = `<div class="pipeline-flow ${this.activeTrace?.traceType || ''}">`;

    hops.forEach((hop, idx) => {
      const isCompleted = idx < activeIndex;
      const isActive    = idx === activeIndex;
      const stateClass  = isActive ? 'hop-active' : (isCompleted ? 'hop-completed' : 'hop-pending');
      const hitMissBadge = hop.isHit
        ? '<span class="badge-hit">● HIT</span>'
        : (hop.isMiss ? '<span class="badge-miss">○ MISS</span>' : '');

      const [hex, rgb] = hopColors[hop.id] || ['#6366f1', '99,102,241'];
      const colorStyle = `--hop-color:${hex};--hop-color-rgb:${rgb};`;

      html += `
        <div class="pipeline-hop ${stateClass}" data-hop-index="${idx}" style="${colorStyle}">
          <div class="hop-inner">
            <div class="hop-icon-bubble">${this.getHopSvgIcon(hop.id)}</div>
            <div class="hop-info">
              <div class="hop-title">${hop.label} ${hitMissBadge}</div>
              <div class="hop-role">${hop.role}</div>
              <div class="hop-latency">${hop.durationMs}ms</div>
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
      db:                ['#fb923c', '251,146,60'],
      db_miss_lookup:    ['#fb923c', '251,146,60'],
      redis_optional:    ['#34d399', '52,211,153'],
      redis_check:       ['#34d399', '52,211,153'],
      redis_populate:    ['#34d399', '52,211,153'],
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
        label: 'Response Payload',
        icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
        code: this.escapeHtml(hop.response),
        lang: 'language-http',
        color: '#4ade80', rgb: '74,222,128'
      });
    }

    this.inspectorEl.innerHTML = `
      <div class="insp-header" style="--hop-color:${hex};--hop-color-rgb:${rgb};">
        <div class="insp-header-left">
          <div class="insp-icon-box">${this.getHopSvgIcon(hop.id)}</div>
          <div class="insp-meta">
            <div class="insp-name-row">
              <span class="insp-component-name">${this.escapeHtml(hop.label)}</span>
              <span class="insp-node-tag">System Node</span>
            </div>
            <span class="insp-role-text">${this.escapeHtml(hop.role)}</span>
          </div>
        </div>
        <div class="insp-header-right">
          <div class="insp-latency-badge" title="Estimated processing latency">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span class="insp-latency-num">${Number(hop.durationMs) || 0}</span>
            <span class="insp-latency-unit">ms</span>
          </div>
        </div>
      </div>

      <div class="insp-cards-row">
        <div class="insp-card insp-card-what">
          <div class="insp-card-label">
            <svg class="insp-label-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
            <span>What is happening</span>
          </div>
          <div class="insp-card-text">${this.escapeHtml(hop.whatIsHappening)}</div>
        </div>
        <div class="insp-card insp-card-why">
          <div class="insp-card-label">
            <svg class="insp-label-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span>Why it exists</span>
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
      case 'db':
      case 'db_miss_lookup':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`;
      case 'redis_optional':
      case 'redis_check':
      case 'redis_populate':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
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
          <td><code class="short-code-badge">${safeShortCode}</code></td>
          <td class="long-url-cell" title="${safeLongUrl}">${safeLongUrl}</td>
          <td class="text-muted">${safeCreatedAt}</td>
          <td><span class="access-pill">${Number(rec.accessCount) || 0}</span></td>
          <td>
            <span class="cache-status-pill ${rec.inCache ? 'in-cache' : 'not-cached'}">
              ${rec.inCache ? '● In Redis RAM' : '○ DB Only'}
            </span>
          </td>
          <td>
            <button class="btn-visit-short" data-short-code="${safeShortCode}">
              Visit (GET)
            </button>
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

    // Attach Visit button click handlers
    this.tableEl.querySelectorAll('.btn-visit-short').forEach(btn => {
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
