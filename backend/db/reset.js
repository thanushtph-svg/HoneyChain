// DEVELOPMENT ONLY: wipes the PostgreSQL schema and the MongoDB database, then re-creates both.
// Usage:  npm run db:reset -- --yes
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { migrate } from './migrate.js';
import { mongoInit } from './mongo-init.js';
import { mongo, closeMongo } from '../src/db/mongo.js';

export async function resetAll({ quiet = false } = {}) {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  const c = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await c.end();
  } catch (e) {
    await c.end().catch(() => {});
    if (!/does not exist/.test(e.message)) throw e; // database missing -> migrate() creates it
  }
  await migrate({ quiet });
  await (await mongo()).dropDatabase();
  await mongoInit({ quiet });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--yes')) {
    console.error('This deletes ALL HoneyChain data. Re-run with:  npm run db:reset -- --yes');
    process.exit(1);
  }
  resetAll()
    .then(async () => { console.log('[reset] done'); await closeMongo(); })
    .catch(async (e) => { console.error('[reset] ERROR:', e.message); await closeMongo(); process.exit(1); });
}
