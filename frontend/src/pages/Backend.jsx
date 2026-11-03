import { useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../hooks.js';

const show = (v) => (v === null || v === undefined ? '-' : String(v));


function CloudPanel() {
  const { data, error } = usePolling('/admin/cloud', 10000);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const backup = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api('/admin/backup', { method: 'POST' })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const yn = (v) => (v ? 'Yes' : 'No');
  return (
    <>
      <h2 className="h2">Cloud &amp; infrastructure</h2>
      {error && !data && <p className="error-text" role="alert">{error.message}</p>}
      {data && (
        <dl className="stats cards">
          <div className="card"><dt>Database engine</dt><dd>{data.database.engine}</dd></div>
          <div className="card"><dt>In a container</dt><dd>{yn(data.container)}</dd></div>
          <div className="card"><dt>S3 backups</dt><dd>{data.s3.configured ? 'Configured' : 'Not set'}</dd></div>
          <div className="card"><dt>Production mode</dt><dd>{yn(data.runtime.production)}</dd></div>
          <div className="card"><dt>Secure cookies</dt><dd>{yn(data.runtime.secureCookies)}</dd></div>
          <div className="card"><dt>HTTPS redirect</dt><dd>{yn(data.runtime.forceHttps)}</dd></div>
        </dl>
      )}
      <div className="row wrap">
        <button className="btn" onClick={backup} disabled={busy}>{busy ? 'Backing up...' : 'Back up database to S3'}</button>
        {data?.s3.configured && <span className="muted small">Bucket: <span className="mono">{data.s3.bucket}</span> ({data.s3.region})</span>}
      </div>
      <div aria-live="polite">
        {res && <p role="status"><strong>Saved s3://{res.bucket}/{res.key}</strong> ({res.bytes} bytes)</p>}
        {err && <p className="error-text" role="alert">{err}</p>}
      </div>
    </>
  );
}

export default function Backend() {
  const [reveal, setReveal] = useState(false);
  const [all, setAll] = useState(false);
  const dbq = usePolling(`/admin/database?reveal=${reveal ? 1 : 0}&limit=${all ? 1000 : 50}`, 3000);
  const log = usePolling('/admin/audit', 3000);
  const [tab, setTab] = useState('users');
  const tables = dbq.data?.tables || [];
  const t = tables.find((x) => x.name === tab) || tables[0];

  return (
    <div className="container">
      <p className="eyebrow">Admin</p>
      <h1 className="display sm">Backend &amp; database (live)</h1>
      <p className="lead">A read-only view of the real database and the security log. Refreshes every 3 seconds. Passwords are never stored in plain text: only bcrypt hashes. Hashes are shortened unless you reveal them.</p>

      <CloudPanel />

      <h2 className="h2">Database tables</h2>
      {dbq.error && !dbq.data && <p className="error-text" role="alert">{dbq.error.message}</p>}
      {dbq.data?.passwordAudit && (
        <div className={`card notice ${dbq.data.passwordAudit.allHashed ? '' : 'error'}`} role="status">
          <strong>{dbq.data.passwordAudit.allHashed ? 'Password storage check: PASS' : 'Password storage check: FAIL'}</strong>
          {' '}- {dbq.data.passwordAudit.bcryptHashed} of {dbq.data.passwordAudit.users} user passwords are stored as {dbq.data.passwordAudit.algorithm} hashes (cost {dbq.data.passwordAudit.cost}). Customers have no password; their browser token is stored as a SHA-256 hash.
        </div>
      )}
      <div className="row wrap" style={{ margin: '14px 0' }}>
        <label className="inline-check"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Reveal full hashes (logged in the audit log)</label>
        <label className="inline-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all rows (up to 1000)</label>
      </div>
      <div className="tabs" role="tablist" aria-label="Database tables">
        {tables.map((x) => (
          <button key={x.name} role="tab" aria-selected={t?.name === x.name} className={`tab ${t?.name === x.name ? 'active' : ''}`} onClick={() => setTab(x.name)}>
            {x.name} <span className="pill">{x.total}</span>
          </button>
        ))}
      </div>
      {t && (t.rows.length === 0 ? (
        <div className="card empty"><p>Table <span className="mono">{t.name}</span> is empty.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Rows of table {t.name}</caption>
            <thead><tr>{t.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={`mono small${String(v).length > 40 ? ' hashcell' : ''}`}>{show(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ))}
      {t && <p className="muted small">Showing {t.rows.length} of {t.total} rows (newest first).</p>}

      <h2 className="h2">Security &amp; activity log</h2>
      <p className="muted">Every action below is also printed on the server console (look for <span className="mono">[AUDIT]</span> in the terminal or Render Logs).</p>
      {log.data && log.data.events.length === 0 && <div className="card empty"><p>No events yet.</p></div>}
      {log.data && log.data.events.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Security and activity log</caption>
            <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Result</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Detail</th><th scope="col">IP</th></tr></thead>
            <tbody>
              {log.data.events.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">{e.ts}</td>
                  <td><span className={`badge ${e.outcome === 'ok' ? 'badge-called' : 'badge-skipped'}`}>{e.outcome === 'ok' ? 'allowed' : 'BLOCKED'}</span></td>
                  <td className="mono small strong">{e.event}</td>
                  <td className="mono small">{e.actor}</td>
                  <td className="small">{e.detail}</td>
                  <td className="mono small muted">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
