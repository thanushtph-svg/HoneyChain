import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post, qs } from '../../api/client.js';
import { Alert, Async, Badge, Card, ErrorBox, PageHeader, Pager, useAction, useApi, fmtDateTime, useBase } from '../../components/ui.jsx';

function Report({ r, onChange }) {
  const base = useBase();
  const a = useAction();
  const [note, setNote] = useState('');
  const act = async (status) => { if (await a.run(() => patch(`/admin/anomalies/${r._id}`, { status, note: note || `${status.toLowerCase()} by admin` }))) onChange(); };
  const ml = r.mlFindings;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{r.scope === 'SYSTEM' ? 'Scan summary' : <>Batch <Link to={base(`batches/${r.batchCode}`)}>{r.batchCode}</Link></>} <small className="muted">{fmtDateTime(r.updatedAt)}</small></h3>
        <div className="btn-row"><Badge value={r.status} />{r.containsDemoData && <span className="badge demo">INCLUDES DEMO DATA</span>}</div>
      </div>
      {r.ruleFindings.length > 0 && (
        <>
          <strong>Business-rule findings</strong> <span className="badge info">RULE-BASED, NOT AI</span>
          <ul>{r.ruleFindings.map((f, i) => <li key={i}><Badge value={f.severity} /> <code>{f.ruleId}</code> {f.message}</li>)}</ul>
        </>
      )}
      <div><strong>Isolation Forest (ML)</strong> <Badge value={ml.status} />{' '}
        {ml.status === 'INSUFFICIENT_DATA' && <span className="muted">{ml.recordCount} qualifying genuine batches; at least {ml.minimumRequired} are needed before ML scoring runs.</span>}
        {ml.status === 'SCORED' && ml.anomalyScore != null && <span>score {ml.anomalyScore.toFixed(3)} {ml.isOutlier ? <Badge value="OUTLIER" kind="bad" /> : <Badge value="NORMAL" kind="ok" />}</span>}
        {ml.statusReason && <span className="muted"> {ml.statusReason}</span>}
      </div>
      {r.resolution && <p className="muted" style={{ fontSize: '0.85rem' }}>Note: {r.resolution.note}</p>}
      <ErrorBox error={a.error} />
      {r.scope === 'BATCH' && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {['OPEN', 'ACKNOWLEDGED'].includes(r.status) && <>
            <input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--line)', font: 'inherit' }} />
            {r.status === 'OPEN' && <button className="btn secondary small" onClick={() => act('ACKNOWLEDGED')}>Acknowledge</button>}
            <button className="btn small" onClick={() => act('RESOLVED')}>Resolve</button>
            <button className="btn secondary small" onClick={() => act('DISMISSED')}>Dismiss</button>
          </>}
          {['RESOLVED', 'DISMISSED'].includes(r.status) && <button className="btn danger small" onClick={async () => { if (window.confirm('Delete this report?') && await a.run(() => del(`/admin/anomalies/${r._id}`))) onChange(); }}>Delete report</button>}
        </div>
      )}
    </div>
  );
}

export default function Anomalies() {
  const [status, setStatus] = useState('OPEN');
  const [page, setPage] = useState(1);
  const s = useApi(`/admin/anomalies${qs({ status, page })}`);
  const scan = useAction();
  return (
    <>
      <PageHeader title="Anomalies & validation alerts" subtitle="Deterministic business rules plus Isolation Forest (only with enough genuine records). Stored in MongoDB."
        actions={<button className="btn" disabled={scan.busy} onClick={async () => { if (await scan.run(() => post('/admin/anomalies/scan', {}), (r) => `Checked ${r.data.batchesChecked} batches: ${r.data.batchesWithFindings} with findings. ML: ${r.data.ml.status.replaceAll('_', ' ')} (${r.data.ml.recordCount}/${r.data.ml.minimumRequired} records)`)) s.reload(); }}>{scan.busy ? 'Scanning...' : 'Run scan now'}</button>} />
      <ErrorBox error={scan.error} />
      {scan.message && <Alert kind="success">{scan.message}</Alert>}
      <div className="tabs">
        {['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED', ''].map((x) => <button key={x || 'all'} className={status === x ? 'active' : ''} onClick={() => { setStatus(x); setPage(1); }}>{x || 'All'}</button>)}
      </div>
      <Async state={s} empty="No reports with this status.">
        {(rows, meta) => (<>{rows.map((r) => <Report key={r._id} r={r} onChange={s.reload} />)}<Pager meta={meta} page={page} setPage={setPage} /></>)}
      </Async>
      <Card title="Rules checked">
        <small className="muted">R01 harvest over-allocation · R02 processing input &gt; batch · R03 packed mass &gt; output · R04 shipped &gt; packed · R05 date order · R06 stage without lab PASS · R07 limit exceeded but PASS · R08 processing loss &gt; 10% · R09 status drift · R10 blockchain MISMATCH · R11 identical lab values across harvests · R12 unusually large single-hive harvest</small>
      </Card>
    </>
  );
}
