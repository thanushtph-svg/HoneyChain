import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, useBase, fmtDate, kg } from '../../components/ui.jsx';
import { TransferTable } from '../shared/Transfers.jsx';

export function ProcessingRecords({ showProcessor = false }) {
  const base = useBase();
  const [page, setPage] = useState(1);
  const s = useApi(`/processing?page=${page}`);
  return (
    <Async state={s} empty="No processing records yet.">
      {(rows, meta) => (
        <>
          <Table rows={rows} rowKey={(r) => r.processing_code} columns={[
            { label: 'Record', render: (r) => <>{r.processing_code} <DemoBadge show={r.is_demo} /></> },
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link><br /><Badge value={r.batch_status} /></> },
            ...(showProcessor ? [{ label: 'Processor', key: 'processor_name' }] : []),
            { label: 'Date', render: (r) => fmtDate(r.processing_date) },
            { label: 'Type', key: 'method' },
            { label: 'Recorded by', key: 'recorded_by_name' },
            { label: 'In → out', render: (r) => <>{kg(r.input_quantity_kg)} → {kg(r.output_quantity_kg)}<br /><small>loss {kg(r.loss_kg)}</small></> },
            { label: 'Packed', render: (r) => `${r.units_packed} × ${r.unit_size_g} g ${r.packaging_type}` },
            { label: 'Best before', render: (r) => fmtDate(r.best_before) },
          ]} />
          <Pager meta={meta} page={page} setPage={setPage} />
        </>
      )}
    </Async>
  );
}

export default function ProcessingHistory() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="History" subtitle="Processing records and every batch received or rejected by your unit" />
      <Card title="Processing records"><ProcessingRecords showProcessor={user.role === 'ADMIN'} /></Card>
      <Card title="Incoming transfers (accepted, rejected, cancelled)"><TransferTable direction="incoming" empty="No transfers received yet." /></Card>
    </>
  );
}
