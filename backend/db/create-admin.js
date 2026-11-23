// Creates an ADMIN account (there is deliberately no public API for this).
// Usage (from backend/):
//   npm run admin:create -- --email you@example.org --name "Your Name"
// The password is read from the ADMIN_PASSWORD environment variable; if it is not set, a random
// password is generated and printed ONCE. Change it after the first login (Profile > Change password).
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, one } from '../src/db/pg.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function createAdmin({ email, name, password }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Pass a valid --email');
  if (!name) throw new Error('Pass --name "Full Name"');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('Password needs 8+ characters with a letter and a digit');
  const exists = await one('SELECT user_id FROM users WHERE lower(email) = lower($1)', [email]);
  if (exists) throw new Error(`An account with ${email} already exists`);
  return one(`INSERT INTO users (email, password_hash, full_name, role_code) VALUES ($1,$2,$3,'ADMIN') RETURNING user_id, email`,
    [email.toLowerCase(), await bcrypt.hash(password, 12), name]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || `${crypto.randomBytes(9).toString('base64url')}7a`;
  createAdmin({ email: arg('email'), name: arg('name'), password })
    .then((u) => {
      console.log(`[admin] created administrator ${u.email} (user ${u.user_id})`);
      if (generated) console.log(`[admin] temporary password: ${password}   <- shown once; change it after logging in`);
    })
    .catch((e) => { console.error('[admin] ERROR:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
