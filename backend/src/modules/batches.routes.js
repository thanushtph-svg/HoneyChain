// Role-scoped batch list and full internal batch detail (traceability record).
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { ok, pageQuery, paging, pageMeta } from '../utils/http.js';
import { batchScope, getVisibleBatch, sanitizeBatchDetail } from '../services/access.js';
import { STAFF_ROLES } from '../config/roles.js';

const r = Router();
r.use('/batches', requireAuth, requireRole(...STAFF_ROLES));

export const BATCH_STATUSES = ['CREATED', 'PENDING_PROCESSOR', 'IN_PROCESSING', 'PROCESSED', 'PENDING_LAB', 'IN_TESTING',
  'LAB_PASSED', 'LAB_FAILED', 'LAB_INCONCLUSIVE', 'PENDING_DISTRIBUTOR', 'IN_DISTRIBUTION', 'DELIVERED'];

r.get('/batches', validateQuery(z.object({
  ...pageQuery,
  status: z.string().trim().max(200).optional()
    .refine((s) => !s || s.split(',').every((x) => BATCH_STATUSES.includes(x)), 'Unknown status'),
  q: z.string().trim().max(40).optional(),
})), async (req, res) => {
  const q = req.validQuery;
  const [cond, params] = batchScope(req.user, 3);
  const statuses = q.status ? q.status.split(',') : null;
  const where = `($1::text[] IS NULL OR b.status = ANY($1)) AND ($2::text IS NULL OR b.batch_code ILIKE '%' || $2 || '%') AND ${cond}`;
  const all = [statuses, q.q ?? null, ...params];
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.quantity_kg, b.honey_type, b.status, b.is_demo, b.created_at,
            h.harvest_code, h.harvest_date, h.floral_source, hv.hive_code, bk.public_display_name AS beekeeper_name,
            po.name AS processor_name, dorg.name AS distributor_name,
            (SELECT lr.decision FROM lab_reports lr WHERE lr.lab_report_id = batch_current_report(b.batch_id)) AS lab_decision,
            (SELECT o.name FROM lab_test_requests rq JOIN organizations o ON o.org_id = rq.lab_org_id
              WHERE rq.batch_id = b.batch_id ORDER BY rq.request_id DESC LIMIT 1) AS lab_name,
            (SELECT t.transfer_code FROM batch_transfers t WHERE t.batch_id = b.batch_id AND t.status = 'PENDING') AS pending_transfer_code
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
       JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
       LEFT JOIN organizations po ON po.org_id = batch_processor_org(b.batch_id)
       LEFT JOIN organizations dorg ON dorg.org_id = batch_distributor_org(b.batch_id)
      WHERE ${where} ORDER BY b.batch_id DESC LIMIT ${limit} OFFSET ${offset}`, all);
  const total = (await one(`SELECT count(*) AS n FROM batches b WHERE ${where}`, all)).n;
  ok(res, rows, pageMeta(q, total));
});

r.get('/batches/:batchCode', async (req, res) => {
  const b = await getVisibleBatch(req.user, req.params.batchCode.toUpperCase());
  const id = b.batch_id;
  const [trace, history, reports, processing, shipments, anchors, qr, transfers, requests, corrections] = await Promise.all([
    one('SELECT * FROM v_batch_trace WHERE batch_id = $1', [id]),
    query(`SELECT bh.from_status, bh.to_status, bh.changed_at, u.full_name AS changed_by_name, u.role_code AS changed_by_role
             FROM batch_status_history bh LEFT JOIN users u ON u.user_id = bh.changed_by
            WHERE bh.batch_id = $1 ORDER BY bh.history_id`, [id]),
    query(`SELECT lr.lab_report_id, lr.report_code, lr.request_id, lr.sample_code, lr.received_on, lr.tested_on,
                  lr.moisture_pct, lr.hmf_mg_kg, lr.sucrose_g_100g, lr.glucose_g_100g, lr.fructose_g_100g, lr.ph,
                  lr.adulteration_result, lr.adulteration_method, lr.report_state, lr.decision, lr.decision_remarks,
                  lr.submitted_at, lr.superseded_at, lr.supersedes_report_id, lr.is_demo,
                  o.name AS lab_name, (SELECT x.report_code FROM lab_reports x WHERE x.lab_report_id = lr.supersedes_report_id) AS supersedes_report_code
             FROM lab_reports lr JOIN organizations o ON o.org_id = lr.lab_org_id
            WHERE lr.batch_id = $1 ORDER BY lr.lab_report_id`, [id]),
    one(`SELECT p.*, o.name AS processor_name FROM processing_records p JOIN organizations o ON o.org_id = p.processor_org_id
          WHERE p.batch_id = $1`, [id]),
    query(`SELECT s.*, o.name AS distributor_name FROM shipments s JOIN organizations o ON o.org_id = s.distributor_org_id
            WHERE s.batch_id = $1 ORDER BY s.shipment_id`, [id]),
    query('SELECT * FROM v_anchor_status WHERE batch_id = $1 ORDER BY anchor_id', [id]),
    one('SELECT public_url, scan_count, last_scanned_at, generated_at FROM qr_records WHERE batch_id = $1', [id]),
    query(`SELECT t.transfer_code, t.transfer_type, t.from_org_id, t.to_org_id, t.quantity_kg, t.units, t.notes, t.status,
                  t.initiated_at, t.responded_at, t.response_reason, fo.name AS from_org_name, tor.name AS to_org_name,
                  iu.full_name AS initiated_by_name, ru.full_name AS responded_by_name
             FROM batch_transfers t LEFT JOIN organizations fo ON fo.org_id = t.from_org_id
             JOIN organizations tor ON tor.org_id = t.to_org_id
             JOIN users iu ON iu.user_id = t.initiated_by LEFT JOIN users ru ON ru.user_id = t.responded_by
            WHERE t.batch_id = $1 ORDER BY t.transfer_id`, [id]),
    query(`SELECT rq.request_code, rq.lab_org_id, rq.requester_org_id, rq.status, rq.requested_at, rq.responded_at,
                  rq.response_reason, rq.completed_at, rq.sample_reference, rq.tests_requested,
                  lo.name AS lab_name, ro.name AS requester_name, ru.full_name AS requested_by_name, xu.full_name AS responded_by_name
             FROM lab_test_requests rq JOIN organizations lo ON lo.org_id = rq.lab_org_id
             JOIN organizations ro ON ro.org_id = rq.requester_org_id
             JOIN users ru ON ru.user_id = rq.requested_by LEFT JOIN users xu ON xu.user_id = rq.responded_by
            WHERE rq.batch_id = $1 ORDER BY rq.request_id`, [id]),
    query(`SELECT c.correction_code, c.status, c.reason, c.requested_at, c.reviewed_at, c.review_note,
                  lr.report_code, nr.report_code AS new_report_code
             FROM lab_report_corrections c JOIN lab_reports lr ON lr.lab_report_id = c.lab_report_id
             LEFT JOIN lab_reports nr ON nr.lab_report_id = c.new_lab_report_id
            WHERE lr.batch_id = $1 ORDER BY c.correction_id`, [id]),
  ]);
  const units = processing ? processing.units_packed : 0;
  const shipped = shipments.rows.filter((s) => s.status !== 'CANCELLED').reduce((s, x) => s + x.units_shipped, 0);
  const d = {
    batch: trace,
    statusHistory: history.rows,
    transfers: transfers.rows,
    labRequests: requests.rows,
    labReports: reports.rows,
    labCorrections: corrections.rows,
    processing,
    shipments: shipments.rows,
    unitsRemaining: units - shipped,
    anchors: anchors.rows,
    qr,
    // what the CURRENT user may do next (the server enforces each action again)
    can: {
      transferToProcessor: req.user.role === 'BEEKEEPER' && trace.status === 'CREATED',
      recordProcessing: req.user.role === 'PROCESSOR' && trace.status === 'IN_PROCESSING' && b.processor_org_id === req.user.orgId,
      requestTesting: req.user.role === 'PROCESSOR' && ['PROCESSED', 'LAB_INCONCLUSIVE'].includes(trace.status) && b.processor_org_id === req.user.orgId,
      transferToDistributor: req.user.role === 'PROCESSOR' && trace.status === 'LAB_PASSED' && b.processor_org_id === req.user.orgId,
      enterResults: req.user.role === 'LAB_TESTER' && trace.status === 'IN_TESTING'
        && requests.rows.some((x) => x.status === 'ACCEPTED' && x.lab_org_id === req.user.orgId),
      ship: req.user.role === 'DISTRIBUTOR' && trace.status === 'IN_DISTRIBUTION' && b.distributor_org_id === req.user.orgId && units - shipped > 0,
      verifyChain: req.user.role === 'ADMIN',
    },
  };
  ok(res, sanitizeBatchDetail(req.user, b, d));
});

export default r;
