import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, DemoBadge, ErrorBox, PageHeader, Table, useAction, useApi, fmtDate, fmtDateTime, kg, short } from '../../components/ui.jsx';

function AssignLab({ batchCode, onDone }) {
  const labs = useApi('/labs');
  const [labId, setLabId] = useState('');
  const a = useAction();
  return (
    <Card title="Send for laboratory testing">
      <ErrorBox error={a.error} />
      {a.message && <Alert kind="success">{a.message}</Alert>}
      <div className="btn-row">
        <select className="btn secondary" value={labId} onChange={(e) => setLabId(e.target.value)}>
          <option value="">Choose a laboratory...</option>
          {(labs.data ?? []).map((l) => <option key={l.org_id} value={l.org_id}>{l.name} ({l.city})</option>)}
        </select>
        <button className="btn" disabled={!labId || a.busy}
          onClick={() => a.run(() => post(`/batches/${batchCode}/assign-lab`, { labOrgId: Number(labId) }), 'Laboratory assigned').then((r) => r && onDone())}>
          Assign laboratory
        </button>
      </div>
    </Card>
  );
}

export default function BatchDetail() {
  const { batchCode } = useParams();
  const { user } = useAuth();
  const s = useApi(`/batches/${batchCode}`, [batchCode]);
  const verify = useAction();
  const [verifyResults, setVerifyResults] = useState(null);

  return (
    <Async state={s}>
      {(d) => {
        const b = d.batch;
        const own = user.role === 'BEEKEEPER' && d.qr;
        return (
          <>
            <PageHeader
              title={<>{b.batch_code} <DemoBadge show={b.is_demo} /></>}
              subtitle={`${b.honey_type} · ${kg(b.batch_quantity_kg)} · from harvest ${b.harvest_code}`}
              actions={<>
                <Badge value={b.status} />
                <a className="btn secondary small" href={`/verify/${b.batch_code}`} target="_blank" rel="noreferrer">Public page</a>
              </>}
            />
            {user.role === 'LAB' && ['CREATED', 'IN_TESTING'].includes(b.status) && (
              <Alert kind="info">This batch is waiting for testing. <Link to={d.labReports.find((r) => r.report_state === 'DRAFT') ? `/app/lab/reports/${d.labReports.find((r) => r.report_state === 'DRAFT').report_code}` : `/app/lab/reports/new?batch=${b.batch_code}`}>Enter laboratory results</Link></Alert>
            )}
            {user.role === 'PROCESSOR' && b.status === 'LAB_PASSED' && <Alert kind="info">Ready for processing. <Link to={`/app/processing/queue?batch=${b.batch_code}`}>Record processing</Link></Alert>}
            {user.role === 'DISTRIBUTOR' && ['PROCESSED', 'IN_DISTRIBUTION'].includes(b.status) && d.unitsRemaining > 0 && <Alert kind="info">{d.unitsRemaining} packed units still to ship. <Link to={`/app/distribution/queue?batch=${b.batch_code}`}>Dispatch</Link></Alert>}
            {own && b.status === 'CREATED' && <AssignLab batchCode={b.batch_code} onDone={s.reload} />}

            <div className="grid grid-2">
              <Card title="Origin">
                <dl className="kv">
                  <dt>Beekeeper</dt><dd>{b.public_display_name} ({b.beekeeper_code}){b.beekeeper_email ? <><br /><small>{b.beekeeper_email}</small></> : null}</dd>
                  <dt>Cooperative</dt><dd>{b.cooperative_name ?? '-'}</dd>
                  <dt>Hive</dt><dd>{b.hive_code} · {b.hive_type} · {b.bee_species}</dd>
                  <dt>Location</dt><dd>{b.hive_district}, {b.hive_state}</dd>
                  <dt>Harvest</dt><dd>{b.harvest_code} · {fmtDate(b.harvest_date)} · {kg(b.harvest_quantity_kg)} · {b.floral_source}</dd>
                  <dt>Assigned lab</dt><dd>{b.assigned_lab_name ?? 'not assigned'}</dd>
                </dl>
              </Card>
              <Card title="QR code">
                {d.qr ? (
                  <div className="qr-box">
                    <img src={`/api/v1/qr/${b.batch_code}.png?size=360`} alt={`QR code for ${b.batch_code}`} />
                    <p><code>{d.qr.public_url}</code></p>
                    <div className="btn-row" style={{ justifyContent: 'center' }}>
                      <a className="btn small" href={`/api/v1/qr/${b.batch_code}.png?size=1024&download=1`}>Download PNG</a>
                      <a className="btn secondary small" href={`/api/v1/qr/${b.batch_code}.svg?download=1`}>Download SVG</a>
                    </div>
                    <p className="muted" style={{ fontSize: '0.8rem' }}>Scanned {d.qr.scan_count} times{d.qr.last_scanned_at ? `, last ${fmtDateTime(d.qr.last_scanned_at)}` : ''}</p>
                  </div>
                ) : <p className="muted">No QR record.</p>}
              </Card>
            </div>

            <Card title="Status history">
              <div className="timeline">
                {d.statusHistory.map((h, i) => (
                  <div className="tl-item" key={i}>
                    <div className="tl-title"><Badge value={h.to_status} /></div>
                    <div className="tl-meta">{fmtDateTime(h.changed_at)}{h.changed_by_name ? ` · ${h.changed_by_name} (${h.changed_by_role})` : ''}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Laboratory reports">
              <Table rows={d.labReports} empty="No laboratory report yet." rowKey={(r) => r.report_code} columns={[
                { label: 'Report', render: (r) => (['LAB', 'ADMIN'].includes(user.role) ? <Link to={`/app/lab/reports/${r.report_code}`}>{r.report_code}</Link> : r.report_code) },
                { label: 'Lab', key: 'lab_name' },
                { label: 'Tested', render: (r) => fmtDate(r.tested_on) },
                { label: 'Moisture %', key: 'moisture_pct' }, { label: 'HMF mg/kg', key: 'hmf_mg_kg' }, { label: 'Sucrose g/100g', key: 'sucrose_g_100g' },
                { label: 'Adulteration', render: (r) => <Badge value={r.adulteration_result} /> },
                { label: 'State', render: (r) => <Badge value={r.report_state} /> },
                { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
              ]} />
            </Card>

            <Card title="Processing & packaging">
              {!d.processing ? <p className="muted">Not processed yet.</p> : (
                <dl className="kv">
                  <dt>Record</dt><dd>{d.processing.processing_code} · {d.processing.processor_name}</dd>
                  <dt>Date / method</dt><dd>{fmtDate(d.processing.processing_date)} · {d.processing.method} {d.processing.method_details ? `(${d.processing.method_details})` : ''}</dd>
                  <dt>Operator</dt><dd>{d.processing.operator_name}{d.processing.operator_staff_id ? ` (${d.processing.operator_staff_id})` : ''}</dd>
                  <dt>Input / output</dt><dd>{kg(d.processing.input_quantity_kg)} → {kg(d.processing.output_quantity_kg)}</dd>
                  <dt>Packaging</dt><dd>{d.processing.units_packed} × {d.processing.unit_size_g} g {d.processing.packaging_type} on {fmtDate(d.processing.packaging_date)}, best before {fmtDate(d.processing.best_before)}</dd>
                  <dt>Units not yet shipped</dt><dd>{d.unitsRemaining}</dd>
                </dl>
              )}
            </Card>

            <Card title="Shipments">
              <Table rows={d.shipments} empty="No shipments yet." rowKey={(r) => r.shipment_code} columns={[
                { label: 'Shipment', key: 'shipment_code' }, { label: 'Distributor', key: 'distributor_name' },
                { label: 'Dispatched', render: (r) => fmtDate(r.dispatch_date) },
                { label: 'Destination', render: (r) => `${r.destination_name} (${r.destination_type}), ${r.destination_city}` },
                { label: 'Units', key: 'units_shipped' }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
                { label: 'Delivered', render: (r) => fmtDate(r.delivered_on) },
              ]} />
            </Card>

            <Card title="Blockchain anchors" actions={user.role === 'ADMIN' && (
              <button className="btn small" disabled={verify.busy} onClick={async () => {
                const r = await verify.run(() => post(`/admin/batches/${b.batch_code}/verify`));
                if (r) { setVerifyResults(r.data); s.reload(); }
              }}>{verify.busy ? 'Verifying...' : 'Verify all records now'}</button>
            )}>
              <ErrorBox error={verify.error} />
              {verifyResults && <Alert kind={verifyResults.every((v) => v.result === 'VERIFIED') ? 'success' : 'warn'}>
                {verifyResults.length === 0 ? 'No confirmed anchors to verify.' : verifyResults.map((v) => `${v.entityType}: ${v.result}`).join(' · ')}
              </Alert>}
              <Table rows={d.anchors} empty="Not anchored (blockchain not configured when these records were created)." rowKey={(r) => r.anchor_id} columns={[
                { label: 'Record', render: (r) => <>{r.entity_type.replaceAll('_', ' ')}<br /><small>{r.entity_code}</small></> },
                { label: 'Status', render: (r) => <Badge value={r.anchor_status} /> },
                { label: 'Tx / block', render: (r) => (r.tx_hash ? <><code>{short(r.tx_hash)}</code><br /><small>block {r.block_number} · {r.network}</small></> : '-') },
                { label: 'Last check', render: (r) => <><Badge value={r.last_result} /><br /><small>{fmtDateTime(r.last_checked_at)}</small></> },
              ]} />
            </Card>
          </>
        );
      }}
    </Async>
  );
}

