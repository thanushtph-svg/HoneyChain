// UI-driven lifecycle: every form is filled and submitted through the real React components
// against the running backend. Requires seeded backend (see pages.smoke.test.jsx).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const BASE = process.env.API_BASE || 'http://localhost:4000';
let cookie = '';
const sessions = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const res = await realFetch(BASE + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
};
async function as(email) {
  if (sessions[email]) { cookie = sessions[email]; return; }
  cookie = '';
  const r = await globalThis.fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Demo@1234' }) });
  expect(r.status).toBe(200);
  sessions[email] = cookie;
}
const api = async (p) => (await (await globalThis.fetch(`/api/v1${p}`)).json()).data;
vi.spyOn(window, 'confirm').mockImplementation(() => true);
afterEach(() => cleanup());
const open = (path) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const field = (label) => {
  const lab = screen.getAllByText((t, el) => el.tagName === 'LABEL' && el.textContent.trim().startsWith(label))[0];
  return lab.parentElement.querySelector('input, select, textarea');
};
const set = (label, value) => fireEvent.change(field(label), { target: { value } });
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const success = async (re) => waitFor(() => expect(document.querySelector('.alert.success')?.textContent ?? '').toMatch(re), { timeout: 10000 });
const ctx = {};

describe('full lifecycle through the UI', () => {
  it('beekeeper registers a hive', async () => {
    await as('anitha@honeychain.demo');
    open('/app/hives');
    await screen.findByText('Register a hive');
    set('Apiary location', 'UI test apiary');
    set('District', 'Kolar');
    set('Installed on', '2025-03-01');
    click('Register hive');
    await success(/Hive HIVE-\d{6} registered/);
    ctx.hive = document.querySelector('.alert.success').textContent.match(/HIVE-\d{6}/)[0];
  });

  it('beekeeper records a harvest', async () => {
    await as('anitha@honeychain.demo');
    open('/app/harvests');
    await waitFor(() => expect(field('Hive').querySelectorAll('option').length).toBeGreaterThan(1));
    set('Hive', ctx.hive);
    set('Quantity (kg)', '8.5');
    set('Floral source', 'Sunflower (UI test)');
    click('Record harvest');
    await success(/Harvest HRV-\d{4}-\d{6} recorded/);
    ctx.harvest = document.querySelector('.alert.success').textContent.match(/HRV-\d{4}-\d{6}/)[0];
  });

  it('beekeeper creates two batches and sends them to the lab', async () => {
    await as('anitha@honeychain.demo');
    open(`/app/harvests/${ctx.harvest}`);
    await screen.findByText('Create batches from this harvest');
    set('Batch 1 quantity (kg)', '5');
    fireEvent.change(screen.getAllByPlaceholderText('Sunflower (UI test)')[0], { target: { value: 'Sunflower' } });
    click('+ Add another batch');
    set('Batch 2 quantity (kg)', '3.5');
    const labSelect = field('Send to laboratory');
    await waitFor(() => expect(labSelect.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(labSelect, { target: { value: labSelect.querySelectorAll('option')[1].value } });
    click('Create batches');
    await success(/Created HC-\d{4}-\d{6}, HC-\d{4}-\d{6}/);
    ctx.batches = document.querySelector('.alert.success').textContent.match(/HC-\d{4}-\d{6}/g);
  });

  it('lab saves a draft, edits it, runs AI quality analysis and submits PASS', async () => {
    await as('lab@honeychain.demo');
    const v = open(`/app/lab/reports/new?batch=${ctx.batches[0]}`);
    await screen.findByText(`New lab report for ${ctx.batches[0]}`);
    set('Sample code', `UI-${Date.now()}`);
    set('Moisture (%)', '18.1'); set('HMF (mg/kg)', '12.5'); set('Sucrose (g/100 g)', '2.2');
    set('Pollen identification', 'Helianthus pollen predominant');
    click('Save draft');
    await screen.findByText(/Lab report LAB-\d{4}-\d{6}/, {}, { timeout: 10000 });
    set('pH', '3.95');
    click('Update draft');
    await success(/Draft updated/);
    click('Run quality analysis');
    await screen.findAllByText('Rule-based standards screening', {}, { timeout: 10000 });
    expect(document.body.textContent).toContain('validated labelled dataset required');
    set('Remarks', 'Within FSSAI limits (UI test)');
    click('Submit decision');
    await screen.findByText(/submitted on/, {}, { timeout: 10000 });
    ctx.report = document.body.textContent.match(/Lab report (LAB-\d{4}-\d{6})/)[1];
    v.unmount();
    const b = await api(`/batches/${ctx.batches[0]}`);
    expect(b.batch.status).toBe('LAB_PASSED');
  });

  it('processor records processing and packaging', async () => {
    await as('processor@honeychain.demo');
    open(`/app/processing/queue?batch=${ctx.batches[0]}`);
    await screen.findByText(`Processing record for ${ctx.batches[0]}`, {}, { timeout: 10000 });
    set('Operator name', 'UI Operator');
    set('Output quantity (kg)', '4.9');
    set('Units packed', '9');
    set('Best before', '2028-12-31');
    click('Save processing record');
    await success(/Recorded PRC-\d{4}-\d{6}/);
  });

  it('distributor dispatches all units and marks them delivered', async () => {
    await as('distributor@honeychain.demo');
    open(`/app/distribution/queue?batch=${ctx.batches[0]}`);
    await screen.findByText(new RegExp(`Dispatch ${ctx.batches[0]}`), {}, { timeout: 10000 });
    set('Destination name', 'UI Test Store');
    set('City', 'Kolar');
    click('Record dispatch');
    await success(/Shipment SHP-\d{4}-\d{6} dispatched/);
    const code = document.querySelector('.alert.success').textContent.match(/SHP-\d{4}-\d{6}/)[0];
    cleanup();
    open('/app/shipments');
    const cell = await screen.findByText(code, {}, { timeout: 10000 });
    fireEvent.click(within(cell.closest('tr')).getByRole('button', { name: 'Delivered today' }));
    await success(/batch fully delivered/);
  });

  it('consumer page shows the full journey for the new batch', async () => {
    cookie = '';
    open(`/verify/${ctx.batches[0]}`);
    await screen.findByText('Helianthus pollen predominant', {}, { timeout: 10000 });
    expect(document.body.textContent).toContain('Shipped to retailer in Kolar');
    expect(document.body.textContent).toContain('DELIVERED');
    expect(document.body.textContent).not.toContain('UI Operator'); // operator name is private
  });
});
