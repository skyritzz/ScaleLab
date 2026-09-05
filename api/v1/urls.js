import { createShortUrl, getRecentUrls } from '../../server/services/urlService.js';
import { parseChaosConfig } from '../../server/services/chaosService.js';
import { runMigrations } from '../../server/db.js';

let isMigrated = false;
async function ensureMigrations() {
  if (!isMigrated) {
    try {
      await runMigrations();
      isMigrated = true;
    } catch (err) {
      console.warn('[Vercel API] Migration check skipped or failed:', err.message);
    }
  }
}

export default async function handler(req, res) {
  // CORS support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Test-Force-Collision, X-Chaos-Fault, X-Chaos-Delay-Ms, X-Chaos-Key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  await ensureMigrations();

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { url, strategy = 'base62', redirect_mode = 302 } = body;

    const chaos = parseChaosConfig(req);
    const idempotencyKey = req.headers['idempotency-key'] || null;
    const forceCollision = req.headers['x-test-force-collision'] === 'true';

    const result = await createShortUrl({
      url,
      strategy,
      redirectMode: Number(redirect_mode) || 302,
      baseUrl,
      idempotencyKey,
      forceCollision,
      chaos
    });

    res.setHeader('X-Chaos-Enabled', chaos.enabled ? 'true' : 'false');
    res.setHeader('X-Chaos-Fault', chaos.enabled ? chaos.fault : 'none');
    res.setHeader('X-Chaos-Injected-Delay-Ms', String(chaos.enabled ? chaos.delayMs : 0));

    if (result.isReplay) {
      res.setHeader('Idempotent-Replay', 'true');
    }

    if (result.telemetry) {
      const { server_duration_ms, db_duration_ms, redis_duration_ms } = result.telemetry;
      res.setHeader('Server-Timing', `server;dur=${server_duration_ms}, db;dur=${db_duration_ms}, redis;dur=${redis_duration_ms}`);
      res.setHeader('Access-Control-Expose-Headers', 'Server-Timing, Idempotent-Replay, X-Chaos-Enabled, X-Chaos-Fault, X-Chaos-Injected-Delay-Ms');
    }

    return res.status(result.status).json(result.data);
  }

  if (req.method === 'GET') {
    const result = await getRecentUrls({ baseUrl, limit: 50 });
    return res.status(result.status).json(result.data);
  }

  res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
  return res.status(405).json({
    status: 'error',
    message: `Method ${req.method} Not Allowed`
  });
}
