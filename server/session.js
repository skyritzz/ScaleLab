import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'sho_rt_session';
const SESSION_MAX_AGE_SECONDS = 31536000; // 1 year

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a Cookie header string into an object of key-value pairs
 */
export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return cookies;
  }
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

/**
 * Build a Set-Cookie header string for sho_rt_session
 */
export function buildSessionCookieString(sessionId) {
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isProd) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Resolve or initialize an anonymous session from a request.
 * Compatible with Fastify (request, reply) and Node / Vercel Serverless (req, res).
 *
 * @param {Object} req - Fastify request or Node http.IncomingMessage
 * @param {Object} res - Fastify reply or Node http.ServerResponse
 * @returns {{ sessionId: string, isNew: boolean }}
 */
export function resolveSession(req, res) {
  const cookieHeader = req.headers?.cookie || req.headers?.Cookie || '';
  const cookies = parseCookies(cookieHeader);
  const rawSessionId = cookies[SESSION_COOKIE_NAME];

  let sessionId = null;
  let isNew = false;

  if (rawSessionId && UUID_REGEX.test(rawSessionId)) {
    sessionId = rawSessionId;
  } else {
    sessionId = crypto.randomUUID();
    isNew = true;
  }

  // If a new session was created (or cookie was invalid/absent), attach Set-Cookie header
  if (isNew && res) {
    const cookieString = buildSessionCookieString(sessionId);
    if (typeof res.header === 'function') {
      // Fastify reply
      res.header('Set-Cookie', cookieString);
    } else if (typeof res.setHeader === 'function') {
      // Node.js http.ServerResponse / Vercel Serverless
      const existing = res.getHeader('Set-Cookie');
      if (existing) {
        if (Array.isArray(existing)) {
          res.setHeader('Set-Cookie', [...existing, cookieString]);
        } else {
          res.setHeader('Set-Cookie', [existing, cookieString]);
        }
      } else {
        res.setHeader('Set-Cookie', cookieString);
      }
    }
  }

  return { sessionId, isNew };
}
