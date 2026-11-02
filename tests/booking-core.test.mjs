import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBookingInput,
  getSlotCapacity,
  canTransition,
  createBooking,
  findExistingByIdempotencyKey,
} from '../booking-core.mjs';

const input = {
  date: '2026-11-03', time: '16:00', sale: 'Виноградова Н.',
  crmUrl: 'https://eduson.amocrm.ru/leads/detail/123', age: '9', phone: '+79991234567',
  createdBy: 'КЦ', idempotencyKey: 'cc-1',
};

test('validates the call-center booking fields', () => {
  assert.deepEqual(validateBookingInput(input), { ok: true, value: { ...input, age: 9, phone: '79991234567' } });
  assert.equal(validateBookingInput({ ...input, crmUrl: 'bad' }).ok, false);
  assert.equal(validateBookingInput({ ...input, age: '0' }).ok, false);
  assert.equal(validateBookingInput({ ...input, phone: '123' }).ok, false);
});

test('counts duplicate slot rows as available places', () => {
  const rows = [
    { date: '2026-11-03', time: '16:00', manager: 'Виноградова Н.', status: 'wait' },
    { date: '2026-11-03', time: '16:00', manager: 'Виноградова Н.', status: 'wait' },
  ];
  assert.equal(getSlotCapacity(rows, input), 2);
  assert.equal(getSlotCapacity(rows, { ...input, time: '17:00' }), 0);
});

test('allows only the intended status transitions', () => {
  assert.equal(canTransition('pending_confirmation', 'confirmed'), true);
  assert.equal(canTransition('pending_confirmation', 'rejected'), true);
  assert.equal(canTransition('confirmed', 'rejected'), false);
  assert.equal(canTransition('rejected', 'confirmed'), false);
});

test('creates a pending booking and assigns a place', () => {
  const booking = createBooking(input, 1);
  assert.match(booking.bookingId, /^booking-/);
  assert.equal(booking.status, 'pending_confirmation');
  assert.equal(booking.place, 1);
  assert.equal(booking.age, 9);
  assert.equal(booking.phone, '79991234567');
});

test('finds an idempotent retry', () => {
  const existing = { bookingId: 'booking-1', idempotencyKey: 'cc-1' };
  assert.equal(findExistingByIdempotencyKey([existing], 'cc-1'), existing);
  assert.equal(findExistingByIdempotencyKey([existing], 'cc-2'), undefined);
});
