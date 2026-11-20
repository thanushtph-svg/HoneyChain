// AI decision support for lab reports. Stores every analysis in MongoDB.
// Rule-based standards screening and ML model output are kept in separate fields.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ok, created } from '../utils/http.js';
import { notFound, unprocessable } from '../utils/errors.js';
import { one } from '../db/pg.js';
import { collection, toObjectId } from '../db/mongo.js';
import { insertWithOutbox, logActivity } from '../services/activityLog.js';
import { screenReport } from '../services/standards.js';
import { ai } from '../services/aiClient.js';
import { getReadableReport } from './lab.routes.js';

const r = Router();
r.use(['/lab', '/ai'], requireAuth);

export const LAB_DISCLAIMER =
  "Decision support only. The laboratory's measured results and decision are authoritative. This is not a certification.";

const QUALITY_FEATURES = ['moisture_pct', 'hmf_mg_kg', 'sucrose_g_100g', 'glucose_g_100g', 'fructose_g_100g', 'brix', 'ph',
  'free_acidity_meq_kg', 'water_activity', 'electrical_conductivity_ms_cm'];

function modelBlock(resp, fallbackName) {
  if (!resp.ok) {
    return { model: { name: fallbackName, version: null, status: 'SERVICE_UNAVAILABLE', statusReason: resp.error, datasetId: null, task: null }, prediction: null };
  }
  const d = resp.data;
  return {
    model: { name: d.model, version: d.version ?? null, status: d.status, statusReason: d.reason ?? null, datasetId: d.datasetId ?? null, task: d.task ?? null },
    prediction: d.status === 'TRAINED' ? d.prediction : null, // never stored unless a trained model produced it
    extra: d.details ?? null,
    reliability: d.reliability ?? null,
  };
}

async function saveAnalysis(doc) {
  const s = await insertWithOutbox('ai_analysis_results', doc);
  return { ...doc, _id: s.id ? String(s.id) : null, saved: s.saved, warnings: s.saved ? doc.warnings : [...doc.warnings, 'MongoDB unavailable: result queued for saving, not yet stored'] };
}

r.post('/lab/reports/:reportCode/ai/quality', requireRole('LAB'), async (req, res) => {
  const rep = await getReadableReport(req.user, req.params.reportCode);
  const features = Object.fromEntries(QUALITY_FEATURES.map((k) => [k, rep[k] == null ? null : Number(rep[k])]));
  const resp = await ai.predictQuality(features);
  const mb = modelBlock(resp, 'honey-quality');
  const warnings = [];
  if (mb.model.status === 'NOT_TRAINED') warnings.push('Quality model is not trained - validated labelled dataset required. Only rule-based screening is shown.');
  const doc = {
    analysisType: 'QUALITY',
    batchId: rep.batch_id,
    batchCode: rep.batch_code,
    labReportId: rep.lab_report_id,
    spectralScanId: null,
    inputSnapshot: features,
    standardsScreening: screenReport(rep),
    model: mb.model,
    prediction: mb.prediction,
    details: mb.extra ?? null,
    warnings,
    disclaimer: LAB_DISCLAIMER,
    requestedBy: req.user.id,
    createdAt: new Date(),
    review: { status: 'UNREVIEWED', reviewedBy: null, reviewedAt: null, note: null },
    isDemo: rep.is_demo,
  };
  const out = await saveAnalysis(doc);
  await logActivity(req, 'AI_QUALITY_ANALYSIS', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { modelStatus: mb.model.status });
  created(res, out);
});

r.post(
  '/lab/reports/:reportCode/ai/adulteration',
  requireRole('LAB'),
  validateBody(z.object({ spectralScanId: z.string().min(1) })),
  async (req, res) => {
    const rep = await getReadableReport(req.user, req.params.reportCode);
    const id = toObjectId(req.valid.spectralScanId);
    if (!id) throw unprocessable('INVALID_ID', 'Invalid spectral scan id');
    const scan = await (await collection('spectral_scans')).findOne({ _id: id, labReportId: rep.lab_report_id });
    if (!scan) throw notFound('Spectral scan');
    // ONLY spectral features go to this model - never moisture/sucrose/etc.
    const resp = await ai.predictAdulteration({
      wavelengthsNm: scan.wavelengthsNm,
      preprocessing: scan.preprocessing,
      observations: scan.acquisitions.map((a) => a.values),
    });
    const mb = modelBlock(resp, 'honey-adulteration');
    if (!resp.ok && resp.httpStatus === 422) { mb.model.status = 'INPUT_INCOMPATIBLE'; }
    const warnings = [];
    if (mb.reliability?.level) warnings.push(`Model reliability: ${mb.reliability.level}. ${mb.reliability.summary}`);
    const doc = {
      analysisType: 'ADULTERATION',
      batchId: rep.batch_id,
      batchCode: rep.batch_code,
      labReportId: rep.lab_report_id,
      spectralScanId: scan._id,
      inputSnapshot: { bandCount: scan.bandCount, observations: scan.acquisitions.length, sourceFile: scan.sourceFile.name },
      standardsScreening: { kind: 'RULE_BASED', standard: 'n/a for spectral input', source: null, checks: [] },
      model: mb.model,
      prediction: mb.prediction,
      details: mb.extra ?? null,
      warnings,
      disclaimer: LAB_DISCLAIMER,
      requestedBy: req.user.id,
      createdAt: new Date(),
      review: { status: 'UNREVIEWED', reviewedBy: null, reviewedAt: null, note: null },
      isDemo: Boolean(rep.is_demo || scan.isDemo),
    };
    const out = await saveAnalysis(doc);
    out.spectralScanId = String(scan._id);
    await logActivity(req, 'AI_ADULTERATION_ANALYSIS', { type: 'lab_report', id: rep.lab_report_id, code: rep.report_code }, 'SUCCESS', { modelStatus: mb.model.status });
    created(res, out);
  },
);

r.get('/lab/reports/:reportCode/ai', requireRole('LAB', 'ADMIN'), async (req, res) => {
  const rep = await getReadableReport(req.user, req.params.reportCode);
  const docs = await (await collection('ai_analysis_results')).find({ labReportId: rep.lab_report_id }).sort({ createdAt: -1 }).toArray();
  ok(res, docs.map((d) => ({ ...d, _id: String(d._id), spectralScanId: d.spectralScanId ? String(d.spectralScanId) : null })));
});

r.patch('/ai/analyses/:id/review', requireRole('LAB'), validateBody(z.object({ note: z.string().trim().max(1000).optional() })), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) throw notFound('Analysis');
  const col = await collection('ai_analysis_results');
  const d = await col.findOne({ _id: id });
  if (!d) throw notFound('Analysis');
  // the analysis must belong to a report of the user's own laboratory
  const rep = await one('SELECT report_code FROM lab_reports WHERE lab_report_id = $1', [d.labReportId]);
  if (!rep) throw notFound('Analysis');
  await getReadableReport(req.user, rep.report_code);
  await col.updateOne({ _id: id }, { $set: { review: { status: 'REVIEWED', reviewedBy: req.user.id, reviewedAt: new Date(), note: req.valid.note ?? null } } });
  await logActivity(req, 'AI_ANALYSIS_REVIEWED', { type: 'ai_analysis', id: String(id) });
  ok(res, { id: String(id), review: 'REVIEWED' });
});

r.delete('/ai/analyses/:id', requireRole('ADMIN'), async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) throw notFound('Analysis');
  const r2 = await (await collection('ai_analysis_results')).deleteOne({ _id: id });
  if (!r2.deletedCount) throw notFound('Analysis');
  await logActivity(req, 'AI_ANALYSIS_DELETED', { type: 'ai_analysis', id: String(id) });
  ok(res, { deleted: true });
});

r.get('/ai/models', async (_req, res) => {
  const m = await ai.models();
  if (!m.ok) return ok(res, { available: false, error: m.error, models: [] });
  ok(res, { available: true, models: m.data.models });
});

export default r;
