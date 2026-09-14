import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ Date });
vm.runInContext(fs.readFileSync(new URL('../operations.js', import.meta.url), 'utf8'), context);
const build = options => {
  assert.equal(typeof context.OpsControl.buildSchedule, 'function', 'schedule aggregation is implemented');
  return JSON.parse(JSON.stringify(context.OpsControl.buildSchedule(options)));
};
const date = '2026-09-15';
const slot = (manager = 'Папашвили Д.', time = '12:00', day = date, extra = {}) => ({ date: day, time, manager, knownManager: true, ...extra });

test('pairs and triples count real bookings separately from primary slots and reserves', () => {
  const result = build({ date, rows: [slot(), slot(), slot('Перебейносов А.'), slot('Перебейносов А.'), slot('Перебейносов А.')] });
  assert.equal(result.bookingCount, 5);
  assert.equal(result.primaryCount, 2);
  assert.equal(result.reserveCount, 3);
  assert.deepEqual(result.groups.map(group => [group.manager, group.bookingCount, group.primaryCount, group.reserveCount]), [
    ['Папашвили Д.', 2, 1, 1], ['Перебейносов А.', 3, 1, 2],
  ]);
  assert.ok(result.groups.every(group => !('rows' in group) && !('primary' in group) && !('id' in group)));
});

test('separate managers, dates and minutes never become reserves for each other', () => {
  const result = build({ date, rows: [slot(), slot('Папашвили Давид'), slot('Папашвили Д.', '12:01'), slot('Папашвили Д.', '12:00', '2026-09-16')] });
  assert.equal(result.bookingCount, 3);
  assert.equal(result.primaryCount, 3);
  assert.equal(result.reserveCount, 0);
  assert.ok(result.groups.every(group => group.date === date));
});

test('normalizes time and exact name case/spacing without inferring identities', () => {
  const result = build({ date, rows: [slot('  Папашвили   Д. ', '9:00'), slot('папашвили д.', '09:00:30'), slot('Папашвили Д.', '10:00:00')] });
  assert.deepEqual(result.groups.map(group => [group.time, group.bookingCount]), [['09:00', 2], ['10:00', 1]]);
  assert.equal(result.reserveCount, 1);
});

test('shuffling rows preserves the complete aggregate and does not mutate source rows', () => {
  const rows = [slot('папашвили д.', '9:00'), slot('Папашвили Д.', '09:00:30'), slot('Перебейносов А.', '09:00'), slot('', '11:00'), slot('Не указан', '11:00')];
  const before = structuredClone(rows);
  assert.deepEqual(build({ date, rows }), build({ date, rows: [...rows].reverse() }));
  assert.deepEqual(rows, before);
});

test('fifteen bookings remain accounted for without truncation', () => {
  const rows = Array.from({ length: 15 }, (_, i) => slot('Папашвили Д.', `${8 + Math.floor(i / 2)}:00`));
  const result = build({ date, rows });
  assert.equal(result.bookingCount, 15);
  assert.equal(result.primaryCount, 8);
  assert.equal(result.reserveCount, 7);
  assert.equal(result.groups.reduce((sum, group) => sum + group.bookingCount, 0), 15);
  const distinct = build({ date, rows: Array.from({ length: 15 }, (_, i) => slot('Папашвили Д.', `${8 + i}:00`)) });
  assert.equal(distinct.groups.length, 15);
  assert.equal(distinct.bookingCount, 15);
});

test('empty input and invalid dates or clock values never invent bookings', () => {
  const empty = { date, groups: [], bookingCount: 0, primaryCount: 0, reserveCount: 0 };
  assert.deepEqual(build({ date, rows: [] }), empty);
  assert.deepEqual(build({ date, rows: [null, {}, slot(undefined, '24:00'), slot(undefined, '12:60'), slot(undefined, '12:00:60'), slot(undefined, '12:00 extra'), slot(undefined, '12:00', '2026-02-31'), slot(undefined, '12:00', `${date} extra`)] }), empty);
  assert.deepEqual(build({ date: '2026-02-31', rows: [slot()] }), { ...empty, date: '' });
  assert.deepEqual(build(), { ...empty, date: '' });
});

test('manager filter matches the canonical name exactly, not a shared surname', () => {
  const result = build({ date, manager: 'Папашвили Д.', rows: [slot(), slot('Папашвили Д.'), slot('Папашвили Давид'), slot('Папашвили А.'), slot('Перебейносов А.')] });
  assert.equal(result.bookingCount, 2);
  assert.equal(result.primaryCount, 1);
  assert.equal(result.reserveCount, 1);
});

test('unknown explicit names can group but missing manager labels cannot', () => {
  const rows = [slot('Новый Менеджер', '12:00', date, { knownManager: false }), slot('Новый Менеджер', '12:00', date, { knownManager: false }), slot(''), slot(undefined, '12:00', date, { manager: undefined }), slot('Не указан'), slot('не  указан')];
  const result = build({ date, rows });
  assert.equal(result.bookingCount, 6);
  assert.equal(result.primaryCount, 5);
  assert.equal(result.reserveCount, 1);
  assert.equal(result.groups.filter(group => group.manager === 'Не указан').length, 4);
});
