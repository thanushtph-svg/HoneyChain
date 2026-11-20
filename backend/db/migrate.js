// Applies backend/db/migrations/*.sql in filename order, once each.
// Usage:  npm run db:migrate
// Creates the target database first if it does not exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../src/config/env.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureDatabase() {
  const url = new URL(env.DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  const admin = new URL(env.DATABASE_URL);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);
    await c.query(`CREATE DATABASE ${dbName}`);
    console.log(`[migrate] created database ${dbName}`);
  }
  await c.end();
}

export async function migrate({ quiet = false } = {}) {
  await ensureDatabase();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await client.query(sql);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      applied++;
      if (!quiet) console.log(`[migrate] applied ${f}`);
    }
    if (!quiet) console.log(`[migrate] ${applied} new migration(s); ${files.length} total`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((e) => {
    console.error('[migrate] ERROR:', e.message);
    if (/ECONNREFUSED/.test(e.message)) console.error('Is PostgreSQL running? Check DATABASE_URL in .env');
    if (/password authentication failed/.test(e.message)) console.error('Wrong PostgreSQL password in DATABASE_URL.');
    process.exit(1);
  });
}
