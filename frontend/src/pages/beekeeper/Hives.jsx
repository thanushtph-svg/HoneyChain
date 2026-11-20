import { useState } from 'react';
import { post, patch } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, PageHeader, Pager, Table, useAction, useApi, useForm, fmtDate, kg, today } from '../../components/ui.jsx';

const TYPES = ['LANGSTROTH', 'NEWTON', 'TOP_BAR', 'TRADITIONAL', 'OTHER'];

export default function Hives() {
  const [page, setPage] = useState(1);
  const s = useApi(`/hives?page=${page}`);
  const f = useForm({ hiveType: 'NEWTON', beeSpecies: 'Apis cerana indica', apiaryLocation: '', district: '', state: 'Karnataka', installedOn: today() });
  const a = useAction();
  const toggle = useAction();

  const submit = async (e) => {
    e.preventDefault();
    const r = await a.run(() => post('/hives', f.values), (res) => `Hive ${res.data.hive_code} registered`);
    if (r) { f.setValues({ ...f.values, apiaryLocation: '' }); s.reload(); }
  };

  return (
    <>
      <PageHeader title="My hives" subtitle="Register hives and manage their status. No sensors are involved - all details are entered by you." />
      <Card title="Register a hive">
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        <form onSubmit={submit} className="form-grid">
          <Field label="Hive type"><select {...f.bind('hiveType')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Bee species"><input required {...f.bind('beeSpecies')} /></Field>
          <Field label="Apiary location" full><input required placeholder="e.g. Mango orchard near the village tank" {...f.bind('apiaryLocation')} /></Field>
          <Field label="District"><input required {...f.bind('district')} /></Field>
          <Field label="State"><input required {...f.bind('state')} /></Field>
          <Field label="Installed on"><input type="date" required max={today()} {...f.bind('installedOn')} /></Field>
          <div className="full"><button className="btn" disabled={a.busy}>{a.busy ? 'Saving...' : 'Register hive'}</button></div>
        </form>
      </Card>
      <Card title="Registered hives">
        <ErrorBox error={toggle.error} />
        <Async state={s} empty="No hives yet - register your first hive above.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.hive_code} columns={[
                { label: 'Hive', render: (r) => <>{r.hive_code} <DemoBadge show={r.is_demo} /></> },
                { label: 'Type / species', render: (r) => <>{r.hive_type}<br /><small>{r.bee_species}</small></> },
                { label: 'Location', render: (r) => <>{r.apiary_location}<br /><small>{r.district}, {r.state}</small></> },
                { label: 'Installed', render: (r) => fmtDate(r.installed_on) },
                { label: 'Harvests', render: (r) => `${r.harvest_count} (${kg(r.total_harvest_kg)})` },
                { label: 'Status', render: (r) => <Badge value={r.status} /> },
                { label: '', render: (r) => (
                  <button className="btn secondary small" disabled={toggle.busy}
                    onClick={async () => { if (await toggle.run(() => patch(`/hives/${r.hive_code}`, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))) s.reload(); }}>
                    {r.status === 'ACTIVE' ? 'Mark inactive' : 'Reactivate'}
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
