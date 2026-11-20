// System-wide read-only views of every record type.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, fmtDate, kg } from '../../components/ui.jsx';

const TABS = {
  beekeepers: { label: 'Beekeepers', path: '/admin/beekeepers', cols: [
    { label: 'Code', render: (r) => <>{r.beekeeper_code} <DemoBadge show={r.is_demo} /></> },
    { label: 'Name', render: (r) => <>{r.full_name}<br /><small>{r.email}</small></> },
    { label: 'Public name', render: (r) => <>{r.public_display_name} {r.show_name_publicly ? <Badge value="PUBLIC" kind="ok" /> : <Badge value="HIDDEN" />}</> },
    { label: 'Cooperative', key: 'cooperative_name' }, { label: 'District', key: 'district' }, { label: 'Hives', key: 'hive_count' },
  ] },
  hives: { label: 'Hives', path: '/hives', cols: [
    { label: 'Hive', render: (r) => <>{r.hive_code} <DemoBadge show={r.is_demo} /></> }, { label: 'Owner', render: (r) => `${r.public_display_name} (${r.beekeeper_code})` },
    { label: 'Type', key: 'hive_type' }, { label: 'Location', render: (r) => `${r.apiary_location}, ${r.district}` },
    { label: 'Harvests', render: (r) => `${r.harvest_count} (${kg(r.total_harvest_kg)})` }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
  ] },
  harvests: { label: 'Harvests', path: '/harvests', cols: [
    { label: 'Harvest', render: (r) => <><Link to={`/app/harvests/${r.harvest_code}`}>{r.harvest_code}</Link> <DemoBadge show={r.is_demo} /></> },
    { label: 'Hive', key: 'hive_code' }, { label: 'Beekeeper', key: 'beekeeper_code' }, { label: 'Date', render: (r) => fmtDate(r.harvest_date) },
    { label: 'Qty', render: (r) => kg(r.quantity_kg) }, { label: 'Batched', render: (r) => `${kg(r.batched_kg)} / ${r.batch_count}` }, { label: 'Flora', key: 'floral_source' },
  ] },
  lab: { label: 'Lab reports', path: '/lab/reports', cols: [
    { label: 'Report', render: (r) => <><Link to={`/app/lab/reports/${r.report_code}`}>{r.report_code}</Link> <DemoBadge show={r.is_demo} /></> },
    { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> }, { label: 'Lab', key: 'lab_name' },
    { label: 'Tested', render: (r) => fmtDate(r.tested_on) }, { label: 'Moisture/HMF/Sucrose', render: (r) => `${r.moisture_pct} / ${r.hmf_mg_kg} / ${r.sucrose_g_100g}` },
    { label: 'Adulteration', render: (r) => <Badge value={r.adulteration_result} /> }, { label: 'State', render: (r) => <Badge value={r.report_state} /> }, { label: 'Decision', render: (r) => <Badge value={r.decision} /> },
  ] },
  processing: { label: 'Processing', path: '/processing', cols: [
    { label: 'Record', render: (r) => <>{r.processing_code} <DemoBadge show={r.is_demo} /></> }, { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
    { label: 'Processor', key: 'processor_name' }, { label: 'Date', render: (r) => fmtDate(r.processing_date) }, { label: 'Method', key: 'method' },
    { label: 'In → out', render: (r) => `${kg(r.input_quantity_kg)} → ${kg(r.output_quantity_kg)}` }, { label: 'Units', key: 'units_packed' },
  ] },
  shipments: { label: 'Distribution', path: '/shipments', cols: [
    { label: 'Shipment', render: (r) => <>{r.shipment_code} <DemoBadge show={r.is_demo} /></> }, { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
    { label: 'Distributor', key: 'distributor_name' }, { label: 'To', render: (r) => `${r.destination_name}, ${r.destination_city}` },
    { label: 'Units', key: 'units_shipped' }, { label: 'Dispatched', render: (r) => fmtDate(r.dispatch_date) }, { label: 'Status', render: (r) => <Badge value={r.status} /> },
  ] },
};

function TabTable({ tab }) {
  const [page, setPage] = useState(1);
  const s = useApi(`${TABS[tab].path}?page=${page}`, [tab]);
  return (
    <Async state={s} empty="No records.">
      {(rows, meta) => (<><Table rows={rows} columns={TABS[tab].cols} /><Pager meta={meta} page={page} setPage={setPage} /></>)}
    </Async>
  );
}

export default function Records() {
  const [tab, setTab] = useState('beekeepers');
  return (
    <>
      <PageHeader title="System records" subtitle="Read-only view of every supply-chain record (PostgreSQL)" />
      <div className="tabs">
        {Object.entries(TABS).map(([k, t]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{t.label}</button>)}
      </div>
      <Card><TabTable key={tab} tab={tab} /></Card>
    </>
  );
}
