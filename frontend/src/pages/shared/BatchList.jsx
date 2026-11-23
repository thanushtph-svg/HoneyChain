// Role-scoped batch table. The server decides which batches are returned (ownership / custody);
// each role's view passes its own title, preset status filter and columns.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, useBase, fmtDate, kg } from '../../components/ui.jsx';

export const ALL_STATUSES = ['CREATED', 'PENDING_PROCESSOR', 'IN_PROCESSING', 'PROCESSED', 'PENDING_LAB', 'IN_TESTING', 'LAB_PASSED', 'LAB_FAILED',
  'LAB_INCONCLUSIVE', 'PENDING_DISTRIBUTOR', 'IN_DISTRIBUTION', 'DELIVERED'];

export function BatchTable({ statuses, empty = 'No batches.', extraColumns = [], pageSize = 20, showOrigin = true }) {
  const base = useBase();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filter = status || (statuses ? statuses.join(',') : '');
  const s = useApi(`/batches${qs({ status: filter, q, page, pageSize })}`);
  const options = statuses ?? ALL_STATUSES;
  return (
    <>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <select aria-label="Status filter" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="btn secondary">
          <option value="">{statuses ? 'All shown statuses' : 'All statuses'}</option>
          {options.map((x) => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}
        </select>
        <input className="search" placeholder="Search batch code" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      <Async state={s} empty={empty}>
        {(rows, meta) => (
          <>
            <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
              { label: 'Honey', key: 'honey_type' },
              { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              ...(showOrigin ? [{ label: 'Harvest', render: (r) => <>{r.harvest_code}<br /><small>{fmtDate(r.harvest_date)} · {r.floral_source}</small></> }] : []),
              { label: 'Processor', render: (r) => r.processor_name ?? '-' },
              { label: 'Lab result', render: (r) => <Badge value={r.lab_decision} /> },
              { label: 'Status', render: (r) => <>{<Badge value={r.status} />}{r.pending_transfer_code ? <><br /><small>{r.pending_transfer_code}</small></> : null}</> },
              ...extraColumns,
            ]} />
            <Pager meta={meta} page={page} setPage={setPage} />
          </>
        )}
      </Async>
    </>
  );
}

export default function BatchList({ title = 'Batches', subtitle, statuses, empty }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <Card><BatchTable statuses={statuses} empty={empty} /></Card>
    </>
  );
}
