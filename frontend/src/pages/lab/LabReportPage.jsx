// Lab report: the lab tester enters measurements and clicks "Submit Lab Report". The system validates and saves
// them, runs the automatic analysis (Standards-Based Laboratory Compliance Check + Random Forest only if a validated
// model exists) and ASSIGNS the outcome automatically: PASS / FAIL (report submitted), INCOMPLETE or ANALYSIS_ERROR
// (report stays a draft). There is no manual PASS/FAIL control and no document upload.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Badge, Card, DemoBadge, ErrorBox, Field, Loading, PageHeader, Table, useAction, useApi, useBase, useForm, fmtDate, fmtDateTime, today } from '../../components/ui.jsx';
const FALLBACK_CATEGORIES = [
  ['BLOSSOM', 'Blossom / nectar honey (any honey not listed separately)'], ['HONEYDEW', 'Honeydew honey'],
  ['BLEND_HONEYDEW_BLOSSOM', 'Blend of honeydew honey and blossom honey'], ['CARVIA_CALLOSA', 'Carvia callosa honey'],
  ['HEATHER', 'Heather (Calluna) honey'], ['CITRUS_ROBINIA_ALFALFA', 'Citrus, false acacia, alfalfa (Codex sucrose exception)'],
  ['LAVENDER_BORAGE', 'Lavender or borage honey'], ['TROPICAL_ORIGIN', 'Honey of declared tropical origin'],
];
const FIELD_LABEL = {
  moisture_pct: 'Moisture (%)', hmf_mg_kg: 'HMF (mg/kg)', sucrose_g_100g: 'Sucrose (g/100 g)', glucose_g_100g: 'Glucose (g/100 g)',
  fructose_g_100g: 'Fructose (g/100 g)', free_acidity_meq_kg: 'Free acidity (meq/kg)', electrical_conductivity_ms_cm: 'Electrical conductivity (mS/cm)',
  brix: '°Brix', ph: 'pH', water_activity: 'Water activity (aw)', fg_sum: 'Fructose + glucose (calculated)', fg_ratio: 'Fructose / glucose ratio (calculated)',
};

const EMPTY = {
  sampleCode: '', receivedOn: today(), testedOn: today(), moisturePct: '', hmfMgKg: '', sucroseG100g: '', glucoseG100g: '', fructoseG100g: '',
  brix: '', ph: '', freeAcidityMeqKg: '', waterActivity: '', electricalConductivityMsCm: '', pollenIdentification: '', adulterationMethod: '', adulterationResult: 'NOT_TESTED',
};
const FROM_ROW = {
  sampleCode: 'sample_code', receivedOn: 'received_on', testedOn: 'tested_on', moisturePct: 'moisture_pct', hmfMgKg: 'hmf_mg_kg', sucroseG100g: 'sucrose_g_100g',
  glucoseG100g: 'glucose_g_100g', fructoseG100g: 'fructose_g_100g', brix: 'brix', ph: 'ph', freeAcidityMeqKg: 'free_acidity_meq_kg', waterActivity: 'water_activity',
  electricalConductivityMsCm: 'electrical_conductivity_ms_cm', pollenIdentification: 'pollen_identification', adulterationMethod: 'adulteration_method', adulterationResult: 'adulteration_result',
};

function Measurements({ f, disabled, hideSample = false }) {
  const num = (name, label, unit, max, step = '0.01', hint) => (
    <Field label={label} hint={hint}>
      <div className="input-unit">
        <input type="number" inputMode="decimal" step={step} min="0" max={max} disabled={disabled} aria-label={label} {...f.bind(name)} />
        <span className="unit">{unit}</span>
      </div>
    </Field>
  );
  return (
    <>
      {!hideSample && <fieldset>
        <legend>Sample</legend>
        <div className="form-grid">
          <Field label="Sample code"><input required disabled={disabled} {...f.bind('sampleCode')} /></Field>
          <span />
          <Field label="Received on"><input type="date" required max={today()} disabled={disabled} {...f.bind('receivedOn')} /></Field>
          <Field label="Tested on"><input type="date" required max={today()} disabled={disabled} {...f.bind('testedOn')} /></Field>
        </div>
      </fieldset>}
      <fieldset>
        <legend>Measured values (as on the actual test report) - * required for approval</legend>
        <div className="form-grid">
          {num('moisturePct', 'Moisture (%) *', '% by mass', 100)}
          {num('hmfMgKg', 'HMF (mg/kg) *', 'mg/kg', 99999)}
          {num('sucroseG100g', 'Sucrose (g/100 g) *', 'g/100 g', 100)}
          {num('glucoseG100g', 'Glucose (g/100 g) *', 'g/100 g', 100)}
          {num('fructoseG100g', 'Fructose (g/100 g) *', 'g/100 g', 100)}
          {num('freeAcidityMeqKg', 'Free acidity (meq/kg) *', 'meq/kg', 9999)}
          {num('electricalConductivityMsCm', 'Electrical conductivity (mS/cm) *', 'mS/cm', 999, '0.001', 'In mS/cm (not µS/cm)')}
          {num('ph', 'pH', 'pH', 14)}
          {num('brix', '°Brix', '°Bx', 100)}
          {num('waterActivity', 'Water activity (aw)', 'aw', 1, '0.001')}
          <Field label="Pollen identification *" full><textarea required disabled={disabled} {...f.bind('pollenIdentification')} /></Field>
          <Field label="Adulteration test result">
            <select disabled={disabled} {...f.bind('adulterationResult')}>
              {['NOT_TESTED', 'NOT_DETECTED', 'DETECTED', 'INCONCLUSIVE'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Adulteration test method" hint="Required when a result is recorded (e.g. C4 sugar SCIRA, NMR)"><input disabled={disabled} {...f.bind('adulterationMethod')} /></Field>
        </div>
      </fieldset>
    </>
  );
}

const fmtVal = (v, unit) => (v == null ? <span className="muted">not provided</span> : `${v}${unit && unit !== 'ratio' ? ` ${unit}` : ''}`);

function StandardsTable({ s }) {
  return (
    <>
      <div className="muted" style={{ fontSize: '0.82rem', marginBottom: 6 }}>
        {s.standard} · {s.version} · honey category: <strong>{s.honeyCategoryLabel}</strong><br />{s.reference}
      </div>
      <Table rows={s.checks} rowKey={(c) => c.parameter} columns={[
        { label: 'Parameter', render: (c) => <>{c.label}{c.mandatory ? ' *' : ''}</> },
        { label: 'Measured', render: (c) => fmtVal(c.value, c.unit) },
        { label: 'Permitted limit', render: (c) => <>{c.limit}<br /><small className="muted">{c.ruleSource}</small></> },
        { label: 'Result', render: (c) => <Badge value={c.outcome} /> },
        { label: 'Explanation', render: (c) => <small>{c.explanation}</small> },
      ]} />
    </>
  );
}

/** The combined automatic analysis report */
const OUTCOME_TEXT = {
  PASS: 'All mandatory applicable standards are satisfied and the required measurements are present and valid.',
  FAIL: 'At least one mandatory applicable regulatory requirement is violated.',
  INCOMPLETE: 'Mandatory measurements are missing or invalid. The report stays a draft: complete the values and submit again.',
  ANALYSIS_ERROR: 'The analysis could not be completed. Nothing was decided; the report stays a draft. Retry.',
};

function AnalysisReport({ a }) {
  const r = a.report;
  if (!r) return <Alert kind="warn">The report document could not be loaded{a.mongoError ? `: ${a.mongoError}` : ''}.</Alert>;
  const p = r.standards.applicable;
  const ml = r.ml;
  // An untrained model is not part of the analysis (also cleans up reports saved before this change)
  const showMl = ml && ml.status !== 'NOT_TRAINED';
  const overall = !showMl && r.overall.status === 'COMPLETED_WITH_LIMITATIONS' ? 'COMPLETED' : r.overall.status;
  const recs = r.recommendations.filter((x) => !/No ML prediction is available|Reports & supporting documents|failed-standard policy/.test(x));
  return (
    <div className="analysis-report">
      <div className={`outcome outcome-${(a.automatic_outcome ?? '').toLowerCase()}`}>
        <div className="muted" style={{ fontSize: '0.8rem' }}>Laboratory outcome (assigned automatically)</div>
        <div className="outcome-value">{(a.automatic_outcome ?? '-').replaceAll('_', ' ')}</div>
        <div style={{ fontSize: '0.85rem' }}>{OUTCOME_TEXT[a.automatic_outcome] ?? ''}</div>
        {p.failedTests.length > 0 && <div style={{ fontSize: '0.85rem' }}><strong>Failed:</strong> {p.checks.filter((c) => c.outcome === 'FAIL').map((c) => `${c.label} ${c.value}${c.unit === 'ratio' ? '' : ` ${c.unit}`} (limit ${c.limit})`).join('; ')}</div>}
      </div>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <span>Overall report: <Badge value={overall} /></span>
        <span>Standards: <Badge value={r.standardsStatus} /></span>
        {showMl && <span>ML: <Badge value={r.mlStatus} /></span>}
        <small className="muted">{a.analysis_code} · analysed {fmtDateTime(r.analysedAt)} · rules {r.engine?.rulesetVersion}</small>
      </div>

      <h3>1. Laboratory measurements</h3>
      <dl className="kv">
        <dt>Batch / report</dt><dd>{r.batch.code} · {r.labReport.code}</dd>
        <dt>Honey type (declared)</dt><dd>{r.honeyType ?? '-'}</dd>
        {r.measurements.map((m) => <FragmentKV key={m.field} k={FIELD_LABEL[m.field] ?? m.field} v={m.value == null ? <span className="muted">not provided</span> : m.value} />)}
      </dl>

      <h3 style={{ marginTop: 16 }}>2. Regulatory compliance: {p.title} <span className="badge info">RULES - DECIDES THE OUTCOME</span></h3>
      <StandardsTable s={p} />
      {r.missingTests.length > 0 && <Alert kind="warn"><strong>Missing tests:</strong> {r.missingTests.join(', ')}</Alert>}
      <details style={{ margin: '6px 0' }}>
        <summary>Not recorded by HoneyChain ({p.notRecorded.length} parameters of the {p.standard}) - confirm on the lab certificate</summary>
        <ul>{p.notRecorded.map((x) => <li key={x.label}>{x.label}: {x.limit}</li>)}</ul>
      </details>
      {r.standards.reference && (
        <details style={{ margin: '6px 0' }}>
          <summary>Reference standard (informational): {r.standards.reference.standard} - <Badge value={r.standards.reference.status} /></summary>
          <StandardsTable s={r.standards.reference} />
        </details>
      )}

      {/* ML section only when a trained model is in use (an untrained model is not shown at all) */}
      {showMl && (
        <>
          <h3 style={{ marginTop: 16 }}>ML analysis (Random Forest) <span className="badge">INFORMATIONAL - NEVER CHANGES THE OUTCOME</span></h3>
          {ml.status === 'PREDICTION_AVAILABLE' ? (
            <div>
              <p>Predicted class: <Badge value={ml.prediction.predictedClass} kind="info" /> · model {ml.model} v{ml.version} · {fmtDateTime(ml.predictedAt)}</p>
              {ml.prediction.probabilities
                ? <p>Class probabilities: {Object.entries(ml.prediction.probabilities).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(' · ')}</p>
                : <p className="muted">{ml.prediction.probabilitiesNote}</p>}
              {ml.modelTestPerformance && <p className="muted" style={{ fontSize: '0.83rem' }}>Model test performance (not the confidence of this prediction): balanced accuracy {ml.modelTestPerformance.test_balanced_accuracy} on {ml.modelTestPerformance.n_test} held-out samples.</p>}
              <ul>{(ml.limitations ?? []).map((l) => <li key={l}><small>{l}</small></li>)}</ul>
            </div>
          ) : (
            <Alert kind="warn"><Badge value={ml.status} /> {ml.reason}</Alert>
          )}
        </>
      )}

      <h3 style={{ marginTop: 16 }}>3. Overall analysis</h3>
      <p><Badge value={overall} /> {r.overall.summary}</p>

      <h3>4. Warnings</h3>
      <ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>

      <h3>5. Recommendations</h3>
      <ul>{recs.map((w) => <li key={w}>{w}</li>)}</ul>
      <p className="muted" style={{ fontSize: '0.8rem' }}>{r.disclaimer}</p>
    </div>
  );
}
const FragmentKV = ({ k, v }) => <><dt>{k}</dt><dd>{v}</dd></>;

function CorrectionRequest({ report, onDone }) {
  const f = useForm(Object.fromEntries(Object.entries(FROM_ROW).filter(([k]) => k !== 'sampleCode').map(([k, col]) => [k, report[col] ?? ''])));
  const [reason, setReason] = useState('');
  const a = useAction();
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn secondary" onClick={() => setOpen(true)}>Request an audited correction</button>;
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const changes = {};
      for (const [k, v] of Object.entries(f.values)) {
        const old = report[FROM_ROW[k]] ?? '';
        if (String(v ?? '') !== String(old)) changes[k] = v === '' ? null : v;
      }
      if (!Object.keys(changes).length) return a.setError(new Error('Change at least one value'));
      if (!window.confirm(`Submit a correction request for ${Object.keys(changes).join(', ')}? An administrator must approve it; the original report stays on record.`)) return;
      const r = await a.run(() => post(`/lab/reports/${report.report_code}/corrections`, { reason, changes }), (res) => `Correction ${res.data.correction_code} sent for review`);
      if (r) { setOpen(false); onDone(); }
    }}>
      <Alert kind="warn">The submitted report is never edited. Only measured values can be corrected; if an administrator approves, the outcome is recomputed automatically from the corrected values and a new report is created and anchored.</Alert>
      <Measurements f={f} disabled={false} hideSample />
      <div className="form-grid">
        <Field label="Reason for the correction (min. 10 characters)" full><textarea required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <ErrorBox error={a.error} />
      <div className="btn-row"><button className="btn" disabled={a.busy}>Send correction for review</button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

export default function LabReportPage() {
  const { reportCode } = useParams();
  const [sp] = useSearchParams();
  const batchCode = sp.get('batch');
  const { user } = useAuth();
  const base = useBase();
  const nav = useNavigate();
  const isLab = user.role === 'LAB_TESTER';
  const [report, setReport] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [view, setView] = useState(null);
  const [viewErr, setViewErr] = useState(null);
  const [category, setCategory] = useState('BLOSSOM');
  const options = useApi(isLab || user.role === 'ADMIN' ? '/ai/lab-analysis/options' : null);
  const f = useForm(EMPTY);
  const save = useAction();
  const analysing = useAction();
  const [msg, setMsg] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const loadView = async (code) => {
    try {
      const v = (await get(`/lab/reports/${code}/analysis`)).data;
      setView(v); setViewErr(null);
      if (v.latest?.honey_category) setCategory(v.latest.honey_category);
    } catch (e) { setViewErr(e); }
  };
  const load = async () => {
    if (!reportCode) return;
    try {
      const r = (await get(`/lab/reports/${reportCode}`)).data;
      setReport(r);
      f.setValues(Object.fromEntries(Object.entries(FROM_ROW).map(([k, col]) => [k, r[col] ?? (k === 'adulterationResult' ? 'NOT_TESTED' : '')])));
      if (isLab || user.role === 'ADMIN') await loadView(r.report_code);
    } catch (e) { setLoadErr(e); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setReport(null); setView(null); load(); }, [reportCode]);

  const payload = () => Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, v === '' ? null : v]));

  /** Submit Lab Report = save the values, then run the automatic analysis (no separate AI button). */
  const submitForAnalysis = async () => {
    setMsg(null);
    let code = report?.report_code;
    const saved = await save.run(() => (code ? patch(`/lab/reports/${code}`, payload()) : post('/lab/reports', { batchCode, ...payload() })));
    if (!saved) return;
    code = saved.data.report_code ?? code;
    const r = await analysing.run(() => post(`/lab/reports/${code}/analysis`, { honeyCategory: category }));
    if (r) setOutcome({ value: r.data.automaticOutcome, batchStatus: r.data.submission?.batchStatus ?? null });
    if (!report) { nav(base(`reports/${code}`), { replace: true }); return; }
    if (r) setView(r.data);
    await load();
  };

  if (loadErr) return <ErrorBox error={loadErr} />;
  if (reportCode && !report) return <Loading />;
  const draft = !report || report.report_state === 'DRAFT';
  const editable = isLab && draft;
  const batchLink = (code) => <Link to={base(`batches/${code}`)}>{code}</Link>;
  const latest = view?.latest;
  const categories = options.data?.categories?.map((c) => [c.key, c.label]) ?? FALLBACK_CATEGORIES;

  return (
    <>
      <PageHeader
        title={report ? <>Lab report {report.report_code} <DemoBadge show={report.is_demo} /></> : `New lab report for ${batchCode}`}
        subtitle={report ? <>Batch {batchLink(report.batch_code)} · {report.lab_name}{report.tested_by_name ? ` · tested by ${report.tested_by_name}` : ''}{report.request_code ? ` · request ${report.request_code}` : ''}</> : 'Enter the values from the laboratory test report, then submit it for automatic analysis.'}
        actions={report && <><Badge value={report.report_state} /> {report.decision && <Badge value={report.decision} />}</>}
      />
      {msg && <Alert kind="success">{msg}</Alert>}
      {outcome && (
        <Alert kind={outcome.value === 'PASS' ? 'success' : outcome.value === 'FAIL' ? 'error' : 'warn'}>
          Automatic outcome: <strong>{String(outcome.value).replaceAll('_', ' ')}</strong>.{' '}
          {outcome.batchStatus ? `The report was submitted automatically; batch is now ${outcome.batchStatus.replaceAll('_', ' ')}.` : OUTCOME_TEXT[outcome.value]}
        </Alert>
      )}
      {report?.report_state === 'SUBMITTED' && <Alert kind="info">Submitted {fmtDateTime(report.submitted_at)}. This report is read-only and its hash is anchored on the blockchain.{report.supersedes_report_code ? ` It corrects ${report.supersedes_report_code}.` : ''}</Alert>}
      {report?.report_state === 'SUPERSEDED' && <Alert kind="warn">Superseded on {fmtDateTime(report.superseded_at)} by {report.superseded_by_report_code} through an approved correction. Kept unchanged as evidence.</Alert>}

      <Card title="Laboratory measurements">
        <ErrorBox error={save.error} />
        {save.message && <Alert kind="success">{save.message}</Alert>}
        <form onSubmit={async (e) => { e.preventDefault(); await submitForAnalysis(); }}>
          <Measurements f={f} disabled={!editable} />
          {editable && (
            <>
              <div className="form-grid">
                <Field label="Honey category (selects the standard's limits)" hint="Exceptions apply to honeydew, Carvia callosa, blends and other listed honeys">
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </Field>
              </div>
              <div className="btn-row">
                <button className="btn" disabled={save.busy || analysing.busy}>{analysing.busy ? 'AI Analysis in Progress...' : 'Submit Lab Report'}</button>
                <button type="button" className="btn secondary" disabled={save.busy || analysing.busy} onClick={async () => {
                  if (!report) {
                    const r = await save.run(() => post('/lab/reports', { batchCode, ...payload() }), 'Draft saved');
                    if (r) nav(base(`reports/${r.data.report_code}`), { replace: true });
                  } else if (await save.run(() => patch(`/lab/reports/${report.report_code}`, payload()), 'Draft updated')) load();
                }}>Save draft only</button>
              </div>
              <p className="muted" style={{ fontSize: '0.83rem' }}>Submitting validates and saves the values, runs the Standards-Based Laboratory Compliance Check and the ML model (only if a validated model exists), and assigns the outcome automatically: <strong>PASS</strong> or <strong>FAIL</strong> submits the report; <strong>INCOMPLETE</strong> or <strong>ANALYSIS ERROR</strong> keeps it a draft. You do not choose PASS or FAIL.</p>
            </>
          )}
        </form>
      </Card>

      {analysing.busy && <Card><Loading text="AI Analysis in Progress - checking standards and generating the report..." /></Card>}
      <ErrorBox error={analysing.error} />

      {report && (isLab || user.role === 'ADMIN') && (
        <Card title="Automatic analysis report" actions={latest && <Badge value={latest.status} />}>
          <ErrorBox error={viewErr} />
          {view?.legacy && <Alert kind="info">This report was approved before automatic analysis reports were introduced (legacy record). No analysis report is attached.</Alert>}
          {!view?.legacy && !latest && <p className="muted">No analysis yet. Enter the measurements and click <strong>Submit Lab Report</strong>.</p>}
          {latest?.status === 'FAILED' && (
            <Alert kind="error">
              <strong>ANALYSIS ERROR</strong> - analysis {latest.analysis_code} failed (attempt {latest.attempts}): {latest.failure_reason}. The measurements are saved; nothing was decided.
              {editable && <div style={{ marginTop: 8 }}><button className="btn small" disabled={analysing.busy} onClick={submitForAnalysis}>Retry analysis</button></div>}
            </Alert>
          )}
          {latest?.status === 'PENDING' && <Alert kind="info">Analysis {latest.analysis_code} is in progress. <button className="btn secondary small" onClick={() => loadView(report.report_code)}>Refresh</button></Alert>}
          {latest?.stale && <Alert kind="warn"><Badge value="STALE" /> The measurements were changed after this analysis. Click <strong>Submit Lab Report</strong> to analyse the current values.</Alert>}
          {latest?.status === 'COMPLETED' && <AnalysisReport a={latest} />}
          {view?.history?.length > 1 && (
            <details><summary>Analysis history ({view.history.length})</summary>
              <Table rows={view.history} rowKey={(h) => h.analysis_id} columns={[
                { label: 'Analysis', key: 'analysis_code' }, { label: 'Status', render: (h) => <Badge value={h.status} /> },
                { label: 'Standards', render: (h) => <Badge value={h.standards_status} /> }, { label: 'ML', render: (h) => <Badge value={h.ml_status} /> },
                { label: 'Category', key: 'honey_category' }, { label: 'Created', render: (h) => fmtDateTime(h.created_at) },
              ]} />
            </details>
          )}
        </Card>
      )}

      {report && !draft && (
        <Card title="Laboratory outcome">
          <dl className="kv">
            <dt>Outcome</dt><dd><Badge value={report.decision} /> {latest?.decided_at ? <small className="muted">assigned automatically</small> : null}</dd>
            <dt>Basis</dt><dd>{report.decision_remarks}</dd><dt>Tested</dt><dd>{fmtDate(report.tested_on)}</dd>
            {latest?.decided_at && <><dt>Analysis</dt><dd>{latest.analysis_code} · {fmtDateTime(latest.decided_at)} · submitted by {latest.decided_by_name}</dd></>}
          </dl>
          {isLab && report.report_state === 'SUBMITTED' && <div style={{ marginTop: 12 }}><CorrectionRequest report={report} onDone={() => { setMsg('Correction request sent to the administrator for review.'); load(); }} /></div>}
        </Card>
      )}
    </>
  );
}
