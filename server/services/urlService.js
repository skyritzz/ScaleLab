import crypto from 'node:crypto';
import { pool } from '../db.js';
import { getShortUrl, setShortUrl } from '../redis.js';
import { generateShortCode } from '../idgen.js';
import { validateDestinationUrl } from '../middleware/security.js';
import { sleep } from './chaosService.js';

const RESERVED_SLUGS = new Set([
  '',
  'api',
  'assets',
  'css',
  'js',
  'favicon.ico',
  'robots.txt',
  'health',
  'index.html',
  'dist'
]);

const SHORT_CODE_REGEX = /^[a-zA-Z0-9_-]{3,16}$/;

/**
 * Increment access count in database with execution timing
 */
export async function recordAccess(urlId) {
  if (!urlId) return { durationMs: 0, success: false };
  const start = performance.now();
  try {
    await pool.query(
      'UPDATE urls SET access_count = access_count + 1, updated_at = NOW() WHERE id = $1',
      [urlId]
    );
    return {
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      success: true
    };
  } catch (err) {
    console.warn(`[Service] Failed to increment access_count for id ${urlId}:`, err.message);
    return {
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      success: false,
      error: err.message
    };
  }
}

/**
 * Core business logic: Create short URL with persistence and cache pre-warming
 */
function computeRequestHash(payload) {
  const normalized = JSON.stringify({
    url: String(payload.url || '').trim(),
    strategy: String(payload.strategy || 'base62'),
    redirect_mode: Number(payload.redirectMode || 302)
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Core business logic: Create short URL with idempotency, collision recovery, and cache pre-warming
 */
export async function createShortUrl({
  url,
  strategy = 'base62',
  redirectMode = 302,
  baseUrl,
  idempotencyKey = null,
  forceCollision = false,
  chaos = null
}) {
  const serverStart = performance.now();
  const chaosConfig = chaos || { enabled: false, fault: null, delayMs: 0 };

  // Injected API Latency Fault
  if (chaosConfig.enabled && chaosConfig.fault === 'api_latency') {
    await sleep(chaosConfig.delayMs);
  }

  // 1. Strict server-side validation and SSRF filtering
  const validation = await validateDestinationUrl(url);
  if (!validation.isValid) {
    const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;
    const telemetry = {
      chaos_enabled: Boolean(chaosConfig.enabled),
      injected_fault: chaosConfig.fault || null,
      injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
      redis_hit: false,
      db_fallback: false,
      idempotency_checked: Boolean(idempotencyKey),
      idempotency_hit: false,
      collision_detected: false,
      collision_attempts: 1,
      short_code: null,
      server_duration_ms: serverDurationMs,
      actual_server_duration_ms: serverDurationMs,
      db_duration_ms: 0,
      actual_db_duration_ms: 0,
      redis_duration_ms: 0,
      actual_redis_duration_ms: 0,
      http_status: 400,
      actual_http_status: 400
    };
    return {
      status: 400,
      data: { status: 'error', message: validation.error, telemetry },
      telemetry,
      isReplay: false
    };
  }

  const destinationUrl = validation.sanitizedUrl;
  const requestHash = computeRequestHash({ url: destinationUrl, strategy, redirectMode });
  const client = await pool.connect();

  let createdRow = null;
  let attempts = 0;
  const maxAttempts = 5;
  let collisionDetected = false;
  let dbDurationMs = 0;
  const isDevOrTest = process.env.NODE_ENV !== 'production' && !process.env.VERCEL;
  const shouldForceCollision = Boolean(forceCollision && isDevOrTest);

  try {
    await client.query('BEGIN');

    // 2. Concurrency-safe idempotency check
    if (idempotencyKey) {
      // Advisory transaction lock guarantees serialize access for identical idempotency keys
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);

      const checkRes = await client.query(
        'SELECT idempotency_key, request_hash, response_code, response_body FROM idempotency_keys WHERE idempotency_key = $1',
        [idempotencyKey]
      );

      if (checkRes.rows.length > 0) {
        const existing = checkRes.rows[0];
        await client.query('COMMIT');

        const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;

        if (existing.request_hash !== requestHash) {
          // Same key with different payload -> 409 Conflict
          const telemetry = {
            idempotency_checked: true,
            idempotency_hit: false,
            collision_detected: false,
            collision_attempts: 1,
            short_code: null,
            server_duration_ms: serverDurationMs,
            actual_server_duration_ms: serverDurationMs,
            db_duration_ms: 0,
            actual_db_duration_ms: 0,
            redis_duration_ms: 0,
            actual_redis_duration_ms: 0,
            http_status: 409,
            actual_http_status: 409
          };
          return {
            status: 409,
            data: {
              status: 'error',
              message: 'Idempotency key conflict: same key was previously used with a different request payload.',
              telemetry
            },
            telemetry,
            isReplay: false
          };
        }

        // Same key with same payload -> Return cached idempotent response
        const cachedData = existing.response_body;
        const replayTelemetry = {
          ...(cachedData.telemetry || {}),
          idempotency_checked: true,
          idempotency_hit: true,
          server_duration_ms: serverDurationMs,
          actual_server_duration_ms: serverDurationMs,
          http_status: existing.response_code,
          actual_http_status: existing.response_code
        };
        const replayData = {
          ...cachedData,
          telemetry: replayTelemetry
        };

        return {
          status: existing.response_code,
          data: replayData,
          telemetry: replayTelemetry,
          isReplay: true
        };
      }
    }

    // 3. Generation and Collision Recovery Loop (up to 5 attempts)
    const dbStart = performance.now();

    while (attempts < maxAttempts) {
      attempts++;
      let { shortCode } = await generateShortCode(client, strategy, destinationUrl, attempts);

      // Dev-only forced collision hook: force candidate to collide on attempt 1
      if (shouldForceCollision && attempts === 1) {
        const existing = await client.query('SELECT short_code FROM urls LIMIT 1');
        if (existing.rows.length > 0) {
          shortCode = existing.rows[0].short_code;
        } else {
          await client.query(
            "INSERT INTO urls (short_code, long_url, redirect_mode) VALUES ('seed_col', 'https://example.com/seed', 302) ON CONFLICT DO NOTHING"
          );
          shortCode = 'seed_col';
        }
      }

      try {
        await client.query('SAVEPOINT sp_insert_url');
        const insertQuery = `
          INSERT INTO urls (short_code, long_url, redirect_mode, access_count, created_at, updated_at)
          VALUES ($1, $2, $3, 0, NOW(), NOW())
          RETURNING id, short_code, long_url, redirect_mode, access_count, created_at;
        `;
        const result = await client.query(insertQuery, [shortCode, destinationUrl, redirectMode]);
        await client.query('RELEASE SAVEPOINT sp_insert_url');
        createdRow = result.rows[0];
        break; // Successfully inserted
      } catch (dbErr) {
        await client.query('ROLLBACK TO SAVEPOINT sp_insert_url');
        // Detect unique violation (23505) specifically for short_code
        const isShortCodeCollision = dbErr.code === '23505' &&
          (dbErr.constraint?.includes('short_code') || dbErr.detail?.includes('short_code') || !dbErr.constraint);

        if (isShortCodeCollision) {
          collisionDetected = true;
          console.warn(`[Service] Collision detected for short_code '${shortCode}', retrying with salt (attempt ${attempts}/${maxAttempts})...`);
          if (attempts >= maxAttempts) {
            throw new Error(`Failed to generate a unique short code after ${maxAttempts} attempts.`);
          }
        } else {
          throw dbErr;
        }
      }
    }

    // Injected DB Latency Fault
    if (chaosConfig.enabled && chaosConfig.fault === 'db_latency') {
      await sleep(chaosConfig.delayMs);
    }

    dbDurationMs = Math.round((performance.now() - dbStart) * 10) / 10;

    const formattedBase = (baseUrl || process.env.BASE_URL || '').replace(/\/+$/, '');
    const shortUrl = `${formattedBase}/${createdRow.short_code}`;

    const initialTelemetry = {
      chaos_enabled: Boolean(chaosConfig.enabled),
      injected_fault: chaosConfig.fault || null,
      injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
      redis_hit: false,
      db_fallback: false,
      idempotency_checked: Boolean(idempotencyKey),
      idempotency_hit: false,
      collision_detected: collisionDetected,
      collision_attempts: attempts,
      short_code: createdRow.short_code,
      server_duration_ms: 0,
      actual_server_duration_ms: 0,
      db_duration_ms: dbDurationMs,
      actual_db_duration_ms: dbDurationMs,
      redis_duration_ms: 0,
      actual_redis_duration_ms: 0,
      http_status: 201,
      actual_http_status: 201
    };

    const responseBody = {
      status: 'success',
      short_code: createdRow.short_code,
      short_url: shortUrl,
      long_url: createdRow.long_url,
      redirect_mode: createdRow.redirect_mode,
      created_at: createdRow.created_at.toISOString(),
      telemetry: initialTelemetry
    };

    // Persist idempotency record within transaction
    if (idempotencyKey) {
      await client.query(`
        INSERT INTO idempotency_keys (idempotency_key, request_hash, response_code, response_body)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (idempotency_key) DO UPDATE
        SET response_code = EXCLUDED.response_code, response_body = EXCLUDED.response_body;
      `, [idempotencyKey, requestHash, 201, JSON.stringify(responseBody)]);
    }

    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }

  if (!createdRow) {
    const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;
    const telemetry = {
      chaos_enabled: Boolean(chaosConfig.enabled),
      injected_fault: chaosConfig.fault || null,
      injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
      redis_hit: false,
      db_fallback: false,
      idempotency_checked: Boolean(idempotencyKey),
      idempotency_hit: false,
      collision_detected: collisionDetected,
      collision_attempts: attempts,
      short_code: null,
      server_duration_ms: serverDurationMs,
      actual_server_duration_ms: serverDurationMs,
      db_duration_ms: dbDurationMs,
      actual_db_duration_ms: dbDurationMs,
      redis_duration_ms: 0,
      actual_redis_duration_ms: 0,
      http_status: 500,
      actual_http_status: 500
    };
    return {
      status: 500,
      data: { status: 'error', message: 'Failed to create short URL in database after retry limit', telemetry },
      telemetry,
      isReplay: false
    };
  }

  const formattedBase = (baseUrl || process.env.BASE_URL || '').replace(/\/+$/, '');
  const shortUrl = `${formattedBase}/${createdRow.short_code}`;

  // Pre-warm Redis cache (failure will not fail database persistence)
  let redisWarmResult = { success: false, durationMs: 0 };
  let redisDurationMs = 0;

  if (chaosConfig.enabled && chaosConfig.fault === 'redis_failure') {
    // Simulated Redis failure: skip or fail cache warming
    console.warn(`[Chaos] Simulated Redis failure injected: skipping cache warming for '${createdRow.short_code}'`);
    redisDurationMs = 1.0;
  } else {
    const redisStart = performance.now();
    redisWarmResult = await setShortUrl(createdRow.short_code, {
      id: Number(createdRow.id),
      longUrl: createdRow.long_url,
      redirectMode: createdRow.redirect_mode
    }, 86400);

    if (chaosConfig.enabled && chaosConfig.fault === 'redis_latency') {
      await sleep(chaosConfig.delayMs);
    }

    redisDurationMs = redisWarmResult.durationMs || Math.round((performance.now() - redisStart) * 10) / 10;
    if (chaosConfig.enabled && chaosConfig.fault === 'redis_latency') {
      redisDurationMs = Math.round((redisDurationMs + chaosConfig.delayMs) * 10) / 10;
    }
  }

  const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;

  const finalTelemetry = {
    chaos_enabled: Boolean(chaosConfig.enabled),
    injected_fault: chaosConfig.fault || null,
    injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
    redis_hit: false,
    db_fallback: false,
    idempotency_checked: Boolean(idempotencyKey),
    idempotency_hit: false,
    collision_detected: collisionDetected,
    collision_attempts: attempts,
    short_code: createdRow.short_code,
    server_duration_ms: serverDurationMs,
    actual_server_duration_ms: serverDurationMs,
    db_duration_ms: dbDurationMs,
    actual_db_duration_ms: dbDurationMs,
    redis_duration_ms: redisDurationMs,
    actual_redis_duration_ms: redisDurationMs,
    http_status: 201,
    actual_http_status: 201,
    redis_cached: Boolean(redisWarmResult.success)
  };

  const finalResponseBody = {
    status: 'success',
    short_code: createdRow.short_code,
    short_url: shortUrl,
    long_url: createdRow.long_url,
    redirect_mode: createdRow.redirect_mode,
    created_at: createdRow.created_at.toISOString(),
    telemetry: finalTelemetry
  };

  // Update persisted idempotency record with final complete telemetry
  if (idempotencyKey) {
    pool.query(
      'UPDATE idempotency_keys SET response_body = $1 WHERE idempotency_key = $2',
      [JSON.stringify(finalResponseBody), idempotencyKey]
    ).catch(err => {
      console.warn('[Service] Failed to update idempotency telemetry:', err.message);
    });
  }

  return {
    status: 201,
    data: finalResponseBody,
    telemetry: finalTelemetry,
    isReplay: false
  };
}

/**
 * Core business logic: Retrieve latest stored records
 */
export async function getRecentUrls({ baseUrl, limit = 50 }) {
  const queryText = `
    SELECT id, short_code, long_url, redirect_mode, access_count, created_at, updated_at
    FROM urls
    ORDER BY created_at DESC
    LIMIT $1;
  `;
  const result = await pool.query(queryText, [limit]);

  const formattedBase = (baseUrl || process.env.BASE_URL || '').replace(/\/+$/, '');

  const formattedRecords = result.rows.map(row => ({
    id: Number(row.id),
    short_code: row.short_code,
    short_url: `${formattedBase}/${row.short_code}`,
    long_url: row.long_url,
    redirect_mode: row.redirect_mode,
    access_count: Number(row.access_count),
    created_at: row.created_at.toISOString()
  }));

  return {
    status: 200,
    data: {
      status: 'success',
      count: formattedRecords.length,
      data: formattedRecords
    }
  };
}

/**
 * Core business logic: Resolve short URL redirect with real telemetry
 */
export async function resolveRedirect(shortCode, chaos = null) {
  const serverStart = performance.now();
  const chaosConfig = chaos || { enabled: false, fault: null, delayMs: 0 };
  const lower = (shortCode || '').trim().toLowerCase();

  // 1. Reserved slugs or invalid format
  if (RESERVED_SLUGS.has(lower) || lower.startsWith('api') || !SHORT_CODE_REGEX.test(shortCode)) {
    const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;
    return {
      notFound: true,
      isReserved: true,
      telemetry: {
        chaos_enabled: Boolean(chaosConfig.enabled),
        injected_fault: chaosConfig.fault || null,
        injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
        redis_hit: false,
        db_fallback: false,
        server_duration_ms: serverDurationMs,
        actual_server_duration_ms: serverDurationMs,
        redis_duration_ms: 0,
        actual_redis_duration_ms: 0,
        db_duration_ms: 0,
        actual_db_duration_ms: 0,
        cache_hit: false,
        http_status: 404,
        actual_http_status: 404
      }
    };
  }

  // 2. Check Redis cache first
  let cached = null;
  let isHit = false;
  let redisDurationMs = 0;

  if (chaosConfig.enabled && chaosConfig.fault === 'redis_failure') {
    // Controlled simulated failure: treat Redis as offline/unreachable
    console.warn(`[Chaos] Simulated Redis failure injected for '${shortCode}'. Cascading to PostgreSQL fallback.`);
    redisDurationMs = 1.0;
    isHit = false;
  } else {
    const redisStart = performance.now();
    const redisRes = await getShortUrl(shortCode);
    cached = redisRes.data;
    isHit = redisRes.isHit;
    redisDurationMs = redisRes.durationMs || Math.round((performance.now() - redisStart) * 10) / 10;

    if (chaosConfig.enabled && chaosConfig.fault === 'redis_latency') {
      await sleep(chaosConfig.delayMs);
      redisDurationMs = Math.round((redisDurationMs + chaosConfig.delayMs) * 10) / 10;
    }
  }

  if (isHit && cached && cached.longUrl) {
    const redirectMode = Number(cached.redirectMode) === 301 ? 301 : 302;
    const accessRes = await recordAccess(cached.id);

    if (chaosConfig.enabled && chaosConfig.fault === 'api_latency') {
      await sleep(chaosConfig.delayMs);
    }

    const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;

    return {
      targetUrl: cached.longUrl,
      redirectMode,
      isHit: true,
      dbFallback: false,
      telemetry: {
        chaos_enabled: Boolean(chaosConfig.enabled),
        injected_fault: chaosConfig.fault || null,
        injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
        redis_hit: true,
        db_fallback: false,
        cache_hit: true,
        server_duration_ms: serverDurationMs,
        actual_server_duration_ms: serverDurationMs,
        redis_duration_ms: redisDurationMs,
        actual_redis_duration_ms: redisDurationMs,
        db_duration_ms: 0,
        actual_db_duration_ms: 0,
        http_status: redirectMode,
        actual_http_status: redirectMode,
        redirect_mode: redirectMode,
        access_update_duration_ms: accessRes.durationMs
      }
    };
  }

  // 3. Query PostgreSQL on cache MISS (or when Redis simulated failure triggered fallback)
  const dbStart = performance.now();
  const queryText = `
    SELECT id, long_url, redirect_mode, access_count
    FROM urls
    WHERE short_code = $1
    LIMIT 1;
  `;
  const result = await pool.query(queryText, [shortCode]);
  let dbDurationMs = Math.round((performance.now() - dbStart) * 10) / 10;

  if (chaosConfig.enabled && chaosConfig.fault === 'db_latency') {
    await sleep(chaosConfig.delayMs);
    dbDurationMs = Math.round((dbDurationMs + chaosConfig.delayMs) * 10) / 10;
  }

  if (result.rows.length === 0) {
    const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;
    return {
      notFound: true,
      isReserved: false,
      telemetry: {
        chaos_enabled: Boolean(chaosConfig.enabled),
        injected_fault: chaosConfig.fault || null,
        injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
        redis_hit: false,
        db_fallback: true,
        cache_hit: false,
        server_duration_ms: serverDurationMs,
        actual_server_duration_ms: serverDurationMs,
        redis_duration_ms: redisDurationMs,
        actual_redis_duration_ms: redisDurationMs,
        db_duration_ms: dbDurationMs,
        actual_db_duration_ms: dbDurationMs,
        http_status: 404,
        actual_http_status: 404
      }
    };
  }

  const row = result.rows[0];
  const redirectMode = Number(row.redirect_mode) === 301 ? 301 : 302;
  const targetUrl = row.long_url;

  // 4. Populate Redis cache on MISS (skip if simulating Redis failure)
  let redisSetMs = 0;
  if (!(chaosConfig.enabled && chaosConfig.fault === 'redis_failure')) {
    const redisSetStart = performance.now();
    await setShortUrl(shortCode, {
      id: Number(row.id),
      longUrl: targetUrl,
      redirectMode
    }, 86400);
    redisSetMs = Math.round((performance.now() - redisSetStart) * 10) / 10;
  }

  // 5. Increment access_count
  const accessRes = await recordAccess(row.id);

  if (chaosConfig.enabled && chaosConfig.fault === 'api_latency') {
    await sleep(chaosConfig.delayMs);
  }

  const serverDurationMs = Math.round((performance.now() - serverStart) * 10) / 10;

  return {
    targetUrl,
    redirectMode,
    isHit: false,
    dbFallback: true,
    telemetry: {
      chaos_enabled: Boolean(chaosConfig.enabled),
      injected_fault: chaosConfig.fault || null,
      injected_delay_ms: chaosConfig.enabled ? (chaosConfig.delayMs || 0) : 0,
      redis_hit: false,
      db_fallback: true,
      cache_hit: false,
      server_duration_ms: serverDurationMs,
      actual_server_duration_ms: serverDurationMs,
      redis_duration_ms: Math.round((redisDurationMs + redisSetMs) * 10) / 10,
      actual_redis_duration_ms: Math.round((redisDurationMs + redisSetMs) * 10) / 10,
      db_duration_ms: dbDurationMs,
      actual_db_duration_ms: dbDurationMs,
      http_status: redirectMode,
      actual_http_status: redirectMode,
      redirect_mode: redirectMode,
      access_update_duration_ms: accessRes.durationMs
    }
  };
}
