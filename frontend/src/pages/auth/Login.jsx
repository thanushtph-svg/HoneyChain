import { Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { ErrorBox, Field, useAction, useForm } from '../../components/ui.jsx';
import { Logo } from '../../layouts/DashboardLayout.jsx';
import { homeFor, isInsideRole } from '../../roles.js';

/** After login: back to the page the user wanted, but only if it belongs to their own role's view. */
export function destinationFor(user, from) {
  return isInsideRole(user.role, from?.split('?')[0]) ? from : homeFor(user.role);
}

export default function Login() {
  const { user, login } = useAuth();
  const f = useForm({ email: '', password: '' });
  const a = useAction();
  const nav = useNavigate();
  const loc = useLocation();
  if (user) return <Navigate to={destinationFor(user, loc.state?.from)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    const u = await a.run(() => login(f.values.email, f.values.password));
    if (u) nav(destinationFor(u, loc.state?.from), { replace: true });
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" style={{ color: 'var(--ink)', margin: '0 0 10px' }}><Logo /> HoneyChain</div>
        <h1>Sign in</h1>
        <p className="muted">Beekeepers, processors, lab testers, distributors, administrators and consumers. You are taken to your own dashboard.</p>
        <ErrorBox error={a.error} />
        <form onSubmit={submit} className="grid">
          <Field label="Email"><input type="email" autoComplete="username" required {...f.bind('email')} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
          <button className="btn" disabled={a.busy}>{a.busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
        <p style={{ marginTop: 16 }}>
          New beekeeper? <Link to="/register">Create a producer account</Link>
          <br />
          Consumer? <Link to="/register?type=consumer">Create an optional account</Link> to keep a verification history.
          <br />
          <small className="muted">Processor, lab tester and distributor accounts are created by an administrator.</small>
        </p>
        <p><Link to="/verify">Verify a product without an account</Link></p>
      </div>
    </div>
  );
}
