// Developer helper: reset the TEST database and run the demo seed against it (never touches the main DB).
// Usage (from backend/):  node tests/seed-smoke.mjs
import './setup-env.js';
import { resetAll } from '../db/reset.js';
import { seed } from '../db/seeds/seed.js';
import { pool } from '../src/db/pg.js';
import { closeMongo } from '../src/db/mongo.js';

try {
  await resetAll({ quiet: true });
  const s = await seed({ quiet: false });
  console.log(JSON.stringify(s, null, 2));
} catch (e) {
  console.error('SEED FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await closeMongo();
  await pool.end();
}
