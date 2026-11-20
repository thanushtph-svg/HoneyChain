// Create / edit a draft lab report, run AI decision support, then submit the lab's decision.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post, upload } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Badge, Card, DemoBadge, ErrorBox, Field, Loading, PageHeader, Table, useAction, useApi, useForm, fmtDate, fmtDateTime, today } from '../../components/ui.jsx';

const EMPTY = {
  sampleCode: '', receivedOn: today(), testedOn: today(), moisturePct: '', hmfMgKg: '', sucroseG100g: '', glucoseG100g: '', fructoseG100g: '',
  brix: '', ph: '', freeAcidityMeqKg: '', waterActivity: '', electricalConductivityMsCm: '', pollenIdentification: '', adulterationMethod: '', adulterationResult: 'NOT_TESTED',
};
const FROM_ROW = {
  sampleCode: 'sample_code', receivedOn: 'received_on', testedOn: 'tested_on', moisturePct: 'moisture_pct', hmfMgKg: 'hmf_mg_kg', sucroseG100g: 'sucrose_g_100g',
  glucoseG100g: 'glucose_g_100g', fructoseG100g: 'fructose_g_100g', brix: 'brix', ph: 'ph', freeAcidityMeqKg: 'free_acidity_meq_kg', waterActivity: 'water_activity',
  electricalConductivityMsCm: 'electrical_conductivity_ms_cm', pollenIdentification: 'pollen_identification', adulterationMethod: 'adulteration_method', adulterationResult: 'adulteration_result',
};

function Measurements({ f, disabled }) {
  const num = (name, label, step = '0.01', hint) => (
    <Field label={label} hint={hint}><input type="number" step={step} min="0" disabled={disabled} {...f.bind(name)} /></Field>
  );
  return (
    <>
      <fieldset>
        <legend>Sample</legend>
        <div className="form-grid">
          <Field label="Sample code"><input required disabled={disabled} {...f.bind('sampleCode')} /></Field>
          <span />
          <Field label="Received on"><input type="date" required max={today()} disabled={disabled} {...f.bind('receivedOn')} /></Field>
          <Field label="Tested on"><input type="date" required max={today()} disabled={disabled} {...f.bind('testedOn')} /></Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>Measured values (as on the actual test report)</legend>
        <div className="form-grid">
          {num('moisturePct', 'Moisture (%) *')}
          {num('hmfMgKg', 'HMF (mg/kg) *')}
          {num('sucroseG100g', 'Sucrose (g/100 g) *')}
          {num('glucoseG100g', 'Glucose (g/100 g)')}
          {num('fructoseG100g', 'Fructose (g/100 g)')}
          {num('brix', '°Brix')}
          {num('ph', 'pH')}
          {num('freeAcidityMeqKg', 'Free acidity (meq/kg)')}
          {num('waterActivity', 'Water activity (aw)', '0.001')}
          {num('electricalConductivityMsCm', 'Electrical conductivity (mS/cm)', '0.001')}
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

function AnalysisCard({ a, onReviewed, canReview }) {
  const r = useAction();
  const ss = a.standardsScreening;
  return (
    <div className="card" style={{ background: '#fffdf7' }}>
      <div className="card-head">
        <h3>{a.analysisType === 'QUALITY' ? 'Quality analysis' : 'Adulteration analysis'} <small className="muted">{fmtDateTime(a.createdAt)}</small></h3>
        <div className="btn-row"><Badge value={a.model.status} /> <DemoBadge show={a.isDemo} /> <Badge value={a.review.status === 'REVIEWED' ? 'REVIEWED' : 'UNREVIEWED'} kind={a.review.status === 'REVIEWED' ? 'ok' : ''} /></div>
      </div>
      {ss?.checks?.length > 0 && (
        <>
          <strong>Rule-based standards screening</strong> <span className="badge info">NOT AI</span>
          <div className="muted" style={{ fontSize: '0.8rem' }}>{ss.standard}</div>
          <Table rows={ss.checks} columns={[
            { label: 'Parameter', key: 'label' }, { label: 'Value', render: (c) => (c.value == null ? '-' : `${c.value} ${c.unit}`) },
            { label: 'Limit', render: (c) => `${c.limit} ${c.unit}` }, { label: 'Outcome', render: (c) => <Badge value={c.outcome} /> },
            { label: 'Exceptions', render: (c) => <small>{c.exceptions ?? ''}</small> },
          ]} />
        </>
      )}
      <div style={{ marginTop: 10 }}>
        <strong>ML model: {a.model.name}</strong>
        {a.model.status !== 'TRAINED' && <div className="alert warn" style={{ marginTop: 6 }}>{a.model.statusReason}</div>}
        {a.prediction && (
          <div style={{ marginTop: 6 }}>
            <Badge value={a.prediction.label} /> probability of adulteration <strong>{(a.prediction.value * 100).toFixed(1)}%</strong>
            {a.details && <span className="muted"> · {a.details.observationsAboveThreshold}/{a.details.observations} observations above threshold</span>}
          </div>
        )}
        {a.warnings?.map((w) => <div key={w} className="alert warn" style={{ marginTop: 6 }}>{w}</div>)}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>{a.disclaimer}</p>
      <ErrorBox error={r.error} />
      {canReview && a.review.status !== 'REVIEWED' && (
        <button className="btn secondary small" disabled={r.busy} onClick={async () => { if (await r.run(() => patch(`/ai/analyses/${a._id}/review`, { note: 'Reviewed by laboratory' }))) onReviewed(); }}>Mark as reviewed</button>
      )}
    </div>
  );
}

function AiPanel({ report, isLab }) {
  const analyses = useApi(`/lab/reports/${report.report_code}/ai`, [report.report_code]);
  const scans = useApi(`/lab/reports/${report.report_code}/spectral-scans`, [report.report_code]);
  const q = useAction();
  const up = useAction();
  const adu = useAction();
  const fileRef = useRef();
  const [scanId, setScanId] = useState('');

  return (
    <Card title="AI decision support">
      <p className="muted">AI output never sets the decision. The quality model and the adulteration model are separate and use different inputs.</p>
      {isLab && (
        <div className="grid grid-2">
          <div>
            <h3>Quality analysis</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>Uses the measured values above. Runs rule-based standards screening and the quality model (if one is trained).</p>
            <ErrorBox error={q.error} />
            <button className="btn" disabled={q.busy} onClick={async () => { if (await q.run(() => post(`/lab/reports/${report.report_code}/ai/quality`))) analyses.reload(); }}>{q.busy ? 'Analysing...' : 'Run quality analysis'}</button>
          </div>
          <div>
            <h3>Adulteration analysis (hyperspectral)</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>Upload a CSV of hyperspectral reflectance (128 bands, 399.40–1063.79 nm, one row per observation). Lab values are never sent to this model.</p>
            <ErrorBox error={up.error} />{up.message && <Alert kind="success">{up.message}</Alert>}
            <div className="btn-row">
              <input type="file" accept=".csv,text/csv" ref={fileRef} />
              <button className="btn secondary small" disabled={up.busy} onClick={async () => {
                const file = fileRef.current?.files?.[0];
                if (!file) return up.setError(new Error('Choose a CSV file first'));
                const form = new FormData(); form.append('file', file);
                const r = await up.run(() => upload(`/lab/reports/${report.report_code}/spectral-scans`, form), (res) => `Uploaded ${res.data.observations} observations × ${res.data.bandCount} bands`);
                if (r) { scans.reload(); setScanId(r.data.id); fileRef.current.value = ''; }
              }}>Upload scan</button>
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <select className="btn secondary" value={scanId} onChange={(e) => setScanId(e.target.value)}>
                <option value="">Choose uploaded scan...</option>
                {(scans.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.sourceFile.name} ({s.observations} obs)</option>)}
              </select>
              <button className="btn" disabled={!scanId || adu.busy} onClick={async () => { if (await adu.run(() => post(`/lab/reports/${report.report_code}/ai/adulteration`, { spectralScanId: scanId }))) analyses.reload(); }}>
                {adu.busy ? 'Analysing...' : 'Run adulteration model'}
              </button>
            </div>
            <ErrorBox error={adu.error} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        {analyses.loading && <Loading />}
        <ErrorBox error={analyses.error} />
        {analyses.data?.length === 0 && <p className="muted">No analyses run yet.</p>}
        {(analyses.data ?? []).map((a) => <AnalysisCard key={a._id} a={a} canReview={isLab} onReviewed={analyses.reload} />)}
      </div>
    </Card>
  );
}

export default function LabReportPage() {
  const { reportCode } = useParams();
  const [sp] = useSearchParams();
  const batchCode = sp.get('batch');
  const { user } = useAuth();
  const nav = useNavigate();
  const isLab = user.role === 'LAB';
  const [report, setReport] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const f = useForm(EMPTY);
  const save = useAction();
  const submit = useAction();
  const dec = useForm({ decision: 'PASS', decisionRemarks: '' });

  const load = async () => {
    if (!reportCode) return;
    try {
      const r = (await get(`/lab/reports/${reportCode}`)).data;
      setReport(r);
      f.setValues(Object.fromEntries(Object.entries(FROM_ROW).map(([k, col]) => [k, r[col] ?? (k === 'adulterationResult' ? 'NOT_TESTED' : '')])));
    } catch (e) { setLoadErr(e); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [reportCode]);

  const payload = () => Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, v === '' ? null : v]));

  if (loadErr) return <ErrorBox error={loadErr} />;
  if (reportCode && !report) return <Loading />;
  const draft = !report || report.report_state === 'DRAFT';
  const editable = isLab && draft;

  return (
    <>
      <PageHeader
        title={report ? <>Lab report {report.report_code} <DemoBadge show={report.is_demo} /></> : `New lab report for ${batchCode}`}
        subtitle={report ? <>Batch <Link to={`/app/batches/${report.batch_code}`}>{report.batch_code}</Link> · {report.lab_name}{report.tested_by_name ? ` · tested by ${report.tested_by_name}` : ''}</> : 'Enter the values from the laboratory test report. Saving creates a draft; the batch moves to IN TESTING.'}
        actions={report && <><Badge value={report.report_state} /> {report.decision && <Badge value={report.decision} />}</>}
      />
      {!draft && <Alert kind="info">This report was submitted on {fmtDateTime(report.submitted_at)} and is now read-only. Its hash is anchored on the blockchain.</Alert>}
      <Card title="Measurements">
        <ErrorBox error={save.error} />
        {save.message && <Alert kind="success">{save.message}</Alert>}
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (!report) {
            const r = await save.run(() => post('/lab/reports', { batchCode, ...payload() }), 'Draft saved');
            if (r) nav(`/app/lab/reports/${r.data.report_code}`, { replace: true });
          } else {
            const r = await save.run(() => patch(`/lab/reports/${report.report_code}`, payload()), 'Draft updated');
            if (r) load();
          }
        }}>
          <Measurements f={f} disabled={!editable} />
          {editable && <button className="btn" disabled={save.busy}>{save.busy ? 'Saving...' : report ? 'Update draft' : 'Save draft'}</button>}
        </form>
      </Card>

      {report && <AiPanel report={report} isLab={isLab} />}

      {report && editable && (
        <Card title="Laboratory decision">
          <p className="muted">This is the authoritative decision. After submitting, the report cannot be edited and the batch moves to LAB PASSED or LAB FAILED.</p>
          <ErrorBox error={submit.error} />
          <form className="form-grid" onSubmit={async (e) => {
            e.preventDefault();
            if (!window.confirm(`Submit decision ${dec.values.decision}? This cannot be undone.`)) return;
            const r = await submit.run(() => post(`/lab/reports/${report.report_code}/submit`, dec.values));
            if (r) load();
          }}>
            <Field label="Decision"><select {...dec.bind('decision')}><option>PASS</option><option>FAIL</option></select></Field>
            <Field label="Remarks" full><textarea required {...dec.bind('decisionRemarks')} /></Field>
            <div className="full"><button className="btn" disabled={submit.busy}>Submit decision</button></div>
          </form>
        </Card>
      )}
      {report && !draft && (
        <Card title="Decision">
          <dl className="kv"><dt>Decision</dt><dd><Badge value={report.decision} /></dd><dt>Remarks</dt><dd>{report.decision_remarks}</dd><dt>Tested</dt><dd>{fmtDate(report.tested_on)}</dd></dl>
        </Card>
      )}
    </>
  );
}
