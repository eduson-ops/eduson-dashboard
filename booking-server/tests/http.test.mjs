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
