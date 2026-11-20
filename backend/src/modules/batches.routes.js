// Role-scoped batch list and full internal batch detail.
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db/pg.js';
import { requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { ok, pageQuery, paging, pageMeta } from '../utils/http.js';
import { batchScope, getVisibleBatch } from '../services/access.js';

const r = Router();
r.use('/batches', requireAuth);

const STATUSES = ['CREATED', 'IN_TESTING', 'LAB_PASSED', 'LAB_FAILED', 'PROCESSED', 'IN_DISTRIBUTION', 'DELIVERED'];

r.get('/batches', validateQuery(z.object({ ...pageQuery, status: z.enum(STATUSES).optional(), q: z.string().trim().max(40).optional() })), async (req, res) => {
  const q = req.validQuery;
  const [cond, params] = batchScope(req.user, 3);
  const where = `($1::text IS NULL OR b.status = $1) AND ($2::text IS NULL OR b.batch_code ILIKE '%' || $2 || '%') AND ${cond}`;
  const all = [q.status ?? null, q.q ?? null, ...params];
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.quantity_kg, b.honey_type, b.status, b.is_demo, b.created_at,
            h.harvest_code, h.harvest_date, h.floral_source, hv.hive_code, bk.public_display_name AS beekeeper_name,
            lab.name AS assigned_lab_name
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
       JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id LEFT JOIN organizations lab ON lab.org_id = b.assigned_lab_id
      WHERE ${where} ORDER BY b.batch_id DESC LIMIT ${limit} OFFSET ${offset}`, all);
  const total = (await one(`SELECT count(*) AS n FROM batches b WHERE ${where}`, all)).n;
  ok(res, rows, pageMeta(q, total));
});

r.get('/batches/:batchCode', async (req, res) => {
  const b = await getVisibleBatch(req.user, req.params.batchCode.toUpperCase());
  const id = b.batch_id;
  const [trace, history, reports, processing, shipments, anchors, qr] = await Promise.all([
    one('SELECT * FROM v_batch_trace WHERE batch_id = $1', [id]),
    query(`SELECT bh.from_status, bh.to_status, bh.changed_at, u.full_name AS changed_by_name, u.role_code AS changed_by_role
             FROM batch_status_history bh LEFT JOIN users u ON u.user_id = bh.changed_by
            WHERE bh.batch_id = $1 ORDER BY bh.history_id`, [id]),
    query(`SELECT lr.*, o.name AS lab_name, u.full_name AS tested_by_name FROM lab_reports lr
             JOIN organizations o ON o.org_id = lr.lab_org_id JOIN users u ON u.user_id = lr.tested_by
            WHERE lr.batch_id = $1 ORDER BY lr.lab_report_id`, [id]),
    one(`SELECT p.*, o.name AS processor_name FROM processing_records p JOIN organizations o ON o.org_id = p.processor_org_id
          WHERE p.batch_id = $1`, [id]),
    query(`SELECT s.*, o.name AS distributor_name FROM shipments s JOIN organizations o ON o.org_id = s.distributor_org_id
            WHERE s.batch_id = $1 ORDER BY s.shipment_id`, [id]),
    query('SELECT * FROM v_anchor_status WHERE batch_id = $1 ORDER BY anchor_id', [id]),
    one('SELECT public_url, scan_count, last_scanned_at, generated_at FROM qr_records WHERE batch_id = $1', [id]),
  ]);
  // Beekeeper personal contact details are only for admins and the owner
  const showPrivate = req.user.role === 'ADMIN' || (req.user.role === 'BEEKEEPER' && req.user.beekeeperId === b.beekeeper_id);
  if (!showPrivate && trace) {
    delete trace.beekeeper_email;
    delete trace.beekeeper_full_name;
    delete trace.beekeeper_user_id;
  }
  const units = processing ? processing.units_packed : 0;
  const shipped = shipments.rows.filter((s) => s.status !== 'CANCELLED').reduce((s, x) => s + x.units_shipped, 0);
  ok(res, {
    batch: trace,
    statusHistory: history.rows,
    labReports: reports.rows,
    processing,
    shipments: shipments.rows,
    unitsRemaining: units - shipped,
    anchors: anchors.rows,
    qr,
  });
});

export default r;
