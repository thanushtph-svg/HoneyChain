import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, fmtDate } from '../../components/ui.jsx';

export default function LabReports() {
  const [page, setPage] = useState(1);
  const [decision, setDecision] = useState('');
  const s = useApi(`/lab/reports${qs({ page, decision })}`);
  return (
    <>
      <PageHeader title="Testing history" />
      <Card>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select className="btn secondary" value={decision} onChange={(e) => { setDecision(e.target.value); setPage(1); }}>
            <option value="">All decisions</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option>
          </select>
        </div>
        <Async state={s} empty="No reports yet.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.report_code} columns={[
                { label: 'Report', render: (r) => <><Link to={`/app/lab/reports/${r.report_code}`}>{r.report_code}</Link> <DemoBadge show={r.is_demo} /></> },
                { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
                { label: 'Sample', key: 'sample_code' },
                { label: 'Tested', render: (r) => fmtDate(r.tested_on) },
                { label: 'Moisture %', key: 'moisture_pct' }, { label: 'HMF', key: 'hmf_mg_kg' }, { label: 'Sucrose', key: 'sucrose_g_100g' },
                { label: 'Tested by', key: 'tested_by_name' },
                { label: 'State', render: (r) => <Badge value={r.report_state} /> },
                { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
