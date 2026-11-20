import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, ErrorBox, Field, PageHeader, Table, useAction, useApi, fmtDate, kg } from '../../components/ui.jsx';

export default function HarvestDetail() {
  const { harvestCode } = useParams();
  const { user } = useAuth();
  const s = useApi(`/harvests/${harvestCode}`, [harvestCode]);
  const labs = useApi(user.role === 'BEEKEEPER' ? '/labs' : null);
  const [rows, setRows] = useState([{ quantityKg: '', honeyType: '' }]);
  const [labOrgId, setLabOrgId] = useState('');
  const a = useAction();

  const total = rows.reduce((t, r) => t + (Number(r.quantityKg) || 0), 0);
  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const submit = async (e) => {
    e.preventDefault();
    const body = { batches: rows.map((r) => ({ quantityKg: r.quantityKg, honeyType: r.honeyType })), ...(labOrgId ? { labOrgId: Number(labOrgId) } : {}) };
    const r = await a.run(() => post(`/harvests/${harvestCode}/batches`, body), (res) => `Created ${res.data.map((b) => b.batch_code).join(', ')} (with QR codes)`);
    if (r) { setRows([{ quantityKg: '', honeyType: '' }]); s.reload(); }
  };

  return (
    <Async state={s}>
      {(h) => (
        <>
          <PageHeader title={`Harvest ${h.harvest_code}`} subtitle={`${h.hive_code} · ${fmtDate(h.harvest_date)} · ${h.floral_source}`} />
          <div className="grid grid-3" style={{ marginBottom: 18 }}>
            <div className="stat"><div className="label">Harvested</div><div className="value">{kg(h.quantity_kg)}</div></div>
            <div className="stat"><div className="label">Already batched</div><div className="value">{kg(h.batched_kg)}</div></div>
            <div className="stat"><div className="label">Remaining</div><div className="value">{kg(h.remaining_kg)}</div></div>
          </div>
          {user.role === 'BEEKEEPER' && Number(h.remaining_kg) > 0 && (
            <Card title="Create batches from this harvest">
              <p className="muted">Each batch gets a unique Batch ID and its own QR code. The total cannot exceed the remaining quantity - the database enforces this.</p>
              <ErrorBox error={a.error} />
              {a.message && <Alert kind="success">{a.message}</Alert>}
              <form onSubmit={submit}>
                {rows.map((r, i) => (
                  <div className="form-grid" key={i} style={{ marginBottom: 8 }}>
                    <Field label={`Batch ${i + 1} quantity (kg)`}><input type="number" step="0.01" min="0.01" required value={r.quantityKg} onChange={(e) => setRow(i, 'quantityKg', e.target.value)} /></Field>
                    <Field label="Honey type"><input required placeholder={h.floral_source} value={r.honeyType} onChange={(e) => setRow(i, 'honeyType', e.target.value)} /></Field>
                  </div>
                ))}
                <div className="btn-row" style={{ marginBottom: 12 }}>
                  <button type="button" className="btn secondary small" onClick={() => setRows([...rows, { quantityKg: '', honeyType: h.floral_source }])}>+ Add another batch</button>
                  {rows.length > 1 && <button type="button" className="btn secondary small" onClick={() => setRows(rows.slice(0, -1))}>Remove last</button>}
                  <span className={total > Number(h.remaining_kg) ? 'badge bad' : 'badge'}>Total {total.toFixed(2)} / {h.remaining_kg} kg</span>
                </div>
                <Field label="Send to laboratory (optional - can be done later)">
                  <select value={labOrgId} onChange={(e) => setLabOrgId(e.target.value)}>
                    <option value="">Decide later</option>
                    {(labs.data ?? []).map((l) => <option key={l.org_id} value={l.org_id}>{l.name} ({l.city})</option>)}
                  </select>
                </Field>
                <div style={{ marginTop: 12 }}><button className="btn" disabled={a.busy}>{a.busy ? 'Creating...' : 'Create batches'}</button></div>
              </form>
            </Card>
          )}
          <Card title="Batches from this harvest">
            <Table rows={h.batches} empty="No batches yet." rowKey={(r) => r.batch_code} columns={[
              { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
              { label: 'Quantity', render: (r) => kg(r.quantity_kg) }, { label: 'Honey', key: 'honey_type' },
              { label: 'Lab', key: 'assigned_lab_name' }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
            ]} />
          </Card>
        </>
      )}
    </Async>
  );
}
