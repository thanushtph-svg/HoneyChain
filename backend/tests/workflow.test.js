// End-to-end API tests: auth, RBAC, ownership, full lifecycle, invalid transitions, QR,
// public privacy, blockchain anchoring + tamper detection, AI gating, anomaly rules.
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

async function agentFor(email) {
  const a = request.agent(app);
  const r = await a.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return a;
}

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

// ------------------------------------------------------------------ authentication
test('login rejects wrong password with a generic message', async () => {
  const r = await request(app).post('/api/v1/auth/login').send({ email: DEMO_USERS.lab, password: 'wrong-pass1' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.message, 'Email or password is incorrect');
});

test('session cookie is httpOnly and SameSite=Strict; /me works', async () => {
  const r = await request(app).post('/api/v1/auth/login').send({ email: DEMO_USERS.admin, password: DEMO_PASSWORD });
  const c = r.headers['set-cookie'][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  const me = await request(app).get('/api/v1/auth/me').set('Cookie', c.split(';')[0]);
  assert.equal(me.body.data.user.role, 'ADMIN');
  assert.equal(me.body.data.user.password_hash, undefined);
});

test('protected routes require login', async () => {
  for (const u of ['/api/v1/batches', '/api/v1/hives', '/api/v1/admin/stats', '/api/v1/lab/queue']) {
    assert.equal((await request(app).get(u)).status, 401, u);
  }
});

test('beekeeper self-registration validates input', async () => {
  const r = await request(app).post('/api/v1/auth/register-beekeeper').send({ email: 'not-an-email', password: 'short' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});

// ------------------------------------------------------------------ server-side RBAC
test('roles cannot use other roles\' endpoints (server-side)', async () => {
  const bk = await agentFor(DEMO_USERS.lakshmi);
  assert.equal((await bk.get('/api/v1/admin/users')).status, 403);
  assert.equal((await bk.get('/api/v1/lab/queue')).status, 403);
  assert.equal((await bk.post('/api/v1/processing').send({})).status, 403);
  const lab = await agentFor(DEMO_USERS.lab);
  assert.equal((await lab.post('/api/v1/hives').send({})).status, 403);
  assert.equal((await lab.post('/api/v1/shipments').send({})).status, 403);
  const dist = await agentFor(DEMO_USERS.distributor);
  assert.equal((await dist.post('/api/v1/lab/reports').send({})).status, 403);
});

test('a beekeeper cannot see or touch another beekeeper\'s records (404, no leak)', async () => {
  const lakshmi = await agentFor(DEMO_USERS.lakshmi);
  const own = (await lakshmi.get('/api/v1/batches')).body.data.map((b) => b.batch_code);
  assert.ok(own.includes(demo.batches.delivered));
  assert.ok(!own.includes(demo.batches.inDistribution)); // Ramesh's batch
  assert.equal((await lakshmi.get(`/api/v1/batches/${demo.batches.inDistribution}`)).status, 404);
  const rHarvest = await one(`SELECT h.harvest_code FROM harvests h JOIN hives hv ON hv.hive_id=h.hive_id
                               JOIN beekeepers b ON b.beekeeper_id=hv.beekeeper_id JOIN users u ON u.user_id=b.user_id WHERE u.email=$1 LIMIT 1`, [DEMO_USERS.ramesh]);
  const r = await lakshmi.post(`/api/v1/harvests/${rHarvest.harvest_code}/batches`).send({ batches: [{ quantityKg: 1, honeyType: 'x' }] });
  assert.equal(r.status, 404);
});

// ------------------------------------------------------------------ full lifecycle through the API
test('complete lifecycle: hive -> harvest -> batches -> lab -> processing -> shipments -> delivered', async () => {
  const bk = await agentFor(DEMO_USERS.anitha);
  const hive = (await bk.post('/api/v1/hives').send({ hiveType: 'TOP_BAR', beeSpecies: 'Apis cerana', apiaryLocation: 'Test apiary', district: 'Kolar', state: 'Karnataka', installedOn: '2025-01-10' })).body.data;
  assert.match(hive.hive_code, /^HIVE-\d{6}$/);
  const hv = await bk.post('/api/v1/harvests').send({ hiveCode: hive.hive_code, harvestDate: '2026-10-01', quantityKg: 10, floralSource: 'Sunflower' });
  assert.equal(hv.status, 201);
  const labOrg = (await bk.get('/api/v1/labs')).body.data[0];
  const created = await bk.post(`/api/v1/harvests/${hv.body.data.harvest_code}/batches`).send({ batches: [{ quantityKg: 6, honeyType: 'Sunflower' }, { quantityKg: 4, honeyType: 'Sunflower' }], labOrgId: labOrg.org_id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [b1, b2] = created.body.data;
  assert.notEqual(b1.public_url, b2.public_url);
  // over-allocation rejected by the database trigger
  const over = await bk.post(`/api/v1/harvests/${hv.body.data.harvest_code}/batches`).send({ batches: [{ quantityKg: 0.5, honeyType: 'x' }] });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'HARVEST_OVER_ALLOCATED');

  // processor cannot process an untested batch
  const proc = await agentFor(DEMO_USERS.processor);
  const early = await proc.post('/api/v1/processing').send({ batchCode: b1.batch_code, processingDate: '2026-11-01', method: 'FILTRATION', operatorName: 'X',
    inputQuantityKg: 6, outputQuantityKg: 5.9, packagingDate: '2026-11-01', packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: 10, bestBefore: '2028-01-01' });
  assert.equal(early.status, 409);

  const lab = await agentFor(DEMO_USERS.lab);
  const today = new Date().toISOString().slice(0, 10);
  const rep = await lab.post('/api/v1/lab/reports').send({ batchCode: b1.batch_code, sampleCode: 'T-LIFE-1', receivedOn: today, testedOn: today,
    moisturePct: 18, hmfMgKg: 10, sucroseG100g: 2, pollenIdentification: 'Helianthus', adulterationResult: 'NOT_TESTED' });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  const code = rep.body.data.report_code;
  assert.equal((await lab.patch(`/api/v1/lab/reports/${code}`).send({ moisturePct: 18.4 })).body.data.moisture_pct, '18.40');
  const sub = await lab.post(`/api/v1/lab/reports/${code}/submit`).send({ decision: 'PASS', decisionRemarks: 'ok' });
  assert.equal(sub.body.data.batchStatus, 'LAB_PASSED');
  assert.equal((await lab.patch(`/api/v1/lab/reports/${code}`).send({ moisturePct: 15 })).status, 409); // immutable

  const p = await proc.post('/api/v1/processing').send({ batchCode: b1.batch_code, processingDate: today, method: 'STRAINING', operatorName: 'Op',
    inputQuantityKg: 6, outputQuantityKg: 5.8, packagingDate: today, packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: 11, bestBefore: '2028-06-01' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const tooMuch = await proc.post('/api/v1/processing').send({ batchCode: b2.batch_code, processingDate: today, method: 'STRAINING', operatorName: 'Op',
    inputQuantityKg: 4, outputQuantityKg: 4, packagingDate: today, packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: 9, bestBefore: '2028-06-01' });
  assert.equal(tooMuch.status, 409); // b2 not tested

  const dist = await agentFor(DEMO_USERS.distributor);
  const ship = (units) => dist.post('/api/v1/shipments').send({ batchCode: b1.batch_code, dispatchDate: today, originLocation: 'Unit', destinationName: 'Shop',
    destinationType: 'RETAILER', destinationCity: 'Kolar', destinationState: 'Karnataka', unitsShipped: units });
  const s1 = await ship(11);
  assert.equal(s1.status, 201);
  const s2 = await ship(1);
  assert.equal(s2.status, 409);
  assert.equal(s2.body.error.code, 'SHIPPED_EXCEEDS_PACKED');
  const noDate = await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'DELIVERED' });
  assert.equal(noDate.status, 422);
  const del = await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'DELIVERED', deliveredOn: today });
  assert.equal(del.body.data.batchStatus, 'DELIVERED');
  const back = await dist.patch(`/api/v1/shipments/${s1.body.data.shipment_code}/status`).send({ status: 'IN_TRANSIT' });
  assert.equal(back.status, 409);

  const hist = await one(`SELECT string_agg(to_status, '>' ORDER BY history_id) AS h FROM batch_status_history bh JOIN batches b ON b.batch_id=bh.batch_id WHERE b.batch_code=$1`, [b1.batch_code]);
  assert.equal(hist.h, 'CREATED>IN_TESTING>LAB_PASSED>PROCESSED>IN_DISTRIBUTION>DELIVERED');
});

// ------------------------------------------------------------------ QR + public page
test('each batch has its own QR; QR PNG is served to authorized users only', async () => {
  const bk = await agentFor(DEMO_USERS.lakshmi);
  const png = await bk.get(`/api/v1/qr/${demo.batches.delivered}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal((await request(app).get(`/api/v1/qr/${demo.batches.delivered}.png`)).status, 401);
  const urls = (await query('SELECT public_url FROM qr_records')).rows.map((r) => r.public_url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((u) => /\/verify\/HC-\d{4}-\d{6}$/.test(u)));
});

test('public page shows the right batch and never exposes private data', async () => {
  const a = await request(app).get(`/api/v1/public/batches/${demo.batches.delivered}`);
  const b = await request(app).get(`/api/v1/public/batches/${demo.batches.inDistribution}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.data.batchCode, demo.batches.delivered);
  assert.equal(b.body.data.batchCode, demo.batches.inDistribution);
  assert.notEqual(a.body.data.harvest.harvestCode, b.body.data.harvest.harvestCode);
  assert.equal(a.body.data.isDemo, true);
  assert.equal(a.body.data.journey.length, 2);
  const text = JSON.stringify(a.body);
  for (const secret of ['@honeychain.demo', 'password', 'Operator K', 'Dr. Meera', 'tracking_reference', 'phone']) {
    assert.ok(!text.includes(secret), `public response leaks "${secret}"`);
  }
  // consent: Anitha did not consent to show her name
  const c = await request(app).get(`/api/v1/public/batches/${demo.batches.labPassedAwaitingProcessing}`);
  assert.equal(c.body.data.origin.producerName, 'Registered beekeeper');
  assert.equal((await request(app).get('/api/v1/public/batches/HC-1999-000999')).status, 404);
});

// ------------------------------------------------------------------ blockchain
test('anchored records verify on-chain, and a database edit is detected as MISMATCH', async (t) => {
  if (!chainUp) return t.skip('Hardhat node / contract not available');
  const admin = await agentFor(DEMO_USERS.admin);
  const ver = await admin.post(`/api/v1/admin/batches/${demo.batches.delivered}/verify`);
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
    await client.query(`UPDATE lab_reports SET moisture_pct = 15.00 WHERE batch_id = (SELECT batch_id FROM batches WHERE batch_code = $1)`, [demo.batches.delivered]);
    await client.query('ALTER TABLE lab_reports ENABLE TRIGGER lab_reports_rules');
    await client.query('COMMIT');
  } finally { client.release(); }

  const after = await admin.post(`/api/v1/admin/anchors/${lab.anchorId}/verify`);
  assert.equal(after.body.data.result, 'MISMATCH');
  assert.notEqual(after.body.data.recomputedHash, after.body.data.onchainHash);
  const pub = await request(app).get(`/api/v1/public/batches/${demo.batches.delivered}`);
  assert.equal(pub.body.data.integrity.find((i) => i.record === 'LAB_REPORT').result, 'MISMATCH');
  // rule R10 picks it up in the anomaly scan
  const scan = await admin.post('/api/v1/admin/anomalies/scan').send({ batchCode: demo.batches.delivered });
  assert.equal(scan.status, 200);
  const rep = await (await collection('anomaly_reports')).findOne({ batchCode: demo.batches.delivered, 'ruleFindings.ruleId': 'R10_INTEGRITY' });
  assert.ok(rep, 'R10_INTEGRITY finding stored');
  // tampered data must not be re-anchored
  const re = await admin.post('/api/v1/admin/anchors/anchor-missing');
  assert.equal(re.status, 200);
});

test('anchors are only CONFIRMED with real receipts (tx hash + block)', async (t) => {
  if (!chainUp) return t.skip('Hardhat node not available');
  await processAnchorsOnce();
  const bad = await one(`SELECT count(*)::int AS n FROM blockchain_anchors WHERE status='CONFIRMED' AND (tx_hash IS NULL OR block_number IS NULL)`);
  assert.equal(bad.n, 0);
});

// ------------------------------------------------------------------ AI
test('quality model reports NOT_TRAINED; rule-based screening is labelled as rules', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const lab = await agentFor(DEMO_USERS.lab);
  const code = (await one(`SELECT report_code FROM lab_reports lr JOIN batches b ON b.batch_id=lr.batch_id WHERE b.batch_code=$1`, [demo.batches.labPassedAwaitingProcessing])).report_code;
  const r = await lab.post(`/api/v1/lab/reports/${code}/ai/quality`);
  assert.equal(r.status, 201);
  assert.equal(r.body.data.model.status, 'NOT_TRAINED');
  assert.equal(r.body.data.prediction, null);
  assert.equal(r.body.data.standardsScreening.kind, 'RULE_BASED');
  assert.equal(r.body.data.standardsScreening.checks.find((c) => c.parameter === 'hmf_mg_kg').outcome, 'EXCEEDS_LIMIT');
});

test('adulteration model returns a real prediction for an uploaded spectral scan', async (t) => {
  if (!aiUp) return t.skip('AI service not running');
  const docs = await (await collection('ai_analysis_results')).find({ analysisType: 'ADULTERATION' }).toArray();
  assert.equal(docs.length, 2);
  for (const d of docs) {
    assert.equal(d.model.status, 'TRAINED');
    assert.ok(['ADULTERATION_SUSPECTED', 'NO_ADULTERATION_DETECTED'].includes(d.prediction.label));
    assert.ok(d.warnings.some((w) => /reliability/i.test(w)));
  }
  const models = await (await agentFor(DEMO_USERS.lab)).get('/api/v1/ai/models');
  assert.equal(models.body.data.models.find((m) => m.name === 'honey-adulteration').status, 'TRAINED');
});

test('lab can mark an AI analysis reviewed (MongoDB update); admin can delete it (MongoDB delete)', async () => {
  const col = await collection('ai_analysis_results');
  const d = await col.findOne({});
  const lab = await agentFor(DEMO_USERS.lab);
  assert.equal((await lab.patch(`/api/v1/ai/analyses/${d._id}/review`).send({ note: 'seen' })).status, 200);
  assert.equal((await col.findOne({ _id: d._id })).review.status, 'REVIEWED');
  const admin = await agentFor(DEMO_USERS.admin);
  assert.equal((await admin.delete(`/api/v1/ai/analyses/${d._id}`)).status, 200);
  assert.equal(await col.findOne({ _id: d._id }), null);
});

// ------------------------------------------------------------------ anomalies & admin
test('anomaly scan: rule R07 found; Isolation Forest honestly reports insufficient data', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const r = await admin.post('/api/v1/admin/anomalies/scan').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ml.status, 'INSUFFICIENT_DATA');
  const list = await admin.get('/api/v1/admin/anomalies?status=OPEN');
  const r07 = list.body.data.find((x) => x.batchCode === demo.batches.labPassedAwaitingProcessing);
  assert.ok(r07.ruleFindings.some((f) => f.ruleId === 'R07_LIMIT_VS_DECISION' && f.kind === 'RULE_BASED'));
  const upd = await admin.patch(`/api/v1/admin/anomalies/${r07._id}`).send({ status: 'ACKNOWLEDGED', note: 'Lab asked to re-test' });
  assert.equal(upd.status, 200);
});

test('admin statistics are computed from the databases', async () => {
  const admin = await agentFor(DEMO_USERS.admin);
  const s = (await admin.get('/api/v1/admin/stats')).body.data;
  const real = await one('SELECT count(*)::int AS n FROM batches');
  assert.equal(Number(s.counts.batches), real.n);
  assert.ok(s.batchesByStatus.length === 7);
  const logs = await admin.get('/api/v1/admin/activity-logs?action=LOGIN');
  assert.ok(logs.body.meta.total > 0);
});
