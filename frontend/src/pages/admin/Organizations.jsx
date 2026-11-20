import { patch, post } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, PageHeader, Table, useAction, useApi, useForm } from '../../components/ui.jsx';

export default function Organizations() {
  const s = useApi('/admin/organizations');
  const f = useForm({ name: '', orgType: 'LABORATORY', city: '', state: 'Karnataka', accreditationNo: '' });
  const a = useAction();
  const t = useAction();
  return (
    <>
      <PageHeader title="Organizations" subtitle="Laboratories, processing units and distributors. Staff users belong to one organization." />
      <Card title="Add organization">
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => post('/admin/organizations', f.values), (r) => `Created ${r.data.org_code}`)) { f.reset(); s.reload(); } }}>
          <Field label="Name"><input required {...f.bind('name')} /></Field>
          <Field label="Type"><select {...f.bind('orgType')}>{['LABORATORY', 'PROCESSOR', 'DISTRIBUTOR'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="City"><input required {...f.bind('city')} /></Field>
          <Field label="State"><input required {...f.bind('state')} /></Field>
          <Field label="Accreditation no. (labs)"><input {...f.bind('accreditationNo')} /></Field>
          <div className="full"><button className="btn" disabled={a.busy}>Add organization</button></div>
        </form>
      </Card>
      <Card>
        <ErrorBox error={t.error} />
        <Async state={s} empty="No organizations yet.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.org_id} columns={[
            { label: 'Code', key: 'org_code' },
            { label: 'Name', render: (r) => <>{r.name} <DemoBadge show={r.is_demo} /></> },
            { label: 'Type', render: (r) => <Badge value={r.org_type} kind="honey" /> },
            { label: 'Location', render: (r) => `${r.city}, ${r.state}` },
            { label: 'Accreditation', key: 'accreditation_no' },
            { label: 'Staff', key: 'staff_count' },
            { label: 'Status', render: (r) => <Badge value={r.is_active ? 'ACTIVE' : 'INACTIVE'} /> },
            { label: '', render: (r) => <button className="btn secondary small" disabled={t.busy} onClick={async () => { if (await t.run(() => patch(`/admin/organizations/${r.org_id}`, { isActive: !r.is_active }))) s.reload(); }}>{r.is_active ? 'Deactivate' : 'Activate'}</button> },
          ]} />}
        </Async>
      </Card>
    </>
  );
}
