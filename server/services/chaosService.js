/**
 * Chaos Service: Controlled Fault Injection Engine
 * 
 * Safety Guarantee:
 * - OFF by default.
 * - Per-request scoping: No global process, database, or cache state mutation.
 * - PostgreSQL is NEVER shut down or flushed.
 * - Redis is NEVER shut down or flushed.
 * - In production, strictly requires server-side demo authorization (ENABLE_CHAOS_EXPERIMENTS=true and matching token).
 * - Latency bounded to [0, 2000] ms.
 */

const ALLOWED_FAULTS = new Set([
  'api_latency',
  'redis_latency',
  'db_latency',
  'redis_failure'
]);

export const DEFAULT_DEMO_KEY = 'scale-lab-chaos-demo-2026';
const MAX_DELAY_MS = 2000;
const MIN_DELAY_MS = 0;

/**
 * Parse and authorize per-request chaos configuration
 */
export function parseChaosConfig(req) {
  if (!req) {
    return { enabled: false, fault: null, delayMs: 0 };
  }

  const headers = req.headers || {};
  const query = req.query || {};

  const rawFault = (headers['x-chaos-fault'] || query.chaos_fault || query.chaosFault || '').toString().trim().toLowerCase();
  if (!rawFault || rawFault === 'none' || rawFault === 'off') {
    return { enabled: false, fault: null, delayMs: 0 };
  }

  // Reject invalid fault names safely
  if (!ALLOWED_FAULTS.has(rawFault)) {
    return { enabled: false, fault: null, delayMs: 0, rejectedReason: 'invalid_fault' };
  }

  // Production safety check:
  // Arbitrary public requests cannot trigger chaos in production unless explicitly authorized
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  if (isProduction) {
    const isChaosEnabledInProd = process.env.ENABLE_CHAOS_EXPERIMENTS === 'true';
    if (!isChaosEnabledInProd) {
      return { enabled: false, fault: null, delayMs: 0, rejectedReason: 'disabled_in_production' };
    }

    const expectedKey = process.env.CHAOS_SECRET_KEY || DEFAULT_DEMO_KEY;
    const providedKey = (headers['x-chaos-key'] || query.chaos_key || query.chaosKey || '').toString().trim();
    if (expectedKey && providedKey !== expectedKey) {
      return { enabled: false, fault: null, delayMs: 0, rejectedReason: 'unauthorized' };
    }
  }

  // Parse and bound delay
  let delayMs = parseInt(headers['x-chaos-delay-ms'] || headers['x-chaos-delay'] || query.chaos_delay || query.chaosDelay || '0', 10);
  if (isNaN(delayMs) || delayMs < MIN_DELAY_MS) delayMs = 0;
  if (delayMs > MAX_DELAY_MS) delayMs = MAX_DELAY_MS;

  // For latency injection, default to 200ms if 0 specified
  if (rawFault !== 'redis_failure' && delayMs === 0) {
    delayMs = 200;
  }

  return {
    enabled: true,
    fault: rawFault,
    delayMs
  };
}

/**
 * Async sleep utility for controlled non-blocking latency injection
 */
export function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
