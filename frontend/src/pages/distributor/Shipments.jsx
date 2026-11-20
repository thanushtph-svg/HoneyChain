import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, qs } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, PageHeader, Pager, Table, useAction, useApi, fmtDate, today } from '../../components/ui.jsx';

export default function Shipments() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const s = useApi(`/shipments${qs({ page, status })}`);
  const a = useAction();
  const update = async (code, next) => {
    if (next === 'CANCELLED' && !window.confirm(`Cancel shipment ${code}?`)) return;
    const body = next === 'DELIVERED' ? { status: next, deliveredOn: today() } : { status: next };
    if (await a.run(() => patch(`/shipments/${code}/status`, body), (r) => `${code}: ${next.replace('_', ' ')}${r.data.batchStatus === 'DELIVERED' ? ' - batch fully delivered' : ''}`)) s.reload();
  };
  return (
    <>
      <PageHeader title="Shipments" subtitle="Update delivery status. Delivered shipments are anchored on the blockchain." />
      <ErrorBox error={a.error} />
      {a.message && <Alert kind="success">{a.message}</Alert>}
      <Card>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select className="btn secondary" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>{['DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
        <Async state={s} empty="No shipments.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.shipment_code} columns={[
                { label: 'Shipment', render: (r) => <>{r.shipment_code} <DemoBadge show={r.is_demo} /></> },
                { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
                { label: 'Destination', render: (r) => <>{r.destination_name}<br /><small>{r.destination_type} · {r.destination_city}, {r.destination_state}</small></> },
                { label: 'Units', key: 'units_shipped' },
                { label: 'Dispatched', render: (r) => fmtDate(r.dispatch_date) },
                { label: 'Status', render: (r) => <><Badge value={r.status} />{r.delivered_on && <><br /><small>{fmtDate(r.delivered_on)}</small></>}</> },
                { label: '', render: (r) => user.role !== 'DISTRIBUTOR' ? null : (
                  <div className="btn-row">
                    {r.status === 'DISPATCHED' && <button className="btn secondary small" disabled={a.busy} onClick={() => update(r.shipment_code, 'IN_TRANSIT')}>In transit</button>}
                    {['DISPATCHED', 'IN_TRANSIT'].includes(r.status) && <button className="btn small" disabled={a.busy} onClick={() => update(r.shipment_code, 'DELIVERED')}>Delivered today</button>}
                    {['DISPATCHED', 'IN_TRANSIT'].includes(r.status) && <button className="btn secondary small" disabled={a.busy} onClick={() => update(r.shipment_code, 'CANCELLED')}>Cancel</button>}
                  </div>
                ) },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
