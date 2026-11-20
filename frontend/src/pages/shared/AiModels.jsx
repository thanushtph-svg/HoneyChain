import { Async, Badge, Card, PageHeader, useApi, fmtDateTime } from '../../components/ui.jsx';

export default function AiModels() {
  const s = useApi('/ai/models');
  return (
    <>
      <PageHeader title="AI models" subtitle="Status, inputs, datasets, evaluation and limitations of each model" />
      <Async state={s}>
        {(d) => !d.available ? <div className="alert error">AI service is not reachable: {d.error}</div> : d.models.map((m) => (
          <Card key={m.name} title={<>{m.name} <Badge value={m.status} /></>}>
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
      <div className="notice">Rule-based standards screening (moisture, HMF, sucrose limits) is not AI and is always available on lab reports. AI output is decision support only; laboratory decisions are authoritative.</div>
    </>
  );
}
