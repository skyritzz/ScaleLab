import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { runMigrations, closeDb, pool } from './db.js';
import { initRedis, closeRedis, redis } from './redis.js';
import { urlRoutes } from './routes/urls.js';
import { redirectRoutes } from './routes/redirect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined
    }
  });

  // Enable CORS
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  // Serve static assets without intercepting short-code redirects
  const cssDir = path.join(projectRoot, 'css');
  if (fs.existsSync(cssDir)) {
    await fastify.register(fastifyStatic, {
      root: cssDir,
      prefix: '/css/',
      decorateReply: false
    });
  }

  const jsDir = path.join(projectRoot, 'js');
  if (fs.existsSync(jsDir)) {
    await fastify.register(fastifyStatic, {
      root: jsDir,
      prefix: '/js/',
      decorateReply: false
    });
  }

  const distAssetsDir = path.join(projectRoot, 'dist', 'assets');
  if (fs.existsSync(distAssetsDir)) {
    await fastify.register(fastifyStatic, {
      root: distAssetsDir,
      prefix: '/assets/',
      decorateReply: false
    });
  }

  // Root / serves index.html
  fastify.get('/', async (request, reply) => {
    const indexPath = path.join(projectRoot, 'index.html');
    if (fs.existsSync(indexPath)) {
      return reply.type('text/html').send(fs.readFileSync(indexPath, 'utf-8'));
    }
    return reply.send({ status: 'ok', service: 'sho.rt backend' });
  });

  // Favicon and robots handlers
  fastify.get('/favicon.ico', async (request, reply) => reply.status(204).send());
  fastify.get('/robots.txt', async (request, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /api/\n'));

  // Consistent JSON error handler
  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error);
    const statusCode = error.statusCode || (error.validation ? 400 : 500);
    const message = error.validation
      ? `Validation failed: ${error.validation.map(v => v.message).join(', ')}`
      : (error.message || 'An unexpected error occurred');

    reply.status(statusCode).send({
      status: 'error',
      message
    });
  });

  // Custom 404 handler for non-existent routes
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      status: 'error',
      message: `Resource not found: ${request.method} ${request.url}`
    });
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    let pgOk = false;
    let redisOk = false;

    try {
      await pool.query('SELECT 1');
      pgOk = true;
    } catch {
      pgOk = false;
    }

    try {
      if (redis.status === 'ready') {
        await redis.ping();
        redisOk = true;
      }
    } catch {
      redisOk = false;
    }

    return {
      status: pgOk ? 'healthy' : 'degraded',
      postgres: pgOk,
      redis: redisOk,
      timestamp: new Date().toISOString()
    };
  });

  // Register URL shortener API routes (/api/v1/urls)
  await fastify.register(urlRoutes);

  // Register Redirect routes (GET /:shortCode)
  await fastify.register(redirectRoutes);

  return fastify;
}

async function start() {
  console.log('[Server] Initializing sho.rt backend services...');

  // 1. Run database migrations
  try {
    await runMigrations();
  } catch (err) {
    console.error('[Server] Critical: Failed to run database migrations:', err.message);
    process.exit(1);
  }

  // 2. Connect Redis
  await initRedis();

  // 3. Build and launch Fastify
  const server = await buildServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`[Server] sho.rt backend running at http://${HOST}:${PORT}`);
    console.log(`[Server] Base URL configured: ${process.env.BASE_URL || `http://${HOST}:${PORT}`}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // 4. Graceful shutdown handler
  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
    try {
      await server.close();
      console.log('[Server] HTTP server closed.');
      await closeDb();
      await closeRedis();
      console.log('[Server] Graceful shutdown complete. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during graceful shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start server if executed directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  start();
}
