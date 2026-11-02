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
const paymentStart = html.indexOf('function applyPaymentToLesson');
const paymentEnd = html.indexOf('async function loadAll', paymentStart);
const mvpStart = html.indexOf('function isMvp');
const mvpEnd = html.indexOf('function renderTeamTable', mvpStart);
const context = {};
const parseCSV = vm.runInNewContext(`${html.slice(csvStart, csvEnd)}\nparseCSV`, context);
const dateFns = vm.runInNewContext(`${html.slice(dateStart, dateEnd)}\n${html.slice(parseDateStart, parseDateEnd)}\n({normDate, parseDate, recordPeriodDate})`, context);
const applyPaymentToLesson = vm.runInNewContext(`${html.slice(paymentStart, paymentEnd)}\napplyPaymentToLesson`, context);
const mvpFns = vm.runInNewContext(`${html.slice(mvpStart, mvpEnd)}\n({isMvp, aggregateMvpRows, mergeMvpRows})`, context);

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

test('paid records use payment date for period filters', () => {
  const paid = {date: '31.10.2026', paid: true, paydate: '01.11.2026'};
  const unpaid = {date: '31.10.2026', paid: false, paydate: ''};
  assert.equal(dateFns.recordPeriodDate(paid).getDate(), 1);
  assert.equal(dateFns.recordPeriodDate(paid).getMonth(), 10);
  assert.equal(dateFns.recordPeriodDate(unpaid).getDate(), 31);
  assert.equal(dateFns.recordPeriodDate(unpaid).getMonth(), 9);
});

test('payment manager overrides an older lesson manager', () => {
  const lesson = {manager: 'Николаев Г.', rev: 0, paid: false, pack: '12 месяцев', practice: 'Vibe-coding'};
  const payment = {manager: 'Перебейносов А.', rev: 63051, paid: true, paytype: 'Рассрочка', paydate: '02.11.2026'};
  applyPaymentToLesson(lesson, payment);
  assert.equal(lesson.manager, 'Перебейносов А.');
  assert.equal(lesson.rev, 63051);
  assert.equal(lesson.paid, true);
  assert.equal(lesson.paydate, '02.11.2026');
});

test('paid MVP rows stay visible in the separate internal-sales block', () => {
  const base = mvpFns.aggregateMvpRows([
    {manager: 'МВП', paid: true, rev: 17811},
    {manager: 'МВП', paid: false, rev: 17811},
    {manager: 'Перебейносов А.', paid: true, rev: 63051},
  ], false);
  const merged = mvpFns.mergeMvpRows(base, []);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [{name: 'МВП', rev: 17811, paid: 1}]);
});
