import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

export default function StaffLogin() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/staff" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { user: u } = await api('/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      setUser(u);
      navigate(u.role === 'admin' ? '/admin' : '/staff');
    } catch (err) {
      setError(err.status === 429 ? `${err.message}` : err.message);
      setBusy(false);
    }
  };

  return (
    <div className="container narrow">
      <p className="eyebrow">Staff and admin</p>
      <h1 className="display sm">Sign in</h1>
      <form className="card form" onSubmit={submit} noValidate>
        <label htmlFor="username">Username</label>
        <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" maxLength={32} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={128} required />
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn" disabled={busy || !username || !password}>{busy ? 'Signing in...' : 'Sign in'}</button>
        {import.meta.env.DEV && (
          <p className="muted small">Local demo only: <span className="mono">staff / Staff#Demo2026</span> or <span className="mono">admin / Admin#Demo2026</span>. This hint is removed from production builds.</p>
        )}
      </form>
    </div>
  );
}
