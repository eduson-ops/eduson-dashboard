# Trial Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить безопасную запись на пробный урок для КЦ, подтверждение второй линией и выдачу подтверждённой записи сейлу.

**Architecture:** Статическая страница dashboard вызывает отдельный Apps Script booking endpoint. Endpoint атомарно проверяет ёмкость и пишет заявку в новую вкладку Sheets, затем добавляет резервную строку в Google Doc. Локальный dev-сервер повторяет контракт через JSON-файл; общая бизнес-логика живёт в небольшом модуле без зависимости от DOM.

**Tech Stack:** Vanilla HTML/CSS/JS, Google Apps Script, Google Sheets, Google Docs, Node.js built-in test runner.

---

### Task 1: Booking domain module

**Files:**
- Create: `booking-core.js`
- Create: `tests/booking-core.test.mjs`

- [ ] **Step 1: Write failing tests** for role permissions, field validation, slot capacity, idempotency and status transitions.
- [ ] **Step 2: Run `node --test tests/booking-core.test.mjs` and confirm the missing module failure.**
- [ ] **Step 3: Implement pure functions** `validateBookingInput`, `getSlotCapacity`, `canTransition`, `createBooking`, `findExistingByIdempotencyKey`.
- [ ] **Step 4: Run the focused test and confirm all domain tests pass.**
- [ ] **Step 5: Commit `test: define trial booking domain contract`.**

### Task 2: Dev booking transport

**Files:**
- Modify: `outputs/dashboard-classic-dev/server.mjs`
- Modify: `outputs/dashboard-classic-dev/dev-adapter.js`
- Create: `outputs/dashboard-classic-dev/dev-bookings.json`
- Create: `outputs/dashboard-classic-dev/tests/booking-api.test.mjs`

- [ ] **Step 1: Write failing API tests** for `POST /api/bookings`, confirmation and sales queue filtering.
- [ ] **Step 2: Run the tests and confirm 404/unsupported operation failures.**
- [ ] **Step 3: Add JSON persistence with a serialized write queue** and endpoints `POST /api/bookings`, `POST /api/bookings/:id/confirm`, `POST /api/bookings/:id/reject`, `GET /api/bookings?role=...`.
- [ ] **Step 4: Make the adapter route same-origin booking calls to the local API.**
- [ ] **Step 5: Run API tests and existing regression tests.**
- [ ] **Step 6: Commit `feat: add local trial booking transport`.**

### Task 3: Production Apps Script append endpoint

**Files:**
- Create: `booking-apps-script.gs`
- Create: `docs/booking-endpoint-setup.md`
- Create: `tests/booking-apps-script.contract.test.mjs`

- [ ] **Step 1: Write a contract test** that checks required headers, status names, idempotency key, capacity check and fields written to Sheets/Docs.
- [ ] **Step 2: Implement `doGet` and `doPost`** with `LockService`, `SpreadsheetApp`, `DocumentApp`, server-side validation and explicit CORS-safe JSON responses.
- [ ] **Step 3: Add setup instructions** for the spreadsheet ID, `Записи на пробный` tab, Google Doc ID, deployment URL, and role-specific dashboard configuration.
- [ ] **Step 4: Run the contract test and verify the Apps Script source has no secrets or hard-coded tokens.**
- [ ] **Step 5: Commit `feat: add sheets and docs booking endpoint`.**

### Task 4: Dashboard booking route and role views

**Files:**
- Modify: `index.html`
- Create: `booking-ui.js`
- Create: `tests/booking-ui.contract.test.mjs`

- [ ] **Step 1: Write failing DOM contract tests** for the route, fields, role views and confirmed-sale visibility.
- [ ] **Step 2: Add the navigation item and route container** without changing existing schedule IDs.
- [ ] **Step 3: Add role-aware forms and lists** using the booking transport, including loading, errors, confirmation and rejection states.
- [ ] **Step 4: Render confirmed bookings in the assigned sale schedule panel.**
- [ ] **Step 5: Run focused tests and the existing dashboard regression tests.**
- [ ] **Step 6: Commit `feat: add call center booking workflow`.**

### Task 5: Apply unslop visual pass

**Files:**
- Modify: `index.html`
- Create: `docs/unslop-dashboard-notes.md`

- [ ] **Step 1: Capture a baseline screenshot** with the unslop snapshot script.
- [ ] **Step 2: Remove decorative gradients, seasonal particles, excessive glow/shadow and emoji-only navigation while preserving semantic slot classes and DOM IDs.**
- [ ] **Step 3: Capture a second screenshot and compare booking, schedule, analytics and mobile layouts.**
- [ ] **Step 4: Run all tests and syntax checks.**
- [ ] **Step 5: Document attribution and visual decisions, then commit `style: apply unslop pass to sales dashboard`.**

### Task 6: End-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-trial-booking-design.md` only if evidence changes the design.

- [ ] **Step 1: Start the dev server and run the browser integration test.**
- [ ] **Step 2: Create two bookings for one two-place slot and verify the third is rejected.**
- [ ] **Step 3: Confirm one booking as the second line and verify it appears only for the assigned sale.**
- [ ] **Step 4: Verify the JSON backup and idempotent retry.**
- [ ] **Step 5: Run `git diff --check`, all tests, and inspect the final diff.**
