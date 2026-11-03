import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb, seedServices, ensureUser } from '../src/db.js';
import { createApp } from '../src/app.js';

const PG = process.env.TEST_DATABASE_URL;
let shared; // one PostgreSQL pool for the whole run
async function setup(opts = {}) {
  let db;
  if (PG) {
    shared ??= openDb({ url: PG });
    db = shared;
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } else db = openDb({ file: ':memory:' });
  await db.init();
  await seedServices(db);
  await ensureUser(db, 'admin', 'Admin#Test12345', 'admin');
  await ensureUser(db, 'staff', 'Staff#Test12345', 'staff');
  return { db, app: createApp({ db, ...opts }) };
}
test.after?.(() => shared?.close());
async function login(app, username, password) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ username, password });
  assert.equal(r.status, 200);
  return agent;
}

test('core flow: join -> call -> serve -> customer sees updated status', async () => {
  const { app } = await setup();
  const customer = request.agent(app);
  const staff = await login(app, 'staff', 'Staff#Test12345');

  const join = await customer.post('/api/tickets').send({ serviceId: 1, displayName: 'Asha' });
  assert.equal(join.status, 201);
  assert.equal(join.body.ticket.status, 'waiting');
  assert.equal(join.body.ticket.label, 'G-001');
  assert.equal(join.body.ticket.peopleAhead, 0);
  const tid = join.body.ticket.id;

  const other = request.agent(app);
  const j2 = await other.post('/api/tickets').send({ serviceId: 1, displayName: 'Ben' });
  assert.equal(j2.body.ticket.peopleAhead, 1);
  assert.equal(j2.body.ticket.estimatedWaitMinutes, 3); // 1 ahead x 3 min (General Enquiry)

  const called = await staff.post('/api/staff/services/1/call-next');
  assert.equal(called.status, 200);
  assert.equal(called.body.ticket.label, 'G-001');
  assert.equal((await customer.get(`/api/tickets/${tid}`)).body.ticket.status, 'called');
  assert.equal((await other.get(`/api/tickets/${j2.body.ticket.id}`)).body.ticket.peopleAhead, 0);

  const served = await staff.post(`/api/staff/tickets/${tid}/serve`);
  assert.equal(served.status, 200);
  assert.equal((await customer.get(`/api/tickets/${tid}`)).body.ticket.status, 'served');
  const q = await staff.get('/api/staff/queue/1');
  assert.equal(q.body.service.counts.served, 1);
  assert.equal(q.body.service.counts.waiting, 1);
});

test('authorization: anonymous gets 401, customer gets 403, staff cannot use admin routes', async () => {
  const { app } = await setup();
  assert.equal((await request(app).get('/api/staff/overview')).status, 401);
  assert.equal((await request(app).post('/api/staff/services/1/call-next')).status, 401);
  const customer = request.agent(app);
  await customer.post('/api/customer/session');
  assert.equal((await customer.post('/api/staff/services/1/call-next')).status, 403);
  assert.equal((await customer.get('/api/admin/summary')).status, 403);
  const staff = await login(app, 'staff', 'Staff#Test12345');
  assert.equal((await staff.get('/api/staff/overview')).status, 200);
  assert.equal((await staff.get('/api/admin/summary')).status, 403);
  const admin = await login(app, 'admin', 'Admin#Test12345');
  assert.equal((await admin.get('/api/admin/summary')).status, 200);
  // staff cookie + act-as-customer header drops privilege (used by Security demo)
  assert.equal((await admin.post('/api/staff/services/1/call-next').set('X-Act-As-Customer', '1')).status, 401);
});

test('input validation rejects bad ids, names, unknown fields and bad JSON', async () => {
  const { app } = await setup();
  const c = request.agent(app);
  for (const body of [
    { serviceId: '1; DROP TABLE tickets' }, { serviceId: -1 }, { serviceId: 99999999999 }, { serviceId: 1.5 },
    { serviceId: 1, displayName: '<script>alert(1)</script>' }, { serviceId: 1, displayName: 'x'.repeat(31) },
    { serviceId: 1, role: 'admin' }, {},
  ]) assert.equal((await c.post('/api/tickets').send(body)).status, 400, JSON.stringify(body));
  assert.equal((await c.post('/api/tickets').set('Content-Type', 'application/json').send('{bad')).status, 400);
  assert.equal((await c.post('/api/tickets').send({ serviceId: 999 })).status, 404);
  assert.equal((await c.get('/api/tickets/abc')).status, 400);
});

test('duplicate active token is rejected, allowed again after cancel', async () => {
  const { app } = await setup();
  const c = request.agent(app);
  const a = await c.post('/api/tickets').send({ serviceId: 2 });
  assert.equal(a.status, 201);
  const b = await c.post('/api/tickets').send({ serviceId: 2 });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'duplicate_active_token');
  // a different counter is fine
  assert.equal((await c.post('/api/tickets').send({ serviceId: 1 })).status, 201);
  assert.equal((await c.post(`/api/tickets/${a.body.ticket.id}/cancel`)).status, 200);
  assert.equal((await c.post('/api/tickets').send({ serviceId: 2 })).status, 201);
});

test('database itself refuses a second active ticket (constraint, not just app code)', async () => {
  const { db } = await setup();
  await db.run("INSERT INTO customers (ref, token_hash) VALUES ('C-T', 'h')");
  const ins = (n) => db.run("INSERT INTO tickets (service_id, customer_id, number, display_name) VALUES (1, 1, ?, 'x')", [n]);
  await ins(1);
  await assert.rejects(() => ins(2), /unique|UNIQUE/);
});

test('invalid transitions are rejected; cancelled/served tokens cannot be re-used', async () => {
  const { app } = await setup();
  const staff = await login(app, 'staff', 'Staff#Test12345');
  const c = request.agent(app);
  const t = (await c.post('/api/tickets').send({ serviceId: 1 })).body.ticket;
  assert.equal((await staff.post(`/api/staff/tickets/${t.id}/serve`)).status, 409); // waiting -> served
  assert.equal((await c.post(`/api/tickets/${t.id}/cancel`)).status, 200);
  assert.equal((await staff.post(`/api/staff/tickets/${t.id}/serve`)).status, 409); // cancelled -> served
  assert.equal((await staff.post(`/api/staff/tickets/${t.id}/skip`)).status, 409); // cancelled -> skipped
  assert.equal((await c.post(`/api/tickets/${t.id}/cancel`)).status, 409); // cancel twice
  const call = await staff.post('/api/staff/services/1/call-next');
  assert.equal(call.status, 409); // cancelled token is not eligible; queue is empty
  assert.equal(call.body.error.code, 'queue_empty');
  // served twice
  const t2 = (await request.agent(app).post('/api/tickets').send({ serviceId: 1 })).body.ticket;
  await staff.post('/api/staff/services/1/call-next');
  assert.equal((await staff.post(`/api/staff/tickets/${t2.id}/serve`)).status, 200);
  assert.equal((await staff.post(`/api/staff/tickets/${t2.id}/serve`)).status, 409);
  // customers cannot cancel a called token
  const c3 = request.agent(app);
  const t3 = (await c3.post('/api/tickets').send({ serviceId: 1 })).body.ticket;
  await staff.post('/api/staff/services/1/call-next');
  assert.equal((await c3.post(`/api/tickets/${t3.id}/cancel`)).status, 409);
});

test('privacy: another customer cannot read or cancel my token', async () => {
  const { app } = await setup();
  const a = request.agent(app), b = request.agent(app);
  const t = (await a.post('/api/tickets').send({ serviceId: 1, displayName: 'Private Person' })).body.ticket;
  assert.equal((await b.get(`/api/tickets/${t.id}`)).status, 404);
  assert.equal((await b.post(`/api/tickets/${t.id}/cancel`)).status, 404);
  assert.equal((await request(app).get(`/api/tickets/${t.id}`)).status, 404);
  assert.equal(JSON.stringify((await request(app).get('/api/services')).body).includes('Private Person'), false);
});

test('login: wrong password rejected, cookie is HttpOnly, no hash leaked, rate limit triggers', async () => {
  const { app } = await setup({ loginMax: 5 });
  const ok = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'Admin#Test12345' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
  assert.equal(JSON.stringify(ok.body).includes('$2'), false);
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'nope' + i })).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
  // other usernames are not locked out by one user's attempts
  assert.equal((await request(app).post('/api/auth/login').send({ username: 'staff', password: 'Staff#Test12345' })).status, 200);
});

test('token creation is rate limited', async () => {
  const { app } = await setup({ tokenMax: 3 });
  const c = request.agent(app);
  const out = [];
  for (let i = 0; i < 5; i++) out.push((await c.post('/api/tickets').send({ serviceId: 1 })).status);
  assert.equal(out.includes(429), true);
});

test('disabled counters cannot be joined; admin can create and toggle counters', async () => {
  const { app } = await setup();
  const admin = await login(app, 'admin', 'Admin#Test12345');
  const r = await admin.post('/api/admin/services').send({ name: 'Library Desk', prefix: 'L', avgMinutes: 4 });
  assert.equal(r.status, 201);
  assert.equal((await admin.post('/api/admin/services').send({ name: 'Library Desk', prefix: 'L', avgMinutes: 4 })).status, 409);
  assert.equal((await admin.post('/api/admin/services').send({ name: 'Bad', prefix: 'lower', avgMinutes: 4 })).status, 400);
  const sid = r.body.service.id;
  await admin.patch(`/api/admin/services/${sid}`).send({ enabled: false });
  assert.equal((await request(app).post('/api/tickets').send({ serviceId: sid })).status, 409);
  assert.equal((await request(app).get('/api/services')).body.services.some((s) => s.id === sid), false);
});

test('security headers present, errors never leak stack traces, bad Origin refused', async () => {
  const { app } = await setup();
  const r = await request(app).get('/api/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.headers['content-security-policy']);
  assert.equal(r.headers['x-powered-by'], undefined);
  const bad = await request(app).post('/api/customer/session').set('Origin', 'https://evil.example');
  assert.equal(bad.status, 403);
  const nf = await request(app).get('/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(JSON.stringify(nf.body).includes('at '), false);
});

test('admin adds a user to a group: stored in the database, can sign in, hashes never leak', async () => {
  const { app, db } = await setup();
  const admin = await login(app, 'admin', 'Admin#Test12345');
  const staff = await login(app, 'staff', 'Staff#Test12345');
  const body = { username: 'newstaff', password: 'Another#Pass123', group: 'staff' };
  assert.equal((await request(app).get('/api/admin/users')).status, 401);
  assert.equal((await staff.post('/api/admin/users').send(body)).status, 403);
  const r = await admin.post('/api/admin/users').send(body);
  assert.equal(r.status, 201);
  assert.equal(JSON.stringify(r.body).includes('$2'), false);
  assert.equal((await db.get('SELECT role FROM users WHERE username = ?', ['newstaff'])).role, 'staff');
  const list = (await admin.get('/api/admin/users')).body;
  assert.equal(list.users.some((u) => u.username === 'newstaff' && u.group === 'staff'), true);
  assert.equal(list.groups.staff, 2);
  assert.equal(JSON.stringify(list).includes('password'), false);
  const fresh = await login(app, 'newstaff', 'Another#Pass123');
  assert.equal((await fresh.get('/api/staff/overview')).status, 200);
  assert.equal((await fresh.get('/api/admin/users')).status, 403);
  assert.equal((await admin.post('/api/admin/users').send({ ...body, username: 'NewStaff' })).status, 409);
  for (const bad of [{ ...body, password: 'short' }, { ...body, username: 'x y', group: 'staff' }, { ...body, username: 'okname', group: 'owner' }, { ...body, username: 'okname', extra: 1 }])
    assert.equal((await admin.post('/api/admin/users').send(bad)).status, 400);
});

test('audit log and database view: events recorded, hashes hidden, admin only', async () => {
  const { app } = await setup();
  const admin = await login(app, 'admin', 'Admin#Test12345');
  const cust = request.agent(app);
  await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'wrong-pass' });
  await request(app).get('/api/staff/overview');
  await cust.post('/api/tickets').send({ serviceId: 1, displayName: 'Asha' });
  await cust.post('/api/tickets').send({ serviceId: 1 });
  await cust.post('/api/tickets').send({ serviceId: 'x' });
  await admin.post('/api/staff/services/1/call-next');
  const ev = (await admin.get('/api/admin/audit')).body.events.map((e) => e.event);
  for (const name of ['LOGIN_OK', 'LOGIN_FAILED', 'ACCESS_DENIED_401', 'CUSTOMER_CREATED', 'TOKEN_CREATED', 'DUPLICATE_TOKEN_BLOCKED', 'VALIDATION_REJECTED', 'TOKEN_CALLED'])
    assert.equal(ev.includes(name), true, name);
  const dbv = (await admin.get('/api/admin/database')).body;
  assert.deepEqual(dbv.tables.map((x) => x.name), ['users', 'customers', 'services', 'tickets', 'sessions', 'audit_log']);
  const cells = dbv.tables.flatMap((x) => x.rows.flat()).filter((v) => typeof v === 'string');
  assert.equal(cells.some((v) => /^\$2[aby]\$/.test(v) && !v.endsWith('(hidden)')), false); // no complete hash
  assert.equal(JSON.stringify(dbv).includes('(hidden)'), true);
  assert.equal(dbv.tables.find((x) => x.name === 'tickets').total, 1);
  assert.equal((await cust.get('/api/admin/database')).status, 403);
  assert.equal((await request(app).get('/api/admin/audit')).status, 401);
});

test('cloud: health reports engine, /admin/cloud is admin-only, S3 backup works with a stubbed S3 and is audited', async () => {
  const puts = [];
  const { app } = await setup({ s3: { bucket: 'test-bucket', region: 'us-east-1', put: async (x) => puts.push(x) }, inDocker: true });
  const health = (await request(app).get('/api/health')).body;
  assert.equal(health.status, 'ok');
  assert.equal(health.database, PG ? 'postgres' : 'sqlite');
  const admin = await login(app, 'admin', 'Admin#Test12345');
  const staff = await login(app, 'staff', 'Staff#Test12345');
  assert.equal((await staff.get('/api/admin/cloud')).status, 403);
  assert.equal((await staff.post('/api/admin/backup')).status, 403);
  const cloud = (await admin.get('/api/admin/cloud')).body;
  assert.equal(cloud.database.engine, PG ? 'PostgreSQL' : 'SQLite');
  assert.equal(cloud.container, true);
  assert.equal(cloud.s3.bucket, 'test-bucket');
  const b = await admin.post('/api/admin/backup');
  assert.equal(b.status, 201);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^backups\/queueless-.*\.json$/);
  assert.equal(JSON.parse(puts[0].body).tables.users.length, 2);
  assert.equal(JSON.parse(puts[0].body).tables.sessions, undefined);
  assert.equal((await admin.get('/api/admin/audit')).body.events.some((e) => e.event === 'BACKUP_CREATED'), true);
});

test('cloud: backup without S3 configured returns 501; S3 failure returns 502 without leaking details', async () => {
  const a = await setup();
  const admin1 = await login(a.app, 'admin', 'Admin#Test12345');
  assert.equal((await admin1.post('/api/admin/backup')).status, 501);
  const b = await setup({ s3: { bucket: 'x', put: async () => { throw new Error('AccessDenied secret-detail'); } } });
  const admin2 = await login(b.app, 'admin', 'Admin#Test12345');
  const r = await admin2.post('/api/admin/backup');
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.body).includes('secret-detail'), false);
});

test('cloud: FORCE_HTTPS redirects plain-HTTP proxied requests but not the health check', async () => {
  const { app } = await setup({ forceHttps: true, trustProxy: 1 });
  const r = await request(app).get('/api/services').set('X-Forwarded-Proto', 'http');
  assert.equal(r.status, 308);
  assert.match(r.headers.location, /^https:\/\//);
  assert.equal((await request(app).get('/api/health').set('X-Forwarded-Proto', 'http')).status, 200);
  assert.equal((await request(app).get('/api/services').set('X-Forwarded-Proto', 'https')).status, 200);
});

test('passwords everywhere are hashed: no plain text in any table, audit log or API output; reveal is admin-only and audited', async () => {
  const { app, db } = await setup();
  const admin = await login(app, 'admin', 'Admin#Test12345');
  await admin.post('/api/admin/users').send({ username: 'extra', password: 'Another#Pass123', group: 'staff' });
  await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'Wrong#Secret999' });
  const cust = request.agent(app);
  await cust.post('/api/tickets').send({ serviceId: 1, displayName: 'Asha' });
  const secrets = ['Admin#Test12345', 'Staff#Test12345', 'Another#Pass123', 'Wrong#Secret999'];
  // 1) raw database dump (every table)
  let dump = '';
  for (const t of ['users', 'sessions', 'customers', 'services', 'tickets', 'audit_log']) dump += JSON.stringify(await db.all(`SELECT * FROM ${t}`));
  for (const s of secrets) assert.equal(dump.includes(s), false, `plain text found in DB: ${s}`);
  // 2) every stored password is a bcrypt hash
  const hashes = (await db.all('SELECT password_hash FROM users')).map((u) => u.password_hash);
  assert.equal(hashes.length, 3);
  for (const x of hashes) assert.match(x, /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/);
  // 3) API output with everything revealed
  const full = (await admin.get('/api/admin/database?reveal=1&limit=1000')).body;
  for (const s of secrets) assert.equal(JSON.stringify(full).includes(s), false);
  assert.equal(full.revealed, true);
  assert.equal(full.passwordAudit.allHashed, true);
  assert.equal(full.passwordAudit.bcryptHashed, 3);
  const users = full.tables.find((t) => t.name === 'users');
  assert.equal(users.rows.every((r) => /^\$2[aby]\$10\$/.test(r[users.columns.indexOf('password_hash')]) && r[users.columns.indexOf('password_hash')].length === 60), true);
  // default view is masked; reveal is admin-only and audited
  const masked = (await admin.get('/api/admin/database')).body;
  assert.equal(masked.tables.find((t) => t.name === 'users').rows[0].some((v) => String(v).endsWith('(hidden)')), true);
  assert.equal((await cust.get('/api/admin/database?reveal=1')).status, 403);
  assert.equal((await admin.get('/api/admin/audit')).body.events.some((e) => e.event === 'HASHES_REVEALED'), true);
  // 4) audit log of failed login contains the username, never the password
  assert.equal((await admin.get('/api/admin/audit')).body.events.some((e) => e.event === 'LOGIN_FAILED' && e.actor === 'ghost'), true);
});
