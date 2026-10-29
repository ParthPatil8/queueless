import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isUniqueViolation } from './db.js';
import { ApiError, onlyKeys, id as vId, text, NAME_RE, int, bool } from './validate.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const label = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing similar for unknown users

// Allowed status transitions. The server is the only place these rules live.
const TRANSITIONS = {
  waiting: ['called', 'skipped', 'cancelled'],
  called: ['served', 'skipped'],
  served: [], skipped: [], cancelled: [],
};

export function createApp({
  db, isProd = false, allowedOrigins = [], distDir = null,
  loginMax = 5, loginWindowMs = 60_000, tokenMax = 20, tokenWindowMs = 60_000, apiMax = 300,
}) {
  const app = express();
  app.disable('x-powered-by');
  if (isProd) app.set('trust proxy', 1); // hosting platforms sit behind one proxy

  app.use(helmet({
    contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': isProd ? [] : null } },
  }));
  // CORS: closed by default (same-origin deployment). Only listed origins are allowed.
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const limited = (code, message) => (req, res) =>
    res.status(429).json({ error: { code, message } });

  app.use('/api', rateLimit({
    windowMs: 60_000, limit: apiMax, standardHeaders: true, legacyHeaders: false,
    handler: limited('rate_limited', 'Too many requests. Please slow down.'),
  }));
  // Login: counts FAILED attempts per IP + username, so a demo lock-out never blocks other accounts.
  const loginLimiter = rateLimit({
    windowMs: loginWindowMs, limit: loginMax, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${req.ip}|${String(req.body?.username ?? '').toLowerCase().slice(0, 32)}`,
    handler: limited('rate_limited', 'Too many login attempts. Wait a minute and try again.'),
  });
  const tokenLimiter = rateLimit({
    windowMs: tokenWindowMs, limit: tokenMax, standardHeaders: true, legacyHeaders: false,
    handler: limited('rate_limited', 'Too many token requests. Please wait a moment.'),
  });

  // CSRF defence-in-depth: browsers always send Origin on cross-site POSTs; it must be ours or allow-listed.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const own = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== own && !allowedOrigins.includes(origin))
      return next(new ApiError(403, 'bad_origin', 'Request origin is not allowed.'));
    next();
  });

  // ---------- sessions ----------
  const STAFF_COOKIE = 'ql_staff', CUST_COOKIE = 'ql_cust';
  const cookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: isProd, path: '/', maxAge });

  app.use('/api', (req, res, next) => {
    req.staff = null; req.customer = null;
    const st = req.cookies?.[STAFF_COOKIE];
    if (typeof st === 'string' && st.length === 64) {
      req.staff = db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(st), Date.now()) ?? null;
    }
    const ct = req.cookies?.[CUST_COOKIE];
    if (typeof ct === 'string' && ct.length === 64) {
      req.customer = db.prepare('SELECT id, ref FROM customers WHERE token_hash = ?').get(sha256(ct)) ?? null;
    }
    // Privilege can only be REDUCED by this header (used by the Security demo to act as a customer).
    if (req.get('x-act-as-customer') === '1') req.staff = null;
    next();
  });

  const requireRole = (...roles) => (req, res, next) => {
    if (req.staff && roles.includes(req.staff.role)) return next();
    if (req.staff || req.customer) return next(new ApiError(403, 'forbidden', 'You do not have permission for this action.'));
    next(new ApiError(401, 'unauthenticated', 'Please sign in.'));
  };
  const staffOnly = requireRole('staff', 'admin');
  const adminOnly = requireRole('admin');

  function ensureCustomer(req, res) {
    if (req.customer) return req.customer;
    const token = randomToken();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const ref = 'C-' + Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
    const info = db.prepare('INSERT INTO customers (ref, token_hash) VALUES (?,?)').run(ref, sha256(token));
    res.cookie(CUST_COOKIE, token, cookieOpts(30 * 24 * 3600 * 1000));
    req.customer = { id: info.lastInsertRowid, ref };
    return req.customer;
  }

  // ---------- helpers ----------
  const getService = (sid) => db.prepare('SELECT * FROM services WHERE id = ?').get(sid);
  const serviceStats = (s) => {
    const c = db.prepare(`SELECT status, COUNT(*) n FROM tickets WHERE service_id = ? GROUP BY status`).all(s.id);
    const counts = { waiting: 0, called: 0, served: 0, skipped: 0, cancelled: 0 };
    for (const r of c) counts[r.status] = r.n;
    const now = db.prepare(`SELECT number FROM tickets WHERE service_id = ? AND status = 'called'
      ORDER BY updated_at DESC, id DESC LIMIT 1`).get(s.id);
    return {
      id: s.id, name: s.name, description: s.description, prefix: s.prefix, avgMinutes: s.avg_minutes,
      enabled: !!s.enabled, counts, nowServing: now ? label(s.prefix, now.number) : null,
      estimatedWaitMinutes: counts.waiting * s.avg_minutes,
    };
  };
  const ticketView = (t) => {
    const s = getService(t.service_id);
    let peopleAhead = null, est = null;
    if (t.status === 'waiting') {
      peopleAhead = db.prepare(`SELECT COUNT(*) n FROM tickets WHERE service_id = ? AND status = 'waiting' AND number < ?`)
        .get(t.service_id, t.number).n;
      est = peopleAhead * s.avg_minutes;
    }
    const now = db.prepare(`SELECT number FROM tickets WHERE service_id = ? AND status = 'called'
      ORDER BY updated_at DESC, id DESC LIMIT 1`).get(t.service_id);
    return {
      id: t.id, label: label(s.prefix, t.number), serviceId: s.id, serviceName: s.name, status: t.status,
      displayName: t.display_name, createdAt: t.created_at, updatedAt: t.updated_at,
      peopleAhead, estimatedWaitMinutes: est, nowServing: now ? label(s.prefix, now.number) : null,
    };
  };

  // The ONLY place ticket status changes. Checks the rule table AND guards the UPDATE with the expected old status.
  const transition = (ticketId, to, allowedFrom) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!t) throw new ApiError(404, 'not_found', 'Token not found.');
    if (!allowedFrom.includes(t.status) || !TRANSITIONS[t.status].includes(to))
      throw new ApiError(409, 'invalid_transition', `A ${t.status} token cannot become ${to}.`);
    const r = db.prepare(`UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`)
      .run(to, ticketId, t.status);
    if (r.changes !== 1) throw new ApiError(409, 'invalid_transition', 'Token changed state; refresh and try again.');
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  };

  // ---------- public ----------
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });

  app.get('/api/services', (req, res) => {
    const rows = db.prepare('SELECT * FROM services WHERE enabled = 1 ORDER BY id').all();
    res.json({ services: rows.map(serviceStats) });
  });

  // ---------- auth ----------
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    onlyKeys(req.body, ['username', 'password']);
    const username = text(req.body.username, 'Username', { min: 3, max: 32, pattern: /^[A-Za-z0-9_.-]+$/ });
    if (typeof req.body.password !== 'string' || req.body.password.length < 1 || req.body.password.length > 128)
      throw new ApiError(400, 'invalid_input', 'Password must be 1-128 characters.');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = bcrypt.compareSync(req.body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new ApiError(401, 'bad_credentials', 'Invalid username or password.');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = randomToken();
    const ttl = 8 * 3600 * 1000;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), user.id, Date.now() + ttl);
    res.cookie(STAFF_COOKIE, token, cookieOpts(ttl));
    res.json({ user: { username: user.username, role: user.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const st = req.cookies?.[STAFF_COOKIE];
    if (typeof st === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(st));
    res.clearCookie(STAFF_COOKIE, cookieOpts(0));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', staffOnly, (req, res) => res.json({ user: { username: req.staff.username, role: req.staff.role } }));

  // ---------- customer ----------
  app.post('/api/customer/session', (req, res) => {
    const c = ensureCustomer(req, res);
    res.json({ customerRef: c.ref });
  });

  app.post('/api/tickets', tokenLimiter, (req, res) => {
    onlyKeys(req.body, ['serviceId', 'displayName']);
    const serviceId = vId(req.body.serviceId, 'serviceId');
    const displayName = req.body.displayName === undefined ? 'Guest'
      : text(req.body.displayName, 'Name', { min: 1, max: 30, pattern: NAME_RE });
    const customer = ensureCustomer(req, res);
    const join = db.transaction(() => {
      const s = getService(serviceId);
      if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
      if (!s.enabled) throw new ApiError(409, 'service_disabled', 'This counter is currently closed.');
      const dup = db.prepare(`SELECT id FROM tickets WHERE service_id = ? AND customer_id = ? AND status IN ('waiting','called')`)
        .get(serviceId, customer.id);
      if (dup) { const e = new ApiError(409, 'duplicate_active_token', 'You already have an active token for this counter.'); e.extra = { ticketId: dup.id }; throw e; }
      const number = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 n FROM tickets WHERE service_id = ?').get(serviceId).n;
      const info = db.prepare('INSERT INTO tickets (service_id, customer_id, number, display_name) VALUES (?,?,?,?)')
        .run(serviceId, customer.id, number, displayName);
      return db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
    });
    let t;
    try { t = join.immediate(); } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'duplicate_active_token', 'You already have an active token for this counter.');
      throw e;
    }
    res.status(201).json({ ticket: ticketView(t) });
  });

  app.get('/api/tickets/mine', (req, res) => {
    if (!req.customer) return res.json({ tickets: [] });
    const rows = db.prepare('SELECT * FROM tickets WHERE customer_id = ? ORDER BY id DESC LIMIT 8').all(req.customer.id);
    res.json({ tickets: rows.map(ticketView) });
  });

  const ownTicket = (req) => {
    const tid = vId(req.params.id, 'Token id');
    const t = req.customer && db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(tid, req.customer.id);
    if (!t) throw new ApiError(404, 'not_found', 'Token not found.'); // same answer for "not yours" and "does not exist"
    return t;
  };
  app.get('/api/tickets/:id', (req, res) => res.json({ ticket: ticketView(ownTicket(req)) }));
  app.post('/api/tickets/:id/cancel', (req, res) => {
    const t = ownTicket(req);
    const updated = db.transaction(() => transition(t.id, 'cancelled', ['waiting']))();
    res.json({ ticket: ticketView(updated) });
  });

  // ---------- staff ----------
  app.get('/api/staff/overview', staffOnly, (req, res) => {
    res.json({ services: db.prepare('SELECT * FROM services ORDER BY id').all().map(serviceStats) });
  });

  app.get('/api/staff/queue/:serviceId', staffOnly, (req, res) => {
    const s = getService(vId(req.params.serviceId, 'Service id'));
    if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
    const rows = db.prepare(`SELECT t.*, c.ref FROM tickets t JOIN customers c ON c.id = t.customer_id
      WHERE t.service_id = ? AND t.status IN ('waiting','called') ORDER BY t.number`).all(s.id);
    res.json({
      service: serviceStats(s),
      tickets: rows.map((t) => ({ id: t.id, label: label(s.prefix, t.number), status: t.status,
        displayName: t.display_name, customerRef: t.ref, createdAt: t.created_at })),
    });
  });

  app.post('/api/staff/services/:serviceId/call-next', staffOnly, (req, res) => {
    const s = getService(vId(req.params.serviceId, 'Service id'));
    if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
    const called = db.transaction(() => {
      const next = db.prepare(`SELECT id FROM tickets WHERE service_id = ? AND status = 'waiting' ORDER BY number LIMIT 1`).get(s.id);
      if (!next) throw new ApiError(409, 'queue_empty', 'Nobody is waiting in this queue.');
      return transition(next.id, 'called', ['waiting']);
    }).immediate();
    res.json({ ticket: { id: called.id, label: label(s.prefix, called.number), status: called.status } });
  });

  const staffAction = (to, from) => (req, res) => {
    const tid = vId(req.params.id, 'Token id');
    const t = db.transaction(() => transition(tid, to, from)).immediate();
    const s = getService(t.service_id);
    res.json({ ticket: { id: t.id, label: label(s.prefix, t.number), status: t.status } });
  };
  app.post('/api/staff/tickets/:id/serve', staffOnly, staffAction('served', ['called']));
  app.post('/api/staff/tickets/:id/skip', staffOnly, staffAction('skipped', ['waiting', 'called']));

  // ---------- admin ----------
  app.get('/api/admin/summary', adminOnly, (req, res) => {
    const services = db.prepare('SELECT * FROM services ORDER BY id').all().map(serviceStats);
    const totals = { waiting: 0, called: 0, served: 0, skipped: 0, cancelled: 0 };
    for (const s of services) for (const k of Object.keys(totals)) totals[k] += s.counts[k];
    res.json({ totals, services });
  });

  app.post('/api/admin/services', adminOnly, (req, res) => {
    onlyKeys(req.body, ['name', 'description', 'prefix', 'avgMinutes']);
    const name = text(req.body.name, 'Name', { min: 2, max: 40, pattern: NAME_RE });
    const description = req.body.description === undefined ? '' : text(req.body.description, 'Description', { min: 0, max: 120, pattern: /^[^<>]*$/ });
    const prefix = text(req.body.prefix, 'Prefix', { min: 1, max: 3, pattern: /^[A-Z]+$/ });
    const avgMinutes = int(req.body.avgMinutes, 'Average minutes', 1, 60);
    try {
      const info = db.prepare('INSERT INTO services (name, description, prefix, avg_minutes) VALUES (?,?,?,?)').run(name, description, prefix, avgMinutes);
      res.status(201).json({ service: serviceStats(getService(info.lastInsertRowid)) });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'duplicate_service', 'A counter with that name already exists.');
      throw e;
    }
  });

  app.patch('/api/admin/services/:id', adminOnly, (req, res) => {
    const sid = vId(req.params.id, 'Service id');
    onlyKeys(req.body, ['enabled']);
    const enabled = bool(req.body.enabled, 'enabled');
    if (!getService(sid)) throw new ApiError(404, 'not_found', 'Service not found.');
    db.prepare('UPDATE services SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, sid);
    res.json({ service: serviceStats(getService(sid)) });
  });

  app.get('/api/admin/security', adminOnly, (req, res) => {
    res.json({
      protections: [
        { id: 'auth', name: 'Password hashing and sessions', detail: 'Passwords stored as bcrypt hashes. Sessions are random 256-bit tokens, stored only as SHA-256 hashes, sent in HttpOnly cookies.' },
        { id: 'rbac', name: 'Role-based access control', detail: 'Every /api/staff and /api/admin route checks the session role on the server. Customers get 403, anonymous users get 401.' },
        { id: 'validation', name: 'Server-side input validation', detail: 'Every field is type-, length- and pattern-checked; unknown fields are rejected; all SQL is parameterised.' },
        { id: 'ratelimit', name: 'Rate limiting', detail: `Login: ${loginMax} failed attempts per ${loginWindowMs / 1000}s per IP+username. Token creation: ${tokenMax} per ${tokenWindowMs / 1000}s per IP.` },
        { id: 'integrity', name: 'Queue integrity', detail: 'Token numbers are assigned inside a database transaction. A partial unique index allows only one active token per customer per counter. Status changes follow a server-side transition table.' },
        { id: 'privacy', name: 'Privacy', detail: 'Customers are anonymous: a display name and a random reference. A customer can only read their own tokens; others get 404.' },
        { id: 'web', name: 'Web hardening', detail: `Helmet security headers (CSP, nosniff, frame protection), Origin check on every write, CORS ${allowedOrigins.length ? 'limited to ' + allowedOrigins.length + ' configured origin(s)' : 'closed (same-origin only)'}, cookie Secure flag ${isProd ? 'ON' : 'OFF (local development)'}.` },
      ],
      config: { production: isProd, loginMax, loginWindowSeconds: loginWindowMs / 1000, tokenMax, tokenWindowSeconds: tokenWindowMs / 1000 },
    });
  });

  // ---------- frontend + errors ----------
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } }));
  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(path.resolve(distDir), 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_input', message: 'Request body is not valid JSON.' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large.' } });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
  });

  return app;
}
