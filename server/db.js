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
        idempotency_key VARCHAR(128) UNIQUE NOT NULL,
        request_hash VARCHAR(64) NOT NULL,
        response_code INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(idempotency_key);
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
