import Redis from 'ioredis';
import 'dotenv/config';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const isTls = redisUrl.startsWith('rediss://');

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  tls: isTls ? { rejectUnauthorized: false } : undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  console.log('[Redis] Connected to Redis server.');
});

redis.on('error', (err) => {
  console.warn('[Redis] Redis error (degraded cache mode):', err.message);
});

/**
 * Initialize Redis connection safely
 */
export async function initRedis() {
  try {
    await redis.connect();
    const pong = await redis.ping();
    console.log(`[Redis] Healthcheck PING: ${pong}`);
    return true;
  } catch (err) {
    console.warn('[Redis] Warning: Redis failed to connect on startup. Operating without cache:', err.message);
    return false;
  }
}

/**
 * Ensure Redis is connected before performing operations
 */
export async function ensureRedis() {
  if (redis.status === 'ready') return true;
  if (redis.status === 'wait') {
    try {
      await redis.connect();
      return true;
    } catch (err) {
      console.warn('[Redis] Connection failed:', err.message);
      return false;
    }
  }
  return redis.status === 'ready' || redis.status === 'connecting';
}

/**
 * Pre-warm or populate cache with URL data (safe wrapper, does not throw)
 */
export async function setShortUrl(shortCode, data, ttlSeconds = 86400) {
  try {
    if (redis.status === 'wait') {
      await redis.connect().catch(() => {});
    }
    if (redis.status !== 'ready') return { success: false, durationMs: 0 };
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const start = performance.now();
    await redis.setex(`urls:${shortCode}`, ttlSeconds, payload);
    const durationMs = Math.round((performance.now() - start) * 10) / 10;
    return { success: true, durationMs };
  } catch (err) {
    console.warn(`[Redis] Failed to cache short code ${shortCode}:`, err.message);
    return { success: false, durationMs: 0, error: err.message };
  }
}

/**
 * Retrieve cached URL data
 */
export async function getShortUrl(shortCode) {
  try {
    if (redis.status === 'wait') {
      await redis.connect().catch(() => {});
    }
    if (redis.status !== 'ready') return { data: null, isHit: false, durationMs: 0 };
    const start = performance.now();
    const raw = await redis.get(`urls:${shortCode}`);
    const durationMs = Math.round((performance.now() - start) * 10) / 10;
    if (!raw) return { data: null, isHit: false, durationMs };
    const parsed = JSON.parse(raw);
    return { data: parsed, isHit: true, durationMs };
  } catch (err) {
    console.warn(`[Redis] Cache fetch failed for ${shortCode}:`, err.message);
    return { data: null, isHit: false, durationMs: 0, error: err.message };
  }
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis() {
  try {
    if (redis.status === 'ready' || redis.status === 'connecting') {
      await redis.quit();
    }
  } catch (err) {
    // Ignore close errors during shutdown
  }
  console.log('[Redis] Redis connection closed.');
}
