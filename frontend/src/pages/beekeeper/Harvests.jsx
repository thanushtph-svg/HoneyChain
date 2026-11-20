import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api/client.js';
import { Alert, Async, Card, DemoBadge, ErrorBox, Field, PageHeader, Pager, Table, useAction, useApi, useForm, fmtDate, kg, today } from '../../components/ui.jsx';

export default function Harvests() {
  const [page, setPage] = useState(1);
  const s = useApi(`/harvests?page=${page}`);
  const hives = useApi('/hives?status=ACTIVE&pageSize=100');
  const f = useForm({ hiveCode: '', harvestDate: today(), quantityKg: '', floralSource: '', notes: '' });
  const a = useAction();

  const submit = async (e) => {
    e.preventDefault();
    const r = await a.run(() => post('/harvests', f.values), (res) => `Harvest ${res.data.harvest_code} recorded`);
    if (r) { f.setValues({ ...f.values, quantityKg: '', notes: '' }); s.reload(); }
  };

  return (
    <>
      <PageHeader title="Harvests" subtitle="Record each harvest; the system generates a Harvest ID. Then split it into batches." />
      <Card title="Record a harvest">
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        {hives.data?.length === 0 && <Alert kind="warn">You need an active hive first. <Link to="/app/hives">Register a hive</Link></Alert>}
        <form onSubmit={submit} className="form-grid">
          <Field label="Hive">
            <select required {...f.bind('hiveCode')}>
              <option value="">Select hive...</option>
              {(hives.data ?? []).map((h) => <option key={h.hive_code} value={h.hive_code}>{h.hive_code} - {h.apiary_location}</option>)}
            </select>
          </Field>
          <Field label="Harvest date"><input type="date" required max={today()} {...f.bind('harvestDate')} /></Field>
          <Field label="Quantity (kg)"><input type="number" step="0.01" min="0.01" max="500" required {...f.bind('quantityKg')} /></Field>
          <Field label="Floral source"><input required placeholder="e.g. Multifloral, Jamun, Eucalyptus" {...f.bind('floralSource')} /></Field>
          <Field label="Notes" full><textarea {...f.bind('notes')} /></Field>
          <div className="full"><button className="btn" disabled={a.busy}>{a.busy ? 'Saving...' : 'Record harvest'}</button></div>
        </form>
      </Card>
      <Card title="Harvest history">
        <Async state={s} empty="No harvests recorded yet.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.harvest_code} columns={[
                { label: 'Harvest ID', render: (r) => <><Link to={`/app/harvests/${r.harvest_code}`}>{r.harvest_code}</Link> <DemoBadge show={r.is_demo} /></> },
                { label: 'Hive', key: 'hive_code' },
                { label: 'Date', render: (r) => fmtDate(r.harvest_date) },
                { label: 'Floral source', key: 'floral_source' },
                { label: 'Quantity', render: (r) => kg(r.quantity_kg) },
                { label: 'Batched', render: (r) => `${kg(r.batched_kg)} in ${r.batch_count} batch(es)` },
                { label: '', render: (r) => Number(r.batched_kg) < Number(r.quantity_kg) ? <Link className="btn small" to={`/app/harvests/${r.harvest_code}`}>Create batches</Link> : <small className="muted">fully batched</small> },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
