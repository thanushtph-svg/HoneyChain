// Processed batches: request laboratory testing (or a re-test after INCONCLUSIVE) and follow the lab status.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api/client.js';
import { Card, PageHeader, useApi, useBase } from '../../components/ui.jsx';
import { BatchTable } from '../shared/BatchList.jsx';
import { SendPanel } from '../shared/BatchDetail.jsx';
import { RequestTable } from '../lab/Requests.jsx';

export default function ProcessedBatches() {
  const base = useBase();
  const [sel, setSel] = useState('');
  const [v, setV] = useState(0);
  const eligible = useApi(`/batches?status=PROCESSED,LAB_INCONCLUSIVE&pageSize=100&v=${v}`);
  return (
    <>
      <PageHeader title="Processed batches" subtitle="Send a sample of each processed batch to a laboratory. Results are entered by the laboratory only." />
      <Card title="Needs a testing request">
        {(eligible.data ?? []).length === 0 ? <p className="muted">No processed batches are waiting for a testing request.</p> : (
          <div className="btn-row">
            {eligible.data.map((b) => (
              <button key={b.batch_code} className={`btn small ${sel === b.batch_code ? '' : 'secondary'}`} onClick={() => setSel(b.batch_code)}>
                {b.batch_code}{b.status === 'LAB_INCONCLUSIVE' ? ' (re-test)' : ''}
              </button>
            ))}
          </div>
        )}
      </Card>
      {sel && (
        <SendPanel key={sel} title={`Request testing for ${sel}`} orgType="LABORATORY" submitLabel="Send testing request"
          help={<>The laboratory accepts or rejects the request. <Link to={base(`batches/${sel}`)}>Open batch {sel}</Link></>}
          onSend={(labOrgId, notes) => post('/lab-requests', { batchCode: sel, labOrgId, notes })}
          onDone={() => { setSel(''); setV((x) => x + 1); }} />
      )}
      <Card title="Testing requests sent by your unit">
        <RequestTable key={`r${v}`} viewer="PROCESSOR" onChange={() => setV((x) => x + 1)} />
      </Card>
      <Card title="All processed batches">
        <BatchTable key={`b${v}`} statuses={['PROCESSED', 'PENDING_LAB', 'IN_TESTING', 'LAB_PASSED', 'LAB_FAILED', 'LAB_INCONCLUSIVE', 'PENDING_DISTRIBUTOR', 'IN_DISTRIBUTION', 'DELIVERED']}
          empty="No processed batches yet." showOrigin={false} />
      </Card>
    </>
  );
}
