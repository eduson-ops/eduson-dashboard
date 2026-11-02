import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const csvStart = html.indexOf('function parseCSV(txt) {');
const csvEnd = html.indexOf('async function fetchCSV', csvStart);
const dateStart = html.indexOf('function fmtDate(d){');
const dateEnd = html.indexOf('const pct =', dateStart);
const parseDateStart = html.indexOf('function parseDate(s) {');
const parseDateEnd = html.indexOf('// Robust AMO CRM', parseDateStart);
const context = {};
const parseCSV = vm.runInNewContext(`${html.slice(csvStart, csvEnd)}\nparseCSV`, context);
const dateFns = vm.runInNewContext(`${html.slice(dateStart, dateEnd)}\n${html.slice(parseDateStart, parseDateEnd)}\n({normDate, parseDate})`, context);

test('CSV parser keeps multiline quoted fields aligned', () => {
  const csv = '"manager","notes"\n"МВП","первая строка\nвторая, строка"\n"Андрей","ok"';
  assert.deepEqual(JSON.parse(JSON.stringify(parseCSV(csv))), [
    ['manager', 'notes'],
    ['МВП', 'первая строка\nвторая, строка'],
    ['Андрей', 'ok'],
  ]);
});

test('date parser handles ISO and dashboard dates', () => {
  assert.equal(dateFns.normDate('2026-11-02T15:51:38.000Z'), '02.11.2026');
  assert.equal(dateFns.parseDate('2026-11-02T15:51:38.000Z').getFullYear(), 2026);
  assert.equal(dateFns.parseDate('02.11.2026').getMonth(), 10);
});
