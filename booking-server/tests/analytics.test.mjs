import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const adapter = await readFile(new URL('../../booking-analytics-adapter.js', import.meta.url), 'utf8').catch(() => '');
const dashboard = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const configStart = dashboard.indexOf('const SHEET_ID =');
// Execute the dashboard's actual data loader and helpers, with rendering stubbed.
const dashboardLoader = dashboard.slice(configStart, dashboard.indexOf('function curMonthBounds()', configStart));
const sheet = '1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18';
const source = gid => `https://docs.google.com/spreadsheets/d/${sheet}/gviz/tq?tqx=out:csv&gid=${gid}`;
const formUrl = source('1621541455');
const cancelUrl = source('901678043');
const formHeaders = ['timestamp', 'manager', 'date', 'time', 'crm', 'recording', 'practice', 'age', 'package', 'payment', 'agreement', 'objection', 'channel', 'amount', 'Booking ID'];
const cancelHeaders = ['timestamp', 'crm', 'reason', 'first', 'contact', 'age', 'comment', 'manager', 'Booking ID', 'Booking status'];
const csv = rows => rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
const lesson = (id, extra = {}) => ({ bookingId: id, timestamp: '2026-11-03T09:00:00.000Z', teacher: 'Менеджер', date: '2026-11-03', time: '12:00', crmUrl: 'https://crm.test/leads/detail/12345', recordingUrl: 'https://video.test/1', practice: 'Python', age: 10, package: '24 урока', paymentMethod: 'Без оплаты', agreement: 'Позвонить завтра', objection: '', channel: 'Сайт', amountNet: 1234, ...extra });
const lessonRow = (id, extra = {}) => { const r = lesson(id, extra); return [r.timestamp, r.teacher, r.date, r.time, r.crmUrl, r.recordingUrl, r.practice, r.age, r.package, r.paymentMethod, r.agreement, r.objection, r.channel, r.amountNet, r.bookingId]; };
const cancellation = (id, extra = {}) => ({ bookingId: id, cancelledAt: '2026-11-03T10:00:00Z', teacher: 'Менеджер', crmUrl: 'https://crm.test/leads/detail/12345', age: 10, reason: 'Перенос', source: 'confirmation', ...extra });
const cancelRow = (id, status = 'cancelled') => ['2026-11-03T09:00:00Z', 'https://crm.test/leads/detail/12345', 'Старая причина', 'Да', 'Звонок', 10, '', 'Менеджер', id, status];

function browser({ snapshot = { lessons: [], cancellations: [], managedBookingIds: [] }, forms = csv([formHeaders]), cancels = csv([cancelHeaders]), apiStatus = 200, apiError = false, sheetStatus = 200 } = {}) {
  const calls = [], elements = new Map(), listeners = new Map(), timers = new Map(), streams = [];
  let clock = 0, timerId = 0;
  const makeElement = () => ({ style: {}, hidden: false, textContent: '', classList: { add() {}, remove() {} }, setAttribute() {}, appendChild(node) { if (node.id) elements.set(node.id, node); }, prepend(node) { if (node.id) elements.set(node.id, node); } });
  const document = { readyState: 'loading', body: makeElement(), createElement: makeElement, getElementById: id => elements.get(id) || null, querySelectorAll: () => [], addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); } };
  const state = { snapshot, apiStatus, apiError, sheetStatus, forms, cancels };
  const originalFetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input.url || String(input);
    calls.push({ input, url, options });
    if (url === '/api/analytics/snapshot') {
      if (state.apiError) throw new Error('offline');
      return new Response(JSON.stringify(state.snapshot), { status: state.apiStatus, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith(formUrl)) return new Response(state.forms, { status: state.sheetStatus, headers: { 'content-type': 'text/csv', 'x-source': 'legacy', 'content-length': String(state.forms.length) } });
    if (url.startsWith(cancelUrl)) return new Response(state.cancels, { status: state.sheetStatus, headers: { 'content-type': 'text/csv', 'x-source': 'legacy' } });
    const gid = new URL(url).searchParams.get('gid');
    if (gid === '1534781490') return new Response(csv([['Менеджер', 'Активный'], ['Менеджер', 'Да']]));
    return new Response(csv([['header']]));
  };
  class FakeDate extends Date { static now() { return clock; } }
  class FakeEventSource {
    constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; streams.push(this); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(revision) { this.handlers.get('changed')?.({ data: JSON.stringify({ revision }), lastEventId: String(revision) }); }
    close() { this.closed = true; }
  }
  const errors = [];
  const context = vm.createContext({ document, URL, Response, Request, Headers, Date: FakeDate, AbortController, AbortSignal, EventSource: FakeEventSource, location: { href: 'http://localhost/dashboard/', hash: '', hostname: 'localhost', protocol: 'http:', assign(url) { this.assigned = url; } }, fetch: originalFetch, console: { log() {}, info() {}, warn() {}, error(...args) { errors.push(args); } }, localStorage: { getItem() { return null; } }, setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, addEventListener(name, handler) { document.addEventListener(name, handler); } });
  context.window = context;
  vm.runInContext(adapter, context, { filename: 'booking-analytics-adapter.js' });
  vm.runInContext(dashboardLoader, context, { filename: 'index.html' });
  for (const fn of ['renderMain', 'buildHotMgrFilter', 'renderHot', 'buildAnalyticsMgrFilter', 'renderAnalytics', 'renderManagers', 'renderSchedule', 'renderRetention']) context[fn] = () => {};
  elements.set('upd', makeElement());
  return { context, calls, state, elements, listeners, streams, errors,
    advance(ms) { clock += ms; },
    async flushTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) await fn(); await new Promise(resolve => setImmediate(resolve)); },
    ready() { document.readyState = 'interactive'; for (const fn of listeners.get('DOMContentLoaded') || []) fn(); },
    data(expression) { return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)); },
    async rows(url) { const response = await context.fetch(url); return { response, rows: JSON.parse(JSON.stringify(context.parseCSV(await response.text()))) }; },
  };
}

test('stable booking ID replaces synchronized rows and preserves separate lessons sharing one CRM', async () => {
  const b = browser({ forms: csv([formHeaders, lessonRow('managed', { practice: 'stale' }), lessonRow('', { practice: 'legacy same CRM' }), lessonRow('unmanaged', { practice: 'other booking' })]), snapshot: { lessons: [lesson('managed', { practice: 'current' }), lesson('another', { practice: 'second same CRM' })], cancellations: [], managedBookingIds: ['managed', 'another'] } });
  const { response, rows } = await b.rows(formUrl);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.slice(1).map(r => r[6]), ['legacy same CRM', 'other booking', 'current', 'second same CRM']);
  assert.equal(response.headers.get('x-source'), 'legacy');
  assert.equal(response.headers.get('content-type'), 'text/csv');
  assert.equal(response.headers.has('content-length'), false);
});

test('restore removes managed archived cancellations while active database cancellations replace synchronized rows', async () => {
  const b = browser({ cancels: csv([cancelHeaders, cancelRow('restored'), cancelRow('cancelled'), cancelRow('legacy'), cancelRow('archived-unmanaged', 'scheduled')]), snapshot: { lessons: [], cancellations: [cancellation('cancelled')], managedBookingIds: ['restored', 'cancelled'] } });
  const { rows } = await b.rows(cancelUrl);
  assert.deepEqual(rows.slice(1).map(r => r[8]), ['legacy', 'archived-unmanaged', 'cancelled']);
  assert.equal(rows[3][2], 'Перенос');
  assert.equal(rows[3][9], 'cancelled');
});

test('stable-ID merge preserves archived cancellation facts and their original actor', async () => {
  const archived = { timestamp: '2026-11-02T11:15:00Z', reason: 'Сохранённая причина', firstCancellation: true, contactMethod: 'Звонок, затем чат', comment: 'Saved cancellation comment\nВторая "строка".', manager: 'Confirmation actor', source: 'confirmation' };
  const fact = cancellation('cancelled', { teacher: 'Assigned sales', assignedTeacher: 'Assigned sales', manager: 'Current top-level actor', reason: 'Changed current reason', cancellation: archived });
  const b = browser({ cancels: csv([cancelHeaders, cancelRow('cancelled')]), snapshot: { lessons: [], cancellations: [fact], managedBookingIds: ['cancelled'] } });
  const { rows } = await b.rows(cancelUrl);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], [archived.timestamp, fact.crmUrl, archived.reason, 'Да', archived.contactMethod, '10', archived.comment, archived.manager, 'cancelled', 'cancelled']);
  await b.context.loadAll();
  const [parsed] = b.data('cancelsList');
  assert.equal(parsed.is_first, 'Да');
  assert.equal(parsed.contact, archived.contactMethod);
  assert.equal(parsed.comment, archived.comment);
  assert.equal(parsed.manager, archived.manager);
  assert.equal(parsed.ts, archived.timestamp);
});

test('archived cancellation false and unknown flags stay distinct and empty values keep their meaning', async () => {
  const facts = [cancellation('repeat', { cancellation: { timestamp: '2026-11-01T10:00:00Z', reason: '', firstCancellation: false, contactMethod: '', comment: '', manager: '' }, manager: 'Fallback actor', comment: 'Current comment' }), cancellation('unknown', { cancellation: { firstCancellation: null } })];
  const b = browser({ snapshot: { lessons: [], cancellations: facts, managedBookingIds: ['repeat', 'unknown'] } });
  const { rows } = await b.rows(cancelUrl);
  assert.equal(rows[1][3], 'Нет');
  assert.equal(rows[1][2], '');
  assert.equal(rows[1][6], '');
  assert.equal(rows[1][7], '');
  assert.equal(rows[2][3], '');
});

test('CSV quoting survives multiline agreements, commas, quotes and Unicode', async () => {
  const agreement = 'Первая, строка\nВторая "строка" — привет';
  const b = browser({ forms: '\uFEFF' + csv([formHeaders, lessonRow('legacy', { agreement })]), snapshot: { lessons: [lesson('new', { agreement })], cancellations: [], managedBookingIds: ['new'] } });
  const { rows } = await b.rows(formUrl);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][10], agreement);
  assert.equal(rows[2][10], agreement);
  assert.equal(rows[2][14], 'new');
});

test('original fourteen-column and eight-column sheets gain separate stable identity columns', async () => {
  const b = browser({ forms: csv([formHeaders.slice(0, 14)]), cancels: csv([cancelHeaders.slice(0, 8)]), snapshot: { lessons: [lesson('new')], cancellations: [cancellation('cancelled')], managedBookingIds: ['new', 'cancelled'] } });
  const form = await b.rows(formUrl);
  const cancels = await b.rows(cancelUrl);
  assert.equal(form.rows[0][14], 'Booking ID');
  assert.equal(form.rows[1][13], '1234');
  assert.equal(cancels.rows[0][8], 'Booking ID');
  assert.equal(cancels.rows[0][9], 'Booking status');
  assert.equal(cancels.rows[1][9], 'cancelled');
});

test('real dashboard loader gets canonical fields without treating report amount as a payment', async () => {
  const b = browser({ snapshot: { lessons: [lesson('new')], cancellations: [cancellation('cancelled')], managedBookingIds: ['new', 'cancelled'] } });
  await b.context.loadAll();
  assert.deepEqual(b.errors, []);
  const [row] = b.data('lessons');
  assert.equal(row.paymentMethod, 'Без оплаты');
  assert.equal(row.channel, 'Сайт');
  assert.equal(row.amountNet, 1234);
  assert.equal(row.bookingId, 'new');
  assert.equal(row.notes, '');
  assert.equal(row.rev, 0);
  assert.equal(row.paid, false);
  assert.equal(b.data('cancelsList').length, 1);
  assert.equal(b.calls.filter(c => c.url === '/api/analytics/snapshot').length, 1);
});

test('unrelated sheets, URLs, requests and non-GET fetches keep their original inputs and options', async () => {
  const b = browser();
  const cases = [source('1367593612'), source('325926893'), formUrl.replace(sheet, 'other-sheet'), formUrl.replace('docs.google.com', 'example.test'), formUrl.replace('/gviz/tq', '/edit'), formUrl.replace('out:csv', 'out:json')];
  for (const url of cases) await b.context.fetch(url, { cache: 'no-store' });
  const request = new Request(formUrl, { method: 'POST' });
  const options = { headers: { test: 'value' } };
  await b.context.fetch(request, options);
  assert.equal(b.calls.length, cases.length + 1);
  assert.equal(b.calls.at(-1).input, request);
  assert.equal(b.calls.at(-1).options, options);
});

test('Request and URL inputs are supported and the snapshot expires after five seconds', async () => {
  const b = browser({ snapshot: { lessons: [lesson('one')], cancellations: [], managedBookingIds: ['one'] } });
  const [form, cancels] = await Promise.all([b.rows(new Request(formUrl)), b.rows(new URL(cancelUrl))]);
  assert.equal(form.rows.length, 2);
  assert.equal(cancels.rows.length, 1);
  assert.equal(b.calls.filter(c => c.url === '/api/analytics/snapshot').length, 1);
  await b.rows(formUrl);
  b.advance(5001);
  b.state.snapshot = { lessons: [lesson('two')], cancellations: [], managedBookingIds: ['two'] };
  assert.equal((await b.rows(formUrl)).rows[1][14], 'two');
  assert.equal(b.calls.filter(c => c.url === '/api/analytics/snapshot').length, 2);
});

for (const failure of [{ apiStatus: 500 }, { apiError: true }, { snapshot: { lessons: [], cancellations: [] } }]) {
  test(`API failure preserves the legacy snapshot and exposes integration status: ${JSON.stringify(failure)}`, async () => {
    const forms = csv([formHeaders, lessonRow('legacy')]);
    const b = browser({ forms, ...failure });
    const response = await b.context.fetch(formUrl);
    assert.equal(await response.text(), forms);
    assert.match(b.elements.get('booking-analytics-status')?.textContent || '', /нового букинга.*недоступны/i);
    assert.equal(b.streams.length, 0);
  });
}

for (const apiStatus of [401, 403]) {
  test(`${apiStatus} uses only legacy data without connecting an admin event stream`, async () => {
    const b = browser({ apiStatus, forms: csv([formHeaders, lessonRow('legacy')]), snapshot: { lessons: [lesson('secret')], cancellations: [], managedBookingIds: ['secret'] } });
    assert.equal((await b.rows(formUrl)).rows.length, 2);
    assert.equal(b.streams.length, 0);
    assert.equal(b.elements.get('booking-analytics-status')?.hidden ?? true, true);
  });
}

test('failed Google response never becomes a fabricated database-only history', async () => {
  const b = browser({ forms: csv([formHeaders, lessonRow('legacy')]), snapshot: { lessons: [lesson('new')], cancellations: [], managedBookingIds: ['new'] } });
  await b.rows(formUrl);
  b.state.sheetStatus = 503;
  const fallback = await b.rows(formUrl);
  assert.deepEqual(fallback.rows.slice(1).map(r => r[14]), ['legacy', 'new']);
  assert.match(b.elements.get('booking-analytics-status')?.textContent || '', /Google Sheets/);
  const fresh = browser({ sheetStatus: 503 });
  assert.equal((await fresh.context.fetch(formUrl)).status, 503);
  assert.match(fresh.elements.get('booking-analytics-status')?.textContent || '', /Google Sheets/);
});

test('malformed Google CSV keeps the last valid history and reports initial malformed data as a failed fetch', async () => {
  const b = browser({ forms: csv([formHeaders, lessonRow('legacy')]) });
  await b.rows(formUrl);
  b.state.forms = '"unfinished';
  assert.equal((await b.rows(formUrl)).rows[1][14], 'legacy');
  assert.match(b.elements.get('booking-analytics-status')?.textContent || '', /Google Sheets/);
  const fresh = browser({ forms: '"unfinished' });
  assert.equal((await fresh.context.fetch(formUrl)).ok, false);
});

test('API outage after a successful merge returns the current unmodified legacy history', async () => {
  const forms = csv([formHeaders, lessonRow('legacy')]);
  const b = browser({ forms, snapshot: { lessons: [lesson('new')], cancellations: [], managedBookingIds: ['new'] } });
  assert.equal((await b.rows(formUrl)).rows.length, 3);
  b.advance(5001);
  b.state.apiError = true;
  const response = await b.context.fetch(formUrl);
  assert.equal(await response.text(), forms);
  assert.match(b.elements.get('booking-analytics-status')?.textContent || '', /нового букинга.*недоступны/i);
});

test('initial SSE revision reconciles the snapshot-subscription gap once', async () => {
  const b = browser({ snapshot: { lessons: [lesson('before-subscription')], cancellations: [], managedBookingIds: ['before-subscription'] } });
  await b.rows(formUrl);
  b.state.snapshot = { lessons: [lesson('after-subscription')], cancellations: [], managedBookingIds: ['after-subscription'] };
  let loads = 0;
  let currentId;
  b.context.loadAll = async () => { loads++; currentId = (await b.rows(formUrl)).rows[1][14]; };
  b.streams[0].emit(4);
  await b.flushTimers();
  assert.equal(loads, 1);
  assert.equal(currentId, 'after-subscription');
  b.streams[0].emit(4);
  await b.flushTimers();
  assert.equal(loads, 1);
});

test('committed SSE changes invalidate cache and debounce one actual loader refresh', async () => {
  const b = browser({ snapshot: { lessons: [lesson('one')], cancellations: [], managedBookingIds: ['one'] } });
  await b.rows(formUrl);
  assert.equal(b.streams.length, 1);
  let loads = 0;
  b.context.loadAll = async () => { loads++; await b.rows(formUrl); };
  b.streams[0].emit(1);
  await b.flushTimers();
  assert.equal(loads, 1);
  b.state.snapshot = { lessons: [lesson('two')], cancellations: [], managedBookingIds: ['two'] };
  b.streams[0].emit(2); b.streams[0].emit(3); b.streams[0].emit(3);
  await b.flushTimers();
  assert.equal(loads, 2);
  assert.equal(b.calls.filter(c => c.url === '/api/analytics/snapshot').length, 3);
});

test('old booking navigation opens the new booking application and keeps other navigation', async () => {
  const b = browser();
  const pages = [];
  b.context.showPage = id => { pages.push(id); return `page:${id}`; };
  b.ready();
  assert.equal(b.context.showPage('analytics'), 'page:analytics');
  b.context.showPage('booking');
  assert.equal(b.context.location.assigned, '/');
  assert.deepEqual(pages, ['analytics']);
});
