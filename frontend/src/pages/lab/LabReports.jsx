// Lab report lists: drafts to submit ("Submit Results"), submitted reports, and correction requests.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, useBase, fmtDate, fmtDateTime } from '../../components/ui.jsx';

export function ReportTable({ state, showLab = false, linkBase = 'reports', empty = 'No reports.' }) {
  const base = useBase();
  const [page, setPage] = useState(1);
  const [decision, setDecision] = useState('');
  const s = useApi(`/lab/reports${qs({ page, decision, state })}`);
  return (
    <>
      {state !== 'DRAFT' && (
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select aria-label="Decision filter" className="btn secondary" value={decision} onChange={(e) => { setDecision(e.target.value); setPage(1); }}>
            <option value="">All decisions</option>{['PASS', 'FAIL', 'INCONCLUSIVE'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
      )}
      <Async state={s} empty={empty}>
        {(rows, meta) => (
          <>
            <Table rows={rows} rowKey={(r) => r.report_code} columns={[
              { label: 'Report', render: (r) => <><Link to={base(`${linkBase}/${r.report_code}`)}>{r.report_code}</Link> <DemoBadge show={r.is_demo} /></> },
              { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link><br /><Badge value={r.batch_status} /></> },
              ...(showLab ? [{ label: 'Lab', key: 'lab_name' }] : []),
              { label: 'Sample', key: 'sample_code' },
              { label: 'Tested', render: (r) => fmtDate(r.tested_on) },
              { label: 'Moisture / HMF / Sucrose', render: (r) => `${r.moisture_pct} / ${r.hmf_mg_kg} / ${r.sucrose_g_100g}` },
              { label: 'Tested by', key: 'tested_by_name' },
              { label: 'Docs', key: 'document_count' },
              { label: 'State', render: (r) => <><Badge value={r.report_state} />{r.correction_status ? <><br /><small>correction {r.correction_status.toLowerCase()}</small></> : null}</> },
              { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
            ]} />
            <Pager meta={meta} page={page} setPage={setPage} />
          </>
        )}
      </Async>
    </>
  );
}

export function CorrectionTable({ status, actions }) {
  const base = useBase();
  const s = useApi(`/lab-corrections${qs({ status })}`);
  return (
    <Async state={s} empty="No correction requests.">
      {(rows) => <Table rows={rows} rowKey={(r) => r.correction_code} columns={[
        { label: 'Correction', render: (r) => <>{r.correction_code}<br /><small>{fmtDateTime(r.requested_at)} · {r.requested_by_name}</small></> },
        { label: 'Report / batch', render: (r) => <>{r.report_code}<br /><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link></> },
        { label: 'Reason', key: 'reason' },
        { label: 'Change', render: (r) => Object.entries(r.proposed_changes).map(([k, v]) => <div key={k}><small>{k}: <s>{String(r.previous_values[k] ?? '-')}</s> → <strong>{String(v ?? '-')}</strong></small></div>) },
        { label: 'Status', render: (r) => <><Badge value={r.status} />{r.review_note ? <><br /><small>“{r.review_note}” - {r.reviewed_by_name}</small></> : null}</> },
        { label: 'New report', render: (r) => r.new_report_code ?? '-' },
        ...(actions ? [{ label: '', render: (r) => actions(r, s.reload) }] : []),
      ]} />}
    </Async>
  );
}

export function SubmitResults() {
  return (
    <>
      <PageHeader title="Submit results" subtitle="Draft reports. Open a draft to check the standards screening and submit PASS, FAIL or INCONCLUSIVE." />
      <Card><ReportTable state="DRAFT" empty="No drafts. Start from Pending tests." /></Card>
    </>
  );
}

export default function LabReports() {
  const base = useBase();
  return (
    <>
      <PageHeader title="Lab reports" subtitle="Submitted results are permanent and anchored. Mistakes are fixed through an audited correction reviewed by an administrator."
        actions={<Link className="btn secondary" to={base('ai-models')}>AI models</Link>} />
      <Card title="Submitted reports"><ReportTable state="SUBMITTED" empty="No submitted reports yet." /></Card>
      <Card title="Correction requests"><CorrectionTable /></Card>
      <Card title="Superseded reports (kept as evidence)"><ReportTable state="SUPERSEDED" empty="No superseded reports." /></Card>
    </>
  );
}
