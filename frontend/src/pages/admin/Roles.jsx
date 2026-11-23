// Role management: the six roles, their dashboards, permission matrix and the audited role-change history.
import { Async, Badge, Card, PageHeader, Table, useApi, fmtDateTime } from '../../components/ui.jsx';
import { roleLabel } from '../../roles.js';

export default function Roles() {
  const s = useApi('/admin/roles');
  const h = useApi('/admin/role-changes');
  return (
    <>
      <PageHeader title="Role management" subtitle="HoneyChain has exactly six roles. Permissions are enforced by the server on every request and by database triggers; this page documents them." />
      <Async state={s}>
        {(d) => (
          <>
            <div className="grid grid-3" style={{ marginBottom: 18 }}>
              {d.roles.map((r) => (
                <div className="stat" key={r.role_code}>
                  <div className="label">{r.role_code}</div>
                  <div className="value">{r.active_users}<small className="muted" style={{ fontSize: '0.9rem' }}> / {r.users} users</small></div>
                  <div className="sub">{r.description}</div>
                  <div className="sub">Dashboard <code>{r.homePath}</code>{r.organizationType ? ` · belongs to a ${r.organizationType.toLowerCase()}` : ''}</div>
                </div>
              ))}
            </div>
            <Card title="Permission matrix">
              <div className="table-wrap">
                <table className="matrix">
                  <thead><tr><th>Permission</th>{d.roles.map((r) => <th key={r.role_code}>{roleLabel(r.role_code)}</th>)}</tr></thead>
                  <tbody>
                    {d.permissions.map((p) => (
                      <tr key={p.key}>
                        <td><strong>{p.description}</strong><br /><small><code>{p.key}</code></small></td>
                        {d.roles.map((r) => <td key={r.role_code} className="center">{p.roles.includes(r.role_code) ? <span className="badge ok" aria-label="allowed">✓</span> : <span className="muted" aria-label="not allowed">-</span>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </Async>
      <Card title="Role change history (database audit table)">
        <Async state={h} empty="No role changes yet.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.change_id} columns={[
            { label: 'When', render: (r) => fmtDateTime(r.changed_at) },
            { label: 'User', render: (r) => <>{r.full_name}<br /><small>{r.email}</small></> },
            { label: 'From', render: (r) => <>{r.old_role ? <Badge value={r.old_role} /> : '-'}{r.old_org_name ? <><br /><small>{r.old_org_name}</small></> : null}</> },
            { label: 'To', render: (r) => <><Badge value={r.new_role} kind="honey" />{r.new_org_name ? <><br /><small>{r.new_org_name}</small></> : null}</> },
            { label: 'Changed by', render: (r) => r.changed_by_name ?? 'system' },
          ]} />}
        </Async>
      </Card>
    </>
  );
}
