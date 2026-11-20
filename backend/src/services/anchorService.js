// Creating anchor intents (PENDING rows), the background anchor worker, and verification.
import { query, one, pool } from '../db/pg.js';
import { chain, chainConfig } from './chainClient.js';
import { buildForEntity, canonicalJson, hashCanonical, recordKey, HASH_SCHEME, SCHEME_NUMBER } from './canonical.js';
import { conflict } from '../utils/errors.js';
import { isTest } from '../config/env.js';

const ENTITY_FK = { LAB_REPORT: 'lab_report_id', PROCESSING_RECORD: 'processing_id', SHIPMENT: 'shipment_id' };

/**
 * Insert a PENDING anchor for a record, inside the caller's transaction (db = client).
 * If the blockchain isn't configured, nothing is inserted and null is returned; the record
 * then shows "not anchored" until an admin anchors it later.
 * spec: { entity_type, batch_id, lab_report_id?, processing_id?, shipment_id? }
 */
export async function createPendingAnchor(db, spec, userId = null) {
  const cfg = chainConfig();
  if (!cfg.configured) return null;
  const obj = await buildForEntity(db, spec);
  if (!obj) throw new Error('Cannot anchor: record not found');
  const json = canonicalJson(obj);
  const hash = hashCanonical(json);
  const key = recordKey(obj.entityType, obj.entityCode);

  // Safety: if this record was anchored before (e.g. on a previous local chain), the current
  // data must still match that earlier hash - otherwise we'd be "re-blessing" tampered data.
  const prev = (await db.query(
    `SELECT record_hash FROM blockchain_anchors WHERE record_key = $1 AND status = 'CONFIRMED'
      ORDER BY anchor_id DESC LIMIT 1`, [key])).rows[0];
  if (prev && prev.record_hash !== hash) {
    throw conflict('RECORD_CHANGED_SINCE_ANCHOR', `${obj.entityCode} no longer matches its earlier anchored hash; it will not be re-anchored`);
  }

  const fk = ENTITY_FK[spec.entity_type];
  const { rows } = await db.query(
    `INSERT INTO blockchain_anchors
       (entity_type, batch_id, lab_report_id, processing_id, shipment_id, hash_scheme, record_key, record_hash,
        canonical_json, network, chain_id, contract_address, anchored_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING
     RETURNING anchor_id`,
    [spec.entity_type, spec.batch_id,
     fk === 'lab_report_id' ? spec.lab_report_id : null,
     fk === 'processing_id' ? spec.processing_id : null,
     fk === 'shipment_id' ? spec.shipment_id : null,
     HASH_SCHEME, key, hash, json, cfg.network, cfg.chainId, cfg.contractAddress, userId],
  );
  return rows[0] ?? null;
}

/** All anchorable records that have no live anchor on the current contract. */
export async function findUnanchored() {
  const cfg = chainConfig();
  if (!cfg.configured) return [];
  const live = `SELECT 1 FROM blockchain_anchors a WHERE a.chain_id = $1 AND a.contract_address = $2
                  AND a.status IN ('PENDING','SUBMITTED','CONFIRMED')`;
  const { rows } = await query(
    `SELECT 'BATCH_ORIGIN' AS entity_type, b.batch_id, NULL::int AS lab_report_id, NULL::int AS processing_id, NULL::int AS shipment_id
       FROM batches b WHERE NOT EXISTS (${live} AND a.entity_type='BATCH_ORIGIN' AND a.batch_id=b.batch_id)
     UNION ALL
     SELECT 'LAB_REPORT', lr.batch_id, lr.lab_report_id, NULL, NULL FROM lab_reports lr
      WHERE lr.report_state='SUBMITTED' AND NOT EXISTS (${live} AND a.lab_report_id=lr.lab_report_id)
     UNION ALL
     SELECT 'PROCESSING_RECORD', p.batch_id, NULL, p.processing_id, NULL FROM processing_records p
      WHERE NOT EXISTS (${live} AND a.processing_id=p.processing_id)
     UNION ALL
     SELECT 'SHIPMENT', s.batch_id, NULL, NULL, s.shipment_id FROM shipments s
      WHERE s.status='DELIVERED' AND NOT EXISTS (${live} AND a.shipment_id=s.shipment_id)`,
    [cfg.chainId, cfg.contractAddress],
  );
  return rows;
}

// ---------------------------------------------------------------- worker
const MAX_ATTEMPTS = 5;
const WORKER_LOCK_ID = 7426001; // PostgreSQL advisory lock: one anchor worker across ALL processes
let running = false;

/** Send PENDING anchors and confirm SUBMITTED ones. Values come only from the node's receipts. */
export async function processAnchorsOnce() {
  if (running) return { skipped: true };
  running = true;
  const lockClient = await pool.connect();
  let locked = false;
  try {
    locked = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK_ID])).rows[0].ok;
    if (!locked) return { skipped: true, reason: 'another process is anchoring' };
    const c = chain();
    if (!c.contract) return { configured: false };
    const { cfg, contract, provider } = c;
    const { rows } = await query(
      `SELECT * FROM blockchain_anchors WHERE status IN ('PENDING','SUBMITTED')
          AND chain_id = $1 AND contract_address = $2 ORDER BY anchor_id LIMIT 25`,
      [cfg.chainId, cfg.contractAddress],
    );
    let confirmed = 0;
    for (const a of rows) {
      let status = a.status;
      try {
        let txHash = a.tx_hash;
        if (status === 'PENDING') {
          const tx = await contract.anchor(a.record_key, a.record_hash, SCHEME_NUMBER);
          txHash = tx.hash.toLowerCase();
          await query(`UPDATE blockchain_anchors SET status='SUBMITTED', tx_hash=$2, attempts=attempts+1 WHERE anchor_id=$1`, [a.anchor_id, txHash]);
          status = 'SUBMITTED';
        }
        const receipt = await provider.waitForTransaction(txHash, cfg.confirmations, 120000);
        if (!receipt) continue; // not mined yet; next round
        if (receipt.status !== 1) {
          await query(`UPDATE blockchain_anchors SET status='FAILED', failure_reason='transaction reverted' WHERE anchor_id=$1`, [a.anchor_id]);
          continue;
        }
        const block = await provider.getBlock(receipt.blockNumber);
        await query(
          `UPDATE blockchain_anchors SET status='CONFIRMED', block_number=$2, block_timestamp=to_timestamp($3), confirmed_at=now(), failure_reason=NULL
            WHERE anchor_id=$1`,
          [a.anchor_id, receipt.blockNumber, Number(block.timestamp)],
        );
        confirmed++;
      } catch (e) {
        const reason = String(e.shortMessage ?? e.message).slice(0, 400);
        const attempts = a.attempts + 1;
        // A SUBMITTED tx is never marked FAILED just because we couldn't read its receipt yet.
        if (status === 'PENDING') {
          await query(
            `UPDATE blockchain_anchors SET attempts=$2, failure_reason=$3,
                    status = CASE WHEN $4 THEN 'FAILED' ELSE status END WHERE anchor_id=$1`,
            [a.anchor_id, attempts, reason, attempts >= MAX_ATTEMPTS],
          );
        }
        if (!isTest) console.warn(`[anchor] ${a.anchor_id}: ${reason}`);
        if (/ECONNREFUSED|network|timeout/i.test(reason)) break; // node down: stop this round
      }
    }
    return { processed: rows.length, confirmed };
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_ID]).catch(() => {});
    lockClient.release();
    running = false;
  }
}

export function startAnchorWorker(intervalMs) {
  const t = setInterval(() => processAnchorsOnce().catch((e) => console.warn('[anchor] worker error', e.message)), intervalMs);
  t.unref();
  return t;
}

// ---------------------------------------------------------------- verification
/**
 * Recompute the record's hash from PostgreSQL, read the hash stored on-chain, compare,
 * and store the result. trigger: ADMIN | PUBLIC_PAGE | SCHEDULED
 */
export async function verifyAnchor(anchorId, trigger, userId = null) {
  const a = await one('SELECT * FROM blockchain_anchors WHERE anchor_id = $1', [anchorId]);
  if (!a) return null;
  if (a.status !== 'CONFIRMED') {
    return { anchorId, result: null, message: `Anchor is ${a.status}; only CONFIRMED anchors can be verified` };
  }
  const obj = await buildForEntity({ query }, a);
  const recomputed = hashCanonical(canonicalJson(obj));

  let onchain = null;
  let result;
  let note = null;
  const c = chain();
  if (!c.contract || c.cfg.chainId !== a.chain_id) {
    result = 'CHAIN_UNAVAILABLE';
    note = !c.contract ? 'Blockchain not configured' : `Anchor is on chain ${a.chain_id}, backend is connected to ${c.cfg.chainId}`;
  } else {
    try {
      const code = await c.provider.getCode(a.contract_address);
      if (!code || code === '0x') {
        result = 'NOT_FOUND_ON_CHAIN';
        note = 'No contract at this address on the connected chain (local Hardhat chain restarted?)';
      } else {
        const ro = c.contract.attach(a.contract_address);
        const count = await ro.versionCount(a.record_key);
        if (count === 0n) {
          result = 'NOT_FOUND_ON_CHAIN';
          note = 'Contract has no anchor for this record key';
        } else {
          const latest = await ro.latest(a.record_key);
          onchain = String(latest.recordHash).toLowerCase();
          result = onchain === recomputed ? 'VERIFIED' : 'MISMATCH';
        }
      }
    } catch (e) {
      result = 'CHAIN_UNAVAILABLE';
      note = `RPC error: ${e.shortMessage ?? e.message}`;
    }
  }
  const row = await one(
    `INSERT INTO verification_checks (anchor_id, recomputed_hash, onchain_hash, result, trigger_source, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING check_id, checked_at`,
    [anchorId, recomputed, onchain, result, trigger, userId],
  );
  return {
    anchorId, checkId: row.check_id, checkedAt: row.checked_at, entityType: a.entity_type,
    result, recomputedHash: recomputed, onchainHash: onchain, anchoredHashInDb: a.record_hash,
    storedHashMatchesChain: onchain ? a.record_hash === onchain : null,
    txHash: a.tx_hash, blockNumber: a.block_number, network: a.network, note,
  };
}
