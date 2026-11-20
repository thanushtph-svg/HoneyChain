import { Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { ErrorBox, Field, useAction, useForm } from '../../components/ui.jsx';
import { Logo } from '../../layouts/DashboardLayout.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const f = useForm({ email: '', password: '' });
  const a = useAction();
  const nav = useNavigate();
  const loc = useLocation();
  if (user) return <Navigate to="/app" replace />;

  const submit = async (e) => {
    e.preventDefault();
    const u = await a.run(() => login(f.values.email, f.values.password));
    if (u) nav(loc.state?.from ?? '/app', { replace: true });
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" style={{ color: 'var(--ink)', margin: '0 0 10px' }}><Logo /> HoneyChain</div>
        <h1>Sign in</h1>
        <p className="muted">Beekeepers, laboratories, processors, distributors and administrators.</p>
        <ErrorBox error={a.error} />
        <form onSubmit={submit} className="grid">
          <Field label="Email"><input type="email" autoComplete="username" required {...f.bind('email')} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
          <button className="btn" disabled={a.busy}>{a.busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
        <p style={{ marginTop: 16 }}>
          New beekeeper? <Link to="/register">Create an account</Link>
          <br />
          Staff accounts (lab, processor, distributor) are created by an administrator.
        </p>
        <p><Link to="/">Consumer verification site</Link></p>
      </div>
    </div>
  );
}
