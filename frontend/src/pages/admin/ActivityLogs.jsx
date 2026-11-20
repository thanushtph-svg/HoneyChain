import { useState } from 'react';
import { qs } from '../../api/client.js';
import { Async, Badge, Card, PageHeader, Pager, Table, useApi, fmtDateTime } from '../../components/ui.jsx';

export default function ActivityLogs() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const s = useApi(`/admin/activity-logs${qs({ page, action })}`);
  return (
    <>
      <PageHeader title="Activity logs" subtitle="Audit trail stored in MongoDB (public QR scan entries auto-expire after 90 days)" />
      <Card>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input placeholder="Filter by action, e.g. LOGIN" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
            style={{ padding: '7px 10px', borderRadius: 9, border: '1px solid var(--line)', font: 'inherit' }} />
        </div>
        <Async state={s} empty="No log entries.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r._id} columns={[
                { label: 'When', render: (r) => fmtDateTime(r.at) },
                { label: 'Action', render: (r) => <code>{r.action}</code> },
                { label: 'Actor', render: (r) => (r.actor ? `user #${r.actor.userId} (${r.actor.role})` : 'public / system') },
                { label: 'Entity', render: (r) => (r.entity ? `${r.entity.type} ${r.entity.code ?? r.entity.id}` : '-') },
                { label: 'Outcome', render: (r) => <Badge value={r.outcome} kind={r.outcome === 'SUCCESS' ? 'ok' : 'bad'} /> },
                { label: 'Details', render: (r) => <small><code>{Object.keys(r.details ?? {}).length ? JSON.stringify(r.details).slice(0, 120) : ''}</code></small> },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
