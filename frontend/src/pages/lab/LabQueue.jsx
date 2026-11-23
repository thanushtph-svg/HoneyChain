// Pending tests = accepted requests that still need a submitted result.
import { Link } from 'react-router-dom';
import { Async, Badge, Card, DemoBadge, PageHeader, Table, useApi, useBase, fmtDate, fmtDateTime, kg } from '../../components/ui.jsx';

export default function LabQueue() {
  const base = useBase();
  const s = useApi('/lab/queue');
  return (
    <>
      <PageHeader title="Pending tests" subtitle="Requests your laboratory accepted. Enter the measured values, save a draft, then submit the result."
        actions={<button className="btn secondary" onClick={s.reload}>Refresh</button>} />
      <Card>
        <Async state={s} empty="No accepted requests are waiting for results.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.request_code} columns={[
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.batch_is_demo} /></> },
            { label: 'Request', render: (r) => <>{r.request_code}<br /><small>accepted {fmtDateTime(r.responded_at)}</small></> },
            { label: 'Honey', key: 'honey_type' },
            { label: 'Processed', render: (r) => <>{fmtDate(r.processing_date)} · {kg(r.output_quantity_kg)}<br /><small>{r.requester_name}</small></> },
            { label: 'Origin', render: (r) => `${r.district}, ${r.state}` },
            { label: 'Batch status', render: (r) => <Badge value={r.batch_status} /> },
            { label: '', render: (r) => r.draft_report_code
              ? <Link className="btn small secondary" to={base(`reports/${r.draft_report_code}`)}>Continue draft</Link>
              : <Link className="btn small" to={base(`reports/new?batch=${r.batch_code}`)}>Enter results</Link> },
          ]} />}
        </Async>
      </Card>
    </>
  );
}
