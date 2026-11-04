import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { createApp } from '../server.mjs';

test('confirmation auto-assigns a primary sales lesson and publishes a realtime change', async t => {
  const db = await openDatabase({ memory: true });
  const app = await createApp({ db, now: () => new Date('2030-01-01T06:00:00Z'), enableWorkers: false });
  t.after(async () => { await app.close(); await db.close(); });

  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const password = 'Realtime assignment test 2030';
  const users = {};
  for (const [key, role] of Object.entries({ admin: 'admin', confirmation: 'confirmation', sales: 'sales' })) {
    const user = await app.auth.createUser({ id: 'system', role: 'admin' }, { email: `${key}@realtime.test`, name: key, role, password });
    const response = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
    assert.equal(response.status, 200);
    users[key] = { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0], user };
  }

  async function request(key, path, method = 'GET', input, expected = 200) {
    const session = users[key];
    const response = await fetch(base + path, {
      method,
      headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      ...(input ? { body: JSON.stringify(input) } : {})
    });
    const body = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${body}`);
    return body ? JSON.parse(body) : null;
  }

  await request('admin', '/api/schedule', 'PUT', {
    managerId: users.sales.user.id,
    date: '2030-01-02',
    intervals: [{ start: '12:00', end: '13:00' }],
    reserveCapacity: 1
  });
  const created = await request('admin', '/api/bookings', 'POST', {
    date: '2030-01-02', time: '12:00', studentName: 'Realtime student', parentName: 'Realtime parent',
    phone: '+79990000000', crmUrl: 'https://eduson.amocrm.ru/leads/detail/42', age: 10,
    hasPc: true, parentPresent: true, idempotencyKey: 'realtime-assignment-test'
  }, 201);

  const events = await fetch(`${base}/api/events`, { headers: { cookie: users.sales.cookie } });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let initial = '';
  while (!initial.includes('\n\n')) initial += decoder.decode((await reader.read()).value || new Uint8Array(), { stream: true });
  assert.match(initial, /event: changed/);

  const confirmed = await request('confirmation', `/api/bookings/${created.booking.id}/confirm`, 'POST', { version: created.booking.version });
  assert.equal(confirmed.booking.assignedTo, users.sales.user.id);
  assert.equal(confirmed.booking.assignmentKind, 'primary');

  let change = '';
  while (!change.includes('event: changed')) change += decoder.decode((await reader.read()).value || new Uint8Array(), { stream: true });
  assert.match(change, /event: changed/);
  await reader.cancel();
});
