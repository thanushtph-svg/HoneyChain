// Product verification page (consumer view). Works WITHOUT an account at /verify/:code; signed-in
// consumers see it inside their dashboard at /consumer/verify/:code and the check is kept in their history.
// Everything comes from the public API, which only exposes consumer-approved fields.
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
const VERDICT = {
  VERIFIED: { kind: 'success', title: 'Records verified against the blockchain' },
  MISMATCH: { kind: 'error', title: 'Integrity warning: records changed after anchoring' },
  PARTIAL: { kind: 'warn', title: 'Partially verified' },
  NOT_ANCHORED: { kind: 'info', title: 'Not verifiable: records are not anchored' },
  UNAVAILABLE: { kind: 'warn', title: 'Verification unavailable right now' },
};

function Row({ k, v }) {
  return (<><dt>{k}</dt><dd>{v ?? '-'}</dd></>);
}

function Wrap({ embedded, children }) {
  if (embedded) return <div className="verify-embedded">{children}</div>;
  return (<><PublicTop /><div className="public-wrap">{children}</div></>);
}

export default function VerifyBatch({ embedded = false }) {
  const { batchCode } = useParams();
  const s = useApi(`/public/batches/${encodeURIComponent(batchCode)}`, [batchCode]);
  const back = embedded ? '/consumer' : '/verify';

  if (s.loading) return <Wrap embedded={embedded}><Loading text="Looking up batch and checking the blockchain..." /></Wrap>;
  if (s.error) {
    return (
      <Wrap embedded={embedded}>
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <h1>{s.error.status === 404 ? 'Batch not found' : 'Could not load this batch'}</h1>
          <div className="alert error" style={{ textAlign: 'left' }}>
            {s.error.status === 404
              ? <>No HoneyChain record exists for <b>{batchCode}</b>. Check the code on the label. A product whose code is not found <strong>cannot be verified</strong>.</>
              : <>{s.error.message} The product could <strong>not</strong> be verified.</>}
          </div>
          <Link to={back}>Verify another product</Link>
        </div>
      </Wrap>
    );
  }
  const b = s.data;
  const v = VERDICT[b.verification.overall];
  const received = (type) => b.custody.find((c) => c.transfer_type === type);
  const proc = received('TO_PROCESSOR');
  const dist = received('TO_DISTRIBUTOR');

  return (
    <Wrap embedded={embedded}>
      {b.isDemo && <div className="alert info"><strong>Demo data.</strong> This batch was created by the HoneyChain seed script for demonstration. The people, places and lab values are fictional.</div>}
      <div className={`alert ${v.kind} verdict`} role="status">
        <strong>{v.title}</strong> <Badge value={b.verification.overall} />
        <div>{b.verification.message}</div>
        <small>{b.verification.recordsChecked} of {b.verification.recordsExpected} published records verified. Blockchain verification proves a record matches the version that was anchored - not that the original information was true.</small>
      </div>
      {b.savedToHistory && <p className="muted" style={{ fontSize: '0.85rem' }}>Saved to your verification history.</p>}

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
            <div style={{ marginTop: 8 }}>{b.laboratory ? <>Lab result <Badge value={b.laboratory.decision} /></> : <span className="muted">Not tested yet</span>}</div>
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
        <div className="card-head">
          <h3>Laboratory results</h3>
          {b.laboratory && <Badge value={b.laboratory.decision} />}
        </div>
        {!b.laboratory ? <p className="muted">No laboratory result has been published for this batch yet.</p> : (
          <>
            {b.laboratory.correctsReport && <div className="alert info">This result is an audited correction of report {b.laboratory.correctsReport}, approved by the platform administrator.</div>}
            <dl className="kv">
              <Row k="Laboratory" v={`${b.laboratory.labName}${b.laboratory.accreditationNo ? ` (${b.laboratory.accreditationNo})` : ''}`} />
              <Row k="Report / tested on" v={`${b.laboratory.reportCode} · ${fmtDate(b.laboratory.testedOn)}`} />
              <Row k="Moisture" v={`${b.laboratory.moisturePct} %`} />
              <Row k="HMF" v={`${b.laboratory.hmfMgKg} mg/kg`} />
              <Row k="Sucrose" v={`${b.laboratory.sucroseG100g} g/100 g`} />
              {b.laboratory.fructoseG100g && <Row k="Fructose / glucose" v={`${b.laboratory.fructoseG100g} / ${b.laboratory.glucoseG100g} g/100 g`} />}
              {b.laboratory.ph && <Row k="pH" v={b.laboratory.ph} />}
              <Row k="Pollen" v={b.laboratory.pollenIdentification} />
              <Row k="Adulteration test" v={<><Badge value={b.laboratory.adulterationResult} /> {b.laboratory.adulterationMethod && <small>({b.laboratory.adulterationMethod})</small>}</>} />
            </dl>
          </>
        )}
      </section>

      <section className="card">
        <h3>Journey</h3>
        <div className="timeline">
          <div className="tl-item"><div className="tl-title">Harvested</div><div className="tl-meta">{fmtDate(b.harvest.date)} · {b.origin.district}, {b.origin.state}</div></div>
          <div className={`tl-item ${proc ? '' : 'pending'}`}><div className="tl-title">Received by processor</div><div className="tl-meta">{proc ? `${fmtDate(proc.received_on)} · ${proc.receiver_name}, ${proc.receiver_city}` : 'pending'}</div></div>
          <div className={`tl-item ${b.processing ? '' : 'pending'}`}><div className="tl-title">Processed &amp; packed</div><div className="tl-meta">{b.processing ? `${fmtDate(b.processing.date)} · ${b.processing.processorCity}` : 'pending'}</div></div>
          <div className={`tl-item ${b.laboratory ? '' : 'pending'}`}><div className="tl-title">Laboratory tested {b.laboratory && <Badge value={b.laboratory.decision} />}</div><div className="tl-meta">{b.laboratory ? `${fmtDate(b.laboratory.testedOn)} · ${b.laboratory.labName}` : 'pending'}</div></div>
          <div className={`tl-item ${dist ? '' : 'pending'}`}><div className="tl-title">Received by distributor</div><div className="tl-meta">{dist ? `${fmtDate(dist.received_on)} · ${dist.receiver_name}` : 'pending'}</div></div>
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
        {b.integrity.length === 0 && <p className="muted">These records have not been anchored on a blockchain, so their integrity cannot be checked.</p>}
        {b.integrity.map((i) => (
          <div className="integrity-row" key={i.record + i.recordCode}>
            <div>
              <strong>{RECORD_LABEL[i.record]}</strong> <small>{i.recordCode}{i.superseded ? ' (superseded by a correction)' : ''}</small>
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
        <h3>Laboratory analysis report</h3>
        <p className="muted" style={{ fontSize: '0.83rem' }}>Automatic analysis attached to the approved laboratory result: a rule-based check against a published honey standard (which decides PASS or FAIL) and, only where a validated model exists, an informational machine-learning result.</p>
        {!b.labAnalysis && <p className="muted">No laboratory result has been approved for this batch yet.</p>}
        {b.labAnalysis && !b.labAnalysis.available && <p className="muted">{b.labAnalysis.message}</p>}
        {b.labAnalysis?.available && (() => {
          const la = b.labAnalysis;
          const failed = la.standards.checks.filter((c) => c.outcome === 'FAIL');
          return (
            <div>
              <div className="btn-row" style={{ marginBottom: 8 }}>
                <span>Laboratory outcome (automatic): <Badge value={la.finalDecision} /></span>
                <span>Required tests: <Badge value={la.standards.status} /></span>
                <span>Report: <Badge value={la.overallStatus} /></span>
              </div>
              <p style={{ margin: '4px 0' }}><strong>{la.standards.title}</strong> - {la.standards.standard} ({la.standards.version}) · {la.honeyCategory}</p>
              <p style={{ margin: '4px 0' }}>
                {la.standards.status === 'ALL_PASSED' && 'All required laboratory tests recorded in HoneyChain are within the permitted limits.'}
                {la.standards.status === 'FAILED' && `Outside the permitted limits: ${failed.map((c) => c.label).join(', ')}.`}
                {la.standards.status === 'INCOMPLETE' && 'Some required tests were not provided.'}
              </p>
              <div className="btn-row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                {la.standards.checks.map((c) => <span key={c.label} title={`${c.value ?? '-'} ${c.unit} (limit ${c.limit})`}>{c.label} <Badge value={c.outcome} /></span>)}
              </div>
              {la.ml.status === 'PREDICTION_AVAILABLE' && (
                <p style={{ margin: '10px 0 4px' }}><strong>Machine-learning result:</strong>{' '}
                  pattern resembles <Badge value={la.ml.predictedClass} kind="info" /> (model {la.ml.modelVersion})</p>
              )}
              <ul style={{ margin: '6px 0', paddingLeft: 18 }}>{la.limitations.map((l) => <li key={l}><small>{l}</small></li>)}</ul>
              <small className="muted">Analysis {la.analysisCode} · {fmtDateTime(la.analysedAt)} · outcome assigned automatically from the measurements {la.approvedOn ? `on ${fmtDate(la.approvedOn)}` : ''}</small>
            </div>
          );
        })()}
      </section>

      <section className="notice">{b.notices.map((n) => <p key={n} style={{ margin: '4px 0' }}>{n}</p>)}</section>
      <p><Link to={back}>Verify another product</Link></p>
    </Wrap>
  );
}
