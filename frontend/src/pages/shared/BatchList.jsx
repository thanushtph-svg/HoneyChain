import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, fmtDate, kg } from '../../components/ui.jsx';

const STATUSES = ['', 'CREATED', 'IN_TESTING', 'LAB_PASSED', 'LAB_FAILED', 'PROCESSED', 'IN_DISTRIBUTION', 'DELIVERED'];
const SCOPE = {
  ADMIN: 'All batches in the system',
  BEEKEEPER: 'Batches from your hives',
  LAB: 'Batches assigned to or tested by your laboratory',
  PROCESSOR: 'Batches ready for processing or processed by your unit',
  DISTRIBUTOR: 'Batches ready for dispatch or shipped by you',
};

export default function BatchList() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const s = useApi(`/batches${qs({ status, q, page })}`);
  return (
    <>
      <PageHeader title="Batches" subtitle={SCOPE[user.role]} />
      <Card>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="btn secondary">
            {STATUSES.map((x) => <option key={x} value={x}>{x ? x.replaceAll('_', ' ') : 'All statuses'}</option>)}
          </select>
          <input placeholder="Search batch code" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }}
            style={{ padding: '7px 10px', borderRadius: 9, border: '1px solid var(--line)', font: 'inherit' }} />
        </div>
        <Async state={s} empty="No batches match.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
                { label: 'Batch', render: (r) => <><Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
                { label: 'Honey', key: 'honey_type' },
                { label: 'Qty', render: (r) => kg(r.quantity_kg) },
                { label: 'Harvest', render: (r) => <>{r.harvest_code}<br /><small>{fmtDate(r.harvest_date)} · {r.floral_source}</small></> },
                { label: 'Beekeeper', key: 'beekeeper_name' },
                { label: 'Lab', key: 'assigned_lab_name' },
                { label: 'Status', render: (r) => <Badge value={r.status} /> },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
