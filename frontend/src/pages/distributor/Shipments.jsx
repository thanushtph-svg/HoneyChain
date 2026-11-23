// Shipments list (all), and the Delivery Status page (open shipments: in transit / delivered / cancel).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, qs } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, PageHeader, Pager, Table, useAction, useApi, useBase, fmtDate, today } from '../../components/ui.jsx';

export function ShipmentTable({ statuses, actions = false, showDistributor = false, empty = 'No shipments.' }) {
  const { user } = useAuth();
  const base = useBase();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const s = useApi(`/shipments${qs({ page, status: status || statuses })}`);
  const a = useAction();
  const [deliveredOn, setDeliveredOn] = useState(today());
  const update = async (code, next) => {
    const label = next.replace('_', ' ').toLowerCase();
    if (!window.confirm(`Mark shipment ${code} as ${label}?${next === 'DELIVERED' ? ` Delivery date: ${deliveredOn}.` : ''}`)) return;
    const body = next === 'DELIVERED' ? { status: next, deliveredOn } : { status: next };
    if (await a.run(() => patch(`/shipments/${code}/status`, body), (r) => `${code}: ${label}${r.data.batchStatus === 'DELIVERED' ? ' - every unit of the batch is now delivered' : ''}`)) s.reload();
  };
  const canAct = actions && user.role === 'DISTRIBUTOR';
  return (
    <>
      <ErrorBox error={a.error} />
      {a.message && <Alert kind="success">{a.message}</Alert>}
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <select aria-label="Shipment status" className="btn secondary" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">{statuses ? 'All open' : 'All statuses'}</option>
          {(statuses ? statuses.split(',') : ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']).map((x) => <option key={x}>{x}</option>)}
        </select>
        {canAct && <label className="check">Delivery date <input type="date" max={today()} value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} /></label>}
      </div>
      <Async state={s} empty={empty}>
        {(rows, meta) => (
          <>
            <Table rows={rows} rowKey={(r) => r.shipment_code} columns={[
              { label: 'Shipment', render: (r) => <>{r.shipment_code} <DemoBadge show={r.is_demo} /></> },
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              ...(showDistributor ? [{ label: 'Distributor', key: 'distributor_name' }] : []),
              { label: 'Recipient', render: (r) => <>{r.destination_name}<br /><small>{r.destination_type} · {r.destination_city}, {r.destination_state}</small></> },
              { label: 'Units', key: 'units_shipped' },
              { label: 'Dispatched', render: (r) => <>{fmtDate(r.dispatch_date)}{r.carrier_name ? <><br /><small>{r.carrier_name}{r.tracking_reference ? ` · ${r.tracking_reference}` : ''}</small></> : null}</> },
              { label: 'Status', render: (r) => <><Badge value={r.status} />{r.delivered_on && <><br /><small>{fmtDate(r.delivered_on)}</small></>}</> },
              ...(canAct ? [{ label: '', render: (r) => (
                <div className="btn-row">
                  {r.status === 'DISPATCHED' && <button className="btn secondary small" disabled={a.busy} onClick={() => update(r.shipment_code, 'IN_TRANSIT')}>In transit</button>}
                  {['DISPATCHED', 'IN_TRANSIT'].includes(r.status) && <button className="btn small" disabled={a.busy} onClick={() => update(r.shipment_code, 'DELIVERED')}>Delivered</button>}
                  {['DISPATCHED', 'IN_TRANSIT'].includes(r.status) && <button className="btn secondary small" disabled={a.busy} onClick={() => update(r.shipment_code, 'CANCELLED')}>Cancel</button>}
                </div>
              ) }] : []),
            ]} />
            <Pager meta={meta} page={page} setPage={setPage} />
          </>
        )}
      </Async>
    </>
  );
}

export default function Shipments() {
  return (
    <>
      <PageHeader title="Shipments" subtitle="Every shipment recorded by your company. Delivered shipments are anchored on the blockchain." />
      <Card><ShipmentTable empty="No shipments yet." /></Card>
    </>
  );
}

export function DeliveryStatus() {
  return (
    <>
      <PageHeader title="Delivery status" subtitle="Update open shipments. A batch becomes DELIVERED when all its packed units are delivered." />
      <Card><ShipmentTable statuses="DISPATCHED,IN_TRANSIT" actions empty="No open shipments." /></Card>
    </>
  );
}
