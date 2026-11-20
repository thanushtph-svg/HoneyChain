import { useState } from 'react';
import { patch, post, qs } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, PageHeader, Pager, Table, useAction, useApi, useForm, fmtDateTime } from '../../components/ui.jsx';

const ORG_FOR_ROLE = { LAB: 'LABORATORY', PROCESSOR: 'PROCESSOR', DISTRIBUTOR: 'DISTRIBUTOR' };

export default function Users() {
  const { user: me } = useAuth();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const s = useApi(`/admin/users${qs({ page, role, q })}`);
  const orgs = useApi('/admin/organizations');
  const f = useForm({ email: '', fullName: '', phone: '', role: 'LAB', orgId: '', tempPassword: '' });
  const a = useAction();
  const t = useAction();
  const orgOptions = (orgs.data ?? []).filter((o) => o.org_type === ORG_FOR_ROLE[f.values.role] && o.is_active);

  return (
    <>
      <PageHeader title="Users & roles" subtitle="Create staff accounts and activate/deactivate users. Beekeepers register themselves." />
      <Card title="Create staff account">
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        <form className="form-grid" onSubmit={async (e) => {
          e.preventDefault();
          const body = { ...f.values, orgId: f.values.role === 'ADMIN' ? undefined : Number(f.values.orgId) };
          if (await a.run(() => post('/admin/users', body), (r) => `Created ${r.data.email} - share the temporary password securely`)) { f.reset(); s.reload(); }
        }}>
          <Field label="Role"><select {...f.bind('role')}>{['LAB', 'PROCESSOR', 'DISTRIBUTOR', 'ADMIN'].map((r) => <option key={r}>{r}</option>)}</select></Field>
          {f.values.role !== 'ADMIN' ? (
            <Field label="Organization" hint={orgOptions.length === 0 ? 'Create an organization of the matching type first' : undefined}>
              <select required {...f.bind('orgId')}><option value="">Select...</option>{orgOptions.map((o) => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}</select>
            </Field>
          ) : <span />}
          <Field label="Full name"><input required {...f.bind('fullName')} /></Field>
          <Field label="Email"><input type="email" required {...f.bind('email')} /></Field>
          <Field label="Phone"><input {...f.bind('phone')} /></Field>
          <Field label="Temporary password" hint="8+ characters, letter and digit"><input type="text" required {...f.bind('tempPassword')} /></Field>
          <div className="full"><button className="btn" disabled={a.busy}>Create user</button></div>
        </form>
      </Card>
      <Card title="All users">
        <ErrorBox error={t.error} />
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select className="btn secondary" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>{['ADMIN', 'BEEKEEPER', 'LAB', 'PROCESSOR', 'DISTRIBUTOR'].map((r) => <option key={r}>{r}</option>)}
          </select>
          <input placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ padding: '7px 10px', borderRadius: 9, border: '1px solid var(--line)', font: 'inherit' }} />
        </div>
        <Async state={s} empty="No users match.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.user_id} columns={[
                { label: 'Name', render: (r) => <>{r.full_name} <DemoBadge show={r.is_demo} /><br /><small>{r.email}</small></> },
                { label: 'Role', render: (r) => <Badge value={r.role_code} kind="honey" /> },
                { label: 'Organization', key: 'org_name' },
                { label: 'Last login', render: (r) => fmtDateTime(r.last_login_at) },
                { label: 'Status', render: (r) => <Badge value={r.is_active ? 'ACTIVE' : 'INACTIVE'} /> },
                { label: '', render: (r) => r.user_id === me.id ? <small className="muted">you</small> : (
                  <button className="btn secondary small" disabled={t.busy} onClick={async () => { if (await t.run(() => patch(`/admin/users/${r.user_id}`, { isActive: !r.is_active }))) s.reload(); }}>
                    {r.is_active ? 'Deactivate' : 'Activate'}
                  </button>
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
