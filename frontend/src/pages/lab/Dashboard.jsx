import { Link } from 'react-router-dom';
import { Async, Badge, Card, PageHeader, Stat, Table, useApi, useBase, fmtDateTime } from '../../components/ui.jsx';

export default function LabDashboard() {
  const base = useBase();
  const pending = useApi('/lab-requests?status=PENDING&pageSize=100');
  const queue = useApi('/lab/queue');
  const reps = useApi('/lab/reports?state=SUBMITTED&pageSize=100');
  const drafts = useApi('/lab/reports?state=DRAFT&pageSize=100');
  const corr = useApi('/lab-corrections?status=PENDING');
  const sub = reps.data ?? [];
  const n = (d) => sub.filter((r) => r.decision === d).length;
  return (
    <>
      <PageHeader title="Lab Tester dashboard" subtitle="Testing requests, pending tests and results of your laboratory"
        actions={<Link className="btn" to={base('requests')}>Review testing requests</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="New requests" value={pending.meta?.total} sub="waiting for accept / reject" />
        <Stat label="Pending tests" value={queue.data?.length} sub={`${drafts.meta?.total ?? '-'} drafts in progress`} />
        <Stat label="Reports submitted" value={reps.meta?.total} />
        <Stat label="Pass / fail / inconclusive" value={`${n('PASS')} / ${n('FAIL')} / ${n('INCONCLUSIVE')}`} sub={`${corr.data?.length ?? 0} correction(s) awaiting admin review`} />
      </div>
      <div className="grid grid-2">
        <Card title="New testing requests" actions={<Link to={base('requests')}>All requests</Link>}>
          <Async state={pending} empty="No new requests.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.request_code} columns={[
              { label: 'Request', key: 'request_code' }, { label: 'Batch', key: 'batch_code' }, { label: 'From', key: 'requester_name' },
              { label: 'Received', render: (r) => fmtDateTime(r.requested_at) },
            ]} />}
          </Async>
        </Card>
        <Card title="Pending tests" actions={<Link to={base('pending')}>Enter results</Link>}>
          <Async state={queue} empty="No accepted requests waiting for results.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.request_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Honey', key: 'honey_type' },
              { label: '', render: (r) => r.draft_report_code ? <Link to={base(`reports/${r.draft_report_code}`)}>Continue draft</Link> : <Link to={base(`reports/new?batch=${r.batch_code}`)}>Enter results</Link> },
            ]} />}
          </Async>
        </Card>
        <Card title="Recent results" className="span-2" actions={<Link to={base('reports')}>Lab reports</Link>}>
          <Async state={reps} empty="No submitted reports yet.">
            {(rows) => <Table rows={rows.slice(0, 8)} rowKey={(r) => r.report_code} columns={[
              { label: 'Report', render: (r) => <Link to={base(`reports/${r.report_code}`)}>{r.report_code}</Link> },
              { label: 'Batch', key: 'batch_code' }, { label: 'Tested by', key: 'tested_by_name' },
              { label: 'Submitted', render: (r) => fmtDateTime(r.submitted_at) }, { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
            ]} />}
          </Async>
        </Card>
      </div>
    </>
  );
}
