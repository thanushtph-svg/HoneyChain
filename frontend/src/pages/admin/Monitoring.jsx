// Admin monitoring pages (read-only) for processing, laboratory and distribution, plus correction review.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api/client.js';
import { Card, PageHeader, ReasonAction, Tabs, useBase } from '../../components/ui.jsx';
import { ProcessingRecords } from '../processor/ProcessingHistory.jsx';
import { TransferTable } from '../shared/Transfers.jsx';
import { RequestTable } from '../lab/Requests.jsx';
import { CorrectionTable, ReportTable } from '../lab/LabReports.jsx';
import { ShipmentTable } from '../distributor/Shipments.jsx';
import { RecordTable } from './Records.jsx';

export function AdminHives() {
  return (<><PageHeader title="Hives" subtitle="Every registered hive (read-only)" /><Card><RecordTable tab="hives" /></Card>
    <Card title="Beekeepers"><RecordTable tab="beekeepers" /></Card></>);
}

export function AdminHarvests() {
  return (<><PageHeader title="Harvests" subtitle="Every recorded harvest and how much of it has been batched (read-only)" /><Card><RecordTable tab="harvests" /></Card></>);
}

export function ProcessingMonitoring() {
  return (
    <>
      <PageHeader title="Processing monitoring" subtitle="Processing records and beekeeper-to-processor custody transfers across all processors" />
      <Card title="Processing records"><ProcessingRecords showProcessor /></Card>
      <Card title="Transfers to processors"><TransferTable type="TO_PROCESSOR" empty="No transfers." /></Card>
    </>
  );
}

export function LaboratoryMonitoring() {
  const base = useBase();
  const [tab, setTab] = useState('corrections');
  const [v, setV] = useState(0);
  return (
    <>
      <PageHeader title="Laboratory monitoring" subtitle="Testing requests and results of every laboratory. Results can only change through corrections you approve here."
        actions={<Link className="btn secondary" to={base('ai-models')}>AI models</Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[['corrections', 'Corrections to review'], ['reports', 'Lab reports'], ['requests', 'Testing requests'], ['all-corrections', 'Correction history']]} />
      {tab === 'corrections' && (
        <Card title="Pending correction requests">
          <p className="muted">Approving keeps the original report as SUPERSEDED (still verifiable on the blockchain), creates a new corrected report and anchors it. You cannot approve your own request.</p>
          <CorrectionTable key={v} status="PENDING" actions={(r) => (
            <div className="btn-row">
              <ReasonAction kind="" label="Approve" placeholder="Review note (what you checked)" confirm={`Approve ${r.correction_code}? A new corrected report will replace ${r.report_code} on the public page.`}
                onSubmit={(note) => post(`/lab-corrections/${r.correction_code}/approve`, { note })} onDone={() => setV((x) => x + 1)} />
              <ReasonAction label="Reject" placeholder="Why is this correction rejected?" confirm={`Reject ${r.correction_code}?`}
                onSubmit={(note) => post(`/lab-corrections/${r.correction_code}/reject`, { note })} onDone={() => setV((x) => x + 1)} />
            </div>
          )} />
        </Card>
      )}
      {tab === 'reports' && <Card><ReportTable showLab linkBase="laboratory/reports" empty="No lab reports." /></Card>}
      {tab === 'requests' && <Card><RequestTable viewer="ADMIN" empty="No testing requests." /></Card>}
      {tab === 'all-corrections' && <Card><CorrectionTable /></Card>}
    </>
  );
}

export function DistributionMonitoring() {
  return (
    <>
      <PageHeader title="Distribution monitoring" subtitle="Processor-to-distributor transfers and all shipments" />
      <Card title="Transfers to distributors"><TransferTable type="TO_DISTRIBUTOR" empty="No transfers." /></Card>
      <Card title="Shipments"><ShipmentTable showDistributor empty="No shipments." /></Card>
    </>
  );
}
