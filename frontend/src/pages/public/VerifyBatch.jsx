// Public consumer page (no login). Layout adapted from the original Flask prototype's verify page,
// now filled entirely from the API - no hardcoded values, no IoT data.
import { useParams, Link } from 'react-router-dom';
import { Badge, DemoBadge, Loading, useApi, fmtDate, fmtDateTime, short } from '../../components/ui.jsx';
import { PublicTop } from './Home.jsx';

const RECORD_LABEL = { BATCH_ORIGIN: 'Origin & harvest record', LAB_REPORT: 'Laboratory report', PROCESSING_RECORD: 'Processing record', SHIPMENT: 'Delivery record' };
const RESULT_TEXT = {
  VERIFIED: 'Unchanged since anchoring',
  MISMATCH: 'CHANGED after anchoring',
  NOT_FOUND_ON_CHAIN: 'Not found on blockchain',
  CHAIN_UNAVAILABLE: 'Blockchain not reachable right now',
};

function Row({ k, v }) {
  return (<><dt>{k}</dt><dd>{v ?? '-'}</dd></>);
}

export default function VerifyBatch() {
  const { batchCode } = useParams();
  const s = useApi(`/public/batches/${encodeURIComponent(batchCode)}`, [batchCode]);

  if (s.loading) return (<><PublicTop /><div className="public-wrap"><Loading text="Looking up batch..." /></div></>);
  if (s.error) {
    return (
      <>
        <PublicTop />
        <div className="public-wrap">
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <h1>{s.error.status === 404 ? 'Batch not found' : 'Could not load this batch'}</h1>
            <p>{s.error.status === 404 ? <>No HoneyChain record exists for <b>{batchCode}</b>. Check the code on the label.</> : s.error.message}</p>
            <Link to="/">Back to HoneyChain</Link>
          </div>
        </div>
      </>
    );
  }
  const b = s.data;
  const mismatch = b.integrity.some((i) => i.result === 'MISMATCH');
  const verified = b.integrity.filter((i) => i.result === 'VERIFIED').length;

  return (
    <>
      <PublicTop />
      <div className="public-wrap">
        {b.isDemo && <div className="alert info"><strong>Demo data.</strong> This batch was created by the HoneyChain seed script for demonstration. The people, places and lab values are fictional.</div>}
        {mismatch && <div className="alert error"><strong>Integrity warning:</strong> at least one record of this batch no longer matches the version sealed on the blockchain.</div>}

        <section className="card">
          <div className="product-head">
            <div>
              <div className="muted" style={{ fontSize: '0.78rem', letterSpacing: '0.08em' }}>BATCH ID</div>
              <div className="big-code">{b.batchCode}</div>
              <h2 style={{ marginTop: 8 }}>{b.honeyType} honey</h2>
              <p className="muted" style={{ margin: 0 }}>Produced by <strong style={{ color: 'var(--ink)' }}>{b.origin.producerName}</strong>{b.origin.cooperative ? `, ${b.origin.cooperative}` : ''}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <Badge value={b.status} /> <DemoBadge show={b.isDemo} />
              <div style={{ marginTop: 8, fontSize: '0.85rem' }}>
                {b.integrity.length === 0 ? <span className="muted">Not anchored on blockchain</span>
                  : mismatch ? <Badge value="MISMATCH" /> : <span>{verified}/{b.integrity.length} records verified</span>}
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-2">
          <section className="card">
            <h3>Origin</h3>
            <dl className="kv">
              <Row k="Region" v={`${b.origin.district}, ${b.origin.state}`} />
              <Row k="Hive" v={b.origin.hiveCode} />
              <Row k="Bee species" v={b.origin.beeSpecies} />
            </dl>
          </section>
          <section className="card">
            <h3>Harvest</h3>
            <dl className="kv">
              <Row k="Harvest ID" v={b.harvest.harvestCode} />
              <Row k="Harvest date" v={fmtDate(b.harvest.date)} />
              <Row k="Floral source" v={b.harvest.floralSource} />
            </dl>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h3>Laboratory results</h3>
            {b.laboratory && <Badge value={b.laboratory.decision} />}
          </div>
          {!b.laboratory ? <p className="muted">Not tested yet.</p> : (
            <dl className="kv">
              <Row k="Laboratory" v={`${b.laboratory.labName}${b.laboratory.accreditationNo ? ` (${b.laboratory.accreditationNo})` : ''}`} />
              <Row k="Report / tested on" v={`${b.laboratory.reportCode} · ${fmtDate(b.laboratory.testedOn)}`} />
              <Row k="Moisture" v={`${b.laboratory.moisturePct} %`} />
              <Row k="HMF" v={`${b.laboratory.hmfMgKg} mg/kg`} />
              <Row k="Sucrose" v={`${b.laboratory.sucroseG100g} g/100 g`} />
              {b.laboratory.fructoseG100g && <Row k="Fructose / glucose" v={`${b.laboratory.fructoseG100g} / ${b.laboratory.glucoseG100g} g/100 g`} />}
              <Row k="Pollen" v={b.laboratory.pollenIdentification} />
              <Row k="Adulteration test" v={<><Badge value={b.laboratory.adulterationResult} /> {b.laboratory.adulterationMethod && <small>({b.laboratory.adulterationMethod})</small>}</>} />
            </dl>
          )}
        </section>

        <section className="card">
          <h3>Processing &amp; packaging</h3>
          {!b.processing ? <p className="muted">Not processed yet.</p> : (
            <dl className="kv">
              <Row k="Processor" v={`${b.processing.processorName}, ${b.processing.processorCity}`} />
              <Row k="Processed on" v={fmtDate(b.processing.date)} />
              <Row k="Method" v={b.processing.method?.replaceAll('_', ' ').toLowerCase()} />
              <Row k="Packaging" v={`${b.processing.packagingType?.replaceAll('_', ' ').toLowerCase()}, ${b.processing.unitSizeG} g, packed ${fmtDate(b.processing.packagingDate)}`} />
              <Row k="Best before" v={fmtDate(b.processing.bestBefore)} />
            </dl>
          )}
        </section>

        <section className="card">
          <h3>Journey</h3>
          <div className="timeline">
            <div className="tl-item"><div className="tl-title">Harvested</div><div className="tl-meta">{fmtDate(b.harvest.date)} · {b.origin.district}, {b.origin.state}</div></div>
            <div className={`tl-item ${b.laboratory ? '' : 'pending'}`}><div className="tl-title">Laboratory tested</div><div className="tl-meta">{b.laboratory ? `${fmtDate(b.laboratory.testedOn)} · ${b.laboratory.labName}` : 'pending'}</div></div>
            <div className={`tl-item ${b.processing ? '' : 'pending'}`}><div className="tl-title">Processed &amp; packed</div><div className="tl-meta">{b.processing ? `${fmtDate(b.processing.date)} · ${b.processing.processorCity}` : 'pending'}</div></div>
            {b.journey.map((j) => (
              <div className={`tl-item ${j.status === 'DELIVERED' ? '' : 'pending'}`} key={j.shipment_code}>
                <div className="tl-title">Shipped to {j.destination_type.toLowerCase()} in {j.destination_city} <Badge value={j.status} /></div>
                <div className="tl-meta">Dispatched {fmtDate(j.dispatch_date)} by {j.distributor_name}{j.delivered_on ? ` · delivered ${fmtDate(j.delivered_on)}` : ''}</div>
              </div>
            ))}
            {b.journey.length === 0 && <div className="tl-item pending"><div className="tl-title">Distribution</div><div className="tl-meta">not dispatched yet</div></div>}
          </div>
        </section>

        <section className="card">
          <h3>Blockchain integrity</h3>
          {b.integrity.length === 0 && <p className="muted">These records have not been anchored on a blockchain yet.</p>}
          {b.integrity.map((i) => (
            <div className="integrity-row" key={i.record + i.recordCode}>
              <div>
                <strong>{RECORD_LABEL[i.record]}</strong> <small>{i.recordCode}</small>
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {i.txHash ? <>tx <code>{short(i.txHash)}</code> · block {i.blockNumber} · {i.network}</> : `anchoring ${i.anchorStatus.toLowerCase()}`}
                  {i.explorerUrl && <> · <a href={i.explorerUrl} target="_blank" rel="noreferrer">view on Etherscan</a></>}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {i.result ? <Badge value={i.result} title={RESULT_TEXT[i.result]} /> : <Badge value={i.anchorStatus} />}
                <div className="muted" style={{ fontSize: '0.78rem' }}>{i.result ? `${RESULT_TEXT[i.result]} · ${fmtDateTime(i.checkedAt)}` : 'not verified yet'}</div>
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          <h3>Automated analysis</h3>
          {b.ai?.unavailable && <p className="muted">Analysis results are temporarily unavailable.</p>}
          {!b.ai?.unavailable && !b.ai?.quality && !b.ai?.adulteration && <p className="muted">No automated analysis has been run for this batch.</p>}
          {b.ai?.quality && (
            <div style={{ marginBottom: 12 }}>
              <strong>Quality screening</strong>{' '}
              {b.ai.quality.modelStatus === 'NOT_TRAINED' && <Badge value="NOT_TRAINED" title="No AI quality model is trained" />}
              {b.ai.quality.standardsScreening && (
                <div style={{ marginTop: 6 }}>
                  <small className="muted">Rule-based check against {b.ai.quality.standardsScreening.standard}:</small>
                  <div className="btn-row" style={{ marginTop: 4 }}>
                    {b.ai.quality.standardsScreening.checks.map((c) => <span key={c.label}>{c.label} <Badge value={c.outcome} /></span>)}
                  </div>
                </div>
              )}
              {b.ai.quality.modelStatus === 'NOT_TRAINED' && <p className="muted" style={{ fontSize: '0.83rem' }}>No AI quality model is trained (a validated labelled dataset is required).</p>}
            </div>
          )}
          {b.ai?.adulteration && (
            <div>
              <strong>Adulteration screening (hyperspectral AI model)</strong>{' '}
              {b.ai.adulteration.prediction ? <Badge value={b.ai.adulteration.prediction.label} /> : <Badge value={b.ai.adulteration.modelStatus} />}
              <p className="muted" style={{ fontSize: '0.83rem' }}>Low-reliability research model; the laboratory's adulteration test above is authoritative.</p>
            </div>
          )}
        </section>

        <section className="notice">{b.notices.map((n) => <p key={n} style={{ margin: '4px 0' }}>{n}</p>)}</section>
      </div>
    </>
  );
}
