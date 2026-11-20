import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Card, DemoBadge, PageHeader, Pager, Table, useApi, fmtDate, kg } from '../../components/ui.jsx';

export default function ProcessingHistory() {
  const [page, setPage] = useState(1);
  const s = useApi(`/processing?page=${page}`);
  return (
    <>
      <PageHeader title="Processing history" />
      <Card>
        <Async state={s} empty="No processing records yet.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.processing_code} columns={[
                { label: 'Record', render: (r) => <>{r.processing_code} <DemoBadge show={r.is_demo} /></> },
                { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
                { label: 'Processor', key: 'processor_name' },
                { label: 'Date', render: (r) => fmtDate(r.processing_date) },
                { label: 'Method', key: 'method' },
                { label: 'Operator', key: 'operator_name' },
                { label: 'In → out', render: (r) => `${kg(r.input_quantity_kg)} → ${kg(r.output_quantity_kg)}` },
                { label: 'Packed', render: (r) => `${r.units_packed} × ${r.unit_size_g} g ${r.packaging_type}` },
                { label: 'Best before', render: (r) => fmtDate(r.best_before) },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
