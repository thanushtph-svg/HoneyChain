// Custody transfers: beekeeper -> processor and processor -> distributor.
// The receiver must ACCEPT (custody moves) or REJECT with a reason (batch returns to the sender).
// The batch status follows the transfer automatically (database trigger trg_transfer_status).
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';

const r = Router();
r.use(['/transfers', '/directory'], requireAuth);

// ---------------------------------------------------------------- organization directory
// Each role may only list the organizations it can hand a batch to (public org fields only).
const DIRECTORY_FOR = { BEEKEEPER: ['PROCESSOR'], PROCESSOR: ['LABORATORY', 'DISTRIBUTOR'], ADMIN: ['PROCESSOR', 'LABORATORY', 'DISTRIBUTOR'] };
r.get('/directory/organizations', requireRole('BEEKEEPER', 'PROCESSOR', 'ADMIN'),
  validateQuery(z.object({ type: z.enum(['PROCESSOR', 'LABORATORY', 'DISTRIBUTOR']) })), async (req, res) => {
    const type = req.validQuery.type;
    if (!DIRECTORY_FOR[req.user.role].includes(type)) throw unprocessable('NOT_ALLOWED', `Your role cannot list ${type} organizations`);
    const { rows } = await query(
      `SELECT org_id, org_code, name, city, state, accreditation_no FROM organizations
        WHERE org_type = $1 AND is_active ORDER BY name`, [type]);
    ok(res, rows);
  });

// ---------------------------------------------------------------- shared loaders
const TRANSFER_SELECT = `
  SELECT t.*, b.batch_code, b.honey_type, b.status AS batch_status, b.is_demo AS batch_is_demo,
         fo.name AS from_org_name, tor.name AS to_org_name, tor.org_type AS to_org_type,
         h.harvest_code, h.harvest_date, h.floral_source, hv.district, hv.state,
         bk.public_display_name AS beekeeper_name, bk.beekeeper_code
    FROM batch_transfers t
    JOIN batches b ON b.batch_id = t.batch_id
    JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
    JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
    LEFT JOIN organizations fo ON fo.org_id = t.from_org_id
    JOIN organizations tor ON tor.org_id = t.to_org_id`;

/** Transfers a user may see: sender side or receiver side (admin: all). */
function transferScope(user, start) {
  const p = `$${start}`;
  switch (user.role) {
    case 'ADMIN': return ['TRUE', []];
    case 'BEEKEEPER': return [`t.transfer_type = 'TO_PROCESSOR' AND hv.beekeeper_id = ${p}`, [user.beekeeperId]];
    case 'PROCESSOR': return [`((t.transfer_type = 'TO_PROCESSOR' AND t.to_org_id = ${p}) OR (t.transfer_type = 'TO_DISTRIBUTOR' AND t.from_org_id = ${p}))`, [user.orgId]];
    case 'DISTRIBUTOR': return [`t.transfer_type = 'TO_DISTRIBUTOR' AND t.to_org_id = ${p}`, [user.orgId]];
    default: return ['FALSE', []];
  }
}

async function loadTransfer(user, transferCode) {
  const [cond, params] = transferScope(user, 2);
  const t = await one(`${TRANSFER_SELECT} WHERE t.transfer_code = $1 AND ${cond}`, [transferCode.toUpperCase(), ...params]);
  if (!t) throw notFound('Transfer');
  return t;
}

// ---------------------------------------------------------------- initiate
r.post('/batches/:batchCode/transfers', requireAuth, requireRole('BEEKEEPER', 'PROCESSOR'),
  validateBody(z.object({ toOrgId: z.number().int().positive(), notes: optText(1000) })),
  async (req, res) => {
    const code = req.params.batchCode.toUpperCase();
    const v = req.valid;
    const t = await withTransaction(req.user.id, async (c) => {
      const b = (await c.query(
        `SELECT b.batch_id, b.batch_code, b.status, b.quantity_kg, hv.beekeeper_id, batch_processor_org(b.batch_id) AS processor_org_id
           FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id
          WHERE b.batch_code = $1 FOR UPDATE OF b`, [code])).rows[0];
      if (req.user.role === 'BEEKEEPER') {
        if (!b || b.beekeeper_id !== req.user.beekeeperId) throw notFound('Batch');
        if (b.status !== 'CREATED') throw conflict('BATCH_NOT_TRANSFERABLE', `Batch is ${b.status}; only CREATED batches can be sent to a processor`);
        return (await c.query(
          `INSERT INTO batch_transfers (batch_id, transfer_type, to_org_id, quantity_kg, notes, initiated_by)
           VALUES ($1, 'TO_PROCESSOR', $2, $3, $4, $5) RETURNING *`,
          [b.batch_id, v.toOrgId, b.quantity_kg, v.notes, req.user.id])).rows[0];
      }
      // PROCESSOR -> DISTRIBUTOR
      if (!b || b.processor_org_id !== req.user.orgId) throw notFound('Batch');
      if (b.status !== 'LAB_PASSED') throw conflict('BATCH_NOT_TRANSFERABLE', `Batch is ${b.status}; only LAB_PASSED batches can be transferred to a distributor`);
      const p = (await c.query('SELECT units_packed, output_quantity_kg FROM processing_records WHERE batch_id = $1', [b.batch_id])).rows[0];
      return (await c.query(
        `INSERT INTO batch_transfers (batch_id, transfer_type, from_org_id, to_org_id, quantity_kg, units, notes, initiated_by)
         VALUES ($1, 'TO_DISTRIBUTOR', $2, $3, $4, $5, $6, $7) RETURNING *`,
        [b.batch_id, req.user.orgId, v.toOrgId, p.output_quantity_kg, p.units_packed, v.notes, req.user.id])).rows[0];
    });
    await logActivity(req, 'TRANSFER_INITIATED', { type: 'transfer', id: t.transfer_id, code: t.transfer_code }, 'SUCCESS',
      { batchCode: code, transferType: t.transfer_type, toOrgId: t.to_org_id, quantityKg: t.quantity_kg, units: t.units });
    created(res, { ...t, batch_code: code });
  });

// ---------------------------------------------------------------- list / detail
r.get('/transfers', requireRole('BEEKEEPER', 'PROCESSOR', 'DISTRIBUTOR', 'ADMIN'),
  validateQuery(z.object({
    ...pageQuery,
    direction: z.enum(['incoming', 'outgoing']).optional(),
    status: z.string().trim().max(60).optional()
      .refine((x) => !x || x.split(',').every((y) => ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'].includes(y)), 'Unknown status'),
    type: z.enum(['TO_PROCESSOR', 'TO_DISTRIBUTOR']).optional(),
  })),
  async (req, res) => {
    const q = req.validQuery;
    const [cond, params] = transferScope(req.user, 4);
    // direction is relative to the user's organization (beekeepers only ever send)
    let dir = 'TRUE';
    if (q.direction === 'incoming') dir = req.user.orgId ? 't.to_org_id = $3' : 'FALSE';
    if (q.direction === 'outgoing') dir = req.user.orgId ? 't.from_org_id = $3' : (req.user.role === 'BEEKEEPER' ? 'TRUE' : 'FALSE');
    const where = `($1::text[] IS NULL OR t.status = ANY($1)) AND ($2::text IS NULL OR t.transfer_type = $2) AND ($3::int IS NULL OR TRUE) AND ${dir} AND ${cond}`;
    const all = [q.status ? q.status.split(',') : null, q.type ?? null, req.user.orgId ?? null, ...params];
    const { limit, offset } = paging(q);
    const { rows } = await query(`${TRANSFER_SELECT} WHERE ${where} ORDER BY t.transfer_id DESC LIMIT ${limit} OFFSET ${offset}`, all);
    const total = (await one(
      `SELECT count(*) AS n FROM batch_transfers t JOIN batches b ON b.batch_id = t.batch_id
         JOIN harvests h ON h.harvest_id = b.harvest_id JOIN hives hv ON hv.hive_id = h.hive_id WHERE ${where}`, all)).n;
    ok(res, rows, pageMeta(q, total));
  });

r.get('/transfers/:transferCode', requireRole('BEEKEEPER', 'PROCESSOR', 'DISTRIBUTOR', 'ADMIN'), async (req, res) => {
  ok(res, await loadTransfer(req.user, req.params.transferCode));
});

// ---------------------------------------------------------------- respond (receiver)
async function respond(req, res, status, reason) {
  const t = await loadTransfer(req.user, req.params.transferCode);
  const expectedRole = t.transfer_type === 'TO_PROCESSOR' ? 'PROCESSOR' : 'DISTRIBUTOR';
  if (req.user.role !== expectedRole || t.to_org_id !== req.user.orgId) throw notFound('Transfer');
  if (t.status !== 'PENDING') throw conflict('TRANSFER_CLOSED', `Transfer ${t.transfer_code} is already ${t.status}`);
  const row = await withTransaction(req.user.id, async (c) => (await c.query(
    `UPDATE batch_transfers SET status = $2, responded_by = $3, responded_at = now(), response_reason = $4
      WHERE transfer_id = $1 AND status = 'PENDING' RETURNING *`,
    [t.transfer_id, status, req.user.id, reason ?? null])).rows[0]);
  if (!row) throw conflict('TRANSFER_CLOSED', 'Transfer was answered by someone else');
  const batch = await one('SELECT status FROM batches WHERE batch_id = $1', [t.batch_id]);
  await logActivity(req, status === 'ACCEPTED' ? 'TRANSFER_ACCEPTED' : 'TRANSFER_REJECTED',
    { type: 'transfer', id: t.transfer_id, code: t.transfer_code }, 'SUCCESS', { batchCode: t.batch_code, reason: reason ?? null });
  ok(res, { ...row, batch_code: t.batch_code, batch_status: batch.status });
}

r.post('/transfers/:transferCode/accept', requireRole('PROCESSOR', 'DISTRIBUTOR'),
  validateBody(z.object({ notes: optText(1000) })), (req, res) => respond(req, res, 'ACCEPTED', req.valid.notes));

r.post('/transfers/:transferCode/reject', requireRole('PROCESSOR', 'DISTRIBUTOR'),
  validateBody(z.object({ reason: text(1000, 5) })), (req, res) => respond(req, res, 'REJECTED', req.valid.reason));

// ---------------------------------------------------------------- cancel (sender, while pending)
r.post('/transfers/:transferCode/cancel', requireRole('BEEKEEPER', 'PROCESSOR'),
  validateBody(z.object({ reason: text(1000, 5) })), async (req, res) => {
    const t = await loadTransfer(req.user, req.params.transferCode);
    const isSender = t.transfer_type === 'TO_PROCESSOR' ? req.user.role === 'BEEKEEPER' : (req.user.role === 'PROCESSOR' && t.from_org_id === req.user.orgId);
    if (!isSender) throw notFound('Transfer');
    if (t.status !== 'PENDING') throw conflict('TRANSFER_CLOSED', `Transfer ${t.transfer_code} is already ${t.status}`);
    const row = await withTransaction(req.user.id, async (c) => (await c.query(
      `UPDATE batch_transfers SET status = 'CANCELLED', responded_by = $2, responded_at = now(), response_reason = $3
        WHERE transfer_id = $1 AND status = 'PENDING' RETURNING *`, [t.transfer_id, req.user.id, req.valid.reason])).rows[0]);
    await logActivity(req, 'TRANSFER_CANCELLED', { type: 'transfer', id: t.transfer_id, code: t.transfer_code }, 'SUCCESS', { batchCode: t.batch_code, reason: req.valid.reason });
    ok(res, { ...row, batch_code: t.batch_code });
  });

export default r;
