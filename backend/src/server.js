import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, seedServices, ensureUser } from './db.js';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') }); // optional project-root .env (never committed)
const isProd = process.env.NODE_ENV === 'production'; // read AFTER .env is loaded
const db = openDb(process.env.DATABASE_PATH || path.join(here, '..', 'data', 'queueless.db'));
seedServices(db);

// ---- accounts ----
// Production: only accounts from environment variables; weak/default credentials are refused.
// Development: documented demo accounts are created for local testing.
if (isProd) {
  const { ADMIN_USERNAME: au, ADMIN_PASSWORD: ap, STAFF_USERNAME: su, STAFF_PASSWORD: sp } = process.env;
  if (!au || !ap || ap.length < 12) {
    console.error('Refusing to start: set ADMIN_USERNAME and ADMIN_PASSWORD (12+ characters) in production.');
    process.exit(1);
  }
  ensureUser(db, au, ap, 'admin');
  if (su && sp) {
    if (sp.length < 12) { console.error('STAFF_PASSWORD must be 12+ characters.'); process.exit(1); }
    ensureUser(db, su, sp, 'staff');
  }
} else {
  ensureUser(db, 'admin', 'Admin#Demo2026', 'admin');
  ensureUser(db, 'staff', 'Staff#Demo2026', 'staff');
  console.log('DEV demo accounts: admin / Admin#Demo2026   staff / Staff#Demo2026');
}

const num = (v, d) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
const app = createApp({
  db, isProd,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  distDir: path.join(here, '..', '..', 'frontend', 'dist'),
  loginMax: num(process.env.LOGIN_RATE_MAX, 5),
  tokenMax: num(process.env.TOKEN_RATE_MAX, 20),
});
const port = num(process.env.PORT, 4000);
app.listen(port, '0.0.0.0', () => console.log(`QueueLess listening on port ${port} (${isProd ? 'production' : 'development'})`));
