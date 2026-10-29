# QueueLess - Smart Queue Management System

> Skip the physical line. Keep your place digitally.

QueueLess lets customers join a counter's queue from their phone, see their position and estimated wait, and get called by staff. Staff manage the queue; admins see totals, open/close counters, and run live security demonstrations.

**Stack:** React + Vite (frontend) - Node.js + Express (backend) - SQLite via Node's built-in `node:sqlite` (no native build step) - one service serves both API and UI (same origin, no CORS problems).

## Run locally (needs Node.js 22.13 or newer)

```bash
npm run build      # installs backend + frontend dependencies and builds the React app
npm start          # http://localhost:4000
```

Open http://localhost:4000. In local development the server prints and creates two **demo-only** accounts:

| Role  | Username | Password         |
|-------|----------|------------------|
| Admin | `admin`  | `Admin#Demo2026` |
| Staff | `staff`  | `Staff#Demo2026` |

These accounts are **never created when `NODE_ENV=production`**.

Development mode with hot reload (two terminals): `npm run install:all`, then `npm run dev:backend` (port 4000) and `npm run dev:frontend` (http://localhost:5173, proxies `/api` to the backend).

Tests: `npm run install:all && npm test` (11 backend tests: queue flow, authorization, validation, duplicates, transitions, privacy, rate limits, headers).

## Features

- **Customer** (no account, no personal data): view counters, join a queue, get a unique token (e.g. `G-004`), see status / people ahead / estimated wait (live, refreshes every few seconds), cancel while waiting. One active token per counter.
- **Staff** (sign in): see the active queue per counter, **Call next**, **Mark served**, **Skip**, live counts (waiting / called / served / skipped / cancelled).
- **Admin**: totals, enable/disable counters, add counters, and the **Security & Safety** panel with six live checks.
- Token statuses everywhere: `waiting`, `called`, `served`, `skipped`, `cancelled`.
- Estimated wait = people ahead x the counter's average minutes per customer (a simple estimate, not a prediction).

## Project layout

```
backend/src/   app.js (routes, auth, limits)  db.js (schema)  validate.js  server.js (startup)
backend/test/  queueless.test.js
frontend/src/  pages/ components/ api.js (central API helper) hooks.js styles.css
SECURITY.md  DEMO_SCRIPT.md  PRESENTATION_OUTLINE.md  render.yaml  .env.example
```

## Environment variables

Copy `.env.example` to `.env` for local production-mode testing. Never commit `.env`.

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `NODE_ENV=production` | host dashboard | Secure cookies, no demo accounts, strict startup checks |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | host dashboard (secret) | **Required in production.** Password must be 12+ characters or the server refuses to start |
| `STAFF_USERNAME`, `STAFF_PASSWORD` | host dashboard (secret) | Optional staff account (12+ char password) |
| `PORT` | set by the host | Port to bind (defaults to 4000) |
| `DATABASE_PATH` | host dashboard | SQLite file location (default `backend/data/queueless.db`) |
| `ALLOWED_ORIGINS` | host dashboard | Only if the frontend is on a different origin; empty = same-origin only |
| `LOGIN_RATE_MAX`, `TOKEN_RATE_MAX` | optional | Rate limits (defaults 5 failed logins/min, 20 tokens/min) |
| `VITE_API_URL` | build time, optional | Public API URL for a split deployment. Leave empty for the default. **Never put secrets here** - Vite exposes these to the browser |

## Deploy (Render, free tier - single service)

1. Push this folder to a GitHub repository (`.gitignore` already excludes `.env`, databases and `node_modules`).
2. On https://render.com: **New > Blueprint**, select the repo (it reads `render.yaml`), or **New > Web Service** with: Build Command `npm run build`, Start Command `npm start`, Health Check Path `/api/health`.
3. In the service's **Environment** tab set `NODE_ENV=production`, `NODE_VERSION=22`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (12+ chars), and optionally `STAFF_USERNAME` / `STAFF_PASSWORD`.
4. Deploy, then open the service URL. Check `https://YOUR-URL/api/health` returns `{"status":"ok"}` and sign in at `/staff/login`.

**Persistence - read this before presenting.** Render's free web services use an *ephemeral* disk and sleep after inactivity: the SQLite file (tokens, accounts' sessions) can be reset on restart or redeploy, and the first request after a sleep is slow. Services and admin/staff accounts are re-created automatically from the environment on boot, so the app still works, but queue history is lost. For durable data, use a plan with a persistent disk (mount it, e.g. at `/var/data`, and set `DATABASE_PATH=/var/data/queueless.db`) or another host with a volume. Free-tier terms change, so confirm current limits on the provider's site.

## Status of this build

| | |
|---|---|
| Implemented and tested locally | All features above; 11 automated backend tests passing; production build; end-to-end run with curl (join, call, serve, status, 401/403/400/409/429 responses, restart persistence); production-mode checks (weak/missing admin password refuses to start, demo accounts absent, `Secure` cookie, bad Origin refused) |
| Deployed and verified publicly | **Not done** - no hosting account or credentials were available in the build environment |
| Not verified | Visual/responsive appearance and the Security panel buttons in a real browser (build compiles, but no browser was available to click through) |
| Manual action needed | Create the hosting account, set the environment variables, deploy (steps above) |
