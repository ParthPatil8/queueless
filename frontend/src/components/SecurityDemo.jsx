import { useState } from 'react';
import { probe } from '../api.js';

// Every check sends REAL requests to the REAL backend. PASS is computed from the HTTP status the server returned.
const demoBody = (serviceId) => ({ serviceId, displayName: 'Security Demo' });

async function firstServiceId() {
  const r = await probe('/services');
  return r.ok && r.body.services[0] ? r.body.services[0].id : null;
}
// Create a disposable waiting token (or reuse an existing active one, if this browser already has one).
async function demoTicket(serviceId) {
  const r = await probe('/tickets', { method: 'POST', body: demoBody(serviceId) });
  if (r.status === 201) return { id: r.body.ticket.id, created: true, first: r };
  if (r.status === 409 && r.data?.ticketId) return { id: r.data.ticketId, created: false, first: r };
  return { id: null, created: false, first: r };
}
const cleanup = (t) => t.created && probe(`/tickets/${t.id}/cancel`, { method: 'POST' });
const show = (r) => `${r.status} ${r.code || 'OK'}`;

const CHECKS = [
  {
    id: 'unauth', title: '1. Anonymous request to a staff endpoint', expect: '401 unauthenticated',
    how: 'GET /api/staff/overview with no cookies.',
    run: async () => { const r = await probe('/staff/overview', { credentials: 'omit' }); return { pass: r.status === 401, got: show(r), note: r.message }; },
  },
  {
    id: 'customer', title: '2. Customer attempts a staff-only operation', expect: '403 forbidden',
    how: 'POST /api/staff/services/:id/call-next as a customer session (staff privileges dropped for this request).',
    run: async () => {
      await probe('/customer/session', { method: 'POST' });
      const sid = (await firstServiceId()) ?? 1;
      const r = await probe(`/staff/services/${sid}/call-next`, { method: 'POST', headers: { 'X-Act-As-Customer': '1' } });
      return { pass: r.status === 403, got: show(r), note: r.message };
    },
  },
  {
    id: 'invalid', title: '3. Invalid / malicious input', expect: '400 invalid_input',
    how: 'POST /api/tickets with serviceId "1; DROP TABLE tickets" and a <script> display name.',
    run: async () => {
      const r = await probe('/tickets', { method: 'POST', body: { serviceId: '1; DROP TABLE tickets', displayName: '<script>alert(1)</script>' } });
      return { pass: r.status === 400, got: show(r), note: r.message };
    },
  },
  {
    id: 'ratelimit', title: '4. Repeated failed logins are rate limited', expect: '401 x5, then 429',
    how: '8 wrong-password logins for a throw-away username (only that username is locked, for about a minute).',
    run: async () => {
      const seen = [];
      for (let i = 0; i < 8; i++) {
        const r = await probe('/auth/login', { method: 'POST', credentials: 'omit', body: { username: 'ratelimit-demo', password: `wrong-${i}` } });
        seen.push(r.status);
      }
      const first429 = seen.indexOf(429);
      const pass = first429 !== -1 && seen.slice(0, first429).every((x) => x === 401);
      const note = first429 > 0 ? `Locked out after ${first429} failed attempts.`
        : first429 === 0 ? 'This username was already locked out by an earlier run (rate limiting is active). Wait about a minute to see the 401 then 429 sequence again.'
        : 'No 429 seen, so rate limiting did not trigger.';
      return { pass, got: seen.join(', '), note };
    },
  },
  {
    id: 'duplicate', title: '5. Duplicate active token is rejected', expect: '409 duplicate_active_token',
    how: 'Request a token for the same counter twice with the same customer session.',
    run: async () => {
      const sid = await firstServiceId();
      if (!sid) return { pass: false, got: 'no counter', note: 'No open counters to test with.' };
      const t = await demoTicket(sid);
      if (!t.id) return { pass: false, got: show(t.first), note: t.first.message };
      const again = await probe('/tickets', { method: 'POST', body: demoBody(sid) });
      await cleanup(t);
      return { pass: again.status === 409 && again.code === 'duplicate_active_token', got: show(again), note: again.message };
    },
  },
  {
    id: 'transition', title: '6. Invalid queue-state transition is rejected', expect: '409 invalid_transition',
    how: 'As signed-in staff, try to mark a token that is still waiting as served (waiting -> served is not allowed).',
    run: async () => {
      const sid = await firstServiceId();
      if (!sid) return { pass: false, got: 'no counter', note: 'No open counters to test with.' };
      const t = await demoTicket(sid);
      if (!t.id) return { pass: false, got: show(t.first), note: t.first.message };
      const cur = await probe(`/tickets/${t.id}`);
      if (cur.body?.ticket?.status !== 'waiting') { await cleanup(t); return { pass: false, got: 'skipped', note: 'This browser already holds a token that is not waiting; cancel it and re-run.' }; }
      const r = await probe(`/staff/tickets/${t.id}/serve`, { method: 'POST' });
      await cleanup(t);
      return { pass: r.status === 409 && r.code === 'invalid_transition', got: show(r), note: r.message };
    },
  },
];

export default function SecurityDemo() {
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(null);

  const runOne = async (c) => {
    setRunning(c.id);
    try { const out = await c.run(); setResults((r) => ({ ...r, [c.id]: out })); }
    catch { setResults((r) => ({ ...r, [c.id]: { pass: false, got: 'error', note: 'Could not reach the server.' } })); }
    setRunning(null);
  };
  const runAll = async () => { for (const c of CHECKS) await runOne(c); };

  return (
    <div>
      <div className="row between wrap">
        <p className="muted">Each check sends real requests to this server. The result shows the actual HTTP status returned, and PASS means the server refused the request as expected.</p>
        <button className="btn" onClick={runAll} disabled={running !== null}>{running ? 'Running...' : 'Run all checks'}</button>
      </div>
      <ul className="plain checks">
        {CHECKS.map((c) => {
          const r = results[c.id];
          return (
            <li key={c.id} className="card check">
              <div className="row between wrap">
                <div>
                  <h4 className="h4">{c.title}</h4>
                  <p className="muted small">{c.how}</p>
                  <p className="small">Expected: <span className="mono">{c.expect}</span></p>
                </div>
                <button className="btn small ghost" onClick={() => runOne(c)} disabled={running !== null}>{running === c.id ? 'Running...' : 'Run'}</button>
              </div>
              {r && (
                <p className={`result ${r.pass ? 'pass' : 'fail'}`} role="status">
                  <strong>{r.pass ? 'PASS' : 'FAIL'}</strong> - server returned <span className="mono">{r.got}</span>{r.note ? `. ${r.note}` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
