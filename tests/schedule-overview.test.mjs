import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const runtime = vm.createContext({});
const moduleUrl = new URL('../schedule-overview.js', import.meta.url);
if (fs.existsSync(moduleUrl)) vm.runInContext(fs.readFileSync(moduleUrl, 'utf8'), runtime);
const api = runtime.ScheduleOverview || {};
const plain = value => JSON.parse(JSON.stringify(value));
const week = Array.from({ length: 7 }, (_, index) => `${14 + index}.09.2026`);
const build = (...args) => {
  assert.equal(typeof api.build, 'function', 'schedule overview aggregation exists');
  return plain(api.build(...args));
};
const filter = (...args) => {
  assert.equal(typeof api.filter, 'function', 'schedule overview filtering exists');
  return plain(api.filter(...args));
};
const rowsHtml = (...args) => {
  assert.equal(typeof api.rowsHtml, 'function', 'schedule overview rows renderer exists');
  return api.rowsHtml(...args);
};

test('keeps all 22 managers in source order without a card or row limit', () => {
  const managers = Array.from({ length: 22 }, (_, index) => `Менеджер ${index + 1}`);
  const schedule = Object.fromEntries(managers.slice(0, 20).map(name => [name, {
    [week[0]]: { 9: true, 10: true }, [week[2]]: { 12: true },
  }]));
  const result = build(managers, schedule, week);
  assert.deepEqual(result.rows.map(row => row.name), managers);
  assert.equal(result.managerCount, 22);
  assert.equal(result.totalHours, 60);
  assert.equal(result.emptyCount, 2);
  assert.deepEqual(result.rows[19], {
    name: 'Менеджер 20', total: 3, days: [2, 0, 1, 0, 0, 0, 0], activeDays: 2, dayCount: 7,
  });
  assert.equal((rowsHtml(result.rows).match(/<tr\b/g) || []).length, 22);
});

test('excludes MVP roles and removes repeated names while preserving people order', () => {
  const managers = ['Анна', 'МВП', 'мвп Иван', 'Борис', ' МВП\tОтдел ', 'Анна', 'Вера', 'Борис'];
  const schedule = Object.fromEntries(managers.map(name => [name, { [week[0]]: { 9: true } }]));
  const result = build(managers, schedule, week);
  assert.deepEqual(result.rows.map(row => row.name), ['Анна', 'Борис', 'Вера']);
  assert.equal(result.managerCount, 3);
  assert.equal(result.totalHours, 3);
  assert.equal(result.emptyCount, 0);
});

test('counts open hours only in the supplied dates and preserves their order', () => {
  const schedule = { Анна: {
    '13.09.2026': { 7: true, 8: true },
    [week[0]]: { 8: true, 9: false, 10: 0, 11: null },
    [week[1]]: { 12: true, 13: true },
    '21.09.2026': { 7: true, 8: true, 9: true },
  }, Борис: { '21.09.2026': { 9: true } } };
  const result = build(['Анна', 'Борис'], schedule, [week[1], week[0], week[2]]);
  assert.deepEqual(result.rows[0], { name: 'Анна', total: 3, days: [2, 1, 0], activeDays: 2, dayCount: 3 });
  assert.deepEqual(result.rows[1], { name: 'Борис', total: 0, days: [0, 0, 0], activeDays: 0, dayCount: 3 });
  assert.equal(result.emptyCount, 1);
  assert.equal(result.totalHours, 3);
});

test('missing schedules and no selected dates keep employees visible with zero hours', () => {
  const empty = build(['Анна', 'Борис'], undefined, week);
  assert.equal(empty.managerCount, 2);
  assert.equal(empty.emptyCount, 2);
  assert.equal(empty.totalHours, 0);
  assert.ok(empty.rows.every(row => row.days.length === 7 && row.total === 0));
  assert.deepEqual(build(['Анна'], { Анна: { [week[0]]: { 9: true } } }, []).rows,
    [{ name: 'Анна', total: 0, days: [], activeDays: 0, dayCount: 0 }]);
  assert.deepEqual(build([], {}, week), { rows: [], totalHours: 0, emptyCount: 0, managerCount: 0 });
});

test('search is case-insensitive and combines with the no-hours filter', () => {
  const result = build(['Анна Иванова', 'АННА Петрова', 'Борис'], {
    'Анна Иванова': { [week[0]]: { 9: true } },
  }, week);
  assert.deepEqual(filter(result.rows, { query: '  анНа ' }).map(row => row.name), ['Анна Иванова', 'АННА Петрова']);
  assert.deepEqual(filter(result.rows, { query: 'анна', emptyOnly: true }).map(row => row.name), ['АННА Петрова']);
  assert.deepEqual(filter(result.rows, { emptyOnly: true }).map(row => row.name), ['АННА Петрова', 'Борис']);
  assert.deepEqual(filter(result.rows, { query: 'Не существует' }), []);
  assert.deepEqual(filter(result.rows), result.rows);
  assert.equal(result.managerCount, 3);
  assert.equal(result.emptyCount, 2);
  assert.equal(result.totalHours, 1);
});

test('building and filtering do not mutate managers, schedules, dates or full rows', () => {
  const managers = ['Анна', 'МВП Иван', 'Анна', 'Борис'];
  const schedule = { Анна: { [week[0]]: { 9: true } } };
  const dates = [...week];
  const before = structuredClone({ managers, schedule, dates });
  const result = build(managers, schedule, dates);
  const beforeRows = structuredClone(result.rows);
  filter(result.rows, { query: 'Борис', emptyOnly: true });
  assert.deepEqual({ managers, schedule, dates }, before);
  assert.deepEqual(result.rows, beforeRows);
});

test('renders three semantic table cells with hours and visible-day counts', () => {
  const result = build(['Анна'], { Анна: { [week[0]]: { 9: true, 10: true } } }, week);
  const html = rowsHtml(result.rows);
  assert.match(html, /^<tr class="so-row">/);
  assert.equal((html.match(/<td\b/g) || []).length, 3);
  assert.match(html, />Анна<\/td>/);
  assert.match(html, />2 ч<\/td>/);
  assert.match(html, />1 из 7 дней<\/td>/);
  assert.ok(!html.includes('<table'));
  const shorter = build(['Анна'], { Анна: { [week[0]]: { 9: true } } }, week.slice(0, 3));
  assert.match(rowsHtml(shorter.rows), />1 из 3 дней<\/td>/);
});

test('zero hours have a text status and an empty row class', () => {
  const html = rowsHtml(build(['Борис'], {}, week).rows);
  assert.match(html, /^<tr class="so-row so-empty">/);
  assert.match(html, />Нет часов<\/td>/);
  assert.match(html, />0 из 7 дней<\/td>/);
});

test('escapes manager names and empty-state messages instead of injecting HTML', () => {
  const name = '<img src=x onerror="alert(1)"> & \'Имя\'';
  const html = rowsHtml(build([name], {}, week).rows);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;Имя&#39;'));
  assert.equal(rowsHtml([], '<b>Нет & "имён"</b>'),
    '<tr><td colspan="3" class="so-no-results">&lt;b&gt;Нет &amp; &quot;имён&quot;&lt;/b&gt;</td></tr>');
});

test('exports the same API to browser globals and CommonJS', () => {
  assert.equal(typeof api.build, 'function', 'browser API exists');
  const commonJs = vm.createContext({ module: { exports: {} } });
  vm.runInContext(fs.readFileSync(moduleUrl, 'utf8'), commonJs);
  assert.equal(commonJs.module.exports, commonJs.ScheduleOverview);
  assert.deepEqual(Object.keys(commonJs.module.exports).sort(), ['build', 'filter', 'rowsHtml']);
});
