// Processor (processing records) and distributor (shipments, delivery status) modules.
// Custody hand-overs are in transfers.routes.js; laboratory testing requests in lab.routes.js.
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, decimal, code, intRange, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';
import { createPendingAnchor } from '../services/anchorService.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Processing method definitions (the six existing method codes + method-specific fields), served to the UI
const METHOD_CFG = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/processing_methods.json'), 'utf8'));
export const PROCESSING_METHODS = METHOD_CFG.methods;
const METHOD_BY_CODE = Object.fromEntries(PROCESSING_METHODS.map((m) => [m.code, m]));

const r = Router();
r.use(['/processing', '/distribution', '/shipments'], requireAuth);

// ================================================================ PROCESSING
// Batches this processing unit has ACCEPTED and not yet processed
r.get('/processing/queue', requireRole('PROCESSOR'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.quantity_kg, b.honey_type, b.status, b.is_demo,
            h.harvest_code, h.harvest_date, h.floral_source, hv.district, hv.state,
            bk.public_display_name AS beekeeper_name, t.transfer_code, t.responded_at AS received_at,
            (SELECT count(*)::int FROM processing_steps s WHERE s.batch_id = b.batch_id) AS steps_saved
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
       JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
       JOIN batch_transfers t ON t.batch_id = b.batch_id AND t.transfer_type = 'TO_PROCESSOR' AND t.status = 'ACCEPTED'
      WHERE b.status = 'IN_PROCESSING' AND t.to_org_id = $1
      ORDER BY t.responded_at`, [req.user.orgId]);
  ok(res, rows);
});

const PROC_METHODS = PROCESSING_METHODS.map((m) => m.code);

r.get('/processing/methods', requireRole('PROCESSOR', 'ADMIN'), (_req, res) => ok(res, PROCESSING_METHODS));

/** Batch in this unit's custody (any status) or 404 */
async function custodyBatch(user, batchCode, c = null) {
  const sql = 'SELECT batch_id, batch_code, status, quantity_kg, batch_processor_org(batch_id) AS proc FROM batches WHERE batch_code = $1' + (c ? ' FOR UPDATE' : '');
  const b = c ? (await c.query(sql, [batchCode.toUpperCase()])).rows[0] : await one(sql, [batchCode.toUpperCase()]);
  if (!b || (user.role === 'PROCESSOR' && b.proc !== user.orgId)) throw notFound('Batch');
  return b;
}
const STEP_SELECT = 'SELECT s.*, u.full_name AS recorded_by_name FROM processing_steps s JOIN users u ON u.user_id = s.recorded_by';

// Saved processing steps of a batch (several methods per batch; each saved independently)
r.get('/processing/batches/:batchCode/steps', requireRole('PROCESSOR', 'ADMIN'), async (req, res) => {
  const b = await custodyBatch(req.user, req.params.batchCode);
  const steps = (await query(STEP_SELECT + ' WHERE s.batch_id = $1 ORDER BY s.step_no', [b.batch_id])).rows;
  const finalRec = await one('SELECT processing_code, created_at FROM processing_records WHERE batch_id = $1', [b.batch_id]);
  ok(res, { batchCode: b.batch_code, batchStatus: b.status, finalized: Boolean(finalRec), processingCode: finalRec?.processing_code ?? null,
    finalizedAt: finalRec?.created_at ?? null, steps });
});

function validateStepParameters(method, parameters = {}, details) {
  const def = METHOD_BY_CODE[method];
  const errors = [];
  const clean = {};
  for (const fd of def.fields) {
    const raw = parameters[fd.key];
    if (raw == null || raw === '') {
      if (fd.required) errors.push(fd.label + ' (' + fd.unit + ') is required for ' + def.label);
      continue;
    }
    const x = Number(raw);
    if (!Number.isFinite(x) || x < fd.min || x > fd.max) errors.push(fd.label + ' must be between ' + fd.min + ' and ' + fd.max + ' ' + fd.unit);
    else clean[fd.key] = x;
  }
  const unknown = Object.keys(parameters).filter((k) => !def.fields.some((fd) => fd.key === k));
  if (unknown.length) errors.push('Unknown fields for ' + def.label + ': ' + unknown.join(', '));
  if (def.requiresDetails && !(details && details.trim().length >= 5)) errors.push('Describe the ' + def.label + ' step in the details (at least 5 characters)');
  if (errors.length) throw unprocessable('VALIDATION_ERROR', errors.join('; '), { errors });
  return clean;
}

// Save ONE processing step. Never finalizes: the batch stays IN_PROCESSING.
r.post('/processing/batches/:batchCode/steps', requireRole('PROCESSOR'), validateBody(z.object({
  method: z.enum(PROCESSING_METHODS.map((m) => m.code)),
  stepDate: isoDate,
  details: optText(1000),
  parameters: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
})), async (req, res) => {
  const v = req.valid;
  const params = validateStepParameters(v.method, v.parameters ?? {}, v.details);
  const step = await withTransaction(req.user.id, async (c) => {
    const b = await custodyBatch(req.user, req.params.batchCode, c);
    if (b.status !== 'IN_PROCESSING') throw conflict('PROCESSING_FINALIZED', 'Batch is ' + b.status + '; steps can only be added while it is IN_PROCESSING');
    const n = (await c.query('SELECT COALESCE(max(step_no), 0) + 1 AS n FROM processing_steps WHERE batch_id = $1', [b.batch_id])).rows[0].n;
    return (await c.query(
      'INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date, details, parameters) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [b.batch_id, req.user.orgId, req.user.id, n, v.method, v.stepDate, v.details, JSON.stringify(params)])).rows[0];
  });
  await logActivity(req, 'PROCESSING_STEP_SAVED', { type: 'processing_step', id: step.step_id, code: step.step_code }, 'SUCCESS',
    { batchCode: req.params.batchCode.toUpperCase(), method: v.method, stepNo: step.step_no, parameters: params });
  created(res, step);
});

// Remove a mistaken step (only before finalization; enforced by the database too)
r.delete('/processing/batches/:batchCode/steps/:stepCode', requireRole('PROCESSOR'), async (req, res) => {
  const out = await withTransaction(req.user.id, async (c) => {
    const b = await custodyBatch(req.user, req.params.batchCode, c);
    const del = (await c.query('DELETE FROM processing_steps WHERE batch_id = $1 AND step_code = $2 RETURNING step_code, method',
      [b.batch_id, req.params.stepCode.toUpperCase()])).rows[0];
    if (!del) throw notFound('Processing step');
    return del;
  });
  await logActivity(req, 'PROCESSING_STEP_REMOVED', { type: 'processing_step', code: out.step_code }, 'SUCCESS',
    { batchCode: req.params.batchCode.toUpperCase(), method: out.method });
  ok(res, { removed: out.step_code });
});

const fmtParams = (m, p) => METHOD_BY_CODE[m].fields.filter((fd) => p[fd.key] != null)
  .map((fd) => fd.label.toLowerCase() + ' ' + p[fd.key] + ' ' + fd.unit).join(', ');
const isoDay = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const PACKAGING = ['GLASS_JAR', 'PET_JAR', 'SACHET', 'TIN', 'BULK_DRUM', 'OTHER'];

r.post(
  '/processing',
  requireRole('PROCESSOR'),
  validateBody(z.object({
    batchCode: code,
    processingDate: isoDate,
    method: z.enum(PROC_METHODS).optional(), // legacy single-method clients; the UI saves steps first
    methodDetails: optText(1000),
    operatorName: text(120),
    operatorStaffId: optText(40),
    inputQuantityKg: decimal(0.01, 500),
    outputQuantityKg: decimal(0.01, 500),
    packagingDate: isoDate,
    packagingType: z.enum(PACKAGING),
    unitSizeG: intRange(1, 100000),
    unitsPacked: intRange(1, 1000000),
    bestBefore: isoDate,
  })),
  async (req, res) => {
    const v = req.valid;
    const rec = await withTransaction(req.user.id, async (c) => {
      const b = (await c.query('SELECT batch_id, status, batch_processor_org(batch_id) AS proc FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
      if (!b || b.proc !== req.user.orgId) throw notFound('Batch');
      if (b.status !== 'IN_PROCESSING') {
        throw conflict('BATCH_NOT_PROCESSABLE', `Batch is ${b.status}; only batches your unit has accepted (IN_PROCESSING) can be processed`);
      }
      // Explicit "Finalize Processing": needs at least one saved step (a legacy single-method call is saved as step 1)
      let steps = (await c.query('SELECT * FROM processing_steps WHERE batch_id = $1 ORDER BY step_no', [b.batch_id])).rows;
      if (!steps.length && v.method) {
        if (v.method === 'OTHER') validateStepParameters(v.method, {}, v.methodDetails ?? '');
        steps = (await c.query(
          'INSERT INTO processing_steps (batch_id, processor_org_id, recorded_by, step_no, method, step_date, details) VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING *',
          [b.batch_id, req.user.orgId, req.user.id, v.method, v.processingDate, v.methodDetails])).rows;
      }
      if (!steps.length) throw unprocessable('NO_PROCESSING_STEPS', 'Save at least one processing step (method) before finalizing processing');
      const summary = steps.map((st) => {
        const p = fmtParams(st.method, st.parameters ?? {});
        return st.step_no + ') ' + st.method + ' on ' + isoDay(st.step_date) + (p ? ' (' + p + ')' : '') + (st.details ? ' - ' + st.details : '');
      }).join('; ');
      const notes = req.valid.methodDetails && !steps.some((st) => st.details === req.valid.methodDetails) ? '. Notes: ' + req.valid.methodDetails : '';
      v.method = steps[0].method;
      v.methodDetails = 'Steps: ' + summary + notes;
      const row = (await c.query(
        `INSERT INTO processing_records (batch_id, processor_org_id, recorded_by, processing_date, method, method_details,
            operator_name, operator_staff_id, input_quantity_kg, output_quantity_kg, packaging_date, packaging_type,
            unit_size_g, units_packed, best_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [b.batch_id, req.user.orgId, req.user.id, v.processingDate, v.method, v.methodDetails, v.operatorName, v.operatorStaffId,
         v.inputQuantityKg, v.outputQuantityKg, v.packagingDate, v.packagingType, v.unitSizeG, v.unitsPacked, v.bestBefore])).rows[0];
      await c.query(`UPDATE batches SET status = 'PROCESSED' WHERE batch_id = $1`, [b.batch_id]);
      const anchor = await createPendingAnchor(c, { entity_type: 'PROCESSING_RECORD', batch_id: b.batch_id, processing_id: row.processing_id }, req.user.id);
      return { ...row, anchor_queued: Boolean(anchor) };
    });
    const lossKg = Number(v.inputQuantityKg) - Number(v.outputQuantityKg);
    await logActivity(req, 'PROCESSING_RECORDED', { type: 'processing', id: rec.processing_id, code: rec.processing_code }, 'SUCCESS',
      { batchCode: v.batchCode, inputKg: v.inputQuantityKg, outputKg: v.outputQuantityKg, lossKg: lossKg.toFixed(2) });
    created(res, { ...rec, batch_code: v.batchCode, loss_kg: lossKg.toFixed(2) });
  },
);

r.get('/processing', requireRole('PROCESSOR', 'ADMIN'), validateQuery(z.object({ ...pageQuery })), async (req, res) => {
  const q = req.validQuery;
  const params = [req.user.role === 'PROCESSOR' ? req.user.orgId : null];
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT p.*, (p.input_quantity_kg - p.output_quantity_kg) AS loss_kg, b.batch_code, b.status AS batch_status,
            o.name AS processor_name, u.full_name AS recorded_by_name
       FROM processing_records p JOIN batches b ON b.batch_id = p.batch_id
       JOIN organizations o ON o.org_id = p.processor_org_id JOIN users u ON u.user_id = p.recorded_by
      WHERE ($1::int IS NULL OR p.processor_org_id = $1) ORDER BY p.processing_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const total = (await one('SELECT count(*) AS n FROM processing_records p WHERE ($1::int IS NULL OR p.processor_org_id = $1)', params)).n;
  ok(res, rows, pageMeta(q, total));
});

r.get('/processing/:processingCode', requireRole('PROCESSOR', 'ADMIN'), async (req, res) => {
  const p = await one(
    `SELECT p.*, b.batch_code, o.name AS processor_name FROM processing_records p JOIN batches b ON b.batch_id = p.batch_id
       JOIN organizations o ON o.org_id = p.processor_org_id
      WHERE p.processing_code = $1 AND ($2::int IS NULL OR p.processor_org_id = $2)`,
    [req.params.processingCode.toUpperCase(), req.user.role === 'PROCESSOR' ? req.user.orgId : null]);
  if (!p) throw notFound('Processing record');
  ok(res, p);
});

// ================================================================ DISTRIBUTION
// Batches this distributor has ACCEPTED that still have packed units to ship
r.get('/distribution/queue', requireRole('DISTRIBUTOR'), async (req, res) => {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.honey_type, b.status, b.is_demo,
            p.processing_code, p.packaging_type, p.unit_size_g, p.units_packed, p.packaging_date, p.best_before,
            o.name AS processor_name, o.city AS processor_city,
            (SELECT lr.decision FROM lab_reports lr WHERE lr.lab_report_id = batch_current_report(b.batch_id)) AS lab_decision,
            p.units_packed - COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED'), 0) AS units_remaining
       FROM batches b JOIN processing_records p ON p.batch_id = b.batch_id JOIN organizations o ON o.org_id = p.processor_org_id
      WHERE b.status = 'IN_DISTRIBUTION' AND batch_distributor_org(b.batch_id) = $1
        AND p.units_packed > COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED'), 0)
      ORDER BY p.packaging_date`, [req.user.orgId]);
  ok(res, rows);
});

const DEST_TYPES = ['WAREHOUSE', 'DISTRIBUTOR', 'RETAILER', 'INSTITUTION', 'OTHER'];

r.post(
  '/shipments',
  requireRole('DISTRIBUTOR'),
  validateBody(z.object({
    batchCode: code,
    dispatchDate: isoDate,
    originLocation: text(150),
    destinationName: text(150),
    destinationType: z.enum(DEST_TYPES),
    destinationCity: text(80),
    destinationState: text(80),
    carrierName: optText(120),
    trackingReference: optText(60),
    unitsShipped: intRange(1, 1000000),
  })),
  async (req, res) => {
    const v = req.valid;
    const s = await withTransaction(req.user.id, async (c) => {
      const b = (await c.query('SELECT batch_id, status, batch_distributor_org(batch_id) AS dist FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
      if (!b || b.dist !== req.user.orgId) throw notFound('Batch');
      if (b.status !== 'IN_DISTRIBUTION') throw conflict('BATCH_NOT_DISPATCHABLE', `Batch is ${b.status}; accept the transfer first`);
      return (await c.query(
        `INSERT INTO shipments (batch_id, distributor_org_id, recorded_by, dispatch_date, origin_location, destination_name,
            destination_type, destination_city, destination_state, carrier_name, tracking_reference, units_shipped)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [b.batch_id, req.user.orgId, req.user.id, v.dispatchDate, v.originLocation, v.destinationName, v.destinationType,
         v.destinationCity, v.destinationState, v.carrierName, v.trackingReference, v.unitsShipped])).rows[0];
    });
    await logActivity(req, 'SHIPMENT_DISPATCHED', { type: 'shipment', id: s.shipment_id, code: s.shipment_code }, 'SUCCESS', { batchCode: v.batchCode, units: v.unitsShipped });
    created(res, { ...s, batch_code: v.batchCode });
  },
);

r.patch(
  '/shipments/:shipmentCode/status',
  requireRole('DISTRIBUTOR'),
  validateBody(z.object({ status: z.enum(['IN_TRANSIT', 'DELIVERED', 'CANCELLED']), deliveredOn: isoDate.optional() })),
  async (req, res) => {
    const v = req.valid;
    if (v.status === 'DELIVERED' && !v.deliveredOn) throw unprocessable('VALIDATION_ERROR', 'deliveredOn is required when status is DELIVERED');
    const s0 = await one('SELECT * FROM shipments WHERE shipment_code = $1 AND distributor_org_id = $2', [req.params.shipmentCode.toUpperCase(), req.user.orgId]);
    if (!s0) throw notFound('Shipment');
    const result = await withTransaction(req.user.id, async (c) => {
      await c.query('SELECT 1 FROM batches WHERE batch_id = $1 FOR UPDATE', [s0.batch_id]);
      const s = (await c.query(
        `UPDATE shipments SET status = $2, delivered_on = $3 WHERE shipment_id = $1 RETURNING *`,
        [s0.shipment_id, v.status, v.status === 'DELIVERED' ? v.deliveredOn : null])).rows[0];
      let anchorQueued = false;
      if (v.status === 'DELIVERED') {
        anchorQueued = Boolean(await createPendingAnchor(c, { entity_type: 'SHIPMENT', batch_id: s.batch_id, shipment_id: s.shipment_id }, req.user.id));
      }
      // Batch becomes DELIVERED when every packed unit is shipped and every live shipment is delivered
      const agg = (await c.query(
        `SELECT p.units_packed,
                COALESCE(sum(sh.units_shipped) FILTER (WHERE sh.status <> 'CANCELLED'), 0) AS shipped,
                count(*) FILTER (WHERE sh.status IN ('DISPATCHED','IN_TRANSIT')) AS open_count,
                b.status
           FROM batches b JOIN processing_records p ON p.batch_id = b.batch_id
           LEFT JOIN shipments sh ON sh.batch_id = b.batch_id
          WHERE b.batch_id = $1 GROUP BY p.units_packed, b.status`, [s.batch_id])).rows[0];
      let batchStatus = agg.status;
      if (agg.status === 'IN_DISTRIBUTION' && Number(agg.shipped) === agg.units_packed && Number(agg.open_count) === 0) {
        await c.query(`UPDATE batches SET status = 'DELIVERED' WHERE batch_id = $1`, [s.batch_id]);
        batchStatus = 'DELIVERED';
      }
      return { shipment: s, batchStatus, anchorQueued };
    });
    await logActivity(req, `SHIPMENT_${v.status}`, { type: 'shipment', id: s0.shipment_id, code: s0.shipment_code });
    ok(res, result);
  },
);

r.get('/shipments', requireRole('DISTRIBUTOR', 'ADMIN'),
  validateQuery(z.object({ ...pageQuery, status: z.string().trim().max(60).optional()
    .refine((s) => !s || s.split(',').every((x) => ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'].includes(x)), 'Unknown status') })),
  async (req, res) => {
    const q = req.validQuery;
    const params = [req.user.role === 'DISTRIBUTOR' ? req.user.orgId : null, q.status ? q.status.split(',') : null];
    const where = '($1::int IS NULL OR s.distributor_org_id = $1) AND ($2::text[] IS NULL OR s.status = ANY($2))';
    const { limit, offset } = paging(q);
    const { rows } = await query(
      `SELECT s.*, b.batch_code, o.name AS distributor_name FROM shipments s JOIN batches b ON b.batch_id = s.batch_id
         JOIN organizations o ON o.org_id = s.distributor_org_id
        WHERE ${where} ORDER BY s.shipment_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*) AS n FROM shipments s WHERE ${where}`, params)).n;
    ok(res, rows, pageMeta(q, total));
  });

export default r;
