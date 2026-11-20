// Smoke test: renders real pages in jsdom against a RUNNING backend (seeded demo data).
// Start backend + seed first; run with:  npx vitest run
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const BASE = process.env.API_BASE || 'http://localhost:4000';
let cookie = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const res = await realFetch(BASE + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
};
const sessions = {};
async function loginAs(email) {
  if (sessions[email]) { cookie = sessions[email]; return; }
  cookie = '';
  const r = await globalThis.fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Demo@1234' }) });
  expect(r.status).toBe(200);
  sessions[email] = cookie;
}
const errors = [];
beforeAll(() => { vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' '))); });
afterEach(() => { cleanup(); });

function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}
const noSpinners = () => expect(document.querySelectorAll('.spinner').length).toBe(0);

const PAGES = [
  ['admin@honeychain.demo', '/app', 'System overview', 'Batches by lifecycle status'],
  ['admin@honeychain.demo', '/app/admin/users', 'Users & roles', 'lab@honeychain.demo'],
  ['admin@honeychain.demo', '/app/admin/organizations', 'Organizations', 'Mysuru Honey Processing Unit (demo)'],
  ['admin@honeychain.demo', '/app/admin/records', 'System records', 'BK-00001'],
  ['admin@honeychain.demo', '/app/admin/anomalies', 'Anomalies & validation alerts', 'R07_LIMIT_VS_DECISION'],
  ['admin@honeychain.demo', '/app/admin/blockchain', 'Blockchain integrity', 'CONFIRMED'],
  ['admin@honeychain.demo', '/app/admin/logs', 'Activity logs', 'LOGIN'],
  ['admin@honeychain.demo', '/app/ai-models', 'AI models', 'Hyperspectral Imaging adulterated honey dataset'],
  ['admin@honeychain.demo', '/app/batches/HC-2026-000001', 'HC-2026-000001', 'Blockchain anchors'],
  ['lakshmi@honeychain.demo', '/app', 'Beekeeper dashboard', 'Recent batches'],
  ['lakshmi@honeychain.demo', '/app/hives', 'My hives', 'HIVE-000001'],
  ['lakshmi@honeychain.demo', '/app/harvests', 'Harvests', 'HRV-2026-000001'],
  ['lakshmi@honeychain.demo', '/app/harvests/HRV-2026-000003', 'Harvest HRV-2026-000003', 'Create batches from this harvest'],
  ['lakshmi@honeychain.demo', '/app/batches', 'Batches', 'HC-2026-000001'],
  ['lakshmi@honeychain.demo', '/app/batches/HC-2026-000002', 'HC-2026-000002', 'Send for laboratory testing'],
  ['lakshmi@honeychain.demo', '/app/profile', 'My profile', 'Change password'],
  ['lab@honeychain.demo', '/app', 'Laboratory dashboard', 'Queue'],
  ['lab@honeychain.demo', '/app/lab/queue', 'Testing queue', 'Enter results'],
  ['lab@honeychain.demo', '/app/lab/reports', 'Testing history', 'LAB-2026-000001'],
  ['lab@honeychain.demo', '/app/lab/reports/new?batch=HC-2026-000002', 'New lab report for HC-2026-000002', 'Save draft'],
  ['lab@honeychain.demo', '/app/lab/reports/LAB-2026-000004', 'Lab report LAB-2026-000004', 'Adulteration analysis'],
  ['processor@honeychain.demo', '/app', 'Processor dashboard', 'Ready for processing'],
  ['processor@honeychain.demo', '/app/processing/queue?batch=HC-2026-000005', 'Processing queue', 'Processing record for HC-2026-000005'],
  ['processor@honeychain.demo', '/app/processing', 'Processing history', 'PRC-2026-000001'],
  ['distributor@honeychain.demo', '/app', 'Distributor dashboard', 'Shipments in progress'],
  ['distributor@honeychain.demo', '/app/distribution/queue', 'Dispatch queue', 'HC-2026-000003'],
  ['distributor@honeychain.demo', '/app/shipments', 'Shipments', 'SHP-2026-000001'],
  [null, '/', 'Trace your honey from hive to shelf', 'HC-2026-000001'],
  [null, '/verify/HC-2026-000001', 'HC-2026-000001', 'Blockchain integrity'],
  [null, '/verify/HC-2026-000001', 'Multifloral honey', 'VERIFIED'],
  [null, '/verify/HC-9999-000000', 'Batch not found', 'Check the code'],
  [null, '/login', 'Sign in', 'Create an account'],
  [null, '/register', 'Beekeeper registration', 'Create account'],
];

describe('pages render with live data', () => {
  for (const [who, path, heading, content] of PAGES) {
    it(`${who ?? 'public'} ${path}`, async () => {
      if (who) await loginAs(who); else cookie = '';
      const before = errors.length;
      renderAt(path);
      await waitFor(() => expect(screen.getAllByText((t, el) => el?.textContent?.includes(heading) && el.children.length === 0 || t.includes(heading)).length).toBeGreaterThan(0), { timeout: 8000 });
      await waitFor(() => expect(document.body.textContent).toContain(content), { timeout: 8000 });
      await waitFor(noSpinners, { timeout: 8000 });
      expect(document.querySelector('.alert.error')?.textContent ?? '').toBe('');
      expect(errors.slice(before).filter((e) => !/act\(|not wrapped/.test(e))).toEqual([]);
    });
  }
});
