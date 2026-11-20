import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, qs } from '../../api/client.js';
import { Alert, Async, Badge, Card, ErrorBox, PageHeader, Pager, Table, useAction, useApi, fmtDateTime, short } from '../../components/ui.jsx';

export default function Blockchain() {
  const st = useApi('/blockchain/status');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const anchors = useApi(`/admin/anchors${qs({ page, status })}`);
  const [vpage, setVpage] = useState(1);
  const ver = useApi(`/admin/verifications?page=${vpage}`);
  const a = useAction();
  const [last, setLast] = useState(null);
  const reload = () => { anchors.reload(); ver.reload(); st.reload(); };

  return (
    <>
      <PageHeader title="Blockchain integrity" subtitle="Hashes of selected records are anchored on-chain. Verification recomputes the hash from PostgreSQL and compares it with the chain." />
      <Alert kind="info">A VERIFIED result proves the record has not changed since it was anchored. It does not prove the original data was true or that the honey is genuine.</Alert>
      <Card title="Network" actions={<button className="btn secondary small" onClick={st.reload}>Refresh</button>}>
        <Async state={st}>
          {(c) => (
            <dl className="kv">
              <dt>Status</dt><dd><Badge value={c.status === 'up' ? 'CONNECTED' : 'UNAVAILABLE'} kind={c.status === 'up' ? 'ok' : 'bad'} /> {c.detail}</dd>
              <dt>Network</dt><dd>{c.network}{c.chainId ? ` (chainId ${c.chainId})` : ''}</dd>
              {c.contractAddress && <><dt>Contract</dt><dd><code>{c.contractAddress}</code>{c.explorerBase && <> · <a href={`${c.explorerBase}/address/${c.contractAddress}`} target="_blank" rel="noreferrer">Etherscan</a></>}</dd></>}
              {c.signer && <><dt>Signer</dt><dd><code>{c.signer}</code> · {Number(c.signerBalanceEth).toFixed(4)} ETH · {c.signerIsAnchorer ? 'authorized' : 'NOT authorized'}</dd></>}
              {c.latestBlock != null && <><dt>Latest block</dt><dd>{c.latestBlock}</dd></>}
            </dl>
          )}
        </Async>
      </Card>

      <Card title="Anchors" actions={<>
        <select className="btn secondary small" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All</option>{['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED'].map((x) => <option key={x}>{x}</option>)}
        </select>
        <button className="btn secondary small" disabled={a.busy} onClick={async () => { if (await a.run(() => post('/admin/anchors/process'), (r) => `Worker run: ${r.data.processed ?? 0} processed, ${r.data.confirmed ?? 0} confirmed`)) reload(); }}>Process pending</button>
        <button className="btn small" disabled={a.busy} onClick={async () => { if (await a.run(() => post('/admin/anchors/anchor-missing'), (r) => `Queued ${r.data.queued} record(s)${r.data.refused.length ? `; refused ${r.data.refused.length} (changed since earlier anchoring)` : ''}`)) reload(); }}>Anchor missing records</button>
      </>}>
        <ErrorBox error={a.error} />
        {a.message && <Alert kind="success">{a.message}</Alert>}
        {last && <Alert kind={last.result === 'VERIFIED' ? 'success' : 'error'}>
          Anchor #{last.anchorId} ({last.entityType}): <strong>{last.result}</strong>{last.note ? ` - ${last.note}` : ''}<br />
          <small>recomputed <code>{last.recomputedHash}</code><br />on-chain <code>{last.onchainHash ?? '-'}</code></small>
        </Alert>}
        <Async state={anchors} empty="No anchors yet.">
          {(rows, meta) => (
            <>
              {meta?.unanchored > 0 && <Alert kind="warn">{meta.unanchored} eligible record(s) have no anchor on the current contract.</Alert>}
              <Table rows={rows} rowKey={(r) => r.anchor_id} columns={[
                { label: '#', key: 'anchor_id' },
                { label: 'Batch', render: (r) => <Link to={`/app/batches/${r.batch_code}`}>{r.batch_code}</Link> },
                { label: 'Record', render: (r) => <>{r.entity_type.replaceAll('_', ' ')}<br /><small>{r.entity_code}</small></> },
                { label: 'Hash', render: (r) => <code title={r.record_hash}>{short(r.record_hash, 8)}</code> },
                { label: 'Status', render: (r) => <Badge value={r.anchor_status} /> },
                { label: 'Transaction', render: (r) => (r.tx_hash ? <><code title={r.tx_hash}>{short(r.tx_hash, 8)}</code><br /><small>block {r.block_number} · {r.network}</small></> : '-') },
                { label: 'Last check', render: (r) => <><Badge value={r.last_result} /><br /><small>{fmtDateTime(r.last_checked_at)}</small></> },
                { label: '', render: (r) => (
                  <div className="btn-row">
                    {r.anchor_status === 'CONFIRMED' && <button className="btn small" disabled={a.busy} onClick={async () => { const res = await a.run(() => post(`/admin/anchors/${r.anchor_id}/verify`)); if (res) { setLast(res.data); reload(); } }}>Verify</button>}
                    {r.anchor_status === 'FAILED' && <button className="btn secondary small" disabled={a.busy} onClick={async () => { if (await a.run(() => post(`/admin/anchors/${r.anchor_id}/retry`), 'Retry queued')) reload(); }}>Retry</button>}
                  </div>
                ) },
              ]} />
              <Pager meta={meta} page={page} setPage={setPage} />
            </>
          )}
        </Async>
      </Card>

      <Card title="Verification history">
        <Async state={ver} empty="No verifications yet.">
          {(rows, meta) => (
            <>
              <Table rows={rows} rowKey={(r) => r.check_id} columns={[
                { label: 'When', render: (r) => fmtDateTime(r.checked_at) },
                { label: 'Batch', key: 'batch_code' },
                { label: 'Record', render: (r) => r.entity_type.replaceAll('_', ' ') },
                { label: 'Result', render: (r) => <Badge value={r.result} /> },
                { label: 'Triggered by', render: (r) => `${r.trigger_source}${r.checked_by_name ? ` (${r.checked_by_name})` : ''}` },
                { label: 'Recomputed / on-chain', render: (r) => <small><code>{short(r.recomputed_hash, 8)}</code><br /><code>{short(r.onchain_hash, 8)}</code></small> },
              ]} />
              <Pager meta={meta} page={vpage} setPage={setVpage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
