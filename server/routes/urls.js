import { createShortUrl, getRecentUrls } from '../services/urlService.js';
import { parseChaosConfig } from '../services/chaosService.js';

export async function urlRoutes(fastify, options) {
  // POST /api/v1/urls - Shorten URL
  fastify.post('/api/v1/urls', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          strategy: { type: 'string', enum: ['base62', 'hash', 'snowflake'] },
          redirect_mode: { type: 'integer', enum: [301, 302] }
        }
      }
    }
  }, async (request, reply) => {
    const { url, strategy = 'base62', redirect_mode = 302 } = request.body;

    const configuredBase = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : '';
    const fallbackBase = `${request.protocol}://${request.headers.host || `${process.env.HOST || 'localhost'}:${process.env.PORT || 4000}`}`;
    const baseUrl = configuredBase || fallbackBase;

    const chaos = parseChaosConfig(request);
    const result = await createShortUrl({
      url,
      strategy,
      redirectMode: redirect_mode,
      baseUrl,
      chaos
    });

    reply.header('X-Chaos-Enabled', chaos.enabled ? 'true' : 'false');
    reply.header('X-Chaos-Fault', chaos.enabled ? chaos.fault : 'none');
    reply.header('X-Chaos-Injected-Delay-Ms', String(chaos.enabled ? chaos.delayMs : 0));

    if (result.telemetry) {
      const { server_duration_ms, db_duration_ms, redis_duration_ms } = result.telemetry;
      reply.header('Server-Timing', `server;dur=${server_duration_ms}, db;dur=${db_duration_ms}, redis;dur=${redis_duration_ms}`);
      reply.header('Access-Control-Expose-Headers', 'Server-Timing, X-Chaos-Enabled, X-Chaos-Fault, X-Chaos-Injected-Delay-Ms');
    }

    return reply.status(result.status).send(result.data);
  });

  // GET /api/v1/urls - Retrieve latest 50 records
  fastify.get('/api/v1/urls', async (request, reply) => {
    const configuredBase = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : '';
    const fallbackBase = `${request.protocol}://${request.headers.host || `${process.env.HOST || 'localhost'}:${process.env.PORT || 4000}`}`;
    const baseUrl = configuredBase || fallbackBase;

    const result = await getRecentUrls({ baseUrl, limit: 50 });
    return reply.status(result.status).send(result.data);
  });
}
