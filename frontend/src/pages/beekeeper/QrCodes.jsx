// Every batch gets a QR code when it is created; this page lists them for printing labels.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../../api/client.js';
import { Async, Badge, Card, DemoBadge, PageHeader, Pager, useApi, useBase, kg } from '../../components/ui.jsx';

export default function QrCodes() {
  const base = useBase();
  const [page, setPage] = useState(1);
  const s = useApi(`/batches${qs({ page, pageSize: 12 })}`);
  return (
    <>
      <PageHeader title="QR codes" subtitle="One QR code per batch. It opens the public verification page - consumers need no account." />
      <Async state={s} empty="No batches yet - create batches from a harvest to get QR codes.">
        {(rows, meta) => (
          <>
            <div className="grid grid-3">
              {rows.map((b) => (
                <Card key={b.batch_code} className="qr-card">
                  <div className="card-head"><h3><Link to={base(`batches/${b.batch_code}`)}>{b.batch_code}</Link> <DemoBadge show={b.is_demo} /></h3><Badge value={b.status} /></div>
                  <img src={`/api/v1/qr/${b.batch_code}.png?size=256`} alt={`QR code for ${b.batch_code}`} loading="lazy" />
                  <p className="muted" style={{ margin: '6px 0' }}>{b.honey_type} · {kg(b.quantity_kg)}</p>
                  {['CREATED', 'PENDING_PROCESSOR'].includes(b.status) && <p className="hint">Not yet processed or tested - the public page will say so.</p>}
                  <div className="btn-row">
                    <a className="btn small" href={`/api/v1/qr/${b.batch_code}.png?size=1024&download=1`}>PNG</a>
                    <a className="btn secondary small" href={`/api/v1/qr/${b.batch_code}.svg?download=1`}>SVG</a>
                    <a className="btn secondary small" href={`/verify/${b.batch_code}`} target="_blank" rel="noreferrer">Open</a>
                  </div>
                </Card>
              ))}
            </div>
            <Pager meta={meta} page={page} setPage={setPage} />
          </>
        )}
      </Async>
    </>
  );
}
