import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../db.mjs';
import { createApp } from '../server.mjs';

test('four real sessions complete one lesson and reject cross-role or stale writes', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, now: () => new Date('2030-01-01T06:00:00Z'), enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const password = 'Eduson test password 2030';
  const system = { id: 'system', role: 'admin' };
  const admin = await app.auth.createUser(system, { email: 'admin@test.local', name: 'Администратор', role: 'admin', password });
  await app.auth.createUser(system, { email: 'kc@test.local', name: 'КЦ', role: 'call_center', password });
  await app.auth.createUser(system, { email: 'confirm@test.local', name: 'Подтверждение', role: 'confirmation', password });
  const sale = await app.auth.createUser(system, { email: 'sale@test.local', name: 'Сейл', role: 'sales', password });
  const other = await app.auth.createUser(system, { email: 'other@test.local', name: 'Другой сейл', role: 'sales', password });
  async function login(email) {
    const response = await fetch(base + '/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    return { ...data, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function request(session, path, method = 'GET', body, csrf = true) {
    const response = await fetch(base + path, { method, headers: { cookie: session?.cookie || '', ...(body ? { 'content-type': 'application/json' } : {}), ...(csrf && session ? { 'x-csrf-token': session.csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request(null, '/api/bookings')).status, 401);
  const a = await login(admin.email); const kc = await login('kc@test.local'); const c = await login('confirm@test.local'); const s = await login(sale.email); const o = await login(other.email);
  assert.equal((await request(kc, '/api/admin/stats?date=2030-01-02')).status, 403);
  assert.equal((await request(kc, '/api/users')).status, 403);
  assert.equal((await request(a, '/api/schedule', 'PUT', { managerId: sale.id, date: '2030-01-02', intervals: [{ start: '12:00', end: '14:00' }], reserveCapacity: 1 }, false)).status, 403);
  assert.equal((await request(a, '/api/schedule', 'PUT', { managerId: sale.id, date: '2030-01-02', intervals: [{ start: '12:00', end: '14:00' }], reserveCapacity: 1 })).status, 200);
  const input = { date: '2030-01-02', time: '12:00', studentName: 'Тестовый ученик', parentName: 'Тестовый родитель', phone: '+79990000001', crmUrl: 'https://eduson.amocrm.ru/leads/detail/999999', age: 10, hasPc: true, parentPresent: true, comment: 'Синтетический урок', idempotencyKey: 'http-full-flow-one', role: 'admin' };
  let created = await request(kc, '/api/bookings', 'POST', input);
  assert.equal(created.status, 201);
  let booking = created.body.booking;
  assert.equal(booking.confirmationStatus, 'pending');
  assert.equal((await request(a, `/api/users/${sale.id}`, 'PATCH', { active: false })).status, 409);
  assert.equal((await request(s, '/api/bookings')).body.bookings.length, 0);
  assert.equal((await request(kc, `/api/bookings/${booking.id}/confirm`, 'POST', { version: booking.version, role: 'confirmation' })).status, 403);
  assert.equal((await request(kc, '/api/bookings', 'POST', input)).body.booking.id, booking.id);
  let result = await request(c, `/api/bookings/${booking.id}/confirm`, 'POST', { version: booking.version });
  assert.equal(result.status, 200); booking = result.body.booking;
  assert.equal(booking.assignedTo, sale.id);
  assert.equal((await request(o, `/api/bookings/${booking.id}/start`, 'POST', { version: booking.version })).status, 403);
  assert.equal((await request(a, `/api/bookings/${booking.id}/assign`, 'POST', { managerId: sale.id, kind: 'primary', version: 1 })).status, 409);
  result = await request(s, `/api/bookings/${booking.id}/start`, 'POST', { version: booking.version });
  assert.equal(result.status, 200); booking = result.body.booking;
  assert.equal(booking.state, 'in_progress');
  result = await request(s, `/api/bookings/${booking.id}/complete`, 'POST', { version: booking.version });
  assert.equal(result.status, 200); booking = result.body.booking;
  result = await request(s, `/api/bookings/${booking.id}/report`, 'PUT', { version: booking.version, practice: 'Python', package: '12 занятий', paymentMethod: 'Без оплаты', agreement: 'Перезвонить завтра', objection: 'Нужно обсудить', channel: 'Сайт', amountNet: 0, recordingUrl: 'https://example.com/lesson-recording' });
  assert.equal(result.status, 200); booking = result.body.booking;
  assert.equal(booking.report.recordingUrl, 'https://example.com/lesson-recording');
  const facts = await request(a, '/api/analytics/lessons');
  assert.equal(facts.status, 200); assert.equal(facts.body.lessons.length, 1);
  assert.equal((await request(kc, '/api/analytics/lessons')).status, 403);
  const publicPage = await fetch(base + '/');
  assert.equal(publicPage.status, 200);
  assert.equal((await fetch(base + '/booking-server/schema.sql')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await request(a, '/api/users')).body.users.some(x => 'password_hash' in x), false);
  assert.equal((await request(a, `/api/users/${admin.id}`, 'PATCH', { active: false })).status, 409);
});

test('Russian JSON survives a UTF-8 character split between HTTP chunks', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0);
  await app.auth.createUser({ id: 'system', role: 'admin' }, { email: 'admin@chunk.test', name: 'Администратор', role: 'admin', password: 'Chunk password 2030' });
  const login = await fetch(`http://127.0.0.1:${port}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@chunk.test', password: 'Chunk password 2030' }) });
  const session = await login.json();
  const payload = Buffer.from(JSON.stringify({ name: 'Ученик', email: 'user@chunk.test', role: 'sales', password: 'Chunk password 2030' }));
  const split = payload.indexOf(Buffer.from('У')) + 1;
  const response = new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrfToken } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.write(payload.subarray(0, split));
    delay(30).then(() => req.end(payload.subarray(split)));
  });
  const result = await response;
  assert.equal(result.status, 201);
  assert.equal(result.body.user.name, 'Ученик');
});

test('confirmation history repair endpoint is admin-only and retry needs CSRF', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, enableWorkers: false, syncOptions: { enabled: true, confirmationHistoryEnabled: true, client: { request: async () => ({ values: [] }) } } });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`; const password = 'History endpoint password 2030'; const system = { id: 'system', role: 'admin' };
  const admin = await app.auth.createUser(system, { name: 'Администратор', email: 'history-endpoint-admin@test.local', role: 'admin', password });
  await app.auth.createUser(system, { name: 'Сейл', email: 'history-endpoint-sales@test.local', role: 'sales', password });
  async function login(email){const response=await fetch(base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});const body=await response.json();return{...body,cookie:response.headers.get('set-cookie').split(';')[0]};}
  const a=await login(admin.email),s=await login('history-endpoint-sales@test.local');
  const issues=await fetch(base+'/api/confirmation-history/issues',{headers:{cookie:a.cookie}});assert.equal(issues.status,200);assert.deepEqual((await issues.json()).issues,[]);
  assert.equal((await fetch(base+'/api/confirmation-history/issues',{headers:{cookie:s.cookie}})).status,403);
  assert.equal((await fetch(base+'/api/confirmation-history/retry',{method:'POST',headers:{cookie:a.cookie}})).status,403);
  const retry=await fetch(base+'/api/confirmation-history/retry',{method:'POST',headers:{cookie:a.cookie,'x-csrf-token':a.csrfToken}});assert.equal(retry.status,200);assert.equal((await retry.json()).processed,0);
});

test('existing same-origin material demos can still be embedded', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/materials/vibe-coding/demos/06_starship_arcade.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('parallel incorrect logins cannot exceed the ten-attempt limit', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0);
  const responses = await Promise.all(Array.from({ length: 16 }, () => fetch(`http://127.0.0.1:${port}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'missing@test.local', password: 'Wrong password 2030' }) })));
  assert.equal(responses.filter(x => x.status === 401).length, 10);
  assert.equal(responses.filter(x => x.status === 429).length, 6);
  await Promise.all(responses.map(x => x.arrayBuffer()));
});

test('legacy HTTP corrections preserve unknown facts and require an administrator for historical outcomes', async t => {
  const db = await openDatabase({ memory: true });
  let instant = new Date('2030-01-01T06:00:00Z');
  const app = await createApp({ db, now: () => instant, enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const system = { id: 'system', role: 'admin' }; const password = 'Legacy password 2030';
  const admin = await app.auth.createUser(system, { name: 'Администратор', email: 'admin@legacy.test', role: 'admin', password });
  const confirmation = await app.auth.createUser(system, { name: 'Подтверждение', email: 'confirm@legacy.test', role: 'confirmation', password });
  const sales = await app.auth.createUser(system, { name: 'Сейл', email: 'sales@legacy.test', role: 'sales', password });
  await app.service.saveSchedule(admin, { managerId: sales.id, date: '2030-01-02', intervals: [{ start: '12:00', end: '13:00', reserveCapacity: 0 }] });
  const original = await app.service.createBooking(admin, { date: '2030-01-02', time: '12:00', studentName: 'До переноса', parentName: 'До переноса', phone: '+79990000000', crmUrl: 'https://eduson.amocrm.ru/leads/detail/989898', age: 10, hasPc: true, parentPresent: true, idempotencyKey: 'legacy-http' });
  await db.query("UPDATE eduson_booking.bookings SET student_name='',parent_name='',phone='',has_pc=NULL,parent_present=NULL,created_by='legacy-import' WHERE id=$1", [original.id]);
  instant = new Date('2030-01-03T06:00:00Z');
  await db.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', ['legacy-http-import', original.id, 'legacy-import', 'admin', 'legacy_imported', JSON.stringify({ source: 'vds_sqlite', managerName: sales.name, capturedAt: instant.toISOString(), elapsedUnknown: true, raw: { privateNote: 'raw-only-in-audit' } }), instant]);
  async function login(email) {
    const res = await fetch(base + '/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200); return { ...(await res.json()), cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  async function request(session, action, method, input) {
    const res = await fetch(`${base}/api/bookings/${original.id}/${action}`, { method, headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() };
  }
  const a = await login(admin.email); const c = await login(confirmation.email);
  let result = await request(c, 'details', 'PUT', { version: original.version, studentName: 'Уточнённое имя' });
  assert.equal(result.status, 200);
  let record = result.body.booking;
  assert.equal(record.parentName, ''); assert.equal(record.phone, ''); assert.equal(record.parentPresent, null);
  assert.equal(record.legacy.elapsedUnknown, true); assert.equal('raw' in record.legacy, false);
  result = await request(c, 'resolve-legacy', 'POST', { version: record.version, outcome: 'completed', managerId: sales.id, reason: 'Проверена запись урока' });
  assert.equal(result.status, 403);
  result = await request(a, 'resolve-legacy', 'POST', { version: record.version, outcome: 'completed', managerId: sales.id, reason: 'Проверена запись урока' });
  assert.equal(result.status, 200); record = result.body.booking;
  assert.equal(record.state, 'completed'); assert.equal(record.confirmationStatus, 'pending'); assert.equal(record.confirmedAt, null);
  assert.equal(record.legacy.needsReview, false);
});
