import { Async, Badge, Card, PageHeader, Table, useApi, fmtDateTime } from '../../components/ui.jsx';

function StandardsRules() {
  const o = useApi('/ai/lab-analysis/options');
  return (
    <Async state={o}>
      {(d) => (
        <Card title={<>{d.title} <span className="badge info">RULES, NOT AI</span></>}>
          <p>Runs automatically on every submitted lab report. Active standard: <strong>{d.activeProfile}</strong> (the other profile is shown as a reference). Failed-standard policy: <strong>{String(d.failedStandardPolicy).replaceAll('_', ' ')}</strong>. Rule set version {d.rulesetVersion}.</p>
          {d.profiles.map((p) => (
            <details key={p.key} style={{ marginBottom: 8 }}>
              <summary><strong>{p.name}</strong> - {p.version}</summary>
              <p className="muted" style={{ fontSize: '0.83rem' }}>{p.reference}<br />{p.verification}</p>
              <Table rows={p.parameters} rowKey={(x) => x.id} columns={[
                { label: 'Parameter', render: (x) => <>{x.label}{x.mandatory ? ' *' : ''}</> }, { label: 'General limit', key: 'limit' },
                { label: 'Honey-type exceptions', render: (x) => Object.entries(x.exceptions).map(([c, l]) => c + ': ' + l).join('; ') || '-' },
              ]} />
              <small className="muted">Not recorded by HoneyChain (confirm on the lab certificate): {p.notRecorded.map((n) => n.label).join(', ')}</small>
            </details>
          ))}
        </Card>
      )}
    </Async>
  );
}

export default function AiModels() {
  const s = useApi('/ai/models');
  return (
    <>
      <PageHeader title="AI models" subtitle="Automatic lab analysis: standards rules, the Random Forest model status, and retired research models" />
      <StandardsRules />
      <Async state={s}>
        {(d) => !d.available ? <div className="alert error">AI service is not reachable: {d.error}</div> : d.models.map((m) => (
          <Card key={m.name} title={<>{m.name} <Badge value={m.status} /></>}>
            {m.name === 'honey-quality' && <p><strong>Random Forest classifier</strong> used by the automatic lab analysis when a validated model exists.</p>}
            {m.name === 'honey-adulteration' && <div className="alert info">Retired from the normal lab workflow (it needs hyperspectral scans, not ordinary lab measurements). Kept for reference only.</div>}
            {m.status !== 'TRAINED' && <div className="alert warn">{m.reason}</div>}
            {m.description && <p>{m.description}</p>}
            {m.status === 'TRAINED' && (
              <dl className="kv">
                <dt>Task</dt><dd>{m.task} · version {m.version} · trained {fmtDateTime(m.trainedAt)}</dd>
                <dt>Input</dt><dd>{m.inputModality}{m.inputRequirements?.band_count ? ` - ${m.inputRequirements.band_count} bands (${m.inputRequirements.wavelengths_nm[0]}-${m.inputRequirements.wavelengths_nm.at(-1)} nm)` : ''}<br /><small>{m.inputRequirements?.capture}</small></dd>
                <dt>Outputs</dt><dd>{m.labels ? Object.values(m.labels).join(' / ') : '-'}</dd>
                <dt>Dataset</dt><dd>{m.dataset?.title} - {m.dataset?.creators}<br /><small>DOI {m.dataset?.doi} · {m.dataset?.licence} · {m.dataset?.rows_used} observations</small></dd>
                <dt>Reliability</dt><dd><Badge value={m.reliability?.level} /> {m.reliability?.summary}</dd>
                <dt>Evaluation</dt><dd>
                  {m.metricsSummary && <>
                    {m.metricsSummary.headline}: balanced accuracy <strong>{m.metricsSummary.jar_balanced_accuracy}</strong>,
                    recall (adulterated) {m.metricsSummary.jar_recall_adulterated}, specificity (pure) {m.metricsSummary.jar_specificity_pure}
                    {' '}({m.metricsSummary.pure_jars} pure / {m.metricsSummary.adulterated_jars} adulterated jars).<br />
                    <small>{m.metricsSummary.note}</small>
                  </>}
                </dd>
                <dt>Limitations</dt><dd><ul style={{ margin: 0, paddingLeft: 18 }}>{(m.limitations ?? []).map((l) => <li key={l}>{l}</li>)}</ul></dd>
              </dl>
            )}
          </Card>
        ))}
      </Async>
      <div className="notice">The Standards-Based Laboratory Compliance Check is deterministic (not AI) and works even when no ML model is trained. AI output is decision support only; laboratory decisions are authoritative.</div>
    </>
  );
}
