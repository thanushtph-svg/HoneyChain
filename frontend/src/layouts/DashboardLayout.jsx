import { useState } from 'react';
import { NavLink, Outlet, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Loading } from '../components/ui.jsx';

const NAV = {
  BEEKEEPER: [
    ['Overview', '/app'],
    ['My hives', '/app/hives'],
    ['Harvests', '/app/harvests'],
    ['Batches', '/app/batches'],
    ['Profile', '/app/profile'],
  ],
  LAB: [
    ['Overview', '/app'],
    ['Testing queue', '/app/lab/queue'],
    ['Testing history', '/app/lab/reports'],
    ['Batches', '/app/batches'],
    ['AI models', '/app/ai-models'],
  ],
  PROCESSOR: [
    ['Overview', '/app'],
    ['Processing queue', '/app/processing/queue'],
    ['Processing history', '/app/processing'],
    ['Batches', '/app/batches'],
  ],
  DISTRIBUTOR: [
    ['Overview', '/app'],
    ['Dispatch queue', '/app/distribution/queue'],
    ['Shipments', '/app/shipments'],
    ['Batches', '/app/batches'],
  ],
  ADMIN: [
    ['System overview', '/app'],
    ['Users', '/app/admin/users'],
    ['Organizations', '/app/admin/organizations'],
    ['Batches', '/app/batches'],
    ['Records', '/app/admin/records'],
    ['Anomalies', '/app/admin/anomalies'],
    ['Blockchain', '/app/admin/blockchain'],
    ['Activity logs', '/app/admin/logs'],
    ['AI models', '/app/ai-models'],
  ],
};

const ROLE_LABEL = { ADMIN: 'Administrator', BEEKEEPER: 'Beekeeper', LAB: 'Laboratory', PROCESSOR: 'Processor', DISTRIBUTOR: 'Distributor' };

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 4 56 18v28L32 60 8 46V18z" fill="#d98a0b" />
      <path d="M32 16 45 23.5v15L32 46 19 38.5v-15z" fill="#fff7e6" />
    </svg>
  );
}

export default function DashboardLayout() {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  if (loading) return <Loading text="Checking your session..." />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand"><Logo /> HoneyChain</div>
        <div className="nav-section">{ROLE_LABEL[user.role]}</div>
        <nav className="nav">
          {NAV[user.role].map(([label, to]) => (
            <NavLink key={to} to={to} end={to === '/app' || to === '/app/processing'}>{label}</NavLink>
          ))}
        </nav>
        <div className="nav-section">Public</div>
        <nav className="nav">
          <NavLink to="/" end>Consumer site</NavLink>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn secondary small menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">Menu</button>
          <span className="who">
            <strong>{user.fullName}</strong> · {ROLE_LABEL[user.role]}
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

/** Route guard by role (the server enforces the same rules; this only keeps the UI tidy) */
export function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) {
    return <div className="alert error">Your role ({user.role}) cannot open this page.</div>;
  }
  return children;
}
