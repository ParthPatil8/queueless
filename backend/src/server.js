import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, seedServices, ensureUser } from './db.js';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') }); // optional project-root .env (never committed)
const env = process.env;
const isProd = env.NODE_ENV === 'production'; // read AFTER .env is loaded
const flag = (v, d) => (v === undefined || v === '' ? d : v === 'true');
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// DATABASE_URL set -> PostgreSQL (e.g. Amazon RDS). Otherwise a SQLite file (DATABASE_PATH).
const db = openDb({
  url: env.DATABASE_URL,
  ssl: flag(env.DATABASE_SSL, false),
  file: env.DATABASE_PATH || path.join(here, '..', 'data', 'queueless.db'),
});
await db.init();
await seedServices(db);
console.log(`Database: ${db.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite'}`);

// ---- accounts ----
// Production: only accounts from environment variables; weak/default credentials are refused.
// Development: documented demo accounts are created for local testing.
if (isProd) {
  const { ADMIN_USERNAME: au, ADMIN_PASSWORD: ap, STAFF_USERNAME: su, STAFF_PASSWORD: sp } = env;
  if (!au || !ap || ap.length < 12) {
    console.error('Refusing to start: set ADMIN_USERNAME and ADMIN_PASSWORD (12+ characters) in production.');
    process.exit(1);
  }
  await ensureUser(db, au, ap, 'admin');
  if (su && sp) {
    if (sp.length < 12) { console.error('STAFF_PASSWORD must be 12+ characters.'); process.exit(1); }
    await ensureUser(db, su, sp, 'staff');
  }
} else {
  await ensureUser(db, 'admin', 'Admin#Demo2026', 'admin');
  await ensureUser(db, 'staff', 'Staff#Demo2026', 'staff');
  console.log('DEV demo accounts: admin / Admin#Demo2026   staff / Staff#Demo2026');
}

const app = createApp({
  db, isProd,
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  distDir: path.join(here, '..', '..', 'frontend', 'dist'),
  loginMax: num(env.LOGIN_RATE_MAX, 5),
  tokenMax: num(env.TOKEN_RATE_MAX, 20),
  logToConsole: true,
  logFormat: env.LOG_FORMAT === 'json' ? 'json' : 'text',
  cookieSecure: flag(env.COOKIE_SECURE, isProd),   // set false ONLY for plain-HTTP lab demos
  trustProxy: num(env.TRUST_PROXY, isProd ? 1 : 0), // 0 when exposed directly (no load balancer in front)
  forceHttps: flag(env.FORCE_HTTPS, false),
  s3: { bucket: env.S3_BUCKET, region: env.S3_REGION || env.AWS_REGION || 'us-east-1' },
  inDocker: env.RUNNING_IN_DOCKER === 'true',
});
const port = num(env.PORT, 4000);
const server = app.listen(port, '0.0.0.0', () => console.log(`QueueLess listening on port ${port} (${isProd ? 'production' : 'development'})`));

// Graceful shutdown (docker stop / EC2 stop / platform redeploys send SIGTERM)
const shutdown = (sig) => {
  console.log(`${sig} received, shutting down`);
  server.close(async () => { await db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
