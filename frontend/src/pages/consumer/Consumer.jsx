// Consumer view. Verification never needs an account; signed-in consumers additionally keep a history.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { Alert, Async, Badge, Card, DemoBadge, PageHeader, Pager, Table, useApi, fmtDateTime } from '../../components/ui.jsx';
import QrScanner from '../../components/QrScanner.jsx';
import { PublicTop } from '../public/Home.jsx';

export function ConsumerVerify() {
  const nav = useNavigate();
  const recent = useApi('/consumer/verifications?pageSize=5');
  return (
    <>
      <PageHeader title="Product verification" subtitle="Scan the QR code on a HoneyChain jar or type its batch code." />
      <Card title="Verify a product">
        <QrScanner onCode={(code) => nav(`/consumer/verify/${code}`)} />
      </Card>
      <Card title="Your recent checks" actions={<Link to="/consumer/history">Full history</Link>}>
        <Async state={recent} empty="No products verified yet.">
          {(rows) => <HistoryTable rows={rows} />}
        </Async>
      </Card>
      <Alert kind="info">You do not need an account to verify a product. Your account only keeps this history. HoneyChain never shows producers' phone numbers, emails or internal business notes.</Alert>
    </>
  );
}

export function ConsumerScan() {
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="QR scanner" subtitle="Allow camera access, then hold the QR code inside the frame." />
      <Card><QrScanner onCode={(code) => nav(`/consumer/verify/${code}`)} /></Card>
    </>
  );
}

function HistoryTable({ rows }) {
  return (
    <Table rows={rows} rowKey={(r) => r.verification_id} columns={[
      { label: 'When', render: (r) => fmtDateTime(r.verified_at) },
      { label: 'Batch', render: (r) => <><Link to={`/consumer/verify/${r.batch_code}`}>{r.batch_code}</Link> <DemoBadge show={r.is_demo} /></> },
      { label: 'Honey', key: 'honey_type' },
      { label: 'Result at that time', render: (r) => <Badge value={r.overall_result} /> },
    ]} />
  );
}

export function ConsumerHistory() {
  const [page, setPage] = useState(1);
  const s = useApi(`/consumer/verifications${qs({ page })}`);
  return (
    <>
      <PageHeader title="Verification history" subtitle="Products you verified while signed in. Open one to re-check it against the blockchain now." />
      <Card>
        <Async state={s} empty="No verifications yet.">
          {(rows, meta) => (<><HistoryTable rows={rows} /><Pager meta={meta} page={page} setPage={setPage} /></>)}
        </Async>
      </Card>
    </>
  );
}

/** Public, no-login entry point: /verify */
export function PublicVerify() {
  const nav = useNavigate();
  return (
    <>
      <PublicTop />
      <div className="public-wrap">
        <section className="hero">
          <h1>Verify your honey</h1>
          <p>Scan the QR code on the jar or type its batch code. No account is needed.</p>
        </section>
        <section className="card"><QrScanner onCode={(code) => nav(`/verify/${code}`)} /></section>
      </div>
    </>
  );
}
