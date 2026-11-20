import { Link } from 'react-router-dom';
import { Async, Badge, Card, DemoBadge, PageHeader, Table, useApi, fmtDate, kg } from '../../components/ui.jsx';

export default function LabQueue() {
  const s = useApi('/lab/queue');
  return (
    <>
      <PageHeader title="Testing queue" subtitle="Batches assigned to your laboratory that still need a submitted report" actions={<button className="btn secondary" onClick={s.reload}>Refresh</button>} />
      <Card>
        <Async state={s} empty="No batches are waiting for your laboratory.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <><Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
            { label: 'Honey', key: 'honey_type' },
            { label: 'Qty', render: (r) => kg(r.quantity_kg) },
            { label: 'Origin', render: (r) => `${r.district}, ${r.state}` },
            { label: 'Harvest', render: (r) => <>{r.harvest_code}<br /><small>{fmtDate(r.harvest_date)} · {r.floral_source}</small></> },
            { label: 'Status', render: (r) => <Badge value={r.status} /> },
            { label: '', render: (r) => r.draft_report_code
              ? <Link className="btn small secondary" to={`/app/lab/reports/${r.draft_report_code}`}>Continue draft</Link>
              : <Link className="btn small" to={`/app/lab/reports/new?batch=${r.batch_code}`}>Enter results</Link> },
          ]} />}
        </Async>
      </Card>
    </>
  );
}
