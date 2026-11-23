// Own account page for processors, lab testers, distributors, admins and consumers.
// (Beekeepers have a producer profile page with consent settings.)
import { useEffect } from 'react';
import { patch, post } from '../../api/client.js';
import { Alert, Async, Card, ErrorBox, Field, PageHeader, useAction, useApi, useForm, fmtDateTime } from '../../components/ui.jsx';
import { roleLabel } from '../../roles.js';

export function ChangePassword() {
  const pw = useForm({ currentPassword: '', newPassword: '' });
  const pa = useAction();
  return (
    <Card title="Change password">
      <ErrorBox error={pa.error} />
      {pa.message && <Alert kind="success">{pa.message}</Alert>}
      <form className="grid" onSubmit={async (e) => { e.preventDefault(); if (await pa.run(() => post('/auth/change-password', pw.values), 'Password changed')) pw.reset(); }}>
        <Field label="Current password"><input type="password" autoComplete="current-password" required {...pw.bind('currentPassword')} /></Field>
        <Field label="New password" hint="At least 8 characters with a letter and a digit"><input type="password" autoComplete="new-password" required {...pw.bind('newPassword')} /></Field>
        <button className="btn" disabled={pa.busy}>Change password</button>
      </form>
    </Card>
  );
}

export default function StaffProfile() {
  const s = useApi('/auth/me/profile');
  const f = useForm({ fullName: '', phone: '' });
  const a = useAction();
  useEffect(() => {
    if (s.data) f.setValues({ fullName: s.data.full_name, phone: s.data.phone ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.data]);
  return (
    <>
      <PageHeader title="My profile" subtitle="Your role and organization can only be changed by an administrator." />
      <Async state={s}>
        {(p) => (
          <div className="grid grid-2">
            <Card title="Account">
              <dl className="kv" style={{ marginBottom: 14 }}>
                <dt>Email</dt><dd>{p.email}</dd>
                <dt>Role</dt><dd>{roleLabel(p.role_code)}</dd>
                {p.org_name && <><dt>Organization</dt><dd>{p.org_name} ({p.org_code}) · {p.org_city}, {p.org_state}</dd></>}
                <dt>Member since</dt><dd>{fmtDateTime(p.created_at)}</dd>
                <dt>Last login</dt><dd>{fmtDateTime(p.last_login_at)}</dd>
              </dl>
              <ErrorBox error={a.error} />
              {a.message && <Alert kind="success">{a.message}</Alert>}
              <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => patch('/auth/me/profile', f.values), 'Profile saved')) s.reload(); }}>
                <Field label="Full name"><input required {...f.bind('fullName')} /></Field>
                <Field label="Phone (private)"><input {...f.bind('phone')} /></Field>
                <div className="full"><button className="btn" disabled={a.busy}>Save</button></div>
              </form>
            </Card>
            <ChangePassword />
          </div>
        )}
      </Async>
    </>
  );
}
