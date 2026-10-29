# QueueLess - Security & Safety

All controls below are enforced **on the server** (`backend/src/app.js`, `db.js`, `validate.js`). The frontend only displays results.

## Implemented protections

| Area | What is implemented |
|------|---------------------|
| Authentication | Staff/admin sign in with username + password. Passwords are stored as **bcrypt** hashes (cost 10). Unknown users still trigger a hash comparison so response timing does not reveal which usernames exist. |
| Sessions | Random 256-bit tokens in **HttpOnly, SameSite=Lax** cookies (`Secure` in production). Only a SHA-256 hash of each token is stored, so a leaked database does not leak live sessions. Staff sessions expire after 8 hours; logout deletes the session server-side. |
| Authorization (RBAC) | Roles: customer (anonymous session), `staff`, `admin`. Every `/api/staff/*` and `/api/admin/*` route checks the role: no session = **401**, customer or wrong role = **403**. Editing frontend code cannot grant access. |
| Input validation | Every field is type/length/pattern checked; unknown fields are rejected; ids must be positive integers; request bodies are capped at 10 KB; all SQL uses parameterised statements. Errors are generic JSON - no stack traces. |
| Rate limiting | Login: 5 **failed** attempts per 60 s per IP + username (then **429**). Token creation: 20 per 60 s per IP. General API: 300 per minute per IP. Configurable via env. |
| Queue integrity | Token numbers are assigned inside a database transaction (never taken from the browser). A **partial unique index** lets the database itself refuse a second active token for the same customer and counter. A server-side transition table allows only: waiting to called/skipped/cancelled; called to served/skipped. Updates are guarded (`WHERE status = expected`), so a token cannot be served twice or called after cancellation. |
| Privacy | Customers give at most a first name; staff see that name plus a random reference (e.g. `C-7F3K2`). A customer can read/cancel only their own tokens (anyone else gets 404, identical to "does not exist"). Public counter data contains no names. |
| Web hardening | Helmet headers (CSP, `nosniff`, frame protection, no `X-Powered-By`). Every write checks the `Origin` header (CSRF defence-in-depth alongside SameSite cookies). CORS is **closed** unless `ALLOWED_ORIGINS` lists exact origins. |
| Secrets & defaults | Production refuses to start without `ADMIN_PASSWORD` of 12+ characters; demo accounts exist only outside production. `.env`, databases and `node_modules` are git-ignored; `.env.example` holds placeholders only. API responses never include password hashes or session tokens. |

## How to demonstrate (Admin > Security & Safety > "Run all checks")

Each check calls the real API and shows the real HTTP status. Equivalent curl commands (local, port 4000):

```bash
B=http://localhost:4000; J='-H Content-Type:application/json'
# 1 Anonymous -> staff endpoint (expect 401)
curl -i $B/api/staff/overview
# 2 Customer -> staff operation (expect 403)
curl -i -c c.jar -X POST $B/api/customer/session
curl -i -b c.jar -X POST $B/api/staff/services/1/call-next
# 3 Invalid input (expect 400)
curl -i $J -d '{"serviceId":"1; DROP TABLE tickets","displayName":"<script>"}' $B/api/tickets
# 4 Rate limit (expect 401 x5, then 429)
for i in 1 2 3 4 5 6 7; do curl -s -o /dev/null -w "%{http_code} " $J -d '{"username":"demo-user","password":"wrong"}' $B/api/auth/login; done
# 5 Duplicate token (second call expect 409)
curl -i -b c.jar -c c.jar $J -d '{"serviceId":1}' $B/api/tickets; curl -i -b c.jar $J -d '{"serviceId":1}' $B/api/tickets
# 6 Invalid transition: sign in as staff, then serve a token that is still waiting (expect 409)
curl -c s.jar $J -d '{"username":"staff","password":"Staff#Demo2026"}' $B/api/auth/login
curl -i -b s.jar -X POST $B/api/staff/tickets/1/serve
```

The same scenarios are automated in `backend/test/queueless.test.js` (`npm test`).

## The `X-Act-As-Customer` header

The Security panel needs to act as a customer while you are signed in as admin in the same browser. Sending `X-Act-As-Customer: 1` makes the server **ignore the staff cookie** for that request. It can only *reduce* privileges; it cannot grant any. It is documented here so it is not mistaken for a backdoor.

## Known limitations (be upfront about these)

- **Customer identity is a browser cookie.** Clearing cookies gives a new anonymous identity, so duplicate-token protection is per browser session, limited by the per-IP token rate limit. A stronger version would verify phone/email (out of scope: no SMS/integrations).
- Rate-limit counters are kept in memory: they reset on restart and are not shared across multiple server instances.
- No multi-factor authentication, password reset, or account lockout beyond the login rate limit; no audit log.
- CSP allows inline styles (the Helmet default) for simplicity.
- `node:sqlite` is marked experimental by Node.js and prints a warning at startup.
- On free hosting with ephemeral disks, queue data is not durable (see README).
- No external penetration test has been performed; only the automated and manual checks listed in the README.
