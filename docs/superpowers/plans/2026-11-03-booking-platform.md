# Booking platform implementation plan

> For agentic workers: use subagent-driven-development. User explicitly requested implementation now. Slack is deferred until booking is complete.

**Goal:** Working booking with four server-enforced roles, reference UI, schedules, confirmation, reserve, reports, PostgreSQL and existing analytics compatibility.

**Architecture:** Static vanilla-JS interface in `booking/`, same-origin Node HTTP API in `booking-server/`. PostgreSQL schema `eduson_booking` owns new records. Local review uses real embedded PostgreSQL via PGlite; production uses `DATABASE_URL` via pg. Existing dashboard is served at `/dashboard/`; existing GitHub Pages is preserved until verified release.

**Tech stack:** Node ESM, native HTTP/crypto/test, pg, PGlite. No Slack integration in this execution phase.

## Confirmed business rules

- Booking is the main work screen; dashboard is analytics.
- Roles: `call_center`, `confirmation`, `sales`, `admin`.
- Lessons last 60 minutes. Business timezone Europe/Moscow (UTC+3).
- Confirmations may happen early; deadline is start minus 2 hours.
- Two bookings may be confirmed per salesperson, one primary and one reserve. Only primary can start. Admin can reassign/promote with concurrency checks.
- Unconfirmed lessons that did not happen become cancelled after their scheduled interval and feed cancellation analytics. Deadline breach alone does not cancel a future lesson.
- Keep cancellation, confirmation, assignment, delivery and report facts separate.
- Reports use existing live Sheet headers: timestamp, teacher, date, time, CRM, recording, practice, age, package, payment method, agreement, objection, channel, amount net. Financial payments remain separate facts.
- Schedule screen supports day switches, multiple work intervals, age tags. Admin table matches supplied hourly columns. Sales actions match «Начать мастер-класс» and «Ученик не пришёл».
- Availability intervals use an exclusive end: a 20:00–21:00 interval permits a 20:00 lesson. Display admin hours 10:00–21:00 inclusive; a lesson at 21:00 requires availability through 22:00.
- Age tags are treated as eligible age ranges; empty tags mean all ages. This is an explicit working assumption, changeable without schema migration.

## Shared API contract

Base `/api`. JSON requests/responses; errors `{error,code?}` with HTTP status. Dates `YYYY-MM-DD`, times `HH:mm`. All authenticated mutations need `X-CSRF-Token`. Optimistic mutations carry `version`; stale version returns 409.

`GET /health` public. `POST /api/session/login {email,password}` -> `{user,csrfToken}` and HttpOnly session cookie. `GET /api/session` returns same identity. `POST /api/session/logout` clears it.

`GET /api/bootstrap` -> `{user,csrfToken,managers,config:{timezone,lessonMinutes,hours},sync}`.

`GET /api/bookings?from=&to=&date=&scope=active|completed|trash|all` -> `{bookings}` filtered by role. `POST /api/bookings` -> `{booking}`.

Create input: `{date,time,studentName,parentName,phone,crmUrl,age,hasPc,parentPresent,comment,idempotencyKey}`. No final salesperson selection by call center.

Booking object: `{id,date,time,startsAt,endsAt,studentName,parentName,phone,crmUrl,age,hasPc,parentPresent,comment,confirmationStatus,confirmationDueAt,confirmedAt,assignedTo,assignedName,assignmentKind,state,cancelReason,cancelSource,createdBy,createdAt,updatedAt,version,report}`. Confirmation `pending|confirmed`; assignment `primary|reserve|null`; state `scheduled|in_progress|completed|cancelled`.

`POST /api/bookings/:id/confirm {version}`. `POST .../assign {managerId,kind,version}` admin only. `POST .../start {version}` current primary salesperson. `POST .../complete {version}` marks held; report can follow. `POST .../cancel {reason,version}`; sales no-show uses reason `Ученик не пришёл`. `POST .../restore {version}` checks capacity again. `PUT .../report {practice,package,paymentMethod,agreement,objection,channel,amountNet,recordingUrl,version}`. These return `{booking}`.

`GET /api/slots?date=&age=` -> `{slots:[{date,time,capacity,used,remaining,primaryCapacity,reserveCapacity,confirmedCount}]}`. Create rechecks authoritative capacity.

`GET /api/schedule?managerId=&from=&to=` -> `{days:[{date,intervals:[{start,end}],reserveCapacity}],ageGroups}`. `PUT /api/schedule {managerId,date,intervals,ageGroups?,reserveCapacity?}` -> same updated day. Sales edits self; admin edits anyone. Assigned intervals cannot be silently deleted.

`GET /api/admin/stats?date=&tag=` -> `{hours:[{time,managers,capacity,total,reserve,confirmed,cancelledConfirmation,cancelledSales,completed,inProgress,assigned,unassigned,deficit}],totals}`. Counts use one canonical query; cancellations stay traceable by actor and reason.

`GET /api/users` admin -> `{users}`. `POST /api/users {name,email,role,password,ageGroups?}` admin; `PATCH /api/users/:id {name,role,active,ageGroups,password?}` admin. Never return password hashes. `GET /api/audit?bookingId=` admin. `GET /api/analytics/lessons` and `/cancellations` admin only -> `{lessons}` / `{cancellations}`; existing dashboard integration must be opt-in and never duplicate legacy rows by CRM alone.

`GET /api/events` SSE with cookie authentication. Send generic `changed` invalidation without customer payload; browser refetches role-filtered data. Heartbeat and reconnect supported.

## Task 1: Storage and domain

Owner: backend agent. Files: `booking-server/schema.sql`, `db.mjs`, `domain.mjs`, `booking-server/tests/domain.test.mjs`.

- [ ] Write failing behavioral tests for capacity, two simultaneous confirmations, reserve, ownership, reassignment, cancellation/restore and unconfirmed expiry.
- [ ] Run `node --test booking-server/tests/domain.test.mjs`; observe missing feature failure.
- [ ] Implement schema and `BookingService` API described below using parameterized SQL and transactions.
- [ ] Run tests; require zero failures. Include report idempotence and actual persistence reopen.

Export `openDatabase({databaseUrl,dataDir,memory})` -> `{query,transaction,close}`. `transaction(fn)` supplies `{query}`. Export `BookingService(db,{now?,random?})` with methods createBooking, confirmBooking, assignBooking, startBooking, completeBooking, cancelBooking, restoreBooking, saveReport, listBookings, listSlots, stats, saveSchedule, getSchedule, managers, expireUnconfirmed, listAudit, getAnalyticsLessons, getAnalyticsCancellations. Methods take `(actor,...args)` except expireUnconfirmed.

Users table contract: `eduson_booking.users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,role TEXT,password_hash TEXT,active BOOLEAN,age_groups JSONB,created_at TIMESTAMPTZ)`. API actor uses camel-case ageGroups. Domain errors expose `.status` and Russian `.message`.

Reports have stable booking_id and enqueue sync jobs. SQL outbox contract: `eduson_booking.sync_jobs(id TEXT PRIMARY KEY,booking_id TEXT,kind TEXT,version INT,status TEXT,attempts INT,last_error TEXT,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ)`. Kinds `booking|report|cancel`; status `pending|processing|done|error`; uniqueness `(booking_id,kind,version)`. Do not make live Google calls.

## Task 2: Interface

Owner: frontend agent. Files only `booking/index.html`, `booking/app.js`, `booking/styles.css`, optional focused frontend helper/tests under `booking/`.

- [ ] Implement login, navigation and role-specific pages against shared contract.
- [ ] Match screenshots: dark narrow sidebar, light grey background, white tabular rows, blue actions, tabs current/future/completed/schedule, calendar filters.
- [ ] Implement create, confirmation, salesperson actions/report, admin hour drilldown/reassign, schedule multiple intervals/age tags, users and trash.
- [ ] Persist drafts during refresh, handle API errors visibly, use DOM textContent/escaping, keep one idempotency key per create attempt.
- [ ] Verify JS parse and browser interactions using synthetic local data. Do not claim live integration before server run.

## Task 3: HTTP, auth, local runtime

Owner: root. Files `package.json`, `package-lock.json`, `.gitignore`, `booking-server/server.mjs`, `auth.mjs`, `demo.mjs`, `tests/http.test.mjs`.

- [ ] Write HTTP behavior tests first: unauthenticated read rejected, role tampering ignored, session/CSRF enforced, role-specific data filtered.
- [ ] Use `node:crypto.scrypt` passwords and random hashed session tokens. Set HttpOnly SameSite=Lax cookies; Secure when configured HTTPS. Origin check for mutations. Body size/rate limits. No hardcoded production accounts.
- [ ] Serve booking at `/`, assets under `/booking/`, existing dashboard at `/dashboard/`, keep other static material reachable without path traversal.
- [ ] Add bootstrap users only from explicit environment. Demo command seeds synthetic accounts in separate local database and advertises demo status.
- [ ] Implement event invalidation after committed mutations, automatic expiry worker, controlled shutdown.

## Task 4: Compatibility and review

Owner: root plus fresh reviewer. Files `booking-server/sheets-sync.mjs`, `booking-analytics-adapter.js`, deployment documentation.

- [ ] Implement durable outbox with retries, stable IDs and configured service-account path. No production Sheet writes during tests/review.
- [ ] Map reports and cancellations to exact existing headers. Keep payment facts distinct. Expose sync errors without secrets.
- [ ] Connect new reports to existing analytics once, using stable IDs and explicit legacy mapping; verify fixed data totals.
- [ ] Run old tests, new domain and HTTP tests. Browser-smoke all four role workflows and screenshot comparison.
- [ ] Fresh spec review, then code-quality review. Fix actionable findings and rerun affected checks.
- [ ] Package reproducible runtime and deployment instructions. Deploy only after actual VDS ownership/inventory is available; do not overwrite an unknown service.

## Release gate

One synthetic lesson must complete the full path: create -> confirm -> assign -> start -> held -> report -> PostgreSQL -> analytics. Reserve remains distinct and cannot start as primary concurrently. Cancel/restore and repeat saves keep one lesson. Unauthorized users cannot read/write other roles' data. VDS and production data remain unchanged until inventory and a verified release are possible.
