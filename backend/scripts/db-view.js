// Prints the database tables in the terminal:  npm run db:view
// Uses DATABASE_URL (PostgreSQL / RDS) if set, otherwise the SQLite file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const db = openDb({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL === 'true', file: env.DATABASE_PATH || path.join(here, '..', 'data', 'queueless.db') });
await db.init();
console.log(`Database engine: ${db.dialect}`);
const mask = process.argv.includes('--mask'); // by default show EVERYTHING, including the full hashes
const hide = mask ? (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /hash/.test(k) ? `${String(v).slice(0, 10)}... (hidden)` : v])) : (r) => r;
for (const [t, order] of [['users', 'id'], ['customers', 'id'], ['services', 'id'], ['tickets', 'id'], ['sessions', 'expires_at'], ['audit_log', 'id']]) {
  const total = (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  console.log(`\n=== ${t} (${total} rows, newest first, max 25) ===`);
  const rows = (await db.all(`SELECT * FROM ${t} ORDER BY ${order} DESC LIMIT 25`)).map(hide);
  if (rows.length) console.table(rows); else console.log('(empty)');
}
const pw = (await db.all('SELECT password_hash FROM users')).map((x) => x.password_hash);
console.log(`\nPassword storage check: ${pw.filter((x) => /^\$2[aby]\$\d{2}\$/.test(x)).length} of ${pw.length} user passwords are bcrypt hashes.`);
await db.close();
