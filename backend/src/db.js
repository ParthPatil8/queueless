import { DatabaseSync } from 'node:sqlite'; // built into Node 22.13+: no native compile step, fewer deployment failures
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

// Statuses used everywhere (database CHECK constraint, API, UI).
export const STATUS = ['waiting', 'called', 'served', 'skipped', 'cancelled'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  avg_minutes INTEGER NOT NULL DEFAULT 5 CHECK (avg_minutes BETWEEN 1 AND 60),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  number INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','called','served','skipped','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (service_id, number)
);
-- Database-level duplicate protection: one active token per customer per service.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ticket_per_customer_service
  ON tickets (service_id, customer_id) WHERE status IN ('waiting','called');
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (service_id, status, number);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Tiny transaction helper: db.transaction(fn)() or db.transaction(fn).immediate()
  db.transaction = (fn) => {
    const make = (mode) => (...args) => {
      db.exec(`BEGIN ${mode}`);
      try { const r = fn(...args); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    };
    const t = make('DEFERRED');
    t.immediate = make('IMMEDIATE');
    return t;
  };
  return db;
}

export const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e?.message));

export function seedServices(db) {
  if (db.prepare('SELECT COUNT(*) c FROM services').get().c > 0) return;
  const ins = db.prepare('INSERT INTO services (name, description, prefix, avg_minutes) VALUES (?,?,?,?)');
  ins.run('General Enquiry', 'Questions, forms and directions (demo counter)', 'G', 3);
  ins.run('Student Services', 'ID cards, certificates and fee queries (demo counter)', 'S', 6);
  ins.run('IT Helpdesk', 'Wi-Fi, accounts and device support (demo counter)', 'IT', 8);
}

export function ensureUser(db, username, password, role) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return false;
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), role);
  return true;
}
