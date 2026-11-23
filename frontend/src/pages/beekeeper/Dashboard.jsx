import { Link } from 'react-router-dom';
import { Alert, Async, Badge, Bars, Card, DemoBadge, PageHeader, Stat, Table, useApi, useBase, fmtDateTime, kg } from '../../components/ui.jsx';

export default function BeekeeperDashboard() {
  const base = useBase();
  const hives = useApi('/hives?pageSize=100');
  const harvests = useApi('/harvests?pageSize=100');
  const batches = useApi('/batches?pageSize=100');
  const rejected = useApi('/transfers?status=REJECTED&pageSize=5');
  const byStatus = {};
  for (const b of batches.data ?? []) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const totalKg = (harvests.data ?? []).reduce((s, h) => s + Number(h.quantity_kg), 0);
  const unbatched = (harvests.data ?? []).reduce((s, h) => s + Number(h.quantity_kg) - Number(h.batched_kg), 0);
  const ready = (batches.data ?? []).filter((b) => b.status === 'CREATED');
  return (
    <>
      <PageHeader title="Beekeeper dashboard" subtitle="Your hives, harvests and batches, and where each batch is now"
        actions={<><Link className="btn" to={base('harvests')}>Record harvest</Link><Link className="btn secondary" to={base('hives')}>Register hive</Link></>} />
      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Hives" value={hives.meta?.total} sub={`${(hives.data ?? []).filter((h) => h.status === 'ACTIVE').length} active`} />
        <Stat label="Harvests" value={harvests.meta?.total} sub={`${totalKg.toFixed(1)} kg recorded · ${unbatched.toFixed(1)} kg not batched`} />
        <Stat label="Batches" value={batches.meta?.total} sub={`${ready.length} ready to send to a processor`} />
        <Stat label="Delivered batches" value={byStatus.DELIVERED ?? 0} />
      </div>
      {(rejected.data ?? []).length > 0 && (
        <Alert kind="warn"><strong>Returned to you:</strong>{' '}
          {rejected.data.map((t) => <span key={t.transfer_code}><Link to={base(`batches/${t.batch_code}`)}>{t.batch_code}</Link> rejected by {t.to_org_name} - “{t.response_reason}” ({fmtDateTime(t.responded_at)}). </span>)}
        </Alert>
      )}
      <div className="grid grid-2">
        <Card title="Batches by status">
          <Bars items={Object.entries(byStatus).map(([status, n]) => ({ status, n }))} labelKey="status" valueKey="n" />
        </Card>
        <Card title="Ready to send to a processor" actions={<Link to={base('batches')}>All batches</Link>}>
          <Async state={{ ...batches, data: ready }} empty="No batches waiting. Create batches from a harvest.">
            {(rows) => <Table rows={rows.slice(0, 6)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
              { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              { label: '', render: (r) => <Link className="btn small" to={base(`batches/${r.batch_code}`)}>Transfer</Link> },
            ]} />}
          </Async>
        </Card>
        <Card title="Recent batches" className="span-2">
          <Async state={batches} empty="No batches yet.">
            {(rows) => <Table rows={rows.slice(0, 8)} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> },
              { label: 'Qty', render: (r) => kg(r.quantity_kg) },
              { label: 'Processor', render: (r) => r.processor_name ?? '-' },
              { label: 'Lab result', render: (r) => <Badge value={r.lab_decision} /> },
              { label: 'Status', render: (r) => <Badge value={r.status} /> },
            ]} />}
          </Async>
        </Card>
      </div>
    </>
  );
}
