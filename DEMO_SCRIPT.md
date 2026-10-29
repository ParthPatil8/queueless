# QueueLess - 5-Minute Demo Script

## Before you start (2 minutes, not part of the 5)
1. Fresh data: stop the server, delete the `backend/data/` folder, run `npm start` (token numbers then start at 001).
2. Open **two browser windows** side by side: **Window A** = customer (make it narrow, like a phone), **Window B** = staff/admin. Both at `http://localhost:4000` (or your deployed URL).
3. Have the demo accounts ready: `staff / Staff#Demo2026`, `admin / Admin#Demo2026` (local only; on a deployed site use the credentials you set in the host's environment variables).
4. Do a dry run once. After the dry run, repeat step 1 so the numbers match this script.

## 0:00 - 0:40 | The problem
**Say:** "Physical queues waste time and give people no information. You cannot leave, and you do not know how long you will wait. QueueLess lets you keep your place digitally."
**Show:** Window A, home page. Point at the headline and the three demo counters (waiting count, estimated wait, now serving).

## 0:40 - 1:30 | Customer joins
1. Window A: on **General Enquiry** click **Join this queue**, type a first name (e.g. "Asha"), click **Get my token**.
   **Expected:** token page with **G-001**, status *Waiting*, People ahead **0**, "You are next".
2. Window B (or a private window): open the home page, join **General Enquiry** again with another name.
   **Expected:** token **G-002**, People ahead **1**, est. wait about 3 min.
**Say:** "The server assigns the token number and the position. The browser cannot choose or fake them."

## 1:30 - 2:30 | Staff calls and serves
1. Window B: **Staff sign in** (`staff` / `Staff#Demo2026`). **Expected:** staff dashboard; the General Enquiry tab shows 2 waiting.
2. Click **Call next**. **Expected:** G-001 becomes *Called*. Within about 3 seconds Window A shows "It is your turn" and the token is highlighted as *Called*.
3. Click **Mark served** on G-001. **Expected:** Window A shows *Served*; the Served count becomes 1.
4. In Window A press **Back to counters**, join again, then use **Cancel my token** -> **Yes, cancel my token**. **Expected:** status *Cancelled*; staff queue no longer lists it.
**Say:** "Every button here calls a real API and writes to the database. Cancelled and served tokens never count as waiting."

## 2:30 - 4:00 | Security demonstrations
1. Window B: sign out, sign in as `admin` / `Admin#Demo2026`. **Expected:** Admin overview with totals and counters.
2. Scroll to **Security & Safety**, read the protection cards (30 seconds).
3. Click **Run all checks** (takes a few seconds). **Expected: six green PASS results:**
   - 1 Anonymous staff request -> **401**
   - 2 Customer doing a staff action -> **403**
   - 3 Malicious input (`1; DROP TABLE...`, `<script>`) -> **400**
   - 4 Repeated bad logins -> **401 x5 then 429**
   - 5 Second active token for the same counter -> **409**
   - 6 Serving a token that is still waiting -> **409**
4. **Say:** "These are not animations. The page shows the real HTTP status the server returned; a PASS means the server refused the attack."
5. (Optional, 20 s) Show the same in a terminal: `curl -i http://localhost:4000/api/staff/overview` -> `401`.
6. Optional: in the Admin table click **Disable** on IT Helpdesk, then in Window A refresh: the counter disappears. Click **Enable** to restore it.

## 4:00 - 5:00 | Architecture and impact
**Show:** `PRESENTATION_OUTLINE.md` slide 5 diagram or a quick sketch.
**Say:** "React frontend, one Express server, SQLite database. Passwords are bcrypt-hashed, sessions are HttpOnly cookies, roles are checked on the server, input is validated, and the database itself blocks duplicate active tokens. It runs as a single deployable service. Honest limits: customer identity is a browser cookie, and free hosting may reset data. Next steps: SMS notifications, appointment booking, durable hosting."

## If something goes wrong
- **Check shows 429 for token creation:** you ran the panel many times in a minute; wait 60 s.
- **Check 4 shows no 429:** the throw-away username was already locked from a previous run; wait 60 s and re-run.
- **Check 6 says "skipped":** this browser already holds a non-waiting token; cancel it from the customer page and re-run.
- **Page will not load on free hosting:** the service was asleep; wait up to a minute and refresh. Open the URL a few minutes before presenting.
