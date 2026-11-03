import { useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../hooks.js';

export default function UsersPanel() {
  const { data, error, reload } = usePolling('/admin/users', 8000);
  const [f, setF] = useState({ username: '', password: '', group: 'staff' });
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try {
      const { user } = await api('/admin/users', { method: 'POST', body: f });
      setMsg(`User "${user.username}" saved to the database in the ${user.group} group.`);
      setF({ username: '', password: '', group: 'staff' });
      await reload();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };

  return (
    <section aria-labelledby="usr-h">
      <h2 id="usr-h" className="h2">Users &amp; groups</h2>
      {error && !data && <p className="error-text" role="alert">{error.message}</p>}
      {data && (
        <>
          <dl className="stats cards">
            <div className="card"><dt>Admin group</dt><dd>{data.groups.admin}</dd></div>
            <div className="card"><dt>Staff group</dt><dd>{data.groups.staff}</dd></div>
            <div className="card"><dt>Customers (anonymous)</dt><dd>{data.groups.customer}</dd></div>
          </dl>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Staff and admin users</caption>
              <thead><tr><th scope="col">ID</th><th scope="col">Username</th><th scope="col">Group</th><th scope="col">Created</th></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td className="mono muted">{u.id}</td>
                    <td className="strong">{u.username}</td>
                    <td><span className={`badge ${u.group === 'admin' ? 'badge-served' : 'badge-called'}`}>{u.group}</span></td>
                    <td className="mono muted">{u.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <form className="card form grid-form" onSubmit={submit} noValidate>
        <h3 className="h3 span-all">Add a user</h3>
        <div><label htmlFor="nu">Username</label><input id="nu" value={f.username} onChange={set('username')} maxLength={32} autoComplete="off" required /></div>
        <div><label htmlFor="np">Password (12+ characters)</label><input id="np" type="password" value={f.password} onChange={set('password')} maxLength={128} autoComplete="new-password" required /></div>
        <div><label htmlFor="ng">Group</label>
          <select id="ng" value={f.group} onChange={set('group')}><option value="staff">staff</option><option value="admin">admin</option></select></div>
        {err && <p className="error-text span-all" role="alert">{err}</p>}
        {msg && <p className="span-all" role="status"><strong>{msg}</strong></p>}
        <div className="span-all"><button className="btn" disabled={busy || !f.username || !f.password}>{busy ? 'Saving...' : 'Add user'}</button></div>
      </form>
    </section>
  );
}
