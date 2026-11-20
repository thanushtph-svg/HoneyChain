// Laboratory: queue, draft -> submit reports, history, spectral scan upload.
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, decimal, optDecimal, code, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable } from '../utils/errors.js';
import { logActivity, insertWithOutbox } from '../services/activityLog.js';
import { createPendingAnchor } from '../services/anchorService.js';
import { batchScope } from '../services/access.js';
import { collection } from '../db/mongo.js';

const r = Router();
r.use('/lab', requireAuth);

const ADULT = ['NOT_DETECTED', 'DETECTED', 'INCONCLUSIVE', 'NOT_TESTED'];
const measurementFields = {
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
const COLS = {
  moisturePct: 'moisture_pct', hmfMgKg: 'hmf_mg_kg', sucroseG100g: 'sucrose_g_100g', glucoseG100g: 'glucose_g_100g',
  fructoseG100g: 'fructose_g_100g', brix: 'brix', ph: 'ph', freeAcidityMeqKg: 'free_acidity_meq_kg',
  waterActivity: 'water_activity', electricalConductivityMsCm: 'electrical_conductivity_ms_cm',
  pollenIdentification: 'pollen_identification', adulterationMethod: 'adulteration_method',
  adulterationResult: 'adulteration_result', sampleCode: 'sample_code', receivedOn: 'received_on', testedOn: 'tested_on',
};

const createSchema = z.object({
  batchCode: code,
  sampleCode: text(40),
  receivedOn: isoDate,
  testedOn: isoDate,
  ...measurementFields,
});

/** Load a report the user may read. Lab staff: own lab. Admin: all. Others: if they can see the batch. */
export async function getReadableReport(user, reportCode) {
  const rc = reportCode.toUpperCase();
  if (user.role === 'LAB' || user.role === 'ADMIN') {
    const rep = await one(
      `SELECT lr.*, b.batch_code, b.status AS batch_status, o.name AS lab_name, u.full_name AS tested_by_name
         FROM lab_reports lr JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
         JOIN users u ON u.user_id = lr.tested_by
        WHERE lr.report_code = $1 AND ($2::int IS NULL OR lr.lab_org_id = $2)`,
      [rc, user.role === 'LAB' ? user.orgId : null]);
    if (!rep) throw notFound('Lab report');
    return rep;
  }
  const [cond, params] = batchScope(user, 2);
  const rep = await one(
    `SELECT lr.*, b.batch_code, b.status AS batch_status, o.name AS lab_name FROM lab_reports lr
       JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
      WHERE lr.report_code = $1 AND lr.report_state = 'SUBMITTED' AND ${cond}`, [rc, ...params]);
  if (!rep) throw notFound('Lab report');
  return rep;
}

async function ownDraftOrSubmitted(user, reportCode) {
  const rep = await one(
    `SELECT lr.*, b.batch_code FROM lab_reports lr JOIN batches b ON b.batch_id = lr.batch_id
      WHERE lr.report_code = $1 AND lr.lab_org_id = $2`, [reportCode.toUpperCase(), user.orgId]);
  if (!rep) throw notFound('Lab report');
  return rep;
}

// ---------------------------------------------------------------- queue
r.get('/lab/queue', requireRole('LAB'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.quantity_kg, b.honey_type, b.status, b.is_demo, b.created_at,
            h.harvest_code, h.harvest_date, h.floral_source, hv.hive_code, hv.district, hv.state,
            (SELECT lr.report_code FROM lab_reports lr WHERE lr.batch_id = b.batch_id AND lr.report_state = 'DRAFT') AS draft_report_code
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
      WHERE b.assigned_lab_id = $1 AND b.status IN ('CREATED','IN_TESTING')
      ORDER BY b.created_at`, [req.user.orgId]);
  ok(res, rows);
});

// ---------------------------------------------------------------- create draft
r.post('/lab/reports', requireRole('LAB'), validateBody(createSchema), async (req, res) => {
  const v = req.valid;
  const rep = await withTransaction(req.user.id, async (c) => {
    const b = (await c.query('SELECT batch_id, status, assigned_lab_id FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
    if (!b || b.assigned_lab_id !== req.user.orgId) throw notFound('Batch');
    const row = (await c.query(
      `INSERT INTO lab_reports (batch_id, lab_org_id, tested_by, sample_code, received_on, tested_on, moisture_pct, hmf_mg_kg,
          sucrose_g_100g, glucose_g_100g, fructose_g_100g, brix, ph, free_acidity_meq_kg, water_activity,
          electrical_conductivity_ms_cm, pollen_identification, adulteration_method, adulteration_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [b.batch_id, req.user.orgId, req.user.id, v.sampleCode, v.receivedOn, v.testedOn, v.moisturePct, v.hmfMgKg,
       v.sucroseG100g, v.glucoseG100g, v.fructoseG100g, v.brix, v.ph, v.freeAcidityMeqKg, v.waterActivity,
       v.electricalConductivityMsCm, v.pollenIdentification, v.adulterationMethod, v.adulterationResult])).rows[0];
    if (b.status === 'CREATED') await c.query(`UPDATE batches SET status = 'IN_TESTING' WHERE batch_id = $1`, [b.batch_id]);
    return row;
  });
  await logActivity(req, 'LAB_REPORT_DRAFTED', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { batchCode: v.batchCode });
  created(res, { ...rep, batch_code: v.batchCode });
});

// ---------------------------------------------------------------- edit draft
r.patch('/lab/reports/:reportCode', requireRole('LAB'), validateBody(createSchema.omit({ batchCode: true }).partial()), async (req, res) => {
  const rep = await ownDraftOrSubmitted(req.user, req.params.reportCode);
  if (rep.report_state !== 'DRAFT') throw conflict('REPORT_IMMUTABLE', 'Submitted reports cannot be edited');
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

// ---------------------------------------------------------------- submit decision
r.post(
  '/lab/reports/:reportCode/submit',
  requireRole('LAB'),
  validateBody(z.object({ decision: z.enum(['PASS', 'FAIL']), decisionRemarks: text(2000) })),
  async (req, res) => {
    const rep = await ownDraftOrSubmitted(req.user, req.params.reportCode);
    if (rep.report_state !== 'DRAFT') throw conflict('REPORT_IMMUTABLE', 'This report is already submitted');
    const result = await withTransaction(req.user.id, async (c) => {
      await c.query('SELECT 1 FROM batches WHERE batch_id = $1 FOR UPDATE', [rep.batch_id]);
      await c.query(
        `UPDATE lab_reports SET report_state = 'SUBMITTED', decision = $2, decision_remarks = $3, submitted_at = now()
          WHERE lab_report_id = $1`, [rep.lab_report_id, req.valid.decision, req.valid.decisionRemarks]);
      const newStatus = req.valid.decision === 'PASS' ? 'LAB_PASSED' : 'LAB_FAILED';
      await c.query('UPDATE batches SET status = $2 WHERE batch_id = $1', [rep.batch_id, newStatus]);
      const anchor = await createPendingAnchor(c, { entity_type: 'LAB_REPORT', batch_id: rep.batch_id, lab_report_id: rep.lab_report_id }, req.user.id);
      return { batchStatus: newStatus, anchorQueued: Boolean(anchor) };
    });
    await logActivity(req, 'LAB_REPORT_SUBMITTED', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { decision: req.valid.decision, batchCode: rep.batch_code });
    ok(res, { reportCode: rep.report_code, batchCode: rep.batch_code, decision: req.valid.decision, ...result });
  },
);

// ---------------------------------------------------------------- history / detail
r.get('/lab/reports', requireRole('LAB', 'ADMIN'),
  validateQuery(z.object({ ...pageQuery, state: z.enum(['DRAFT', 'SUBMITTED']).optional(), decision: z.enum(['PASS', 'FAIL']).optional(),
    from: isoDate.optional(), to: isoDate.optional() })),
  async (req, res) => {
    const q = req.validQuery;
    const params = [req.user.role === 'LAB' ? req.user.orgId : null, q.state ?? null, q.decision ?? null, q.from ?? null, q.to ?? null];
    const where = `($1::int IS NULL OR lr.lab_org_id = $1) AND ($2::text IS NULL OR lr.report_state = $2)
      AND ($3::text IS NULL OR lr.decision = $3) AND ($4::date IS NULL OR lr.tested_on >= $4) AND ($5::date IS NULL OR lr.tested_on <= $5)`;
    const { limit, offset } = paging(q);
    const { rows } = await query(
      `SELECT lr.lab_report_id, lr.report_code, lr.sample_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g,
              lr.adulteration_result, lr.report_state, lr.decision, lr.submitted_at, lr.is_demo,
              b.batch_code, o.name AS lab_name, u.full_name AS tested_by_name
         FROM lab_reports lr JOIN batches b ON b.batch_id = lr.batch_id JOIN organizations o ON o.org_id = lr.lab_org_id
         JOIN users u ON u.user_id = lr.tested_by
        WHERE ${where} ORDER BY lr.lab_report_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*) AS n FROM lab_reports lr WHERE ${where}`, params)).n;
    ok(res, rows, pageMeta(q, total));
  });

r.get('/lab/reports/:reportCode', async (req, res) => {
  ok(res, await getReadableReport(req.user, req.params.reportCode));
});

// ---------------------------------------------------------------- spectral scans (MongoDB)
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

r.post('/lab/reports/:reportCode/spectral-scans', requireRole('LAB'), upload.single('file'), async (req, res) => {
  const rep = await ownDraftOrSubmitted(req.user, req.params.reportCode);
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

r.get('/lab/reports/:reportCode/spectral-scans', requireRole('LAB', 'ADMIN'), async (req, res) => {
  const rep = await getReadableReport(req.user, req.params.reportCode);
  const col = await collection('spectral_scans');
  const docs = await col.find({ labReportId: rep.lab_report_id }).sort({ createdAt: -1 }).toArray();
  ok(res, docs.map((d) => ({
    id: String(d._id), bandCount: d.bandCount, observations: d.acquisitions.length, instrument: d.instrument,
    preprocessing: d.preprocessing, sourceFile: d.sourceFile, createdAt: d.createdAt, isDemo: d.isDemo,
  })));
});

export default r;
