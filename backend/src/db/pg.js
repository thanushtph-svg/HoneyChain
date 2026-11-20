// PostgreSQL access. Every query is parameterized ($1, $2 ...) - no string-built SQL.
import pg from 'pg';
import { env } from '../config/env.js';

// Return NUMERIC as exact strings ("12.50") and DATE as "YYYY-MM-DD" strings.
// This keeps decimals exact and makes canonical hashing deterministic.
pg.types.setTypeParser(1700, (v) => v); // NUMERIC
pg.types.setTypeParser(1082, (v) => v); // DATE
pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT ids/counts fit safely in JS numbers here

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export function query(text, params = []) {
  return pool.query(text, params);
}

export async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

/**
 * Run fn(client) inside BEGIN ... COMMIT. Any thrown error rolls back.
 * userId is stored in the session setting app.user_id so DB triggers can
 * record who made a change (batch_status_history.changed_by).
 */
export async function withTransaction(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId != null) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function pgHealth() {
  try {
    const r = await one('SELECT version() AS v, (SELECT count(*) FROM schema_migrations) AS migrations');
    return { status: 'up', detail: `${r.v.split(' ').slice(0, 2).join(' ')}, ${r.migrations} migrations applied` };
  } catch (e) {
    return { status: 'down', detail: e.message };
  }
}
