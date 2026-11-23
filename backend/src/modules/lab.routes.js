// Laboratory: testing requests (accept / reject), draft -> submit reports (PASS / FAIL / INCONCLUSIVE),
// audited corrections (outcome recomputed automatically), history and spectral scan upload. Lab outcomes are automatic.
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, decimal, optDecimal, code, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable, forbidden } from '../utils/errors.js';
import { logActivity, insertWithOutbox } from '../services/activityLog.js';
import { createPendingAnchor } from '../services/anchorService.js';
import { batchScope } from '../services/access.js';
import { screenReport, suggestDecision } from '../services/standards.js';
import { getSetting } from '../services/settings.js';
import { collection } from '../db/mongo.js';
import { analyseCorrection, storeCorrectionAnalysis } from '../services/labAnalysis.js';

const r = Router();
r.use(['/lab', '/lab-requests', '/lab-corrections'], requireAuth);

const ADULT = ['NOT_DETECTED', 'DETECTED', 'INCONCLUSIVE', 'NOT_TESTED'];
export const DECISIONS = ['PASS', 'FAIL', 'INCONCLUSIVE'];
const DECISION_STATUS = { PASS: 'LAB_PASSED', FAIL: 'LAB_FAILED', INCONCLUSIVE: 'LAB_INCONCLUSIVE' };
export const measurementFields = {
  moisturePct: decimal(0, 100),
  hmfMgKg: decimal(0, 99999),
  sucroseG100g: decimal(0, 100),
  glucoseG100g: optDecimal(0, 100),
  fructoseG100g: optDecimal(0, 100),
  brix: optDecimal(0, 100),
  ph: optDecimal(0, 14),
  freeAcidityMeqKg: optDecimal(0, 9999),
  waterActivity: optDecimal(0, 1, 3),
  electricalConductivityMsCm: optDecimal(0, 999, 3),
  pollenIdentification: text(2000),
  adulterationMethod: optText(100),
  adulterationResult: z.enum(ADULT).default('NOT_TESTED'),
};
export const COLS = {
  moisturePct: 'moisture_pct', hmfMgKg: 'hmf_mg_kg', sucroseG100g: 'sucrose_g_100g', glucoseG100g: 'glucose_g_100g',
  fructoseG100g: 'fructose_g_100g', brix: 'brix', ph: 'ph', freeAcidityMeqKg: 'free_acidity_meq_kg',
  waterActivity: 'water_activity', electricalConductivityMsCm: 'electrical_conductivity_ms_cm',
  pollenIdentification: 'pollen_identification', adulterationMethod: 'adulteration_method',
  adulterationResult: 'adulteration_result', sampleCode: 'sample_code', receivedOn: 'received_on', testedOn: 'tested_on',
  decision: 'decision', decisionRemarks: 'decision_remarks',
};

const createSchema = z.object({
  batchCode: code,
  sampleCode: text(40),
  receivedOn: isoDate,
  testedOn: isoDate,
  ...measurementFields,
});

const REPORT_SELECT = `
  SELECT lr.*, b.batch_code, b.status AS batch_status, o.name AS lab_name, u.full_name AS tested_by_name,
         rq.request_code, sup.report_code AS supersedes_report_code,
         (SELECT n.report_code FROM lab_reports n WHERE n.supersedes_report_id = lr.lab_report_id) AS superseded_by_report_code
    FROM lab_reports lr JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
    JOIN users u ON u.user_id = lr.tested_by
    LEFT JOIN lab_test_requests rq ON rq.request_id = lr.request_id
    LEFT JOIN lab_reports sup ON sup.lab_report_id = lr.supersedes_report_id`;

/** Load a report the user may read. Lab testers: own lab. Admin: all. Others: submitted reports of batches they can see. */
export async function getReadableReport(user, reportCode) {
  const rc = reportCode.toUpperCase();
  if (user.role === 'LAB_TESTER' || user.role === 'ADMIN') {
    const rep = await one(`${REPORT_SELECT} WHERE lr.report_code = $1 AND ($2::int IS NULL OR lr.lab_org_id = $2)`,
      [rc, user.role === 'LAB_TESTER' ? user.orgId : null]);
    if (!rep) throw notFound('Lab report');
    return rep;
  }
  const [cond, params] = batchScope(user, 2);
  const rep = await one(`${REPORT_SELECT} WHERE lr.report_code = $1 AND lr.report_state IN ('SUBMITTED','SUPERSEDED') AND ${cond}`, [rc, ...params]);
  if (!rep) throw notFound('Lab report');
  delete rep.tested_by_name; // individual testers are internal to the laboratory
  return rep;
}

async function ownReport(user, reportCode) {
  const rep = await one(`${REPORT_SELECT} WHERE lr.report_code = $1 AND lr.lab_org_id = $2`, [reportCode.toUpperCase(), user.orgId]);
  if (!rep) throw notFound('Lab report');
  return rep;
}

// ================================================================ TESTING REQUESTS
const REQUEST_SELECT = `
  SELECT rq.*, b.batch_code, b.honey_type, b.quantity_kg, b.status AS batch_status, b.is_demo AS batch_is_demo,
         lo.name AS lab_name, ro.name AS requester_name, ro.city AS requester_city,
         h.harvest_code, h.harvest_date, h.floral_source, hv.district, hv.state,
         p.processing_code, p.processing_date, p.method AS processing_method, p.output_quantity_kg,
         (SELECT lr.report_code FROM lab_reports lr WHERE lr.request_id = rq.request_id AND lr.report_state = 'DRAFT') AS draft_report_code,
         (SELECT lr.report_code FROM lab_reports lr WHERE lr.request_id = rq.request_id AND lr.report_state <> 'DRAFT'
           ORDER BY lr.lab_report_id DESC LIMIT 1) AS result_report_code
    FROM lab_test_requests rq JOIN batches b ON b.batch_id = rq.batch_id
    JOIN organizations lo ON lo.org_id = rq.lab_org_id JOIN organizations ro ON ro.org_id = rq.requester_org_id
    JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
    LEFT JOIN processing_records p ON p.batch_id = b.batch_id`;

function requestScope(user, start) {
  const p = `$${start}`;
  if (user.role === 'ADMIN') return ['TRUE', []];
  if (user.role === 'LAB_TESTER') return [`rq.lab_org_id = ${p}`, [user.orgId]];
  if (user.role === 'PROCESSOR') return [`rq.requester_org_id = ${p}`, [user.orgId]];
  return ['FALSE', []];
}

async function loadRequest(user, requestCode) {
  const [cond, params] = requestScope(user, 2);
  const rq = await one(`${REQUEST_SELECT} WHERE rq.request_code = $1 AND ${cond}`, [requestCode.toUpperCase(), ...params]);
  if (!rq) throw notFound('Testing request');
  return rq;
}

r.post('/lab-requests', requireRole('PROCESSOR'), validateBody(z.object({
  batchCode: code,
  labOrgId: z.number().int().positive(),
  sampleReference: optText(60),
  testsRequested: optText(1000),
  notes: optText(1000),
})), async (req, res) => {
  const v = req.valid;
  const rq = await withTransaction(req.user.id, async (c) => {
    const b = (await c.query('SELECT batch_id, status, batch_processor_org(batch_id) AS proc FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
    if (!b || b.proc !== req.user.orgId) throw notFound('Batch');
    if (!['PROCESSED', 'LAB_INCONCLUSIVE'].includes(b.status)) throw conflict('BATCH_NOT_TESTABLE', `Batch is ${b.status}; testing can be requested after processing (or after an inconclusive result)`);
    return (await c.query(
      `INSERT INTO lab_test_requests (batch_id, lab_org_id, requester_org_id, requested_by, sample_reference, tests_requested, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.batch_id, v.labOrgId, req.user.orgId, req.user.id, v.sampleReference, v.testsRequested, v.notes])).rows[0];
  });
  await logActivity(req, 'LAB_TEST_REQUESTED', { type: 'lab_request', id: rq.request_id, code: rq.request_code }, 'SUCCESS', { batchCode: v.batchCode, labOrgId: v.labOrgId });
  created(res, { ...rq, batch_code: v.batchCode });
});

r.get('/lab-requests', requireRole('LAB_TESTER', 'PROCESSOR', 'ADMIN'), validateQuery(z.object({
  ...pageQuery, status: z.string().trim().max(80).optional()
    .refine((s) => !s || s.split(',').every((x) => ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED'].includes(x)), 'Unknown status'),
})), async (req, res) => {
  const q = req.validQuery;
  const [cond, params] = requestScope(req.user, 2);
  const where = `($1::text[] IS NULL OR rq.status = ANY($1)) AND ${cond}`;
  const all = [q.status ? q.status.split(',') : null, ...params];
  const { limit, offset } = paging(q);
  const { rows } = await query(`${REQUEST_SELECT} WHERE ${where} ORDER BY rq.request_id DESC LIMIT ${limit} OFFSET ${offset}`, all);
  const total = (await one(`SELECT count(*) AS n FROM lab_test_requests rq WHERE ${where}`, all)).n;
  ok(res, rows, pageMeta(q, total));
});

r.get('/lab-requests/:requestCode', requireRole('LAB_TESTER', 'PROCESSOR', 'ADMIN'), async (req, res) => {
  ok(res, await loadRequest(req.user, req.params.requestCode));
});

async function respondRequest(req, res, status, reason) {
  const rq = await loadRequest(req.user, req.params.requestCode);
  if (rq.status !== 'PENDING') throw conflict('REQUEST_CLOSED', `Testing request ${rq.request_code} is already ${rq.status}`);
  const row = await withTransaction(req.user.id, async (c) => (await c.query(
    `UPDATE lab_test_requests SET status = $2, responded_by = $3, responded_at = now(), response_reason = $4
      WHERE request_id = $1 AND status = 'PENDING' RETURNING *`, [rq.request_id, status, req.user.id, reason ?? null])).rows[0]);
  if (!row) throw conflict('REQUEST_CLOSED', 'The request was answered by someone else');
  const action = { ACCEPTED: 'LAB_REQUEST_ACCEPTED', REJECTED: 'LAB_REQUEST_REJECTED', CANCELLED: 'LAB_REQUEST_CANCELLED' }[status];
  await logActivity(req, action, { type: 'lab_request', id: rq.request_id, code: rq.request_code }, 'SUCCESS', { batchCode: rq.batch_code, reason: reason ?? null });
  const batch = await one('SELECT status FROM batches WHERE batch_id = $1', [rq.batch_id]);
  ok(res, { ...row, batch_code: rq.batch_code, batch_status: batch.status });
}

r.post('/lab-requests/:requestCode/accept', requireRole('LAB_TESTER'), validateBody(z.object({ notes: optText(1000) })),
  (req, res) => respondRequest(req, res, 'ACCEPTED', req.valid.notes));
r.post('/lab-requests/:requestCode/reject', requireRole('LAB_TESTER'), validateBody(z.object({ reason: text(1000, 5) })),
  (req, res) => respondRequest(req, res, 'REJECTED', req.valid.reason));
r.post('/lab-requests/:requestCode/cancel', requireRole('PROCESSOR'), validateBody(z.object({ reason: text(1000, 5) })),
  (req, res) => respondRequest(req, res, 'CANCELLED', req.valid.reason));

// ================================================================ PENDING TESTS (accepted requests)
r.get('/lab/queue', requireRole('LAB_TESTER'), async (req, res) => {
  const { rows } = await query(`${REQUEST_SELECT} WHERE rq.lab_org_id = $1 AND rq.status = 'ACCEPTED' ORDER BY rq.responded_at`, [req.user.orgId]);
  ok(res, rows);
});

// ================================================================ REPORTS
r.post('/lab/reports', requireRole('LAB_TESTER'), validateBody(createSchema), async (req, res) => {
  const v = req.valid;
  const rep = await withTransaction(req.user.id, async (c) => {
    const b = (await c.query('SELECT batch_id, status FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
    const rq = b && (await c.query(`SELECT request_id FROM lab_test_requests WHERE batch_id = $1 AND lab_org_id = $2 AND status = 'ACCEPTED'`,
      [b.batch_id, req.user.orgId])).rows[0];
    if (!b || !rq) throw notFound('Accepted testing request for this batch');
    return (await c.query(
      `INSERT INTO lab_reports (batch_id, lab_org_id, tested_by, request_id, sample_code, received_on, tested_on, moisture_pct, hmf_mg_kg,
          sucrose_g_100g, glucose_g_100g, fructose_g_100g, brix, ph, free_acidity_meq_kg, water_activity,
          electrical_conductivity_ms_cm, pollen_identification, adulteration_method, adulteration_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [b.batch_id, req.user.orgId, req.user.id, rq.request_id, v.sampleCode, v.receivedOn, v.testedOn, v.moisturePct, v.hmfMgKg,
       v.sucroseG100g, v.glucoseG100g, v.fructoseG100g, v.brix, v.ph, v.freeAcidityMeqKg, v.waterActivity,
       v.electricalConductivityMsCm, v.pollenIdentification, v.adulterationMethod, v.adulterationResult])).rows[0];
  });
  await logActivity(req, 'LAB_REPORT_DRAFTED', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { batchCode: v.batchCode });
  created(res, { ...rep, batch_code: v.batchCode });
});

r.patch('/lab/reports/:reportCode', requireRole('LAB_TESTER'), validateBody(createSchema.omit({ batchCode: true }).partial()), async (req, res) => {
  const rep = await ownReport(req.user, req.params.reportCode);
  if (rep.report_state !== 'DRAFT') throw conflict('REPORT_IMMUTABLE', 'Submitted reports cannot be edited; request an audited correction instead');
  const sets = [];
  const vals = [rep.lab_report_id];
  for (const [k, v] of Object.entries(req.valid)) {
    if (!(k in req.body)) continue; // only fields actually sent
    vals.push(v);
    sets.push(`${COLS[k]} = $${vals.length}`);
  }
  if (!sets.length) return ok(res, rep);
  const updated = await withTransaction(req.user.id, async (c) =>
    (await c.query(`UPDATE lab_reports SET ${sets.join(', ')} WHERE lab_report_id = $1 RETURNING *`, vals)).rows[0]);
  await logActivity(req, 'LAB_REPORT_EDITED', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { fields: Object.keys(req.body) });
  ok(res, { ...updated, batch_code: rep.batch_code });
});

// Rule-based screening of the entered values against the configured standard (NOT AI)
r.get('/lab/reports/:reportCode/screening', requireRole('LAB_TESTER', 'ADMIN'), async (req, res) => {
  const rep = await getReadableReport(req.user, req.params.reportCode);
  const screening = screenReport(rep, await getSetting('standards_profile'));
  ok(res, { ...screening, suggestedDecision: suggestDecision(screening),
    note: 'Suggestion from rule-based limits only. The laboratory decides; PASS against a limit is flagged for review (anomaly rule R07).' });
});

// The laboratory outcome is assigned automatically by the analysis (POST /lab/reports/:code/analysis).
// Nobody can choose PASS / FAIL by hand; this endpoint is kept only to answer old clients clearly.
r.post('/lab/reports/:reportCode/submit', requireRole('LAB_TESTER'), async (req, res) => {
  await logActivity(req, 'LAB_MANUAL_DECISION_REFUSED', { type: 'lab_report', code: String(req.params.reportCode).toUpperCase() }, 'DENIED',
    { attempted: req.body?.decision ?? null });
  throw forbidden('The laboratory outcome is assigned automatically by the standards-based analysis. Submit the lab report for analysis instead.');
});

r.get('/lab/reports', requireRole('LAB_TESTER', 'ADMIN'),
  validateQuery(z.object({ ...pageQuery, state: z.enum(['DRAFT', 'SUBMITTED', 'SUPERSEDED']).optional(), decision: z.enum(DECISIONS).optional(),
    from: isoDate.optional(), to: isoDate.optional() })),
  async (req, res) => {
    const q = req.validQuery;
    const params = [req.user.role === 'LAB_TESTER' ? req.user.orgId : null, q.state ?? null, q.decision ?? null, q.from ?? null, q.to ?? null];
    const where = `($1::int IS NULL OR lr.lab_org_id = $1) AND ($2::text IS NULL OR lr.report_state = $2)
      AND ($3::text IS NULL OR lr.decision = $3) AND ($4::date IS NULL OR lr.tested_on >= $4) AND ($5::date IS NULL OR lr.tested_on <= $5)`;
    const { limit, offset } = paging(q);
    const { rows } = await query(
      `SELECT lr.lab_report_id, lr.report_code, lr.sample_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
              lr.adulteration_result, lr.report_state, lr.decision, lr.submitted_at, lr.is_demo,
              b.batch_code, b.status AS batch_status, o.name AS lab_name, u.full_name AS tested_by_name,
              (SELECT count(*) FROM lab_report_documents d WHERE d.lab_report_id = lr.lab_report_id) AS document_count,
              (SELECT c.status FROM lab_report_corrections c WHERE c.lab_report_id = lr.lab_report_id ORDER BY c.correction_id DESC LIMIT 1) AS correction_status
         FROM lab_reports lr JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
         JOIN users u ON u.user_id = lr.tested_by
        WHERE ${where} ORDER BY lr.lab_report_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*) AS n FROM lab_reports lr WHERE ${where}`, params)).n;
    ok(res, rows, pageMeta(q, total));
  });

r.get('/lab/reports/:reportCode', requireRole('LAB_TESTER', 'ADMIN', 'BEEKEEPER', 'PROCESSOR', 'DISTRIBUTOR'), async (req, res) => {
  ok(res, await getReadableReport(req.user, req.params.reportCode));
});

// ================================================================ AUDITED CORRECTIONS
// Corrections change MEASUREMENTS only; the corrected outcome is recomputed automatically on approval.
const correctionChanges = createSchema.omit({ batchCode: true, sampleCode: true }).partial();
const DECISION_FIELDS = ['decision', 'decisionRemarks'];

r.post('/lab/reports/:reportCode/corrections', requireRole('LAB_TESTER'), validateBody(z.object({
  reason: text(2000, 10),
  changes: correctionChanges,
})), async (req, res) => {
  if (DECISION_FIELDS.some((k) => k in (req.body.changes ?? {}))) {
    throw forbidden('The laboratory outcome is assigned automatically; a correction can only change measured values');
  }
  const rep = await ownReport(req.user, req.params.reportCode);
  if (rep.report_state !== 'SUBMITTED') throw conflict('NOT_CORRECTABLE', 'Only the current submitted report can be corrected');
  const sent = Object.keys(req.body.changes ?? {}).filter((k) => k in COLS && !DECISION_FIELDS.includes(k));
  const changes = Object.fromEntries(sent.map((k) => [k, req.valid.changes[k] ?? null]));
  const previous = Object.fromEntries(sent.map((k) => [k, rep[COLS[k]] ?? null]));
  const really = sent.filter((k) => String(changes[k] ?? '') !== String(previous[k] ?? ''));
  if (!really.length) throw unprocessable('NO_CHANGES', 'The proposed values are identical to the submitted ones');
  const row = await withTransaction(req.user.id, async (c) => (await c.query(
    `INSERT INTO lab_report_corrections (lab_report_id, requested_by, reason, proposed_changes, previous_values)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [rep.lab_report_id, req.user.id, req.valid.reason,
     JSON.stringify(Object.fromEntries(really.map((k) => [k, changes[k]]))),
     JSON.stringify(Object.fromEntries(really.map((k) => [k, previous[k]])))])).rows[0]);
  await logActivity(req, 'LAB_CORRECTION_REQUESTED', { type: 'lab_correction', id: row.correction_id, code: row.correction_code }, 'SUCCESS',
    { reportCode: rep.report_code, fields: really });
  created(res, { ...row, report_code: rep.report_code });
});

const CORRECTION_SELECT = `
  SELECT c.*, lr.report_code, lr.lab_org_id, b.batch_code, b.status AS batch_status, o.name AS lab_name,
         ru.full_name AS requested_by_name, vu.full_name AS reviewed_by_name, nr.report_code AS new_report_code
    FROM lab_report_corrections c JOIN lab_reports lr ON lr.lab_report_id = c.lab_report_id
    JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
    JOIN users ru ON ru.user_id = c.requested_by LEFT JOIN users vu ON vu.user_id = c.reviewed_by
    LEFT JOIN lab_reports nr ON nr.lab_report_id = c.new_lab_report_id`;

r.get('/lab-corrections', requireRole('LAB_TESTER', 'ADMIN'),
  validateQuery(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() })), async (req, res) => {
    const { rows } = await query(
      `${CORRECTION_SELECT} WHERE ($1::int IS NULL OR lr.lab_org_id = $1) AND ($2::text IS NULL OR c.status = $2) ORDER BY c.correction_id DESC LIMIT 200`,
      [req.user.role === 'LAB_TESTER' ? req.user.orgId : null, req.validQuery.status ?? null]);
    ok(res, rows);
  });

r.post('/lab-corrections/:correctionCode/reject', requireRole('ADMIN'), validateBody(z.object({ note: text(1000, 5) })), async (req, res) => {
  const c0 = await one(`${CORRECTION_SELECT} WHERE c.correction_code = $1`, [req.params.correctionCode.toUpperCase()]);
  if (!c0) throw notFound('Correction');
  if (c0.status !== 'PENDING') throw conflict('CORRECTION_CLOSED', `Correction is already ${c0.status}`);
  const row = await withTransaction(req.user.id, async (c) => (await c.query(
    `UPDATE lab_report_corrections SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), review_note = $3
      WHERE correction_id = $1 RETURNING *`, [c0.correction_id, req.user.id, req.valid.note])).rows[0]);
  await logActivity(req, 'LAB_CORRECTION_REJECTED', { type: 'lab_correction', id: c0.correction_id, code: c0.correction_code }, 'SUCCESS', { reportCode: c0.report_code, note: req.valid.note });
  ok(res, row);
});

// Approval: old report -> SUPERSEDED (kept, still verifiable on-chain), new corrected report SUBMITTED and anchored.
r.post('/lab-corrections/:correctionCode/approve', requireRole('ADMIN'), validateBody(z.object({ note: text(1000, 5) })), async (req, res) => {
  const c0 = await one(`${CORRECTION_SELECT} WHERE c.correction_code = $1`, [req.params.correctionCode.toUpperCase()]);
  if (!c0) throw notFound('Correction');
  if (c0.status !== 'PENDING') throw conflict('CORRECTION_CLOSED', `Correction is already ${c0.status}`);
  if (c0.requested_by === req.user.id) throw conflict('SELF_REVIEW', 'You cannot review your own correction request');
  // recompute the outcome from the corrected values BEFORE writing anything (no manual decision)
  const before = await one('SELECT * FROM lab_reports WHERE lab_report_id = $1', [c0.lab_report_id]);
  const preview = { ...before };
  for (const [k, v] of Object.entries(c0.proposed_changes)) if (!DECISION_FIELDS.includes(k)) preview[COLS[k]] = v;
  const honeyCategory = (await one(`SELECT honey_category FROM lab_report_analyses WHERE lab_report_id = $1 AND status = 'COMPLETED'
                                      ORDER BY completed_at DESC LIMIT 1`, [c0.lab_report_id]))?.honey_category ?? 'BLOSSOM';
  const analysed = await analyseCorrection(before, preview, honeyCategory);
  let savedDocId = null;
  const result = await withTransaction(req.user.id, async (c) => {
    await c.query("SELECT set_config('app.lab_correction', $1, true)", [c0.correction_code]);
    const old = (await c.query('SELECT * FROM lab_reports WHERE lab_report_id = $1 FOR UPDATE', [c0.lab_report_id])).rows[0];
    const batch = (await c.query('SELECT batch_id, status FROM batches WHERE batch_id = $1 FOR UPDATE', [old.batch_id])).rows[0];
    if (old.report_state !== 'SUBMITTED') throw conflict('NOT_CORRECTABLE', 'The report is no longer the current submitted report');
    if (!['LAB_PASSED', 'LAB_FAILED', 'LAB_INCONCLUSIVE'].includes(batch.status)) {
      throw conflict('BATCH_MOVED_ON', `Batch is ${batch.status}; results can only be corrected before the batch leaves the processor`);
    }
    await c.query(`UPDATE lab_reports SET report_state = 'SUPERSEDED', superseded_at = now() WHERE lab_report_id = $1`, [old.lab_report_id]);
    const merged = { ...old };
    for (const [k, v] of Object.entries(c0.proposed_changes)) if (!DECISION_FIELDS.includes(k)) merged[COLS[k]] = v;
    merged.decision = analysed.outcome;
    merged.decision_remarks = `Automatic outcome ${analysed.outcome} of the corrected values (standards: ${analysed.report.standardsStatus})`;
    const n = (await c.query('SELECT count(*)::int AS n FROM lab_reports WHERE batch_id = $1 AND supersedes_report_id IS NOT NULL', [old.batch_id])).rows[0].n + 1;
    const fresh = (await c.query(
      `INSERT INTO lab_reports (batch_id, lab_org_id, tested_by, request_id, sample_code, received_on, tested_on, moisture_pct, hmf_mg_kg,
          sucrose_g_100g, glucose_g_100g, fructose_g_100g, brix, ph, free_acidity_meq_kg, water_activity, electrical_conductivity_ms_cm,
          pollen_identification, adulteration_method, adulteration_result, report_state, decision, decision_remarks, submitted_at,
          supersedes_report_id, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'SUBMITTED',$21,$22,now(),$23,$24) RETURNING *`,
      [old.batch_id, old.lab_org_id, c0.requested_by, old.request_id, `${old.sample_code}-C${n}`.slice(0, 40), merged.received_on, merged.tested_on,
       merged.moisture_pct, merged.hmf_mg_kg, merged.sucrose_g_100g, merged.glucose_g_100g, merged.fructose_g_100g, merged.brix, merged.ph,
       merged.free_acidity_meq_kg, merged.water_activity, merged.electrical_conductivity_ms_cm, merged.pollen_identification,
       merged.adulteration_method, merged.adulteration_result, merged.decision,
       `${merged.decision_remarks} [Corrected by ${c0.correction_code}: ${c0.reason}]`.slice(0, 4000), old.lab_report_id, old.is_demo])).rows[0];
    const { row: an, doc } = await storeCorrectionAnalysis(c, { newReport: fresh, analysed, honeyCategory, adminId: req.user.id });
    await (await collection('ai_analysis_results')).insertOne(doc);
    savedDocId = doc._id;
    const newStatus = DECISION_STATUS[fresh.decision];
    if (newStatus !== batch.status) await c.query('UPDATE batches SET status = $2 WHERE batch_id = $1', [old.batch_id, newStatus]);
    await c.query(
      `UPDATE lab_report_corrections SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), review_note = $3, new_lab_report_id = $4
        WHERE correction_id = $1`, [c0.correction_id, req.user.id, req.valid.note, fresh.lab_report_id]);
    const anchor = await createPendingAnchor(c, { entity_type: 'LAB_REPORT', batch_id: old.batch_id, lab_report_id: fresh.lab_report_id }, req.user.id);
    return { newReportCode: fresh.report_code, supersededReportCode: old.report_code, batchStatus: newStatus, anchorQueued: Boolean(anchor),
      automaticOutcome: fresh.decision, analysisCode: an.analysis_code };
  }).catch(async (e) => {
    if (savedDocId) await (await collection('ai_analysis_results')).deleteOne({ _id: savedDocId }).catch(() => {});
    throw e;
  });
  await logActivity(req, 'LAB_CORRECTION_APPROVED', { type: 'lab_correction', id: c0.correction_id, code: c0.correction_code }, 'SUCCESS',
    { ...result, changes: c0.proposed_changes, previous: c0.previous_values, note: req.valid.note });
  ok(res, result);
});

// ================================================================ SPECTRAL SCANS (MongoDB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/** Parse a CSV of spectral observations. Band columns are those whose header is a wavelength ("399.40nm" or "399.40"). */
export function parseSpectralCsv(buf) {
  const textContent = buf.toString('utf8').replace(/^﻿/, '');
  const lines = textContent.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw unprocessable('BAD_FILE', 'CSV must have a header row and at least one data row');
  if (lines.length > 5001) throw unprocessable('BAD_FILE', 'At most 5000 observations per file');
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const bandIdx = [];
  const wavelengths = [];
  const ignored = [];
  let acqIdx = -1;
  header.forEach((h, i) => {
    const m = /^(\d+(?:\.\d+)?)\s*(nm)?$/i.exec(h);
    if (m) { bandIdx.push(i); wavelengths.push(Number(m[1])); }
    else if (/^acquisition$/i.test(h)) acqIdx = i;
    else ignored.push(h);
  });
  if (bandIdx.length < 10) throw unprocessable('BAD_FILE', 'No spectral band columns found (headers must be wavelengths, e.g. "399.40nm")');
  const acquisitions = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(',');
    const values = bandIdx.map((i) => Number(cells[i]));
    if (values.some((x) => !Number.isFinite(x))) throw unprocessable('BAD_FILE', `Row ${li + 1} has a non-numeric band value`);
    const acq = acqIdx >= 0 ? Number(cells[acqIdx]) : li;
    acquisitions.push({ acquisitionNo: Number.isFinite(acq) ? Math.trunc(acq) : li, values });
  }
  return { wavelengths, acquisitions, ignored };
}

r.post('/lab/reports/:reportCode/spectral-scans', requireRole('LAB_TESTER'), upload.single('file'), async (req, res) => {
  const rep = await ownReport(req.user, req.params.reportCode);
  if (rep.report_state === 'SUPERSEDED') throw conflict('REPORT_IMMUTABLE', 'This report has been superseded');
  if (!req.file) throw unprocessable('BAD_FILE', 'Attach a CSV file in the "file" field');
  const parsed = parseSpectralCsv(req.file.buffer);
  const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const col = await collection('spectral_scans');
  if (await col.findOne({ 'sourceFile.sha256': sha256 })) throw conflict('DUPLICATE_FILE', 'This exact file has already been uploaded');
  const doc = {
    batchId: rep.batch_id,
    batchCode: rep.batch_code,
    labReportId: rep.lab_report_id,
    uploadedBy: req.user.id,
    instrument: (req.body.instrument || '').slice(0, 120) || null,
    preprocessing: (req.body.preprocessing || '').slice(0, 200) || null,
    bandCount: parsed.wavelengths.length,
    wavelengthsNm: parsed.wavelengths.map(Number),
    acquisitions: parsed.acquisitions,
    ignoredColumns: parsed.ignored,
    sourceFile: { name: req.file.originalname.slice(0, 200), sha256 },
    createdAt: new Date(),
    isDemo: req.body.isDemo === 'true',
  };
  const saved = await insertWithOutbox('spectral_scans', doc);
  if (!saved.saved) throw conflict('NOT_SAVED', 'MongoDB is unavailable; the scan was queued and will be saved automatically. Try analysing it later.');
  await logActivity(req, 'SPECTRAL_SCAN_UPLOADED', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS',
    { observations: parsed.acquisitions.length, bands: parsed.wavelengths.length });
  created(res, { id: String(saved.id), bandCount: doc.bandCount, observations: doc.acquisitions.length, ignoredColumns: parsed.ignored, sourceFile: doc.sourceFile });
});

r.get('/lab/reports/:reportCode/spectral-scans', requireRole('LAB_TESTER', 'ADMIN'), async (req, res) => {
  const rep = await getReadableReport(req.user, req.params.reportCode);
  const col = await collection('spectral_scans');
  const docs = await col.find({ labReportId: rep.lab_report_id }).sort({ createdAt: -1 }).toArray();
  ok(res, docs.map((d) => ({
    id: String(d._id), bandCount: d.bandCount, observations: d.acquisitions.length, instrument: d.instrument,
    preprocessing: d.preprocessing, sourceFile: d.sourceFile, createdAt: d.createdAt, isDemo: d.isDemo,
  })));
});

export default r;
