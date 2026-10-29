import { useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../hooks.js';
import SecurityDemo from '../components/SecurityDemo.jsx';

function ServiceForm({ onCreated }) {
  const [f, setF] = useState({ name: '', description: '', prefix: '', avgMinutes: 5 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api('/admin/services', { method: 'POST', body: { name: f.name, description: f.description, prefix: f.prefix.toUpperCase(), avgMinutes: Number(f.avgMinutes) } });
      setF({ name: '', description: '', prefix: '', avgMinutes: 5 });
      onCreated();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };
  return (
    <form className="card form grid-form" onSubmit={submit} noValidate>
      <h3 className="h3 span-all">Add a counter</h3>
      <div><label htmlFor="sn">Name</label><input id="sn" value={f.name} onChange={set('name')} maxLength={40} required /></div>
      <div><label htmlFor="sp">Token prefix (1-3 letters)</label><input id="sp" value={f.prefix} onChange={set('prefix')} maxLength={3} required /></div>
      <div><label htmlFor="sd">Description</label><input id="sd" value={f.description} onChange={set('description')} maxLength={120} /></div>
      <div><label htmlFor="sa">Avg. minutes per customer</label><input id="sa" type="number" min="1" max="60" value={f.avgMinutes} onChange={set('avgMinutes')} required /></div>
      {error && <p className="error-text span-all" role="alert">{error}</p>}
      <div className="span-all"><button className="btn" disabled={busy}>{busy ? 'Adding...' : 'Add counter'}</button></div>
    </form>
  );
}

export default function Admin() {
  const summary = usePolling('/admin/summary', 5000);
  const security = usePolling('/admin/security', 60000);
  const [error, setError] = useState(null);
  const d = summary.data;

  const toggle = async (s) => {
    setError(null);
    try { await api(`/admin/services/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }); await summary.reload(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="container">
      <p className="eyebrow">Admin</p>
      <h1 className="display sm">Overview</h1>
      {summary.error && !d && <div className="card notice error" role="alert">{summary.error.message}</div>}
      {summary.loading && <p className="muted" role="status">Loading...</p>}
      {d && (
        <>
          <dl className="stats cards">
            {Object.entries(d.totals).map(([k, v]) => (
              <div className="card" key={k}><dt>{k[0].toUpperCase() + k.slice(1)}</dt><dd>{v}</dd></div>
            ))}
          </dl>

          <h2 className="h2">Service counters</h2>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Service counters</caption>
              <thead><tr><th scope="col">Counter</th><th scope="col">Prefix</th><th scope="col">Waiting</th><th scope="col">Served</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {d.services.map((s) => (
                  <tr key={s.id}>
                    <td className="strong">{s.name}</td>
                    <td className="mono">{s.prefix}</td>
                    <td>{s.counts.waiting}</td>
                    <td>{s.counts.served}</td>
                    <td><span className={`badge ${s.enabled ? 'badge-called' : 'badge-cancelled'}`}>{s.enabled ? 'Open' : 'Closed'}</span></td>
                    <td><button className="btn small ghost" onClick={() => toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ServiceForm onCreated={summary.reload} />
        </>
      )}

      <section aria-labelledby="sec-h" className="security">
        <h2 id="sec-h" className="h2">Security &amp; Safety</h2>
        {security.data && (
          <ul className="plain grid-2">
            {security.data.protections.map((p) => (
              <li key={p.id} className="card"><h3 className="h4"><span className="dot" aria-hidden="true" /> {p.name}</h3><p className="small">{p.detail}</p></li>
            ))}
          </ul>
        )}
        <h3 className="h3">Live demonstrations</h3>
        <SecurityDemo />
      </section>
    </div>
  );
}
