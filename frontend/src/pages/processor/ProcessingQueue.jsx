import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, PageHeader, Table, useAction, useApi, useForm, fmtDate, kg, today } from '../../components/ui.jsx';

const METHODS = ['FILTRATION', 'STRAINING', 'SETTLING', 'GENTLE_WARMING', 'CREAMING', 'OTHER'];
const PACK = ['GLASS_JAR', 'PET_JAR', 'SACHET', 'TIN', 'BULK_DRUM', 'OTHER'];

export default function ProcessingQueue() {
  const [sp] = useSearchParams();
  const s = useApi('/processing/queue');
  const [sel, setSel] = useState(sp.get('batch') ?? '');
  const a = useAction();
  const f = useForm({ processingDate: today(), method: 'FILTRATION', methodDetails: '', operatorName: '', operatorStaffId: '', inputQuantityKg: '', outputQuantityKg: '',
    packagingDate: today(), packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: '', bestBefore: '' });
  const batch = (s.data ?? []).find((b) => b.batch_code === sel);

  useEffect(() => {
    if (batch) f.setValues((v) => ({ ...v, inputQuantityKg: batch.quantity_kg }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, s.data]);

  const packedKg = ((Number(f.values.unitsPacked) || 0) * (Number(f.values.unitSizeG) || 0)) / 1000;

  return (
    <>
      <PageHeader title="Processing queue" subtitle="Batches with a submitted PASS decision from the laboratory" />
      <Card>
        <Async state={s} empty="No batches are ready for processing.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <><Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
            { label: 'Honey', key: 'honey_type' }, { label: 'Qty', render: (r) => kg(r.quantity_kg) },
            { label: 'Lab', render: (r) => <>{r.lab_name}<br /><small>{r.report_code} · {fmtDate(r.tested_on)}</small></> },
            { label: 'Moisture / HMF / Sucrose', render: (r) => `${r.moisture_pct}% / ${r.hmf_mg_kg} / ${r.sucrose_g_100g}` },
            { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
            { label: '', render: (r) => <button className="btn small" onClick={() => { setSel(r.batch_code); a.setMessage(null); a.setError(null); }}>Record processing</button> },
          ]} />}
        </Async>
      </Card>
      {a.message && <Alert kind="success">{a.message}</Alert>}
      {batch && (
        <Card title={`Processing record for ${batch.batch_code}`}>
          <ErrorBox error={a.error} />
          <form className="form-grid" onSubmit={async (e) => {
            e.preventDefault();
            const r = await a.run(() => post('/processing', { batchCode: batch.batch_code, ...f.values }), (res) => `Recorded ${res.data.processing_code} for ${batch.batch_code}`);
            if (r) { setSel(''); s.reload(); }
          }}>
            <Field label="Processing date"><input type="date" required max={today()} {...f.bind('processingDate')} /></Field>
            <Field label="Method"><select {...f.bind('method')}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Method details" full><input placeholder="e.g. cold filtration through 200-micron mesh" {...f.bind('methodDetails')} /></Field>
            <Field label="Operator name"><input required {...f.bind('operatorName')} /></Field>
            <Field label="Operator staff ID"><input {...f.bind('operatorStaffId')} /></Field>
            <Field label="Input quantity (kg)" hint={`Batch quantity: ${kg(batch.quantity_kg)}`}><input type="number" step="0.01" min="0.01" required {...f.bind('inputQuantityKg')} /></Field>
            <Field label="Output quantity (kg)"><input type="number" step="0.01" min="0.01" required {...f.bind('outputQuantityKg')} /></Field>
            <Field label="Packaging date"><input type="date" required max={today()} {...f.bind('packagingDate')} /></Field>
            <Field label="Packaging type"><select {...f.bind('packagingType')}>{PACK.map((p) => <option key={p}>{p}</option>)}</select></Field>
            <Field label="Unit size (g)"><input type="number" min="1" required {...f.bind('unitSizeG')} /></Field>
            <Field label="Units packed" hint={`= ${packedKg.toFixed(2)} kg packed (must not exceed output)`}><input type="number" min="1" required {...f.bind('unitsPacked')} /></Field>
            <Field label="Best before"><input type="date" required {...f.bind('bestBefore')} /></Field>
            <div className="full btn-row"><button className="btn" disabled={a.busy}>{a.busy ? 'Saving...' : 'Save processing record'}</button><button type="button" className="btn secondary" onClick={() => setSel('')}>Cancel</button></div>
          </form>
        </Card>
      )}
    </>
  );
}
