import { Link } from 'react-router-dom';
import { Async, Badge, Card, PageHeader, Stat, Table, useApi, useBase, fmtDateTime, kg } from '../../components/ui.jsx';

export default function ProcessorDashboard() {
  const base = useBase();
  const incoming = useApi('/transfers?direction=incoming&status=PENDING&pageSize=100');
  const queue = useApi('/processing/queue');
  const lab = useApi('/batches?status=PROCESSED,PENDING_LAB,IN_TESTING,LAB_INCONCLUSIVE&pageSize=100');
  const ready = useApi('/batches?status=LAB_PASSED&pageSize=100');
  const hist = useApi('/processing?pageSize=100');
  const outKg = (hist.data ?? []).reduce((s, p) => s + Number(p.output_quantity_kg), 0);
  const lossKg = (hist.data ?? []).reduce((s, p) => s + Number(p.loss_kg), 0);
  return (
    <>
      <PageHeader title="Processor dashboard" subtitle="Batches in your unit's custody, from receipt to hand-over"
        actions={<Link className="btn" to={base('incoming')}>Review incoming batches</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Waiting for acceptance" value={incoming.meta?.total} sub="incoming transfers" />
        <Stat label="To process" value={queue.data?.length} sub="accepted, not yet processed" />
        <Stat label="With the laboratory" value={lab.meta?.total} sub="processed / testing" />
        <Stat label="Ready for distributor" value={ready.meta?.total} sub="lab passed" />
        <Stat label="Processing records" value={hist.meta?.total} />
        <Stat label="Honey processed" value={kg(outKg)} sub={`${kg(lossKg)} total processing loss`} />
      </div>
      <div className="grid grid-2">
        <Card title="Incoming batches" actions={<Link to={base('incoming')}>Accept / reject</Link>}>
          <Async state={incoming} empty="Nothing waiting.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.transfer_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'From', key: 'beekeeper_name' }, { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              { label: 'Sent', render: (r) => fmtDateTime(r.initiated_at) },
            ]} />}
          </Async>
        </Card>
        <Card title="To process" actions={<Link to={base('processing')}>Record processing</Link>}>
          <Async state={queue} empty="No accepted batches waiting for processing.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Honey', key: 'honey_type' }, { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              { label: 'Received', render: (r) => fmtDateTime(r.received_at) },
            ]} />}
          </Async>
        </Card>
        <Card title="Laboratory status" actions={<Link to={base('processed')}>Processed batches</Link>}>
          <Async state={lab} empty="No batches with the laboratory.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Lab', render: (r) => r.lab_name ?? '-' }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
            ]} />}
          </Async>
        </Card>
        <Card title="Ready for a distributor" actions={<Link to={base('transfers')}>Transfers</Link>}>
          <Async state={ready} empty="No lab-passed batches waiting.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Honey', key: 'honey_type' }, { label: 'Lab', render: (r) => <Badge value={r.lab_decision} /> },
            ]} />}
          </Async>
        </Card>
      </div>
    </>
  );
}
