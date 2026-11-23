import { Link } from 'react-router-dom';
import { Async, Badge, Card, PageHeader, Stat, Table, useApi, useBase, fmtDateTime, kg } from '../../components/ui.jsx';
import { ShipmentTable } from './Shipments.jsx';
import { TransferTable } from '../shared/Transfers.jsx';

export default function DistributorDashboard() {
  const base = useBase();
  const incoming = useApi('/transfers?direction=incoming&status=PENDING&pageSize=100');
  const queue = useApi('/distribution/queue');
  const open = useApi('/shipments?status=DISPATCHED,IN_TRANSIT&pageSize=100');
  const delivered = useApi('/shipments?status=DELIVERED&pageSize=1');
  const units = (queue.data ?? []).reduce((s, b) => s + Number(b.units_remaining), 0);
  return (
    <>
      <PageHeader title="Distributor dashboard" subtitle="Batches handed to your company, shipments and deliveries"
        actions={<><Link className="btn" to={base('distribution')}>Record a shipment</Link><Link className="btn secondary" to={base('incoming')}>Incoming batches</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Waiting for acceptance" value={incoming.meta?.total} sub="incoming transfers" />
        <Stat label="Batches to ship" value={queue.data?.length} sub={`${units} packed units in stock`} />
        <Stat label="Shipments in progress" value={open.meta?.total} />
        <Stat label="Delivered shipments" value={delivered.meta?.total} />
      </div>
      <div className="grid grid-2">
        <Card title="Incoming batches" actions={<Link to={base('incoming')}>Accept / reject</Link>}>
          <Async state={incoming} empty="Nothing waiting.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.transfer_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'From', key: 'from_org_name' }, { label: 'Units', key: 'units' }, { label: 'Sent', render: (r) => fmtDateTime(r.initiated_at) },
            ]} />}
          </Async>
        </Card>
        <Card title="In stock (accepted, not fully shipped)" actions={<Link to={base('distribution')}>Distribution</Link>}>
          <Async state={queue} empty="No batches in stock.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Honey', key: 'honey_type' }, { label: 'Lab', render: (r) => <Badge value={r.lab_decision} /> },
              { label: 'Units left', key: 'units_remaining' }, { label: 'Pack', render: (r) => `${r.unit_size_g} g ${r.packaging_type}` },
            ]} />}
          </Async>
        </Card>
      </div>
      <Card title="Shipments in progress" actions={<Link to={base('delivery')}>Update delivery status</Link>}>
        <ShipmentTable statuses="DISPATCHED,IN_TRANSIT" empty="No open shipments." />
      </Card>
      <Card title="Recently received">
        <TransferTable direction="incoming" status="ACCEPTED" pageSize={5} empty="Nothing received yet." />
      </Card>
      <p className="muted" style={{ fontSize: '0.8rem' }}>Quantities: {kg((queue.data ?? []).reduce((s, b) => s + (Number(b.units_remaining) * Number(b.unit_size_g)) / 1000, 0))} of packed honey in stock.</p>
    </>
  );
}

export function DistributorHistory() {
  return (
    <>
      <PageHeader title="History" subtitle="Every batch received or rejected by your company, and every delivered or cancelled shipment" />
      <Card title="Incoming transfers"><TransferTable direction="incoming" empty="No transfers yet." /></Card>
      <Card title="Closed shipments"><ShipmentTable statuses="DELIVERED,CANCELLED" empty="No closed shipments." /></Card>
    </>
  );
}
