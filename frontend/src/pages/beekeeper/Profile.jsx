import { useEffect } from 'react';
import { patch, post } from '../../api/client.js';
import { Alert, Async, Card, ErrorBox, Field, PageHeader, useAction, useApi, useForm } from '../../components/ui.jsx';

export default function Profile() {
  const s = useApi('/beekeeper/profile');
  const f = useForm({});
  const a = useAction();
  const pw = useForm({ currentPassword: '', newPassword: '' });
  const pa = useAction();

  useEffect(() => {
    if (s.data) f.setValues({
      publicDisplayName: s.data.public_display_name, showNamePublicly: s.data.show_name_publicly, cooperativeName: s.data.cooperative_name ?? '',
      village: s.data.village ?? '', district: s.data.district, state: s.data.state, registrationNo: s.data.registration_no ?? '', phone: s.data.phone ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.data]);

  return (
    <>
      <PageHeader title="My profile" />
      <Async state={s}>
        {(p) => (
          <div className="grid grid-2">
            <Card title={`${p.full_name} · ${p.beekeeper_code}`}>
              <ErrorBox error={a.error} />
              {a.message && <Alert kind="success">{a.message}</Alert>}
              <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => patch('/beekeeper/profile', f.values), 'Profile saved')) s.reload(); }}>
                <Field label="Email"><input value={p.email} disabled /></Field>
                <Field label="Phone (private)"><input {...f.bind('phone')} /></Field>
                <Field label="Public display name"><input required {...f.bind('publicDisplayName')} /></Field>
                <Field label="Cooperative"><input {...f.bind('cooperativeName')} /></Field>
                <Field label="Village"><input {...f.bind('village')} /></Field>
                <Field label="District"><input required {...f.bind('district')} /></Field>
                <Field label="State"><input required {...f.bind('state')} /></Field>
                <Field label="Registration no."><input {...f.bind('registrationNo')} /></Field>
                <label className="check full"><input type="checkbox" checked={Boolean(f.values.showNamePublicly)} onChange={(e) => f.setValues({ ...f.values, showNamePublicly: e.target.checked })} />
                  Show my display name on public QR pages (otherwise "Registered beekeeper" is shown)</label>
                <div className="full"><button className="btn" disabled={a.busy}>Save profile</button></div>
              </form>
            </Card>
            <Card title="Change password">
              <ErrorBox error={pa.error} />
              {pa.message && <Alert kind="success">{pa.message}</Alert>}
              <form className="grid" onSubmit={async (e) => { e.preventDefault(); if (await pa.run(() => post('/auth/change-password', pw.values), 'Password changed')) pw.reset(); }}>
                <Field label="Current password"><input type="password" required {...pw.bind('currentPassword')} /></Field>
                <Field label="New password" hint="At least 8 characters with a letter and a digit"><input type="password" required {...pw.bind('newPassword')} /></Field>
                <button className="btn" disabled={pa.busy}>Change password</button>
              </form>
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}
