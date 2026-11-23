// One layout component, rendered separately for each of the six roles: the sidebar shows ONLY that
// role's navigation, and the whole view refuses to render for any other role (route guard).
// The server enforces the same rules on every API call; this guard keeps the UI honest.
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Loading } from '../components/ui.jsx';
import { ROLES, homeFor, roleLabel } from '../roles.js';

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 4 56 18v28L32 60 8 46V18z" fill="#d98a0b" />
      <path d="M32 16 45 23.5v15L32 46 19 38.5v-15z" fill="#fff7e6" />
    </svg>
  );
}

/** Shown when a signed-in user opens another role's URL. */
export function Forbidden({ user, wanted }) {
  return (
    <div className="auth-wrap">
      <div className="card auth-card forbidden" role="alert">
        <div className="brand" style={{ color: 'var(--ink)', margin: '0 0 10px' }}><Logo /> HoneyChain</div>
        <h1>Access denied (403)</h1>
        <p>This page belongs to the <strong>{roleLabel(wanted)}</strong> view. You are signed in as <strong>{roleLabel(user.role)}</strong>.</p>
        <Link className="btn" to={homeFor(user.role)}>Go to my dashboard</Link>
      </div>
    </div>
  );
}

export default function RoleLayout({ role }) {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  if (loading) return <Loading text="Checking your session..." />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (user.role !== role) return <Forbidden user={user} wanted={role} />;
  const cfg = ROLES[role];

  return (
    <div className={`shell role-${role.toLowerCase()}`}>
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand"><Logo /> HoneyChain</div>
        <div className="role-chip">{cfg.label} view</div>
        <nav className="nav" aria-label={`${cfg.label} navigation`}>
          {cfg.nav.map(([label, sub]) => {
            const to = sub ? `${cfg.base}/${sub}` : cfg.base;
            return <NavLink key={to} to={to} end={!sub}>{label}</NavLink>;
          })}
        </nav>
        {role !== 'CONSUMER' && (
          <>
            <div className="nav-section">Public</div>
            <nav className="nav"><NavLink to="/verify">Product verification site</NavLink></nav>
          </>
        )}
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn secondary small menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">Menu</button>
          <span className="who">
            <strong>{user.fullName}</strong> · {cfg.label}
            {user.organization ? ` · ${user.organization.name}` : ''}
          </span>
          <button className="btn secondary small" onClick={async () => { await logout(); nav('/login'); }}>Log out</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Old /app links (bookmarks, printed instructions) go to the user's own dashboard. */
export function LegacyAppRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}
