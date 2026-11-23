// Hand lab-passed batches over to a distributor; follow outgoing transfers.
import { useState } from 'react';
import { post } from '../../api/client.js';
import { Card, PageHeader, useApi } from '../../components/ui.jsx';
import { SendPanel } from '../shared/BatchDetail.jsx';
import { TransferTable } from '../shared/Transfers.jsx';

export default function ProcessorTransfers() {
  const [sel, setSel] = useState('');
  const [v, setV] = useState(0);
  const ready = useApi(`/batches?status=LAB_PASSED&pageSize=100&v=${v}`);
  return (
    <>
      <PageHeader title="Transfers" subtitle="Only batches with a current PASS laboratory result can be transferred. All packed units are handed over." />
      <Card title="Ready for a distributor (lab passed)">
        {(ready.data ?? []).length === 0 ? <p className="muted">No lab-passed batches are waiting.</p> : (
          <div className="btn-row">
            {ready.data.map((b) => <button key={b.batch_code} className={`btn small ${sel === b.batch_code ? '' : 'secondary'}`} onClick={() => setSel(b.batch_code)}>{b.batch_code} · {b.honey_type}</button>)}
          </div>
        )}
      </Card>
      {sel && (
        <SendPanel key={sel} title={`Transfer ${sel} to a distributor`} orgType="DISTRIBUTOR" submitLabel="Send batch"
          help="Custody moves when the distributor accepts. If rejected, the batch returns to you with their reason."
          onSend={(toOrgId, notes) => post(`/batches/${sel}/transfers`, { toOrgId, notes })} onDone={() => { setSel(''); setV((x) => x + 1); }} />
      )}
      <Card title="Outgoing transfers">
        <TransferTable key={v} direction="outgoing" empty="No outgoing transfers yet." />
      </Card>
    </>
  );
}
