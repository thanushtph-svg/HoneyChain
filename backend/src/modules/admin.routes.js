// Administrator: users & roles, organizations, settings, statistics, audit/security logs, reports,
// blockchain and anomalies. Admins MONITOR business records: there is no endpoint here that edits hives,
// harvests, batches, lab results, processing or shipments. Lab results change only through audited
// corrections (lab.routes.js) that a lab tester requests and an admin approves.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, one, withTransaction } from '../db/pg.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { ok, created, text, optText, isoDate, code, pageQuery, paging, pageMeta } from '../utils/http.js';
import { notFound, conflict, unprocessable } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';
import { collection, toObjectId } from '../db/mongo.js';
import { chainStatus, chainConfig } from '../services/chainClient.js';
import { createPendingAnchor, findUnanchored, processAnchorsOnce, verifyAnchor } from '../services/anchorService.js';
import { runAnomalyScan } from '../services/anomalyService.js';
import { passwordRule } from './auth.routes.js';
import { ALL_ROLES, ORG_TYPE_FOR_ROLE, HOME_PATH, PERMISSIONS } from '../config/roles.js';
import { listStandardsProfiles } from '../services/standards.js';
import { invalidateSettings } from '../services/settings.js';
import { env } from '../config/env.js';

const r = Router();
r.use(['/admin', '/blockchain'], requireAuth, requireRole('ADMIN'));

// ---------------------------------------------------------------- users (all six roles)
r.get('/admin/users', validateQuery(z.object({ ...pageQuery, role: z.enum(ALL_ROLES).optional(),
  active: z.enum(['true', 'false']).optional(), q: z.string().trim().max(80).optional() })), async (req, res) => {
  const q = req.validQuery;
  const params = [q.role ?? null, q.active == null ? null : q.active === 'true', q.q ?? null];
  const where = `($1::text IS NULL OR u.role_code = $1) AND ($2::boolean IS NULL OR u.is_active = $2)
                 AND ($3::text IS NULL OR u.full_name ILIKE '%'||$3||'%' OR u.email ILIKE '%'||$3||'%')`;
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT u.user_id, u.email, u.full_name, u.phone, u.role_code, u.org_id, o.name AS org_name, o.org_type, u.is_active, u.is_demo,
            u.last_login_at, u.created_at, bk.beekeeper_code
       FROM users u LEFT JOIN organizations o ON o.org_id = u.org_id LEFT JOIN beekeepers bk ON bk.user_id = u.user_id
      WHERE ${where} ORDER BY u.user_id LIMIT ${limit} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*) AS n FROM users u WHERE ${where}`, params)).n;
  ok(res, rows, pageMeta(q, total));
});

r.post('/admin/users', validateBody(z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: text(120),
  phone: optText(20),
  role: z.enum(ALL_ROLES),
  orgId: z.number().int().positive().optional(),
  tempPassword: passwordRule,
  // beekeeper profile (role BEEKEEPER only)
  beekeeper: z.object({
    publicDisplayName: text(120).optional(),
    showNamePublicly: z.boolean().default(false),
    cooperativeName: optText(150),
    district: text(80),
    state: text(80),
  }).optional(),
})), async (req, res) => {
  const v = req.valid;
  const needsOrg = Boolean(ORG_TYPE_FOR_ROLE[v.role]);
  if (needsOrg && !v.orgId) throw unprocessable('VALIDATION_ERROR', `${v.role} users need an organization of type ${ORG_TYPE_FOR_ROLE[v.role]}`);
  if (v.role === 'BEEKEEPER' && !v.beekeeper) throw unprocessable('VALIDATION_ERROR', 'Beekeeper accounts need a profile (district, state)');
  const u = await withTransaction(req.user.id, async (c) => {
    const row = (await c.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role_code, org_id) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING user_id, email, full_name, role_code, org_id, is_active`,
      [v.email, await bcrypt.hash(v.tempPassword, 12), v.fullName, v.phone, v.role, needsOrg ? v.orgId : null])).rows[0];
    if (v.role === 'BEEKEEPER') {
      const p = v.beekeeper;
      await c.query(
        `INSERT INTO beekeepers (user_id, public_display_name, show_name_publicly, cooperative_name, district, state) VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.user_id, p.publicDisplayName ?? v.fullName, p.showNamePublicly, p.cooperativeName, p.district, p.state]);
    }
    return row;
  });
  await logActivity(req, 'USER_CREATED', { type: 'user', id: u.user_id }, 'SUCCESS', { role: v.role, orgId: u.org_id });
  created(res, u);
});

async function assertNotLastAdmin(c, userId) {
  const n = (await c.query(`SELECT count(*)::int AS n FROM users WHERE role_code = 'ADMIN' AND is_active AND user_id <> $1`, [userId])).rows[0].n;
  if (n === 0) throw conflict('LAST_ADMIN', 'At least one active administrator must remain');
}

r.patch('/admin/users/:userId', validateBody(z.object({ isActive: z.boolean().optional(), fullName: text(120).optional(), phone: optText(20) })), async (req, res) => {
  const id = Number(req.params.userId);
  if (id === req.user.id && req.valid.isActive === false) throw conflict('SELF_DEACTIVATION', 'You cannot deactivate your own account');
  const u = await withTransaction(req.user.id, async (c) => {
    const cur = (await c.query('SELECT role_code FROM users WHERE user_id = $1', [id])).rows[0];
    if (!cur) throw notFound('User');
    if (cur.role_code === 'ADMIN' && req.valid.isActive === false) await assertNotLastAdmin(c, id);
    return (await c.query(
      `UPDATE users SET is_active = COALESCE($2, is_active), full_name = COALESCE($3, full_name),
              phone = CASE WHEN $4::boolean THEN $5 ELSE phone END
        WHERE user_id = $1 RETURNING user_id, email, full_name, role_code, is_active`,
      [id, req.valid.isActive ?? null, req.valid.fullName ?? null, 'phone' in req.body, req.valid.phone ?? null])).rows[0];
  });
  const action = req.valid.isActive === false ? 'USER_DEACTIVATED' : req.valid.isActive === true ? 'USER_ACTIVATED' : 'USER_UPDATED';
  await logActivity(req, action, { type: 'user', id }, 'SUCCESS', req.valid);
  ok(res, u);
});

// Role assignment. Audited twice: user_role_changes (database trigger) + activity log (with the reason).
// Beekeeper accounts own a producer profile and supply-chain records, so they cannot be converted.
r.patch('/admin/users/:userId/role', validateBody(z.object({
  role: z.enum(ALL_ROLES),
  orgId: z.number().int().positive().nullable().optional(),
  reason: text(500, 5),
})), async (req, res) => {
  const id = Number(req.params.userId);
  const v = req.valid;
  if (id === req.user.id) throw conflict('SELF_ROLE_CHANGE', 'You cannot change your own role');
  const result = await withTransaction(req.user.id, async (c) => {
    const cur = (await c.query('SELECT user_id, role_code, org_id FROM users WHERE user_id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('User');
    if (cur.role_code === 'BEEKEEPER' || v.role === 'BEEKEEPER') {
      throw conflict('BEEKEEPER_ROLE_FIXED', 'Beekeeper accounts own hives and harvests; create a separate account instead of converting roles');
    }
    if (cur.role_code === 'ADMIN' && v.role !== 'ADMIN') await assertNotLastAdmin(c, id);
    const needsOrg = Boolean(ORG_TYPE_FOR_ROLE[v.role]);
    if (needsOrg && !v.orgId) throw unprocessable('VALIDATION_ERROR', `${v.role} needs an organization of type ${ORG_TYPE_FOR_ROLE[v.role]}`);
    const row = (await c.query(
      'UPDATE users SET role_code = $2, org_id = $3 WHERE user_id = $1 RETURNING user_id, email, full_name, role_code, org_id',
      [id, v.role, needsOrg ? v.orgId : null])).rows[0];
    return { before: { role: cur.role_code, orgId: cur.org_id }, after: { role: row.role_code, orgId: row.org_id }, user: row };
  });
  await logActivity(req, 'USER_ROLE_CHANGED', { type: 'user', id }, 'SUCCESS', { from: result.before, to: result.after, reason: v.reason });
  ok(res, result);
});

r.get('/admin/role-changes', async (_req, res) => {
  const { rows } = await query(
    `SELECT c.*, u.email, u.full_name, cb.full_name AS changed_by_name, oo.name AS old_org_name, nw.name AS new_org_name
       FROM user_role_changes c JOIN users u ON u.user_id = c.user_id LEFT JOIN users cb ON cb.user_id = c.changed_by
       LEFT JOIN organizations oo ON oo.org_id = c.old_org_id LEFT JOIN organizations nw ON nw.org_id = c.new_org_id
      ORDER BY c.change_id DESC LIMIT 100`);
  ok(res, rows);
});

// The six roles, how many users hold each, and the permission matrix (config/roles.js)
r.get('/admin/roles', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.role_code, r.display_name, r.description,
            count(u.user_id) AS users, count(u.user_id) FILTER (WHERE u.is_active) AS active_users
       FROM roles r LEFT JOIN users u ON u.role_code = r.role_code GROUP BY r.role_code ORDER BY r.role_code`);
  ok(res, {
    roles: ALL_ROLES.map((c) => ({ ...rows.find((x) => x.role_code === c), homePath: HOME_PATH[c], organizationType: ORG_TYPE_FOR_ROLE[c] ?? null })),
    permissions: PERMISSIONS.map(([key, description, roles]) => ({ key, description, roles })),
  });
});

// ---------------------------------------------------------------- settings (audited)
r.get('/admin/settings', async (_req, res) => {
  const [rows, history] = await Promise.all([
    query(`SELECT s.*, u.full_name AS updated_by_name FROM app_settings s LEFT JOIN users u ON u.user_id = s.updated_by ORDER BY s.setting_key`),
    query(`SELECT h.*, u.full_name AS changed_by_name FROM app_settings_history h LEFT JOIN users u ON u.user_id = h.changed_by ORDER BY h.history_id DESC LIMIT 50`),
  ]);
  ok(res, {
    settings: rows.rows,
    history: history.rows,
    standardsProfiles: listStandardsProfiles(),
    system: { // read-only, from .env (secrets are never returned)
      chainNetwork: env.CHAIN_NETWORK, publicBaseUrl: env.PUBLIC_BASE_URL, anomalyMinRecords: env.ANOMALY_MIN_RECORDS,
      loginRateLimit: env.LOGIN_RATE_LIMIT, publicReverifyMinutes: env.PUBLIC_REVERIFY_MINUTES, sessionLifetime: env.JWT_EXPIRES_IN,
      cookieSecure: env.COOKIE_SECURE,
    },
  });
});

const SETTING_SCHEMAS = {
  standards_profile: z.enum(listStandardsProfiles().map((p) => p.key)),
  max_processing_loss_pct: z.number().min(0).max(100),
  consumer_registration_enabled: z.boolean(),
  lab_failed_standard_policy: z.enum(['FLAG_FOR_REVIEW', 'BLOCK_PASS']),
};
r.patch('/admin/settings/:key', validateBody(z.object({ value: z.unknown() })), async (req, res) => {
  const schema = SETTING_SCHEMAS[req.params.key];
  if (!schema) throw notFound('Setting');
  const parsed = schema.safeParse(req.body.value);
  if (!parsed.success) throw unprocessable('VALIDATION_ERROR', parsed.error.issues[0].message);
  const row = await withTransaction(req.user.id, async (c) => (await c.query(
    'UPDATE app_settings SET value = $2 WHERE setting_key = $1 RETURNING *', [req.params.key, JSON.stringify(parsed.data)])).rows[0]);
  invalidateSettings();
  await logActivity(req, 'SETTING_CHANGED', { type: 'setting', id: req.params.key }, 'SUCCESS', { value: parsed.data });
  ok(res, row);
});

// ---------------------------------------------------------------- security events (from the audit log)
r.get('/admin/security-events', validateQuery(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) })), async (req, res) => {
  const since = new Date(Date.now() - req.validQuery.days * 86400000);
  const col = await collection('activity_logs');
  const recent = await col.find({ at: { $gte: since }, action: { $in: ['ACCESS_DENIED', 'LOGIN_FAILED'] } }).sort({ at: -1 }).limit(500).toArray();
  const counts = { ACCESS_DENIED: 0, LOGIN_FAILED: 0 };
  const byIp = new Map();
  const byUser = new Map();
  for (const d of recent) {
    counts[d.action] = (counts[d.action] ?? 0) + 1;
    if (d.ip) byIp.set(d.ip, (byIp.get(d.ip) ?? 0) + 1);
    if (d.actor?.userId) byUser.set(d.actor.userId, (byUser.get(d.actor.userId) ?? 0) + 1);
  }
  ok(res, {
    since, counts,
    topIps: [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, n]) => ({ ip, n })),
    topUsers: [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([userId, n]) => ({ userId, n })),
    recent: recent.slice(0, 50).map((d) => ({ ...d, _id: String(d._id) })),
  });
});

// ---------------------------------------------------------------- quantity reconciliation report
r.get('/admin/reports/reconciliation', async (_req, res) => {
  const { rows } = await query(
    `SELECT b.batch_code, b.status, b.is_demo, h.harvest_code, h.quantity_kg AS harvest_kg,
            (SELECT sum(b2.quantity_kg) FROM batches b2 WHERE b2.harvest_id = h.harvest_id) AS harvest_allocated_kg,
            b.quantity_kg AS batch_kg, p.input_quantity_kg AS processing_input_kg, p.output_quantity_kg AS processing_output_kg,
            (p.input_quantity_kg - p.output_quantity_kg) AS processing_loss_kg,
            CASE WHEN p.input_quantity_kg > 0 THEN round((p.input_quantity_kg - p.output_quantity_kg) / p.input_quantity_kg * 100, 2) END AS loss_pct,
            p.units_packed,
            COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED'), 0) AS units_shipped,
            COALESCE((SELECT sum(s.units_shipped) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status = 'DELIVERED'), 0) AS units_delivered,
            (SELECT count(*) FROM batch_transfers t WHERE t.batch_id = b.batch_id AND t.status = 'REJECTED') AS rejected_transfers,
            (SELECT count(*) FROM lab_test_requests q WHERE q.batch_id = b.batch_id AND q.status = 'REJECTED') AS rejected_lab_requests
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id LEFT JOIN processing_records p ON p.batch_id = b.batch_id
      ORDER BY b.batch_id DESC LIMIT 500`);
  ok(res, rows.map((x) => ({
    ...x,
    issues: [
      Number(x.harvest_allocated_kg) > Number(x.harvest_kg) && 'harvest over-allocated',
      x.processing_input_kg != null && Number(x.processing_input_kg) > Number(x.batch_kg) && 'processing input exceeds batch',
      x.units_packed != null && Number(x.units_shipped) > Number(x.units_packed) && 'shipped more than packed',
    ].filter(Boolean),
  })));
});

// ---------------------------------------------------------------- organizations
r.get('/admin/organizations', validateQuery(z.object({ type: z.enum(['LABORATORY', 'PROCESSOR', 'DISTRIBUTOR']).optional() })), async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, (SELECT count(*) FROM users u WHERE u.org_id = o.org_id) AS staff_count
       FROM organizations o WHERE ($1::text IS NULL OR o.org_type = $1) ORDER BY o.org_type, o.name`, [req.validQuery.type ?? null]);
  ok(res, rows);
});

r.post('/admin/organizations', validateBody(z.object({
  name: text(150), orgType: z.enum(['LABORATORY', 'PROCESSOR', 'DISTRIBUTOR']), city: text(80), state: text(80), accreditationNo: optText(60),
})), async (req, res) => {
  const v = req.valid;
  const o = await one(
    `INSERT INTO organizations (name, org_type, city, state, accreditation_no) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [v.name, v.orgType, v.city, v.state, v.accreditationNo]);
  await logActivity(req, 'ORGANIZATION_CREATED', { type: 'organization', id: o.org_id, code: o.org_code });
  created(res, o);
});

r.patch('/admin/organizations/:orgId', validateBody(z.object({ isActive: z.boolean().optional(), accreditationNo: optText(60) })), async (req, res) => {
  const o = await one(
    `UPDATE organizations SET is_active = COALESCE($2, is_active),
            accreditation_no = CASE WHEN $3::boolean THEN $4 ELSE accreditation_no END
      WHERE org_id = $1 RETURNING *`,
    [Number(req.params.orgId), req.valid.isActive ?? null, 'accreditationNo' in req.body, req.valid.accreditationNo ?? null]);
  if (!o) throw notFound('Organization');
  await logActivity(req, 'ORGANIZATION_UPDATED', { type: 'organization', id: o.org_id, code: o.org_code }, 'SUCCESS', req.valid);
  ok(res, o);
});

// ---------------------------------------------------------------- statistics (all computed live)
r.get('/admin/stats', async (_req, res) => {
  const [counts, byStatus, quantities, lab, anchors, verifs, monthly] = await Promise.all([
    one(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM beekeepers) AS beekeepers,
                (SELECT count(*) FROM hives) AS hives, (SELECT count(*) FROM harvests) AS harvests,
                (SELECT count(*) FROM batches) AS batches, (SELECT count(*) FROM lab_reports WHERE report_state='SUBMITTED') AS lab_reports,
                (SELECT count(*) FROM processing_records) AS processing_records, (SELECT count(*) FROM shipments) AS shipments,
                (SELECT count(*) FROM organizations) AS organizations, (SELECT count(*) FROM batches WHERE is_demo) AS demo_batches,
                (SELECT COALESCE(sum(scan_count),0) FROM qr_records) AS qr_scans,
                (SELECT count(*) FROM batch_transfers WHERE status = 'PENDING') AS pending_transfers,
                (SELECT count(*) FROM batch_transfers WHERE status = 'REJECTED') AS rejected_transfers,
                (SELECT count(*) FROM lab_test_requests WHERE status = 'PENDING') AS pending_lab_requests,
                (SELECT count(*) FROM lab_test_requests WHERE status = 'REJECTED') AS rejected_lab_requests,
                (SELECT count(*) FROM lab_report_corrections WHERE status = 'PENDING') AS pending_corrections,
                (SELECT count(*) FROM consumer_verifications) AS consumer_verifications,
                (SELECT count(*) FROM users WHERE NOT is_active) AS inactive_users`),
    query(`SELECT s.status_code AS status, count(b.batch_id) AS n FROM batch_statuses s LEFT JOIN batches b ON b.status = s.status_code
            GROUP BY s.status_code, s.stage_order ORDER BY s.stage_order`),
    one(`SELECT (SELECT COALESCE(sum(quantity_kg),0) FROM harvests) AS harvested_kg,
                (SELECT COALESCE(sum(quantity_kg),0) FROM batches) AS batched_kg,
                (SELECT COALESCE(sum(output_quantity_kg),0) FROM processing_records) AS processed_output_kg,
                (SELECT COALESCE(sum(units_packed),0) FROM processing_records) AS units_packed,
                (SELECT COALESCE(sum(units_shipped),0) FROM shipments WHERE status <> 'CANCELLED') AS units_shipped,
                (SELECT COALESCE(sum(units_shipped),0) FROM shipments WHERE status = 'DELIVERED') AS units_delivered`),
    query(`SELECT o.name AS lab, count(*) FILTER (WHERE lr.decision='PASS') AS pass, count(*) FILTER (WHERE lr.decision='FAIL') AS fail,
                  count(*) FILTER (WHERE lr.decision='INCONCLUSIVE') AS inconclusive
             FROM lab_reports lr JOIN organizations o ON o.org_id = lr.lab_org_id WHERE lr.report_state='SUBMITTED'
            GROUP BY o.name ORDER BY o.name`),
    query(`SELECT status, count(*) AS n FROM blockchain_anchors GROUP BY status ORDER BY status`),
    query(`SELECT result, count(*) AS n FROM verification_checks GROUP BY result ORDER BY result`),
    query(`SELECT to_char(date_trunc('month', harvest_date), 'YYYY-MM') AS month, sum(quantity_kg) AS kg, count(*) AS harvests
             FROM harvests GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
  ]);
  let anomalies = null;
  let outbox = null;
  try {
    const col = await collection('anomaly_reports');
    anomalies = {
      open: await col.countDocuments({ status: 'OPEN' }),
      bySeverity: await col.aggregate([{ $match: { status: { $in: ['OPEN', 'ACKNOWLEDGED'] } } }, { $unwind: '$ruleFindings' },
        { $group: { _id: '$ruleFindings.severity', n: { $sum: 1 } } }]).toArray(),
    };
  } catch (e) {
    anomalies = { unavailable: e.message };
  }
  outbox = (await query(`SELECT status, count(*) AS n FROM mongo_outbox GROUP BY status`)).rows;
  ok(res, {
    counts, batchesByStatus: byStatus.rows, quantities, labDecisions: lab.rows, anchorsByStatus: anchors.rows,
    verificationResults: verifs.rows, harvestsByMonth: monthly.rows.reverse(), anomalies, outbox,
  });
});

// ---------------------------------------------------------------- system-wide read lists
r.get('/admin/beekeepers', validateQuery(z.object({ ...pageQuery })), async (req, res) => {
  const q = req.validQuery;
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT bk.*, u.email, u.full_name, u.phone, u.is_active,
            (SELECT count(*) FROM hives h WHERE h.beekeeper_id = bk.beekeeper_id) AS hive_count
       FROM beekeepers bk JOIN users u ON u.user_id = bk.user_id ORDER BY bk.beekeeper_id LIMIT ${limit} OFFSET ${offset}`);
  ok(res, rows, pageMeta(q, (await one('SELECT count(*) AS n FROM beekeepers')).n));
});

r.get('/admin/activity-logs', validateQuery(z.object({ ...pageQuery, action: z.string().max(60).optional(),
  userId: z.coerce.number().int().optional(), from: isoDate.optional(), to: isoDate.optional() })), async (req, res) => {
  const q = req.validQuery;
  const filter = {};
  if (q.action) filter.action = q.action.toUpperCase();
  if (q.userId) filter['actor.userId'] = q.userId;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59Z`) } : {}) };
  const col = await collection('activity_logs');
  const { limit, offset } = paging(q);
  const docs = await col.find(filter).sort({ at: -1 }).skip(offset).limit(limit).toArray();
  ok(res, docs.map((d) => ({ ...d, _id: String(d._id) })), pageMeta(q, await col.countDocuments(filter)));
});

r.get('/admin/outbox', async (_req, res) => {
  const { rows } = await query(`SELECT outbox_id, target_collection, operation, status, attempts, last_error, next_attempt_at, created_at
                                  FROM mongo_outbox WHERE status <> 'DONE' ORDER BY outbox_id DESC LIMIT 100`);
  ok(res, rows);
});

// ---------------------------------------------------------------- blockchain
r.get('/blockchain/status', async (_req, res) => ok(res, await chainStatus()));

r.get('/admin/anchors', validateQuery(z.object({ ...pageQuery, batchCode: code.optional(),
  status: z.enum(['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED']).optional(),
  entityType: z.enum(['BATCH_ORIGIN', 'LAB_REPORT', 'PROCESSING_RECORD', 'SHIPMENT']).optional() })), async (req, res) => {
  const q = req.validQuery;
  const params = [q.batchCode ?? null, q.status ?? null, q.entityType ?? null];
  const where = `($1::text IS NULL OR batch_code = $1) AND ($2::text IS NULL OR anchor_status = $2) AND ($3::text IS NULL OR entity_type = $3)`;
  const { limit, offset } = paging(q);
  const { rows } = await query(`SELECT * FROM v_anchor_status WHERE ${where} ORDER BY anchor_id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*) AS n FROM v_anchor_status WHERE ${where}`, params)).n;
  const unanchored = (await findUnanchored()).length;
  ok(res, rows, { ...pageMeta(q, total), unanchored, chain: chainConfig().configured ? { network: chainConfig().network, contract: chainConfig().contractAddress } : null });
});

r.get('/admin/anchors/:anchorId', async (req, res) => {
  const a = await one('SELECT * FROM blockchain_anchors WHERE anchor_id = $1', [Number(req.params.anchorId)]);
  if (!a) throw notFound('Anchor');
  const checks = (await query('SELECT * FROM verification_checks WHERE anchor_id = $1 ORDER BY check_id DESC LIMIT 20', [a.anchor_id])).rows;
  ok(res, { ...a, checks });
});

// Anchor every eligible record that has no live anchor on the current contract
r.post('/admin/anchors/anchor-missing', async (req, res) => {
  if (!chainConfig().configured) throw conflict('CHAIN_NOT_CONFIGURED', `Blockchain not configured: ${chainConfig().missing.join(', ')}`);
  const todo = await findUnanchored();
  const results = [];
  for (const spec of todo) {
    try {
      const a = await withTransaction(req.user.id, (c) => createPendingAnchor(c, spec, req.user.id));
      results.push({ ...spec, queued: Boolean(a) });
    } catch (e) {
      results.push({ ...spec, queued: false, error: e.message });
    }
  }
  await processAnchorsOnce().catch(() => {});
  await logActivity(req, 'ANCHOR_MISSING_RECORDS', null, 'SUCCESS', { queued: results.filter((x) => x.queued).length, refused: results.filter((x) => !x.queued).length });
  ok(res, { queued: results.filter((x) => x.queued).length, refused: results.filter((x) => x.error) });
});

r.post('/admin/anchors/:anchorId/retry', async (req, res) => {
  const a = await one('SELECT * FROM blockchain_anchors WHERE anchor_id = $1', [Number(req.params.anchorId)]);
  if (!a) throw notFound('Anchor');
  if (a.status !== 'FAILED') throw conflict('NOT_FAILED', 'Only FAILED anchors can be retried');
  const spec = { entity_type: a.entity_type, batch_id: a.batch_id, lab_report_id: a.lab_report_id, processing_id: a.processing_id, shipment_id: a.shipment_id };
  const created2 = await withTransaction(req.user.id, (c) => createPendingAnchor(c, spec, req.user.id));
  await processAnchorsOnce().catch(() => {});
  await logActivity(req, 'ANCHOR_RETRIED', { type: 'anchor', id: a.anchor_id });
  ok(res, { newAnchorId: created2?.anchor_id ?? null });
});

r.post('/admin/anchors/process', async (req, res) => ok(res, await processAnchorsOnce()));

r.post('/admin/anchors/:anchorId/verify', async (req, res) => {
  const v = await verifyAnchor(Number(req.params.anchorId), 'ADMIN', req.user.id);
  if (!v) throw notFound('Anchor');
  await logActivity(req, 'RECORD_VERIFIED', { type: 'anchor', id: Number(req.params.anchorId) }, 'SUCCESS', { result: v.result });
  ok(res, v);
});

r.post('/admin/batches/:batchCode/verify', async (req, res) => {
  const b = await one('SELECT batch_id FROM batches WHERE batch_code = $1', [req.params.batchCode.toUpperCase()]);
  if (!b) throw notFound('Batch');
  const { rows } = await query(`SELECT anchor_id FROM blockchain_anchors WHERE batch_id = $1 AND status = 'CONFIRMED' ORDER BY anchor_id`, [b.batch_id]);
  const results = [];
  for (const a of rows) results.push(await verifyAnchor(a.anchor_id, 'ADMIN', req.user.id));
  await logActivity(req, 'BATCH_VERIFIED', { type: 'batch', id: b.batch_id, code: req.params.batchCode.toUpperCase() }, 'SUCCESS',
    { results: results.map((x) => x.result) });
  ok(res, results);
});

r.get('/admin/verifications', validateQuery(z.object({ ...pageQuery, result: z.enum(['VERIFIED', 'MISMATCH', 'NOT_FOUND_ON_CHAIN', 'CHAIN_UNAVAILABLE']).optional() })), async (req, res) => {
  const q = req.validQuery;
  const { limit, offset } = paging(q);
  const { rows } = await query(
    `SELECT v.*, a.entity_type, a.network, a.tx_hash, b.batch_code, u.full_name AS checked_by_name
       FROM verification_checks v JOIN blockchain_anchors a ON a.anchor_id = v.anchor_id JOIN batches b ON b.batch_id = a.batch_id
       LEFT JOIN users u ON u.user_id = v.checked_by
      WHERE ($1::text IS NULL OR v.result = $1) ORDER BY v.check_id DESC LIMIT ${limit} OFFSET ${offset}`, [q.result ?? null]);
  const total = (await one('SELECT count(*) AS n FROM verification_checks WHERE ($1::text IS NULL OR result = $1)', [q.result ?? null])).n;
  ok(res, rows, pageMeta(q, total));
});

// ---------------------------------------------------------------- anomalies
r.post('/admin/anomalies/scan', validateBody(z.object({ batchCode: code.optional() })), async (req, res) => {
  const result = await runAnomalyScan(req.valid.batchCode ?? null);
  await logActivity(req, 'ANOMALY_SCAN', null, 'SUCCESS', { batchCode: req.valid.batchCode ?? null, reports: result.reportsCreated, ml: result.ml.status });
  ok(res, result);
});

r.get('/admin/anomalies', validateQuery(z.object({ ...pageQuery, status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(), batchCode: code.optional() })), async (req, res) => {
  const q = req.validQuery;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.batchCode) filter.batchCode = q.batchCode;
  if (q.severity) filter['ruleFindings.severity'] = q.severity;
  const col = await collection('anomaly_reports');
  const { limit, offset } = paging(q);
  const docs = await col.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray();
  ok(res, docs.map((d) => ({ ...d, _id: String(d._id) })), pageMeta(q, await col.countDocuments(filter)));
});

r.patch('/admin/anomalies/:id', validateBody(z.object({ status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']), note: text(1000) })), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) throw notFound('Anomaly report');
  const col = await collection('anomaly_reports');
  const now = new Date();
  const r2 = await col.updateOne({ _id: id }, { $set: { status: req.valid.status, updatedAt: now, resolution: { by: req.user.id, at: now, note: req.valid.note } } });
  if (!r2.matchedCount) throw notFound('Anomaly report');
  await logActivity(req, 'ANOMALY_STATUS_CHANGED', { type: 'anomaly_report', id: String(id) }, 'SUCCESS', req.valid);
  ok(res, { id: String(id), status: req.valid.status });
});

r.delete('/admin/anomalies/:id', async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) throw notFound('Anomaly report');
  const col = await collection('anomaly_reports');
  const d = await col.findOne({ _id: id });
  if (!d) throw notFound('Anomaly report');
  if (!['RESOLVED', 'DISMISSED'].includes(d.status)) throw conflict('ANOMALY_OPEN', 'Only RESOLVED or DISMISSED reports can be deleted');
  await col.deleteOne({ _id: id });
  await logActivity(req, 'ANOMALY_REPORT_DELETED', { type: 'anomaly_report', id: String(id) });
  ok(res, { deleted: true });
});

export default r;
