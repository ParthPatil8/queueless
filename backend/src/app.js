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
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // async errors -> error handler

// Allowed status transitions. The server is the only place these rules live.
const TRANSITIONS = {
  waiting: ['called', 'skipped', 'cancelled'],
  called: ['served', 'skipped'],
  served: [], skipped: [], cancelled: [],
};

// Default S3 upload (AWS SDK v3). Credentials come from the default chain: on EC2 that is the instance's IAM role.
async function putToS3({ bucket, region, key, body }) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  await new S3Client({ region }).send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256',
  }));
}

export function createApp({
  db, isProd = false, allowedOrigins = [], distDir = null,
  loginMax = 5, loginWindowMs = 60_000, tokenMax = 20, tokenWindowMs = 60_000, apiMax = 300,
  logToConsole = false, logFormat = 'text', cookieSecure = isProd, trustProxy = isProd ? 1 : 0, forceHttps = false,
  s3 = {}, inDocker = false,
}) {
  const s3cfg = { bucket: s3.bucket || null, region: s3.region || 'us-east-1', put: s3.put || putToS3 };
  const startedAt = Date.now();
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer / PaaS proxy trust 1 hop; when exposed directly (e.g. Docker on EC2) set TRUST_PROXY=0
  // so clients cannot spoof X-Forwarded-For to dodge rate limits.
  if (trustProxy) app.set('trust proxy', trustProxy);

  const pathOf = (req) => req.originalUrl.split('?')[0];
  const emit = (obj, textLine) => {
    if (!logToConsole) return;
    console.log(logFormat === 'json' ? JSON.stringify({ ts: new Date().toISOString(), ...obj }) : textLine);
  };

  // Audit log: every security-relevant action is stored in the audit_log table AND printed to the server console.
  const audit = async (req, event, outcome, detail = '') => {
    try {
      const who = pathOf(req) === '/api/auth/login' && typeof req.body?.username === 'string' ? req.body.username.slice(0, 32)
        : (req.staff?.username || req.customer?.ref || 'anonymous');
      const ip = String(req.ip || '').replace('::ffff:', '');
      const newId = await db.insert('INSERT INTO audit_log (event, actor, detail, ip, outcome) VALUES (?,?,?,?,?)', [event, who, String(detail).slice(0, 160), ip, outcome]);
      if (newId > 1000) await db.run('DELETE FROM audit_log WHERE id <= ?', [newId - 1000]);
      emit({ level: 'audit', outcome, event, actor: who, ip, detail },
        `[AUDIT] ${new Date().toISOString()} ${outcome.toUpperCase()} ${event} actor=${who} ip=${ip}${detail ? ' ' + detail : ''}`);
    } catch { /* logging must never break a request */ }
  };
  const BLOCK_EVENTS = { invalid_input: 'VALIDATION_REJECTED', unauthenticated: 'ACCESS_DENIED_401', forbidden: 'ACCESS_DENIED_403', bad_origin: 'BAD_ORIGIN_BLOCKED',
    duplicate_active_token: 'DUPLICATE_TOKEN_BLOCKED', invalid_transition: 'INVALID_TRANSITION_BLOCKED', bad_credentials: 'LOGIN_FAILED', duplicate_user: 'DUPLICATE_USER_BLOCKED' };

  // Force HTTPS when running behind a TLS-terminating proxy / load balancer (FORCE_HTTPS=true).
  if (forceHttps) {
    app.use((req, res, next) => {
      if (req.get('x-forwarded-proto') === 'http' && pathOf(req) !== '/api/health') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
      next();
    });
  }
  // Structured request log (one JSON line per request) - ready for CloudWatch / any log pipeline.
  if (logFormat === 'json' && logToConsole) {
    app.use((req, res, next) => {
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        if (pathOf(req) === '/api/health') return;
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'request', method: req.method, path: pathOf(req), status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 | 0, ip: req.ip }));
      });
      next();
    });
  }

  app.use(helmet({
    contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': isProd && cookieSecure ? [] : null } },
  }));
  // CORS: closed by default (same-origin deployment). Only listed origins are allowed.
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '10kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const limited = (code, message) => async (req, res) => {
    await audit(req, 'RATE_LIMITED', 'blocked', `${req.method} ${pathOf(req)}`);
    res.status(429).json({ error: { code, message } });
  };

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
  const cookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: cookieSecure, path: '/', maxAge });

  app.use('/api', h(async (req, res, next) => {
    req.staff = null; req.customer = null;
    const st = req.cookies?.[STAFF_COOKIE];
    if (typeof st === 'string' && st.length === 64) {
      req.staff = (await db.get(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`, [sha256(st), Date.now()])) ?? null;
    }
    const ct = req.cookies?.[CUST_COOKIE];
    if (typeof ct === 'string' && ct.length === 64) {
      req.customer = (await db.get('SELECT id, ref FROM customers WHERE token_hash = ?', [sha256(ct)])) ?? null;
    }
    // Privilege can only be REDUCED by this header (used by the Security demo to act as a customer).
    if (req.get('x-act-as-customer') === '1') req.staff = null;
    next();
  }));

  const requireRole = (...roles) => (req, res, next) => {
    if (req.staff && roles.includes(req.staff.role)) return next();
    if (req.staff || req.customer) return next(new ApiError(403, 'forbidden', 'You do not have permission for this action.'));
    next(new ApiError(401, 'unauthenticated', 'Please sign in.'));
  };
  const staffOnly = requireRole('staff', 'admin');
  const adminOnly = requireRole('admin');

  async function ensureCustomer(req, res) {
    if (req.customer) return req.customer;
    const token = randomToken();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const ref = 'C-' + Array.from(crypto.randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
    const newId = await db.insert('INSERT INTO customers (ref, token_hash) VALUES (?,?)', [ref, sha256(token)]);
    res.cookie(CUST_COOKIE, token, cookieOpts(30 * 24 * 3600 * 1000));
    req.customer = { id: newId, ref };
    await audit(req, 'CUSTOMER_CREATED', 'ok', 'new anonymous customer row added to the database');
    return req.customer;
  }

  // ---------- helpers (q is the db or a transaction handle) ----------
  const getService = (q, sid) => q.get('SELECT * FROM services WHERE id = ?', [sid]);
  const nowServing = (q, s) => q.get(`SELECT number FROM tickets WHERE service_id = ? AND status = 'called' ORDER BY updated_at DESC, id DESC LIMIT 1`, [s.id]);
  const serviceStats = async (q, s) => {
    const counts = { waiting: 0, called: 0, served: 0, skipped: 0, cancelled: 0 };
    for (const r of await q.all('SELECT status, COUNT(*) AS n FROM tickets WHERE service_id = ? GROUP BY status', [s.id])) counts[r.status] = r.n;
    const now = await nowServing(q, s);
    return {
      id: s.id, name: s.name, description: s.description, prefix: s.prefix, avgMinutes: s.avg_minutes,
      enabled: !!s.enabled, counts, nowServing: now ? label(s.prefix, now.number) : null,
      estimatedWaitMinutes: counts.waiting * s.avg_minutes,
    };
  };
  const ticketView = async (q, t) => {
    const s = await getService(q, t.service_id);
    let peopleAhead = null, est = null;
    if (t.status === 'waiting') {
      peopleAhead = (await q.get(`SELECT COUNT(*) AS n FROM tickets WHERE service_id = ? AND status = 'waiting' AND number < ?`, [t.service_id, t.number])).n;
      est = peopleAhead * s.avg_minutes;
    }
    const now = await nowServing(q, s);
    return {
      id: t.id, label: label(s.prefix, t.number), serviceId: s.id, serviceName: s.name, status: t.status,
      displayName: t.display_name, createdAt: t.created_at, updatedAt: t.updated_at,
      peopleAhead, estimatedWaitMinutes: est, nowServing: now ? label(s.prefix, now.number) : null,
    };
  };

  // The ONLY place ticket status changes (call inside db.tx). Checks the rule table AND guards the UPDATE with the expected old status.
  const transition = async (q, ticketId, to, allowedFrom) => {
    const t = await q.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!t) throw new ApiError(404, 'not_found', 'Token not found.');
    if (!allowedFrom.includes(t.status) || !TRANSITIONS[t.status].includes(to))
      throw new ApiError(409, 'invalid_transition', `A ${t.status} token cannot become ${to}.`);
    const r = await q.run(`UPDATE tickets SET status = ?, updated_at = ${db.now} WHERE id = ? AND status = ?`, [to, ticketId, t.status]);
    if (r.changes !== 1) throw new ApiError(409, 'invalid_transition', 'Token changed state; refresh and try again.');
    return q.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
  };

  // ---------- public ----------
  app.get('/api/health', h(async (req, res) => {
    await db.get('SELECT 1 AS ok');
    res.json({ status: 'ok', database: db.dialect, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  }));

  app.get('/api/services', h(async (req, res) => {
    const rows = await db.all('SELECT * FROM services WHERE enabled = 1 ORDER BY id');
    res.json({ services: await Promise.all(rows.map((s) => serviceStats(db, s))) });
  }));

  // ---------- auth ----------
  app.post('/api/auth/login', loginLimiter, h(async (req, res) => {
    onlyKeys(req.body, ['username', 'password']);
    const username = text(req.body.username, 'Username', { min: 3, max: 32, pattern: /^[A-Za-z0-9_.-]+$/ });
    if (typeof req.body.password !== 'string' || req.body.password.length < 1 || req.body.password.length > 128)
      throw new ApiError(400, 'invalid_input', 'Password must be 1-128 characters.');
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    const ok = bcrypt.compareSync(req.body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new ApiError(401, 'bad_credentials', 'Invalid username or password.');
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
    const token = randomToken();
    const ttl = 8 * 3600 * 1000;
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', [sha256(token), user.id, Date.now() + ttl]);
    res.cookie(STAFF_COOKIE, token, cookieOpts(ttl));
    await audit(req, 'LOGIN_OK', 'ok', `group=${user.role}`);
    res.json({ user: { username: user.username, role: user.role } });
  }));

  app.post('/api/auth/logout', h(async (req, res) => {
    if (req.staff) await audit(req, 'LOGOUT', 'ok');
    const st = req.cookies?.[STAFF_COOKIE];
    if (typeof st === 'string') await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(st)]);
    res.clearCookie(STAFF_COOKIE, cookieOpts(0));
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', staffOnly, (req, res) => res.json({ user: { username: req.staff.username, role: req.staff.role } }));

  // ---------- customer ----------
  app.post('/api/customer/session', h(async (req, res) => {
    const c = await ensureCustomer(req, res);
    res.json({ customerRef: c.ref });
  }));

  app.post('/api/tickets', tokenLimiter, h(async (req, res) => {
    onlyKeys(req.body, ['serviceId', 'displayName']);
    const serviceId = vId(req.body.serviceId, 'serviceId');
    const displayName = req.body.displayName === undefined ? 'Guest'
      : text(req.body.displayName, 'Name', { min: 1, max: 30, pattern: NAME_RE });
    const customer = await ensureCustomer(req, res);
    let t;
    try {
      t = await db.tx(async (q) => {
        const s = await q.get(`SELECT * FROM services WHERE id = ?${db.forUpdate}`, [serviceId]); // row lock: one join at a time per counter
        if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
        if (!s.enabled) throw new ApiError(409, 'service_disabled', 'This counter is currently closed.');
        const dup = await q.get(`SELECT id FROM tickets WHERE service_id = ? AND customer_id = ? AND status IN ('waiting','called')`, [serviceId, customer.id]);
        if (dup) { const e = new ApiError(409, 'duplicate_active_token', 'You already have an active token for this counter.'); e.extra = { ticketId: dup.id }; throw e; }
        const number = (await q.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE service_id = ?', [serviceId])).n;
        const newId = await q.insert('INSERT INTO tickets (service_id, customer_id, number, display_name) VALUES (?,?,?,?)', [serviceId, customer.id, number, displayName]);
        return q.get('SELECT * FROM tickets WHERE id = ?', [newId]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'duplicate_active_token', 'You already have an active token for this counter.');
      throw e;
    }
    const tv = await ticketView(db, t);
    await audit(req, 'TOKEN_CREATED', 'ok', `${tv.label} ${tv.serviceName}`);
    res.status(201).json({ ticket: tv });
  }));

  app.get('/api/tickets/mine', h(async (req, res) => {
    if (!req.customer) return res.json({ tickets: [] });
    const rows = await db.all('SELECT * FROM tickets WHERE customer_id = ? ORDER BY id DESC LIMIT 8', [req.customer.id]);
    res.json({ tickets: await Promise.all(rows.map((t) => ticketView(db, t))) });
  }));

  const ownTicket = async (req) => {
    const tid = vId(req.params.id, 'Token id');
    const t = req.customer && await db.get('SELECT * FROM tickets WHERE id = ? AND customer_id = ?', [tid, req.customer.id]);
    if (!t) throw new ApiError(404, 'not_found', 'Token not found.'); // same answer for "not yours" and "does not exist"
    return t;
  };
  app.get('/api/tickets/:id', h(async (req, res) => res.json({ ticket: await ticketView(db, await ownTicket(req)) })));
  app.post('/api/tickets/:id/cancel', h(async (req, res) => {
    const t = await ownTicket(req);
    const updated = await db.tx((q) => transition(q, t.id, 'cancelled', ['waiting']));
    const tv = await ticketView(db, updated);
    await audit(req, 'TOKEN_CANCELLED', 'ok', `${tv.label} ${tv.serviceName}`);
    res.json({ ticket: tv });
  }));

  // ---------- staff ----------
  app.get('/api/staff/overview', staffOnly, h(async (req, res) => {
    const rows = await db.all('SELECT * FROM services ORDER BY id');
    res.json({ services: await Promise.all(rows.map((s) => serviceStats(db, s))) });
  }));

  app.get('/api/staff/queue/:serviceId', staffOnly, h(async (req, res) => {
    const s = await getService(db, vId(req.params.serviceId, 'Service id'));
    if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
    const rows = await db.all(`SELECT t.*, c.ref FROM tickets t JOIN customers c ON c.id = t.customer_id
      WHERE t.service_id = ? AND t.status IN ('waiting','called') ORDER BY t.number`, [s.id]);
    res.json({
      service: await serviceStats(db, s),
      tickets: rows.map((t) => ({ id: t.id, label: label(s.prefix, t.number), status: t.status,
        displayName: t.display_name, customerRef: t.ref, createdAt: t.created_at })),
    });
  }));

  app.post('/api/staff/services/:serviceId/call-next', staffOnly, h(async (req, res) => {
    const s = await getService(db, vId(req.params.serviceId, 'Service id'));
    if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
    const called = await db.tx(async (q) => {
      const next = await q.get(`SELECT id FROM tickets WHERE service_id = ? AND status = 'waiting' ORDER BY number LIMIT 1${db.skipLocked}`, [s.id]);
      if (!next) throw new ApiError(409, 'queue_empty', 'Nobody is waiting in this queue.');
      return transition(q, next.id, 'called', ['waiting']);
    });
    await audit(req, 'TOKEN_CALLED', 'ok', `${label(s.prefix, called.number)} ${s.name}`);
    res.json({ ticket: { id: called.id, label: label(s.prefix, called.number), status: called.status } });
  }));

  const staffAction = (to, from, ev) => h(async (req, res) => {
    const tid = vId(req.params.id, 'Token id');
    const t = await db.tx((q) => transition(q, tid, to, from));
    const s = await getService(db, t.service_id);
    await audit(req, ev, 'ok', `${label(s.prefix, t.number)} ${s.name}`);
    res.json({ ticket: { id: t.id, label: label(s.prefix, t.number), status: t.status } });
  });
  app.post('/api/staff/tickets/:id/serve', staffOnly, staffAction('served', ['called'], 'TOKEN_SERVED'));
  app.post('/api/staff/tickets/:id/skip', staffOnly, staffAction('skipped', ['waiting', 'called'], 'TOKEN_SKIPPED'));

  // ---------- admin ----------
  app.get('/api/admin/summary', adminOnly, h(async (req, res) => {
    const services = await Promise.all((await db.all('SELECT * FROM services ORDER BY id')).map((s) => serviceStats(db, s)));
    const totals = { waiting: 0, called: 0, served: 0, skipped: 0, cancelled: 0 };
    for (const s of services) for (const k of Object.keys(totals)) totals[k] += s.counts[k];
    res.json({ totals, services });
  }));

  app.post('/api/admin/services', adminOnly, h(async (req, res) => {
    onlyKeys(req.body, ['name', 'description', 'prefix', 'avgMinutes']);
    const name = text(req.body.name, 'Name', { min: 2, max: 40, pattern: NAME_RE });
    const description = req.body.description === undefined ? '' : text(req.body.description, 'Description', { min: 0, max: 120, pattern: /^[^<>]*$/ });
    const prefix = text(req.body.prefix, 'Prefix', { min: 1, max: 3, pattern: /^[A-Z]+$/ });
    const avgMinutes = int(req.body.avgMinutes, 'Average minutes', 1, 60);
    let newId;
    try {
      newId = await db.insert('INSERT INTO services (name, description, prefix, avg_minutes) VALUES (?,?,?,?)', [name, description, prefix, avgMinutes]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'duplicate_service', 'A counter with that name already exists.');
      throw e;
    }
    await audit(req, 'COUNTER_CREATED', 'ok', name);
    res.status(201).json({ service: await serviceStats(db, await getService(db, newId)) });
  }));

  app.patch('/api/admin/services/:id', adminOnly, h(async (req, res) => {
    const sid = vId(req.params.id, 'Service id');
    onlyKeys(req.body, ['enabled']);
    const enabled = bool(req.body.enabled, 'enabled');
    const s = await getService(db, sid);
    if (!s) throw new ApiError(404, 'not_found', 'Service not found.');
    await db.run('UPDATE services SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, sid]);
    await audit(req, enabled ? 'COUNTER_ENABLED' : 'COUNTER_DISABLED', 'ok', s.name);
    res.json({ service: await serviceStats(db, await getService(db, sid)) });
  }));

  // ---- users and groups (groups = roles) ----
  const userView = (u) => ({ id: u.id, username: u.username, group: u.role, createdAt: u.created_at });
  app.get('/api/admin/users', adminOnly, h(async (req, res) => {
    const users = await db.all('SELECT id, username, role, created_at FROM users ORDER BY id');
    const groups = { admin: 0, staff: 0, customer: (await db.get('SELECT COUNT(*) AS n FROM customers')).n };
    for (const u of users) groups[u.role] += 1;
    res.json({ users: users.map(userView), groups });
  }));

  app.post('/api/admin/users', adminOnly, h(async (req, res) => {
    onlyKeys(req.body, ['username', 'password', 'group']);
    const username = text(req.body.username, 'Username', { min: 3, max: 32, pattern: /^[A-Za-z0-9_.-]+$/ });
    const pw = req.body.password;
    if (typeof pw !== 'string' || pw.length < 12 || pw.length > 128) throw new ApiError(400, 'invalid_input', 'Password must be 12-128 characters.');
    if (!['staff', 'admin'].includes(req.body.group)) throw new ApiError(400, 'invalid_input', 'Group must be staff or admin.');
    if (await db.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?)', [username])) throw new ApiError(409, 'duplicate_user', 'That username already exists.');
    const newId = await db.insert('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [username, bcrypt.hashSync(pw, 10), req.body.group]);
    const u = await db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [newId]);
    await audit(req, 'USER_CREATED', 'ok', `${u.username} added to the ${u.role} group`);
    res.status(201).json({ user: userView(u) });
  }));

  // ---- backend visibility (read-only) ----
  const MASK = new Set(['password_hash', 'token_hash']);
  const TABLES = [['users', 'id'], ['customers', 'id'], ['services', 'id'], ['tickets', 'id'], ['sessions', 'expires_at'], ['audit_log', 'id']];
  const revealAt = new Map(); // admin -> last time a reveal was audited (avoid one log line per 3 s poll)
  app.get('/api/admin/database', adminOnly, h(async (req, res) => {
    const reveal = req.query.reveal === '1';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
    const tables = [];
    for (const [name, order] of TABLES) {
      const columns = await db.columns(name);
      const total = (await db.get(`SELECT COUNT(*) AS n FROM ${name}`)).n;
      const rows = (await db.all(`SELECT * FROM ${name} ORDER BY ${order} DESC LIMIT ${limit}`))
        .map((r) => columns.map((c) => (MASK.has(c) && !reveal ? `${String(r[c]).slice(0, 10)}... (hidden)` : r[c])));
      tables.push({ name, columns, total, rows });
    }
    // Live proof that every stored password is a bcrypt hash (never plain text).
    const hashes = (await db.all('SELECT password_hash FROM users')).map((x) => x.password_hash);
    const bcryptHashed = hashes.filter((x) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(x)).length;
    const passwordAudit = { users: hashes.length, bcryptHashed, allHashed: hashes.length === bcryptHashed, algorithm: 'bcrypt', cost: Number(hashes[0]?.slice(4, 6)) || 10 };
    if (reveal && Date.now() - (revealAt.get(req.staff.username) || 0) > 60_000) {
      revealAt.set(req.staff.username, Date.now());
      await audit(req, 'HASHES_REVEALED', 'ok', 'full password and token hashes shown in the admin database view');
    }
    res.json({ tables, passwordAudit, revealed: reveal, limit });
  }));
  app.get('/api/admin/audit', adminOnly, h(async (req, res) => {
    res.json({ events: await db.all('SELECT id, ts, event, actor, detail, ip, outcome FROM audit_log ORDER BY id DESC LIMIT 100') });
  }));

  // ---- cloud: what the app is running on, and S3 backups ----
  app.get('/api/admin/cloud', adminOnly, (req, res) => {
    res.json({
      database: { engine: db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite', managedFriendly: db.dialect === 'postgres' },
      container: inDocker,
      s3: { configured: !!s3cfg.bucket, bucket: s3cfg.bucket, region: s3cfg.region },
      runtime: { node: process.version, production: isProd, logFormat, secureCookies: cookieSecure, forceHttps, trustProxy: Number(trustProxy) || 0, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) },
    });
  });

  app.post('/api/admin/backup', adminOnly, h(async (req, res) => {
    if (!s3cfg.bucket) throw new ApiError(501, 's3_not_configured', 'S3 is not configured. Set S3_BUCKET (and give the server an IAM role or credentials).');
    const data = {};
    for (const [name] of TABLES) if (name !== 'sessions') data[name] = await db.all(`SELECT * FROM ${name}`);
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), engine: db.dialect, tables: data });
    const key = `backups/queueless-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    try {
      await s3cfg.put({ bucket: s3cfg.bucket, region: s3cfg.region, key, body });
    } catch (e) {
      console.error('S3 backup failed:', e.name || e.message);
      throw new ApiError(502, 's3_error', 'Could not write to S3. Check the bucket name, region and the server\'s IAM permissions.');
    }
    await audit(req, 'BACKUP_CREATED', 'ok', `s3://${s3cfg.bucket}/${key}`);
    res.status(201).json({ bucket: s3cfg.bucket, key, bytes: Buffer.byteLength(body), rows: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) });
  }));

  app.get('/api/admin/security', adminOnly, (req, res) => {
    res.json({
      protections: [
        { id: 'auth', name: 'Password hashing and sessions', detail: 'Passwords stored as bcrypt hashes. Sessions are random 256-bit tokens, stored only as SHA-256 hashes, sent in HttpOnly cookies.' },
        { id: 'rbac', name: 'Role-based access control', detail: 'Every /api/staff and /api/admin route checks the session role on the server. Customers get 403, anonymous users get 401.' },
        { id: 'validation', name: 'Server-side input validation', detail: 'Every field is type-, length- and pattern-checked; unknown fields are rejected; all SQL is parameterised.' },
        { id: 'ratelimit', name: 'Rate limiting', detail: `Login: ${loginMax} failed attempts per ${loginWindowMs / 1000}s per IP+username. Token creation: ${tokenMax} per ${tokenWindowMs / 1000}s per IP.` },
        { id: 'integrity', name: 'Queue integrity', detail: 'Token numbers are assigned inside a database transaction. A partial unique index allows only one active token per customer per counter. Status changes follow a server-side transition table.' },
        { id: 'privacy', name: 'Privacy', detail: 'Customers are anonymous: a display name and a random reference. A customer can only read their own tokens; others get 404.' },
        { id: 'web', name: 'Web hardening', detail: `Helmet security headers (CSP, nosniff, frame protection), Origin check on every write, CORS ${allowedOrigins.length ? 'limited to ' + allowedOrigins.length + ' configured origin(s)' : 'closed (same-origin only)'}, cookie Secure flag ${cookieSecure ? 'ON' : 'OFF'}, HTTPS redirect ${forceHttps ? 'ON' : 'OFF'}.` },
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
  app.use(async (err, req, res, next) => {
    if (err instanceof ApiError) {
      const ev = BLOCK_EVENTS[err.code];
      if (ev && pathOf(req) !== '/api/auth/me') await audit(req, ev, 'blocked', `${req.method} ${pathOf(req)} - ${err.message}`);
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_input', message: 'Request body is not valid JSON.' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large.' } });
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
  });

  return app;
}
