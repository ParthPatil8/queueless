import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb, seedServices, ensureUser } from '../src/db.js';
import { createApp } from '../src/app.js';

function setup(opts = {}) {
  const db = openDb(':memory:');
  seedServices(db);
  ensureUser(db, 'admin', 'Admin#Test12345', 'admin');
  ensureUser(db, 'staff', 'Staff#Test12345', 'staff');
  const app = createApp({ db, ...opts });
  return { db, app };
}
async function login(app, username, password) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ username, password });
  assert.equal(r.status, 200);
  return agent;
}

test('core flow: join -> call -> serve -> customer sees updated status', async () => {
  const { app } = setup();
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
  const { app } = setup();
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
  const { app } = setup();
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
  const { app } = setup();
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

test('database itself refuses a second active ticket (constraint, not just app code)', () => {
  const { db } = setup();
  db.prepare("INSERT INTO customers (ref, token_hash) VALUES ('C-T', 'h')").run();
  const ins = db.prepare("INSERT INTO tickets (service_id, customer_id, number, display_name) VALUES (1, 1, ?, 'x')");
  ins.run(1);
  assert.throws(() => ins.run(2), /UNIQUE/);
});

test('invalid transitions are rejected; cancelled/served tokens cannot be re-used', async () => {
  const { app } = setup();
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
  const { app } = setup();
  const a = request.agent(app), b = request.agent(app);
  const t = (await a.post('/api/tickets').send({ serviceId: 1, displayName: 'Private Person' })).body.ticket;
  assert.equal((await b.get(`/api/tickets/${t.id}`)).status, 404);
  assert.equal((await b.post(`/api/tickets/${t.id}/cancel`)).status, 404);
  assert.equal((await request(app).get(`/api/tickets/${t.id}`)).status, 404);
  assert.equal(JSON.stringify((await request(app).get('/api/services')).body).includes('Private Person'), false);
});

test('login: wrong password rejected, cookie is HttpOnly, no hash leaked, rate limit triggers', async () => {
  const { app } = setup({ loginMax: 5 });
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
  const { app } = setup({ tokenMax: 3 });
  const c = request.agent(app);
  const out = [];
  for (let i = 0; i < 5; i++) out.push((await c.post('/api/tickets').send({ serviceId: 1 })).status);
  assert.equal(out.includes(429), true);
});

test('disabled counters cannot be joined; admin can create and toggle counters', async () => {
  const { app } = setup();
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
  const { app } = setup();
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
