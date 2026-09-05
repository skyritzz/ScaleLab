import crypto from 'node:crypto';

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CUSTOM_EPOCH = 1704067200000n; // 2024-01-01T00:00:00.000Z

let snowflakeSequence = 0n;
const WORKER_ID = 1n; // Default single-node worker ID

/**
 * Encode a BigInt or number into Base62 string
 */
export function encodeBase62(num) {
  let n = BigInt(num);
  if (n <= 0n) return '0';
  let result = '';
  while (n > 0n) {
    const rem = Number(n % 62n);
    result = BASE62_CHARS[rem] + result;
    n = n / 62n;
  }
  return result;
}

/**
 * Generate short code using Base62 from PostgreSQL sequence
 */
export async function generateBase62Code(client) {
  // Acquire atomic next value from sequence
  const res = await client.query("SELECT nextval('urls_id_seq') AS next_id");
  const nextId = BigInt(res.rows[0].next_id);
  // Offset by 14,776,336 so the code is always at least 5 alphanumeric characters (62^4)
  const offsetId = 14776336n + nextId;
  return encodeBase62(offsetId);
}

/**
 * Generate short code using SHA-256 hash.
 * Attempt 1 is deterministic from the longUrl.
 * Subsequent attempts use a salt to resolve collisions.
 */
export function generateHashCode(longUrl, attempt = 1) {
  const seed = attempt === 1 ? String(longUrl) : `${longUrl}:salt:${attempt}`;
  const hash = crypto.createHash('sha256').update(seed).digest('base64url');
  // Strip any hyphens or underscores to keep clean alphanumeric string
  const clean = hash.replace(/[^0-9a-zA-Z]/g, '');
  return (clean.padEnd(7, '0')).substring(0, 7);
}

/**
 * Generate distributed Snowflake ID encoded in Base62
 */
export function generateSnowflakeCode() {
  const now = BigInt(Date.now());
  const timestamp = (now - CUSTOM_EPOCH) & 0x1FFFFFFFFFFn; // 41 bits
  snowflakeSequence = (snowflakeSequence + 1n) % 4096n; // 12 bits
  const snowflakeId = (timestamp << 22n) | (WORKER_ID << 12n) | snowflakeSequence;
  return encodeBase62(snowflakeId).substring(0, 7);
}

/**
 * Primary ID generation dispatcher
 */
export async function generateShortCode(client, strategy = 'base62', longUrl = '', attempt = 1) {
  switch (strategy) {
    case 'hash':
      return { shortCode: generateHashCode(longUrl, attempt), strategy: 'hash' };
    case 'snowflake':
      return { shortCode: generateSnowflakeCode(), strategy: 'snowflake' };
    case 'base62':
    default:
      return { shortCode: await generateBase62Code(client), strategy: 'base62' };
  }
}
