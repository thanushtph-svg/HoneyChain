// Small reusable UI building blocks.
import { useCallback, useEffect, useState } from 'react';
import { get } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { pathFor } from '../roles.js';

/** Load data from the API: { data, meta, error, loading, reload } */
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: Boolean(path) });
  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await get(path);
      setState({ data: r.data, meta: r.meta ?? null, error: null, loading: false });
    } catch (e) {
      setState({ data: null, meta: null, error: e, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="btn-row">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="btn-row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value ?? '-'}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Loading({ text = 'Loading...' }) {
  return (
    <div className="loading">
      <span className="spinner" /> {text}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <strong>{error.message}</strong>
      {error.details?.length > 0 && (
        <ul>
          {error.details.map((d, i) => (
            <li key={i}>
              {d.path ? <code>{d.path}</code> : null} {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Alert({ kind = 'info', children }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Empty({ children = 'Nothing here yet.' }) {
  return <div className="empty">{children}</div>;
}

/** Wraps loading / error / empty states around content */
export function Async({ state, empty, children }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} />;
  if (empty && (!state.data || (Array.isArray(state.data) && state.data.length === 0))) return <Empty>{empty}</Empty>;
  return children(state.data, state.meta);
}

const STATUS_KIND = {
  CREATED: 'info', IN_TESTING: 'warn', LAB_PASSED: 'ok', LAB_FAILED: 'bad', PROCESSED: 'honey', IN_DISTRIBUTION: 'honey', DELIVERED: 'ok',
  DRAFT: 'warn', SUBMITTED: 'ok', PASS: 'ok', FAIL: 'bad', DISPATCHED: 'info', IN_TRANSIT: 'warn', CANCELLED: 'bad',
  ACTIVE: 'ok', INACTIVE: '', PENDING: 'warn', CONFIRMED: 'ok', FAILED: 'bad', VERIFIED: 'ok', MISMATCH: 'bad',
  NOT_FOUND_ON_CHAIN: 'warn', CHAIN_UNAVAILABLE: 'warn', OPEN: 'bad', ACKNOWLEDGED: 'warn', RESOLVED: 'ok', DISMISSED: '',
  NOT_DETECTED: 'ok', DETECTED: 'bad', INCONCLUSIVE: 'warn', NOT_TESTED: '', TRAINED: 'ok', NOT_TRAINED: 'warn',
  WITHIN_LIMIT: 'ok', EXCEEDS_LIMIT: 'bad', NOT_MEASURED: '', CRITICAL: 'bad', WARNING: 'warn', INFO: 'info',
  INSUFFICIENT_DATA: 'warn', SCORED: 'ok', SERVICE_UNAVAILABLE: 'bad', INPUT_INCOMPATIBLE: 'bad', SUBMITTED_TX: 'info',
  PENDING_PROCESSOR: 'warn', IN_PROCESSING: 'honey', PENDING_LAB: 'warn', LAB_INCONCLUSIVE: 'warn', PENDING_DISTRIBUTOR: 'warn',
  ACCEPTED: 'ok', REJECTED: 'bad', COMPLETED: 'ok', SUPERSEDED: '', APPROVED: 'ok', PARTIAL: 'warn', NOT_ANCHORED: '', UNAVAILABLE: 'warn',
  TO_PROCESSOR: 'info', TO_DISTRIBUTOR: 'info', REVIEWED: 'ok', UNREVIEWED: '',
  ADULTERATION_SUSPECTED: 'bad', NO_ADULTERATION_DETECTED: 'ok', LOW: 'bad', MODERATE: 'warn', HIGH: 'ok',
  // automatic lab analysis
  ALL_PASSED: 'ok', INCOMPLETE: 'warn', COMPLETED_WITH_LIMITATIONS: 'warn', PREDICTION_AVAILABLE: 'ok', NOT_AVAILABLE: 'warn',
  INSUFFICIENT_INPUT: 'warn', NOT_PROVIDED: 'warn', IMPLAUSIBLE: 'bad', NOT_APPLICABLE: '', PENDING_REVIEW: 'warn', STALE: 'warn',
  FLAGGED_FOR_REVIEW: 'warn', LEGACY: '',
};

export function Badge({ value, kind, title }) {
  if (value == null || value === '') return <span className="muted">-</span>;
  return (
    <span className={`badge ${kind ?? STATUS_KIND[value] ?? ''}`} title={title}>
      {String(value).replaceAll('_', ' ')}
    </span>
  );
}

export const DemoBadge = ({ show }) => (show ? <span className="badge demo" title="Seed/demo data, not a real record">DEMO DATA</span> : null);

export function Table({ columns, rows, empty = 'No records.', rowKey }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key ?? c.label}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : i}>
              {columns.map((c) => (
                <td key={c.key ?? c.label}>{c.render ? c.render(r) : (r[c.key] ?? '-')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ meta, page, setPage }) {
  if (!meta || meta.total <= meta.pageSize) return null;
  const pages = Math.ceil(meta.total / meta.pageSize);
  return (
    <div className="pager">
      <span>
        Page {page} of {pages} ({meta.total} records)
      </span>
      <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
      <button className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  );
}

export function Field({ label, hint, children, full }) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Controlled form state helper */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const bind = (name, opts = {}) => ({
    name,
    value: values[name] ?? '',
    onChange: (e) => {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setValues((s) => ({ ...s, [name]: opts.number && v !== '' ? v : v }));
    },
  });
  return { values, setValues, bind, reset: () => setValues(initial) };
}

/** Submit helper: tracks busy/error/success around an async action */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const run = async (fn, successMessage) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      if (successMessage) setMessage(typeof successMessage === 'function' ? successMessage(r) : successMessage);
      return r;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, message, run, setError, setMessage };
}

export const fmtDate = (d) => (d ? String(d).slice(0, 10) : '-');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : '-');
export const kg = (v) => (v == null ? '-' : `${Number(v).toFixed(2)} kg`);
export const today = () => new Date().toISOString().slice(0, 10);
export const short = (h, n = 10) => (h ? `${h.slice(0, n)}...${h.slice(-6)}` : '-');

/** Bars for real numbers (no decorative charts) */
export function Bars({ items, labelKey, valueKey, format = (v) => v }) {
  const max = Math.max(1, ...items.map((i) => Number(i[valueKey]) || 0));
  if (!items.length) return <Empty>No data yet.</Empty>;
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i[labelKey]}>
          <span>{String(i[labelKey]).replaceAll('_', ' ')}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${((Number(i[valueKey]) || 0) / max) * 100}%` }} />
          </div>
          <strong>{format(i[valueKey])}</strong>
        </div>
      ))}
    </div>
  );
}

/** Link builder for the CURRENT user's own view: base('batches/HC-1') -> /processor/batches/HC-1 */
export function useBase() {
  const { user } = useAuth();
  return (sub = '') => pathFor(user.role, sub);
}

/** Button that asks for confirmation, runs an async action and shows its error. */
export function ConfirmButton({ confirm, onClick, children, kind = '', small = true, onDone }) {
  const a = useAction();
  return (
    <span className="confirm-wrap">
      <button type="button" className={`btn ${small ? 'small' : ''} ${kind}`} disabled={a.busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          const r = await a.run(onClick);
          if (r && onDone) onDone(r);
        }}>
        {a.busy ? 'Working...' : children}
      </button>
      {a.error && <span className="inline-error" role="alert">{a.error.message}</span>}
    </span>
  );
}

/** Opens an inline form that requires a written reason (rejections, cancellations, corrections). */
export function ReasonAction({ label, placeholder = 'Reason (required)', confirm, onSubmit, onDone, kind = 'secondary', minLength = 5 }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const a = useAction();
  if (!open) return <button type="button" className={`btn small ${kind}`} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form className="inline-form" onSubmit={async (e) => {
      e.preventDefault();
      if (confirm && !window.confirm(confirm)) return;
      const r = await a.run(() => onSubmit(reason.trim()));
      if (r) { setOpen(false); setReason(''); onDone?.(r); }
    }}>
      <textarea aria-label={label} required minLength={minLength} placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} />
      <ErrorBox error={a.error} />
      <div className="btn-row">
        <button className="btn small" disabled={a.busy}>{a.busy ? 'Saving...' : `Confirm: ${label}`}</button>
        <button type="button" className="btn small secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

/** Simple tabs */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{label}</button>)}
    </div>
  );
}
