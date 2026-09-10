import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const isNeonOrProd = Boolean(
  (process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('sslmode=require'))) ||
  process.env.NODE_ENV === 'production'
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://shortener:shortener_secret@localhost:5432/shortener',
  ssl: isNeonOrProd ? { rejectUnauthorized: false } : undefined,
  max: process.env.VERCEL ? 3 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Execute a parameterized query against PostgreSQL pool
 */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  return { ...res, durationMs: duration };
}

/**
 * Run schema migrations and create necessary tables and indexes
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('[DB] Running database migrations...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS urls (
        id BIGSERIAL PRIMARY KEY,
        short_code VARCHAR(16) UNIQUE NOT NULL,
        long_url TEXT NOT NULL,
        redirect_mode SMALLINT NOT NULL DEFAULT 302 CHECK (redirect_mode IN (301, 302)),
        access_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
      CREATE INDEX IF NOT EXISTS idx_urls_created_at ON urls(created_at DESC);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id BIGSERIAL PRIMARY KEY,
        idempotency_key VARCHAR(128) NOT NULL,
        owner_id VARCHAR(64),
        request_hash VARCHAR(64) NOT NULL,
        response_code INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Extend urls table for anonymous ownership and demo distinction
      ALTER TABLE urls ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);
      ALTER TABLE urls ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
      CREATE INDEX IF NOT EXISTS idx_urls_created_at ON urls(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_urls_owner_id ON urls(owner_id);
      CREATE INDEX IF NOT EXISTS idx_urls_is_demo ON urls(is_demo);

      -- Extend idempotency_keys table for owner-scoped idempotency isolation
      ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);
      ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_idempotency_key_key;
      DROP INDEX IF EXISTS idx_idempotency_keys_key;
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_owner ON idempotency_keys(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_owner_key ON idempotency_keys(owner_id, idempotency_key);

      -- Seed standard demo/system records (unassigned to any user, marked as is_demo = true)
      INSERT INTO urls (short_code, long_url, redirect_mode, access_count, is_demo, created_at, updated_at)
      VALUES
        ('aB92x', 'https://github.com/torvalds/linux', 302, 42, true, NOW() - INTERVAL '1 hour', NOW()),
        ('k9L0z', 'https://blog.bytebytego.com/p/ep1-url-shortener', 302, 15, true, NOW() - INTERVAL '30 minutes', NOW()),
        ('m4X7w', 'https://news.ycombinator.com', 302, 8, true, NOW() - INTERVAL '10 minutes', NOW())
      ON CONFLICT (short_code) DO UPDATE
      SET is_demo = true;
    `);
    console.log('[DB] Migrations applied successfully.');
  } finally {
    client.release();
  }
}

/**
 * Close pool gracefully
 */
export async function closeDb() {
  await pool.end();
  console.log('[DB] PostgreSQL pool closed.');
}
