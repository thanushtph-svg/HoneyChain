// Full traceability record of one batch. Rendered inside each role's own view; the actions shown
// come from the server ("can" flags) and every action is checked again by the API.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Async, Badge, Card, ConfirmButton, DemoBadge, ErrorBox, Field, PageHeader, ReasonAction, Table, useAction, useApi, useBase,
  fmtDate, fmtDateTime, kg, short } from '../../components/ui.jsx';

/** Choose an organization from the role-limited directory and send the batch / request. */
export function SendPanel({ title, help, orgType, submitLabel, onSend, extra, onDone }) {
  const orgs = useApi(`/directory/organizations?type=${orgType}`);
  const [orgId, setOrgId] = useState('');
  const [notes, setNotes] = useState('');
  const a = useAction();
  return (
    <Card title={title} className="action-card">
      {help && <p className="muted">{help}</p>}
      <ErrorBox error={a.error} />
      {a.message && <Alert kind="success">{a.message}</Alert>}
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        const org = (orgs.data ?? []).find((o) => String(o.org_id) === orgId);
        if (!window.confirm(`${submitLabel} to ${org?.name}?`)) return;
        const r = await a.run(() => onSend(Number(orgId), notes), `${submitLabel}: sent to ${org?.name}`);
        if (r) { setNotes(''); onDone?.(r); }
      }}>
        <Field label="Organization">
          <select required value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">Choose...</option>
            {(orgs.data ?? []).map((o) => <option key={o.org_id} value={o.org_id}>{o.name} ({o.city}){o.accreditation_no ? ` · ${o.accreditation_no}` : ''}</option>)}
          </select>
        </Field>
        {extra}
        <Field label="Notes (optional)" full><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="full"><button className="btn" disabled={a.busy || !orgId}>{a.busy ? 'Sending...' : submitLabel}</button></div>
      </form>
      {orgs.data?.length === 0 && <Alert kind="warn">No active {orgType.toLowerCase()} organizations exist yet. An administrator must create one.</Alert>}
    </Card>
  );
}

function Actions({ d, reload }) {
  const { user } = useAuth();
  const base = useBase();
  const b = d.batch;
  const pending = d.transfers.find((t) => t.status === 'PENDING');
  const draft = d.labReports.find((r) => r.report_state === 'DRAFT');
  const out = [];

  if (pending && user.organization && pending.to_org_id === user.organization.id && ['PROCESSOR', 'DISTRIBUTOR'].includes(user.role)) {
    out.push(
      <Card key="respond" title={`Incoming transfer ${pending.transfer_code}`} className="action-card">
        <p>Sent {fmtDateTime(pending.initiated_at)} · {kg(pending.quantity_kg)}{pending.units ? ` · ${pending.units} units` : ''}{pending.notes ? ` · "${pending.notes}"` : ''}</p>
        <div className="btn-row">
          <ConfirmButton confirm={`Accept custody of ${b.batch_code}?`} onClick={() => post(`/transfers/${pending.transfer_code}/accept`, {})} onDone={reload}>Accept batch</ConfirmButton>
          <ReasonAction label="Reject batch" confirm={`Reject ${b.batch_code}? It returns to the sender.`} onSubmit={(reason) => post(`/transfers/${pending.transfer_code}/reject`, { reason })} onDone={reload} />
        </div>
      </Card>);
  }
  if (pending && ((user.role === 'BEEKEEPER' && pending.transfer_type === 'TO_PROCESSOR') || (user.role === 'PROCESSOR' && pending.from_org_id === user.organization?.id))) {
    out.push(
      <Alert key="waiting" kind="info">Waiting for <strong>{pending.to_org_name}</strong> to accept transfer {pending.transfer_code}.{' '}
        <ReasonAction label="Cancel transfer" confirm="Cancel this transfer?" onSubmit={(reason) => post(`/transfers/${pending.transfer_code}/cancel`, { reason })} onDone={reload} />
      </Alert>);
  }
  if (d.can.transferToProcessor) {
    out.push(<SendPanel key="tp" title="Transfer to a processor" orgType="PROCESSOR" submitLabel="Send batch"
      help="Custody moves only when the processor accepts. If they reject, the batch comes back to you with their reason."
      onSend={(toOrgId, notes) => post(`/batches/${b.batch_code}/transfers`, { toOrgId, notes })} onDone={reload} />);
  }
  if (d.can.recordProcessing) out.push(<Alert key="rp" kind="info">This batch is in your custody. <Link to={base(`processing?batch=${b.batch_code}`)}>Record processing</Link></Alert>);
  if (d.can.requestTesting) {
    out.push(<SendPanel key="rt" title={b.status === 'LAB_INCONCLUSIVE' ? 'Request a re-test' : 'Request laboratory testing'} orgType="LABORATORY" submitLabel="Send testing request"
      help="The laboratory accepts or rejects the request; results are recorded by the laboratory only."
      onSend={(labOrgId, notes) => post('/lab-requests', { batchCode: b.batch_code, labOrgId, notes })} onDone={reload} />);
  }
  if (d.can.transferToDistributor) {
    out.push(<SendPanel key="td" title="Transfer to a distributor" orgType="DISTRIBUTOR" submitLabel="Send batch"
      help={`All ${d.processing?.units_packed ?? ''} packed units (${kg(d.processing?.output_quantity_kg)}) are handed over. Custody moves when the distributor accepts.`}
      onSend={(toOrgId, notes) => post(`/batches/${b.batch_code}/transfers`, { toOrgId, notes })} onDone={reload} />);
  }
  if (d.can.enterResults) {
    out.push(<Alert key="er" kind="info">Testing request accepted. <Link to={draft ? base(`reports/${draft.report_code}`) : base(`reports/new?batch=${b.batch_code}`)}>{draft ? 'Continue the draft report' : 'Enter laboratory results'}</Link></Alert>);
  }
  if (d.can.ship) out.push(<Alert key="sh" kind="info">{d.unitsRemaining} packed units still to ship. <Link to={base(`distribution?batch=${b.batch_code}`)}>Record a shipment</Link></Alert>);
  return out;
}

function Timeline({ d }) {
  return (
    <div className="timeline">
      {d.statusHistory.map((h, i) => (
        <div className="tl-item" key={i}>
          <div className="tl-title"><Badge value={h.to_status} /></div>
          <div className="tl-meta">{fmtDateTime(h.changed_at)}{h.changed_by_role ? ` · by ${h.changed_by_name ?? ''} (${h.changed_by_role.replace('_', ' ').toLowerCase()})` : ''}</div>
        </div>
      ))}
    </div>
  );
}

export default function BatchDetail() {
  const { batchCode } = useParams();
  const { user } = useAuth();
  const base = useBase();
  const s = useApi(`/batches/${batchCode}`, [batchCode]);
  const verify = useAction();
  const [verifyResults, setVerifyResults] = useState(null);
  const reportLink = (code) => (['LAB_TESTER', 'ADMIN'].includes(user.role) ? <Link to={base(`${user.role === 'ADMIN' ? 'laboratory/reports' : 'reports'}/${code}`)}>{code}</Link> : code);

  return (
    <Async state={s}>
      {(d) => {
        const b = d.batch;
        return (
          <>
            <PageHeader
              title={<>{b.batch_code} <DemoBadge show={b.is_demo} /></>}
              subtitle={`${b.honey_type} · ${kg(b.batch_quantity_kg)} · from harvest ${b.harvest_code} · custody: ${b.custodian_role.toLowerCase()}`}
              actions={<><Badge value={b.status} /><a className="btn secondary small" href={`/verify/${b.batch_code}`} target="_blank" rel="noreferrer">Public page</a></>}
            />
            <Actions d={d} reload={s.reload} />

            <div className="grid grid-2">
              <Card title="Origin">
                <dl className="kv">
                  <dt>Beekeeper</dt><dd>{b.public_display_name} ({b.beekeeper_code}){b.beekeeper_email ? <><br /><small>{b.beekeeper_email}</small></> : null}</dd>
                  <dt>Cooperative</dt><dd>{b.cooperative_name ?? '-'}</dd>
                  <dt>Hive</dt><dd>{b.hive_code} · {b.hive_type} · {b.bee_species}</dd>
                  <dt>Location</dt><dd>{b.hive_district}, {b.hive_state}</dd>
                  <dt>Harvest</dt><dd>{b.harvest_code} · {fmtDate(b.harvest_date)} · {kg(b.harvest_quantity_kg)} · {b.floral_source}</dd>
                  <dt>Processor</dt><dd>{b.processor_org_name ?? '-'}</dd>
                  <dt>Distributor</dt><dd>{b.distributor_org_name ?? '-'}</dd>
                </dl>
              </Card>
              <Card title="Status history">
                <Timeline d={d} />
              </Card>
            </div>

            <Card title="Custody transfers">
              <Table rows={d.transfers} empty="No transfers yet - the batch is with the beekeeper." rowKey={(r) => r.transfer_code} columns={[
                { label: 'Transfer', render: (r) => <>{r.transfer_code}<br /><small>{r.transfer_type.replace('_', ' ').toLowerCase()}</small></> },
                { label: 'From → to', render: (r) => `${r.from_org_name ?? 'Beekeeper'} → ${r.to_org_name}` },
                { label: 'Quantity', render: (r) => <>{kg(r.quantity_kg)}{r.units ? <><br /><small>{r.units} units</small></> : null}</> },
                { label: 'Sent', render: (r) => <>{fmtDateTime(r.initiated_at)}{r.initiated_by_name ? <><br /><small>{r.initiated_by_name}</small></> : null}</> },
                { label: 'Status', render: (r) => <Badge value={r.status} /> },
                { label: 'Response', render: (r) => r.responded_at ? <>{fmtDateTime(r.responded_at)}{r.responded_by_name ? ` · ${r.responded_by_name}` : ''}{r.response_reason ? <><br /><small>“{r.response_reason}”</small></> : null}</> : '-' },
              ]} />
            </Card>

            <Card title="Processing & packaging">
              {!d.processing ? <p className="muted">Not processed yet.</p> : (
                <dl className="kv">
                  <dt>Record</dt><dd>{d.processing.processing_code} · {d.processing.processor_name}</dd>
                  <dt>Date / method</dt><dd>{fmtDate(d.processing.processing_date)} · {d.processing.method} {d.processing.method_details ? `(${d.processing.method_details})` : ''}</dd>
                  {d.processing.operator_name && <><dt>Operator</dt><dd>{d.processing.operator_name}{d.processing.operator_staff_id ? ` (${d.processing.operator_staff_id})` : ''}</dd></>}
                  <dt>Input / output</dt><dd>{kg(d.processing.input_quantity_kg)} → {kg(d.processing.output_quantity_kg)} (loss {kg(Number(d.processing.input_quantity_kg) - Number(d.processing.output_quantity_kg))})</dd>
                  <dt>Packaging</dt><dd>{d.processing.units_packed} × {d.processing.unit_size_g} g {d.processing.packaging_type} on {fmtDate(d.processing.packaging_date)}, best before {fmtDate(d.processing.best_before)}</dd>
                  <dt>Units not yet shipped</dt><dd>{d.unitsRemaining}</dd>
                </dl>
              )}
            </Card>

            <Card title="Laboratory testing requests">
              <Table rows={d.labRequests} empty="No testing requested yet." rowKey={(r) => r.request_code} columns={[
                { label: 'Request', key: 'request_code' }, { label: 'Laboratory', key: 'lab_name' }, { label: 'Requested by', key: 'requester_name' },
                { label: 'Requested', render: (r) => fmtDateTime(r.requested_at) }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
                { label: 'Response', render: (r) => r.responded_at ? <>{fmtDateTime(r.responded_at)}{r.response_reason ? <><br /><small>“{r.response_reason}”</small></> : null}</> : '-' },
              ]} />
            </Card>

            <Card title="Laboratory results">
              <Table rows={d.labReports} empty="No laboratory report yet." rowKey={(r) => r.report_code} columns={[
                { label: 'Report', render: (r) => <>{reportLink(r.report_code)}{r.supersedes_report_code ? <><br /><small>corrects {r.supersedes_report_code}</small></> : null}</> },
                { label: 'Lab', key: 'lab_name' },
                { label: 'Tested', render: (r) => fmtDate(r.tested_on) },
                { label: 'Moisture %', key: 'moisture_pct' }, { label: 'HMF mg/kg', key: 'hmf_mg_kg' }, { label: 'Sucrose g/100g', key: 'sucrose_g_100g' },
                { label: 'Adulteration', render: (r) => <Badge value={r.adulteration_result} /> },
                { label: 'State', render: (r) => <Badge value={r.report_state} /> },
                { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
              ]} />
              {d.labCorrections.length > 0 && (
                <>
                  <h3 style={{ marginTop: 14 }}>Audited corrections</h3>
                  <Table rows={d.labCorrections} rowKey={(r) => r.correction_code} columns={[
                    { label: 'Correction', key: 'correction_code' }, { label: 'Report', key: 'report_code' }, { label: 'Reason', key: 'reason' },
                    { label: 'Status', render: (r) => <Badge value={r.status} /> }, { label: 'New report', render: (r) => r.new_report_code ?? '-' },
                  ]} />
                </>
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

            <div className="grid grid-2">
              <Card title="Blockchain anchors" actions={d.can.verifyChain && (
                <button className="btn small" disabled={verify.busy} onClick={async () => {
                  const r = await verify.run(() => post(`/admin/batches/${b.batch_code}/verify`));
                  if (r) { setVerifyResults(r.data); s.reload(); }
                }}>{verify.busy ? 'Verifying...' : 'Verify all records now'}</button>
              )}>
                <ErrorBox error={verify.error} />
                {verifyResults && <Alert kind={verifyResults.length && verifyResults.every((v) => v.result === 'VERIFIED') ? 'success' : 'warn'}>
                  {verifyResults.length === 0 ? 'No confirmed anchors to verify.' : verifyResults.map((v) => `${v.entityType}: ${v.result}`).join(' · ')}
                </Alert>}
                <Table rows={d.anchors} empty="Not anchored (blockchain not configured when these records were created)." rowKey={(r) => r.anchor_id} columns={[
                  { label: 'Record', render: (r) => <>{r.entity_type.replaceAll('_', ' ')}<br /><small>{r.entity_code}</small></> },
                  { label: 'Status', render: (r) => <Badge value={r.anchor_status} /> },
                  { label: 'Tx / block', render: (r) => (r.tx_hash ? <><code>{short(r.tx_hash)}</code><br /><small>block {r.block_number} · {r.network}</small></> : '-') },
                  { label: 'Last check', render: (r) => <><Badge value={r.last_result} /><br /><small>{fmtDateTime(r.last_checked_at)}</small></> },
                ]} />
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
          </>
        );
      }}
    </Async>
  );
}
