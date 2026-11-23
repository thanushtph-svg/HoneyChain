// Custody transfers: incoming (accept / reject with reason) and history, for processors and distributors.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, qs } from '../../api/client.js';
import { Alert, Async, Badge, Card, ConfirmButton, DemoBadge, PageHeader, Pager, ReasonAction, Table, useApi, useBase, fmtDate, fmtDateTime, kg } from '../../components/ui.jsx';

export function TransferTable({ direction, status, type, empty = 'No transfers.', actions = false, onChange, pageSize = 20 }) {
  const base = useBase();
  const [page, setPage] = useState(1);
  const s = useApi(`/transfers${qs({ direction, status, type, page, pageSize })}`);
  const reload = () => { s.reload(); onChange?.(); };
  return (
    <Async state={s} empty={empty}>
      {(rows, meta) => (
        <>
          <Table rows={rows} rowKey={(r) => r.transfer_code} columns={[
            { label: 'Transfer', render: (r) => <>{r.transfer_code} <DemoBadge show={r.is_demo || r.batch_is_demo} /><br /><small>{fmtDateTime(r.initiated_at)}</small></> },
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link><br /><small>{r.honey_type}</small></> },
            { label: 'From', render: (r) => r.from_org_name ?? <>{r.beekeeper_name}<br /><small>{r.district}, {r.state}</small></> },
            { label: 'To', key: 'to_org_name' },
            { label: 'Quantity', render: (r) => <>{kg(r.quantity_kg)}{r.units ? <><br /><small>{r.units} units</small></> : null}</> },
            { label: 'Harvest', render: (r) => <>{r.harvest_code}<br /><small>{fmtDate(r.harvest_date)} · {r.floral_source}</small></> },
            { label: 'Status', render: (r) => <><Badge value={r.status} />{r.response_reason ? <><br /><small>“{r.response_reason}”</small></> : null}</> },
            ...(actions ? [{ label: '', render: (r) => r.status !== 'PENDING' ? null : (
              <div className="btn-row">
                <ConfirmButton confirm={`Accept custody of ${r.batch_code} (${kg(r.quantity_kg)})?`} onClick={() => post(`/transfers/${r.transfer_code}/accept`, {})} onDone={reload}>Accept</ConfirmButton>
                <ReasonAction label="Reject" confirm={`Reject ${r.batch_code}? It goes back to the sender with your reason.`}
                  placeholder="Why are you rejecting this batch? (recorded and shown to the sender)" onSubmit={(reason) => post(`/transfers/${r.transfer_code}/reject`, { reason })} onDone={reload} />
              </div>
            ) }] : []),
          ]} />
          <Pager meta={meta} page={page} setPage={setPage} />
        </>
      )}
    </Async>
  );
}

export default function IncomingTransfers({ title = 'Incoming batches', subtitle }) {
  const [v, setV] = useState(0);
  return (
    <>
      <PageHeader title={title} subtitle={subtitle ?? 'Batches sent to your organization. Accepting takes custody; rejecting returns the batch to the sender with your reason.'} />
      <Alert kind="info">Check the batch details (origin, quantity, lab status) before accepting. Every response is recorded with your name and time.</Alert>
      <Card title="Waiting for your response">
        <TransferTable key={`p${v}`} direction="incoming" status="PENDING" actions empty="No incoming batches are waiting." onChange={() => setV((x) => x + 1)} />
      </Card>
      <Card title="Recently answered">
        <TransferTable key={`h${v}`} direction="incoming" status="ACCEPTED,REJECTED,CANCELLED" empty="Nothing answered yet." pageSize={10} />
      </Card>
    </>
  );
}
