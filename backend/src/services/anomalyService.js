// Supply-chain consistency checks.
//  1) Deterministic business rules (RULE_BASED) - always run.
//  2) Isolation Forest (ML_ISOLATION_FOREST) - only when enough genuine records exist.
// Results are stored in MongoDB anomaly_reports.
import crypto from 'node:crypto';
import { query } from '../db/pg.js';
import { collection } from '../db/mongo.js';
import { insertWithOutbox } from './activityLog.js';
import { ai } from './aiClient.js';
import { standardsProfile } from './standards.js';
import { env } from '../config/env.js';
import { getSettings } from './settings.js';

// maxProcessLossPct and standardsProfile are refreshed from app_settings at the start of every scan
export const RULE_CONFIG = { maxProcessLossPct: 10, maxSingleHiveHarvestKg: 60, standardsProfile: undefined };

async function loadBatches(batchCode) {
  const { rows } = await query(
    `SELECT b.batch_id, b.batch_code, b.status, b.is_demo, b.quantity_kg::float AS batch_kg,
            h.harvest_id, h.harvest_code, h.harvest_date, h.quantity_kg::float AS harvest_kg,
            (SELECT sum(b2.quantity_kg)::float FROM batches b2 WHERE b2.harvest_id = h.harvest_id) AS harvest_allocated_kg,
            lr.report_code, lr.received_on, lr.tested_on, lr.decision, lr.moisture_pct::float AS moisture, lr.hmf_mg_kg::float AS hmf,
            lr.sucrose_g_100g::float AS sucrose, lr.glucose_g_100g::float AS glucose, lr.fructose_g_100g::float AS fructose,
            p.processing_code, p.processing_date, p.packaging_date, p.input_quantity_kg::float AS input_kg,
            p.output_quantity_kg::float AS output_kg, p.units_packed, p.unit_size_g,
            (SELECT COALESCE(sum(s.units_shipped),0) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED')::int AS units_shipped,
            (SELECT count(*) FROM shipments s WHERE s.batch_id = b.batch_id)::int AS shipment_count,
            (SELECT count(*) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status IN ('DISPATCHED','IN_TRANSIT'))::int AS open_shipments,
            (SELECT min(s.dispatch_date) FROM shipments s WHERE s.batch_id = b.batch_id AND s.status <> 'CANCELLED') AS first_dispatch,
            (SELECT bool_or(s.dispatch_date < p.packaging_date OR s.delivered_on < s.dispatch_date) FROM shipments s WHERE s.batch_id = b.batch_id) AS bad_ship_dates,
            (SELECT v.result FROM verification_checks v JOIN blockchain_anchors a ON a.anchor_id = v.anchor_id
              WHERE a.batch_id = b.batch_id AND v.result = 'MISMATCH'
                AND v.check_id = (SELECT max(v2.check_id) FROM verification_checks v2 WHERE v2.anchor_id = a.anchor_id) LIMIT 1) AS integrity
       FROM batches b JOIN harvests h ON h.harvest_id = b.harvest_id
       LEFT JOIN lab_reports lr ON lr.lab_report_id = batch_current_report(b.batch_id)
       LEFT JOIN processing_records p ON p.batch_id = b.batch_id
      WHERE ($1::text IS NULL OR b.batch_code = $1)
      ORDER BY b.batch_id`, [batchCode]);
  return rows;
}

const days = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : null);

export function evaluateRules(b, duplicateGroups = new Map()) {
  const f = [];
  const add = (ruleId, severity, message, evidence = {}) => f.push({ kind: 'RULE_BASED', ruleId, severity, message, evidence });

  if (b.harvest_allocated_kg > b.harvest_kg + 1e-9)
    add('R01_HARVEST_ALLOCATION', 'CRITICAL', `Batches from ${b.harvest_code} total ${b.harvest_allocated_kg} kg but the harvest was ${b.harvest_kg} kg`, { allocated: b.harvest_allocated_kg, harvest: b.harvest_kg });
  if (b.input_kg != null && b.input_kg > b.batch_kg + 1e-9)
    add('R02_PROCESS_INPUT', 'CRITICAL', `Processing input ${b.input_kg} kg exceeds batch quantity ${b.batch_kg} kg`, { input: b.input_kg, batch: b.batch_kg });
  if (b.units_packed != null && (b.units_packed * b.unit_size_g) / 1000 > b.output_kg + 1e-9)
    add('R03_PACKED_MASS', 'CRITICAL', `Packed ${b.units_packed} x ${b.unit_size_g} g exceeds processed output ${b.output_kg} kg`, { unitsPacked: b.units_packed, unitSizeG: b.unit_size_g, outputKg: b.output_kg });
  if (b.units_packed != null && b.units_shipped > b.units_packed)
    add('R04_SHIPPED_UNITS', 'CRITICAL', `${b.units_shipped} units dispatched but only ${b.units_packed} were packed`, { shipped: b.units_shipped, packed: b.units_packed });
  if (b.units_packed == null && b.shipment_count > 0)
    add('R04_SHIPPED_UNITS', 'CRITICAL', 'Shipments exist but there is no processing record', { shipments: b.shipment_count });

  // workflow order: harvest -> processing -> laboratory (sample of the processed batch) -> dispatch
  const order = [['harvest', b.harvest_date], ['processed', b.processing_date], ['lab received', b.received_on], ['lab tested', b.tested_on], ['first dispatch', b.first_dispatch]].filter(([, d]) => d);
  for (let i = 1; i < order.length; i++) {
    if (Date.parse(order[i][1]) < Date.parse(order[i - 1][1]))
      add('R05_DATE_ORDER', 'CRITICAL', `${order[i][0]} date (${order[i][1]}) is before ${order[i - 1][0]} date (${order[i - 1][1]})`, { earlier: order[i - 1], later: order[i] });
  }
  if (b.bad_ship_dates) add('R05_DATE_ORDER', 'CRITICAL', 'A shipment is dated before packaging or delivered before dispatch');

  if (b.shipment_count > 0 && b.decision !== 'PASS')
    add('R06_STAGE_WITHOUT_PASS', 'CRITICAL', 'Distribution records exist without a current submitted PASS lab decision', { decision: b.decision ?? null });

  if (b.decision === 'PASS') {
    const prof = standardsProfile(RULE_CONFIG.standardsProfile);
    const vals = { moisture_pct: b.moisture, hmf_mg_kg: b.hmf, sucrose_g_100g: b.sucrose };
    for (const c of prof.checks) {
      const v = vals[c.parameter];
      if (v != null && c.max != null && v > c.max)
        add('R07_LIMIT_VS_DECISION', 'WARNING', `${c.label} ${v} ${c.unit} exceeds the ${prof.key} limit (${c.max}) but the lab decision is PASS`, { parameter: c.parameter, value: v, limit: c.max, standard: prof.name });
    }
  }
  if (b.input_kg && b.output_kg != null) {
    const loss = ((b.input_kg - b.output_kg) / b.input_kg) * 100;
    if (loss > RULE_CONFIG.maxProcessLossPct)
      add('R08_PROCESS_LOSS', 'WARNING', `Processing loss ${loss.toFixed(1)}% exceeds ${RULE_CONFIG.maxProcessLossPct}%`, { lossPct: Number(loss.toFixed(2)) });
  }
  const allShippedDelivered = b.units_packed != null && b.units_shipped === b.units_packed && b.open_shipments === 0 && b.shipment_count > 0;
  if (allShippedDelivered && b.status !== 'DELIVERED')
    add('R09_STATUS_DRIFT', 'WARNING', `All units delivered but batch status is ${b.status}`);
  if (b.status === 'DELIVERED' && !allShippedDelivered)
    add('R09_STATUS_DRIFT', 'WARNING', 'Batch marked DELIVERED but not all packed units are delivered');
  if (b.integrity === 'MISMATCH')
    add('R10_INTEGRITY', 'CRITICAL', 'Latest blockchain verification of a record of this batch is MISMATCH (record changed after anchoring)');
  const dupKey = b.moisture != null ? `${b.moisture}|${b.hmf}|${b.sucrose}|${b.glucose}|${b.fructose}` : null;
  const dup = dupKey ? duplicateGroups.get(dupKey) : null;
  if (dup && dup.harvests.size > 1)
    add('R11_DUPLICATE_LAB_VALUES', 'WARNING', `Identical lab measurement set also reported for batches from other harvests (${[...dup.batches].filter((x) => x !== b.batch_code).join(', ')})`, { values: dupKey });
  if (b.harvest_kg > RULE_CONFIG.maxSingleHiveHarvestKg)
    add('R12_HARVEST_OUTLIER_RULE', 'INFO', `Single-hive harvest of ${b.harvest_kg} kg is above ${RULE_CONFIG.maxSingleHiveHarvestKg} kg`, { harvestKg: b.harvest_kg });
  return f;
}

function mlFeatures(b) {
  return {
    process_yield: b.input_kg ? b.output_kg / b.input_kg : null,
    batch_share_of_harvest: b.harvest_kg ? b.batch_kg / b.harvest_kg : null,
    days_harvest_to_processing: days(b.harvest_date, b.processing_date),
    days_processing_to_test: days(b.processing_date, b.tested_on),
    days_processing_to_dispatch: days(b.processing_date, b.first_dispatch),
    moisture_pct: b.moisture,
    hmf_mg_kg: b.hmf,
    sucrose_g_100g: b.sucrose,
  };
}

export async function runAnomalyScan(batchCode = null) {
  const runId = `${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
  const settings = await getSettings({ fresh: true });
  RULE_CONFIG.maxProcessLossPct = Number(settings.max_processing_loss_pct);
  RULE_CONFIG.standardsProfile = settings.standards_profile;
  const all = await loadBatches(null);
  const target = batchCode ? all.filter((b) => b.batch_code === batchCode) : all;
  if (batchCode && !target.length) return { runId, error: 'Batch not found', reportsCreated: 0, ml: { status: 'NOT_RUN' } };

  // duplicate lab-value groups across the whole system
  const dup = new Map();
  for (const b of all) {
    if (b.moisture == null) continue;
    const k = `${b.moisture}|${b.hmf}|${b.sucrose}|${b.glucose}|${b.fructose}`;
    if (!dup.has(k)) dup.set(k, { harvests: new Set(), batches: new Set() });
    dup.get(k).harvests.add(b.harvest_id);
    dup.get(k).batches.add(b.batch_code);
  }

  // ---- ML (Isolation Forest) on qualifying records
  const qualifying = all.filter((b) => b.report_code && b.processing_code && (env.ANOMALY_INCLUDE_DEMO || !b.is_demo));
  const containsDemo = qualifying.some((b) => b.is_demo);
  let ml = { kind: 'ML_ISOLATION_FOREST', status: 'INSUFFICIENT_DATA', recordCount: qualifying.length, minimumRequired: env.ANOMALY_MIN_RECORDS,
    anomalyScore: null, isOutlier: null, modelVersion: null, includesDemoData: containsDemo };
  const scores = new Map();
  if (qualifying.length >= env.ANOMALY_MIN_RECORDS) {
    const resp = await ai.scoreAnomaly({ minimumRequired: env.ANOMALY_MIN_RECORDS, records: qualifying.map((b) => ({ id: b.batch_code, features: mlFeatures(b) })) });
    if (!resp.ok) ml = { ...ml, status: 'SERVICE_UNAVAILABLE', statusReason: resp.error };
    else {
      ml = { ...ml, status: resp.data.status, modelVersion: resp.data.modelVersion ?? null };
      for (const s of resp.data.scores ?? []) scores.set(s.id, s);
    }
  }

  const reports = [];
  const now = new Date();
  for (const b of target) {
    const ruleFindings = evaluateRules(b, dup);
    const s = scores.get(b.batch_code);
    const mlFindings = s
      ? { ...ml, anomalyScore: s.score, isOutlier: s.isOutlier }
      : { ...ml, status: ml.status === 'SCORED' ? 'NOT_RUN' : ml.status, statusReason: ml.status === 'SCORED' ? 'Batch not eligible (needs submitted lab report and processing record, non-demo unless enabled)' : ml.statusReason };
    if (!ruleFindings.length && !(s && s.isOutlier)) continue;
    reports.push({
      runId, scope: 'BATCH', batchId: b.batch_id, batchCode: b.batch_code, ruleFindings, mlFindings,
      status: 'OPEN', resolution: null, createdAt: now, updatedAt: now, containsDemoData: Boolean(b.is_demo || (s && containsDemo)),
    });
  }

  // De-duplicate: if an OPEN report for the batch already has the same rule ids, refresh it instead of adding another
  let createdCount = 0;
  let refreshed = 0;
  let col = null;
  try { col = await collection('anomaly_reports'); } catch { col = null; }
  for (const rep of reports) {
    const ids = rep.ruleFindings.map((x) => x.ruleId).sort().join(',') + (rep.mlFindings.isOutlier ? ',ML' : '');
    let existing = null;
    if (col) {
      const open = await col.find({ batchId: rep.batchId, status: { $in: ['OPEN', 'ACKNOWLEDGED'] } }).toArray();
      existing = open.find((o) => o.ruleFindings.map((x) => x.ruleId).sort().join(',') + (o.mlFindings?.isOutlier ? ',ML' : '') === ids);
    }
    if (existing) {
      await col.updateOne({ _id: existing._id }, { $set: { updatedAt: now, ruleFindings: rep.ruleFindings, mlFindings: rep.mlFindings, runId } });
      refreshed++;
    } else {
      await insertWithOutbox('anomaly_reports', rep);
      createdCount++;
    }
  }
  if (!batchCode) {
    await insertWithOutbox('anomaly_reports', {
      runId, scope: 'SYSTEM', batchId: null, batchCode: null, ruleFindings: [], mlFindings: { ...ml },
      status: 'RESOLVED', resolution: { by: 0, at: now, note: `Scan summary: ${target.length} batches checked, ${reports.length} with findings` },
      createdAt: now, updatedAt: now, containsDemoData: containsDemo,
    });
  }
  return {
    runId,
    batchesChecked: target.length,
    batchesWithFindings: reports.length,
    reportsCreated: createdCount,
    reportsRefreshed: refreshed,
    ruleFindings: reports.reduce((n, r) => n + r.ruleFindings.length, 0),
    ml: { status: ml.status, recordCount: ml.recordCount, minimumRequired: ml.minimumRequired, outliers: [...scores.values()].filter((x) => x.isOutlier).map((x) => x.id), includesDemoData: containsDemo, statusReason: ml.statusReason ?? null },
  };
}
