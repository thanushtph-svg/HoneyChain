// QR images, the public (no-login) consumer verification API, and the optional consumer history.
import { Router } from 'express';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, one } from '../db/pg.js';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { ok, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound } from '../utils/errors.js';
import { getVisibleBatch } from '../services/access.js';
import { verifyAnchor } from '../services/anchorService.js';
import { logActivity } from '../services/activityLog.js';
import { publicAnalysisSummary } from '../services/labAnalysis.js';
import { env, isTest } from '../config/env.js';
import { STAFF_ROLES } from '../config/roles.js';

const r = Router();

// ---------------------------------------------------------------- QR (staff who can see the batch)
r.get('/qr/:file', requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
  const m = /^([A-Za-z0-9-]+)\.(png|svg)$/.exec(req.params.file);
  if (!m) throw notFound('QR code');
  const b = await getVisibleBatch(req.user, m[1].toUpperCase());
  const qr = await one('SELECT public_url FROM qr_records WHERE batch_id = $1', [b.batch_id]);
  if (!qr) throw notFound('QR code');
  const size = Math.min(1024, Math.max(128, Number(req.query.size) || 512));
  const opts = { errorCorrectionLevel: 'M', margin: 2, width: size, color: { dark: '#1f1a12', light: '#ffffff' } };
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${b.batch_code}.${m[2]}"`);
  if (m[2] === 'svg') {
    res.type('image/svg+xml').send(await QRCode.toString(qr.public_url, { ...opts, type: 'svg' }));
  } else {
    res.type('image/png').send(await QRCode.toBuffer(qr.public_url, opts));
  }
});

// ---------------------------------------------------------------- public batch page data
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: isTest ? 10000 : 60, standardHeaders: true, legacyHeaders: false });

export const PUBLIC_NOTICES = [
  'Blockchain verification shows whether these records changed after they were anchored. It does not prove the honey is genuine or that the original entries were correct.',
  'The automatic laboratory analysis report (standards check and any ML result) is decision support and does not certify this honey. The laboratory decision is authoritative.',
];

const VERDICT_TEXT = {
  VERIFIED: 'Every published record of this batch matches the version anchored on the blockchain.',
  MISMATCH: 'WARNING: at least one record of this batch no longer matches the version anchored on the blockchain. Treat this product information with caution.',
  PARTIAL: 'Some records of this batch are not anchored or not yet verified. Only the records marked VERIFIED could be checked.',
  NOT_ANCHORED: 'The records of this batch have not been anchored on a blockchain, so their integrity cannot be verified.',
  UNAVAILABLE: 'The blockchain could not be reached (or the anchor was not found), so integrity could not be verified right now.',
};

/**
 * Overall integrity verdict. VERIFIED only when EVERY expected record (origin, current lab report,
 * processing, delivered shipments) has a confirmed anchor whose latest check is VERIFIED.
 */
export function overallVerdict(expected, integrity) {
  if (!integrity.length) return 'NOT_ANCHORED';
  if (integrity.some((i) => i.result === 'MISMATCH')) return 'MISMATCH';
  const byKey = new Map(integrity.map((i) => [`${i.record}|${i.recordCode}`, i]));
  const expectedResults = expected.map((k) => byKey.get(k)?.result ?? null);
  if (expectedResults.some((x) => x === 'CHAIN_UNAVAILABLE' || x === 'NOT_FOUND_ON_CHAIN')) return 'UNAVAILABLE';
  if (expectedResults.length && expectedResults.every((x) => x === 'VERIFIED')) return 'VERIFIED';
  return 'PARTIAL';
}

r.get('/public/batches/:batchCode', publicLimiter, optionalAuth, async (req, res) => {
  const batchCode = String(req.params.batchCode).toUpperCase().slice(0, 30);
  const b = await one('SELECT * FROM v_public_batch WHERE batch_code = $1', [batchCode]);
  if (!b) throw notFound('Batch');
  const batchId = (await one('SELECT batch_id FROM batches WHERE batch_code = $1', [batchCode])).batch_id;

  // Re-verify confirmed anchors whose last check is older than PUBLIC_REVERIFY_MINUTES
  const anchors = (await query(
    `SELECT * FROM v_anchor_status WHERE batch_id = $1 AND anchor_status IN ('PENDING','SUBMITTED','CONFIRMED') ORDER BY anchor_id`, [batchId])).rows;
  for (const a of anchors) {
    const stale = !a.last_checked_at || Date.now() - new Date(a.last_checked_at).getTime() > env.PUBLIC_REVERIFY_MINUTES * 60000;
    if (a.anchor_status === 'CONFIRMED' && stale) {
      const v = await verifyAnchor(a.anchor_id, 'PUBLIC_PAGE').catch(() => null);
      if (v?.result) { a.last_result = v.result; a.last_checked_at = v.checkedAt; }
    }
  }
  const superseded = new Set((await query(`SELECT report_code FROM lab_reports WHERE batch_id = $1 AND report_state = 'SUPERSEDED'`, [batchId])).rows.map((x) => x.report_code));
  // one entry per anchored record (latest live anchor wins)
  const byRecord = new Map();
  for (const a of anchors) byRecord.set(`${a.entity_type}|${a.entity_code}`, a);
  const integrity = [...byRecord.values()].map((a) => ({
    record: a.entity_type,
    recordCode: a.entity_code,
    superseded: a.entity_type === 'LAB_REPORT' && superseded.has(a.entity_code),
    anchorStatus: a.anchor_status,
    result: a.anchor_status === 'CONFIRMED' ? (a.last_result ?? null) : null, // never a result without a confirmed anchor
    checkedAt: a.last_checked_at ?? null,
    network: a.network,
    txHash: a.tx_hash,
    blockNumber: a.block_number,
    explorerUrl: a.network === 'sepolia' && a.tx_hash ? `https://sepolia.etherscan.io/tx/${a.tx_hash}` : null,
  }));

  const shipments = (await query(
    `SELECT shipment_code, dispatch_date, origin_location, destination_type, destination_city, destination_state, status, delivered_on, distributor_name
       FROM v_public_shipments WHERE batch_code = $1 ORDER BY dispatch_date, shipment_code`, [batchCode])).rows;
  const custody = (await query(
    `SELECT transfer_type, receiver_name, receiver_city, received_on FROM v_public_custody WHERE batch_code = $1 ORDER BY received_on`, [batchCode])).rows;

  const expected = [`BATCH_ORIGIN|${batchCode}`];
  if (b.report_code) expected.push(`LAB_REPORT|${b.report_code}`);
  if (b.processing_code) expected.push(`PROCESSING_RECORD|${b.processing_code}`);
  const delivered = (await query(`SELECT shipment_code FROM shipments WHERE batch_id = $1 AND status = 'DELIVERED'`, [batchId])).rows;
  for (const s of delivered) expected.push(`SHIPMENT|${s.shipment_code}`);
  const overall = overallVerdict(expected, integrity);

  // Approved automatic laboratory analysis of the CURRENT submitted report (public-safe summary only)
  let labAnalysis = null;
  if (b.report_code) {
    const rep = await one(`SELECT lab_report_id, ai_analysis_id, supersedes_report_id FROM lab_reports
                            WHERE report_code = $1 AND report_state = 'SUBMITTED'`, [b.report_code]);
    labAnalysis = await publicAnalysisSummary(rep).catch(() => ({ available: false, reason: 'UNAVAILABLE', message: 'The analysis report is temporarily unavailable.' }));
  }

  await query('UPDATE qr_records SET scan_count = scan_count + 1, last_scanned_at = now() WHERE batch_id = $1', [batchId]);
  logActivity(req, 'PUBLIC_QR_SCAN', { type: 'batch', id: batchId, code: batchCode });
  // optional consumer account: keep a personal history (never required)
  let savedToHistory = false;
  if (req.user?.role === 'CONSUMER') {
    await query('INSERT INTO consumer_verifications (user_id, batch_id, overall_result) VALUES ($1,$2,$3)', [req.user.id, batchId, overall]);
    savedToHistory = true;
  }

  ok(res, {
    batchCode: b.batch_code,
    isDemo: b.is_demo,
    status: b.status,
    honeyType: b.honey_type,
    quantityKg: b.batch_quantity_kg,
    origin: { producerName: b.producer_name, cooperative: b.cooperative_name, district: b.origin_district, state: b.origin_state, hiveCode: b.hive_code, beeSpecies: b.bee_species },
    harvest: { harvestCode: b.harvest_code, date: b.harvest_date, floralSource: b.floral_source },
    processing: b.processing_code ? {
      processorName: b.processor_name, processorCity: b.processor_city, processingCode: b.processing_code, date: b.processing_date,
      method: b.processing_method, packagingDate: b.packaging_date, packagingType: b.packaging_type, unitSizeG: b.unit_size_g, bestBefore: b.best_before,
    } : null,
    laboratory: b.report_code ? {
      labName: b.lab_name, accreditationNo: b.lab_accreditation_no, reportCode: b.report_code, testedOn: b.tested_on,
      moisturePct: b.moisture_pct, hmfMgKg: b.hmf_mg_kg, sucroseG100g: b.sucrose_g_100g, glucoseG100g: b.glucose_g_100g,
      fructoseG100g: b.fructose_g_100g, ph: b.ph, freeAcidityMeqKg: b.free_acidity_meq_kg,
      pollenIdentification: b.pollen_identification, adulterationMethod: b.adulteration_method,
      adulterationResult: b.adulteration_result, decision: b.lab_decision, correctsReport: b.supersedes_report_code ?? null,
    } : null,
    custody,
    journey: shipments,
    integrity,
    verification: { overall, message: VERDICT_TEXT[overall], recordsChecked: integrity.filter((i) => i.result === 'VERIFIED').length, recordsExpected: expected.length },
    labAnalysis,
    notices: PUBLIC_NOTICES,
    savedToHistory,
  });
});

// List of demo batches for the public home page (only rows flagged is_demo)
r.get('/public/demo-batches', publicLimiter, async (_req, res) => {
  const { rows } = await query(
    `SELECT batch_code, honey_type, status, origin_district, origin_state, harvest_date, floral_source, lab_decision
       FROM v_public_batch WHERE is_demo ORDER BY batch_code LIMIT 12`);
  ok(res, rows);
});

// ---------------------------------------------------------------- consumer account (optional)
r.get('/consumer/verifications', requireAuth, requireRole('CONSUMER'), validateQuery(z.object({ ...pageQuery })), async (req, res) => {
  const q = req.validQuery;
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT cv.verification_id, cv.overall_result, cv.verified_at, b.batch_code, b.honey_type, b.status, b.is_demo
       FROM consumer_verifications cv JOIN batches b ON b.batch_id = cv.batch_id
      WHERE cv.user_id = $1 ORDER BY cv.verified_at DESC LIMIT ${limit} OFFSET ${offset}`, [req.user.id]);
  const total = (await one('SELECT count(*) AS n FROM consumer_verifications WHERE user_id = $1', [req.user.id])).n;
  ok(res, rows, pageMeta(q, total));
});

export default r;
