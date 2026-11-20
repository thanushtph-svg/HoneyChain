// Replays MongoDB writes that failed earlier (rows in PostgreSQL mongo_outbox).
// Backoff: 1, 5, 30, 60, 120, 240, 480 minutes; after 8 attempts -> DEAD (shown to admins).
import { query } from '../db/pg.js';
import { collection, ObjectId } from '../db/mongo.js';

const BACKOFF_MIN = [1, 5, 30, 60, 120, 240, 480];
const MAX_ATTEMPTS = 8;

function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && '$date' in v) return new Date(v.$date);
    if (Object.keys(v).length === 1 && '$oid' in v) return new ObjectId(v.$oid);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

export async function processOutboxOnce(limit = 50) {
  const { rows } = await query(
    `SELECT * FROM mongo_outbox WHERE status = 'PENDING' AND next_attempt_at <= now()
      ORDER BY outbox_id LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const row of rows) {
    try {
      const doc = decode(row.payload);
      const col = await collection(row.target_collection);
      if (row.operation === 'INSERT') await col.insertOne(doc);
      else await col.updateOne(doc.filter, doc.update);
      await query(`UPDATE mongo_outbox SET status = 'DONE', attempts = attempts + 1 WHERE outbox_id = $1`, [row.outbox_id]);
      done++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
      await query(
        `UPDATE mongo_outbox SET attempts = $2, last_error = $3,
                status = CASE WHEN $4 THEN 'DEAD' ELSE 'PENDING' END,
                next_attempt_at = now() + ($5 || ' minutes')::interval
          WHERE outbox_id = $1`,
        [row.outbox_id, attempts, String(err.message).slice(0, 500), dead, String(wait)],
      );
    }
  }
  return { processed: rows.length, done };
}

export function startOutboxWorker(intervalMs) {
  const t = setInterval(() => processOutboxOnce().catch(() => {}), intervalMs);
  t.unref();
  return t;
}
