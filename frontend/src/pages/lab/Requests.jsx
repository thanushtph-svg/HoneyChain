// Laboratory testing requests. Lab testers accept / reject (with reason); the requesting processor may cancel.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, qs } from '../../api/client.js';
import { Alert, Async, Badge, Card, ConfirmButton, DemoBadge, PageHeader, Pager, ReasonAction, Table, useApi, useBase, fmtDate, fmtDateTime, kg } from '../../components/ui.jsx';

export function RequestTable({ viewer, status, empty = 'No testing requests.', onChange, pageSize = 20 }) {
  const base = useBase();
  const [page, setPage] = useState(1);
  const s = useApi(`/lab-requests${qs({ status, page, pageSize })}`);
  const reload = () => { s.reload(); onChange?.(); };
  const resultLink = (code) => (viewer === 'LAB_TESTER' ? <Link to={base(`reports/${code}`)}>{code}</Link> : code);
  return (
    <Async state={s} empty={empty}>
      {(rows, meta) => (
        <>
          <Table rows={rows} rowKey={(r) => r.request_code} columns={[
            { label: 'Request', render: (r) => <>{r.request_code} <DemoBadge show={r.is_demo || r.batch_is_demo} /><br /><small>{fmtDateTime(r.requested_at)}</small></> },
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link><br /><small>{r.honey_type} · {kg(r.output_quantity_kg ?? r.quantity_kg)}</small></> },
            viewer === 'LAB_TESTER'
              ? { label: 'From processor', render: (r) => <>{r.requester_name}<br /><small>{r.requester_city}</small></> }
              : { label: 'Laboratory', key: 'lab_name' },
            { label: 'Processed', render: (r) => r.processing_code ? <>{fmtDate(r.processing_date)}<br /><small>{r.processing_method}</small></> : '-' },
            { label: 'Sample / tests', render: (r) => <>{r.sample_reference ?? '-'}<br /><small>{r.tests_requested ?? ''}</small></> },
            { label: 'Status', render: (r) => <><Badge value={r.status} />{r.response_reason ? <><br /><small>“{r.response_reason}”</small></> : null}</> },
            { label: '', render: (r) => {
              if (r.status === 'PENDING' && viewer === 'LAB_TESTER') {
                return (
                  <div className="btn-row">
                    <ConfirmButton confirm={`Accept testing request ${r.request_code} for ${r.batch_code}?`} onClick={() => post(`/lab-requests/${r.request_code}/accept`, {})} onDone={reload}>Accept</ConfirmButton>
                    <ReasonAction label="Reject" placeholder="Why can the laboratory not test this sample? (shown to the processor)" confirm="Reject this testing request?"
                      onSubmit={(reason) => post(`/lab-requests/${r.request_code}/reject`, { reason })} onDone={reload} />
                  </div>
                );
              }
              if (r.status === 'PENDING' && viewer === 'PROCESSOR') {
                return <ReasonAction label="Cancel" confirm="Cancel this testing request?" onSubmit={(reason) => post(`/lab-requests/${r.request_code}/cancel`, { reason })} onDone={reload} />;
              }
              if (r.status === 'ACCEPTED' && viewer === 'LAB_TESTER') {
                return r.draft_report_code
                  ? <Link className="btn small secondary" to={base(`reports/${r.draft_report_code}`)}>Continue draft</Link>
                  : <Link className="btn small" to={base(`reports/new?batch=${r.batch_code}`)}>Enter results</Link>;
              }
              return r.result_report_code ? resultLink(r.result_report_code) : null;
            } },
          ]} />
          <Pager meta={meta} page={page} setPage={setPage} />
        </>
      )}
    </Async>
  );
}

export default function TestingRequests() {
  const [v, setV] = useState(0);
  return (
    <>
      <PageHeader title="Testing requests" subtitle="Requests from processors. Accept to start testing; reject with a reason if the sample cannot be tested." />
      <Alert kind="info">Accepting a request moves the batch to IN TESTING. You can only enter results for requests your laboratory has accepted.</Alert>
      <Card title="Waiting for your response">
        <RequestTable key={v} viewer="LAB_TESTER" status="PENDING" empty="No new testing requests." onChange={() => setV((x) => x + 1)} />
      </Card>
    </>
  );
}

export function TestingHistory() {
  return (
    <>
      <PageHeader title="Testing history" subtitle="Every request your laboratory received: accepted, rejected, cancelled and completed" />
      <Card><RequestTable viewer="LAB_TESTER" status="ACCEPTED,REJECTED,CANCELLED,COMPLETED" empty="No testing history yet." /></Card>
    </>
  );
}
