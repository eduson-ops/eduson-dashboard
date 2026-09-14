import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const moduleUrl = new URL('../operations.js', import.meta.url);
const context = vm.createContext({ Date });
if (fs.existsSync(moduleUrl)) vm.runInContext(fs.readFileSync(moduleUrl, 'utf8'), context);
const ops = context.OpsControl || {};
const available = name => assert.equal(typeof ops[name], 'function', `${name} is implemented`);
const plain = value => JSON.parse(JSON.stringify(value));
const sources = { slots: { state: 'success' }, form: { state: 'success' }, cancels: { state: 'success' } };

function csvParser() {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const runtime = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function parseCSV('), html.indexOf('async function fetchCSV(')), runtime);
  return runtime.parseCSV;
}

test('CSV preserves multiline quoted headers and fields, commas, escaped quotes and CRLF', async () => {
  const parse = csvParser();
  const headers = ['Отправлен', 'Менеджер', 'Дата', 'Время', 'CRM', 'Запись', 'Практика', 'Возраст', 'Пакет', 'Вариант оплаты', '\n\nДоговорённости с клиентом', 'Возражения', 'Причина отказа', 'Канал'];
  const encode = row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(',');
  const record = ['14.09.2026', 'A.', '14.09.2026', '10:00', 'https://crm.test/1', '', '', '', '', 'Payment', 'Первая строка, "цитата"\r\nВторая строка', '', 'No time', ''];
  const csv = '\uFEFF' + [headers, ...Array.from({length: 196}, () => record)].map(encode).join('\r\n') + '\r\n';
  const rows = parse(csv);
  assert.equal(rows.length, 197);
  assert.ok(rows.every(row => row.length === 14));
  assert.equal(rows[0][10], '\n\nДоговорённости с клиентом');
  assert.equal(rows[1][10], 'Первая строка, "цитата"\r\nВторая строка');
  assert.equal(rows[1][13], '');
  const source = await fetchSource({ ok: true, text: async () => csv });
  assert.equal(source.state.state, 'success');
  assert.equal(source.state.rowCount, 196);
  const report = ops.parseReports(rows)[0];
  assert.equal(report.paymentVariant, 'Payment');
  assert.equal(report.notes, 'No time');
});

test('CSV rejects an unfinished quoted record and keeps explicit empty trailing fields', () => {
  const parse = csvParser();
  assert.deepEqual(plain(parse('a,b,c\r\n\r\n1,"two, parts",\r\n2,"""quoted""",3')), [['a', 'b', 'c'], ['1', 'two, parts', ''], ['2', '"quoted"', '3']]);
  assert.throws(() => parse('a,b\n1,"unfinished\nsecond line'), /CSV|кавыч/i);
});

test('dates are strict and report timestamps retain their calendar date', () => {
  available('dateKey');
  assert.equal(ops.dateKey('14.09.2026 12:34:56'), '2026-09-14');
  assert.equal(ops.dateKey('2026-09-14T12:34:56+03:00'), '2026-09-14');
  assert.equal(ops.dateKey('9/14/2026'), '2026-09-14');
  assert.equal(ops.dateKey('31.02.2026'), '');
  assert.equal(ops.dateKey('2026-13-01'), '');
  assert.equal(ops.dateKey('14 сентября'), '');
});

test('today and tomorrow are recalculated across month and year boundaries', () => {
  available('selectedDate');
  assert.equal(ops.selectedDate('today', '', new Date('2026-12-31T20:59:00Z')), '2026-12-31');
  assert.equal(ops.selectedDate('tomorrow', '', new Date('2026-12-31T20:59:00Z')), '2027-01-01');
  assert.equal(ops.selectedDate('custom', '2026-09-10', new Date()), '2026-09-10');
  assert.equal(ops.selectedDate('custom', 'bad', new Date()), '');
});

test('operational days and offset timestamps use Moscow even in a UTC browser', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const now = new Date('2026-09-13T22:30:00Z');
    assert.equal(ops.selectedDate('today', '', now), '2026-09-14');
    assert.equal(ops.selectedDate('tomorrow', '', now), '2026-09-15');
    assert.equal(ops.dateKey('2026-09-13T22:30:00Z'), '2026-09-14');
    assert.equal(ops.dateKey('2026-09-14T00:30:00+10:00'), '2026-09-13');
    assert.equal(ops.dateKey('2026-02-31T22:30:00Z'), '');
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test('slots require an explicit valid date and time; names do not create identities', () => {
  available('parseSlots');
  const result = ops.parseSlots([
    ['Дата', 'Время', 'Менеджер', 'Статус'],
    ['14.09.2026', '9:00', '@known', 'done'],
    ['14.09.2026', '10:00', 'A. customer name', 'wait'],
    ['11:00', '@known', 'wait'],
    ['31.02.2026', '11:00', '@known', 'wait'],
    ['14.09.2026', '25:00', '@known', 'wait'],
  ], ['A.'], { '@known': 'A.' });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(plain(result.rows[0]), { date: '2026-09-14', time: '09:00', manager: 'A.', knownManager: true });
  assert.equal(result.rows[1].manager, 'A. customer name');
  assert.equal(result.rows[1].knownManager, false);
  assert.equal(result.invalidDates, 2);
  assert.equal(result.invalidTimes, 1);
  assert.equal(result.unknownManagers, 1);
  assert.equal('status' in result.rows[0], false);
});

test('slot full names match only a unique surname and first initial in the manager list', () => {
  const rawNames = ['Папашвили Давид', 'Никифорова Дарья', 'Иванов Дмитрий', 'Папашвили Алексей', 'Папашвили Давид / урок'];
  const result = ops.parseSlots([['Дата', 'Время', 'Менеджер', 'Статус'], ...rawNames.map(name => ['14.09.2026', '10:00', name, 'wait'])], ['Папашвили Д.', 'Никифорова Д.', 'Иванов Д.', 'Иванов Д.С.']);
  assert.equal(result.rows[0].manager, 'Папашвили Д.');
  assert.equal(result.rows[0].knownManager, true);
  assert.equal(result.rows[1].manager, 'Никифорова Д.');
  assert.equal(result.rows[1].knownManager, true);
  for (const index of [2, 3, 4]) {
    assert.equal(result.rows[index].manager, rawNames[index]);
    assert.equal(result.rows[index].knownManager, false);
  }
});

test('source failure preserves last success and distinguishes a valid empty sheet', () => {
  available('updateSource');
  const success = ops.updateSource(null, 'success', 1000, { rowCount: 0 });
  const loading = ops.updateSource(success, 'loading', 2000);
  const failure = ops.updateSource(loading, 'error', 2500, { message: 'HTTP 503' });
  assert.equal(success.state, 'success');
  assert.equal(success.rowCount, 0);
  assert.equal(failure.lastSuccessAt, 1000);
  assert.equal(failure.lastAttemptAt, 2500);
  assert.equal(failure.state, 'error');
  assert.equal(failure.message, 'HTTP 503');
  assert.equal(success.state, 'success', 'previous state is not mutated');
});

test('daily view filters reports by lesson date and cancellations by submitted date', () => {
  available('buildView');
  const result = ops.buildView({ date: '2026-09-14', manager: 'A.', sources,
    slots: [{ date: '2026-09-14', time: '10:00', manager: 'A.' }, { date: '2026-09-15', time: '10:00', manager: 'A.' }],
    reports: [
      { date: '14.09.2026', ts: '15.09.2026 10:00', manager: 'A.', crm: '', rec: '', agreement: 'Call' },
      { date: '15.09.2026', ts: '14.09.2026 10:00', manager: 'A.' },
      { date: '14.09.2026', manager: 'B.' },
    ],
    cancels: [{ ts: '14.09.2026 10:00', manager: 'A.' }, { ts: '15.09.2026 10:00', manager: 'A.' }],
  });
  assert.equal(result.slots.length, 1);
  assert.equal(result.reports.length, 1);
  assert.deepEqual(plain(result.reports[0].missing), ['CRM', 'Запись']);
  assert.equal(result.cancels.length, 1);
  assert.equal(result.incompleteCount, 1);
});

test('personal manager wins over a stale team filter and no synthetic payment is a report', () => {
  available('buildView');
  const result = ops.buildView({ date: '2026-09-14', manager: 'B.', personalManager: 'A.', sources,
    reports: [
      { date: '14.09.2026', manager: 'A.', crm: 'https://example.test/1', rec: 'https://example.test/r', agreement: 'Call' },
      { date: '14.09.2026', manager: 'A.', scenario: 'pay_on_lesson' },
      { date: '14.09.2026', manager: 'B.' },
    ],
  });
  assert.equal(result.reports.length, 1);
  assert.equal(result.incompleteCount, 0);
});

test('failed or not-yet-loaded source yields unavailable, never an empty healthy queue', () => {
  available('buildView');
  const result = ops.buildView({ date: '2026-09-14', sources: { ...sources, form: { state: 'error' }, slots: { state: 'loading' } }, reports: [], slots: [], cancels: [] });
  assert.equal(result.reports, null);
  assert.equal(result.incompleteCount, null);
  assert.equal(result.slots, null);
  assert.equal(result.cancels.length, 0);
  assert.equal(ops.buildView({ date: '2026-09-14' }).reports, null);
});

test('invalid report dates stay diagnostic instead of being silently counted as today', () => {
  available('buildView');
  const result = ops.buildView({ date: '2026-09-14', manager: 'A.', sources,
    reports: [{ date: 'not a date', manager: 'A.' }, { date: '', manager: 'B.' }],
    cancels: [{ ts: '31.02.2026 10:00', manager: 'A.' }],
  });
  assert.equal(result.reports.length, 0);
  assert.equal(result.invalidReportDates, 1);
  assert.equal(result.invalidCancelDates, 1);
});

async function fetchSource(response, previous) {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const functions = html.slice(html.indexOf('function parseCSV('), html.indexOf('function calDaysLeft('));
  let state = previous;
  const runtime = vm.createContext({
    URLS: { form: 'https://example.test/source' },
    sourceSnapshots: {},
    fetch: async () => response,
    AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {} },
    recordOpsSource(key, next, details) { state = ops.updateSource(state, next, Date.now(), details); },
  });
  vm.runInContext(functions, runtime);
  const rows = await runtime.fetchCSV('form');
  return { rows, state };
}

test('actual fetch path marks an HTTP failure and retains last successful download', async () => {
  const result = await fetchSource({ ok: false, status: 503 }, { state: 'success', lastSuccessAt: 123 });
  assert.equal(result.rows.length, 0);
  assert.equal(result.state.state, 'error');
  assert.equal(result.state.lastSuccessAt, 123);
  assert.match(result.state.message, /503/);
});

test('actual fetch path accepts a header-only sheet but rejects a blank or HTML response', async () => {
  const empty = await fetchSource({ ok: true, text: async () => '"Отправлен","Менеджер","Дата","Время","CRM","Запись","Практика","Возраст","Пакет","Комментарий","Договорённость","Возражение"\n' });
  assert.equal(empty.state?.state, 'success');
  assert.equal(empty.state.rowCount, 0);
  for (const text of ['  ', '<html><body>login</body></html>', 'not a table', '"Unexpected","Columns"\n']) {
    const invalid = await fetchSource({ ok: true, text: async () => text });
    assert.equal(invalid.state?.state, 'error', text);
  }
});

function loadRuntime(raw, fetcher) {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  let start = html.indexOf('function loadAll(');
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  const end = html.indexOf('// OPERATIONAL CONTROL', start);
  const runtime = vm.createContext({
    OpsControl: ops, fetchCSV: fetcher || (async key => raw[key]), Date, URL,
    dashboardLoadPromise: null, opsSourceStates: Object.fromEntries(Object.keys(raw).map(key => [key, { state: 'success' }])), __lastLoadAt: 0,
    scheduleData: {},
    FALLBACK_MGRS: ['A.'], OPS_SLOT_MANAGERS: {},
    cc: value => value == null ? '' : String(value).trim(),
    extractCrmId: value => value.split('/').at(-1),
    normDate: value => value,
    parseDate: value => ops.dateKey(value) ? new Date(ops.dateKey(value)) : null,
    fmtDate: date => `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth()+1).padStart(2, '0')}.${date.getFullYear()}`,
    window: {}, console: { log() {}, info() {}, warn() {}, error(message, error) { throw error; } },
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
    ...Object.fromEntries(['renderOperations', 'renderMain', 'buildHotMgrFilter', 'renderHot', 'buildAnalyticsMgrFilter', 'renderAnalytics', 'renderManagers', 'renderSchedule', 'renderRetention'].map(name => [name, () => {}])),
  });
  for (const file of ['analytics-core.js', 'dashboard-analytics.js', 'dashboard-load.js']) {
    vm.runInContext(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), runtime);
  }
  runtime.renderAnalyticsAll = () => {};
  runtime.renderMain = () => {};
  vm.runInContext(html.slice(start, end), runtime);
  const safeStart = html.indexOf('function safeReload(');
  vm.runInContext(html.slice(safeStart, html.indexOf('setInterval(', safeStart)), runtime);
  return runtime;
}

test('load integration preserves raw lesson reports and reconciles paid-only MK separately', async () => {
  const raw = {
    form: [[], ['14.09.2026 12:00', 'A.', '14.09.2026', '11:00', 'https://crm.test/detail/123456', '', 'Original course']],
    payments: [[], ['14.09.2026', 'A.', 'https://crm.test/detail/123456', '14.09.2026', 'Paid course', 'Pack', 'Payment', '100'], ['14.09.2026', 'A.', 'https://crm.test/detail/234567', '14.09.2026', 'Course', 'Pack', 'Payment', '200']],
    managers: [[], ['A.', 'да']], targets: [], slots: [], schedule: [], cancels: [],
  };
  const runtime = loadRuntime(raw);
  await runtime.loadAll();
  assert.equal(runtime.actualLessonReports.length, 1);
  assert.equal(runtime.actualLessonReports[0].practice, 'Original course');
  assert.equal(runtime.lessons.length, 2);
  assert.equal(runtime.lessons[0].practice, 'Original course');
  assert.equal(runtime.analyticsModel.payments.length, 2);
  assert.equal(runtime.analyticsModel.payments[0].practice, 'Paid course');
  assert.equal(runtime.analyticsModel.payments[1].lessonRow, 3);
  assert.equal(runtime.analyticsModel.payments[1].lessonSource, 'payments');
  assert.equal(raw.form[1][6], 'Original course');
  assert.equal(runtime.opsDataReady, true);
});

test('startup, safe refresh and repeated load share one flight and cannot mix source generations', async () => {
  const raw = { form: [[], ['14.09.2026 12:00', 'A.', '14.09.2026', '11:00', 'https://crm.test/detail/123456']], managers: [[], ['A.', 'да']], payments: [], targets: [], slots: [], schedule: [], cancels: [] };
  let releaseFirst, run = 0, requests = 0;
  const blocked = new Promise(resolve => { releaseFirst = resolve; });
  const runtime = loadRuntime(raw, async key => {
    requests++;
    if (key === 'form') run++;
    const generation = run;
    if (key === 'payments' && generation === 1) await blocked;
    runtime.opsSourceStates[key] = { state: key === 'form' && generation === 1 ? 'error' : 'success' };
    return key === 'form' && generation === 1 ? [] : raw[key];
  });
  const first = runtime.loadAll();
  await Promise.resolve();
  runtime.safeReload('test');
  const second = runtime.loadAll();
  await new Promise(resolve => setImmediate(resolve));
  const overlappingRequests = requests;
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(first, second, 'callers await the same in-flight operation');
  assert.equal(overlappingRequests, 7, 'only one seven-source read can be in flight');
  assert.equal(runtime.opsSourceStates.form.state, 'error');
  assert.equal(ops.buildView({ date: '2026-09-14', sources: runtime.opsSourceStates, reports: runtime.actualLessonReports }).reports, null);
  await runtime.loadAll();
  assert.equal(requests, 14, 'a later retry starts a fresh complete read');
  assert.equal(runtime.opsSourceStates.form.state, 'success');
  assert.equal(runtime.actualLessonReports.length, 1);
});

test('nonempty raw rows with missing managers or timestamps remain visible to operational diagnostics', async () => {
  const raw = {
    form: [[], ['14.09.2026 12:00', '', '14.09.2026', '11:00', 'https://crm.test/detail/123456'], ['', '', ''], ['14.09.2026 12:00', '', '', '11:00', 'https://crm.test/detail/345678']],
    cancels: [[], ['', 'https://crm.test/detail/123456', 'Reason', '', '', '', '', 'A.']],
    managers: [[], ['A.', 'да']], payments: [], targets: [], slots: [], schedule: [],
  };
  const runtime = loadRuntime(raw);
  await runtime.loadAll();
  assert.equal(runtime.actualLessonReports.length, 2);
  assert.equal(runtime.actualCancelReports.length, 1);
  assert.equal(runtime.lessons.length, 2, 'nonempty source facts are retained for diagnostics');
  assert.equal(runtime.cancelsList.length, 1, 'invalid dates stay in the source model');
  const selected = runtime.SalesAnalytics.select(runtime.analyticsModel, { from: '2026-09-14', to: '2026-09-14' });
  assert.equal(selected.lessons.length, 1, 'valid unassigned lessons count for the team');
  assert.equal(selected.cancels.length, 0, 'invalid event dates do not enter a period');
  const view = ops.buildView({ date: '2026-09-14', sources, reports: runtime.actualLessonReports, cancels: runtime.actualCancelReports });
  assert.equal(view.reports.length, 1);
  assert.ok(view.reports[0].missing.includes('Менеджер'));
  assert.equal(view.invalidReportDates, 1);
  assert.equal(view.invalidCancelDates, 1);
  assert.equal(view.missingReportManagers, 2);
});

test('operational and analytical facts share strict manager matching', async () => {
  const raw = {
    managers: [[], ['Иванов А.', 'да'], ['Иванов Б.', 'да'], ['Петров Д.', 'да'], ['Петров Д.С.', 'да']],
    form: [[], ['14.09.2026 12:00', 'Иванов Борис', '14.09.2026', '11:00', 'https://crm.test/detail/123456'], ['14.09.2026 13:00', 'Петров Дмитрий', '14.09.2026', '12:00', 'https://crm.test/detail/234567']],
    cancels: [[], ['14.09.2026 12:00', 'https://crm.test/detail/123456', 'Reason', '', '', '', '', 'Иванов Борис'], ['14.09.2026 13:00', 'https://crm.test/detail/234567', 'Reason', '', '', '', '', 'Петров Дмитрий']],
    slots: [[], ['14.09.2026', '11:00', 'Иванов Борис', 'wait'], ['14.09.2026', '12:00', 'Петров Дмитрий', 'wait']],
    payments: [], targets: [], schedule: [],
  };
  const runtime = loadRuntime(raw);
  await runtime.loadAll();
  assert.equal(runtime.opsSlotData.rows[0].manager, 'Иванов Б.');
  assert.equal(runtime.actualLessonReports[0].manager, 'Иванов Б.');
  assert.equal(runtime.actualCancelReports[0].manager, 'Иванов Б.');
  assert.equal(runtime.opsSlotData.rows[1].manager, 'Петров Дмитрий');
  assert.equal(runtime.opsSlotData.rows[1].knownManager, false);
  assert.equal(runtime.actualLessonReports[1].manager, 'Петров Дмитрий');
  assert.equal(runtime.actualCancelReports[1].manager, 'Петров Дмитрий');
  assert.equal(runtime.lessons[0].manager, 'Иванов Б.');
  assert.equal(runtime.cancelsList[0].manager, 'Иванов Б.');
  const view = ops.buildView({ date: '2026-09-14', manager: 'Иванов Б.', sources, slots: runtime.opsSlotData.rows, reports: runtime.actualLessonReports, cancels: runtime.actualCancelReports });
  assert.equal(view.slots.length, 1);
  assert.equal(view.reports.length, 1);
  assert.equal(view.cancels.length, 1);
});
