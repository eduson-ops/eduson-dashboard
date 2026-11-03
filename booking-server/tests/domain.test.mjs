import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.mjs';
import { BookingService } from '../domain.mjs';

const admin = { id: 'admin', role: 'admin', name: 'Администратор' };
const caller = { id: 'caller', role: 'call_center', name: 'Колл-центр' };
const otherCaller = { id: 'caller2', role: 'call_center', name: 'Другой КЦ' };
const confirmer = { id: 'confirmer', role: 'confirmation', name: 'Подтверждение' };
const seller = { id: 'seller', role: 'sales', name: 'Продажи' };
const seller2 = { id: 'seller2', role: 'sales', name: 'Продажи 2' };
const date = '2026-11-10';
let inputSequence = 0;
const input = (extra = {}) => ({ date, time: '12:00', studentName: 'Ученик', parentName: 'Родитель', phone: '+79990000000', crmUrl: 'https://eduson.amocrm.ru/leads/detail/1', age: 10, hasPc: true, parentPresent: true, comment: '', idempotencyKey:`domain-test-${++inputSequence}`, ...extra });
const report = { practice: 'Scratch', package: '24 урока', paymentMethod: 'Без оплаты', agreement: 'Позвонить завтра', objection: '', channel: 'Звонок', amountNet: 0, recordingUrl: 'https://example.test/recording' };

async function fixture(t, options = {}) {
  const db = await openDatabase({ memory: true });
  t.after(() => db.close());
  for (const actor of [admin, caller, otherCaller, confirmer, seller, seller2]) {
    await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES ($1,$2,$3,$4,$5,true,$6)', [actor.id, `${actor.id}@example.test`, actor.name, actor.role, 'unused', JSON.stringify([])]);
  }
  let instant = new Date('2026-11-03T09:00:00Z');
  const service = new BookingService(db, { now: () => instant, random: () => 0, ...options });
  await service.saveSchedule(seller, { managerId: seller.id, date, intervals: [{ start: '10:00', end: '15:00' }], reserveCapacity: 1 });
  return { db, service, setNow: (value) => { instant = new Date(value); } };
}

test('pending pool consumes capacity atomically and creation key is idempotent', async t => {
  const { service } = await fixture(t);
  const first = await service.createBooking(caller, input({ idempotencyKey: 'repeat-key' }));
  assert.equal(first.confirmationStatus, 'pending');
  assert.equal(first.assignedTo, null);
  assert.equal(first.startsAt, '2026-11-10T09:00:00.000Z');
  assert.equal(first.confirmationDueAt, '2026-11-10T07:00:00.000Z');
  assert.equal((await service.createBooking(caller, input({ idempotencyKey: 'repeat-key' }))).id, first.id);
  const attempts = await Promise.allSettled([service.createBooking(caller, input()), service.createBooking(caller, input())]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.status, 409);
  const slot = (await service.listSlots(caller, { date, age: 10 })).find(s => s.time === '12:00');
  assert.deepEqual([slot.capacity, slot.used, slot.remaining], [2, 2, 0]);
});

test('simultaneous confirmations assign one primary and one reserve; reserve cannot start', async t => {
  const { service, setNow } = await fixture(t);
  const a = await service.createBooking(caller, input());
  const b = await service.createBooking(caller, input());
  const confirmed = await Promise.all([service.confirmBooking(confirmer, a.id, { version: a.version }), service.confirmBooking(confirmer, b.id, { version: b.version })]);
  assert.deepEqual(confirmed.map(v => v.assignmentKind).sort(), ['primary', 'reserve']);
  assert.ok(confirmed.every(v => v.assignedTo === seller.id && v.confirmationStatus === 'confirmed'));
  const primary = confirmed.find(v => v.assignmentKind === 'primary');
  const reserve = confirmed.find(v => v.assignmentKind === 'reserve');
  setNow('2026-11-10T09:00:00Z');
  await assert.rejects(service.startBooking(seller, reserve.id, { version: reserve.version }), { status: 409 });
  const started = await service.startBooking(seller, primary.id, { version: primary.version });
  assert.equal(started.state, 'in_progress');
  await assert.rejects(service.assignBooking(admin, reserve.id, { managerId: seller.id, kind: 'primary', version: reserve.version }), { status: 409 });
});

test('ownership and optimistic versions protect mutations and role-filtered reads', async t => {
  const { service } = await fixture(t);
  const b = await service.createBooking(caller, input());
  await assert.rejects(service.confirmBooking(caller, b.id, { version: b.version }), { status: 403 });
  await assert.rejects(service.cancelBooking(otherCaller, b.id, { reason: 'Отказ', version: b.version }), { status: 403 });
  const c = await service.confirmBooking(confirmer, b.id, { version: b.version });
  await assert.rejects(service.cancelBooking(seller2, c.id, { reason: 'Отказ', version: c.version }), { status: 403 });
  await assert.rejects(service.cancelBooking(confirmer, c.id, { reason: 'Отказ', version: b.version }), { status: 409 });
  assert.equal((await service.listBookings(otherCaller, { scope: 'all' })).length, 0);
  assert.equal((await service.listBookings(seller2, { scope: 'all' })).length, 0);
  assert.equal((await service.listBookings(seller, { scope: 'all' })).length, 1);
  assert.equal((await service.listBookings(admin, { scope: 'all', id: c.id })).length, 1);
  assert.equal((await service.listBookings(admin, { scope: 'all', id: 'missing' })).length, 0);
});

test('admin reassignment checks eligible ages and accepts once under a version race', async t => {
  const { service, db } = await fixture(t);
  await service.saveSchedule(seller2, { date, intervals: [{ start: '12:00', end: '14:00' }], reserveCapacity: 1, ageGroups: ['12-15'] });
  const b = await service.createBooking(caller, input());
  const c = await service.confirmBooking(confirmer, b.id, { version: b.version });
  await assert.rejects(service.assignBooking(admin, c.id, { managerId: seller2.id, kind: 'primary', version: c.version }), { status: 409 });
  await db.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2', [JSON.stringify(['8-12']), seller2.id]);
  const attempts = await Promise.allSettled([service.assignBooking(admin, c.id, { managerId: seller2.id, kind: 'primary', version: c.version }), service.assignBooking(admin, c.id, { managerId: seller2.id, kind: 'primary', version: c.version })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await service.listBookings(seller, { scope: 'all' })).length, 0);
  assert.equal((await service.listBookings(seller2, { scope: 'all' })).length, 1);
});

test('cancel frees capacity, restore reacquires it, and reserve promotion preserves history', async t => {
  const { service } = await fixture(t);
  const first = await service.createBooking(caller, input());
  const a = await service.confirmBooking(confirmer, first.id, { version: first.version });
  const second = await service.createBooking(caller, input());
  const b = await service.confirmBooking(confirmer, second.id, { version: second.version });
  const cancelled = await service.cancelBooking(confirmer, a.id, { reason: 'Перенос клиента', version: a.version });
  const promoted = await service.assignBooking(admin, b.id, { managerId: seller.id, kind: 'primary', version: b.version });
  assert.equal(promoted.assignmentKind, 'primary');
  const restored = await service.restoreBooking(confirmer, cancelled.id, { version: cancelled.version });
  assert.equal(restored.assignmentKind, 'reserve');
  assert.equal(restored.cancelReason, null);
  assert.equal(restored.cancellation.reason, 'Перенос клиента');
  assert.equal(restored.cancellation.firstCancellation, true);
  await assert.rejects(service.restoreBooking(confirmer, restored.id, { version: restored.version }), { status: 409 });
  const history = await service.listAudit(admin, { bookingId: a.id });
  assert.ok(history.some(e => e.action === 'cancelled'));
  assert.ok(history.some(e => e.action === 'restored'));
  assert.equal((await service.getAnalyticsCancellations(admin)).length, 0);
});

test('restoring into a full pending pool fails without losing cancelled record', async t => {
  const { service } = await fixture(t);
  let b = await service.createBooking(caller, input());
  b = await service.cancelBooking(caller, b.id, { reason: 'Отказ', version: b.version });
  await service.createBooking(caller, input());
  await service.createBooking(caller, input());
  await assert.rejects(service.restoreBooking(caller, b.id, { version: b.version }), { status: 409 });
  assert.equal((await service.listBookings(caller, { scope: 'trash' }))[0].id, b.id);
});

test('expiry waits until interval end, cancels only unheld pending, preserves confirmed', async t => {
  const { service, setNow } = await fixture(t);
  const pending = await service.createBooking(caller, input());
  const another = await service.createBooking(caller, input({ time: '13:00' }));
  await service.confirmBooking(confirmer, another.id, { version: another.version });
  setNow('2026-11-10T07:01:00Z');
  assert.equal(await service.expireUnconfirmed(), 0);
  setNow('2026-11-10T10:00:00Z');
  assert.equal(await service.expireUnconfirmed(), 1);
  assert.equal(await service.expireUnconfirmed(), 0);
  const cancellations = await service.getAnalyticsCancellations(admin);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].bookingId, pending.id);
  assert.equal(cancellations[0].source, 'system');
});

test('exclusive schedule end and age groups control capacity; occupied intervals cannot be deleted', async t => {
  const { service } = await fixture(t);
  await service.saveSchedule(seller, { date, intervals: [{ start: '20:00', end: '21:00' }], reserveCapacity: 1, ageGroups: ['8-12'] });
  const slots = await service.listSlots(caller, { date, age: 10 });
  assert.equal(slots.find(s => s.time === '20:00').capacity, 2);
  assert.equal(slots.find(s => s.time === '21:00').capacity, 0);
  assert.equal((await service.listSlots(caller, { date, age: 15 })).find(s => s.time === '20:00').capacity, 0);
  let b = await service.createBooking(caller, input({ time: '20:00' }));
  b = await service.confirmBooking(confirmer, b.id, { version: b.version });
  await assert.rejects(service.saveSchedule(seller, { date, intervals: [], reserveCapacity: 1 }), { status: 409 });
  await assert.rejects(service.saveSchedule(seller, { managerId: seller2.id, date, intervals: [] }), { status: 403 });
});

test('completion and typed idempotent report produce one lesson and durable versioned outbox', async t => {
  const { service, db, setNow } = await fixture(t);
  let b = await service.createBooking(caller, input());
  b = await service.confirmBooking(confirmer, b.id, { version: b.version });
  setNow('2026-11-10T09:00:00Z');
  b = await service.startBooking(seller, b.id, { version: b.version });
  await assert.rejects(service.saveReport(seller, b.id, { ...report, version: b.version }), { status: 409 });
  b = await service.completeBooking(seller, b.id, { version: b.version });
  setNow('2026-11-10T11:00:00Z');
  await assert.rejects(service.saveReport(seller, b.id, { ...report, amountNet: '5000', version: b.version }), { status: 400 });
  await assert.rejects(service.saveReport(seller, b.id, { ...report, amountNet: -1, version: b.version }), { status: 400 });
  b = await service.saveReport(seller, b.id, { ...report, version: b.version });
  const again = await service.saveReport(seller, b.id, { ...report, version: b.version });
  assert.equal(again.version, b.version);
  assert.equal(again.report.bookingId, b.id);
  const lessons = await service.getAnalyticsLessons(admin);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].bookingId, b.id);
  assert.equal(lessons[0].amountNet, 0);
  assert.equal(lessons[0].completedAt, '2026-11-10T09:00:00.000Z');
  assert.equal((await db.query('SELECT * FROM eduson_booking.reports')).rows.length, 1);
  assert.equal((await db.query("SELECT * FROM eduson_booking.sync_jobs WHERE kind='report'")).rows.length, 1);
  const stats = await service.stats(admin, { date });
  assert.equal(stats.hours.find(h => h.time === '12:00').completed, 1);
  assert.equal(stats.hours.find(h => h.time === '12:00').managers, 1);
  await assert.rejects(service.getAnalyticsLessons(seller), { status: 403 });
});

test('database persists records and audit across a real embedded PostgreSQL reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'booking-domain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let db = await openDatabase({ dataDir: dir });
  await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES ($1,$2,$3,$4,$5,true,$6)', [seller.id, 'persist@example.test', seller.name, seller.role, 'unused', '[]']);
  let service = new BookingService(db, { now: () => new Date('2026-11-03T09:00:00Z') });
  await service.saveSchedule(admin, { managerId: seller.id, date, intervals: [{ start: '10:00', end: '15:00' }], reserveCapacity: 1 });
  const b = await service.createBooking(admin, input());
  await db.close();
  db = await openDatabase({ dataDir: dir });
  t.after(() => db.close());
  service = new BookingService(db);
  assert.equal((await service.listBookings(admin, { scope: 'all' }))[0].id, b.id);
  assert.equal((await service.listAudit(admin, { bookingId: b.id })).length, 1);
});

test('age matching preserves scarce pending slots while assigning a flexible-age booking', async t => {
  const { service } = await fixture(t);
  await service.saveSchedule(seller, { date, intervals: [{ start: '10:00', end: '15:00' }], ageGroups: ['8-12'] });
  await service.saveSchedule(seller2, { date, intervals: [{ start: '10:00', end: '15:00' }], ageGroups: ['12-15'] });
  const flexible = await service.createBooking(caller, input({ age: 12 }));
  await service.createBooking(caller, input({ age: 10 }));
  await service.createBooking(caller, input({ age: 10 }));
  await assert.rejects(service.createBooking(caller, input({ age: 10 })), { status: 409 });
  assert.equal((await service.listSlots(caller, { date, age: 10 })).find(s => s.time === '12:00').remaining, 0);
  assert.equal((await service.listSlots(caller, { date, age: 15 })).find(s => s.time === '12:00').remaining, 1);
  const confirmed = await service.confirmBooking(confirmer, flexible.id, { version: flexible.version });
  assert.equal(confirmed.assignedTo, seller2.id);
  assert.equal(confirmed.assignmentKind, 'primary');
  await service.createBooking(caller, input({ age: 15 }));
  await assert.rejects(service.createBooking(caller, input({ age: 15 })), { status: 409 });
});

test('simultaneous restores cannot overbook the last free pool place', async t => {
  const { service } = await fixture(t);
  let a = await service.createBooking(caller, input());
  let b = await service.createBooking(caller, input());
  a = await service.cancelBooking(caller, a.id, { reason: 'Перенос', version: a.version });
  b = await service.cancelBooking(caller, b.id, { reason: 'Перенос', version: b.version });
  await service.createBooking(caller, input());
  const attempts = await Promise.allSettled([service.restoreBooking(caller, a.id, { version: a.version }),service.restoreBooking(caller, b.id, { version: b.version })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await service.listBookings(admin, { scope: 'active' })).length, 2);
  assert.equal((await service.listBookings(admin, { scope: 'trash' })).length, 1);
});

test('transactional user changes preserve pending capacity and roll back incompatible age edits', async t => {
  const { service, db } = await fixture(t);
  await service.createBooking(caller, input());
  await service.createBooking(caller, input());
  await assert.rejects(db.transaction(async tx => {
    await tx.query('LOCK TABLE eduson_booking.bookings, eduson_booking.schedules, eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
    await tx.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2', [JSON.stringify(['13-15']), seller.id]);
    await service.validateCapacity(tx);
  }), { status: 409 });
  assert.deepEqual((await db.query('SELECT age_groups FROM eduson_booking.users WHERE id=$1', [seller.id])).rows[0].age_groups, []);
  await service.saveSchedule(seller2, { date, intervals: [{ start: '10:00', end: '15:00' }], reserveCapacity: 1 });
  await db.transaction(async tx => {
    await tx.query('LOCK TABLE eduson_booking.bookings, eduson_booking.schedules, eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
    await tx.query('UPDATE eduson_booking.users SET active=false WHERE id=$1', [seller.id]);
    await service.validateCapacity(tx);
  });
  assert.equal((await db.query('SELECT active FROM eduson_booking.users WHERE id=$1', [seller.id])).rows[0].active, false);
  const pending = await service.listBookings(admin, { scope: 'active' });
  const confirmed = await service.confirmBooking(confirmer, pending[0].id, { version: pending[0].version });
  assert.equal(confirmed.assignedTo, seller2.id);
});

test('stats deficit counts confirmed demand for eligible primary places instead of total capacity', async t => {
  const { service } = await fixture(t);
  await service.saveSchedule(seller, { date, intervals: [{ start: '10:00', end: '15:00' }], ageGroups: ['5-7'] });
  await service.saveSchedule(seller2, { date, intervals: [{ start: '10:00', end: '15:00' }], ageGroups: ['10-12'] });
  const a = await service.createBooking(caller, input({ age: 6 }));
  const b = await service.createBooking(caller, input({ age: 6 }));
  assert.equal((await service.stats(admin, { date })).hours.find(h => h.time === '12:00').deficit, 0);
  await service.confirmBooking(confirmer, a.id, { version: a.version });
  await service.confirmBooking(confirmer, b.id, { version: b.version });
  const hour = (await service.stats(admin, { date })).hours.find(h => h.time === '12:00');
  assert.deepEqual([hour.managers, hour.capacity, hour.confirmed, hour.reserve, hour.deficit], [2,4,2,1,1]);
  assert.equal((await service.stats(admin, { date, tag: '5-7' })).totals.deficit, 1);
  const reserve = (await service.listBookings(admin, { scope: 'active' })).find(booking => booking.assignmentKind === 'reserve');
  await service.cancelBooking(confirmer, reserve.id, { reason: 'Отказ', version: reserve.version });
  assert.equal((await service.stats(admin, { date })).totals.deficit, 0);
});

test('confirmation accepts before its deadline and rejects after the deadline or scheduled start', async t => {
  const { service, setNow } = await fixture(t);
  const before = await service.createBooking(caller, input());
  const boundary = await service.createBooking(caller, input());
  const later = await service.createBooking(caller, input({ time: '13:00' }));
  setNow('2026-11-10T06:59:59.999Z');
  assert.equal((await service.confirmBooking(confirmer, before.id, { version: before.version })).confirmationStatus, 'confirmed');
  setNow('2026-11-10T07:00:00.001Z');
  await assert.rejects(service.confirmBooking(confirmer, boundary.id, { version: boundary.version }), { status: 409 });
  setNow('2026-11-10T10:00:00.001Z');
  await assert.rejects(service.confirmBooking(confirmer, later.id, { version: later.version }), { status: 409 });
});

test('booking ages and age tags retain the supported inclusive 1–18 range', async t => {
  const { service, db } = await fixture(t);
  await service.saveSchedule(seller, { date, intervals: [{ start: '10:00', end: '15:00' }], ageGroups: ['1-2', '18'] });
  const baby = await service.createBooking(caller, input({ age: 1 }));
  assert.equal(baby.age, 1);
  assert.equal((await service.listSlots(caller, { date, age: 2 })).find(s => s.time === '12:00').remaining, 1);
  assert.equal((await service.createBooking(caller, input({ age: 18, time: '13:00' }))).age, 18);
  await assert.rejects(service.createBooking(caller, input({ age: 0 })), { status: 400 });
  await assert.rejects(service.createBooking(caller, input({ age: 19 })), { status: 400 });
  await assert.rejects(db.query('UPDATE eduson_booking.bookings SET age=0 WHERE id=$1', [baby.id]), { code: '23514' });
});

test('versioned schema migration widens existing age checks and preserves stored lessons', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'booking-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let db = await openDatabase({ dataDir: dir });
  await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES ($1,$2,$3,$4,$5,true,$6)', [seller.id,'migrate@example.test',seller.name,seller.role,'unused','[]']);
  let service = new BookingService(db, { now: () => new Date('2026-11-03T09:00:00Z') });
  await service.saveSchedule(admin, { managerId:seller.id,date,intervals:[{ start:'10:00',end:'15:00' }] });
  const original = await service.createBooking(admin,input());
  // Reproduce the persisted schema created before migration version 1 existed.
  await db.query('DELETE FROM eduson_booking.schema_migrations WHERE version=1');
  await db.query('ALTER TABLE eduson_booking.bookings DROP CONSTRAINT bookings_age_check');
  await db.query('ALTER TABLE eduson_booking.bookings ADD CONSTRAINT bookings_age_check CHECK (age BETWEEN 3 AND 18)');
  await db.close();
  db = await openDatabase({ dataDir:dir });
  t.after(() => db.close());
  service = new BookingService(db, { now: () => new Date('2026-11-03T09:00:00Z') });
  assert.equal((await service.listBookings(admin,{ scope:'all' }))[0].id, original.id);
  assert.equal((await service.createBooking(admin,input({ age:1 }))).age, 1);
  assert.ok((await db.query('SELECT version FROM eduson_booking.schema_migrations')).rows.some(row=>row.version===1));
});

test('analytics retains archived cancellation facts and distinguishes actor from assigned teacher', async t => {
  const { service, db } = await fixture(t);
  let booking = await service.createBooking(caller, input({ comment:'Родитель просит перезвонить вечером' }));
  booking = await service.confirmBooking(confirmer,booking.id,{ version:booking.version });
  booking = await service.cancelBooking(confirmer,booking.id,{ reason:'Клиент перенёс занятие',version:booking.version });
  // Historical/imported audit facts can contain a contact method beyond the current form.
  await db.query("UPDATE eduson_booking.audit_events SET payload=jsonb_set(payload,'{contactMethod}',to_jsonb($1::text)) WHERE booking_id=$2 AND action='cancelled'",['Телефон',booking.id]);
  await db.query('UPDATE eduson_booking.users SET name=$1 WHERE id=$2',['Новое имя сотрудника',confirmer.id]);
  const [fact] = await service.getAnalyticsCancellations(admin);
  assert.equal(fact.bookingId,booking.id);
  assert.equal(fact.assignedTeacher,seller.name);
  assert.equal(fact.cancellation.firstCancellation,true);
  assert.equal(fact.cancellation.reason,'Клиент перенёс занятие');
  assert.equal(fact.cancellation.comment,'Родитель просит перезвонить вечером');
  assert.equal(fact.cancellation.contactMethod,'Телефон');
  assert.equal(fact.cancellation.manager,confirmer.name);
  assert.equal(fact.cancellation.actorId,confirmer.id);
  assert.equal(fact.cancellation.actorRole,confirmer.role);
  assert.equal(fact.actorName,confirmer.name);
  assert.equal(fact.actorId,confirmer.id);
  assert.equal(fact.source,'confirmation');
  booking = await service.restoreBooking(confirmer,booking.id,{ version:booking.version });
  assert.equal((await service.getAnalyticsCancellations(admin)).length,0);
  assert.equal(booking.cancellation.manager,confirmer.name);
});

test('cancel restore and expiry enqueue both booking state and cancellation projections atomically', async t => {
  const { service, db, setNow } = await fixture(t);
  await service.saveSchedule(seller2,{ date,intervals:[{ start:'10:00',end:'15:00' }] });
  let original = await service.createBooking(caller,input());
  original = await service.confirmBooking(confirmer,original.id,{ version:original.version });
  assert.equal(original.assignedTo,seller.id);
  await db.query("UPDATE eduson_booking.sync_jobs SET status='done'");
  original = await service.cancelBooking(confirmer,original.id,{ reason:'Перенос',version:original.version });
  const pendingKinds = async booking => (await db.query("SELECT kind FROM eduson_booking.sync_jobs WHERE booking_id=$1 AND version=$2 AND status='pending' ORDER BY kind",[booking.id,booking.version])).rows.map(row=>row.kind);
  assert.deepEqual(await pendingKinds(original),['booking','cancel']);
  await db.query("UPDATE eduson_booking.sync_jobs SET status='done'");
  let replacement = await service.createBooking(caller,input());
  replacement = await service.confirmBooking(confirmer,replacement.id,{ version:replacement.version });
  assert.equal(replacement.assignedTo,seller.id);
  original = await service.restoreBooking(confirmer,original.id,{ version:original.version });
  assert.equal(original.assignedTo,seller2.id);
  assert.equal(original.state,'scheduled');
  assert.deepEqual(await pendingKinds(original),['booking','cancel']);
  const expiring = await service.createBooking(caller,input({ time:'13:00' }));
  await db.query("UPDATE eduson_booking.sync_jobs SET status='done'");
  setNow('2026-11-10T11:00:00Z');
  assert.equal(await service.expireUnconfirmed(),1);
  const [expired] = await service.listBookings(admin,{ id:expiring.id,scope:'trash' });
  assert.deepEqual(await pendingKinds(expired),['booking','cancel']);
});

test('create retains mandatory stable key AmoCRM URL and legacy phone validation', async t => {
  const { service } = await fixture(t);
  const invalid = [
    { idempotencyKey:undefined },
    { idempotencyKey:'   ' },
    { idempotencyKey:'x'.repeat(129) },
    { crmUrl:'' },
    { crmUrl:'https://example.test/leads/detail/1' },
    { crmUrl:'https://eduson.amocrm.ru.evil.test/leads/detail/1' },
    { crmUrl:String.raw`https://evil.test\.amocrm.ru/leads/detail/1` },
    { crmUrl:'https://evil.test?x=.amocrm.ru/leads/detail/1' },
    { crmUrl:'https://evil.test#.amocrm.ru/path' },
    { crmUrl:'https://eduson.amocrm.ru@evil.test/leads/detail/1' },
    { crmUrl:'https://.amocrm.ru/leads/detail/1' },
    { crmUrl:'https://eduson.amocrm.ru/leads/..' },
    { crmUrl:'https://eduson.amocrm.ru/' },
    { crmUrl:'http://eduson.amocrm.ru/leads/detail/1' },
    { crmUrl:'https://user:secret@eduson.amocrm.ru/leads/detail/1' },
    { phone:'не телефон' },
    { phone:'+123456789' },
    { phone:'+1234567890123456' }
  ];
  for (const values of invalid) await assert.rejects(service.createBooking(caller,input(values)),{ status:400 });
  const foreignPhone = '+1 (234) 567-890-12345';
  const payload = input({ phone:foreignPhone });
  const created = await service.createBooking(caller,payload);
  assert.equal(created.phone,foreignPhone);
  assert.equal((await service.createBooking(caller,payload)).id,created.id);
  assert.equal((await service.listBookings(caller)).length,1);
});
