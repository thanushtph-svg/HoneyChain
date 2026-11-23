// Batches this unit has ACCEPTED: record processing as one or more steps (any of the supported methods,
// each saved independently), then finalize processing explicitly (quantities, loss, packaging).
// Saving a step never finalizes. Methods and their fields come from the backend (/processing/methods).
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, post } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, Loading, PageHeader, Table, useAction, useApi, useBase, useForm, fmtDate, fmtDateTime, kg, today } from '../../components/ui.jsx';

const PACK = ['GLASS_JAR', 'PET_JAR', 'SACHET', 'TIN', 'BULK_DRUM', 'OTHER'];

function StepForm({ method, batchCode, onSaved, onCancel }) {
  const a = useAction();
  const [stepDate, setStepDate] = useState(today());
  const [details, setDetails] = useState('');
  const [params, setParams] = useState({});
  return (
    <form className="form-grid" style={{ marginTop: 8 }} onSubmit={async (e) => {
      e.preventDefault();
      const parameters = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
      const r = await a.run(() => post(`/processing/batches/${batchCode}/steps`, { method: method.code, stepDate, details: details || undefined, parameters }));
      if (r) onSaved(r.data);
    }}>
      <Field label="Step date"><input type="date" required max={today()} value={stepDate} onChange={(e) => setStepDate(e.target.value)} /></Field>
      {method.fields.map((fd) => (
        <Field key={fd.key} label={`${fd.label}${fd.required ? ' *' : ''}`} hint={`${fd.min}-${fd.max} ${fd.unit}`}>
          <div className="input-unit">
            <input type="number" step="any" min={fd.min} max={fd.max} required={fd.required} aria-label={fd.label}
              value={params[fd.key] ?? ''} onChange={(e) => setParams((p) => ({ ...p, [fd.key]: e.target.value }))} />
            <span className="unit">{fd.unit}</span>
          </div>
        </Field>
      ))}
      <Field label={`Details${method.requiresDetails ? ' *' : ''}`} full>
        <input required={Boolean(method.requiresDetails)} minLength={method.requiresDetails ? 5 : undefined} value={details}
          placeholder="What was done (optional unless 'Other')" onChange={(e) => setDetails(e.target.value)} />
      </Field>
      <ErrorBox error={a.error} />
      <div className="full btn-row">
        <button className="btn small" disabled={a.busy}>{a.busy ? 'Saving...' : `Save ${method.label} step`}</button>
        <button type="button" className="btn secondary small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function FinalizeForm({ batch, steps, onDone }) {
  const a = useAction();
  const f = useForm({ processingDate: today(), methodDetails: '', operatorName: '', operatorStaffId: '', inputQuantityKg: batch.quantity_kg, outputQuantityKg: '',
    packagingDate: today(), packagingType: 'GLASS_JAR', unitSizeG: 500, unitsPacked: '', bestBefore: '' });
  const packedKg = ((Number(f.values.unitsPacked) || 0) * (Number(f.values.unitSizeG) || 0)) / 1000;
  const lossKg = (Number(f.values.inputQuantityKg) || 0) - (Number(f.values.outputQuantityKg) || 0);
  const lossPct = Number(f.values.inputQuantityKg) ? (lossKg / Number(f.values.inputQuantityKg)) * 100 : 0;
  const v = f.values;
  const missing = [
    !steps.length && 'at least one saved processing step',
    !v.operatorName.trim() && 'operator name',
    !(Number(v.inputQuantityKg) > 0) && 'input quantity',
    !(Number(v.outputQuantityKg) > 0) && 'output quantity',
    Number(v.outputQuantityKg) > Number(v.inputQuantityKg) && 'output must not exceed input',
    !(Number(v.unitsPacked) > 0) && 'units packed',
    packedKg > Number(v.outputQuantityKg) && 'packed mass must not exceed output',
    !v.bestBefore && 'best-before date',
  ].filter(Boolean);
  return (
    <Card title={`Finalize processing for ${batch.batch_code}`}>
      <p className="muted">Finalizing records quantities, loss and packaging, lists every saved step, sets the batch to PROCESSED and anchors the record on the blockchain. It cannot be edited afterwards.</p>
      <ErrorBox error={a.error} />
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        if (!window.confirm(`Finalize processing for ${batch.batch_code}: ${steps.length} step(s), ${v.inputQuantityKg} kg in, ${v.outputQuantityKg} kg out (${lossKg.toFixed(2)} kg loss), ${v.unitsPacked} units? This cannot be edited later.`)) return;
        const r = await a.run(() => post('/processing', { batchCode: batch.batch_code, ...v, methodDetails: v.methodDetails || undefined }));
        if (r) onDone(`Finalized ${r.data.processing_code} for ${batch.batch_code} (loss ${r.data.loss_kg} kg).`);
      }}>
        <Field label="Processing completed on"><input type="date" required max={today()} {...f.bind('processingDate')} /></Field>
        <Field label="Notes / reason for losses"><input placeholder="optional" {...f.bind('methodDetails')} /></Field>
        <Field label="Operator name *"><input required {...f.bind('operatorName')} /></Field>
        <Field label="Operator staff ID"><input {...f.bind('operatorStaffId')} /></Field>
        <Field label="Input quantity *" hint={`Batch quantity received: ${kg(batch.quantity_kg)}`}>
          <div className="input-unit"><input type="number" step="0.01" min="0.01" max={batch.quantity_kg} required {...f.bind('inputQuantityKg')} /><span className="unit">kg</span></div>
        </Field>
        <Field label="Output quantity *" hint={v.outputQuantityKg ? `Processing loss: ${lossKg.toFixed(2)} kg (${lossPct.toFixed(1)}%)` : 'Quantity after processing'}>
          <div className="input-unit"><input type="number" step="0.01" min="0.01" required {...f.bind('outputQuantityKg')} /><span className="unit">kg</span></div>
        </Field>
        <Field label="Packaging date"><input type="date" required max={today()} {...f.bind('packagingDate')} /></Field>
        <Field label="Packaging type"><select {...f.bind('packagingType')}>{PACK.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Unit size"><div className="input-unit"><input type="number" min="1" required {...f.bind('unitSizeG')} /><span className="unit">g</span></div></Field>
        <Field label="Units packed *" hint={`= ${packedKg.toFixed(2)} kg packed (must not exceed output)`}><input type="number" min="1" required {...f.bind('unitsPacked')} /></Field>
        <Field label="Best before *"><input type="date" required {...f.bind('bestBefore')} /></Field>
        {lossPct > 10 && <div className="full"><Alert kind="warn">Loss above 10% will be flagged for review by the anomaly checks. Explain it in the notes.</Alert></div>}
        {missing.length > 0 && <div className="full"><Alert kind="info">To finalize, complete: {missing.join(', ')}.</Alert></div>}
        <div className="full"><button className="btn" disabled={a.busy || missing.length > 0}>{a.busy ? 'Finalizing...' : 'Finalize Processing'}</button></div>
      </form>
    </Card>
  );
}

function BatchProcessing({ batch, methods, onFinalized }) {
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState(null);
  const rm = useAction();
  const load = async () => {
    try { setView((await get(`/processing/batches/${batch.batch_code}/steps`)).data); setErr(null); } catch (e) { setErr(e); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setView(null); setOpen(null); setMsg(null); load(); }, [batch.batch_code]);
  if (err) return <ErrorBox error={err} />;
  if (!view) return <Loading />;
  const steps = view.steps;
  return (
    <>
      <Card title={<>Processing {batch.batch_code} <Badge value={view.finalized ? 'PROCESSED' : 'IN_PROCESSING'} /></>}
        actions={<small className="muted">{steps.length} step(s) saved · {view.finalized ? `finalized ${fmtDateTime(view.finalizedAt)}` : 'not finalized'}</small>}>
        {msg && <Alert kind="success">{msg}</Alert>}
        <p className="muted">Choose every method you applied. Each step is saved on its own; saving a step does <strong>not</strong> finalize processing.</p>
        <div className="method-grid">
          {methods.map((m) => (
            <div key={m.code} className={`method-card ${open === m.code ? 'active' : ''}`}>
              <h3>{m.label} {steps.some((s) => s.method === m.code) && <Badge value="SAVED" kind="ok" />}</h3>
              <p>{m.instructions}</p>
              {m.fields.length > 0 && <p><small>Records: {m.fields.map((fd) => `${fd.label} (${fd.unit})`).join(', ')}</small></p>}
              {open === m.code
                ? <StepForm method={m} batchCode={batch.batch_code} onCancel={() => setOpen(null)} onSaved={(s) => { setOpen(null); setMsg(`Saved step ${s.step_no}: ${m.label} (${s.step_code}).`); load(); }} />
                : <button className="btn secondary small" disabled={view.finalized} onClick={() => { setOpen(m.code); setMsg(null); }}>Add {m.label} step</button>}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Saved processing steps">
        <ErrorBox error={rm.error} />
        {steps.length === 0 ? <p className="muted">No steps saved yet.</p> : (
          <Table rows={steps} rowKey={(s) => s.step_code} columns={[
            { label: '#', key: 'step_no' }, { label: 'Method', render: (s) => methods.find((m) => m.code === s.method)?.label ?? s.method },
            { label: 'Date', render: (s) => fmtDate(s.step_date) },
            { label: 'Parameters', render: (s) => {
              const def = methods.find((m) => m.code === s.method);
              return Object.entries(s.parameters ?? {}).map(([k, val]) => { const fd = def?.fields.find((x) => x.key === k); return `${fd?.label ?? k}: ${val} ${fd?.unit ?? ''}`; }).join(' · ') || '-';
            } },
            { label: 'Details', render: (s) => s.details ?? '-' },
            { label: 'Saved', render: (s) => <>{fmtDateTime(s.created_at)}<br /><small>{s.recorded_by_name} · {s.step_code}</small></> },
            { label: '', render: (s) => !view.finalized && <button className="btn secondary small" disabled={rm.busy} onClick={async () => {
              if (!window.confirm(`Remove step ${s.step_no} (${s.method})?`)) return;
              if (await rm.run(() => del(`/processing/batches/${batch.batch_code}/steps/${s.step_code}`))) load();
            }}>Remove</button> },
          ]} />
        )}
      </Card>
      {!view.finalized && <FinalizeForm batch={batch} steps={steps} onDone={onFinalized} />}
    </>
  );
}

export default function ProcessingQueue() {
  const base = useBase();
  const [sp] = useSearchParams();
  const s = useApi('/processing/queue');
  const methods = useApi('/processing/methods');
  const [sel, setSel] = useState(sp.get('batch') ?? '');
  const [done, setDone] = useState(null);
  const batch = (s.data ?? []).find((b) => b.batch_code === sel);

  return (
    <>
      <PageHeader title="Processing" subtitle="Batches your unit has accepted. Save each processing method as a step, then finalize processing explicitly." />
      {done && <Alert kind="success">{done} Next: <Link to={base('processed')}>request laboratory testing</Link>.</Alert>}
      <Card title="Accepted batches waiting for processing">
        <Async state={s} empty="No accepted batches. Accept incoming batches first.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
            { label: 'Honey', key: 'honey_type' }, { label: 'Qty', render: (r) => kg(r.quantity_kg) },
            { label: 'Origin', render: (r) => <>{r.beekeeper_name}<br /><small>{r.district}, {r.state} · harvested {fmtDate(r.harvest_date)}</small></> },
            { label: 'Received', render: (r) => <>{fmtDateTime(r.received_at)}<br /><small>{r.transfer_code}</small></> },
            { label: 'Steps saved', render: (r) => <>{r.steps_saved} <Badge value={r.status} /></> },
            { label: '', render: (r) => <button className="btn small" onClick={() => { setSel(r.batch_code); setDone(null); }}>{r.steps_saved ? 'Continue processing' : 'Record processing'}</button> },
          ]} />}
        </Async>
      </Card>
      <ErrorBox error={methods.error} />
      {batch && methods.data && <BatchProcessing batch={batch} methods={methods.data} onFinalized={(m) => { setDone(m); setSel(''); s.reload(); }} />}
    </>
  );
}
