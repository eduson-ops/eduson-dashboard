import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const runtime = vm.createContext({});
const moduleUrl = new URL('../schedule-verification.js', import.meta.url);
if (fs.existsSync(moduleUrl)) vm.runInContext(fs.readFileSync(moduleUrl, 'utf8'), runtime);
const api = runtime.ScheduleVerification || {};
const header = ['Менеджер', 'Дата', 'Время'];
const rows = (...items) => [header, ...items];
const slot = (date, time) => ({ date, time });
const plain = value => JSON.parse(JSON.stringify(value));
function verify(expected, actualRows, extra = {}) {
  assert.equal(typeof api.verify, 'function', 'strict schedule verifier exists');
  return api.verify({ manager: 'A', expected, rows: actualRows, sourceState: 'success', ...extra });
}

test('requires every expected manager/date/hour, not an 80% threshold', () => {
  const expected = [9, 10, 11, 12, 13].map(hour => slot('15.09.2026', `${hour}:00`));
  const result = verify(expected, rows(...expected.slice(0, 4).map(s => ['A', s.date, s.time])));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.deepEqual(plain(result.missing), ['2026-09-15|13']);
});

test('exact match accepts equivalent date/hour notation and legitimate other-manager changes', () => {
  const result = verify([slot('15.09.2026', '09:00')], rows(['A', '2026-09-15', '9:00'], ['B', '16.09.2026', '12:00']));
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.schedule), { A: { '15.09.2026': { 9: true } }, B: { '16.09.2026': { 12: true } } });
});

test('extra hours and dates for the replaced manager prevent success', () => {
  const result = verify([slot('15.09.2026', '09:00')], rows(['A', '15.09.2026', '09:00'], ['A', '15.09.2026', '10:00'], ['A', '20.09.2026', '09:00']));
  assert.equal(result.ok, false);
  assert.deepEqual(plain(result.extra), ['2026-09-15|10', '2026-09-20|9']);
});

test('clear succeeds with a valid header-only source or rows for other managers', () => {
  assert.equal(verify([], rows()).ok, true);
  assert.equal(verify([], rows(['B', '15.09.2026', '09:00'])).ok, true);
  assert.equal(verify([], rows(['A', '15.09.2026', '09:00'])).ok, false);
});

test('explicit replacement range is inclusive and leaves same-manager dates outside the range alone', () => {
  const range = { from: '2026-09-15', to: '2026-09-16' };
  const actual = rows(['A', '14.09.2026', '08:00'], ['A', '15.09.2026', '09:00'], ['A', '17.09.2026', '10:00']);
  assert.equal(verify([slot('15.09.2026', '09:00')], actual, { range }).ok, true);
  assert.equal(verify([], actual, { range }).ok, false);
  assert.equal(verify([], rows(['A', '14.09.2026', '08:00']), { range }).ok, true);
  assert.equal(verify([slot('14.09.2026', '08:00')], actual, { range }).reason, 'invalid-expected');
});

test('failed, loading, or missing read status cannot confirm even an exact or empty match', () => {
  for (const sourceState of ['error', 'loading', undefined]) {
    assert.equal(verify([], rows(), { sourceState }).ok, false);
    assert.equal(verify([], rows(), { sourceState }).reason, 'unavailable');
  }
  assert.equal(verify([], []).ok, false);
  assert.equal(verify([], [['error', 'bad', 'response']]).ok, false);
});

test('malformed source rows cannot silently disappear into a clear or rounded hour', () => {
  const invalidRows = [
    ['A', '31.02.2026', '09:00'], ['A', '', '09:00'], ['A', '15.09.2026', '09:30'],
    ['A', '15.09.2026', '24:00'], ['', '15.09.2026', '09:00'], ['A', '15.09.2026'],
  ];
  for (const row of invalidRows) {
    const result = verify([], rows(row));
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.equal(result.reason, 'invalid-source');
  }
  assert.equal(verify([], rows(['', '', ''])).ok, true);
});

test('duplicate source rows within scope cannot masquerade as an exact set', () => {
  const expected = [slot('15.09.2026', '09:00')];
  const result = verify(expected, rows(['A', '15.09.2026', '09:00'], ['A', '15.09.2026', '9:00']));
  assert.equal(result.ok, false);
  assert.deepEqual(plain(result.duplicates), ['2026-09-15|9']);
  assert.equal(verify(expected, rows(['A', '15.09.2026', '09:00'], ['B', '15.09.2026', '10:00'], ['B', '15.09.2026', '10:00'])).ok, true);
});

test('invalid or duplicate expected input and reversed ranges never produce success', () => {
  assert.equal(verify([slot('15.09.2026', '09:30')], rows()).reason, 'invalid-expected');
  assert.equal(verify([slot('15.09.2026', '09:00'), slot('15.09.2026', '9:00')], rows()).reason, 'invalid-expected');
  assert.equal(verify([], rows(), { range: { from: '2026-09-16', to: '2026-09-15' } }).reason, 'invalid-expected');
});

test('manager matching stays exact and inputs are not mutated', () => {
  const expected = [slot('15.09.2026', '09:00')];
  const actual = rows(['A B', '15.09.2026', '09:00']);
  const before = JSON.stringify({ expected, actual });
  assert.equal(verify(expected, actual).ok, false);
  assert.equal(JSON.stringify({ expected, actual }), before);
});
