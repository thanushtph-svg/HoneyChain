import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, withTransaction, query } from '../db/pg.js';
import { requireAuth, issueSession, clearSession, toPublicUser } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../utils/errors.js';
import { ok, created, text, optText } from '../utils/http.js';
import { logActivity } from '../services/activityLog.js';
import { env, isTest } from '../config/env.js';

const r = Router();

export const passwordRule = z
  .string()
  .min(8, 'At least 8 characters')
  .max(72)
  .regex(/[A-Za-z]/, 'Must contain a letter')
  .regex(/\d/, 'Must contain a digit');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 1000 : env.LOGIN_RATE_LIMIT, standardHeaders: true, legacyHeaders: false });

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: passwordRule,
  fullName: text(120),
  phone: optText(20),
  publicDisplayName: text(120),
  showNamePublicly: z.boolean().default(false),
  cooperativeName: optText(150),
  village: optText(80),
  district: text(80),
  state: text(80),
  registrationNo: optText(60),
});

r.post('/register-beekeeper', loginLimiter, validateBody(registerSchema), async (req, res) => {
  const v = req.valid;
  const hash = await bcrypt.hash(v.password, 12);
  const user = await withTransaction(null, async (c) => {
    const u = (await c.query(
      `INSERT INTO users (email, password_hash, full_name, phone, role_code)
       VALUES ($1, $2, $3, $4, 'BEEKEEPER') RETURNING user_id`,
      [v.email, hash, v.fullName, v.phone],
    )).rows[0];
    await c.query(
      `INSERT INTO beekeepers (user_id, public_display_name, show_name_publicly, cooperative_name, village, district, state, registration_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [u.user_id, v.publicDisplayName, v.showNamePublicly, v.cooperativeName, v.village, v.district, v.state, v.registrationNo],
    );
    return u;
  });
  const full = await loadForSession(user.user_id);
  issueSession(res, full);
  req.user = toPublicUser(full);
  await logActivity(req, 'BEEKEEPER_REGISTERED', { type: 'user', id: full.user_id });
  created(res, { user: toPublicUser(full) });
});

async function loadForSession(userId) {
  return one(
    `SELECT u.*, o.name AS org_name, o.org_code, o.org_type, b.beekeeper_id
       FROM users u LEFT JOIN organizations o ON o.org_id = u.org_id
       LEFT JOIN beekeepers b ON b.user_id = u.user_id WHERE u.user_id = $1`,
    [userId],
  );
}

r.post(
  '/login',
  loginLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) })),
  async (req, res) => {
    const { email, password } = req.valid;
    const u = await one(
      `SELECT u.*, o.name AS org_name, o.org_code, o.org_type, b.beekeeper_id
         FROM users u LEFT JOIN organizations o ON o.org_id = u.org_id
         LEFT JOIN beekeepers b ON b.user_id = u.user_id
        WHERE lower(u.email) = $1`,
      [email],
    );
    // Same message for unknown email and wrong password (don't reveal which accounts exist)
    const valid = u && u.is_active && (await bcrypt.compare(password, u.password_hash));
    if (!valid) {
      await logActivity(req, 'LOGIN_FAILED', null, 'FAILED', { email });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    await query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [u.user_id]);
    issueSession(res, u);
    req.user = toPublicUser(u);
    await logActivity(req, 'LOGIN', { type: 'user', id: u.user_id });
    ok(res, { user: toPublicUser(u) });
  },
);

r.post('/logout', (req, res) => {
  clearSession(res);
  ok(res, { loggedOut: true });
});

r.get('/me', requireAuth, (req, res) => ok(res, { user: req.user }));

r.post(
  '/change-password',
  requireAuth,
  validateBody(z.object({ currentPassword: z.string().min(1), newPassword: passwordRule })),
  async (req, res) => {
    const u = await one('SELECT password_hash FROM users WHERE user_id = $1', [req.user.id]);
    if (!(await bcrypt.compare(req.valid.currentPassword, u.password_hash))) {
      throw new ApiError(422, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    await query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [req.user.id, await bcrypt.hash(req.valid.newPassword, 12)]);
    await logActivity(req, 'PASSWORD_CHANGED', { type: 'user', id: req.user.id });
    ok(res, { changed: true });
  },
);

export default r;
