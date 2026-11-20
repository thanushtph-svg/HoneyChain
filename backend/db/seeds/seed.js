// DEMO DATA. Builds a realistic supply chain by calling the real API (so every rule, trigger,
// QR record, anchor and log is produced exactly as in normal use), then labels every row as
// demo data (is_demo = TRUE). All people, organizations and lab values here are fictional.
//
// Usage:  npm run db:seed            (expects an EMPTY database; use  npm run db:reset -- --yes  first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/app.js';
import { pool, query, one } from '../../src/db/pg.js';
import { connectMongo, closeMongo, collection } from '../../src/db/mongo.js';
import { processAnchorsOnce } from '../../src/services/anchorService.js';
import { chainConfig } from '../../src/services/chainClient.js';
import { PROJECT_ROOT } from '../../src/config/env.js';

export const DEMO_PASSWORD = 'Demo@1234';
export const DEMO_USERS = {
  admin: 'admin@honeychain.demo',
  lab: 'lab@honeychain.demo',
  processor: 'processor@honeychain.demo',
  distributor: 'distributor@honeychain.demo',
  lakshmi: 'lakshmi@honeychain.demo',
  ramesh: 'ramesh@honeychain.demo',
  anitha: 'anitha@honeychain.demo',
};

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const today = day(0);

class Api {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body, { form } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json.error ?? json)}`);
    return json.data;
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b); }
  patch(u, b) { return this.req('PATCH', u, b); }
  async login(email) { return this.post('/auth/login', { email, password: DEMO_PASSWORD }); }
}

export async function seed({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log('[seed]', ...a);
  const existing = await one('SELECT count(*)::int AS n FROM users');
  if (existing.n > 0) throw new Error('Database is not empty. Run  npm run db:reset -- --yes  first.');
  await connectMongo();

  // Bootstrap admin directly (there is no API to create the first admin)
  await query(`INSERT INTO users (email, password_hash, full_name, role_code, is_demo) VALUES ($1,$2,'Demo Administrator','ADMIN',TRUE)`,
    [DEMO_USERS.admin, await bcrypt.hash(DEMO_PASSWORD, 12)]);

  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const admin = new Api(base);
    await admin.login(DEMO_USERS.admin);
    const lab = await admin.post('/admin/organizations', { name: 'Bengaluru Honey Testing Laboratory (demo)', orgType: 'LABORATORY', city: 'Bengaluru', state: 'Karnataka', accreditationNo: 'DEMO-NABL-0000' });
    const proc = await admin.post('/admin/organizations', { name: 'Mysuru Honey Processing Unit (demo)', orgType: 'PROCESSOR', city: 'Mysuru', state: 'Karnataka' });
    const dist = await admin.post('/admin/organizations', { name: 'Karnataka Agri Logistics (demo)', orgType: 'DISTRIBUTOR', city: 'Bengaluru', state: 'Karnataka' });
    await admin.post('/admin/users', { email: DEMO_USERS.lab, fullName: 'Dr. Meera Nair (demo)', role: 'LAB', orgId: lab.org_id, tempPassword: DEMO_PASSWORD });
    await admin.post('/admin/users', { email: DEMO_USERS.processor, fullName: 'Suresh Patil (demo)', role: 'PROCESSOR', orgId: proc.org_id, tempPassword: DEMO_PASSWORD });
    await admin.post('/admin/users', { email: DEMO_USERS.distributor, fullName: 'Farhan Ali (demo)', role: 'DISTRIBUTOR', orgId: dist.org_id, tempPassword: DEMO_PASSWORD });
    log('organizations and staff created');

    // ---- beekeepers (self-registration through the public API)
    const bk = {};
    const people = [
      ['lakshmi', 'Lakshmi Devi (demo)', 'Shakti Rural Beekeepers Cooperative (demo)', 'Chikkaballapur', true],
      ['ramesh', 'Ramesh Gowda (demo)', 'Malnad Bee Collective (demo)', 'Hassan', true],
      ['anitha', 'Anitha Rao (demo)', 'Namma Bee Farmers Group (demo)', 'Kolar', false],
    ];
    for (const [key, name, coop, district, consent] of people) {
      const c = new Api(base);
      await c.post('/auth/register-beekeeper', { email: DEMO_USERS[key], password: DEMO_PASSWORD, fullName: name, publicDisplayName: name,
        showNamePublicly: consent, cooperativeName: coop, district, state: 'Karnataka' });
      bk[key] = c;
    }

    // ---- hives & harvests
    const hive = async (c, type, species, loc, district, installed) =>
      (await c.post('/hives', { hiveType: type, beeSpecies: species, apiaryLocation: loc, district, state: 'Karnataka', installedOn: installed })).hive_code;
    const hL1 = await hive(bk.lakshmi, 'NEWTON', 'Apis cerana indica', 'Mango orchard near Nandi Hills (demo)', 'Chikkaballapur', day(700));
    const hL2 = await hive(bk.lakshmi, 'NEWTON', 'Apis cerana indica', 'Village tank bund (demo)', 'Chikkaballapur', day(400));
    const hR1 = await hive(bk.ramesh, 'LANGSTROTH', 'Apis mellifera', 'Coffee estate edge, Sakleshpur (demo)', 'Hassan', day(900));
    const hA1 = await hive(bk.anitha, 'LANGSTROTH', 'Apis mellifera', 'Jamun grove, Mulbagal (demo)', 'Kolar', day(600));
    const harvest = async (c, hiveCode, d, kg, flora) => (await c.post('/harvests', { hiveCode, harvestDate: day(d), quantityKg: kg, floralSource: flora })).harvest_code;
    const hvL1 = await harvest(bk.lakshmi, hL1, 40, 18.5, 'Multifloral');
    const hvL2 = await harvest(bk.lakshmi, hL2, 12, 9.0, 'Multifloral');
    await harvest(bk.lakshmi, hL1, 130, 14.2, 'Multifloral');
    const hvR1 = await harvest(bk.ramesh, hR1, 35, 22.0, 'Coffee blossom');
    const hvA1 = await harvest(bk.anitha, hA1, 28, 16.0, 'Jamun');
    log('hives and harvests created');

    // ---- batches
    const batches = async (c, hv, list) => (await c.post(`/harvests/${hv}/batches`, { batches: list, labOrgId: lab.org_id })).map((b) => b.batch_code);
    const [bA, bF] = await batches(bk.lakshmi, hvL1, [{ quantityKg: 12, honeyType: 'Multifloral' }, { quantityKg: 6, honeyType: 'Multifloral' }]);
    const [bB, bE] = await batches(bk.ramesh, hvR1, [{ quantityKg: 15, honeyType: 'Coffee blossom' }, { quantityKg: 7, honeyType: 'Coffee blossom' }]);
    const [bC, bD] = await batches(bk.anitha, hvA1, [{ quantityKg: 10, honeyType: 'Jamun' }, { quantityKg: 5.5, honeyType: 'Jamun' }]);
    const [bG] = await batches(bk.lakshmi, hvL2, [{ quantityKg: 9, honeyType: 'Multifloral' }]);
    log('batches created:', [bA, bB, bC, bD, bE, bF, bG].join(', '));

    // ---- laboratory
    const labApi = new Api(base); await labApi.login(DEMO_USERS.lab);
    const report = async (batchCode, sample, v, decision, remarks, isDemoDraftOnly = false) => {
      const r = await labApi.post('/lab/reports', { batchCode, sampleCode: sample, receivedOn: today, testedOn: today, ...v });
      if (!isDemoDraftOnly) await labApi.post(`/lab/reports/${r.report_code}/submit`, { decision, decisionRemarks: remarks });
      return r.report_code;
    };
    const pollen = (p) => ({ pollenIdentification: p, adulterationMethod: 'C4 sugar (SCIRA) - demo', adulterationResult: 'NOT_DETECTED' });
    const rA = await report(bA, 'DEMO-S-001', { moisturePct: 17.8, hmfMgKg: 9.6, sucroseG100g: 3.1, glucoseG100g: 31.2, fructoseG100g: 38.4, ph: 3.9, freeAcidityMeqKg: 24, ...pollen('Multifloral pollen spectrum (demo)') }, 'PASS', 'All parameters within FSSAI limits (demo data)');
    await report(bB, 'DEMO-S-002', { moisturePct: 18.2, hmfMgKg: 11.4, sucroseG100g: 2.8, glucoseG100g: 30.1, fructoseG100g: 39.0, ...pollen('Coffea pollen predominant (demo)') }, 'PASS', 'Within limits (demo data)');
    await report(bC, 'DEMO-S-003', { moisturePct: 17.1, hmfMgKg: 85.0, sucroseG100g: 2.4, ...pollen('Syzygium cumini (jamun) pollen predominant (demo)') }, 'PASS', 'Accepted (demo data - HMF deliberately above limit to demonstrate rule-based anomaly R07)');
    const rD = await report(bD, 'DEMO-S-004', { moisturePct: 17.5, hmfMgKg: 12.0, sucroseG100g: 2.9, ...pollen('Jamun pollen (demo)') }, null, null, true);
    await report(bE, 'DEMO-S-005', { moisturePct: 21.6, hmfMgKg: 96.0, sucroseG100g: 7.2, pollenIdentification: 'Low pollen count (demo)', adulterationMethod: 'C4 sugar (SCIRA) - demo', adulterationResult: 'DETECTED' }, 'FAIL', 'Moisture, HMF and sucrose above limits; C4 sugar detected (demo data)');
    log('lab reports created');

    // AI: quality analysis (standards screening + honest model status) and adulteration on demo spectral scans
    await labApi.post(`/lab/reports/${rA}/ai/quality`);
    const samplesDir = path.join(PROJECT_ROOT, 'ai-service', 'samples');
    for (const f of ['demo_scan_c9_manuka_0pct.csv', 'demo_scan_c9_manuka_25pct.csv']) {
      const p = path.join(samplesDir, f);
      if (!fs.existsSync(p)) continue;
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(p)], { type: 'text/csv' }), f);
      form.append('instrument', 'SOC-710 (public Auckland dataset sample - demo)');
      form.append('preprocessing', 'as distributed in the Auckland HSI dataset');
      form.append('isDemo', 'true');
      const scan = await labApi.req('POST', `/lab/reports/${rD}/spectral-scans`, undefined, { form });
      await labApi.post(`/lab/reports/${rD}/ai/adulteration`, { spectralScanId: scan.id }).catch((e) => log('adulteration analysis skipped:', e.message));
    }

    // ---- processing
    const procApi = new Api(base); await procApi.login(DEMO_USERS.processor);
    const process = (batchCode, inKg, outKg, units) => procApi.post('/processing', {
      batchCode, processingDate: today, method: 'FILTRATION', methodDetails: 'Cold filtration through 200-micron mesh (demo)',
      operatorName: 'Operator K. (demo)', inputQuantityKg: inKg, outputQuantityKg: outKg, packagingDate: today,
      packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: units, bestBefore: day(-540) });
    await process(bA, 12, 11.8, 23);
    await process(bB, 15, 14.6, 29);

    // ---- distribution
    const distApi = new Api(base); await distApi.login(DEMO_USERS.distributor);
    const ship = (batchCode, dest, type, city, units) => distApi.post('/shipments', {
      batchCode, dispatchDate: today, originLocation: 'Mysuru Honey Processing Unit (demo)', destinationName: dest,
      destinationType: type, destinationCity: city, destinationState: 'Karnataka', carrierName: 'Demo Road Carriers', unitsShipped: units });
    const s1 = await ship(bA, 'Bengaluru Central Warehouse (demo)', 'WAREHOUSE', 'Bengaluru', 15);
    const s2 = await ship(bA, 'Organic Mart Jayanagar (demo)', 'RETAILER', 'Bengaluru', 8);
    await distApi.patch(`/shipments/${s1.shipment_code}/status`, { status: 'IN_TRANSIT' });
    await distApi.patch(`/shipments/${s1.shipment_code}/status`, { status: 'DELIVERED', deliveredOn: today });
    await distApi.patch(`/shipments/${s2.shipment_code}/status`, { status: 'DELIVERED', deliveredOn: today });
    const s3 = await ship(bB, 'Hassan Retail Store (demo)', 'RETAILER', 'Hassan', 12);
    await distApi.patch(`/shipments/${s3.shipment_code}/status`, { status: 'IN_TRANSIT' });
    log('processing and shipments recorded');

    // ---- label everything as demo data
    for (const t of ['organizations', 'users', 'beekeepers', 'hives', 'harvests', 'batches', 'lab_reports', 'processing_records', 'shipments']) {
      await query(`UPDATE ${t} SET is_demo = TRUE WHERE NOT is_demo`);
    }
    for (const col of ['ai_analysis_results', 'spectral_scans']) {
      await (await collection(col)).updateMany({ isDemo: false }, { $set: { isDemo: true } }).catch(() => {});
    }

    // ---- confirm anchors on-chain, then verify, then run the anomaly scan
    if (chainConfig().configured) {
      for (let i = 0; i < 6; i++) await processAnchorsOnce();
      const confirmed = await one(`SELECT count(*)::int AS n FROM blockchain_anchors WHERE status='CONFIRMED'`);
      log(`blockchain anchors confirmed: ${confirmed.n}`);
      await admin.post(`/admin/batches/${bA}/verify`);
    } else {
      log('blockchain not configured - records are NOT anchored (deploy the contract, then use Admin > Blockchain > Anchor missing records)');
    }
    await admin.post('/admin/anomalies/scan', {});
    log('anomaly scan done');

    const summary = { batches: { delivered: bA, inDistribution: bB, labPassedAwaitingProcessing: bC, inTesting: bD, labFailed: bE, created: bF, createdOtherHarvest: bG } };
    log('demo batches:', JSON.stringify(summary.batches));
    log(`demo logins (password ${DEMO_PASSWORD}):`, Object.values(DEMO_USERS).join(', '));
    return summary;
  } finally {
    server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed()
    .then(async () => { await closeMongo(); await pool.end(); })
    .catch(async (e) => { console.error('[seed] ERROR:', e.message); await closeMongo(); await pool.end(); process.exit(1); });
}
