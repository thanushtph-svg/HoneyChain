// Compulsory automatic laboratory analysis.
// PostgreSQL (lab_report_analyses) holds the reference, statuses, review and decision audit;
// MongoDB (ai_analysis_results, analysisType LAB_ANALYSIS) holds the full structured report.
// The AI service performs the Standards-Based Laboratory Compliance Check and the Random Forest
// prediction (only if a validated model exists). Nothing here decides PASS/FAIL.
import { ObjectId } from 'mongodb';
import { query, one, withTransaction } from '../db/pg.js';
import { collection } from '../db/mongo.js';
import { ai } from './aiClient.js';
import { getSetting } from './settings.js';
import { conflict, unprocessable, unavailable } from '../utils/errors.js';
import { createPendingAnchor } from './anchorService.js';

export const LAB_ANALYSIS_DISCLAIMER =
  "Decision support only. The laboratory's measured results and the tester's decision are authoritative. This is not a certification.";
const STALE_PENDING_MS = 2 * 60 * 1000;
const MEASUREMENT_COLS = ['moisture_pct', 'hmf_mg_kg', 'sucrose_g_100g', 'glucose_g_100g', 'fructose_g_100g', 'brix', 'ph',
  'free_acidity_meq_kg', 'water_activity', 'electrical_conductivity_ms_cm'];
const ML_TO_MODEL_STATUS = { PREDICTION_AVAILABLE: 'TRAINED', INSUFFICIENT_INPUT: 'INPUT_UNAVAILABLE', NOT_TRAINED: 'NOT_TRAINED', NOT_AVAILABLE: 'NOT_AVAILABLE' };

const ANALYSIS_SELECT = `
  SELECT a.*, ru.full_name AS reviewed_by_name, du.full_name AS decided_by_name, qu.full_name AS requested_by_name
    FROM lab_report_analyses a
    LEFT JOIN users ru ON ru.user_id = a.reviewed_by
    LEFT JOIN users du ON du.user_id = a.decided_by
    LEFT JOIN users qu ON qu.user_id = a.requested_by`;

export async function currentFingerprint(labReportId, client = null) {
  const sql = 'SELECT lab_report_values_fingerprint(lr) AS fp FROM lab_reports lr WHERE lr.lab_report_id = $1';
  const row = client ? (await client.query(sql, [labReportId])).rows[0] : await one(sql, [labReportId]);
  return row?.fp ?? null;
}

export async function analysisOptions() {
  const [r, profile, policy] = await Promise.all([ai.standards(), getSetting('standards_profile'), getSetting('lab_failed_standard_policy')]);
  if (!r.ok) throw unavailable('AI_SERVICE_UNAVAILABLE', `The AI analysis service is not reachable: ${r.error}`);
  return { ...r.data, activeProfile: profile, failedStandardPolicy: policy ?? 'FLAG_FOR_REVIEW' };
}

async function markFailed(analysisId, reason) {
  await query(`UPDATE lab_report_analyses SET status = 'FAILED', automatic_outcome = 'ANALYSIS_ERROR', failure_reason = $2
                WHERE analysis_id = $1 AND status = 'PENDING'`, [analysisId, String(reason).slice(0, 1000)]);
}

/** Automatic laboratory outcome from the authoritative standards result (the ML output never changes it). */
export const outcomeFor = (standardsStatus) => ({ ALL_PASSED: 'PASS', FAILED: 'FAIL', INCOMPLETE: 'INCOMPLETE' })[standardsStatus] ?? 'ANALYSIS_ERROR';
const DECISION_STATUS = { PASS: 'LAB_PASSED', FAIL: 'LAB_FAILED' };

function autoRemarks(report) {
  const p = report.standards.applicable;
  return p.status === 'ALL_PASSED'
    ? `Automatic outcome PASS: all ${p.checks.filter((c) => c.mandatory && c.outcome !== 'NOT_APPLICABLE').length} mandatory parameters within the ${p.standard} limits (${p.version}).`
    : `Automatic outcome FAIL: outside the ${p.standard} limits - ${p.checks.filter((c) => c.outcome === 'FAIL').map((c) => `${c.label} ${c.value} ${c.unit === 'ratio' ? '' : c.unit} (limit ${c.limit})`).join('; ')}.`;
}

/**
 * PASS / FAIL outcomes are submitted automatically: report SUBMITTED with the automatic decision,
 * batch -> LAB_PASSED / LAB_FAILED, testing request completed, record queued for blockchain anchoring.
 * INCOMPLETE / ANALYSIS_ERROR leave the report as a DRAFT so the tester can complete it / retry.
 */
async function autoSubmit(user, analysis, report) {
  const decision = analysis.automatic_outcome;
  if (!DECISION_STATUS[decision]) return null;
  return withTransaction(user.id, async (c) => {
    const lr = (await c.query('SELECT * FROM lab_reports WHERE lab_report_id = $1 FOR UPDATE', [analysis.lab_report_id])).rows[0];
    if (lr.report_state !== 'DRAFT') return { alreadySubmitted: true, decision: lr.decision };
    await c.query('SELECT 1 FROM batches WHERE batch_id = $1 FOR UPDATE', [lr.batch_id]);
    const remarks = autoRemarks(report);
    await c.query(
      `UPDATE lab_reports SET report_state = 'SUBMITTED', decision = $2, decision_remarks = $3, submitted_at = now(), ai_analysis_id = $4
        WHERE lab_report_id = $1`, [lr.lab_report_id, decision, remarks, analysis.analysis_id]);
    await c.query(
      `UPDATE lab_report_analyses SET final_decision = $2, decision_comment = $3, decided_by = $4, decided_at = now()
        WHERE analysis_id = $1`, [analysis.analysis_id, decision, 'Assigned automatically by the standards-based compliance check', user.id]);
    if (lr.request_id) await c.query(`UPDATE lab_test_requests SET status = 'COMPLETED', completed_at = now() WHERE request_id = $1`, [lr.request_id]);
    await c.query('UPDATE batches SET status = $2 WHERE batch_id = $1', [lr.batch_id, DECISION_STATUS[decision]]);
    const anchor = await createPendingAnchor(c, { entity_type: 'LAB_REPORT', batch_id: lr.batch_id, lab_report_id: lr.lab_report_id }, user.id);
    return { decision, batchStatus: DECISION_STATUS[decision], anchorQueued: Boolean(anchor) };
  });
}

function buildDoc({ mongoId, row, lr, batchCode, measurements, honeyCategory, profile, report, userId }) {
  const primary = report.standards.applicable;
  return {
    _id: mongoId,
    analysisType: 'LAB_ANALYSIS',
    analysisCode: row.analysis_code,
    pgAnalysisId: row.analysis_id,
    batchId: lr.batch_id,
    batchCode,
    labReportId: lr.lab_report_id,
    labReportCode: lr.report_code,
    spectralScanId: null,
    inputSnapshot: { ...measurements, honeyCategory, profile, valuesFingerprint: row.values_fingerprint },
    standardsScreening: {
      kind: 'RULE_BASED', standard: `${primary.standard} - ${primary.version}`, source: primary.reference, profile: primary.profile,
      checks: primary.checks.map((c) => ({ parameter: c.parameter, label: c.label, value: c.value, limit: c.limit, unit: c.unit, outcome: c.outcome })),
    },
    model: {
      name: report.ml.model ?? 'honey-quality', version: report.ml.version ?? null,
      status: ML_TO_MODEL_STATUS[report.mlStatus] ?? 'NOT_AVAILABLE', statusReason: report.ml.reason ?? null, datasetId: null, task: 'classification',
    },
    prediction: report.mlStatus === 'PREDICTION_AVAILABLE'
      ? { label: report.ml.prediction.predictedClass, value: null, unit: null, probabilities: report.ml.prediction.probabilities ?? null, confidence: null }
      : null,
    report,
    warnings: report.warnings,
    disclaimer: LAB_ANALYSIS_DISCLAIMER,
    requestedBy: userId,
    createdAt: new Date(),
    review: { status: 'UNREVIEWED', reviewedBy: null, reviewedAt: null, note: null },
    isDemo: Boolean(lr.is_demo),
  };
}

/**
 * Run (or reuse) the automatic analysis of a DRAFT report's current values.
 * Idempotent: the same values + category + profile return the existing COMPLETED analysis.
 */
export async function runLabAnalysis(user, rep, honeyCategory) {
  const profile = (await getSetting('standards_profile')) || 'FSSAI';
  const referenceProfile = profile === 'FSSAI' ? 'CODEX' : 'FSSAI';
  const claim = await withTransaction(user.id, async (c) => {
    const lr = (await c.query('SELECT * FROM lab_reports WHERE lab_report_id = $1 FOR UPDATE', [rep.lab_report_id])).rows[0];
    if (lr.report_state !== 'DRAFT') throw conflict('REPORT_IMMUTABLE', 'Only a draft lab report can be submitted for analysis');
    const fp = await currentFingerprint(lr.lab_report_id, c);
    const existing = (await c.query(
      `SELECT * FROM lab_report_analyses WHERE lab_report_id = $1 AND values_fingerprint = $2 AND honey_category = $3 AND standards_profile = $4`,
      [lr.lab_report_id, fp, honeyCategory, profile])).rows[0];
    if (existing?.status === 'COMPLETED') return { row: existing, reused: true, lr };
    if (existing?.status === 'PENDING' && Date.now() - new Date(existing.started_at).getTime() < STALE_PENDING_MS) {
      throw conflict('ANALYSIS_IN_PROGRESS', `Analysis ${existing.analysis_code} is already running for these values`);
    }
    if (existing) {
      const row = (await c.query(
        `UPDATE lab_report_analyses SET status = 'PENDING', failure_reason = NULL, attempts = attempts + 1, started_at = now(), requested_by = $2
          WHERE analysis_id = $1 RETURNING *`, [existing.analysis_id, user.id])).rows[0];
      return { row, reused: false, lr };
    }
    const row = (await c.query(
      `INSERT INTO lab_report_analyses (lab_report_id, batch_id, values_fingerprint, honey_category, standards_profile, requested_by, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [lr.lab_report_id, lr.batch_id, fp, honeyCategory, profile, user.id, lr.is_demo])).rows[0];
    return { row, reused: false, lr };
  });
  if (claim.reused) {
    // the same values were already analysed: (re)apply its automatic outcome if the report is still a draft
    const { doc } = await loadReportDoc(claim.row);
    const submission = doc ? await autoSubmit(user, claim.row, doc.report) : null;
    return { analysis: claim.row, reused: true, submission };
  }
  const { row, lr } = claim;

  const batch = await one('SELECT batch_code, honey_type FROM batches WHERE batch_id = $1', [lr.batch_id]);
  const measurements = Object.fromEntries(MEASUREMENT_COLS.map((k) => [k, lr[k] == null ? null : Number(lr[k])]));
  const resp = await ai.labAnalysis({
    labReportId: lr.lab_report_id, labReportCode: lr.report_code, batchId: lr.batch_id, batchCode: batch.batch_code,
    honeyType: batch.honey_type, honeyCategory, profile, referenceProfile, measurements,
  });
  if (!resp.ok) {
    const reason = resp.httpStatus === 422 ? `Input rejected by the AI service: ${resp.error}`
      : resp.httpStatus === 500 ? `Report generation failed: ${resp.error}` : resp.error;
    await markFailed(row.analysis_id, reason);
    return { analysis: await one('SELECT * FROM lab_report_analyses WHERE analysis_id = $1', [row.analysis_id]), reused: false };
  }
  const report = resp.data;
  const mongoId = new ObjectId();
  const doc = buildDoc({ mongoId, row, lr, batchCode: batch.batch_code, measurements, honeyCategory, profile, report, userId: user.id });
  try {
    const col = await collection('ai_analysis_results');
    // the PostgreSQL row is not COMPLETED, so any document with this code is an orphan of an interrupted attempt
    await col.deleteMany({ analysisType: 'LAB_ANALYSIS', analysisCode: row.analysis_code });
    await col.insertOne(doc);
  } catch (e) {
    await markFailed(row.analysis_id, `MongoDB unavailable - report not saved: ${e.message}`);
    return { analysis: await one('SELECT * FROM lab_report_analyses WHERE analysis_id = $1', [row.analysis_id]), reused: false };
  }
  let done;
  try {
    done = (await query(
      `UPDATE lab_report_analyses SET status = 'COMPLETED', standards_status = $2, ml_status = $3, overall_status = $4, mongo_report_id = $5,
              ruleset_version = $6, ml_model_version = $7, automatic_outcome = $8, completed_at = now()
        WHERE analysis_id = $1 AND status = 'PENDING' RETURNING *`,
      [row.analysis_id, report.standardsStatus, report.mlStatus, report.overall.status, String(mongoId),
        report.engine?.rulesetVersion ?? null, report.ml.version ?? null, outcomeFor(report.standardsStatus)])).rows[0];
    if (!done) throw new Error('analysis row was changed concurrently');
  } catch (e) {
    // PostgreSQL could not record the result: remove the orphan report and leave the analysis retryable
    await (await collection('ai_analysis_results')).deleteOne({ _id: mongoId }).catch(() => {});
    await markFailed(row.analysis_id, `Database error while saving the analysis: ${e.message}`).catch(() => {});
    throw e;
  }
  const submission = await autoSubmit(user, done, report);
  return { analysis: done, reused: false, submission };
}

/**
 * Approved correction: analyse the corrected values BEFORE the correction transaction, so the corrected
 * report's decision is computed (never chosen). Returns the report, outcome and a prepared Mongo document id.
 */
export async function analyseCorrection(oldReport, merged, honeyCategory) {
  const profile = (await getSetting('standards_profile')) || 'FSSAI';
  const batch = await one('SELECT batch_code, honey_type FROM batches WHERE batch_id = $1', [oldReport.batch_id]);
  const measurements = Object.fromEntries(MEASUREMENT_COLS.map((k) => [k, merged[k] == null ? null : Number(merged[k])]));
  const resp = await ai.labAnalysis({
    labReportId: oldReport.lab_report_id, labReportCode: `${oldReport.report_code} (corrected)`, batchId: oldReport.batch_id,
    batchCode: batch.batch_code, honeyType: batch.honey_type, honeyCategory, profile,
    referenceProfile: profile === 'FSSAI' ? 'CODEX' : 'FSSAI', measurements,
  });
  if (!resp.ok) throw unavailable('ANALYSIS_ERROR', `The automatic analysis of the corrected values failed: ${resp.error}`);
  const outcome = outcomeFor(resp.data.standardsStatus);
  if (outcome === 'INCOMPLETE') throw conflict('CORRECTION_INCOMPLETE', 'The corrected values are missing or invalid for mandatory tests; the correction cannot be approved');
  return { report: resp.data, outcome, measurements, profile, batchCode: batch.batch_code };
}

/** Store the analysis of an approved correction (inside the correction transaction, app.lab_correction set). */
export async function storeCorrectionAnalysis(c, { newReport, analysed, honeyCategory, adminId }) {
  const mongoId = new ObjectId();
  const fp = (await c.query('SELECT lab_report_values_fingerprint(lr) AS fp FROM lab_reports lr WHERE lab_report_id = $1', [newReport.lab_report_id])).rows[0].fp;
  const row = (await c.query(
    `INSERT INTO lab_report_analyses (lab_report_id, batch_id, values_fingerprint, honey_category, standards_profile, status, standards_status,
        ml_status, overall_status, mongo_report_id, ruleset_version, ml_model_version, automatic_outcome, completed_at, requested_by,
        final_decision, decision_comment, decided_by, decided_at, is_demo)
     VALUES ($1,$2,$3,$4,$5,'COMPLETED',$6,$7,$8,$9,$10,$11,$12,now(),$13,$12,'Automatic outcome of an administrator-approved correction',$13,now(),$14)
     RETURNING *`,
    [newReport.lab_report_id, newReport.batch_id, fp, honeyCategory, analysed.profile, analysed.report.standardsStatus, analysed.report.mlStatus,
      analysed.report.overall.status, String(mongoId), analysed.report.engine?.rulesetVersion ?? null, analysed.report.ml.version ?? null,
      analysed.outcome, adminId, newReport.is_demo])).rows[0];
  const report = { ...analysed.report, labReport: { id: newReport.lab_report_id, code: newReport.report_code } };
  return { row, doc: buildDoc({ mongoId, row, lr: newReport, batchCode: analysed.batchCode, measurements: analysed.measurements, honeyCategory,
    profile: analysed.profile, report, userId: adminId }) };
}

async function loadReportDoc(row) {
  if (!row?.mongo_report_id) return { doc: null, mongoError: null };
  try {
    const d = await (await collection('ai_analysis_results')).findOne({ _id: new ObjectId(row.mongo_report_id) });
    return { doc: d, mongoError: d ? null : 'Report document not found in MongoDB' };
  } catch (e) {
    return { doc: null, mongoError: `MongoDB unavailable: ${e.message}` };
  }
}

/** Latest analysis of a report (with its full MongoDB report) plus history and staleness. */
export async function analysisView(rep) {
  const rows = (await query(`${ANALYSIS_SELECT} WHERE a.lab_report_id = $1 ORDER BY a.created_at DESC, a.analysis_id DESC`, [rep.lab_report_id])).rows;
  const fp = await currentFingerprint(rep.lab_report_id);
  const approved = rep.ai_analysis_id ? rows.find((r) => r.analysis_id === rep.ai_analysis_id)
    : (rep.report_state !== 'DRAFT' ? rows.find((r) => r.decided_at) : null); // corrected reports are linked by report id
  const latest = approved ?? rows[0] ?? null;
  const { doc, mongoError } = await loadReportDoc(latest);
  return {
    latest: latest && {
      ...latest,
      stale: rep.report_state === 'DRAFT' && latest.values_fingerprint !== fp,
      report: doc?.report ?? null,
      mongoError,
    },
    approvedAnalysisId: rep.ai_analysis_id ?? null,
    legacy: rep.report_state !== 'DRAFT' && !approved,
    history: rows.map(({ values_fingerprint: _f, ...r }) => r),
  };
}

/** Public-safe summary of the approved analysis of a submitted report (no staff names or internal ids). */
export async function publicAnalysisSummary(reportRow) {
  if (!reportRow) return null;
  const linked = reportRow.ai_analysis_id
    ?? (await one(`SELECT analysis_id FROM lab_report_analyses WHERE lab_report_id = $1 AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 1`,
      [reportRow.lab_report_id]))?.analysis_id;
  if (!linked) {
    return { available: false, reason: reportRow.supersedes_report_id ? 'CORRECTED_REPORT' : 'LEGACY',
      message: reportRow.supersedes_report_id
        ? 'This corrected laboratory report was approved by an administrator through an audited correction; no automatic analysis report is attached to it.'
        : 'This laboratory result was approved before automatic analysis reports were introduced.' };
  }
  const a = await one('SELECT * FROM lab_report_analyses WHERE analysis_id = $1', [linked]);
  const { doc, mongoError } = await loadReportDoc(a);
  if (!doc) return { available: false, reason: 'UNAVAILABLE', message: 'The analysis report is temporarily unavailable.', detail: mongoError ? 'storage' : null };
  const r = doc.report;
  const p = r.standards.applicable;
  return {
    available: true,
    analysisCode: a.analysis_code,
    analysedAt: r.analysedAt,
    honeyCategory: p.honeyCategoryLabel,
    overallStatus: r.mlStatus === 'NOT_TRAINED' && r.overall.status === 'COMPLETED_WITH_LIMITATIONS' ? 'COMPLETED' : r.overall.status,
    standards: {
      title: p.title, standard: p.standard, version: p.version, status: p.status,
      checks: p.checks.map((c) => ({ label: c.label, value: c.value, unit: c.unit, limit: c.limit, outcome: c.outcome })),
      notRecordedCount: p.notRecorded.length,
    },
    ml: {
      status: r.mlStatus,
      predictedClass: r.mlStatus === 'PREDICTION_AVAILABLE' ? r.ml.prediction.predictedClass : null,
      modelVersion: r.ml.version ?? null,
      limitations: r.ml.limitations ?? [],
    },
    limitations: [
      `HoneyChain checks ${p.checks.length} parameters of the ${p.standard}; ${p.notRecorded.length} further parameters are tested only on the laboratory's own certificate.`,
      ...(r.mlStatus === 'PREDICTION_AVAILABLE' ? ['The ML result is a pattern match against its training data, not proof of purity or adulteration.'] : []),
      ...(a.flagged_for_review ? ['The laboratory approved this batch although a mandatory standard check failed; a written justification is on record.'] : []),
    ],
    finalDecision: a.final_decision,
    automaticOutcome: a.automatic_outcome,
    decisionMode: 'AUTOMATIC',
    approvedOn: a.decided_at,
  };
}
