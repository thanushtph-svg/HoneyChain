import { Link } from 'react-router-dom';
import { PublicTop } from './Home.jsx';

export default function NotFound({ inApp }) {
  const body = (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <h1>Page not found</h1>
      <p className="muted">The page you were looking for does not exist.</p>
      <Link to={inApp ? '/app' : '/'}>{inApp ? 'Back to dashboard' : 'Back to HoneyChain'}</Link>
    </div>
  );
  if (inApp) return body;
  return (<><PublicTop /><div className="public-wrap">{body}</div></>);
}
