import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, Field, PageHeader, Table, useAction, useApi, useForm, fmtDate, today, useBase } from '../../components/ui.jsx';

const DEST = ['WAREHOUSE', 'DISTRIBUTOR', 'RETAILER', 'INSTITUTION', 'OTHER'];

export default function DispatchQueue() {
  const base = useBase();
  const [sp] = useSearchParams();
  const s = useApi('/distribution/queue');
  const [sel, setSel] = useState(sp.get('batch') ?? '');
  const a = useAction();
  const f = useForm({ dispatchDate: today(), originLocation: '', destinationName: '', destinationType: 'RETAILER', destinationCity: '', destinationState: 'Karnataka', carrierName: '', trackingReference: '', unitsShipped: '' });
  const batch = (s.data ?? []).find((b) => b.batch_code === sel);

  // pre-fill origin and units whenever a batch is selected (button or ?batch= link)
  useEffect(() => {
    if (batch) f.setValues((v) => ({ ...v, originLocation: `${batch.processor_name}, ${batch.processor_city}`, unitsShipped: batch.units_remaining }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, s.data]);

  return (
    <>
      <PageHeader title="Distribution" subtitle="Batches your company has accepted that still have packed units to ship" />
      <Card>
        <Async state={s} empty="Nothing to dispatch. Accept incoming batches first.">
          {(rows) => <Table rows={rows} rowKey={(r) => r.batch_code} columns={[
            { label: 'Batch', render: (r) => <><Link to={base(`batches/${r.batch_code}`)}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
            { label: 'Honey', key: 'honey_type' },
            { label: 'Processor', render: (r) => `${r.processor_name}, ${r.processor_city}` },
            { label: 'Packed', render: (r) => `${r.units_packed} × ${r.unit_size_g} g (${fmtDate(r.packaging_date)})` },
            { label: 'Lab result', render: (r) => <Badge value={r.lab_decision} /> },
            { label: 'Best before', render: (r) => fmtDate(r.best_before) },
            { label: 'Units left', key: 'units_remaining' },
            { label: 'Status', render: (r) => <Badge value={r.status} /> },
            { label: '', render: (r) => <button className="btn small" onClick={() => { setSel(r.batch_code); a.setMessage(null); }}>Dispatch</button> },
          ]} />}
        </Async>
      </Card>
      {a.message && <Alert kind="success">{a.message} <Link to={base('delivery')}>Update delivery status</Link></Alert>}
      {batch && (
        <Card title={`Dispatch ${batch.batch_code} (${batch.units_remaining} units available)`}>
          <ErrorBox error={a.error} />
          <form className="form-grid" onSubmit={async (e) => {
            e.preventDefault();
            if (!window.confirm(`Dispatch ${f.values.unitsShipped} units of ${batch.batch_code} to ${f.values.destinationName}?`)) return;
            const r = await a.run(() => post('/shipments', { batchCode: batch.batch_code, ...f.values }), (res) => `Shipment ${res.data.shipment_code} dispatched`);
            if (r) { setSel(''); s.reload(); }
          }}>
            <Field label="Dispatch date"><input type="date" required max={today()} {...f.bind('dispatchDate')} /></Field>
            <Field label="Units shipped"><input type="number" min="1" max={batch.units_remaining} required {...f.bind('unitsShipped')} /></Field>
            <Field label="Dispatched from" full><input required {...f.bind('originLocation')} /></Field>
            <Field label="Recipient / destination name"><input required {...f.bind('destinationName')} /></Field>
            <Field label="Destination type"><select {...f.bind('destinationType')}>{DEST.map((d) => <option key={d}>{d}</option>)}</select></Field>
            <Field label="City"><input required {...f.bind('destinationCity')} /></Field>
            <Field label="State"><input required {...f.bind('destinationState')} /></Field>
            <Field label="Carrier"><input {...f.bind('carrierName')} /></Field>
            <Field label="Vehicle / docket no. (private)"><input {...f.bind('trackingReference')} /></Field>
            <div className="full btn-row"><button className="btn" disabled={a.busy}>{a.busy ? 'Saving...' : 'Record dispatch'}</button><button type="button" className="btn secondary" onClick={() => setSel('')}>Cancel</button></div>
          </form>
        </Card>
      )}
    </>
  );
}
