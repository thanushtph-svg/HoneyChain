// User management: create accounts of all six roles, activate / deactivate, assign roles (audited).
import { useState } from 'react';
import { patch, post, qs } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, ConfirmButton, DemoBadge, ErrorBox, Field, PageHeader, Pager, Table, useAction, useApi, useForm, fmtDateTime } from '../../components/ui.jsx';
import { roleLabel } from '../../roles.js';

export const ROLE_CODES = ['BEEKEEPER', 'PROCESSOR', 'LAB_TESTER', 'DISTRIBUTOR', 'ADMIN', 'CONSUMER'];
export const ORG_FOR_ROLE = { LAB_TESTER: 'LABORATORY', PROCESSOR: 'PROCESSOR', DISTRIBUTOR: 'DISTRIBUTOR' };

function RoleChange({ u, orgs, onDone }) {
  const [open, setOpen] = useState(false);
  const f = useForm({ role: u.role_code === 'ADMIN' ? 'CONSUMER' : 'ADMIN', orgId: '', reason: '' });
  const a = useAction();
  if (u.role_code === 'BEEKEEPER') return <small className="muted" title="Beekeeper accounts own hives and harvests">role fixed</small>;
  if (!open) return <button className="btn secondary small" onClick={() => setOpen(true)}>Change role</button>;
  const options = orgs.filter((o) => o.org_type === ORG_FOR_ROLE[f.values.role] && o.is_active);
  return (
    <form className="inline-form" onSubmit={async (e) => {
      e.preventDefault();
      if (!window.confirm(`Change ${u.email} from ${roleLabel(u.role_code)} to ${roleLabel(f.values.role)}? This is recorded in the audit log.`)) return;
      const r = await a.run(() => patch(`/admin/users/${u.user_id}/role`, { role: f.values.role, orgId: ORG_FOR_ROLE[f.values.role] ? Number(f.values.orgId) : null, reason: f.values.reason }));
      if (r) { setOpen(false); onDone(); }
    }}>
      <select aria-label="New role" {...f.bind('role')}>{ROLE_CODES.filter((x) => x !== 'BEEKEEPER' && x !== u.role_code).map((x) => <option key={x} value={x}>{roleLabel(x)}</option>)}</select>
      {ORG_FOR_ROLE[f.values.role] && <select aria-label="Organization" required {...f.bind('orgId')}><option value="">Organization...</option>{options.map((o) => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}</select>}
      <input aria-label="Reason" required minLength={5} placeholder="Reason (recorded)" {...f.bind('reason')} />
      <ErrorBox error={a.error} />
      <div className="btn-row"><button className="btn small" disabled={a.busy}>Save role</button><button type="button" className="btn small secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

export default function Users() {
  const { user: me } = useAuth();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const s = useApi(`/admin/users${qs({ page, role, q })}`);
  const orgs = useApi('/admin/organizations');
  const f = useForm({ email: '', fullName: '', phone: '', role: 'LAB_TESTER', orgId: '', tempPassword: '', district: '', state: 'Karnataka', cooperativeName: '' });
  const a = useAction();
  const orgOptions = (orgs.data ?? []).filter((o) => o.org_type === ORG_FOR_ROLE[f.values.role] && o.is_active);
  const v = f.values;

  return (
    <>
      <PageHeader title="User management" subtitle="Create accounts for all six roles, activate or deactivate them, and assign roles. Every change is audited." />
      <Card title="Create an account">
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        <form className="form-grid" onSubmit={async (e) => {
          e.preventDefault();
          const body = { email: v.email, fullName: v.fullName, phone: v.phone, role: v.role, tempPassword: v.tempPassword,
            ...(ORG_FOR_ROLE[v.role] ? { orgId: Number(v.orgId) } : {}),
            ...(v.role === 'BEEKEEPER' ? { beekeeper: { district: v.district, state: v.state, cooperativeName: v.cooperativeName } } : {}) };
          if (!window.confirm(`Create ${roleLabel(v.role)} account for ${v.email}?`)) return;
          if (await a.run(() => post('/admin/users', body), (r) => `Created ${r.data.email} (${roleLabel(r.data.role_code)}) - share the temporary password securely`)) { f.reset(); s.reload(); }
        }}>
          <Field label="Role"><select {...f.bind('role')}>{ROLE_CODES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></Field>
          {ORG_FOR_ROLE[v.role] ? (
            <Field label="Organization" hint={orgOptions.length === 0 ? `Create a ${ORG_FOR_ROLE[v.role].toLowerCase()} organization in Settings first` : undefined}>
              <select required {...f.bind('orgId')}><option value="">Select...</option>{orgOptions.map((o) => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}</select>
            </Field>
          ) : <span />}
          <Field label="Full name"><input required {...f.bind('fullName')} /></Field>
          <Field label="Email"><input type="email" required {...f.bind('email')} /></Field>
          <Field label="Phone (private)"><input {...f.bind('phone')} /></Field>
          <Field label="Temporary password" hint="8+ characters, a letter and a digit"><input type="text" required {...f.bind('tempPassword')} /></Field>
          {v.role === 'BEEKEEPER' && (
            <>
              <Field label="District"><input required {...f.bind('district')} /></Field>
              <Field label="State"><input required {...f.bind('state')} /></Field>
              <Field label="Cooperative (optional)"><input {...f.bind('cooperativeName')} /></Field>
            </>
          )}
          <div className="full"><button className="btn" disabled={a.busy}>Create account</button></div>
        </form>
      </Card>
      <Card title="All users">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select aria-label="Role filter" className="btn secondary" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>{ROLE_CODES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
          <input className="search" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <Async state={s} empty="No users match.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.user_id} columns={[
                { label: 'Name', render: (r) => <>{r.full_name} <DemoBadge show={r.is_demo} /><br /><small>{r.email}</small></> },
                { label: 'Role', render: (r) => <Badge value={roleLabel(r.role_code)} kind="honey" /> },
                { label: 'Organization', render: (r) => r.org_name ?? (r.beekeeper_code ? `producer ${r.beekeeper_code}` : '-') },
                { label: 'Last login', render: (r) => fmtDateTime(r.last_login_at) },
                { label: 'Status', render: (r) => <Badge value={r.is_active ? 'ACTIVE' : 'INACTIVE'} /> },
                { label: '', render: (r) => r.user_id === me.id ? <small className="muted">you</small> : (
                  <div className="btn-row">
                    <ConfirmButton kind="secondary" confirm={`${r.is_active ? 'Deactivate' : 'Activate'} ${r.email}?${r.is_active ? ' Their open sessions stop working immediately.' : ''}`}
                      onClick={() => patch(`/admin/users/${r.user_id}`, { isActive: !r.is_active })} onDone={s.reload}>{r.is_active ? 'Deactivate' : 'Activate'}</ConfirmButton>
                    <RoleChange u={r} orgs={orgs.data ?? []} onDone={s.reload} />
                  </div>
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
