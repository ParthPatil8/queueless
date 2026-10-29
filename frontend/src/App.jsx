import { Component, createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate, useNavigate } from 'react-router-dom';
import { api, probe } from './api.js';
import Landing from './pages/Landing.jsx';
import Ticket from './pages/Ticket.jsx';
import StaffLogin from './pages/StaffLogin.jsx';
import StaffDashboard from './pages/StaffDashboard.jsx';
import Admin from './pages/Admin.jsx';
import NotFound from './pages/NotFound.jsx';

// If any page throws while rendering, show a message instead of a blank screen.
class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('UI error:', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="container narrow">
        <div className="card notice error" role="alert">
          <h1 className="h2">Something went wrong</h1>
          <p>This page hit an unexpected error. Reload the page; if it keeps happening, go back to the home page.</p>
          <a className="btn" href="/">Back to home</a>
        </div>
      </div>
    );
  }
}

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="QueueLess home">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#FF5A1F" />
        <path d="M9 16h14M17 10l6 6-6 6" stroke="#14110F" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>QueueLess</span>
    </Link>
  );
}

function Nav() {
  const { user, logout } = useAuth();
  return (
    <header className="site-header">
      <div className="container nav">
        <Brand />
        <nav aria-label="Main">
          <NavLink to="/" end>Join a queue</NavLink>
          {user && <NavLink to="/staff" end>Staff</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
          {user ? (
            <button className="linklike" onClick={logout}>Sign out ({user.username})</button>
          ) : (
            <NavLink to="/staff/login">Staff sign in</NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}

function Protected({ role, children }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="container"><p className="muted" role="status">Checking your session...</p></div>;
  if (!user) return <Navigate to="/staff/login" replace />;
  if (role && user.role !== role) {
    return (
      <div className="container narrow">
        <div className="card notice error" role="alert">
          <h1 className="h2">Admin access required</h1>
          <p>Your account ({user.role}) cannot open this page. The server enforces this too.</p>
          <Link className="btn" to="/staff">Back to the staff dashboard</Link>
        </div>
      </div>
    );
  }
  return children;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    probe('/auth/me').then((r) => { setUser(r.ok ? r.body.user : null); setReady(true); });
  }, []);

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* cookie is cleared server-side when reachable */ }
    setUser(null);
    navigate('/');
  };

  return (
    <AuthCtx.Provider value={{ user, setUser, ready, logout }}>
      <a href="#main" className="skip">Skip to content</a>
      <Nav />
      <main id="main">
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/ticket/:id" element={<Ticket />} />
          <Route path="/staff/login" element={<StaffLogin />} />
          <Route path="/staff" element={<Protected><StaffDashboard /></Protected>} />
          <Route path="/admin" element={<Protected role="admin"><Admin /></Protected>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </ErrorBoundary>
      </main>
      <footer className="site-footer">
        <div className="container">QueueLess - college demo project. Demo counters are fictional.</div>
      </footer>
    </AuthCtx.Provider>
  );
}
