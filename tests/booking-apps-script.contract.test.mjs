import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../booking-apps-script.gs', import.meta.url), 'utf8');

test('Apps Script gates creation but exposes confirmation transitions to all mapped roles', () => {
  assert.match(source, /body\.action === 'create'/);
  assert.match(source, /body\.action === 'confirm' \|\| body\.action === 'reject'/);
  assert.match(source, /actor\.role !== 'call_center'/);
  assert.doesNotMatch(source, /actor\.role !== 'confirmation_manager'/);
  assert.match(source, /status === 'pending_confirmation'/);
});

test('Apps Script serializes writes and checks idempotency and capacity', () => {
  assert.match(source, /LockService\.getScriptLock/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /Свободных мест в этом слоте больше нет/);
  assert.match(source, /SpreadsheetApp\.openById/);
  assert.match(source, /DocumentApp\.openById/);
});

test('Apps Script formats booking date and time for the client', () => {
  assert.match(source, /function bookingDate_/);
  assert.match(source, /dd\.MM\.yyyy/);
  assert.match(source, /function bookingTime_/);
  assert.match(source, /HH:mm/);
});
