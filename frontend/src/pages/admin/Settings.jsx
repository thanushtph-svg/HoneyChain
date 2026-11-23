// Settings: organizations, supported standards (active profile), application settings, change history.
import { Fragment, useState } from 'react';
import { patch } from '../../api/client.js';
import { Alert, Async, Badge, Card, ErrorBox, PageHeader, Table, Tabs, useAction, useApi, fmtDateTime } from '../../components/ui.jsx';
import Organizations from './Organizations.jsx';

function SettingsPanel() {
  const s = useApi('/admin/settings');
  const a = useAction();
  const save = async (key, value, label) => {
    if (!window.confirm(`Change "${label}"? The change is recorded in the audit log.`)) return;
    if (await a.run(() => patch(`/admin/settings/${key}`, { value }), 'Setting saved')) s.reload();
  };
  return (
    <Async state={s}>
      {(d) => {
        const val = Object.fromEntries(d.settings.map((x) => [x.setting_key, x.value]));
        return (
          <>
            <ErrorBox error={a.error} />
            {a.message && <Alert kind="success">{a.message}</Alert>}
            <Card title="Supported standards">
              <p className="muted">The active standard is used for the rule-based screening of laboratory values and the anomaly checks. It is not AI.</p>
              <div className="grid grid-2">
                {d.standardsProfiles.map((p) => (
                  <div className={`stat ${val.standards_profile === p.key ? 'selected' : ''}`} key={p.key}>
                    <div className="card-head"><strong>{p.name}</strong>{val.standards_profile === p.key ? <Badge value="ACTIVE" kind="ok" /> :
                      <button className="btn small secondary" disabled={a.busy} onClick={() => save('standards_profile', p.key, 'Active standard')}>Make active</button>}</div>
                    <Table rows={p.checks} rowKey={(c) => c.parameter} columns={[{ label: 'Parameter', key: 'label' }, { label: 'Limit', render: (c) => (c.max != null ? `≤ ${c.max} ${c.unit}` : `≥ ${c.min} ${c.unit}`) }]} />
                    <div className="sub">{p.source}</div>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Application settings">
              <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save('max_processing_loss_pct', Number(new FormData(e.target).get('loss')), 'Processing loss threshold'); }}>
                <label className="field"><span>Processing loss warning threshold (%)</span><input name="loss" type="number" min="0" max="100" step="0.5" defaultValue={val.max_processing_loss_pct} /></label>
                <div><button className="btn small">Save threshold</button></div>
              </form>
              <label className="check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={Boolean(val.consumer_registration_enabled)} onChange={(e) => save('consumer_registration_enabled', e.target.checked, 'Consumer registration')} />
                Allow consumers to create an optional account (verification never requires an account)
              </label>
            </Card>
            <Card title="System configuration (read-only, from .env)">
              <dl className="kv">{Object.entries(d.system).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd><code>{String(v)}</code></dd></Fragment>)}</dl>
            </Card>
            <Card title="Change history">
              <Table rows={d.history} rowKey={(r) => r.history_id} empty="No changes yet." columns={[
                { label: 'When', render: (r) => fmtDateTime(r.changed_at) }, { label: 'Setting', key: 'setting_key' },
                { label: 'From → to', render: (r) => <><code>{JSON.stringify(r.old_value)}</code> → <code>{JSON.stringify(r.new_value)}</code></> },
                { label: 'By', key: 'changed_by_name' },
              ]} />
            </Card>
          </>
        );
      }}
    </Async>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('settings');
  return (
    <>
      <PageHeader title="Settings" subtitle="Application configuration, supported standards and organizations" />
      <Tabs value={tab} onChange={setTab} tabs={[['settings', 'Configuration & standards'], ['orgs', 'Organizations']]} />
      {tab === 'settings' ? <SettingsPanel /> : <Organizations embedded />}
    </>
  );
}
