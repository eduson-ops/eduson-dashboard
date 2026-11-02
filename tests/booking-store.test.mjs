import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingStore, BookingConflictError } from '../booking-store.mjs';

const booking = (key, place = 1) => ({
  bookingId: `booking-${key}`, idempotencyKey: key, date: '2026-11-03', time: '16:00',
  sale: 'Виноградова Н.', crmUrl: 'https://eduson.amocrm.ru/leads/detail/123', age: 9,
  phone: '79991234567', createdBy: 'КЦ', status: 'pending_confirmation', place,
});

test('stores a booking, returns the idempotent retry, and filters confirmation queue', async () => {
  const store = new BookingStore({ slots: [{ date: '2026-11-03', time: '16:00', manager: 'Виноградова Н.', status: 'wait' }] });
  const created = await store.create(booking('a'), '2026-11-03T10:00:00.000Z');
  assert.equal(created.bookingId, 'booking-a');
  assert.equal((await store.create(booking('a'))).bookingId, 'booking-a');
  assert.equal(store.list({ role: 'confirmation_manager' }).length, 1);
  assert.equal(store.list({ role: 'sales', sale: 'Виноградова Н.' }).length, 0);
  await store.transition('booking-a', 'confirmed');
  assert.equal(store.list({ role: 'sales', sale: 'Виноградова Н.' }).length, 1);
});

test('rejects the third booking when a slot has two places', async () => {
  const slots = [1, 2].map(place => ({ date: '2026-11-03', time: '16:00', manager: 'Виноградова Н.', status: 'wait', place }));
  const store = new BookingStore({ slots });
  await store.create(booking('a', 1));
  await store.create(booking('b', 2));
  await assert.rejects(() => store.create(booking('c')), BookingConflictError);
});
