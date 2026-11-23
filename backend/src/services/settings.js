// Application settings stored in PostgreSQL (app_settings). Changes are audited by a trigger
// (app_settings_history) and in the activity log. A short in-memory cache avoids a query per request.
import { query } from '../db/pg.js';

const DEFAULTS = { standards_profile: 'FSSAI', max_processing_loss_pct: 10, consumer_registration_enabled: true, lab_failed_standard_policy: 'FLAG_FOR_REVIEW' };
const TTL_MS = 30_000;
let cache = null;
let loadedAt = 0;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    const { rows } = await query('SELECT setting_key, value FROM app_settings');
    cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.setting_key, r.value])) };
  } catch {
    cache = { ...DEFAULTS };
  }
  loadedAt = Date.now();
  return cache;
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

export function invalidateSettings() {
  cache = null;
}
