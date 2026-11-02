import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../booking-apps-script.gs', import.meta.url), 'utf8');

test('Apps Script exposes role-gated create and transition actions', () => {
  assert.match(source, /body\.action === 'create'/);
  assert.match(source, /body\.action === 'confirm' \|\| body\.action === 'reject'/);
  assert.match(source, /actor\.role !== 'call_center'/);
  assert.match(source, /actor\.role !== 'confirmation_manager'/);
});

test('Apps Script serializes writes and checks idempotency and capacity', () => {
  assert.match(source, /LockService\.getScriptLock/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /Свободных мест в этом слоте больше нет/);
  assert.match(source, /SpreadsheetApp\.openById/);
  assert.match(source, /DocumentApp\.openById/);
});
