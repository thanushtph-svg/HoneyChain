import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Async, Badge, useApi, fmtDate } from '../../components/ui.jsx';
import { Logo } from '../../layouts/DashboardLayout.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

export function PublicTop() {
  const { user } = useAuth();
  return (
    <header className="public-top">
      <Link to="/" className="brand" style={{ margin: 0, color: '#fff' }}><Logo /> HoneyChain</Link>
      {user ? <Link to="/app">Dashboard</Link> : <Link to="/login">Staff &amp; beekeeper login</Link>}
    </header>
  );
}

export default function Home() {
  const [code, setCode] = useState('');
  const nav = useNavigate();
  const demos = useApi('/public/demo-batches');
  return (
    <>
      <PublicTop />
      <div className="public-wrap">
        <section className="hero">
          <h1>Trace your honey from hive to shelf</h1>
          <p>Scan the QR code on a HoneyChain jar, or type its batch code, to see where the honey came from, its laboratory results, processing and distribution journey, and whether the records have changed since they were sealed on the blockchain.</p>
          <form className="btn-row" style={{ marginTop: 14 }} onSubmit={(e) => { e.preventDefault(); if (code.trim()) nav(`/verify/${code.trim().toUpperCase()}`); }}>
            <input aria-label="Batch code" placeholder="e.g. HC-2026-000001" value={code} onChange={(e) => setCode(e.target.value)}
              style={{ padding: '9px 12px', borderRadius: 9, border: 'none', minWidth: 240, font: 'inherit' }} />
            <button className="btn">Verify batch</button>
          </form>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Demo batches</h2>
            <span className="badge demo">DEMO DATA</span>
          </div>
          <p className="muted">Fictional records created by the seed script to demonstrate the system.</p>
          <Async state={demos} empty="No demo batches. Run the seed script (npm run db:seed) to create some.">
            {(rows) => (
              <div className="grid grid-3">
                {rows.map((b) => (
                  <Link key={b.batch_code} to={`/verify/${b.batch_code}`} className="stat" style={{ color: 'inherit', textDecoration: 'none' }}>
                    <div className="label">{b.batch_code}</div>
                    <div style={{ fontWeight: 700, margin: '6px 0' }}>{b.honey_type} honey</div>
                    <div className="sub">{b.origin_district}, {b.origin_state} · harvested {fmtDate(b.harvest_date)}</div>
                    <div style={{ marginTop: 8 }}><Badge value={b.status} /> {b.lab_decision && <Badge value={b.lab_decision} />}</div>
                  </Link>
                ))}
              </div>
            )}
          </Async>
        </section>
        <section className="notice">
          HoneyChain records are entered by registered beekeepers, laboratories, processors and distributors. Blockchain verification shows whether a record changed after it was anchored. It does not prove the honey is genuine. Any AI output is decision support, not certification.
        </section>
      </div>
    </>
  );
}
