import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { ErrorBox, Field, useAction, useForm } from '../../components/ui.jsx';
import { Logo } from '../../layouts/DashboardLayout.jsx';
import { homeFor } from '../../roles.js';

// Optional consumer account: verification works without it; it only keeps a personal history.
function ConsumerRegister() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const a = useAction();
  const f = useForm({ email: '', password: '', fullName: '' });
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" style={{ color: 'var(--ink)', margin: '0 0 10px' }}><Logo /> HoneyChain</div>
        <h1>Consumer account</h1>
        <p className="muted">Optional. You can verify any product without an account; an account keeps a history of the products you checked.</p>
        <ErrorBox error={a.error} />
        <form className="grid" onSubmit={async (e) => {
          e.preventDefault();
          const r = await a.run(() => post('/auth/register-consumer', f.values));
          if (r) { await refresh(); nav(homeFor('CONSUMER')); }
        }}>
          <Field label="Name"><input required {...f.bind('fullName')} /></Field>
          <Field label="Email"><input type="email" autoComplete="username" required {...f.bind('email')} /></Field>
          <Field label="Password" hint="At least 8 characters with a letter and a digit"><input type="password" autoComplete="new-password" required {...f.bind('password')} /></Field>
          <button className="btn" disabled={a.busy}>{a.busy ? 'Creating account...' : 'Create account'}</button>
        </form>
        <p style={{ marginTop: 14 }}><Link to="/login">I already have an account</Link>
            <Link to="/register?type=consumer">I am a consumer</Link> · <Link to="/register">I am a beekeeper</Link> · <Link to="/verify">Verify without an account</Link></p>
      </div>
    </div>
  );
}

export default function Register() {
  const [sp] = useSearchParams();
  if (sp.get('type') === 'consumer') return <ConsumerRegister />;
  return <BeekeeperRegister />;
}

function BeekeeperRegister() {
  const { register } = useAuth();
  const nav = useNavigate();
  const a = useAction();
  const f = useForm({
    email: '', password: '', fullName: '', phone: '', publicDisplayName: '', showNamePublicly: false,
    cooperativeName: '', village: '', district: '', state: 'Karnataka', registrationNo: '',
  });

  const submit = async (e) => {
    e.preventDefault();
    const v = f.values;
    const u = await a.run(() => register({ ...v, publicDisplayName: v.publicDisplayName || v.fullName }));
    if (u) nav(homeFor(u.role));
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card wide">
        <div className="brand" style={{ color: 'var(--ink)', margin: '0 0 10px' }}><Logo /> HoneyChain</div>
        <h1>Beekeeper registration</h1>
        <p className="muted">Create your producer account. You can register hives and record harvests after signing up.</p>
        <ErrorBox error={a.error} />
        <form onSubmit={submit}>
          <fieldset>
            <legend>Login</legend>
            <div className="form-grid">
              <Field label="Email"><input type="email" required {...f.bind('email')} /></Field>
              <Field label="Password" hint="At least 8 characters with a letter and a digit"><input type="password" required {...f.bind('password')} /></Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>Profile</legend>
            <div className="form-grid">
              <Field label="Full name"><input required {...f.bind('fullName')} /></Field>
              <Field label="Phone (private)"><input {...f.bind('phone')} /></Field>
              <Field label="Public display name" hint="Shown to consumers only if you allow it below"><input placeholder="same as full name" {...f.bind('publicDisplayName')} /></Field>
              <Field label="Cooperative / group"><input {...f.bind('cooperativeName')} /></Field>
              <Field label="Village"><input {...f.bind('village')} /></Field>
              <Field label="District"><input required {...f.bind('district')} /></Field>
              <Field label="State"><input required {...f.bind('state')} /></Field>
              <Field label="Registration no. (optional)" hint="e.g. NBB / KVIC registration"><input {...f.bind('registrationNo')} /></Field>
              <label className="check full">
                <input type="checkbox" checked={f.values.showNamePublicly} onChange={(e) => f.setValues({ ...f.values, showNamePublicly: e.target.checked })} />
                Show my display name on the public QR verification page
              </label>
            </div>
          </fieldset>
          <div className="btn-row">
            <button className="btn" disabled={a.busy}>{a.busy ? 'Creating account...' : 'Create account'}</button>
            <Link to="/login">I already have an account</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
