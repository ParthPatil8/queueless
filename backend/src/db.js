import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

// Statuses used everywhere (database CHECK constraint, API, UI).
export const STATUS = ['waiting', 'called', 'served', 'skipped', 'cancelled'];

// COUNT(*) is BIGINT in PostgreSQL; return plain numbers like SQLite does.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

// One schema for both engines; {PK}, {BIGINT} and {NOW} are filled in per engine.
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id {PK},
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff','admin')),
  created_at TEXT NOT NULL DEFAULT ({NOW})
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at {BIGINT} NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id {PK},
  ref TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ({NOW})
);
CREATE TABLE IF NOT EXISTS services (
  id {PK},
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  avg_minutes INTEGER NOT NULL DEFAULT 5 CHECK (avg_minutes BETWEEN 1 AND 60),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS tickets (
  id {PK},
  service_id INTEGER NOT NULL REFERENCES services(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  number INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','called','served','skipped','cancelled')),
  created_at TEXT NOT NULL DEFAULT ({NOW}),
  updated_at TEXT NOT NULL DEFAULT ({NOW}),
  UNIQUE (service_id, number)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id {PK},
  ts TEXT NOT NULL DEFAULT ({NOW}),
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','blocked'))
);
-- Database-level duplicate protection: one active token per customer per service.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ticket_per_customer_service
  ON tickets (service_id, customer_id) WHERE status IN ('waiting','called');
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (service_id, status, number);
`;

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

// ---------------------------------------------------------------- SQLite
function sqliteAdapter(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');

  const ops = {
    get: async (sql, p = []) => raw.prepare(sql).get(...p),
    all: async (sql, p = []) => raw.prepare(sql).all(...p),
    run: async (sql, p = []) => ({ changes: Number(raw.prepare(sql).run(...p).changes) }),
    insert: async (sql, p = []) => Number(raw.prepare(sql).run(...p).lastInsertRowid),
  };
  // One connection: queue every statement and every transaction so they never interleave.
  let chain = Promise.resolve();
  const exclusive = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
  const queued = Object.fromEntries(Object.entries(ops).map(([k, f]) => [k, (...a) => exclusive(() => f(...a))]));

  return {
    dialect: 'sqlite', now: "datetime('now')", forUpdate: '', skipLocked: '',
    ...queued,
    exec: (sql) => exclusive(async () => raw.exec(sql)),
    tx: (fn) => exclusive(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = await fn(ops); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch { /* already closed */ } throw e; }
    }),
    columns: async (t) => (await queued.all(`PRAGMA table_info(${t})`)).map((c) => c.name),
    init: async () => { raw.exec(DDL.replaceAll('{PK}', 'INTEGER PRIMARY KEY').replaceAll('{BIGINT}', 'INTEGER').replaceAll('{NOW}', "datetime('now')")); },
    close: async () => raw.close(),
  };
}

// ------------------------------------------------- PostgreSQL (e.g. Amazon RDS)
function postgresAdapter(url, ssl) {
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  const mk = (c) => ({
    get: async (sql, p = []) => (await c.query(toPg(sql), p)).rows[0],
    all: async (sql, p = []) => (await c.query(toPg(sql), p)).rows,
    run: async (sql, p = []) => ({ changes: (await c.query(toPg(sql), p)).rowCount }),
    insert: async (sql, p = []) => (await c.query(`${toPg(sql)} RETURNING id`, p)).rows[0].id,
  });
  const ops = mk(pool);
  const NOW = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')";
  return {
    dialect: 'postgres', now: NOW, forUpdate: ' FOR UPDATE', skipLocked: ' FOR UPDATE SKIP LOCKED',
    ...ops,
    exec: (sql) => pool.query(sql),
    tx: async (fn) => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await fn(mk(client)); await client.query('COMMIT'); return r; }
      catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection lost */ } throw e; }
      finally { client.release(); }
    },
    columns: async (t) => (await ops.all(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position', [t],
    )).map((c) => c.column_name),
    init: async () => { await pool.query(DDL.replaceAll('{PK}', 'SERIAL PRIMARY KEY').replaceAll('{BIGINT}', 'BIGINT').replaceAll('{NOW}', NOW)); },
    close: () => pool.end(),
  };
}

// DATABASE_URL set -> PostgreSQL (RDS). Otherwise a SQLite file.
export function openDb({ url, ssl = false, file = ':memory:' } = {}) {
  return url ? postgresAdapter(url, ssl) : sqliteAdapter(file);
}

export const isUniqueViolation = (e) => e?.code === '23505' || /UNIQUE constraint failed/i.test(String(e?.message));

export async function seedServices(db) {
  if ((await db.get('SELECT COUNT(*) AS c FROM services')).c > 0) return;
  for (const row of [
    ['General Enquiry', 'Questions, forms and directions (demo counter)', 'G', 3],
    ['Student Services', 'ID cards, certificates and fee queries (demo counter)', 'S', 6],
    ['IT Helpdesk', 'Wi-Fi, accounts and device support (demo counter)', 'IT', 8],
  ]) await db.run('INSERT INTO services (name, description, prefix, avg_minutes) VALUES (?,?,?,?)', row);
}

export async function ensureUser(db, username, password, role) {
  if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', [username])) return false;
  await db.run('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [username, bcrypt.hashSync(password, 10), role]);
  return true;
}
