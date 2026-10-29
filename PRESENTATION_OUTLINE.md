# QueueLess - Presentation Outline (8 slides)

Rules for this deck: only claim what exists. Everything under "Implemented" is in the repository and was run; everything under "Future scope" is **not built**. Do not quote user numbers or performance figures - none were measured.

---
## Slide 1 - Title and team
**On slide:** QueueLess - Smart Queue Management System. *Skip the physical line. Keep your place digitally.* [Your name(s), roll no., guide, institute, date]
**Visual:** Logo (orange arrow tile) + screenshot of the home page.
**Speaker notes:** Introduce the team and the one-line idea. "We built a working queue system with real security controls, not just a mock-up."
**Likely questions:**
- *Why this topic?* Queues at college offices/help desks are a familiar, visible problem; it let us demonstrate full-stack work plus security.

## Slide 2 - Problem statement
**On slide:** People stand in physical lines with no visibility of position or wait. Staff cannot see demand. Paper tokens can be lost or duplicated. Shared systems also face abuse (spam tokens, unauthorised access).
**Visual:** Simple sketch of a crowded counter vs. a phone showing a token.
**Speaker notes:** Keep it relatable: waiting without information is the pain. Do not quote statistics unless you can cite a source.
**Questions:**
- *Do you have data on wait times saved?* No. We did not measure real-world impact; it is a prototype. The estimate shown to users is people ahead x average service time.

## Slide 3 - Proposed solution
**On slide:** Customers join from their phone, see live position and estimate, cancel anytime. Staff call, serve or skip. Admin monitors counters. Security built in.
**Visual:** Three-role diagram: Customer - Staff - Admin around one server.
**Speaker notes:** Scope was deliberately small: no payments, SMS or booking, so that the core and the security work reliably.
**Questions:**
- *How is it different from a paper token machine?* Remote visibility, cancellation, staff dashboard, and server-enforced rules.

## Slide 4 - Key features and user workflow
**On slide:** Flow: Choose counter -> Get token -> Wait (live status) -> Called -> Served. Staff: Call next / Mark served / Skip. Statuses: waiting, called, served, skipped, cancelled. One active token per counter per customer.
**Visual:** Screenshots: landing page, token page, staff dashboard. Add a status-flow diagram (waiting -> called -> served; waiting/called -> skipped; waiting -> cancelled).
**Speaker notes:** Walk the happy path. Mention the page refreshes every 3-5 seconds (polling) rather than WebSockets - simpler and reliable.
**Questions:**
- *Why polling?* Simple, robust, fine for this scale; WebSockets are future work.
- *How is the wait estimated?* Waiting people ahead x the counter's configured average minutes. It is an estimate, not a prediction.

## Slide 5 - Architecture and technology stack
**On slide:** React + Vite (UI) -> HTTPS -> Express API (auth, validation, rate limits, queue logic) -> SQLite. One service serves the API and the built UI (same origin).
**Visual:** Box diagram: Browser -> Express (middleware chain: Helmet, CORS, rate limit, auth, validation) -> SQLite file.
**Speaker notes:** Explain the middleware chain order. Tables: users, sessions, customers, services, tickets. Mention SQLite via Node's built-in module, chosen to avoid native build problems when deploying.
**Questions:**
- *Why SQLite?* Zero setup, transactional, enough for small-scale use. Limitation: single server and, on free hosting, possibly non-persistent disk.
- *Can it scale?* Not as-is. Moving to PostgreSQL and a shared rate-limit store would be the next step.
- *Why Express/React?* Widely used, simple to explain.

## Slide 6 - Security and safety features
**On slide:** bcrypt passwords - HttpOnly session cookies - server-side role checks (401/403) - input validation + parameterised SQL - rate limiting (429) - duplicate-token unique index + transactions - transition rules (409) - privacy by design - Helmet/Origin/CORS.
**Visual:** Screenshot of the Security & Safety panel with six PASS results. Table: attack -> protection -> HTTP response.
**Speaker notes:** Stress that checks hit the real backend. If asked about the `X-Act-As-Customer` header, explain it only reduces privilege (see SECURITY.md).
**Questions:**
- *What if someone edits the frontend?* Authorization is on the server, so a modified UI still gets 401/403.
- *How do you stop SQL injection?* Parameterised queries plus validation; we tested a `DROP TABLE` payload and got 400.
- *How are passwords stored?* bcrypt hashes; sessions stored only as SHA-256 hashes.
- *Can a customer bypass the duplicate rule?* By clearing cookies they get a new anonymous identity - a known limitation, bounded by the per-IP rate limit. Verified identity (SMS/email) would fix it.
- *Is it fully secure?* No system is. No external penetration test was done; see the limitations list.

## Slide 7 - Testing, demonstration results and limitations
**On slide:** 11 automated backend tests passing (flow, authorization, validation, duplicates, transitions, privacy, rate limits, headers). Manual end-to-end run with curl. Production-mode checks. **Limitations:** [fill in deployment status honestly]; free-hosting data may reset; cookie-based customer identity; no load testing; UI not formally accessibility-audited; browser click-through of the panel done by you before the demo.
**Visual:** Terminal screenshot of `npm test` output; table of the six demo checks and the actual status codes you saw.
**Speaker notes:** Quote only results you personally saw. Before presenting, run the panel yourself and put your real results on the slide.
**Questions:**
- *Did you load test?* No. State this plainly.
- *Is it deployed?* Answer based on what you actually did (see README status table).

## Slide 8 - Conclusion and future scope
**On slide:** Delivered: working end-to-end queue system with real, demonstrable security. **Future (not built):** SMS/WhatsApp alerts, QR join, appointment booking, multiple staff per counter, analytics, PostgreSQL + persistent hosting, MFA, audit logs, WebSocket updates.
**Visual:** Roadmap strip: Built now | Next | Later.
**Speaker notes:** End on impact: less physical waiting, clearer information, safer by design. Be clear that the right-hand roadmap items are plans, not features.
**Questions:**
- *What did you learn?* Server-side validation/authorization, transactions and database constraints for integrity, and deploying a full-stack app.
- *What would you do next?* Verified customer identity and durable database hosting.
