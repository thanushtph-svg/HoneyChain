import { Link } from 'react-router-dom';
import { Alert, Async, Badge, Bars, Card, PageHeader, Stat, Table, useApi, useBase, kg } from '../../components/ui.jsx';

export default function AdminDashboard() {
  const base = useBase();
  const s = useApi('/admin/stats');
  const sec = useApi('/admin/security-events?days=7');
  return (
    <>
      <PageHeader title="Admin dashboard" subtitle="Platform-wide statistics computed live from PostgreSQL and MongoDB. Administrators monitor records; they do not edit them."
        actions={<button className="btn secondary" onClick={() => { s.reload(); sec.reload(); }}>Refresh</button>} />
      <Async state={s}>
        {(d) => (
          <>
            {Number(d.counts.pending_corrections) > 0 && (
              <Alert kind="warn"><strong>{d.counts.pending_corrections} lab correction request(s)</strong> waiting for your review. <Link to={base('laboratory')}>Review</Link></Alert>
            )}
            <div className="grid grid-4" style={{ marginBottom: 18 }}>
              <Stat label="Users" value={d.counts.users} sub={`${d.counts.inactive_users} inactive · ${d.counts.organizations} organizations`} />
              <Stat label="Beekeepers" value={d.counts.beekeepers} sub={`${d.counts.hives} hives · ${d.counts.harvests} harvests`} />
              <Stat label="Batches" value={d.counts.batches} sub={`${d.counts.demo_batches} demo`} />
              <Stat label="Lab reports" value={d.counts.lab_reports} sub={`${d.counts.pending_lab_requests} requests pending`} />
              <Stat label="Pending transfers" value={d.counts.pending_transfers} sub={`${d.counts.rejected_transfers} rejected so far`} />
              <Stat label="Rejected lab requests" value={d.counts.rejected_lab_requests} />
              <Stat label="Open anomaly reports" value={d.anomalies?.open ?? '-'} />
              <Stat label="QR scans" value={d.counts.qr_scans} sub={`${d.counts.consumer_verifications} by consumer accounts`} />
              <Stat label="Harvested" value={kg(d.quantities.harvested_kg)} sub={`${kg(d.quantities.batched_kg)} batched`} />
              <Stat label="Processed output" value={kg(d.quantities.processed_output_kg)} sub={`${d.quantities.units_packed} units packed`} />
              <Stat label="Units shipped" value={d.quantities.units_shipped} sub={`${d.quantities.units_delivered} delivered`} />
              <Stat label="Security events (7 days)" value={sec.data ? sec.data.counts.ACCESS_DENIED + sec.data.counts.LOGIN_FAILED : '-'}
                sub={sec.data ? `${sec.data.counts.ACCESS_DENIED} denied · ${sec.data.counts.LOGIN_FAILED} failed logins` : ''} />
            </div>
            <div className="grid grid-2">
              <Card title="Batches by lifecycle status"><Bars items={d.batchesByStatus} labelKey="status" valueKey="n" /></Card>
              <Card title="Harvests by month (kg)"><Bars items={d.harvestsByMonth} labelKey="month" valueKey="kg" format={(v) => Number(v).toFixed(1)} /></Card>
              <Card title="Blockchain anchors" actions={<Link to={base('blockchain')}>Monitor</Link>}><Bars items={d.anchorsByStatus} labelKey="status" valueKey="n" /></Card>
              <Card title="Verification results"><Bars items={d.verificationResults} labelKey="result" valueKey="n" /></Card>
              <Card title="Lab decisions" actions={<Link to={base('laboratory')}>Laboratory monitoring</Link>}>
                <Table rows={d.labDecisions} columns={[{ label: 'Laboratory', key: 'lab' }, { label: 'Pass', key: 'pass' }, { label: 'Fail', key: 'fail' }, { label: 'Inconclusive', key: 'inconclusive' }]} empty="No submitted reports." />
              </Card>
              <Card title="Data-sync queue (MongoDB outbox)">
                {d.outbox.length === 0 ? <p className="muted">Empty - every MongoDB write succeeded.</p>
                  : <Table rows={d.outbox} columns={[{ label: 'Status', render: (r) => <Badge value={r.status} /> }, { label: 'Count', key: 'n' }]} />}
              </Card>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
