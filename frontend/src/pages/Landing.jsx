import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiFailure } from '../api.js';
import { usePolling } from '../hooks.js';
import StatusBadge from '../components/StatusBadge.jsx';

function JoinForm({ service, onCancel }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { serviceId: service.id };
      if (name.trim()) body.displayName = name.trim();
      const { ticket } = await api('/tickets', { method: 'POST', body });
      navigate(`/ticket/${ticket.id}`);
    } catch (err) {
      setError(err instanceof ApiFailure ? err : new ApiFailure(0, 'error', 'Something went wrong.'));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="join-form" noValidate>
      <label htmlFor={`name-${service.id}`}>Your first name <span className="muted">(optional, shown to staff)</span></label>
      <input id={`name-${service.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoComplete="given-name" placeholder="e.g. Asha" />
      {error && (
        <p className="error-text" role="alert">
          {error.message}{' '}
          {error.data?.ticketId && <Link to={`/ticket/${error.data.ticketId}`}>View your token</Link>}
        </p>
      )}
      <div className="row">
        <button className="btn" disabled={busy}>{busy ? 'Getting your token...' : 'Get my token'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function MyTickets() {
  const { data } = usePolling('/tickets/mine', 6000);
  const active = (data?.tickets || []).filter((t) => t.status === 'waiting' || t.status === 'called');
  if (!active.length) return null;
  return (
    <section className="container" aria-labelledby="mine-h">
      <h2 id="mine-h" className="h2">Your active tokens</h2>
      <ul className="plain grid-2">
        {active.map((t) => (
          <li key={t.id} className="card row between">
            <div>
              <strong className="mono big-label">{t.label}</strong>
              <div className="muted">{t.serviceName}</div>
            </div>
            <div className="right">
              <StatusBadge status={t.status} />
              <div><Link to={`/ticket/${t.id}`}>Open</Link></div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Landing() {
  const { data, error, loading, reload } = usePolling('/services', 5000);
  const [selected, setSelected] = useState(null);
  const services = data?.services || [];

  return (
    <>
      <section className="container hero">
        <div>
          <p className="eyebrow">Smart queue management</p>
          <h1 className="display">Skip the physical line. Keep your place digitally.</h1>
          <p className="lead">Join a counter's queue from your phone, watch your position in real time, and walk up only when you are called.</p>
          <a className="btn large" href="#services">Join a queue</a>
        </div>
        <svg className="hero-art" viewBox="0 0 320 260" role="img" aria-label="Illustration of tokens moving through a queue">
          <rect x="8" y="30" width="304" height="200" rx="24" fill="#fff" stroke="#14110F" strokeWidth="2" />
          {[0, 1, 2].map((i) => (
            <g key={i} transform={`translate(${28 + i * 94} 62)`}>
              <rect width="82" height="116" rx="14" fill={i === 0 ? '#FF5A1F' : '#F4EDE2'} stroke="#14110F" strokeWidth="2" />
              <text x="41" y="52" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="20" fontWeight="700" fill="#14110F">{['G-014', 'G-015', 'G-016'][i]}</text>
              <text x="41" y="78" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="11" fill="#14110F">{['NOW', 'NEXT', 'WAIT'][i]}</text>
            </g>
          ))}
          <path d="M28 205h264" stroke="#14110F" strokeWidth="2" strokeDasharray="2 8" strokeLinecap="round" />
        </svg>
      </section>

      <section id="services" className="container" aria-labelledby="svc-h">
        <h2 id="svc-h" className="h2">Choose a counter</h2>
        {loading && <p className="muted" role="status">Loading counters...</p>}
        {error && (
          <div className="card notice error" role="alert">
            <p>{error.message}</p>
            <button className="btn ghost" onClick={reload}>Try again</button>
          </div>
        )}
        {!loading && !error && services.length === 0 && (
          <div className="card empty"><p>No counters are open right now. Please check back soon.</p></div>
        )}
        <ul className="plain grid-3">
          {services.map((s) => (
            <li key={s.id} className={`card service ${selected === s.id ? 'selected' : ''}`}>
              <h3 className="h3">{s.name}</h3>
              <p className="muted">{s.description}</p>
              <dl className="stats">
                <div><dt>Waiting</dt><dd>{s.counts.waiting}</dd></div>
                <div><dt>Est. wait</dt><dd>{s.estimatedWaitMinutes} min</dd></div>
                <div><dt>Now serving</dt><dd className="mono">{s.nowServing || '-'}</dd></div>
              </dl>
              {selected === s.id
                ? <JoinForm service={s} onCancel={() => setSelected(null)} />
                : <button className="btn" onClick={() => setSelected(s.id)} aria-label={`Join the ${s.name} queue`}>Join this queue</button>}
            </li>
          ))}
        </ul>
      </section>

      <MyTickets />

      <section className="container how" aria-labelledby="how-h">
        <h2 id="how-h" className="h2">How it works</h2>
        <ol className="plain grid-3 steps">
          <li><span className="step-n">1</span><h3 className="h3">Join</h3><p>Pick a counter and get a unique token. No account needed.</p></li>
          <li><span className="step-n">2</span><h3 className="h3">Watch</h3><p>See people ahead and an estimated wait, updated automatically.</p></li>
          <li><span className="step-n">3</span><h3 className="h3">Get called</h3><p>When your status changes to Called, head to the counter.</p></li>
        </ol>
      </section>
    </>
  );
}
