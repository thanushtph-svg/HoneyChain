// Writes supplementary documents to MongoDB. If MongoDB is unavailable, the
// document is parked in PostgreSQL's mongo_outbox table and retried later
// (see outboxWorker.js). PostgreSQL remains the source of truth.
import { collection } from '../db/mongo.js';
import { query } from '../db/pg.js';
import { isTest } from '../config/env.js';

/** Serialise a document for the outbox (Dates -> {$date}, ObjectId -> {$oid}) so it can be restored exactly. */
function encode(doc) {
  const walk = (v) => {
    if (v instanceof Date) return { $date: v.toISOString() };
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && v.constructor?.name === 'ObjectId') return { $oid: String(v) };
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(doc);
}

/**
 * Insert into MongoDB; on failure queue it in mongo_outbox.
 * Returns { saved: true, id } or { saved: false, queued: true }.
 */
export async function insertWithOutbox(collectionName, doc) {
  try {
    const r = await (await collection(collectionName)).insertOne(doc);
    return { saved: true, id: r.insertedId };
  } catch (err) {
    if (!isTest) console.warn(`[mongo] insert into ${collectionName} failed, queued in outbox: ${err.message}`);
    await query(
      `INSERT INTO mongo_outbox (target_collection, operation, payload, last_error) VALUES ($1, 'INSERT', $2, $3)`,
      [collectionName, JSON.stringify(encode(doc)), String(err.message).slice(0, 500)],
    ).catch((e) => console.error('[outbox] could not queue document:', e.message));
    return { saved: false, queued: true };
  }
}

/**
 * Audit log entry. Never throws - logging must not break the user's action.
 * outcome: SUCCESS | DENIED | FAILED
 */
export async function logActivity(req, action, entity = null, outcome = 'SUCCESS', details = {}) {
  const doc = {
    at: new Date(),
    actor: req?.user ? { userId: req.user.id, role: req.user.role } : null,
    action,
    entity: entity ? { type: entity.type, id: entity.id, code: entity.code ?? null } : null,
    outcome,
    ip: req?.ip ?? null,
    details,
  };
  try {
    await insertWithOutbox('activity_logs', doc);
  } catch {
    /* swallow */
  }
}
