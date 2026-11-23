// End-to-end API tests for the six-role application:
//   authentication & role redirects, server-side RBAC for every role, row-level data visibility,
//   the complete beekeeper -> processor -> lab -> distributor -> consumer workflow (with rejections),
//   database-level defences, audited lab corrections, lab documents, admin functions,
//   QR + public privacy, blockchain anchoring + tamper detection, AI gating, anomaly rules.
// Run from backend/:  npm test     (PostgreSQL must be running; AI service and Hardhat node optional)
import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, query, one } from '../src/db/pg.js';
import { closeMongo, collection } from '../src/db/mongo.js';
import { resetAll } from '../db/reset.js';
import { seed, DEMO_USERS, DEMO_PASSWORD } from '../db/seeds/seed.js';
import { chainStatus } from '../src/services/chainClient.js';
import { processAnchorsOnce } from '../src/services/anchorService.js';
import { aiHealth } from '../src/services/aiClient.js';

let app;
let demo;
let chainUp = false;
let aiUp = false;
const today = new Date().toISOString().slice(0, 10);
const agents = {};

async function agentFor(email, { fresh = false } = {}) {
  if (agents[email] && !fresh) return agents[email];
  const a = request.agent(app);
  const r = await a.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  if (!fresh) agents[email] = a;
  return a;
}
const B = () => demo.batches;

before(async () => {
  await resetAll({ quiet: true });
  chainUp = (await chainStatus()).status === 'up';
  aiUp = (await aiHealth()).status === 'up';
  demo = await seed({ quiet: true });
  app = createApp();
  console.log(`# integrations: blockchain=${chainUp ? 'up' : 'SKIPPED'} aiService=${aiUp ? 'up' : 'SKIPPED'}`);
});

after(async () => {
  await closeMongo();
  await pool.end();
});

// ================================================================== authentication & redirects
test('login rejects wrong password with a generic message', async () => {
  const r = await request(app).post('/api/v1/auth/login').send({ email: DEMO_USERS.lab, password: 'wrong-pass1' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.message, 'Email or password is incorrect');
});

test('session cookie is httpOnly and SameSite=Strict; /me never returns the password hash', async () => {
  const r = await request(app).post('/api/v1/auth/login').send({ email: DEMO_USERS.admin, password: DEMO_PASSWORD });
  const c = r.headers['set-cookie'][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  const me = await request(app).get('/api/v1/auth/me').set('Cookie', c.split(';')[0]);
  assert.equal(me.body.data.user.role, 'ADMIN');
  assert.equal(me.body.data.user.password_hash, undefined);
});

test('each of the six roles logs in and is sent to its own dashboard', async () => {
  const expected = {
    [DEMO_USERS.lakshmi]: ['BEEKEEPER', '/beekeeper'],
    [DEMO_USERS.processor]: ['PROCESSOR', '/processor'],
    [DEMO_USERS.lab]: ['LAB_TESTER', '/lab'],
    [DEMO_USERS.distributor]: ['DISTRIBUTOR', '/distributor'],
    [DEMO_USERS.admin]: ['ADMIN', '/admin'],
    [DEMO_USERS.consumer]: ['CONSUMER', '/consumer'],
  };
  for (const [email, [role, home]] of Object.entries(expected)) {
    const r = await request(app).post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
    assert.equal(r.status, 200, email);
    assert.equal(r.body.data.user.role, role, email);
    assert.equal(r.body.data.user.homePath, home, email);
  }
  const roles = (await query('SELECT role_code FROM roles ORDER BY 1')).rows.map((x) => x.role_code);
  assert.deepEqual(roles, ['ADMIN', 'BEEKEEPER', 'CONSUMER', 'DISTRIBUTOR', 'LAB_TESTER', 'PROCESSOR']);
});

test('protected routes require login (401)', async () => {
  for (const u of ['/api/v1/batches', '/api/v1/hives', '/api/v1/admin/stats', '/api/v1/lab/queue', '/api/v1/transfers',
    '/api/v1/lab-requests', '/api/v1/processing/queue', '/api/v1/distribution/queue', '/api/v1/consumer/verifications']) {
    assert.equal((await request(app).get(u)).status, 401, u);
  }
});

test('self-registration: beekeeper input validated; consumer accounts are optional and get role CONSUMER', async () => {
  const r = await request(app).post('/api/v1/auth/register-beekeeper').send({ email: 'not-an-email', password: 'short' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  const c = await request(app).post('/api/v1/auth/register-consumer').send({ email: 'new.consumer@example.com', password: 'Consumer123', fullName: 'New Consumer' });
  assert.equal(c.status, 201);
  assert.equal(c.body.data.user.role, 'CONSUMER');
  assert.equal(c.body.data.user.organization, null);
});

// ================================================================== server-side RBAC (manual URL entry)
const RBAC = {
  // role: { denied: [[method, url]], allowed: [url] }
  lakshmi: {
    denied: [['get', '/admin/users'], ['get', '/lab/queue'], ['post', '/processing'], ['get', '/processing/queue'], ['get', '/distribution/queue'],
      ['post', '/lab-requests'], ['post', '/lab/reports'], ['post', '/transfers/TRF-2026-000001/accept'], ['get', '/consumer/verifications'],
      ['post', '/lab-corrections/LCR-2026-000001/approve'], ['get', '/admin/settings'], ['post', '/shipments'], ['get', '/lab-requests']],
    allowed: ['/hives', '/harvests', '/batches', '/transfers', '/beekeeper/profile', '/directory/organizations?type=PROCESSOR'],
  },
  processor: {
    denied: [['post', '/hives'], ['post', '/harvests'], ['post', '/lab/reports'], ['patch', '/lab/reports/LAB-2026-000004'], ['post', '/shipments'],
      ['get', '/admin/stats'], ['post', '/lab-requests/LTR-2026-000001/accept'], ['get', '/distribution/queue'], ['get', '/lab/queue'],
      ['get', '/consumer/verifications'], ['get', '/hives']],
    allowed: ['/processing/queue', '/processing', '/transfers?direction=incoming', '/lab-requests', '/batches', '/directory/organizations?type=LABORATORY'],
  },
  lab: {
    denied: [['post', '/hives'], ['post', '/processing'], ['post', '/shipments'], ['post', `/batches/HC-2026-000002/transfers`], ['get', '/admin/users'],
      ['post', '/transfers/TRF-2026-000001/accept'], ['post', '/lab-requests'], ['get', '/transfers'], ['get', '/processing/queue'],
      ['post', '/lab-corrections/LCR-2026-000001/approve'], ['get', '/directory/organizations?type=PROCESSOR']],
    allowed: ['/lab/queue', '/lab-requests', '/lab/reports', '/lab-corrections', '/batches', '/ai/models'],
  },
  distributor: {
    denied: [['post', '/processing'], ['post', '/lab/reports'], ['post', '/hives'], ['get', '/admin/stats'], ['get', '/lab-requests'],
      ['post', '/lab-requests'], ['post', '/batches/HC-2026-000001/transfers'], ['get', '/lab/reports'], ['get', '/processing']],
    allowed: ['/distribution/queue', '/shipments', '/transfers?direction=incoming', '/batches'],
  },
  consumer: {
    denied: [['get', '/batches'], ['get', '/batches/HC-2026-000001'], ['get', '/hives'], ['get', '/qr/HC-2026-000001.png'], ['get', '/admin/stats'],
      ['get', '/lab/queue'], ['get', '/transfers'], ['get', '/processing'], ['get', '/shipments'], ['get', '/lab/reports/LAB-2026-000001']],
    allowed: ['/consumer/verifications', '/auth/me/profile'],
  },
  admin: {
    // admins monitor; they cannot create or edit supply-chain business records
    denied: [['post', '/hives'], ['post', '/harvests'], ['post', '/processing'], ['post', '/lab/reports'], ['patch', '/lab/reports/LAB-2026-000004'],
      ['post', '/lab/reports/LAB-2026-000004/submit'], ['post', '/shipments'], ['post', '/transfers/TRF-2026-000001/accept'],
      ['post', '/batches/HC-2026-000002/transfers'], ['post', '/lab-requests'], ['patch', '/shipments/SHP-2026-000001/status']],
    allowed: ['/admin/stats', '/admin/users', '/admin/roles', '/admin/settings', '/admin/security-events', '/admin/reports/reconciliation',
      '/batches', '/hives', '/harvests', '/processing', '/shipments', '/transfers', '/lab-requests', '/lab/reports', '/lab-corrections', '/admin/anchors'],
  },
};

for (const [who, spec] of Object.entries(RBAC)) {
  test(`RBAC ${who}: other roles' endpoints return 403, own endpoints 200`, async () => {
    const a = await agentFor(DEMO_USERS[who]);
    for (const [m, url] of spec.denied) {
      const r = await a[m](`/api/v1${url}`).send({});
      assert.equal(r.status, 403, `${who} ${m.toUpperCase()} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const url of spec.allowed) {
      const r = await a.get(`/api/v1${url}`);
      assert.equal(r.status, 200, `${who} GET ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
  });
}

test('denied requests are written to the audit log as ACCESS_DENIED', async () => {
  const n = await (await collection('activity_logs')).countDocuments({ action: 'ACCESS_DENIED', outcome: 'DENIED' });
  assert.ok(n >= 40, `only ${n} ACCESS_DENIED entries`);
  const admin = await agentFor(DEMO_USERS.admin);
  const ev = (await admin.get('/api/v1/admin/security-events')).body.data;
  assert.ok(ev.counts.ACCESS_DENIED > 0);
  assert.ok(ev.counts.LOGIN_FAILED > 0);
});

// ================================================================== row-level data visibility
test('a beekeeper cannot see or touch another beekeeper\'s records (404, no leak)', async () => {
  const lakshmi = await agentFor(DEMO_USERS.lakshmi);
  const own = (await lakshmi.get('/api/v1/batches?pageSize=100')).body.data.map((b) => b.batch_code);
  assert.ok(own.includes(B().delivered));
  assert.ok(!own.includes(B().inDistribution)); // Ramesh's batch
  assert.equal((await lakshmi.get(`/api/v1/batches/${B().inDistribution}`)).status, 404);
  const rHarvest = await one(`SELECT h.harvest_code FROM harvests h JOIN hives hv ON hv.hive_id=h.hive_id
                               JOIN beekeepers b ON b.beekeeper_id=hv.beekeeper_id JOIN users u ON u.user_id=b.user_id WHERE u.email=$1 LIMIT 1`, [DEMO_USERS.ramesh]);
  assert.equal((await lakshmi.post(`/api/v1/harvests/${rHarvest.harvest_code}/batches`).send({ batches: [{ quantityKg: 1, honeyType: 'x' }] })).status, 404);
  assert.equal((await lakshmi.post(`/api/v1/batches/${B().inDistribution}/transfers`).send({ toOrgId: demo.orgs.processor })).status, 404);
});

test('processors, labs and distributors only see batches handed to their own organization', async () => {
  const p1 = await agentFor(DEMO_USERS.processor);
  const p1codes = (await p1.get('/api/v1/batches?pageSize=100')).body.data.map((b) => b.batch_code);
  assert.ok(p1codes.includes(B().pendingProcessor) && p1codes.includes(B().delivered));
  assert.ok(!p1codes.includes(B().created), 'processor sees a batch still with the beekeeper');
  assert.ok(!p1codes.includes(B().transferRejected), 'processor sees a batch sent to another processor');
  // the second processor rejected its only transfer -> sees nothing, cannot open others' batches
  const p2 = await agentFor(DEMO_USERS.processor2);
  assert.equal((await p2.get('/api/v1/batches')).body.data.length, 0);
  assert.equal((await p2.get(`/api/v1/batches/${B().delivered}`)).status, 404);
  assert.equal((await p2.get('/api/v1/processing')).body.data.length, 0);

  const lab = await agentFor(DEMO_USERS.lab);
  const labCodes = (await lab.get('/api/v1/batches?pageSize=100')).body.data.map((b) => b.batch_code);
  assert.ok(labCodes.includes(B().pendingLab) && labCodes.includes(B().inTesting));
  assert.ok(!labCodes.includes(B().created) && !labCodes.includes(B().pendingProcessor));
  assert.equal((await lab.get(`/api/v1/batches/${B().created}`)).status, 404);

  const dist = await agentFor(DEMO_USERS.distributor);
  const distCodes = (await dist.get('/api/v1/batches?pageSize=100')).body.data.map((b) => b.batch_code).sort();
  assert.deepEqual(distCodes, [B().delivered, B().inDistribution].sort());
  assert.equal((await dist.get(`/api/v1/batches/${B().labPassedAwaitingDistributor}`)).status, 404);
});

test('batch detail strips private fields by role', async () => {
  const owner = (await (await agentFor(DEMO_USERS.lakshmi)).get(`/api/v1/batches/${B().delivered}`)).body.data;
  assert.equal(owner.batch.beekeeper_email, DEMO_USERS.lakshmi);
  assert.equal(owner.processing.operator_name, undefined, 'beekeeper sees processor operator name');
  const proc = (await (await agentFor(DEMO_USERS.processor)).get(`/api/v1/batches/${B().delivered}`)).body.data;
  assert.equal(proc.batch.beekeeper_email, undefined);
  assert.equal(proc.processing.operator_name, 'Operator K. (demo)');
  assert.ok(proc.shipments.every((s) => !('tracking_reference' in s)));
  const lab = (await (await agentFor(DEMO_USERS.lab)).get(`/api/v1/batches/${B().delivered}`)).body.data;
  assert.equal(lab.batch.beekeeper_email, undefined);
  assert.equal(lab.processing.operator_name, undefined);
  // full traceability for the distributor
  const dist = (await (await agentFor(DEMO_USERS.distributor)).get(`/api/v1/batches/${B().delivered}`)).body.data;
  assert.equal(dist.transfers.length, 2);
  assert.equal(dist.labReports[0].decision, 'PASS');
  assert.ok(dist.statusHistory.length >= 10);
});

// ================================================================== the complete workflow (new demo records)
test('complete workflow: hive -> harvest -> split batches -> processor -> lab -> distributor -> delivered -> consumer', async () => {
  const bk = await agentFor(DEMO_USERS.anitha);
  const proc = await agentFor(DEMO_USERS.processor);
  const proc2 = await agentFor(DEMO_USERS.processor2);
  const lab = await agentFor(DEMO_USERS.lab);
  const dist = await agentFor(DEMO_USERS.distributor);

  const hive = (await bk.post('/api/v1/hives').send({ hiveType: 'TOP_BAR', beeSpecies: 'Apis cerana', apiaryLocation: 'Test apiary (demo)', district: 'Kolar', state: 'Karnataka', installedOn: '2025-01-10' })).body.data;
  assert.match(hive.hive_code, /^HIVE-\d{6}$/);
  const hv = await bk.post('/api/v1/harvests').send({ hiveCode: hive.hive_code, harvestDate: '2026-10-01', quantityKg: 10, floralSource: 'Sunflower' });
  assert.equal(hv.status, 201);
  const created = await bk.post(`/api/v1/harvests/${hv.body.data.harvest_code}/batches`).send({ batches: [{ quantityKg: 6, honeyType: 'Sunflower' }, { quantityKg: 4, honeyType: 'Sunflower' }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [b1, b2] = created.body.data;
  assert.notEqual(b1.public_url, b2.public_url);
  const over = await bk.post(`/api/v1/harvests/${hv.body.data.harvest_code}/batches`).send({ batches: [{ quantityKg: 0.5, honeyType: 'x' }] });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'HARVEST_OVER_ALLOCATED');

  const procForm = (batchCode, extra = {}) => ({ batchCode, processingDate: today, method: 'STRAINING', operatorName: 'Op',
    inputQuantityKg: 6, outputQuantityKg: 5.8, packagingDate: today, packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: 11, bestBefore: '2028-06-01', ...extra });
  // processor cannot touch a batch it has not received
  assert.equal((await proc.post('/api/v1/processing').send(procForm(b1.batch_code))).status, 404);

  // beekeeper -> processor
  const dir = (await bk.get('/api/v1/directory/organizations?type=PROCESSOR')).body.data;
  assert.ok(dir.every((o) => !('email' in o)));
  const t1 = await bk.post(`/api/v1/batches/${b1.batch_code}/transfers`).send({ toOrgId: demo.orgs.processor, notes: 'test' });
  assert.equal(t1.status, 201, JSON.stringify(t1.body));
  const t2 = (await bk.post(`/api/v1/batches/${b2.batch_code}/transfers`).send({ toOrgId: demo.orgs.processor })).body.data;
  assert.equal((await bk.post(`/api/v1/batches/${b1.batch_code}/transfers`).send({ toOrgId: demo.orgs.processor })).status, 409); // already pending
  // only the receiving organization can respond
  assert.equal((await proc2.post(`/api/v1/transfers/${t1.body.data.transfer_code}/accept`).send({})).status, 404);
  // rejection needs a reason; batch goes back to the beekeeper; reason & responder recorded
  assert.equal((await proc.post(`/api/v1/transfers/${t2.transfer_code}/reject`).send({})).status, 422);
  const rej = await proc.post(`/api/v1/transfers/${t2.transfer_code}/reject`).send({ reason: 'Moisture visibly high on arrival' });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.data.batch_status, 'CREATED');
  const rejRow = await one('SELECT status, response_reason, responded_by FROM batch_transfers WHERE transfer_code = $1', [t2.transfer_code]);
  assert.equal(rejRow.status, 'REJECTED');
  assert.equal(rejRow.response_reason, 'Moisture visibly high on arrival');
  assert.ok(rejRow.responded_by);
  const acc = await proc.post(`/api/v1/transfers/${t1.body.data.transfer_code}/accept`).send({});
  assert.equal(acc.body.data.batch_status, 'IN_PROCESSING');
  assert.equal((await bk.post(`/api/v1/transfers/${t1.body.data.transfer_code}/cancel`).send({ reason: 'changed my mind' })).status, 409);
  // the beekeeper still sees the full history of their batch but cannot modify processing
  assert.equal((await bk.post('/api/v1/processing').send(procForm(b1.batch_code))).status, 403);

  // lab cannot test before a request exists
  const labForm = { batchCode: b1.batch_code, sampleCode: 'T-LIFE-1', receivedOn: today, testedOn: today, moisturePct: 18, hmfMgKg: 10, sucroseG100g: 2, glucoseG100g: 31, fructoseG100g: 38.5, freeAcidityMeqKg: 22, electricalConductivityMsCm: 0.4, pollenIdentification: 'Helianthus', adulterationResult: 'NOT_TESTED' };
  assert.equal((await lab.post('/api/v1/lab/reports').send(labForm)).status, 404);

  // processing with quantity loss
  assert.equal((await proc.post('/api/v1/processing').send(procForm(b1.batch_code, { inputQuantityKg: 7 }))).body.error.code, 'INPUT_EXCEEDS_BATCH');
  const p = await proc.post('/api/v1/processing').send(procForm(b1.batch_code));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.data.loss_kg, '0.20');
  // cannot go to a distributor before a PASS result
  assert.equal((await proc.post(`/api/v1/batches/${b1.batch_code}/transfers`).send({ toOrgId: demo.orgs.distributor })).status, 409);

  // processor -> laboratory testing request
  const rq = await proc.post('/api/v1/lab-requests').send({ batchCode: b1.batch_code, labOrgId: demo.orgs.lab, sampleReference: 'S-1' });
  assert.equal(rq.status, 201, JSON.stringify(rq.body));
  assert.equal((await lab.post(`/api/v1/lab-requests/${rq.body.data.request_code}/accept`).send({})).body.data.batch_status, 'IN_TESTING');
  const rep = await lab.post('/api/v1/lab/reports').send(labForm);
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  const code = rep.body.data.report_code;
  assert.equal((await lab.patch(`/api/v1/lab/reports/${code}`).send({ moisturePct: 18.4 })).body.data.moisture_pct, '18.40');
  const scr = (await lab.get(`/api/v1/lab/reports/${code}/screening`)).body.data;
  assert.equal(scr.kind, 'RULE_BASED');
  assert.equal(scr.suggestedDecision, 'PASS');
  // the lab tester cannot choose PASS/FAIL: Submit Lab Report runs the analysis and the outcome is assigned automatically
  assert.equal((await lab.post(`/api/v1/lab/reports/${code}/submit`).send({ decision: 'PASS', decisionRemarks: 'ok' })).status, 403);
  const an = await lab.post(`/api/v1/lab/reports/${code}/analysis`).send({ honeyCategory: 'BLOSSOM' });
  assert.equal(an.status, 201, JSON.stringify(an.body));
  const la = an.body.data.latest;
  assert.equal(la.status, 'COMPLETED', la.failure_reason);
  assert.equal(la.automatic_outcome, 'PASS');
  assert.equal(an.body.data.submission.batchStatus, 'LAB_PASSED');
  assert.deepEqual(await one('SELECT report_state, decision FROM lab_reports WHERE report_code = $1', [code]), { report_state: 'SUBMITTED', decision: 'PASS' });
  assert.equal((await lab.patch(`/api/v1/lab/reports/${code}`).send({ moisturePct: 15 })).status, 409); // immutable
  assert.equal((await one('SELECT status FROM lab_test_requests WHERE request_code = $1', [rq.body.data.request_code])).status, 'COMPLETED');

  // processor -> distributor (all packed units), distributor accepts
  const td = await proc.post(`/api/v1/batches/${b1.batch_code}/transfers`).send({ toOrgId: demo.orgs.distributor });
  assert.equal(td.status, 201, JSON.stringify(td.body));
  assert.equal(td.body.data.units, 11);
  assert.equal((await dist.post(`/api/v1/transfers/${td.body.data.transfer_code}/accept`).send({})).body.data.batch_status, 'IN_DISTRIBUTION');

  const ship = (units) => dist.post('/api/v1/shipments').send({ batchCode: b1.batch_code, dispatchDate: today, originLocation: 'Hub', destinationName: 'Shop',
    destinationType: 'RETAILER', destinationCity: 'Kolar', destinationState: 'Karnataka', trackingReference: 'KA-01-1234', unitsShipped: units });
  const s1 = await ship(11);
  assert.equal(s1.status, 201);
  const s2 = await ship(1);
  assert.equal(s2.body.error.code, 'SHIPPED_EXCEEDS_PACKED');
  assert.equal((await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'DELIVERED' })).status, 422);
  const del = await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'DELIVERED', deliveredOn: today });
  assert.equal(del.body.data.batchStatus, 'DELIVERED');
  assert.equal((await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'IN_TRANSIT' })).status, 409);

  // every step recorded with a responsible user
  const hist = await query(`SELECT to_status, changed_by FROM batch_status_history bh JOIN batches b ON b.batch_id=bh.batch_id WHERE b.batch_code=$1 ORDER BY history_id`, [b1.batch_code]);
  assert.equal(hist.rows.map((x) => x.to_status).join('>'),
    'CREATED>PENDING_PROCESSOR>IN_PROCESSING>PROCESSED>PENDING_LAB>IN_TESTING>LAB_PASSED>PENDING_DISTRIBUTOR>IN_DISTRIBUTION>DELIVERED');
  assert.ok(hist.rows.every((x) => x.changed_by != null), 'a status change without a responsible user');

  // consumer: no account needed; with an account the check is saved to history
  const pub = await request(app).get(`/api/v1/public/batches/${b1.batch_code}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.custody.length, 2);
  assert.equal(pub.body.data.journey.length, 1);
  assert.equal(pub.body.data.laboratory.decision, 'PASS');
  assert.equal(pub.body.data.savedToHistory, false);
  assert.ok(!JSON.stringify(pub.body).includes('KA-01-1234'), 'tracking reference leaked');
  assert.ok(!JSON.stringify(pub.body).includes('Moisture visibly high'), 'internal rejection reason leaked');
  const consumer = await agentFor(DEMO_USERS.consumer);
  assert.equal((await consumer.get(`/api/v1/public/batches/${b1.batch_code}`)).body.data.savedToHistory, true);
  const hcons = (await consumer.get('/api/v1/consumer/verifications')).body.data;
  assert.equal(hcons[0].batch_code, b1.batch_code);
});

test('automatic FAIL: the failing parameter is named, the batch cannot reach a distributor, and nobody can flip the outcome', async () => {
  const proc = await agentFor(DEMO_USERS.processor);
  const lab = await agentFor(DEMO_USERS.lab);
  const b = B().labFailedAcidity;
  assert.equal((await one('SELECT status FROM batches WHERE batch_code=$1', [b])).status, 'LAB_FAILED');
  assert.equal((await proc.post(`/api/v1/batches/${b}/transfers`).send({ toOrgId: demo.orgs.distributor })).status, 409);
  const rep = await one(`SELECT lr.report_code, lr.decision, lr.decision_remarks FROM lab_reports lr JOIN batches bt ON bt.batch_id = lr.batch_id
                         WHERE bt.batch_code = $1 AND lr.report_state = 'SUBMITTED'`, [b]);
  assert.equal(rep.decision, 'FAIL');
  assert.match(rep.decision_remarks, /Free acidity 58/);
  // no manual decision, and a correction cannot carry a decision
  assert.equal((await lab.post(`/api/v1/lab/reports/${rep.report_code}/submit`).send({ decision: 'PASS', decisionRemarks: 'x' })).status, 403);
  const c = await lab.post(`/api/v1/lab/reports/${rep.report_code}/corrections`).send({ reason: 'please make it pass', changes: { decision: 'PASS' } });
  assert.equal(c.status, 403);
  assert.ok((await (await collection('activity_logs')).findOne({ action: 'LAB_MANUAL_DECISION_REFUSED' })), 'refused manual decision is audited');
});

test('the database itself rejects impossible changes (last line of defence)', async () => {
  const expectErr = async (sql, params, codeRe) => {
    await assert.rejects(query(sql, params), (e) => { assert.match(e.message, codeRe); return true; });
  };
  const id = async (code) => (await one('SELECT batch_id FROM batches WHERE batch_code=$1', [code])).batch_id;
  await expectErr(`UPDATE batches SET status = 'DELIVERED' WHERE batch_code = $1`, [B().created], /INVALID_TRANSITION/);
  await expectErr(`UPDATE batches SET status = 'LAB_FAILED' WHERE batch_code = $1`, [B().labPassedAwaitingDistributor], /CORRECTION_REQUIRED/);
  await expectErr(`UPDATE lab_reports SET moisture_pct = 1 WHERE report_code = $1`, [demo.reports.passed], /REPORT_IMMUTABLE/);
  await expectErr('DELETE FROM batch_transfers WHERE transfer_id = (SELECT min(transfer_id) FROM batch_transfers)', [], /RECORD_IMMUTABLE/);
  await expectErr(`UPDATE batch_transfers SET status = 'PENDING', responded_at = NULL, responded_by = NULL WHERE status = 'ACCEPTED'`, [], /RECORD_IMMUTABLE/);
  const distUser = (await one('SELECT user_id, org_id FROM users WHERE email=$1', [DEMO_USERS.distributor]));
  await expectErr(`INSERT INTO shipments (batch_id, distributor_org_id, recorded_by, dispatch_date, origin_location, destination_name, destination_type,
                     destination_city, destination_state, units_shipped) VALUES ($1,$2,$3,CURRENT_DATE,'x','y','RETAILER','c','s',1)`,
    [await id(B().labPassedAwaitingDistributor), distUser.org_id, distUser.user_id], /BATCH_NOT_DISPATCHABLE/);
  const p2 = await one('SELECT user_id, org_id FROM users WHERE email=$1', [DEMO_USERS.processor2]);
  await expectErr(`INSERT INTO lab_test_requests (batch_id, lab_org_id, requester_org_id, requested_by) VALUES ($1,$2,$3,$4)`,
    [await id(B().labPassedAwaitingDistributor), demo.orgs.lab, p2.org_id, p2.user_id], /BATCH_NOT_TESTABLE|NOT_CUSTODIAN/);
  const bkUser = await one('SELECT user_id FROM users WHERE email=$1', [DEMO_USERS.ramesh]);
  await expectErr(`INSERT INTO batch_transfers (batch_id, transfer_type, to_org_id, quantity_kg, initiated_by) VALUES ($1,'TO_PROCESSOR',$2,6,$3)`,
    [await id(B().created), demo.orgs.processor, bkUser.user_id], /NOT_OWNER/);
});

// ================================================================== lab documents
test('laboratory document upload has been removed: measurements are entered directly', async () => {
  const lab = await agentFor(DEMO_USERS.lab);
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const up = await lab.post(`/api/v1/lab/reports/${demo.reports.passed}/documents`).attach('file', pdf, { filename: 'c.pdf', contentType: 'application/pdf' });
  assert.equal(up.status, 404);
  assert.equal((await lab.get(`/api/v1/lab/reports/${demo.reports.passed}/documents`)).status, 404);
});

// ================================================================== QR + public page
test('each batch has its own QR; QR PNG is served to authorized users only', async () => {
  const bk = await agentFor(DEMO_USERS.lakshmi);
  const png = await bk.get(`/api/v1/qr/${B().delivered}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal((await request(app).get(`/api/v1/qr/${B().delivered}.png`)).status, 401);
  const urls = (await query('SELECT public_url FROM qr_records')).rows.map((r) => r.public_url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((u) => /\/verify\/HC-\d{4}-\d{6}$/.test(u)));
});

test('public page shows the right batch, honest verdict, and never exposes private data', async () => {
  const a = await request(app).get(`/api/v1/public/batches/${B().delivered}`);
  const b = await request(app).get(`/api/v1/public/batches/${B().inDistribution}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.data.batchCode, B().delivered);
  assert.equal(b.body.data.batchCode, B().inDistribution);
  assert.notEqual(a.body.data.harvest.harvestCode, b.body.data.harvest.harvestCode);
  assert.equal(a.body.data.isDemo, true);
  assert.equal(a.body.data.journey.length, 2);
  assert.equal(a.body.data.custody.length, 2);
  const text = JSON.stringify(a.body);
  for (const secret of ['@honeychain.demo', 'password', 'Operator K', 'Dr. Meera', 'tracking', 'phone', 'Suresh', 'Farhan', 'response_reason']) {
    assert.ok(!text.includes(secret), `public response leaks "${secret}"`);
  }
  // VERIFIED is only claimed when every expected record verified on-chain
  if (chainUp) {
    assert.equal(a.body.data.verification.overall, 'VERIFIED');
    assert.equal(a.body.data.verification.recordsChecked, a.body.data.verification.recordsExpected);
  } else {
    assert.notEqual(a.body.data.verification.overall, 'VERIFIED');
  }
  // consent: Anitha did not consent to show her name (nor her cooperative)
  const c = await request(app).get(`/api/v1/public/batches/${B().labPassedAwaitingDistributor}`);
  assert.equal(c.body.data.origin.producerName, 'Registered beekeeper');
  assert.equal(c.body.data.origin.cooperative, null);
  assert.equal((await request(app).get('/api/v1/public/batches/HC-1999-000999')).status, 404);
  // a rejected transfer is not shown publicly
  const h = await request(app).get(`/api/v1/public/batches/${B().transferRejected}`);
  assert.equal(h.body.data.custody.length, 0);
});

// ================================================================== AI
test('quality model reports NOT_TRAINED; rule-based screening is labelled as rules', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const lab = await agentFor(DEMO_USERS.lab);
  const r = await lab.post(`/api/v1/lab/reports/${demo.reports.withPendingCorrection}/ai/quality`);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.model.status, 'NOT_TRAINED');
  assert.equal(r.body.data.prediction, null);
  assert.equal(r.body.data.standardsScreening.kind, 'RULE_BASED');
  assert.equal(r.body.data.standardsScreening.checks.find((c) => c.parameter === 'hmf_mg_kg').outcome, 'WITHIN_LIMIT'); // seeded HMF 58 mg/kg (FSSAI max 80)
});

test('hyperspectral adulteration model is retired from the lab workflow but still reported honestly', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const docs = await (await collection('ai_analysis_results')).find({ analysisType: 'ADULTERATION' }).toArray();
  assert.equal(docs.length, 0); // no longer part of the seeded / normal workflow
  const models = await (await agentFor(DEMO_USERS.lab)).get('/api/v1/ai/models');
  assert.equal(models.body.data.models.find((m) => m.name === 'honey-adulteration').status, 'TRAINED');
});

test('lab can mark an AI analysis reviewed (MongoDB update); admin can delete it (MongoDB delete)', async () => {
  const col = await collection('ai_analysis_results');
  const d = await col.findOne({ analysisType: 'QUALITY' });
  const lab = await agentFor(DEMO_USERS.lab);
  assert.equal((await lab.patch(`/api/v1/ai/analyses/${d._id}/review`).send({ note: 'seen' })).status, 200);
  assert.equal((await col.findOne({ _id: d._id })).review.status, 'REVIEWED');
  const admin = await agentFor(DEMO_USERS.admin);
  assert.equal((await admin.delete(`/api/v1/ai/analyses/${d._id}`)).status, 200);
  assert.equal(await col.findOne({ _id: d._id }), null);
});

// ================================================================== anomalies
// ================================================================== automatic lab outcome
const FULL = { moisturePct: 17.6, hmfMgKg: 11, sucroseG100g: 2.2, glucoseG100g: 31, fructoseG100g: 38.6, freeAcidityMeqKg: 23, electricalConductivityMsCm: 0.41,
  pollenIdentification: 'Multifloral', adulterationResult: 'NOT_TESTED' };
let seq = 0;
/** beekeeper -> processor -> processing (finalized) -> accepted lab request -> draft report (optional) */
async function batchInProcessing() {
  seq += 1;
  const bk = await agentFor(DEMO_USERS.anitha);
  const proc = await agentFor(DEMO_USERS.processor);
  const hive = (await bk.post('/api/v1/hives').send({ hiveType: 'TOP_BAR', beeSpecies: 'Apis cerana', apiaryLocation: `AI test apiary ${seq}`, district: 'Kolar', state: 'Karnataka', installedOn: '2025-01-10' })).body.data;
  const hv = (await bk.post('/api/v1/harvests').send({ hiveCode: hive.hive_code, harvestDate: '2026-10-02', quantityKg: 3, floralSource: 'Mixed' })).body.data;
  const [b] = (await bk.post(`/api/v1/harvests/${hv.harvest_code}/batches`).send({ batches: [{ quantityKg: 3, honeyType: 'Multifloral' }] })).body.data;
  const t = (await bk.post(`/api/v1/batches/${b.batch_code}/transfers`).send({ toOrgId: demo.orgs.processor })).body.data;
  await proc.post(`/api/v1/transfers/${t.transfer_code}/accept`).send({});
  return { proc, batchCode: b.batch_code };
}
const finalizeForm = (batchCode) => ({ batchCode, processingDate: today, operatorName: 'Op', inputQuantityKg: 3, outputQuantityKg: 2.9,
  packagingDate: today, packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: 5, bestBefore: '2028-06-01' });
async function draftReport(values = FULL) {
  const { proc, batchCode } = await batchInProcessing();
  const lab = await agentFor(DEMO_USERS.lab);
  await proc.post(`/api/v1/processing/batches/${batchCode}/steps`).send({ method: 'FILTRATION', stepDate: today, parameters: { meshMicron: 200 } });
  const p = await proc.post('/api/v1/processing').send(finalizeForm(batchCode));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const rq = (await proc.post('/api/v1/lab-requests').send({ batchCode, labOrgId: demo.orgs.lab })).body.data;
  await lab.post(`/api/v1/lab-requests/${rq.request_code}/accept`).send({});
  const rep = await lab.post('/api/v1/lab/reports').send({ batchCode, sampleCode: `AI-T-${seq}`, receivedOn: today, testedOn: today, ...values });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  return { lab, batchCode, code: rep.body.data.report_code, reportId: rep.body.data.lab_report_id };
}
const analyse = (lab, code, honeyCategory = 'BLOSSOM') => lab.post(`/api/v1/lab/reports/${code}/analysis`).send({ honeyCategory });
const state = (code) => one('SELECT report_state, decision FROM lab_reports WHERE report_code = $1', [code]);

test('automatic PASS: one submit validates, analyses, saves the report (MongoDB + PostgreSQL) and assigns PASS; duplicates reuse it', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const { lab, code, reportId, batchCode } = await draftReport();
  const first = await analyse(lab, code);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const a = first.body.data.latest;
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.standards_status, 'ALL_PASSED');
  assert.equal(a.automatic_outcome, 'PASS');
  assert.equal(a.ml_status, 'NOT_TRAINED'); // honest: no validated model, no fake prediction
  assert.equal(a.report.ml.prediction, null);
  assert.deepEqual(await state(code), { report_state: 'SUBMITTED', decision: 'PASS' });
  assert.equal((await one('SELECT status FROM batches WHERE batch_code = $1', [batchCode])).status, 'LAB_PASSED');
  const row = await one('SELECT ai_analysis_id FROM lab_reports WHERE lab_report_id = $1', [reportId]);
  assert.equal(row.ai_analysis_id, a.analysis_id);
  const an = await one('SELECT final_decision, decided_by, decided_at FROM lab_report_analyses WHERE analysis_id = $1', [a.analysis_id]);
  assert.ok(an.decided_by && an.decided_at && an.final_decision === 'PASS');
  // duplicate submission: refused (already submitted); no second analysis or document
  assert.equal((await analyse(lab, code)).status, 409);
  assert.equal((await one('SELECT count(*)::int AS n FROM lab_report_analyses WHERE lab_report_id = $1', [reportId])).n, 1);
  const docs = await (await collection('ai_analysis_results')).find({ analysisType: 'LAB_ANALYSIS', labReportId: reportId }).toArray();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].batchCode, batchCode);
  // a completed analysis and its outcome are immutable
  await assert.rejects(query(`UPDATE lab_report_analyses SET automatic_outcome = 'FAIL' WHERE analysis_id = $1`, [a.analysis_id]), /RECORD_IMMUTABLE/);
  // consumer QR page
  const pub = (await request(app).get(`/api/v1/public/batches/${batchCode}`)).body.data;
  assert.equal(pub.labAnalysis.available, true);
  assert.equal(pub.labAnalysis.automaticOutcome, 'PASS');
  assert.equal(pub.labAnalysis.decisionMode, 'AUTOMATIC');
  const txt = JSON.stringify(pub.labAnalysis);
  for (const leak of ['Meera', 'decided_by', 'requested_by', 'mongo', 'AI_SERVICE_KEY']) assert.ok(!txt.includes(leak), leak);
});

test('automatic FAIL names the failing parameter; INCOMPLETE keeps a draft; invalid units are caught', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const f = await draftReport({ ...FULL, moisturePct: 21.2 });
  const fa = (await analyse(f.lab, f.code)).body.data.latest;
  assert.equal(fa.automatic_outcome, 'FAIL');
  const st = await one('SELECT decision, decision_remarks FROM lab_reports WHERE report_code = $1', [f.code]);
  assert.equal(st.decision, 'FAIL');
  assert.match(st.decision_remarks, /Moisture 21\.2/);
  assert.equal((await one('SELECT status FROM batches WHERE batch_code = $1', [f.batchCode])).status, 'LAB_FAILED');

  const m = await draftReport({ ...FULL, glucoseG100g: null, freeAcidityMeqKg: null });
  const ma = (await analyse(m.lab, m.code)).body.data.latest;
  assert.equal(ma.automatic_outcome, 'INCOMPLETE');
  assert.ok(ma.report.missingTests.includes('Free acidity'));
  assert.equal((await state(m.code)).report_state, 'DRAFT'); // nothing decided
  await m.lab.patch(`/api/v1/lab/reports/${m.code}`).send({ glucoseG100g: 31, freeAcidityMeqKg: 20, electricalConductivityMsCm: 450 }); // uS/cm typed as mS/cm
  const ia = (await analyse(m.lab, m.code)).body.data.latest;
  assert.equal(ia.automatic_outcome, 'INCOMPLETE');
  assert.equal(ia.report.standards.applicable.checks.find((c) => c.parameter === 'electrical_conductivity').outcome, 'IMPLAUSIBLE');
  await m.lab.patch(`/api/v1/lab/reports/${m.code}`).send({ electricalConductivityMsCm: 0.45 });
  assert.equal((await analyse(m.lab, m.code)).body.data.latest.automatic_outcome, 'PASS');
  assert.equal((await state(m.code)).decision, 'PASS');
  // impossible values are rejected by the form validation; unknown honey category rejected
  const bad = await draftReport({ ...FULL, glucoseG100g: null });
  assert.equal((await bad.lab.patch(`/api/v1/lab/reports/${bad.code}`).send({ moisturePct: 120 })).status, 422);
  assert.equal((await bad.lab.patch(`/api/v1/lab/reports/${bad.code}`).send({ ph: 'abc' })).status, 422);
  assert.equal((await analyse(bad.lab, bad.code, 'MANUKA')).status, 422);
});

test('AI service down -> ANALYSIS_ERROR, report kept as a draft (no false PASS); retry succeeds', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const { env } = await import('../src/config/env.js');
  const { lab, code } = await draftReport();
  const real = env.AI_SERVICE_URL;
  env.AI_SERVICE_URL = 'http://127.0.0.1:9';
  let failed;
  try { failed = (await analyse(lab, code)).body.data; } finally { env.AI_SERVICE_URL = real; }
  assert.equal(failed.latest.status, 'FAILED');
  assert.equal(failed.automaticOutcome, 'ANALYSIS_ERROR');
  assert.equal(failed.latest.report, null);
  assert.deepEqual(await state(code), { report_state: 'DRAFT', decision: null });
  const retry = (await analyse(lab, code)).body.data.latest;
  assert.equal(retry.status, 'COMPLETED');
  assert.equal(retry.analysis_code, failed.latest.analysis_code);
  assert.equal(retry.attempts, 2);
  assert.equal(retry.automatic_outcome, 'PASS');
});

test('edited values make an analysis stale; the database refuses any decision that is not the automatic outcome', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const { lab, code } = await draftReport({ ...FULL, fructoseG100g: null });
  const a = (await analyse(lab, code)).body.data.latest; // INCOMPLETE -> stays a draft
  await lab.patch(`/api/v1/lab/reports/${code}`).send({ fructoseG100g: 38.6 });
  assert.equal((await lab.get(`/api/v1/lab/reports/${code}/analysis`)).body.data.latest.stale, true);
  await assert.rejects(query(`UPDATE lab_reports SET report_state = 'SUBMITTED', decision = 'PASS', submitted_at = now() WHERE report_code = $1`, [code]), /ANALYSIS_REQUIRED/);
  await assert.rejects(query(`UPDATE lab_reports SET report_state = 'SUBMITTED', decision = 'PASS', submitted_at = now(), ai_analysis_id = $2 WHERE report_code = $1`,
    [code, a.analysis_id]), /MANDATORY_TESTS_MISSING|ANALYSIS_STALE/);
});

// ================================================================== processing: several methods, explicit finalize
test('processing: all methods are offered; several steps are saved independently; nothing finalizes until Finalize Processing', async () => {
  const { proc, batchCode } = await batchInProcessing();
  const methods = (await proc.get('/api/v1/processing/methods')).body.data;
  assert.deepEqual(methods.map((m) => m.code), ['FILTRATION', 'STRAINING', 'SETTLING', 'GENTLE_WARMING', 'CREAMING', 'OTHER']);
  assert.ok(methods.every((m) => m.instructions && Array.isArray(m.fields)));
  const step = (body) => proc.post(`/api/v1/processing/batches/${batchCode}/steps`).send({ stepDate: today, ...body });
  // method-specific validation
  assert.equal((await step({ method: 'FILTRATION', parameters: {} })).status, 422);                      // mesh required
  assert.equal((await step({ method: 'GENTLE_WARMING', parameters: { temperatureC: 70, durationHours: 2 } })).status, 422); // too hot
  assert.equal((await step({ method: 'OTHER' })).status, 422);                                           // details required
  // finalize without any step is refused
  const none = await proc.post('/api/v1/processing').send(finalizeForm(batchCode));
  assert.equal(none.body.error.code, 'NO_PROCESSING_STEPS');
  // several methods, each its own record; the batch stays IN_PROCESSING
  assert.equal((await step({ method: 'STRAINING', parameters: { meshMicron: 1000 } })).status, 201);
  assert.equal((await step({ method: 'FILTRATION', parameters: { meshMicron: 200 } })).status, 201);
  assert.equal((await step({ method: 'GENTLE_WARMING', parameters: { temperatureC: 38, durationHours: 2 } })).status, 201);
  const removable = (await step({ method: 'OTHER', details: 'Mistaken entry' })).body.data;
  assert.equal((await proc.delete(`/api/v1/processing/batches/${batchCode}/steps/${removable.step_code}`)).status, 200);
  let view = (await proc.get(`/api/v1/processing/batches/${batchCode}/steps`)).body.data;
  assert.deepEqual(view.steps.map((x) => x.method), ['STRAINING', 'FILTRATION', 'GENTLE_WARMING']);
  assert.equal(view.finalized, false);
  assert.equal((await one('SELECT status FROM batches WHERE batch_code = $1', [batchCode])).status, 'IN_PROCESSING');
  assert.equal((await one('SELECT count(*)::int AS n FROM processing_records p JOIN batches b ON b.batch_id = p.batch_id WHERE b.batch_code = $1', [batchCode])).n, 0);
  // another unit cannot see or add steps
  const proc2 = await agentFor(DEMO_USERS.processor2);
  assert.equal((await proc2.get(`/api/v1/processing/batches/${batchCode}/steps`)).status, 404);
  // explicit finalize: incomplete info refused, then succeeds; record lists every step
  const bad = await proc.post('/api/v1/processing').send({ ...finalizeForm(batchCode), operatorName: '' });
  assert.equal(bad.status, 422);
  const fin = await proc.post('/api/v1/processing').send(finalizeForm(batchCode));
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  assert.match(fin.body.data.method_details, /1\) STRAINING.*2\) FILTRATION.*3\) GENTLE_WARMING/);
  view = (await proc.get(`/api/v1/processing/batches/${batchCode}/steps`)).body.data;
  assert.equal(view.finalized, true);
  assert.equal(view.batchStatus, 'PROCESSED');
  // locked after finalization
  assert.equal((await step({ method: 'SETTLING', parameters: { durationHours: 5 } })).status, 409);
});

test('anomaly scan: rules run; no PASS-above-limit (R07) exists because outcomes are automatic; Isolation Forest honest', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const r = await admin.post('/api/v1/admin/anomalies/scan').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ml.status, 'INSUFFICIENT_DATA');
  const list = await admin.get('/api/v1/admin/anomalies?status=OPEN');
  assert.ok(!list.body.data.some((x) => x.ruleFindings.some((f) => f.ruleId === 'R07_LIMIT_VS_DECISION')), 'a PASS above a limit was found');
  assert.ok(!list.body.data.some((x) => x.ruleFindings.some((f) => f.ruleId === 'R05_DATE_ORDER')), 'new workflow order flagged as date anomaly');
});

// ================================================================== audited lab corrections
test('submitted results change only via an audited correction approved by an admin', async () => {
  const lab = await agentFor(DEMO_USERS.lab);
  const admin = await agentFor(DEMO_USERS.admin);
  const pending = (await admin.get('/api/v1/lab-corrections?status=PENDING')).body.data;
  const c = pending.find((x) => x.report_code === demo.reports.withPendingCorrection);
  assert.ok(c, 'seeded pending correction');
  assert.deepEqual(c.previous_values, { hmfMgKg: '58.00' });
  // the lab tester cannot approve; a second pending request for the same report is refused
  assert.equal((await lab.post(`/api/v1/lab-corrections/${c.correction_code}/approve`).send({ note: 'self approve' })).status, 403);
  assert.equal((await lab.post(`/api/v1/lab/reports/${demo.reports.withPendingCorrection}/corrections`).send({ reason: 'another correction please', changes: { moisturePct: 16 } })).status, 409);
  const ap = await admin.post(`/api/v1/lab-corrections/${c.correction_code}/approve`).send({ note: 'Printout checked against record' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.data.supersededReportCode, demo.reports.withPendingCorrection);
  const old = await one('SELECT report_state, hmf_mg_kg FROM lab_reports WHERE report_code=$1', [demo.reports.withPendingCorrection]);
  assert.equal(old.report_state, 'SUPERSEDED');
  assert.equal(old.hmf_mg_kg, '58.00'); // original kept unchanged as evidence
  const fresh = await one('SELECT report_state, hmf_mg_kg, decision FROM lab_reports WHERE report_code=$1', [ap.body.data.newReportCode]);
  assert.deepEqual(fresh, { report_state: 'SUBMITTED', hmf_mg_kg: '62.00', decision: 'PASS' }); // decision recomputed, not chosen
  assert.equal(ap.body.data.automaticOutcome, 'PASS');
  const pubC = (await request(app).get(`/api/v1/public/batches/${B().labPassedAwaitingDistributor}`)).body.data;
  assert.equal(pubC.labAnalysis.available, true); // the corrected report carries its own automatic analysis
  assert.equal((await admin.post(`/api/v1/lab-corrections/${c.correction_code}/approve`).send({ note: 'again' })).status, 409);
  const pub = (await request(app).get(`/api/v1/public/batches/${B().labPassedAwaitingDistributor}`)).body.data;
  assert.equal(pub.laboratory.reportCode, ap.body.data.newReportCode);
  assert.equal(pub.laboratory.correctsReport, demo.reports.withPendingCorrection);
  const logged = await (await collection('activity_logs')).findOne({ action: 'LAB_CORRECTION_APPROVED' });
  assert.ok(logged?.details?.previous, 'correction not in audit log');
});

// ================================================================== admin functions
test('admin manages users of all six roles; role changes are audited; deactivation ends access', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const roles = (await admin.get('/api/v1/admin/roles')).body.data;
  assert.deepEqual(roles.roles.map((r) => r.role_code), ['BEEKEEPER', 'PROCESSOR', 'LAB_TESTER', 'DISTRIBUTOR', 'ADMIN', 'CONSUMER']);
  assert.ok(roles.permissions.length > 10);
  const mk = (body) => admin.post('/api/v1/admin/users').send({ tempPassword: 'Temp12345', fullName: 'Test User', ...body });
  assert.equal((await mk({ email: 'c1@example.com', role: 'CONSUMER' })).status, 201);
  assert.equal((await mk({ email: 'bk1@example.com', role: 'BEEKEEPER', beekeeper: { district: 'Mandya', state: 'Karnataka' } })).status, 201);
  assert.equal((await mk({ email: 'lt-noorg@example.com', role: 'LAB_TESTER' })).status, 422);
  const staff = (await mk({ email: 'staff1@example.com', role: 'PROCESSOR', orgId: demo.orgs.processor })).body.data;
  // wrong organization type is refused by the database
  assert.equal((await admin.patch(`/api/v1/admin/users/${staff.user_id}/role`).send({ role: 'DISTRIBUTOR', orgId: demo.orgs.processor, reason: 'moved team' })).body.error.code, 'ORG_ROLE_MISMATCH');
  const ch = await admin.patch(`/api/v1/admin/users/${staff.user_id}/role`).send({ role: 'DISTRIBUTOR', orgId: demo.orgs.distributor, reason: 'moved team' });
  assert.equal(ch.status, 200);
  const audit = await one('SELECT old_role, new_role, changed_by FROM user_role_changes WHERE user_id = $1', [staff.user_id]);
  assert.equal(audit.old_role, 'PROCESSOR');
  assert.equal(audit.new_role, 'DISTRIBUTOR');
  assert.ok(audit.changed_by);
  const bkId = (await one('SELECT user_id FROM users WHERE email=$1', [DEMO_USERS.ramesh])).user_id;
  assert.equal((await admin.patch(`/api/v1/admin/users/${bkId}/role`).send({ role: 'CONSUMER', reason: 'test change' })).body.error.code, 'BEEKEEPER_ROLE_FIXED');
  const me = (await admin.get('/api/v1/auth/me')).body.data.user;
  assert.equal((await admin.patch(`/api/v1/admin/users/${me.id}/role`).send({ role: 'CONSUMER', reason: 'test change' })).status, 409);
  // deactivate: an existing session stops working immediately
  const victim = request.agent(app);
  await victim.post('/api/v1/auth/login').send({ email: 'staff1@example.com', password: 'Temp12345' });
  assert.equal((await victim.get('/api/v1/distribution/queue')).status, 200);
  await admin.patch(`/api/v1/admin/users/${staff.user_id}`).send({ isActive: false });
  assert.equal((await victim.get('/api/v1/distribution/queue')).status, 401);
});

test('admin settings are validated and every change is recorded', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const s = (await admin.get('/api/v1/admin/settings')).body.data;
  assert.ok(s.standardsProfiles.some((p) => p.key === 'CODEX'));
  assert.ok(!JSON.stringify(s).includes(process.env.JWT_SECRET ?? '__none__'), 'secret exposed');
  assert.equal((await admin.patch('/api/v1/admin/settings/standards_profile').send({ value: 'NOPE' })).status, 422);
  assert.equal((await admin.patch('/api/v1/admin/settings/standards_profile').send({ value: 'CODEX' })).status, 200);
  const h = await one(`SELECT old_value, new_value, changed_by FROM app_settings_history WHERE setting_key='standards_profile' ORDER BY history_id DESC LIMIT 1`);
  assert.equal(h.old_value, 'FSSAI');
  assert.equal(h.new_value, 'CODEX');
  assert.ok(h.changed_by);
  await admin.patch('/api/v1/admin/settings/standards_profile').send({ value: 'FSSAI' });
  const rec = (await admin.get('/api/v1/admin/reports/reconciliation')).body.data;
  assert.ok(rec.length >= 10);
  assert.ok(rec.every((x) => x.issues.length === 0), JSON.stringify(rec.filter((x) => x.issues.length)));
});

test('admin statistics are computed from the databases', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const s = (await admin.get('/api/v1/admin/stats')).body.data;
  const real = await one('SELECT count(*)::int AS n FROM batches');
  assert.equal(Number(s.counts.batches), real.n);
  assert.equal(s.batchesByStatus.length, 12);
  assert.ok(Number(s.counts.rejected_transfers) >= 2);
  const logs = await admin.get('/api/v1/admin/activity-logs?action=LOGIN');
  assert.ok(logs.body.meta.total > 0);
});

// ================================================================== blockchain (tamper test last: it changes data)
test('anchors are only CONFIRMED with real receipts (tx hash + block)', async (t) => {
  if (!chainUp) return t.skip('Hardhat node not available');
  await processAnchorsOnce();
  const bad = await one(`SELECT count(*)::int AS n FROM blockchain_anchors WHERE status='CONFIRMED' AND (tx_hash IS NULL OR block_number IS NULL)`);
  assert.equal(bad.n, 0);
  // the corrected lab report was anchored as its own record version; the superseded one still verifies
  const admin = await agentFor(DEMO_USERS.admin);
  await processAnchorsOnce();
  const v = (await admin.post(`/api/v1/admin/batches/${B().labPassedAwaitingDistributor}/verify`)).body.data;
  assert.ok(v.filter((x) => x.entityType === 'LAB_REPORT').length >= 2, JSON.stringify(v));
  assert.ok(v.every((x) => x.result === 'VERIFIED'), JSON.stringify(v.map((x) => x.result)));
});

test('anchored records verify on-chain, and a database edit is detected as MISMATCH', async (t) => {
  if (!chainUp) return t.skip('Hardhat node / contract not available');
  const admin = await agentFor(DEMO_USERS.admin);
  const ver = await admin.post(`/api/v1/admin/batches/${B().delivered}/verify`);
  assert.equal(ver.status, 200);
  assert.ok(ver.body.data.length >= 4);
  assert.ok(ver.body.data.every((v) => v.result === 'VERIFIED'), JSON.stringify(ver.body.data.map((v) => v.result)));
  const lab = ver.body.data.find((v) => v.entityType === 'LAB_REPORT');
  assert.match(lab.txHash, /^0x[0-9a-f]{64}$/);

  // Tamper OUTSIDE the application: bypass the immutability trigger like a rogue DB admin would
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE lab_reports DISABLE TRIGGER lab_reports_rules');
    await client.query(`UPDATE lab_reports SET moisture_pct = 15.00 WHERE batch_id = (SELECT batch_id FROM batches WHERE batch_code = $1)`, [B().delivered]);
    await client.query('ALTER TABLE lab_reports ENABLE TRIGGER lab_reports_rules');
    await client.query('COMMIT');
  } finally { client.release(); }

  const after = await admin.post(`/api/v1/admin/anchors/${lab.anchorId}/verify`);
  assert.equal(after.body.data.result, 'MISMATCH');
  assert.notEqual(after.body.data.recomputedHash, after.body.data.onchainHash);
  const pub = await request(app).get(`/api/v1/public/batches/${B().delivered}`);
  assert.equal(pub.body.data.integrity.find((i) => i.record === 'LAB_REPORT').result, 'MISMATCH');
  assert.equal(pub.body.data.verification.overall, 'MISMATCH'); // never "verified" after tampering
  const scan = await admin.post('/api/v1/admin/anomalies/scan').send({ batchCode: B().delivered });
  assert.equal(scan.status, 200);
  const rep = await (await collection('anomaly_reports')).findOne({ batchCode: B().delivered, 'ruleFindings.ruleId': 'R10_INTEGRITY' });
  assert.ok(rep, 'R10_INTEGRITY finding stored');
  const re = await admin.post('/api/v1/admin/anchors/anchor-missing');
  assert.equal(re.status, 200);
});
