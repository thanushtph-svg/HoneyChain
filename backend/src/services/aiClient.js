// HTTP client for the internal Python AI service. Failures are reported, never masked.
import { env } from '../config/env.js';

async function call(pathname, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.AI_SERVICE_KEY },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.detail ? (typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)) : `HTTP ${res.status}`;
      return { ok: false, httpStatus: res.status, error: msg };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, httpStatus: 503, error: e.name === 'AbortError' ? 'AI service timed out' : `AI service unreachable: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

export const ai = {
  health: () => call('/health', { timeoutMs: 3000 }),
  models: () => call('/models'),
  predictQuality: (features) => call('/v1/quality/predict', { method: 'POST', body: { features } }),
  predictAdulteration: (payload) => call('/v1/adulteration/predict', { method: 'POST', body: payload }),
  scoreAnomaly: (payload) => call('/v1/anomaly/score', { method: 'POST', body: payload, timeoutMs: 60000 }),
  standards: () => call('/v1/standards'),
  labAnalysis: (payload) => call('/v1/lab-analysis', { method: 'POST', body: payload, timeoutMs: 30000 }),
};

export async function aiHealth() {
  const r = await ai.health();
  return r.ok
    ? { status: 'up', detail: `models: ${Object.entries(r.data.models ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '?'}` }
    : { status: 'down', detail: r.error };
}
