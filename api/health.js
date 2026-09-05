import { pool } from '../server/db.js';
import { redis, ensureRedis } from '../server/redis.js';

let isContainerWarm = false;
let invocationCount = 0;

export default async function handler(req, res) {
  const handlerStart = performance.now();
  invocationCount++;
  const isCold = !isContainerWarm;
  isContainerWarm = true;

  let pgConnectMs = 0;
  let pgQueryMs = 0;
  let pgOk = false;
  let pgError = null;

  try {
    const t0 = performance.now();
    const client = await pool.connect();
    pgConnectMs = Math.round((performance.now() - t0) * 10) / 10;

    const t1 = performance.now();
    await client.query('SELECT 1');
    pgQueryMs = Math.round((performance.now() - t1) * 10) / 10;
    client.release();
    pgOk = true;
  } catch (err) {
    pgError = err.message;
    console.warn('[Health] Database ping failed:', err.message);
  }

  let redisConnectMs = 0;
  let redisCommandMs = 0;
  let redisOk = false;
  let redisError = null;

  try {
    const initialStatus = redis.status;
    const t2 = performance.now();
    const isConnected = await ensureRedis();
    redisConnectMs = Math.round((performance.now() - t2) * 10) / 10;

    if (isConnected) {
      const t3 = performance.now();
      const pong = await redis.ping();
      redisCommandMs = Math.round((performance.now() - t3) * 10) / 10;
      redisOk = pong === 'PONG';
    }
  } catch (err) {
    redisError = err.message;
    console.warn('[Health] Redis ping failed:', err.message);
  }

  const totalDurationMs = Math.round((performance.now() - handlerStart) * 10) / 10;

  return res.status(200).json({
    status: pgOk && redisOk ? 'healthy' : 'degraded',
    is_cold_start: isCold,
    invocation_count: invocationCount,
    vercel_region: process.env.VERCEL_REGION || 'local',
    postgres: {
      ok: pgOk,
      connect_ms: pgConnectMs,
      query_ms: pgQueryMs,
      error: pgError
    },
    redis: {
      ok: redisOk,
      status: redis.status,
      connect_ms: redisConnectMs,
      command_ms: redisCommandMs,
      error: redisError
    },
    total_server_duration_ms: totalDurationMs,
    runtime: 'Vercel Serverless',
    timestamp: new Date().toISOString()
  });
}
