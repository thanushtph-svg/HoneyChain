// System-level reports: quantity reconciliation across the chain, and security events from the audit log.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Badge, Card, DemoBadge, PageHeader, Table, Tabs, useApi, useBase, fmtDateTime, kg } from '../../components/ui.jsx';

function Reconciliation() {
  const base = useBase();
  const s = useApi('/admin/reports/reconciliation');
  return (
    <Async state={s} empty="No batches yet.">
      {(rows) => {
        const issues = rows.filter((r) => r.issues.length);
        return (
          <>
            <p className={issues.length ? '' : 'muted'}>{issues.length ? <Badge value={`${issues.length} batch(es) with quantity issues`} kind="bad" /> : 'Quantities are consistent for every batch: harvest ≥ batches, batch ≥ processing input, packed ≥ shipped.'}</p>
            <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /><br /><Badge value={r.status} /></> },
              { label: 'Harvest', render: (r) => <>{r.harvest_code}<br /><small>{kg(r.harvest_allocated_kg)} of {kg(r.harvest_kg)} batched</small></> },
              { label: 'Batch qty', render: (r) => kg(r.batch_kg) },
              { label: 'Processing in → out', render: (r) => r.processing_input_kg ? <>{kg(r.processing_input_kg)} → {kg(r.processing_output_kg)}<br /><small>loss {kg(r.processing_loss_kg)} ({r.loss_pct}%)</small></> : '-' },
              { label: 'Units packed / shipped / delivered', render: (r) => r.units_packed ? `${r.units_packed} / ${r.units_shipped} / ${r.units_delivered}` : '-' },
              { label: 'Rejections', render: (r) => `${r.rejected_transfers} transfer · ${r.rejected_lab_requests} lab` },
              { label: 'Issues', render: (r) => (r.issues.length ? r.issues.map((i) => <Badge key={i} value={i} kind="bad" />) : <Badge value="OK" kind="ok" />) },
            ]} />
          </>
        );
      }}
    </Async>
  );
}

function Security() {
  const [days, setDays] = useState(7);
  const s = useApi(`/admin/security-events?days=${days}`);
  return (
    <>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <select aria-label="Period" className="btn secondary" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} day(s)</option>)}
        </select>
      </div>
      <Async state={s}>
        {(d) => (
          <>
            <div className="grid grid-4" style={{ marginBottom: 14 }}>
              <div className="stat"><div className="label">Access denied</div><div className="value">{d.counts.ACCESS_DENIED}</div><div className="sub">a role tried another role's API</div></div>
              <div className="stat"><div className="label">Failed logins</div><div className="value">{d.counts.LOGIN_FAILED}</div></div>
              <div className="stat"><div className="label">Top source IP</div><div className="value" style={{ fontSize: '1rem' }}>{d.topIps[0]?.ip ?? '-'}</div><div className="sub">{d.topIps[0]?.n ?? 0} events</div></div>
              <div className="stat"><div className="label">Top user id</div><div className="value" style={{ fontSize: '1rem' }}>{d.topUsers[0]?.userId ?? '-'}</div><div className="sub">{d.topUsers[0]?.n ?? 0} denied requests</div></div>
            </div>
            <Table rows={d.recent} rowKey={(r) => r._id} empty="No security events in this period." columns={[
              { label: 'When', render: (r) => fmtDateTime(r.at) },
              { label: 'Event', render: (r) => <Badge value={r.action} kind={r.action === 'ACCESS_DENIED' ? 'bad' : 'warn'} /> },
              { label: 'User / role', render: (r) => (r.actor ? `#${r.actor.userId} · ${r.actor.role}` : r.details?.email ?? 'anonymous') },
              { label: 'Target', render: (r) => <code>{r.entity?.id ?? '-'}</code> },
              { label: 'IP', key: 'ip' },
            ]} />
          </>
        )}
      </Async>
    </>
  );
}

export default function Reports() {
  const [tab, setTab] = useState('reconciliation');
  return (
    <>
      <PageHeader title="Reports" subtitle="System-level reports computed from the live databases" />
      <Tabs value={tab} onChange={setTab} tabs={[['reconciliation', 'Quantity reconciliation'], ['security', 'Security events']]} />
      <Card>{tab === 'reconciliation' ? <Reconciliation /> : <Security />}</Card>
    </>
  );
}
