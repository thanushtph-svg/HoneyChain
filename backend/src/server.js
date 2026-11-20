import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pg.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { startOutboxWorker } from './services/outboxWorker.js';
import { startAnchorWorker } from './services/anchorService.js';
import { chainConfig } from './services/chainClient.js';

const app = createApp();

try {
  await pool.query('SELECT 1');
} catch (e) {
  console.error(`[startup] Cannot connect to PostgreSQL: ${e.message}`);
  console.error('Check that PostgreSQL is running and DATABASE_URL in .env is correct, then run: npm run db:migrate');
  process.exit(1);
}
try {
  await connectMongo();
} catch (e) {
  console.warn(`[startup] MongoDB not reachable (${e.message}). The app will run; logs/AI results are queued in the outbox until MongoDB is back.`);
}

startOutboxWorker(env.OUTBOX_WORKER_INTERVAL_MS);
const cc = chainConfig();
if (env.ANCHOR_WORKER_ENABLED) startAnchorWorker(env.ANCHOR_WORKER_INTERVAL_MS);
console.log(`[startup] blockchain: ${cc.network} ${cc.configured ? `contract ${cc.contractAddress}` : `NOT configured (${cc.missing.join(', ')})`}`);

const server = app.listen(env.PORT, () => {
  console.log(`[startup] HoneyChain API listening on http://localhost:${env.PORT}/api/v1  (health: /api/v1/health)`);
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => {});
  await closeMongo().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
