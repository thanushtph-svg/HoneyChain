// UI-driven end-to-end workflow through the real React components of each role's own view,
// against the running seeded backend (see pages.smoke.test.jsx):
//   beekeeper: hive -> harvest -> split into 2 batches -> transfer both to the processor
//   processor: reject one (with reason), accept the other -> record processing -> request lab testing
//   lab tester: accept request -> Submit Lab Report (automatic analysis) -> review -> submit PASS
//   processor: transfer to distributor;  distributor: accept -> dispatch -> delivered
//   consumer: QR page shows the full journey;  beekeeper sees the rejection reason
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
/** Read through another user's session, then restore the current one */
const apiAs = async (email, p) => { const keep = cookie; await as(email); const d = await api(p); cookie = keep; return d; };
vi.spyOn(window, 'confirm').mockImplementation(() => true);
afterEach(() => cleanup());
const open = (path) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const field = (label, root = document) => {
  const lab = within(root).getAllByText((t, el) => el.tagName === 'LABEL' && el.textContent.trim().startsWith(label))[0];
  return lab.parentElement.querySelector('input, select, textarea');
};
const set = (label, value, root) => fireEvent.change(field(label, root), { target: { value } });
const click = (name, root = document.body) => fireEvent.click(within(root).getByRole('button', { name }));
const success = async (re) => waitFor(() => expect(document.querySelector('.alert.success')?.textContent ?? '').toMatch(re), { timeout: 10000 });
const chooseOrg = async (root, nameRe) => {
  const sel = field('Organization', root);
  await waitFor(() => expect(sel.querySelectorAll('option').length).toBeGreaterThan(1), { timeout: 10000 });
  const opt = [...sel.querySelectorAll('option')].find((o) => nameRe.test(o.textContent));
  fireEvent.change(sel, { target: { value: opt.value } });
};
const card = (title) => screen.getByText(title, { selector: 'h2' }).closest('section');
const rowOf = async (text, root = document.body) => (await within(root).findByText(text, {}, { timeout: 10000 })).closest('tr');
const pendingCard = () => screen.findByText('Waiting for your response').then((h) => h.closest('section'));
const ctx = {};

describe('complete beekeeper -> consumer workflow through the six views', () => {
  it('beekeeper registers a hive', async () => {
    await as('anitha@honeychain.demo');
    open('/beekeeper/hives');
    await screen.findByText('Register a hive');
    set('Apiary location', 'UI test apiary (demo)');
    set('District', 'Kolar');
    set('Installed on', '2025-03-01');
    click('Register hive');
    await success(/Hive HIVE-\d{6} registered/);
    ctx.hive = document.querySelector('.alert.success').textContent.match(/HIVE-\d{6}/)[0];
  });

  it('beekeeper records a harvest', async () => {
    await as('anitha@honeychain.demo');
    open('/beekeeper/harvests');
    await waitFor(() => expect(field('Hive').querySelectorAll('option').length).toBeGreaterThan(1));
    set('Hive', ctx.hive);
    set('Quantity (kg)', '8.5');
    set('Floral source', 'Sunflower (UI test)');
    click('Record harvest');
    await success(/Harvest HRV-\d{4}-\d{6} recorded/);
    ctx.harvest = document.querySelector('.alert.success').textContent.match(/HRV-\d{4}-\d{6}/)[0];
  });

  it('beekeeper splits the harvest into two batches', async () => {
    await as('anitha@honeychain.demo');
    open(`/beekeeper/harvests/${ctx.harvest}`);
    await screen.findByText('Create batches from this harvest');
    expect(document.body.textContent).not.toContain('Send to laboratory'); // the beekeeper no longer assigns a lab
    set('Batch 1 quantity (kg)', '5');
    fireEvent.change(screen.getAllByPlaceholderText('Sunflower (UI test)')[0], { target: { value: 'Sunflower' } });
    click('+ Add another batch');
    set('Batch 2 quantity (kg)', '3.5');
    click('Create batches');
    await success(/Created HC-\d{4}-\d{6}, HC-\d{4}-\d{6}/);
    ctx.batches = document.querySelector('.alert.success').textContent.match(/HC-\d{4}-\d{6}/g);
  });

  it('beekeeper transfers both batches to the processor', async () => {
    await as('anitha@honeychain.demo');
    for (const b of ctx.batches) {
      open(`/beekeeper/batches/${b}`);
      await screen.findByText('Transfer to a processor', {}, { timeout: 10000 });
      const panel = card('Transfer to a processor');
      await chooseOrg(panel, /Mysuru/);
      click('Send batch', panel);
      await screen.findByText(/Waiting for/, {}, { timeout: 10000 });
      cleanup();
    }
    expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('PENDING_PROCESSOR');
  });

  it('processor rejects one batch with a reason and accepts the other', async () => {
    await as('processor@honeychain.demo');
    open('/processor/incoming');
    const rej = await rowOf(ctx.batches[1], await pendingCard());
    click('Reject', rej);
    fireEvent.change(within(rej).getByRole('textbox', { name: 'Reject' }), { target: { value: 'Moisture visibly high on arrival (UI test)' } });
    click('Confirm: Reject', rej);
    // after a rejection the processor no longer has access; the beekeeper has the batch back
    await waitFor(async () => expect((await apiAs('anitha@honeychain.demo', `/batches/${ctx.batches[1]}`)).batch.status).toBe('CREATED'), { timeout: 10000 });
    expect((await globalThis.fetch(`/api/v1/batches/${ctx.batches[1]}`)).status).toBe(404);
    cleanup();
    open('/processor/incoming');
    click('Accept', await rowOf(ctx.batches[0], await pendingCard()));
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('IN_PROCESSING'), { timeout: 10000 });
  });

  it('processor saves several processing methods as steps, then finalizes explicitly (with a quantity loss)', async () => {
    await as('processor@honeychain.demo');
    open(`/processor/processing?batch=${ctx.batches[0]}`);
    await screen.findByText(/Choose every method you applied/, {}, { timeout: 10000 });
    // all six existing methods are visible at once
    for (const m of ['Filtration', 'Straining', 'Settling', 'Gentle warming', 'Creaming', 'Other']) {
      expect(screen.getByRole('button', { name: `Add ${m} step` })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Finalize Processing' }).disabled).toBe(true); // nothing saved yet
    click('Add Filtration step');
    expect(screen.getByRole('button', { name: 'Add Settling step' })).toBeTruthy(); // other methods stay visible
    set('Filter mesh size *', '200');
    click('Save Filtration step');
    await success(/Saved step 1: Filtration/);
    click('Add Settling step');
    set('Settling time *', '24');
    click('Save Settling step');
    await success(/Saved step 2: Settling/);
    // saving steps did not finalize
    expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('IN_PROCESSING');
    const steps = (await api(`/processing/batches/${ctx.batches[0]}/steps`)).steps.map((s) => s.method);
    expect(steps).toEqual(['FILTRATION', 'SETTLING']);
    set('Operator name *', 'UI Operator');
    set('Output quantity *', '4.9');
    await screen.findByText(/Processing loss: 0.10 kg/);
    set('Units packed *', '9');
    set('Best before *', '2028-12-31');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finalize Processing' }).disabled).toBe(false));
    click('Finalize Processing');
    await success(/Finalized PRC-\d{4}-\d{6} .*loss 0.10 kg/);
    expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('PROCESSED');
  });

  it('processor requests laboratory testing', async () => {
    await as('processor@honeychain.demo');
    open('/processor/processed');
    const needs = (await screen.findByText('Needs a testing request')).closest('section');
    fireEvent.click(await within(needs).findByRole('button', { name: ctx.batches[0] }, { timeout: 10000 }));
    const panel = (await screen.findByText(`Request testing for ${ctx.batches[0]}`)).closest('section');
    await chooseOrg(panel, /Bengaluru Honey Testing/);
    click('Send testing request', panel);
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('PENDING_LAB'), { timeout: 10000 });
  });

  it('lab tester accepts the request, enters measurements only; the system assigns PASS automatically', async () => {
    await as('lab@honeychain.demo');
    const r = open('/lab/requests');
    click('Accept', await rowOf(ctx.batches[0], await pendingCard()));
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('IN_TESTING'), { timeout: 10000 });
    r.unmount();
    open('/lab/pending');
    fireEvent.click(within(await rowOf(ctx.batches[0])).getByRole('link', { name: 'Enter results' }));
    await screen.findByText(`New lab report for ${ctx.batches[0]}`, {}, { timeout: 10000 });
    set('Sample code', `UI-${Date.now()}`);
    set('Moisture (%)', '18.1'); set('HMF (mg/kg)', '12.5'); set('Sucrose (g/100 g)', '2.2');
    set('Glucose (g/100 g)', '31.0'); set('Fructose (g/100 g)', '38.4'); set('Free acidity (meq/kg)', '22'); set('Electrical conductivity (mS/cm)', '0.41');
    set('Pollen identification', 'Helianthus pollen predominant');
    // no manual decision controls, no document upload
    expect(screen.queryByRole('button', { name: /Submit decision/ })).toBeNull();
    expect(screen.queryByText('Reports & supporting documents')).toBeNull();
    // one action: validate + save + automatic analysis + automatic outcome
    click('Submit Lab Report');
    await screen.findByText(/Lab report LAB-\d{4}-\d{6}/, {}, { timeout: 15000 });
    await screen.findAllByText(/Standards-Based Laboratory Compliance Check/, {}, { timeout: 15000 });
    await screen.findByText('Laboratory outcome (assigned automatically)', {}, { timeout: 15000 });
    expect(document.body.textContent).toContain('ALL PASSED');
    expect(document.body.textContent).not.toContain('ML analysis (Random Forest)'); // untrained model is not shown
    expect(screen.queryByRole('button', { name: /Run quality analysis|Run adulteration model|Submit decision/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Decision/ })).toBeNull();
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('LAB_PASSED'), { timeout: 10000 });
  });

  it('processor transfers the lab-passed batch to the distributor', async () => {
    await as('processor@honeychain.demo');
    open('/processor/transfers');
    const ready = (await screen.findByText('Ready for a distributor (lab passed)')).closest('section');
    fireEvent.click(await within(ready).findByRole('button', { name: new RegExp(ctx.batches[0]) }, { timeout: 10000 }));
    const panel = (await screen.findByText(`Transfer ${ctx.batches[0]} to a distributor`)).closest('section');
    await chooseOrg(panel, /Karnataka Agri Logistics/);
    click('Send batch', panel);
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('PENDING_DISTRIBUTOR'), { timeout: 10000 });
  });

  it('distributor accepts, dispatches all units and marks them delivered', async () => {
    await as('distributor@honeychain.demo');
    let v = open('/distributor/incoming');
    click('Accept', await rowOf(ctx.batches[0], await pendingCard()));
    await waitFor(async () => expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('IN_DISTRIBUTION'), { timeout: 10000 });
    v.unmount();
    open(`/distributor/distribution?batch=${ctx.batches[0]}`);
    await screen.findByText(new RegExp(`Dispatch ${ctx.batches[0]}`), {}, { timeout: 10000 });
    set('Recipient / destination name', 'UI Test Store');
    set('City', 'Kolar');
    click('Record dispatch');
    await success(/Shipment SHP-\d{4}-\d{6} dispatched/);
    const code = document.querySelector('.alert.success').textContent.match(/SHP-\d{4}-\d{6}/)[0];
    cleanup();
    v = open('/distributor/delivery');
    click('Delivered', await rowOf(code));
    await success(/every unit of the batch is now delivered/);
    expect((await api(`/batches/${ctx.batches[0]}`)).batch.status).toBe('DELIVERED');
  });

  it('consumer (no account) sees the full journey; private data is not shown', async () => {
    cookie = '';
    open(`/verify/${ctx.batches[0]}`);
    await screen.findByText('Helianthus pollen predominant', {}, { timeout: 15000 });
    const text = document.body.textContent;
    expect(text).toContain('Received by processor');
    expect(text).toContain('Received by distributor');
    expect(text).toContain('Shipped to retailer in Kolar');
    expect(text).not.toContain('UI Operator'); // operator name is private
    expect(text).not.toContain('Moisture visibly high'); // internal rejection reasons are private
    expect(text).not.toContain('AUTHENTIC');
    // approved automatic analysis report, public-safe summary
    expect(text).toContain('Laboratory analysis report');
    expect(text).toContain('Standards-Based Laboratory Compliance Check');
    expect(text).toContain('All required laboratory tests recorded in HoneyChain are within the permitted limits.');
    expect(text).not.toContain('Dr. Meera Nair'); // lab staff names are private
  });

  it('beekeeper sees the rejected batch back in custody with the reason', async () => {
    await as('anitha@honeychain.demo');
    open('/beekeeper');
    await screen.findByText(/Returned to you/, {}, { timeout: 10000 });
    expect(document.body.textContent).toContain('Moisture visibly high on arrival (UI test)');
  });
});
