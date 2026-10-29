import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../hooks.js';
import StatusBadge from '../components/StatusBadge.jsx';

export default function StaffDashboard() {
  const overview = usePolling('/staff/overview', 5000);
  const services = overview.data?.services || [];
  const [serviceId, setServiceId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (serviceId === null && services.length) setServiceId(services[0].id);
  }, [services, serviceId]);

  const queue = usePolling(serviceId ? `/staff/queue/${serviceId}` : '/health', 3000);
  const q = serviceId ? queue.data : null;

  const act = async (path) => {
    setBusy(true); setActionError(null);
    try { await api(path, { method: 'POST' }); }
    catch (e) { setActionError(e.message); }
    await Promise.all([queue.reload(), overview.reload()]);
    setBusy(false);
  };

  return (
    <div className="container">
      <p className="eyebrow">Staff dashboard</p>
      <h1 className="display sm">Manage the queue</h1>
      {overview.error && <div className="card notice error" role="alert">{overview.error.message}</div>}
      {overview.loading && <p className="muted" role="status">Loading counters...</p>}

      <div className="tabs" role="tablist" aria-label="Counters">
        {services.map((s) => (
          <button key={s.id} role="tab" aria-selected={s.id === serviceId} className={`tab ${s.id === serviceId ? 'active' : ''}`}
            onClick={() => { setServiceId(s.id); setActionError(null); }}>
            {s.name}{!s.enabled && ' (closed)'} <span className="pill">{s.counts.waiting}</span>
          </button>
        ))}
      </div>

      {q && (
        <>
          <dl className="stats cards">
            <div className="card"><dt>Waiting</dt><dd>{q.service.counts.waiting}</dd></div>
            <div className="card"><dt>Called</dt><dd>{q.service.counts.called}</dd></div>
            <div className="card"><dt>Served</dt><dd>{q.service.counts.served}</dd></div>
            <div className="card"><dt>Skipped</dt><dd>{q.service.counts.skipped}</dd></div>
            <div className="card"><dt>Cancelled</dt><dd>{q.service.counts.cancelled}</dd></div>
          </dl>

          <div className="row between wrap">
            <h2 className="h2">Active queue - {q.service.name}</h2>
            <button className="btn large" disabled={busy || q.service.counts.waiting === 0} onClick={() => act(`/staff/services/${q.service.id}/call-next`)}>
              Call next
            </button>
          </div>
          <div aria-live="polite">{actionError && <p className="error-text" role="alert">{actionError}</p>}</div>

          {q.tickets.length === 0 ? (
            <div className="card empty"><p>The queue is empty. New tokens will appear here automatically.</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Active tokens for {q.service.name}</caption>
                <thead><tr><th scope="col">Token</th><th scope="col">Name</th><th scope="col">Ref</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {q.tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono strong">{t.label}</td>
                      <td>{t.displayName}</td>
                      <td className="mono muted">{t.customerRef}</td>
                      <td><StatusBadge status={t.status} /></td>
                      <td className="row">
                        {t.status === 'called' && <button className="btn small" disabled={busy} onClick={() => act(`/staff/tickets/${t.id}/serve`)}>Mark served</button>}
                        <button className="btn small ghost" disabled={busy} onClick={() => act(`/staff/tickets/${t.id}/skip`)}>Skip</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
