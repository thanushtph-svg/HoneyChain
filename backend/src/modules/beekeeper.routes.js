// Beekeeper: profile, hives, harvests, batch creation / splitting (transfers are in transfers.routes.js).
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, decimal, code, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';
import { createPendingAnchor } from '../services/anchorService.js';
import { env } from '../config/env.js';

const r = Router();
r.use(['/beekeeper', '/hives', '/harvests'], requireAuth);

// ---------------------------------------------------------------- profile
r.get('/beekeeper/profile', requireRole('BEEKEEPER'), async (req, res) => {
  const p = await one(
    `SELECT b.*, u.email, u.full_name, u.phone FROM beekeepers b JOIN users u ON u.user_id = b.user_id
      WHERE b.user_id = $1`, [req.user.id]);
  ok(res, p);
});

r.patch(
  '/beekeeper/profile',
  requireRole('BEEKEEPER'),
  validateBody(z.object({
    publicDisplayName: text(120).optional(),
    showNamePublicly: z.boolean().optional(),
    cooperativeName: optText(150),
    village: optText(80),
    district: text(80).optional(),
    state: text(80).optional(),
    registrationNo: optText(60),
    phone: optText(20),
  })),
  async (req, res) => {
    const v = req.valid;
    await withTransaction(req.user.id, async (c) => {
      await c.query(
        `UPDATE beekeepers SET
           public_display_name = COALESCE($2, public_display_name),
           show_name_publicly  = COALESCE($3, show_name_publicly),
           cooperative_name    = CASE WHEN $4::boolean THEN $5 ELSE cooperative_name END,
           village             = CASE WHEN $6::boolean THEN $7 ELSE village END,
           district            = COALESCE($8, district),
           state               = COALESCE($9, state),
           registration_no     = CASE WHEN $10::boolean THEN $11 ELSE registration_no END
         WHERE user_id = $1`,
        [req.user.id, v.publicDisplayName ?? null, v.showNamePublicly ?? null,
         'cooperativeName' in req.body, v.cooperativeName, 'village' in req.body, v.village,
         v.district ?? null, v.state ?? null, 'registrationNo' in req.body, v.registrationNo],
      );
      if ('phone' in req.body) await c.query('UPDATE users SET phone = $2 WHERE user_id = $1', [req.user.id, v.phone]);
    });
    await logActivity(req, 'PROFILE_UPDATED', { type: 'beekeeper', id: req.user.beekeeperId });
    const p = await one(`SELECT b.*, u.email, u.full_name, u.phone FROM beekeepers b JOIN users u ON u.user_id=b.user_id WHERE b.user_id=$1`, [req.user.id]);
    ok(res, p);
  },
);

// ---------------------------------------------------------------- hives
const HIVE_TYPES = ['LANGSTROTH', 'NEWTON', 'TOP_BAR', 'TRADITIONAL', 'OTHER'];

r.get('/hives', requireRole('BEEKEEPER', 'ADMIN'), validateQuery(z.object({ ...pageQuery, status: z.enum(['ACTIVE', 'INACTIVE']).optional() })), async (req, res) => {
  const q = req.validQuery;
  const own = req.user.role === 'BEEKEEPER';
  const params = [own ? req.user.beekeeperId : null, q.status ?? null];
  const where = `($1::int IS NULL OR hv.beekeeper_id = $1) AND ($2::text IS NULL OR hv.status = $2)`;
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT hv.*, bk.beekeeper_code, bk.public_display_name,
            (SELECT count(*) FROM harvests h WHERE h.hive_id = hv.hive_id) AS harvest_count,
            (SELECT COALESCE(sum(quantity_kg),0) FROM harvests h WHERE h.hive_id = hv.hive_id) AS total_harvest_kg
       FROM hives hv JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
      WHERE ${where} ORDER BY hv.hive_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*) AS n FROM hives hv WHERE ${where}`, params)).n;
  ok(res, rows, pageMeta(q, total));
});

r.post(
  '/hives',
  requireRole('BEEKEEPER'),
  validateBody(z.object({
    hiveType: z.enum(HIVE_TYPES),
    beeSpecies: text(60),
    apiaryLocation: text(150),
    district: text(80),
    state: text(80),
    installedOn: isoDate,
  })),
  async (req, res) => {
    const v = req.valid;
    const h = await withTransaction(req.user.id, async (c) => (await c.query(
      `INSERT INTO hives (beekeeper_id, hive_type, bee_species, apiary_location, district, state, installed_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.beekeeperId, v.hiveType, v.beeSpecies, v.apiaryLocation, v.district, v.state, v.installedOn])).rows[0]);
    await logActivity(req, 'HIVE_REGISTERED', { type: 'hive', id: h.hive_id, code: h.hive_code });
    created(res, h);
  },
);

r.patch(
  '/hives/:hiveCode',
  requireRole('BEEKEEPER'),
  validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), apiaryLocation: text(150).optional() })),
  async (req, res) => {
    const h = await one(
      `UPDATE hives SET status = COALESCE($3, status), apiary_location = COALESCE($4, apiary_location)
        WHERE hive_code = $1 AND beekeeper_id = $2 RETURNING *`,
      [req.params.hiveCode.toUpperCase(), req.user.beekeeperId, req.valid.status ?? null, req.valid.apiaryLocation ?? null]);
    if (!h) throw notFound('Hive');
    await logActivity(req, 'HIVE_UPDATED', { type: 'hive', id: h.hive_id, code: h.hive_code }, 'SUCCESS', req.valid);
    ok(res, h);
  },
);

// ---------------------------------------------------------------- harvests
r.get('/harvests', requireRole('BEEKEEPER', 'ADMIN'),
  validateQuery(z.object({ ...pageQuery, hiveCode: code.optional(), from: isoDate.optional(), to: isoDate.optional() })),
  async (req, res) => {
    const q = req.validQuery;
    const params = [req.user.role === 'BEEKEEPER' ? req.user.beekeeperId : null, q.hiveCode ?? null, q.from ?? null, q.to ?? null];
    const where = `($1::int IS NULL OR hv.beekeeper_id = $1) AND ($2::text IS NULL OR hv.hive_code = $2)
                   AND ($3::date IS NULL OR h.harvest_date >= $3) AND ($4::date IS NULL OR h.harvest_date <= $4)`;
    const { limit, offset } = paging(q);
    const { rows } = await query(
      `SELECT h.*, hv.hive_code, bk.beekeeper_code,
              COALESCE((SELECT sum(quantity_kg) FROM batches b WHERE b.harvest_id = h.harvest_id), 0) AS batched_kg,
              (SELECT count(*) FROM batches b WHERE b.harvest_id = h.harvest_id) AS batch_count
         FROM harvests h JOIN hives hv ON hv.hive_id = h.hive_id JOIN beekeepers bk ON bk.beekeeper_id = hv.beekeeper_id
        WHERE ${where} ORDER BY h.harvest_date DESC, h.harvest_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*) AS n FROM harvests h JOIN hives hv ON hv.hive_id=h.hive_id WHERE ${where}`, params)).n;
    ok(res, rows, pageMeta(q, total));
  });

r.post(
  '/harvests',
  requireRole('BEEKEEPER'),
  validateBody(z.object({
    hiveCode: code,
    harvestDate: isoDate,
    quantityKg: decimal(0.01, 500),
    floralSource: text(100),
    notes: optText(1000),
  })),
  async (req, res) => {
    const v = req.valid;
    const hive = await one('SELECT hive_id FROM hives WHERE hive_code = $1 AND beekeeper_id = $2', [v.hiveCode, req.user.beekeeperId]);
    if (!hive) throw notFound('Hive');
    const h = await withTransaction(req.user.id, async (c) => (await c.query(
      `INSERT INTO harvests (hive_id, harvest_date, quantity_kg, floral_source, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [hive.hive_id, v.harvestDate, v.quantityKg, v.floralSource, v.notes, req.user.id])).rows[0]);
    await logActivity(req, 'HARVEST_RECORDED', { type: 'harvest', id: h.harvest_id, code: h.harvest_code }, 'SUCCESS', { quantityKg: v.quantityKg });
    created(res, { ...h, hive_code: v.hiveCode });
  },
);

async function ownHarvest(user, harvestCode) {
  const own = user.role === 'BEEKEEPER';
  const h = await one(
    `SELECT h.*, hv.hive_code, hv.beekeeper_id FROM harvests h JOIN hives hv ON hv.hive_id = h.hive_id
      WHERE h.harvest_code = $1 AND ($2::int IS NULL OR hv.beekeeper_id = $2)`,
    [harvestCode.toUpperCase(), own ? user.beekeeperId : null]);
  if (!h) throw notFound('Harvest');
  return h;
}

r.get('/harvests/:harvestCode', requireRole('BEEKEEPER', 'ADMIN'), async (req, res) => {
  const h = await ownHarvest(req.user, req.params.harvestCode);
  const { rows: batches } = await query(
    `SELECT b.batch_code, b.quantity_kg, b.honey_type, b.status, b.created_at, o.name AS processor_name
       FROM batches b LEFT JOIN organizations o ON o.org_id = batch_processor_org(b.batch_id)
      WHERE b.harvest_id = $1 ORDER BY b.batch_id`, [h.harvest_id]);
  const batched = batches.reduce((s, b) => s + Number(b.quantity_kg), 0);
  ok(res, { ...h, batches, batched_kg: batched.toFixed(2), remaining_kg: (Number(h.quantity_kg) - batched).toFixed(2) });
});

// Create one or more batches from a harvest - ONE transaction: batches + QR records + origin anchors.
r.post(
  '/harvests/:harvestCode/batches',
  requireRole('BEEKEEPER'),
  validateBody(z.object({
    batches: z.array(z.object({ quantityKg: decimal(0.01, 500), honeyType: text(80) })).min(1).max(20),
  })),
  async (req, res) => {
    const h = await ownHarvest(req.user, req.params.harvestCode);
    const createdBatches = await withTransaction(req.user.id, async (c) => {
      await c.query('SELECT 1 FROM harvests WHERE harvest_id = $1 FOR UPDATE', [h.harvest_id]);
      const out = [];
      for (const b of req.valid.batches) {
        const row = (await c.query(
          `INSERT INTO batches (harvest_id, quantity_kg, honey_type, created_by)
           VALUES ($1,$2,$3,$4) RETURNING batch_id, batch_code, quantity_kg, honey_type, status`,
          [h.harvest_id, b.quantityKg, b.honeyType, req.user.id])).rows[0];
        const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/verify/${row.batch_code}`;
        await c.query('INSERT INTO qr_records (batch_id, public_url, generated_by) VALUES ($1,$2,$3)', [row.batch_id, url, req.user.id]);
        const anchor = await createPendingAnchor(c, { entity_type: 'BATCH_ORIGIN', batch_id: row.batch_id }, req.user.id);
        out.push({ ...row, public_url: url, anchor_queued: Boolean(anchor) });
      }
      return out;
    });
    for (const b of createdBatches) {
      await logActivity(req, 'BATCH_CREATED', { type: 'batch', id: b.batch_id, code: b.batch_code }, 'SUCCESS', { harvestCode: h.harvest_code, quantityKg: b.quantity_kg });
    }
    created(res, createdBatches);
  },
);

export default r;
