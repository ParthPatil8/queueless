import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { usePolling } from '../hooks.js';
import StatusBadge from '../components/StatusBadge.jsx';

const MESSAGES = {
  waiting: 'You are in the queue. Keep this page open or come back to it - your place is saved.',
  called: 'It is your turn. Please go to the counter now.',
  served: 'You have been served. Thank you!',
  skipped: 'Your token was skipped by staff. You can join the queue again.',
  cancelled: 'You cancelled this token. You can join the queue again.',
};

export default function Ticket() {
  const { id } = useParams();
  const { data, error, loading, reload } = usePolling(`/tickets/${id}`, 3000);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const t = data?.ticket;

  const cancel = async () => {
    setBusy(true); setActionError(null);
    try { await api(`/tickets/${id}/cancel`, { method: 'POST' }); setConfirming(false); await reload(); }
    catch (e) { setActionError(e.message); }
    setBusy(false);
  };

  if (loading) return <div className="container narrow"><p className="muted" role="status">Loading your token...</p></div>;
  if (error && !t) {
    return (
      <div className="container narrow">
        <div className="card notice error" role="alert">
          <h1 className="h2">{error.status === 404 ? 'Token not found' : 'Something went wrong'}</h1>
          <p>{error.status === 404 ? 'This token does not exist, or it belongs to a different device or browser.' : error.message}</p>
          <Link className="btn" to="/">Back to home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container narrow">
      <p className="eyebrow">{t.serviceName}</p>
      <div className="card ticket">
        <div className="ticket-top">
          <span className="muted">Your token</span>
          <StatusBadge status={t.status} />
        </div>
        <div className="token-number mono" aria-label={`Token ${t.label}`}>{t.label}</div>
        <p className="lead" role="status" aria-live="polite">{MESSAGES[t.status]}</p>

        {t.status === 'waiting' && (
          <dl className="stats big">
            <div><dt>People ahead</dt><dd>{t.peopleAhead}</dd></div>
            <div><dt>Est. wait</dt><dd>{t.peopleAhead === 0 ? 'You are next' : `~${t.estimatedWaitMinutes} min`}</dd></div>
            <div><dt>Now serving</dt><dd className="mono">{t.nowServing || '-'}</dd></div>
          </dl>
        )}
        {error && <p className="error-text" role="alert">Connection problem: {error.message} Retrying...</p>}
        {actionError && <p className="error-text" role="alert">{actionError}</p>}

        {t.status === 'waiting' && (confirming ? (
          <div className="row">
            <button className="btn danger" onClick={cancel} disabled={busy}>{busy ? 'Cancelling...' : 'Yes, cancel my token'}</button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>Keep my place</button>
          </div>
        ) : (
          <button className="btn ghost" onClick={() => setConfirming(true)}>Cancel my token</button>
        ))}
        {['served', 'skipped', 'cancelled'].includes(t.status) && <Link className="btn" to="/">Back to counters</Link>}
        <p className="muted small">Estimates use the counter's average service time and update automatically every few seconds.</p>
      </div>
    </div>
  );
}
