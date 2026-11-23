// Authentication (JWT in an httpOnly cookie) and server-side role authorization.
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { one } from '../db/pg.js';
import { ApiError, forbidden } from '../utils/errors.js';
import { logActivity } from '../services/activityLog.js';
import { HOME_PATH } from '../config/roles.js';

export const COOKIE_NAME = 'hc_session';

export function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user.user_id), role: user.role_code }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE,
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

async function loadUser(userId) {
  return one(
    `SELECT u.user_id, u.email, u.full_name, u.role_code, u.org_id, u.is_active,
            o.name AS org_name, o.org_code, o.org_type, b.beekeeper_id
       FROM users u
       LEFT JOIN organizations o ON o.org_id = u.org_id
       LEFT JOIN beekeepers b    ON b.user_id = u.user_id
      WHERE u.user_id = $1`,
    [userId],
  );
}

export function toPublicUser(u) {
  return {
    id: u.user_id,
    email: u.email,
    fullName: u.full_name,
    role: u.role_code,
    organization: u.org_id ? { id: u.org_id, code: u.org_code, name: u.org_name, type: u.org_type } : null,
    beekeeperId: u.beekeeper_id ?? null,
    homePath: HOME_PATH[u.role_code] ?? '/',
  };
}

/** Requires a valid session; reloads the user so deactivation/role changes apply immediately. */
export async function requireAuth(req, _res, next) {
  if (req.user) return next(); // already authenticated by an earlier router
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Session expired, please log in again'));
  }
  const u = await loadUser(Number(payload.sub));
  if (!u || !u.is_active) return next(new ApiError(401, 'UNAUTHENTICATED', 'Account not active'));
  req.user = { ...toPublicUser(u), orgId: u.org_id };
  next();
}

/** Like requireAuth but never fails: sets req.user when a valid session exists (public pages). */
export async function optionalAuth(req, _res, next) {
  if (req.user) return next();
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    const u = await loadUser(Number(payload.sub));
    if (u && u.is_active) req.user = { ...toPublicUser(u), orgId: u.org_id };
  } catch {
    /* anonymous visitor */
  }
  next();
}

/** requireRole('ADMIN', 'LAB_TESTER') - must come after requireAuth. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
    if (!roles.includes(req.user.role)) {
      logActivity(req, 'ACCESS_DENIED', { type: 'route', id: req.originalUrl }, 'DENIED', { required: roles });
      return next(forbidden());
    }
    next();
  };
}
