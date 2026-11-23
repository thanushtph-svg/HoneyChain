// Smoke test of the six role-based views: renders real pages in jsdom against a RUNNING backend
// with the seeded demo data. For every role: correct dashboard, ONLY that role's navigation, every
// navigation page renders without errors, and other roles' URLs are refused.
// Start backend + seed first; run with:  npx vitest run   (API_BASE=http://localhost:4000 by default)
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { ROLES } from '../src/roles.js';

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
const navLabels = () => [...document.querySelectorAll('aside .nav')][0] ? [...[...document.querySelectorAll('aside .nav')][0].querySelectorAll('a')].map((a) => a.textContent) : [];

const USERS = {
  BEEKEEPER: 'lakshmi@honeychain.demo',
  PROCESSOR: 'processor@honeychain.demo',
  LAB_TESTER: 'lab@honeychain.demo',
  DISTRIBUTOR: 'distributor@honeychain.demo',
  ADMIN: 'admin@honeychain.demo',
  CONSUMER: 'consumer@honeychain.demo',
};
const DASHBOARD = {
  BEEKEEPER: 'Beekeeper dashboard', PROCESSOR: 'Processor dashboard', LAB_TESTER: 'Lab Tester dashboard',
  DISTRIBUTOR: 'Distributor dashboard', ADMIN: 'Admin dashboard', CONSUMER: 'Product verification',
};

async function expectRendered(heading, content) {
  await waitFor(() => expect(document.body.textContent).toContain(heading), { timeout: 10000 });
  if (content) await waitFor(() => expect(document.body.textContent).toContain(content), { timeout: 10000 });
  await waitFor(noSpinners, { timeout: 10000 });
}

describe('six role views: own dashboard and ONLY own navigation', () => {
  for (const [role, cfg] of Object.entries(ROLES)) {
    it(`${role}: dashboard + sidebar`, async () => {
      await loginAs(USERS[role]);
      renderAt(cfg.base);
      await expectRendered(DASHBOARD[role]);
      expect(navLabels()).toEqual(cfg.nav.map(([label]) => label));
      expect(document.querySelector('.role-chip').textContent).toBe(`${cfg.label} view`);
    });
  }
});

describe('every navigation page of every role renders with live data', () => {
  for (const [role, cfg] of Object.entries(ROLES)) {
    for (const [label, sub] of cfg.nav) {
      it(`${role} → ${label}`, async () => {
        await loginAs(USERS[role]);
        const before = errors.length;
        renderAt(sub ? `${cfg.base}/${sub}` : cfg.base);
        await waitFor(() => expect(document.querySelector('.page-head h1')).not.toBeNull(), { timeout: 10000 });
        await waitFor(noSpinners, { timeout: 10000 });
        expect(document.querySelector('.alert.error')?.textContent ?? '').toBe('');
        expect(errors.slice(before).filter((e) => !/act\(|not wrapped/.test(e))).toEqual([]);
      });
    }
  }
});

describe('a role cannot open another role\'s view (403), anonymous users are sent to login', () => {
  const others = Object.keys(ROLES);
  for (const role of others) {
    it(`${role} is refused in every other view`, async () => {
      await loginAs(USERS[role]);
      for (const other of others.filter((r) => r !== role)) {
        renderAt(`${ROLES[other].base}/${ROLES[other].nav[1]?.[1] ?? ''}`);
        await screen.findByText('Access denied (403)');
        expect(document.querySelector('aside')).toBeNull(); // no other role's navigation is shown
        cleanup();
      }
    });
  }
  it('anonymous visitor opening /admin/users sees the login page', async () => {
    cookie = '';
    renderAt('/admin/users');
    await screen.findByRole('heading', { name: 'Sign in' });
  });
});

const PAGES = [
  ['BEEKEEPER', '/beekeeper/batches/HC-2026-000002', 'HC-2026-000002', 'Transfer to a processor'],
  ['BEEKEEPER', '/beekeeper/batches/HC-2026-000008', 'HC-2026-000008', 'Containers not sealed on arrival'],
  ['BEEKEEPER', '/beekeeper/harvests/HRV-2026-000003', 'Harvest HRV-2026-000003', 'Create batches from this harvest'],
  ['BEEKEEPER', '/beekeeper/qr-codes', 'QR codes', 'HC-2026-000001'],
  ['PROCESSOR', '/processor/incoming', 'Incoming batches', 'HC-2026-000007'],
  ['PROCESSOR', '/processor/batches/HC-2026-000007', 'HC-2026-000007', 'Incoming transfer'],
  ['PROCESSOR', '/processor/processed', 'Processed batches', 'HC-2026-000010'],
  ['PROCESSOR', '/processor/transfers', 'Transfers', 'HC-2026-000005'],
  ['LAB_TESTER', '/lab/requests', 'Testing requests', 'HC-2026-000010'],
  ['LAB_TESTER', '/lab/pending', 'Pending tests', 'HC-2026-000006'],
  ['LAB_TESTER', '/lab/submit', 'Submit results', 'LAB-2026-000004'],
  ['LAB_TESTER', '/lab/reports/LAB-2026-000004', 'Lab report LAB-2026-000004', 'Standards-Based Laboratory Compliance Check'],
  ['LAB_TESTER', '/lab/reports/new?batch=HC-2026-000006', 'New lab report for HC-2026-000006', 'Submit Lab Report'],
  ['LAB_TESTER', '/lab/history', 'Testing history', 'Sample jar arrived broken'],
  ['DISTRIBUTOR', '/distributor/incoming', 'Incoming batches', 'Recently answered'],
  ['DISTRIBUTOR', '/distributor/distribution', 'Distribution', 'HC-2026-000003'],
  ['DISTRIBUTOR', '/distributor/delivery', 'Delivery status', 'SHP-2026-000003'],
  ['DISTRIBUTOR', '/distributor/batches/HC-2026-000001', 'HC-2026-000001', 'Custody transfers'],
  ['ADMIN', '/admin/users', 'User management', 'lab@honeychain.demo'],
  ['ADMIN', '/admin/roles', 'Role management', 'Permission matrix'],
  ['ADMIN', '/admin/laboratory', 'Laboratory monitoring', 'HMF transcription error'],
  ['ADMIN', '/admin/settings', 'Settings', 'Codex Alimentarius'],
  ['ADMIN', '/admin/reports', 'Reports', 'Quantities are consistent'],
  ['ADMIN', '/admin/anomalies', 'Anomalies', 'Run scan now'], // R07 (PASS above a limit) can no longer occur: lab outcomes are automatic
  ['ADMIN', '/admin/blockchain', 'Blockchain integrity', 'CONFIRMED'],
  ['ADMIN', '/admin/audit-logs', 'Activity logs', 'LOGIN'],
  ['ADMIN', '/admin/batches/HC-2026-000001', 'HC-2026-000001', 'Blockchain anchors'],
  ['ADMIN', '/admin/ai-models', 'AI models', 'Hyperspectral Imaging adulterated honey dataset'],
  ['CONSUMER', '/consumer/verify/HC-2026-000001', 'HC-2026-000001', 'Saved to your verification history'],
  ['CONSUMER', '/consumer/history', 'Verification history', 'HC-2026-000001'],
  [null, '/', 'Trace your honey from hive to shelf', 'HC-2026-000001'],
  [null, '/verify', 'Verify your honey', 'Scan with camera'],
  [null, '/verify/HC-2026-000001', 'Multifloral honey', 'Records verified against the blockchain'],
  [null, '/verify/HC-2026-000002', 'HC-2026-000002', 'No laboratory result has been published'],
  [null, '/verify/HC-9999-000000', 'Batch not found', 'cannot be verified'],
  [null, '/login', 'Sign in', 'Create a producer account'],
  [null, '/register', 'Beekeeper registration', 'Create account'],
  [null, '/register?type=consumer', 'Consumer account', 'Verify without an account'],
];

describe('detail pages render with live data', () => {
  for (const [role, path, heading, content] of PAGES) {
    it(`${role ?? 'public'} ${path}`, async () => {
      if (role) await loginAs(USERS[role]); else cookie = '';
      const before = errors.length;
      renderAt(path);
      await expectRendered(heading, content);
      expect(document.querySelector('.alert.error')?.textContent ?? '').toBe(path.includes('9999') ? document.querySelector('.alert.error').textContent : '');
      expect(errors.slice(before).filter((e) => !/act\(|not wrapped/.test(e))).toEqual([]);
    });
  }
});
