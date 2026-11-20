// Role-specific home dashboards. Every number comes from the API.
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Async, Badge, Bars, Card, DemoBadge, PageHeader, Stat, Table, useApi, fmtDate, kg } from '../../components/ui.jsx';

function BeekeeperHome() {
  const hives = useApi('/hives?pageSize=100');
  const harvests = useApi('/harvests?pageSize=100');
  const batches = useApi('/batches?pageSize=100');
  const byStatus = {};
  for (const b of batches.data ?? []) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const totalKg = (harvests.data ?? []).reduce((s, h) => s + Number(h.quantity_kg), 0);
  return (
    <>
      <PageHeader title="Beekeeper dashboard" subtitle="Your hives, harvests and batches" actions={<><Link className="btn" to="/app/harvests">Record harvest</Link><Link className="btn secondary" to="/app/hives">Register hive</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Hives" value={hives.meta?.total} sub={`${(hives.data ?? []).filter((h) => h.status === 'ACTIVE').length} active`} />
        <Stat label="Harvests" value={harvests.meta?.total} sub={`${totalKg.toFixed(1)} kg recorded`} />
        <Stat label="Batches" value={batches.meta?.total} />
        <Stat label="Delivered batches" value={byStatus.DELIVERED ?? 0} />
      </div>
      <div className="grid grid-2">
        <Card title="Batches by status">
          <Bars items={Object.entries(byStatus).map(([status, n]) => ({ status, n }))} labelKey="status" valueKey="n" />
        </Card>
        <Card title="Recent batches" actions={<Link to="/app/batches">All batches</Link>}>
          <Async state={batches} empty="No batches yet. Create batches from a harvest.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
              { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              { label: 'Status', render: (r) => <Badge value={r.status} /> },
            ]} />}
          </Async>
        </Card>
      </div>
    </>
  );
}

function LabHome() {
  const q = useApi('/lab/queue');
  const reps = useApi('/lab/reports?pageSize=100');
  const sub = (reps.data ?? []).filter((r) => r.report_state === 'SUBMITTED');
  return (
    <>
      <PageHeader title="Laboratory dashboard" subtitle="Batches assigned to your laboratory" actions={<Link className="btn" to="/app/lab/queue">Open testing queue</Link>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Awaiting testing" value={q.data?.filter((b) => !b.draft_report_code).length} />
        <Stat label="Open drafts" value={q.data?.filter((b) => b.draft_report_code).length} />
        <Stat label="Reports submitted" value={sub.length} />
        <Stat label="Pass / fail" value={`${sub.filter((r) => r.decision === 'PASS').length} / ${sub.filter((r) => r.decision === 'FAIL').length}`} />
      </div>
      <Card title="Queue">
        <Async state={q} empty="No batches waiting for your laboratory.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <>{r.batch_code} <DemoBadge show={r.is_demo} /></> },
            { label: 'Honey', key: 'honey_type' },
            { label: 'Harvested', render: (r) => fmtDate(r.harvest_date) },
            { label: 'Status', render: (r) => <Badge value={r.status} /> },
            { label: '', render: (r) => r.draft_report_code ? <Link to={`/app/lab/reports/${r.draft_report_code}`}>Continue draft</Link> : <Link to={`/app/lab/reports/new?batch=${r.batch_code}`}>Enter results</Link> },
          ]} />}
        </Async>
      </Card>
    </>
  );
}

function ProcessorHome() {
  const q = useApi('/processing/queue');
  const h = useApi('/processing?pageSize=100');
  const outKg = (h.data ?? []).reduce((s, p) => s + Number(p.output_quantity_kg), 0);
  return (
    <>
      <PageHeader title="Processor dashboard" actions={<Link className="btn" to="/app/processing/queue">Open processing queue</Link>} />
      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <Stat label="Batches ready to process" value={q.data?.length} />
        <Stat label="Processing records" value={h.meta?.total} />
        <Stat label="Honey processed" value={`${outKg.toFixed(1)} kg`} />
      </div>
      <Card title="Ready for processing (lab passed)">
        <Async state={q} empty="No batches are waiting for processing.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
            { label: 'Honey', key: 'honey_type' }, { label: 'Qty', render: (r) => kg(r.quantity_kg) },
            { label: 'Lab', key: 'lab_name' }, { label: 'Tested', render: (r) => fmtDate(r.tested_on) },
          ]} />}
        </Async>
      </Card>
    </>
  );
}

function DistributorHome() {
  const q = useApi('/distribution/queue');
  const s = useApi('/shipments?pageSize=100');
  const open = (s.data ?? []).filter((x) => ['DISPATCHED', 'IN_TRANSIT'].includes(x.status));
  return (
    <>
      <PageHeader title="Distributor dashboard" actions={<Link className="btn" to="/app/distribution/queue">Dispatch a batch</Link>} />
      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <Stat label="Batches with units to ship" value={q.data?.length} />
        <Stat label="Shipments in progress" value={open.length} />
        <Stat label="Delivered shipments" value={(s.data ?? []).filter((x) => x.status === 'DELIVERED').length} />
      </div>
      <Card title="Shipments in progress" actions={<Link to="/app/shipments">Update status</Link>}>
        <Async state={{ ...s, data: open }} empty="No open shipments.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.shipment_code} columns={[
            { label: 'Shipment', key: 'shipment_code' }, { label: 'Batch', key: 'batch_code' },
            { label: 'To', render: (r) => `${r.destination_name}, ${r.destination_city}` }, { label: 'Units', key: 'units_shipped' },
            { label: 'Status', render: (r) => <Badge value={r.status} /> },
          ]} />}
        </Async>
      </Card>
    </>
  );
}

function AdminHome() {
  const s = useApi('/admin/stats');
  return (
    <>
      <PageHeader title="System overview" subtitle="Live statistics computed from PostgreSQL and MongoDB" actions={<button className="btn secondary" onClick={s.reload}>Refresh</button>} />
      <Async state={s}>
        {(d) => (
          <>
            <div className="grid grid-4" style={{ marginBottom: 18 }}>
              <Stat label="Beekeepers" value={d.counts.beekeepers} sub={`${d.counts.hives} hives`} />
              <Stat label="Batches" value={d.counts.batches} sub={`${d.counts.demo_batches} demo`} />
              <Stat label="Lab reports" value={d.counts.lab_reports} />
              <Stat label="Open anomaly reports" value={d.anomalies?.open ?? '-'} />
              <Stat label="Harvested" value={kg(d.quantities.harvested_kg)} sub={`${kg(d.quantities.batched_kg)} batched`} />
              <Stat label="Processed output" value={kg(d.quantities.processed_output_kg)} sub={`${d.quantities.units_packed} units packed`} />
              <Stat label="Units shipped" value={d.quantities.units_shipped} sub={`${d.quantities.units_delivered} delivered`} />
              <Stat label="QR scans" value={d.counts.qr_scans} />
            </div>
            <div className="grid grid-2">
              <Card title="Batches by lifecycle status"><Bars items={d.batchesByStatus} labelKey="status" valueKey="n" /></Card>
              <Card title="Harvests by month (kg)"><Bars items={d.harvestsByMonth} labelKey="month" valueKey="kg" format={(v) => Number(v).toFixed(1)} /></Card>
              <Card title="Blockchain anchors"><Bars items={d.anchorsByStatus} labelKey="status" valueKey="n" /></Card>
              <Card title="Verification results"><Bars items={d.verificationResults} labelKey="result" valueKey="n" /></Card>
              <Card title="Lab decisions">
                <Table rows={d.labDecisions} columns={[{ label: 'Laboratory', key: 'lab' }, { label: 'Pass', key: 'pass' }, { label: 'Fail', key: 'fail' }]} empty="No submitted reports." />
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

export default function Overview() {
  const { user } = useAuth();
  const C = { BEEKEEPER: BeekeeperHome, LAB: LabHome, PROCESSOR: ProcessorHome, DISTRIBUTOR: DistributorHome, ADMIN: AdminHome }[user.role];
  return <C />;
}
