// QR images and the public (no-login) consumer verification API.
import { Router } from 'express';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { query, one } from '../db/pg.js';
import { requireAuth } from '../middleware/auth.js';
import { ok } from '../utils/http.js';
import { notFound } from '../utils/errors.js';
import { getVisibleBatch } from '../services/access.js';
import { verifyAnchor } from '../services/anchorService.js';
import { collection } from '../db/mongo.js';
import { logActivity } from '../services/activityLog.js';
import { env, isTest } from '../config/env.js';

const r = Router();

// ---------------------------------------------------------------- QR (staff who can see the batch)
r.get('/qr/:file', requireAuth, async (req, res) => {
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
  'Automated (AI) analysis is informational decision support and does not certify this honey. The laboratory decision is authoritative.',
];

r.get('/public/batches/:batchCode', publicLimiter, async (req, res) => {
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
  // one entry per anchored record (latest live anchor wins)
  const byRecord = new Map();
  for (const a of anchors) byRecord.set(`${a.entity_type}|${a.entity_code}`, a);
  const integrity = [...byRecord.values()].map((a) => ({
    record: a.entity_type,
    recordCode: a.entity_code,
    anchorStatus: a.anchor_status,
    result: a.last_result ?? null,
    checkedAt: a.last_checked_at ?? null,
    network: a.network,
    txHash: a.tx_hash,
    blockNumber: a.block_number,
    explorerUrl: a.network === 'sepolia' && a.tx_hash ? `https://sepolia.etherscan.io/tx/${a.tx_hash}` : null,
  }));

  const shipments = (await query(
    `SELECT shipment_code, dispatch_date, origin_location, destination_type, destination_city, destination_state, status, delivered_on, distributor_name
       FROM v_public_shipments WHERE batch_code = $1 ORDER BY dispatch_date, shipment_code`, [batchCode])).rows;

  // Latest AI analyses (status + headline only; never raw lab staff info)
  let aiSummary = { quality: null, adulteration: null };
  try {
    const col = await collection('ai_analysis_results');
    for (const t of ['QUALITY', 'ADULTERATION']) {
      const d = await col.findOne({ batchId, analysisType: t }, { sort: { createdAt: -1 } });
      if (d) {
        aiSummary[t.toLowerCase()] = {
          modelStatus: d.model.status,
          modelName: d.model.name,
          prediction: d.prediction ? { label: d.prediction.label ?? null, confidence: d.prediction.confidence ?? null } : null,
          standardsScreening: d.standardsScreening?.checks?.length
            ? { standard: d.standardsScreening.standard, checks: d.standardsScreening.checks.map((c) => ({ label: c.label, outcome: c.outcome, limit: c.limit, unit: c.unit })) }
            : null,
          analysedAt: d.createdAt,
        };
      }
    }
  } catch {
    aiSummary = { unavailable: true };
  }

  await query('UPDATE qr_records SET scan_count = scan_count + 1, last_scanned_at = now() WHERE batch_id = $1', [batchId]);
  logActivity(req, 'PUBLIC_QR_SCAN', { type: 'batch', id: batchId, code: batchCode });

  ok(res, {
    batchCode: b.batch_code,
    isDemo: b.is_demo,
    status: b.status,
    honeyType: b.honey_type,
    quantityKg: b.batch_quantity_kg,
    origin: { producerName: b.producer_name, cooperative: b.cooperative_name, district: b.origin_district, state: b.origin_state, hiveCode: b.hive_code, beeSpecies: b.bee_species },
    harvest: { harvestCode: b.harvest_code, date: b.harvest_date, floralSource: b.floral_source },
    laboratory: b.report_code ? {
      labName: b.lab_name, accreditationNo: b.lab_accreditation_no, reportCode: b.report_code, testedOn: b.tested_on,
      moisturePct: b.moisture_pct, hmfMgKg: b.hmf_mg_kg, sucroseG100g: b.sucrose_g_100g, glucoseG100g: b.glucose_g_100g,
      fructoseG100g: b.fructose_g_100g, ph: b.ph, freeAcidityMeqKg: b.free_acidity_meq_kg,
      pollenIdentification: b.pollen_identification, adulterationMethod: b.adulteration_method,
      adulterationResult: b.adulteration_result, decision: b.lab_decision,
    } : null,
    processing: b.processing_code ? {
      processorName: b.processor_name, processorCity: b.processor_city, processingCode: b.processing_code, date: b.processing_date,
      method: b.processing_method, packagingDate: b.packaging_date, packagingType: b.packaging_type, unitSizeG: b.unit_size_g, bestBefore: b.best_before,
    } : null,
    journey: shipments,
    integrity,
    ai: aiSummary,
    notices: PUBLIC_NOTICES,
  });
});

// List of demo batches for the public home page (only rows flagged is_demo)
r.get('/public/demo-batches', publicLimiter, async (_req, res) => {
  const { rows } = await query(
    `SELECT batch_code, honey_type, status, origin_district, origin_state, harvest_date, floral_source, lab_decision
       FROM v_public_batch WHERE is_demo ORDER BY batch_code LIMIT 12`);
  ok(res, rows);
});

export default r;
