import { resolveRedirect } from '../server/services/urlService.js';
import { parseChaosConfig } from '../server/services/chaosService.js';

export default async function handler(req, res) {
  const shortCode = req.query.code || req.query.shortCode;

  if (!shortCode) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing short code query parameter.'
    });
  }

  const acceptHeader = req.headers['accept'] || '';
  const wantsJson = acceptHeader.includes('application/json') || req.query.format === 'json';

  const chaos = parseChaosConfig(req);
  const result = await resolveRedirect(shortCode, chaos);

  // Chaos response headers
  res.setHeader('X-Chaos-Enabled', chaos.enabled ? 'true' : 'false');
  res.setHeader('X-Chaos-Fault', chaos.enabled ? chaos.fault : 'none');
  res.setHeader('X-Chaos-Injected-Delay-Ms', String(chaos.enabled ? chaos.delayMs : 0));

  if (result.notFound) {
    return res.status(404).json({
      status: 'error',
      message: `Short URL with code '${shortCode}' was not found.`,
      telemetry: result.telemetry
    });
  }

  const { targetUrl, redirectMode, isHit, dbFallback, telemetry } = result;

  // Useful observability headers
  const serverTiming = [
    `redis;dur=${telemetry.actual_redis_duration_ms ?? telemetry.redis_duration_ms}`,
    (telemetry.actual_db_duration_ms ?? telemetry.db_duration_ms) > 0 ? `db;dur=${telemetry.actual_db_duration_ms ?? telemetry.db_duration_ms}` : null,
    telemetry.access_update_duration_ms ? `access;dur=${telemetry.access_update_duration_ms}` : null,
    `total;dur=${telemetry.actual_server_duration_ms ?? telemetry.server_duration_ms}`
  ].filter(Boolean).join(', ');

  res.setHeader('X-Cache', isHit ? 'HIT' : 'MISS');
  res.setHeader('X-Redirect-Mode', String(redirectMode));
  res.setHeader('X-Db-Fallback', dbFallback ? 'true' : 'false');
  res.setHeader('Server-Timing', serverTiming);
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache, X-Redirect-Mode, X-Db-Fallback, X-Chaos-Enabled, X-Chaos-Fault, X-Chaos-Injected-Delay-Ms, Server-Timing, Location');

  // If client requested JSON (telemetry inspection mode)
  if (wantsJson) {
    return res.status(200).json({
      status: 'success',
      short_code: shortCode,
      destination: targetUrl,
      redirect_mode: redirectMode,
      cache_hit: isHit,
      redis_hit: isHit,
      db_fallback: dbFallback,
      http_status: redirectMode,
      chaos_enabled: chaos.enabled,
      injected_fault: chaos.fault,
      injected_delay_ms: chaos.delayMs,
      telemetry
    });
  }

  // Standard browser redirect
  res.setHeader(
    'Cache-Control',
    redirectMode === 301
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, no-store, must-revalidate'
  );
  res.setHeader('Location', targetUrl);
  return res.status(redirectMode).end();
}
