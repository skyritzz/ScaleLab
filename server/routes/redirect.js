import { resolveRedirect } from '../services/urlService.js';
import { parseChaosConfig } from '../services/chaosService.js';

export async function redirectRoutes(fastify, options) {
  fastify.get('/:shortCode', async (request, reply) => {
    const { shortCode } = request.params;
    const acceptHeader = request.headers['accept'] || '';
    const wantsJson = acceptHeader.includes('application/json') || request.query?.format === 'json';

    const chaos = parseChaosConfig(request);
    const result = await resolveRedirect(shortCode, chaos);

    // Chaos response headers
    reply.header('X-Chaos-Enabled', chaos.enabled ? 'true' : 'false');
    reply.header('X-Chaos-Fault', chaos.enabled ? chaos.fault : 'none');
    reply.header('X-Chaos-Injected-Delay-Ms', String(chaos.enabled ? chaos.delayMs : 0));

    if (result.notFound) {
      if (result.isReserved) {
        return reply.callNotFound();
      }
      return reply.status(404).send({
        status: 'error',
        message: `Short URL with code '${shortCode}' was not found.`,
        telemetry: result.telemetry
      });
    }

    const { targetUrl, redirectMode, isHit, dbFallback, telemetry } = result;

    // Standard useful observability headers
    const serverTiming = [
      `redis;dur=${telemetry.actual_redis_duration_ms ?? telemetry.redis_duration_ms}`,
      (telemetry.actual_db_duration_ms ?? telemetry.db_duration_ms) > 0 ? `db;dur=${telemetry.actual_db_duration_ms ?? telemetry.db_duration_ms}` : null,
      telemetry.access_update_duration_ms ? `access;dur=${telemetry.access_update_duration_ms}` : null,
      `total;dur=${telemetry.actual_server_duration_ms ?? telemetry.server_duration_ms}`
    ].filter(Boolean).join(', ');

    reply.header('X-Cache', isHit ? 'HIT' : 'MISS');
    reply.header('X-Redirect-Mode', String(redirectMode));
    reply.header('X-Db-Fallback', dbFallback ? 'true' : 'false');
    reply.header('Server-Timing', serverTiming);
    reply.header('Access-Control-Expose-Headers', 'X-Cache, X-Redirect-Mode, X-Db-Fallback, X-Chaos-Enabled, X-Chaos-Fault, X-Chaos-Injected-Delay-Ms, Server-Timing, Location');

    // If client requested JSON (Request Tracer telemetry inspection mode)
    if (wantsJson) {
      return reply.status(200).send({
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
    reply.header(
      'Cache-Control',
      redirectMode === 301
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, no-store, must-revalidate'
    );
    return reply.status(redirectMode).header('Location', targetUrl).send();
  });
}
