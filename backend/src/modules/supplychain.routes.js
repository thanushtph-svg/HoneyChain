// Processor and distributor modules.
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, decimal, code, intRange, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';
import { createPendingAnchor } from '../services/anchorService.js';

const r = Router();
r.use(['/processing', '/distribution', '/shipments'], requireAuth);

// ================================================================ PROCESSING
r.get('/processing/queue', requireRole('PROCESSOR'), async (_req, res) => {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.quantity_kg, b.honey_type, b.status, b.is_demo,
            h.harvest_code, h.harvest_date, h.floral_source,
            lr.report_code, lr.tested_on, lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g, lr.adulteration_result, lr.decision,
            o.name AS lab_name
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id
       JOIN lab_reports lr ON lr.batch_id = b.batch_id AND lr.report_state = 'SUBMITTED'
       JOIN organizations o ON o.org_id = lr.lab_org_id
      WHERE b.status = 'LAB_PASSED' ORDER BY lr.submitted_at`);
  ok(res, rows);
});

const PROC_METHODS = ['FILTRATION', 'STRAINING', 'SETTLING', 'GENTLE_WARMING', 'CREAMING', 'OTHER'];
const PACKAGING = ['GLASS_JAR', 'PET_JAR', 'SACHET', 'TIN', 'BULK_DRUM', 'OTHER'];

r.post(
  '/processing',
  requireRole('PROCESSOR'),
  validateBody(z.object({
    batchCode: code,
    processingDate: isoDate,
    method: z.enum(PROC_METHODS),
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
      const b = (await c.query('SELECT batch_id, status FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
      if (!b) throw notFound('Batch');
      if (b.status !== 'LAB_PASSED') throw conflict('BATCH_NOT_PROCESSABLE', `Batch is ${b.status}; only LAB_PASSED batches can be processed`);
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
    await logActivity(req, 'PROCESSING_RECORDED', { type: 'processing', id: rec.processing_id, code: rec.processing_code }, 'SUCCESS', { batchCode: v.batchCode });
    created(res, { ...rec, batch_code: v.batchCode });
  },
);

r.get('/processing', requireRole('PROCESSOR', 'ADMIN'), validateQuery(z.object({ ...pageQuery })), async (req, res) => {
  const q = req.validQuery;
  const params = [req.user.role === 'PROCESSOR' ? req.user.orgId : null];
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT p.*, b.batch_code, o.name AS processor_name, u.full_name AS recorded_by_name
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
r.get('/distribution/queue', requireRole('DISTRIBUTOR'), async (_req, res) => {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.honey_type, b.status, b.is_demo,
            p.processing_code, p.packaging_type, p.unit_size_g, p.units_packed, p.packaging_date, o.name AS processor_name, o.city AS processor_city,
            p.units_packed - COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED'), 0) AS units_remaining
       FROM batches b JOIN processing_records p ON p.batch_id = b.batch_id JOIN organizations o ON o.org_id = p.processor_org_id
      WHERE b.status IN ('PROCESSED','IN_DISTRIBUTION')
        AND p.units_packed > COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED'), 0)
      ORDER BY p.packaging_date`);
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
      const b = (await c.query('SELECT batch_id, status FROM batches WHERE batch_code = $1 FOR UPDATE', [v.batchCode])).rows[0];
      if (!b) throw notFound('Batch');
      if (!['PROCESSED', 'IN_DISTRIBUTION'].includes(b.status)) throw conflict('BATCH_NOT_DISPATCHABLE', `Batch is ${b.status}`);
      const row = (await c.query(
        `INSERT INTO shipments (batch_id, distributor_org_id, recorded_by, dispatch_date, origin_location, destination_name,
            destination_type, destination_city, destination_state, carrier_name, tracking_reference, units_shipped)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [b.batch_id, req.user.orgId, req.user.id, v.dispatchDate, v.originLocation, v.destinationName, v.destinationType,
         v.destinationCity, v.destinationState, v.carrierName, v.trackingReference, v.unitsShipped])).rows[0];
      if (b.status === 'PROCESSED') await c.query(`UPDATE batches SET status = 'IN_DISTRIBUTION' WHERE batch_id = $1`, [b.batch_id]);
      return row;
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
  validateQuery(z.object({ ...pageQuery, status: z.enum(['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']).optional() })),
  async (req, res) => {
    const q = req.validQuery;
    const params = [req.user.role === 'DISTRIBUTOR' ? req.user.orgId : null, q.status ?? null];
    const where = '($1::int IS NULL OR s.distributor_org_id = $1) AND ($2::text IS NULL OR s.status = $2)';
    const { limit, offset } = paging(q);
    const { rows } = await query(
      `SELECT s.*, b.batch_code, o.name AS distributor_name FROM shipments s JOIN batches b ON b.batch_id = s.batch_id
         JOIN organizations o ON o.org_id = s.distributor_org_id
        WHERE ${where} ORDER BY s.shipment_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*) AS n FROM shipments s WHERE ${where}`, params)).n;
    ok(res, rows, pageMeta(q, total));
  });

export default r;
