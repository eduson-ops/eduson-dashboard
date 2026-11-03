import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.mjs';
import { BookingService } from './domain.mjs';
import { CompensationService, getConfirmation } from './compensation.mjs';
import { OperationalPaymentService, createOperationalSynchronizer } from './operational-reports.mjs';
import { createAuth, createLoginLimiter, readCookie, cookieHeader, requireCsrf, checkOrigin, requestAddress } from './auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEM = { id: 'system', name: 'Система', role: 'admin' };
const BACKOFFICE = 'https://docs.google.com/spreadsheets/d/1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18/edit?gid=1367593612#gid=1367593612';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function admin(user) { if (user.role !== 'admin') fail('Доступ только администратору', 403); }
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail('Ожидается JSON', 415);
  const chunks = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > 64 * 1024) fail('Слишком большой запрос', 413); chunks.push(part); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') fail('Некорректный JSON'); return value; }
  catch { fail('Некорректный JSON'); }
}
function safePath(path) {
  if (path === '/' || path === '/booking' || path === '/booking/') return { path: resolve(ROOT, 'booking/index.html'), booking: true };
  if (path === '/dashboard' || path === '/dashboard/') return { path: resolve(ROOT, 'index.html'), dashboard: true };
  const trimmed = path.startsWith('/dashboard/') ? path.slice('/dashboard'.length) : path;
  const permitted = /^\/booking\/[a-zA-Z0-9_.-]+\.(?:html|js|mjs|css|svg|png|woff2)$/.test(trimmed)
    || /^\/materials\/[a-zA-Z0-9_./-]+$/.test(trimmed)
    || ['/booking-ui.js', '/booking-analytics-adapter.js'].includes(trimmed);
  if (!permitted || trimmed.includes('..') || trimmed.includes('\\')) return null;
  const target = resolve(ROOT, '.' + trimmed);
  return target.startsWith(ROOT + sep) ? { path: target, booking: trimmed.startsWith('/booking/') } : null;
}

export async function createApp({ db, now = () => new Date(), secureCookies = false, publicOrigin, trustProxy = false, demo = false, demoDate, enableWorkers = true, syncOptions } = {}) {
  if (!db) throw Error('Database is required');
  const service = new BookingService(db, { now });
  const payments = new OperationalPaymentService(db, { now });
  const compensation = new CompensationService(db, { now });
  const auth = await createAuth(db, { now, validateUserChange: async tx => { await service.validateCapacity(tx); await service.markSheetsDirty(tx); } });
  const limiter = createLoginLimiter();
  const subscribers = new Set(); let revision = 0; let closing = false; let workerBusy = false;
  let synchronizer = null; let scheduleSynchronizer = null;
  const operationalSynchronizer = createOperationalSynchronizer({ ...syncOptions, db, now, getPayment: id => payments.getPayment(id), getConfirmation: id => getConfirmation(db, id) });
  if (syncOptions?.enabled) {
    const { createSheetSynchronizer } = await import('./sheets-sync.mjs');
    const { createScheduleSheetSynchronizer } = await import('./sheet-schedule-sync.mjs');
    synchronizer = createSheetSynchronizer({ ...syncOptions, db, getBooking: async id => (await service.listBookings(SYSTEM, { id, scope: 'all' }))[0] });
    scheduleSynchronizer = createScheduleSheetSynchronizer({ ...syncOptions, db, getSnapshot: () => service.getSheetSnapshot(SYSTEM) });
  }
  function broadcast() {
    revision++;
    for (const stream of subscribers) stream.res.write(`id: ${revision}\nevent: changed\ndata: {"revision":${revision}}\n\n`);
  }
  async function syncStatus() {
    const result = await db.query("SELECT status,count(*)::int AS n FROM eduson_booking.sync_jobs GROUP BY status");
    const counts = Object.fromEntries(result.rows.map(x => [x.status, x.n]));
    const projections = (await db.query('SELECT status,count(*)::int AS n FROM eduson_booking.sheet_projections GROUP BY status')).rows;
    const projectionCounts = Object.fromEntries(projections.map(x => [x.status, x.n]));
    const status = synchronizer ? await synchronizer.status() : {};
    const schedule = scheduleSynchronizer ? await scheduleSynchronizer.status() : {};
    const operations = await operationalSynchronizer.status();
    const pending = (counts.pending || 0) + (counts.processing || 0) + (projectionCounts.pending || 0) + (projectionCounts.processing || 0) + operations.pending;
    const errors = (counts.error || 0) + (projectionCounts.error || 0) + operations.error;
    return { enabled: Boolean(synchronizer), pending, errors, error: errors, lastError: schedule.lastError || status.lastError || operations.lastError || null, schedule, operations };
  }
  async function worker() {
    if (workerBusy || closing) return;
    workerBusy = true;
    try {
      const expired = await service.expireUnconfirmed(now());
      if (Array.isArray(expired) ? expired.length : Number(expired) > 0) broadcast();
      const recovered = await service.reconcileCapacityHolds();
      if (recovered.promoted > 0) broadcast();
      if (scheduleSynchronizer) await scheduleSynchronizer.runOnce();
      if (synchronizer) {
        const started = Date.now();
        for (let i = 0; i < 8 && Date.now() - started < 10_000; i++) {
          const booking = await synchronizer.runOnce();
          const operation = await operationalSynchronizer.runOnce();
          if (!booking.processed && !operation.processed) break;
        }
      }
    } catch (error) { console.error('Booking background operation failed', /^[A-Z0-9_]{2,40}$/.test(error.code || '') ? error.code : 'WORKER_ERROR'); }
    finally { workerBusy = false; }
  }
  const timer = enableWorkers ? setInterval(worker, 15_000) : null;
  timer?.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname; const method = req.method;
      if (path === '/health') return json(res, { ok: true, service: 'eduson-booking', database: 'postgresql' });
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(method)) fail('Метод не разрешён', 405);
        const asset = safePath(decodeURIComponent(path));
        if (!asset || !(await stat(asset.path).catch(() => null))?.isFile()) fail('Страница не найдена', 404);
        let content = await readFile(asset.path);
        if (asset.dashboard) {
          const source = content.toString('utf8');
          content = Buffer.from(source.replace('<head>', '<head>\n<script src="/booking-analytics-adapter.js"></script>'));
        }
        if (asset.booking) res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        res.writeHead(200, { 'content-type': MIME[extname(asset.path)] || 'application/octet-stream', 'cache-control': asset.path.endsWith('.html') ? 'no-store' : 'public,max-age=300' });
        return res.end(method === 'HEAD' ? undefined : content);
      }
      res.setHeader('cache-control', 'no-store');
      if (path === '/api/session/login' && method === 'POST') {
        checkOrigin(req, publicOrigin);
        const ip = requestAddress(req, { trustProxy });
        const input = await body(req);
        if (limiter.blocked(ip)) fail('Слишком много попыток. Попробуйте через 15 минут', 429);
        limiter.failure(ip);
        const session = await auth.login(input.email, input.password);
        limiter.clear(ip);
        res.setHeader('set-cookie', cookieHeader(session.token, { secure: secureCookies }));
        return json(res, { user: session.user, csrfToken: session.csrfToken });
      }
      const token = readCookie(req.headers.cookie);
      const session = await auth.session(token);
      if (!session) fail('Войдите в букинг', 401);
      const user = session.user;
      if (!['GET', 'HEAD'].includes(method)) requireCsrf(req, session, { publicOrigin });
      if (path === '/api/session' && method === 'GET') return json(res, session);
      if (path === '/api/session/logout' && method === 'POST') {
        await auth.logout(token); res.setHeader('set-cookie', cookieHeader('', { secure: secureCookies, clear: true }));
        for (const stream of subscribers) if (stream.userId === user.id) stream.res.end();
        return json(res, { ok: true });
      }
      if (path === '/api/events' && method === 'GET') {
        for (const stream of [...subscribers].filter(x => x.userId === user.id).slice(0, -4)) stream.res.end();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache,no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 3000\nevent: changed\ndata: {"revision":${revision}}\n\n`);
        const stream = { res, userId: user.id }; subscribers.add(stream);
        const heartbeat = setInterval(async () => {
          try { if (!(await auth.session(token))) return res.end(); res.write(': heartbeat\n\n'); }
          catch { res.end(); }
        }, 20_000); heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); subscribers.delete(stream); });
        return;
      }
      if (path === '/api/bootstrap' && method === 'GET') return json(res, { ...session, managers: await service.managers(user), config: { timezone: 'Europe/Moscow', lessonMinutes: 60, hours: Array.from({ length: 12 }, (_, i) => `${i + 10}:00`), backofficeUrl: BACKOFFICE, dashboardUrl: '/dashboard/', demo, ...(demoDate ? { demoDate } : {}) }, sync: user.role === 'admin' ? await syncStatus() : { enabled: Boolean(synchronizer) } });
      const filter = Object.fromEntries(url.searchParams);
      if (path === '/api/bookings' && method === 'GET') return json(res, { bookings: await service.listBookings(user, filter) });
      if (path === '/api/bookings' && method === 'POST') {
        const booking = await service.createBooking(user, await body(req)); broadcast(); return json(res, { booking }, 201);
      }
      const match = path.match(/^\/api\/bookings\/([^/]+)\/(confirm|assign|start|complete|cancel|restore|report|details|resolve-legacy)$/);
      if (match && method === (['report','details'].includes(match[2]) ? 'PUT' : 'POST')) {
        const methods = { confirm: 'confirmBooking', assign: 'assignBooking', start: 'startBooking', complete: 'completeBooking', cancel: 'cancelBooking', restore: 'restoreBooking', report: 'saveReport', details: 'updateBookingDetails', 'resolve-legacy': 'resolveLegacy' };
        const booking = await service[methods[match[2]]](user, decodeURIComponent(match[1]), await body(req));
        broadcast(); return json(res, { booking });
      }
      if (path === '/api/slots' && method === 'GET') return json(res, { slots: await service.listSlots(user, filter) });
      if (path === '/api/schedule' && method === 'GET') return json(res, await service.getSchedule(user, filter));
      if (path === '/api/schedule' && method === 'PUT') {
        const day = await service.saveSchedule(user, await body(req)); broadcast(); return json(res, { day });
      }
      if (path === '/api/schedule/range' && method === 'PUT') {
        const result = await service.saveScheduleRange(user, await body(req)); broadcast(); return json(res, result);
      }
      if (path === '/api/compensation' && method === 'GET') return json(res, await compensation.get(user, filter));
      if (path === '/api/payments' && method === 'GET') return json(res, { payments: await payments.listPayments(user, filter) });
      if (path === '/api/payments' && method === 'POST') {
        const payment = await payments.createPayment(user, await body(req)); broadcast(); return json(res, { payment }, 201);
      }
      if (path === '/api/admin/stats' && method === 'GET') { admin(user); return json(res, await service.stats(user, filter)); }
      if (path === '/api/users' && method === 'GET') return json(res, { users: await auth.users(user) });
      if (path === '/api/users' && method === 'POST') { const created = await auth.createUser(user, await body(req)); broadcast(); return json(res, { user: created }, 201); }
      const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && method === 'PATCH') { const updated = await auth.updateUser(user, decodeURIComponent(userMatch[1]), await body(req)); broadcast(); return json(res, { user: updated }); }
      if (path === '/api/audit' && method === 'GET') { admin(user); return json(res, { events: await service.listAudit(user, filter) }); }
      if (path === '/api/sync' && method === 'GET') { admin(user); return json(res, await syncStatus()); }
      if (path === '/api/analytics/lessons' && method === 'GET') { admin(user); return json(res, { lessons: await service.getAnalyticsLessons(user, filter) }); }
      if (path === '/api/analytics/cancellations' && method === 'GET') { admin(user); return json(res, { cancellations: await service.getAnalyticsCancellations(user, filter) }); }
      if (path === '/api/analytics/snapshot' && method === 'GET') {
        admin(user);
        const bookings = await service.listBookings(user, { scope: 'all' });
        return json(res, { lessons: await service.getAnalyticsLessons(user, {}), cancellations: await service.getAnalyticsCancellations(user, {}), managedBookingIds: bookings.map(x => x.id) });
      }
      fail('Метод или страница не найдены', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (status === 500) console.error('Booking request failed', /^[A-Z0-9_]{2,40}$/.test(error.code || '') ? error.code : 'REQUEST_ERROR');
      json(res, { error: status === 500 ? 'Сервер не смог выполнить запрос. Повторите попытку' : error.message, ...(error.code && status < 500 ? { code: error.code } : {}) }, status);
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return {
    server, auth, service, payments, compensation, worker,
    async listen(port = 4180, host = '127.0.0.1') { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); }); return server.address().port; },
    async close() { closing = true; if (timer) clearInterval(timer); for (const stream of subscribers) stream.res.end(); if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}

async function main() {
  if (!process.env.DATABASE_URL && process.env.BOOKING_EMBEDDED !== '1') throw Error('Set DATABASE_URL for PostgreSQL, or BOOKING_EMBEDDED=1 for explicit local review');
  const db = await openDatabase({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.BOOKING_DATA_DIR || resolve(ROOT, '.booking-data') });
  const app = await createApp({ db, secureCookies: process.env.BOOKING_SECURE_COOKIES === '1', publicOrigin: process.env.BOOKING_PUBLIC_ORIGIN, trustProxy: process.env.BOOKING_TRUST_PROXY === '1', syncOptions: { enabled: process.env.BOOKING_SHEETS_SYNC === '1', serviceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_PATH, spreadsheetId: process.env.BOOKING_SHEET_ID, enrollmentSpreadsheetId: process.env.BOOKING_ENROLLMENT_SHEET_ID } });
  if (process.env.BOOKING_ADMIN_EMAIL && process.env.BOOKING_ADMIN_PASSWORD) {
    const existing = await db.query("SELECT id FROM eduson_booking.users WHERE role='admin' AND active=true LIMIT 1");
    if (!existing.rows.length) await app.auth.createUser(SYSTEM, { name: process.env.BOOKING_ADMIN_NAME || 'Администратор', email: process.env.BOOKING_ADMIN_EMAIL, password: process.env.BOOKING_ADMIN_PASSWORD, role: 'admin' });
  }
  const port = await app.listen(Number(process.env.PORT || 4180), process.env.HOST || '127.0.0.1');
  console.log(`Eduson booking: http://${process.env.HOST || '127.0.0.1'}:${port}`);
  let stopped = false;
  async function stop() { if (stopped) return; stopped = true; await app.close(); await db.close(); }
  process.on('SIGTERM', () => stop().then(() => process.exit(0))); process.on('SIGINT', () => stop().then(() => process.exit(0)));
}
const isMain = process.argv[1] && await Promise.all([realpath(resolve(process.argv[1])),realpath(fileURLToPath(import.meta.url))]).then(([entry,module])=>entry===module).catch(()=>false);
if (isMain) main().catch(error => { console.error(error.message); process.exitCode = 1; });
