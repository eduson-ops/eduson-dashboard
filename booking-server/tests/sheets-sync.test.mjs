import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';

const module = await import('../sheets-sync.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('sheets-sync.mjs')) return {};
  throw error;
});
const available = typeof module.createSheetSynchronizer === 'function';
const BOOKING_HEADERS = ['ID','Дата','Время','Менеджер','AmoCRM','Возраст ребёнка','ПК','Родитель','Комментарий','Статус','Создано','Изменено'];
const REPORT_HEADERS = [']','Кто провёл урок? ','Дата МК ','Время МК','  Ссылка на CRM  ','  Ссылка на запись урока  - кидать сюда : https://disk.360.yandex.ru/client/disk/example','Практика','Возраст ','Какой пакет предложил/оплатили','  Вариант оплаты  ','\n\nДоговорённости с клиентом  ','  Итоговое возражение  ','С какого канала пришли (смотри скрин) ','Сумма оплаты (после комиссий банка) без копеек'];
const CANCEL_HEADERS = ['Отметка времени','Ссылка на AMO','Причина отмены','Первичная отмена или нет? ',' Как пробовали связаться?  ','Возраст','Комментарий ','МИМК '];
const snapshot = (overrides = {}) => ({
  id: 'booking-1', date: '2026-11-04', time: '14:00', assignedName: 'Synthetic teacher',
  crmUrl: 'https://synthetic.amocrm.ru/leads/detail/42', age: 12, hasPc: true, parentPresent: false,
  comment: '=UNTRUSTED()', state: 'scheduled', confirmationStatus: 'confirmed',
  createdAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T08:01:00.000Z', version: 1,
  ...overrides,
});

async function database(t) {
  const pg = new PGlite();
  await pg.exec(`CREATE SCHEMA eduson_booking; CREATE TABLE eduson_booking.sync_jobs (
    id TEXT PRIMARY KEY, booking_id TEXT, kind TEXT, version INT, status TEXT,
    attempts INT, last_error TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    UNIQUE (booking_id, kind, version));`);
  t.after(() => pg.close());
  return { query: (sql, values) => pg.query(sql, values), transaction: callback => pg.transaction(tx => callback({query: (sql, values) => tx.query(sql, values)})) };
}
async function enqueue(db, {id = 'job-1', bookingId = 'booking-1', kind = 'booking', version = 1, status = 'pending', attempts = 0, updatedAt = '2026-11-03T08:00:00Z'} = {}) {
  await db.query(`INSERT INTO eduson_booking.sync_jobs VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$7)`, [id, bookingId, kind, version, status, attempts, updatedAt]);
}
async function keys(t) {
  const path = await mkdtemp(join(tmpdir(), 'booking-sheets-test-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
  const file = join(path, 'synthetic-service-account.json');
  await writeFile(file, JSON.stringify({client_email: 'synthetic@example.invalid', private_key: pair.privateKey.export({type: 'pkcs8', format: 'pem'})}));
  return {path: file, publicKey: pair.publicKey};
}
function fakeGoogle() {
  const tabs = new Map([
    ['Booking VDS', [BOOKING_HEADERS.slice()]], ['Ответы формы', [REPORT_HEADERS.slice()]], ['Отмены', [CANCEL_HEADERS.slice()]],
  ]);
  const requests = [];
  let loseAppendResponse = false;
  let failWithSecret = false;
  const response = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
  const column = text => [...text].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const fetch = async (url, options = {}) => {
    requests.push({url: String(url), ...options});
    if (failWithSecret) throw new Error('Bearer SECRET-TOKEN private_key=PRIVATE-KEY hash=PASSWORD-HASH customer@example.test');
    if (String(url) === 'https://oauth2.googleapis.com/token') return response({access_token: 'SYNTHETIC-TOKEN', expires_in: 3600});
    const address = new URL(url);
    assert.equal(address.hostname, 'sheets.googleapis.com');
    const rawRange = decodeURIComponent(address.pathname.split('/values/')[1] || '');
    const append = rawRange.endsWith(':append');
    const range = rawRange.replace(/:append$/, '');
    const match = /^'(.+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);
    assert.ok(match, `Unrecognized test range: ${range}`);
    const [, name, fromColumn, fromRow, toColumn, toRow] = match;
    const rows = tabs.get(name);
    if (!rows) return new Response('{}', {status: 404});
    const startColumn = column(fromColumn), endColumn = column(toColumn || fromColumn);
    const startRow = Number(fromRow || 1) - 1, endRow = toRow ? Number(toRow) : (fromRow && !toColumn ? Number(fromRow) : rows.length);
    if (!options.method || options.method === 'GET') return response({values: rows.slice(startRow, endRow).map(row => row.slice(startColumn, endColumn + 1))});
    assert.equal(address.searchParams.get('valueInputOption'), 'RAW');
    const values = JSON.parse(options.body).values;
    if (append) {
      rows.push(...values.map(row => row.slice()));
      if (loseAppendResponse) { loseAppendResponse = false; throw new Error('socket closed after accepted append'); }
    } else {
      values.forEach((row, index) => {
        rows[startRow + index] ||= [];
        row.forEach((value, offset) => {rows[startRow + index][startColumn + offset] = value;});
      });
    }
    return response({updatedRows: values.length});
  };
  return {tabs, requests, fetch, loseNextAppend: () => {loseAppendResponse = true;}, failWithSecret: () => {failWithSecret = true;}};
}
async function fixture(t, options = {}) {
  const db = await database(t);
  const key = await keys(t);
  const google = fakeGoogle();
  let current = new Date('2026-11-03T09:00:00.000Z');
  let booking = snapshot();
  const sync = module.createSheetSynchronizer({db, getBooking: async id => id === booking.id ? booking : null,
    serviceAccountPath: key.path, spreadsheetId: 'synthetic-sheet', enabled: true, fetchImpl: google.fetch, now: () => current, ...options});
  return {db, google, sync, key, advance: ms => {current = new Date(current.valueOf() + ms);}, setBooking: value => {booking = value;}};
}

test('synchronizer export exists', () => {
  assert.equal(typeof module.createSheetSynchronizer, 'function', 'Durable Google Sheets synchronizer must be implemented');
});

test('an older pending booking job cannot publish an unresolved archive, while a later factual resolution can', async t => {
  const f=await fixture(t);
  f.setBooking(snapshot({historyOnly:true,legacy:{elapsedUnknown:true}}));
  await enqueue(f.db);
  assert.equal((await f.sync.runOnce()).status,'done');
  assert.equal(f.google.requests.length,0);
  assert.equal((await f.db.query("SELECT status FROM eduson_booking.sync_jobs WHERE id='job-1'")).rows[0].status,'done');
  f.setBooking(snapshot({historyOnly:true,legacy:{elapsedUnknown:false},state:'completed',version:2}));
  await enqueue(f.db,{id:'resolved-job',version:2});
  assert.equal((await f.sync.runOnce()).status,'done');
  assert.equal(f.google.tabs.get('Booking VDS').length,2);
  assert.equal(f.google.tabs.get('Booking VDS')[1][0],'booking-1');
});
test('disabled synchronizer leaves jobs untouched without reading keys or calling Google', {skip: !available}, async t => {
  const db = await database(t);
  await enqueue(db);
  let called = 0;
  const sync = module.createSheetSynchronizer({db, getBooking: () => {throw new Error('should not read bookings');},
    serviceAccountPath: 'Z:/missing/never-read-private-key.json', spreadsheetId: 'synthetic-sheet', fetchImpl: () => {called++; throw new Error('network forbidden');}});
  assert.equal((await sync.runOnce()).processed, false);
  assert.equal(called, 0);
  const status = await sync.status();
  assert.equal(status.enabled, false);
  assert.equal(status.pending, 1);
  assert.equal((await db.query('SELECT status,attempts FROM eduson_booking.sync_jobs')).rows[0].attempts, 0);
});
test('report mapper preserves the exact fourteen legacy fields in order', {skip: !available}, () => {
  const report = {timestamp: '2026-11-03T09:20:00Z', teacher: 'Report teacher', date: '2026-11-04', time: '14:00', crmUrl: 'CRM', recordingUrl: 'RECORDING', practice: 'Practice', age: 13,
    package: 'Package', paymentMethod: 'Method', agreement: 'Agreement', objection: 'Objection', channel: 'Channel', amountNet: 9000};
  assert.deepEqual(module.mapReportRow(snapshot({report})), [report.timestamp, report.teacher, report.date, report.time, report.crmUrl, report.recordingUrl, report.practice, report.age, report.package, report.paymentMethod, report.agreement, report.objection, report.channel, report.amountNet]);
});
test('unknown append result is retried by stable ID without duplicating the row', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db);
  f.google.loseNextAppend();
  assert.equal((await f.sync.runOnce()).processed, true);
  assert.equal((await f.db.query('SELECT status FROM eduson_booking.sync_jobs')).rows[0].status, 'error');
  assert.equal(f.google.tabs.get('Booking VDS').length, 2);
  f.advance(10_000);
  await f.sync.runOnce();
  assert.equal(f.google.tabs.get('Booking VDS').length, 2);
  assert.equal((await f.db.query('SELECT status,attempts FROM eduson_booking.sync_jobs')).rows[0].status, 'done');
  assert.equal(f.google.requests.filter(request => request.method === 'POST' && request.url.includes(':append')).length, 1);
  assert.equal(f.google.tabs.get('Booking VDS')[1][8], '=UNTRUSTED()');
});
test('foreign stable-ID header blocks all writes and leaves the header unchanged', {skip: !available}, async t => {
  const f = await fixture(t);
  const headers = f.google.tabs.get('Ответы формы')[0];
  headers[14] = 'Foreign production column';
  f.setBooking(snapshot({report: {timestamp: '2026-11-03T09:00:00Z', practice: 'Practice'}}));
  await enqueue(f.db, {kind: 'report'});
  await f.sync.runOnce();
  assert.equal(headers[14], 'Foreign production column');
  assert.equal(f.google.requests.filter(request => request.method === 'PUT' || request.url.includes(':append')).length, 0);
  assert.equal((await f.db.query('SELECT last_error FROM eduson_booking.sync_jobs')).rows[0].last_error, 'SHEET_HEADER_MISMATCH');
});
test('report projection adds a stable ID and never merges an anonymous legacy CRM row', {skip: !available}, async t => {
  const f = await fixture(t);
  const booking = snapshot({state: 'completed', report: {timestamp: '2026-11-03T09:00:00Z', practice: 'Practice', amountNet: 100}});
  f.setBooking(booking);
  f.google.tabs.get('Ответы формы').push(module.mapReportRow(booking));
  await enqueue(f.db, {kind: 'report'});
  await f.sync.runOnce();
  const rows = f.google.tabs.get('Ответы формы');
  assert.equal(rows[0][14], 'Booking ID');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][14], undefined);
  assert.equal(rows[2][14], booking.id);
});

test('test reports keep all fourteen business cells and carry separate boolean metadata', {skip: !available}, async t => {
  const f = await fixture(t);
  const booking = snapshot({isTest: true, state: 'completed', report: {timestamp:'2026-11-03T09:00:00Z', teacher:'Synthetic teacher', date:'2026-11-03', time:'12:00', crmUrl:'CRM', recordingUrl:'RECORDING', practice:'Python', age:12, package:'Package', paymentMethod:'Без оплаты', agreement:'Agreement', objection:'Objection', channel:'Сайт', amountNet:9999}});
  f.setBooking(booking);await enqueue(f.db,{kind:'report'});await f.sync.runOnce();
  const rows=f.google.tabs.get('Ответы формы');
  assert.deepEqual(rows[0].slice(14),['Booking ID','Test flag']);assert.deepEqual(rows[1].slice(0,14),module.mapReportRow(booking));assert.deepEqual(rows[1].slice(14),[booking.id,true]);
  f.setBooking({...booking,isTest:false,version:2});await enqueue(f.db,{id:'job-2',kind:'report',version:2});await f.sync.runOnce();
  assert.equal(rows.length,2);assert.equal(rows[1][15],false);assert.deepEqual(rows[1].slice(0,14),module.mapReportRow(booking));
});

for(const occupied of ['foreign header','foreign data'])test(`test metadata cannot replace ${occupied}`,{skip:!available},async t=>{
  const f=await fixture(t),rows=f.google.tabs.get('Ответы формы');rows[0][14]='Booking ID';
  if(occupied==='foreign header')rows[0][15]='Unowned production column';else rows.push([...Array(15).fill(''),'Existing data']);
  f.setBooking(snapshot({isTest:true,report:{practice:'Python'}}));await enqueue(f.db,{kind:'report'});await f.sync.runOnce();
  assert.equal((await f.db.query('SELECT last_error FROM eduson_booking.sync_jobs')).rows[0].last_error,'SHEET_HEADER_MISMATCH');
  assert.equal(f.google.requests.filter(request=>request.method==='PUT'||request.url.includes(':append')).length,0);
});
test('cancel restore preserves the fact and changes its stable row status', {skip: !available}, async t => {
  const f = await fixture(t);
  f.setBooking(snapshot({state: 'cancelled', cancelReason: 'Synthetic reason'}));
  await enqueue(f.db, {kind: 'cancel'});
  await f.sync.runOnce();
  const rows = f.google.tabs.get('Отмены');
  assert.deepEqual(rows[0].slice(8), ['Booking ID', 'Booking status']);
  assert.equal(rows[1][9], 'cancelled');
  f.setBooking(snapshot({version: 2, state: 'scheduled', cancelReason: ''}));
  await enqueue(f.db, {id: 'job-2', kind: 'cancel', version: 2});
  await f.sync.runOnce();
  assert.equal(rows.length, 2);
  assert.equal(rows[1][2], 'Synthetic reason');
  assert.equal(rows[1][9], 'restored');
});
test('stale version jobs project the current snapshot and process only one job', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db);
  await enqueue(f.db, {id: 'job-2', version: 2});
  f.setBooking(snapshot({assignedName: 'Current teacher', version: 2}));
  await f.sync.runOnce();
  assert.equal(f.google.tabs.get('Booking VDS')[1][3], 'Current teacher');
  const jobs = (await f.db.query('SELECT status FROM eduson_booking.sync_jobs ORDER BY id')).rows;
  assert.deepEqual(jobs.map(row => row.status), ['done', 'pending']);
});
test('transient failures obey backoff, cap retries and never expose secrets or customer details', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db);
  f.google.failWithSecret();
  await f.sync.runOnce();
  const requests = f.google.requests.length;
  await f.sync.runOnce();
  assert.equal(f.google.requests.length, requests);
  for (let index = 0; index < 10; index++) { f.advance(3_600_000); await f.sync.runOnce(); }
  const job = (await f.db.query('SELECT attempts,status,last_error FROM eduson_booking.sync_jobs')).rows[0];
  assert.equal(job.status, 'error');
  assert.equal(job.attempts, 8);
  const publicStatus = JSON.stringify(await f.sync.status());
  assert.doesNotMatch(publicStatus + JSON.stringify(job), /SECRET-TOKEN|PRIVATE-KEY|PASSWORD-HASH|customer@example|Bearer|private_key/);
});
test('stale processing is recovered while a fresh claim prevents parallel projections', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db, {status: 'processing', attempts: 1, updatedAt: '2026-11-03T08:59:00Z'});
  assert.equal((await f.sync.runOnce()).processed, false);
  f.advance(6 * 60_000);
  assert.equal((await f.sync.runOnce()).processed, true);
  assert.equal((await f.db.query('SELECT status,attempts FROM eduson_booking.sync_jobs')).rows[0].attempts, 2);
});
test('service account JWT uses RS256 and access tokens are reused for subsequent jobs', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db);
  await f.sync.runOnce();
  await enqueue(f.db, {id: 'job-2', version: 2});
  await f.sync.runOnce();
  const oauth = f.google.requests.filter(request => request.url === 'https://oauth2.googleapis.com/token');
  assert.equal(oauth.length, 1);
  const params = new URLSearchParams(oauth[0].body);
  const [header, payload, signature] = params.get('assertion').split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), f.key.publicKey, Buffer.from(signature, 'base64url')), true);
});
test('empty metadata headers cannot claim columns that already contain unrelated data', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Ответы формы').push([...Array(14).fill(''), 'Unowned existing value']);
  f.setBooking(snapshot({report: {practice: 'Practice'}}));
  await enqueue(f.db, {kind: 'report'});
  await f.sync.runOnce();
  assert.equal(f.google.tabs.get('Ответы формы')[0][14], undefined);
  assert.equal(f.google.requests.filter(request => request.method === 'PUT' || request.url.includes(':append')).length, 0);
  assert.equal((await f.db.query('SELECT last_error FROM eduson_booking.sync_jobs')).rows[0].last_error, 'SHEET_HEADER_MISMATCH');
});
test('a crashed final attempt recovers to a terminal error without remaining processing forever', {skip: !available}, async t => {
  const f = await fixture(t);
  await enqueue(f.db, {status: 'processing', attempts: 8});
  await f.sync.runOnce();
  assert.equal(f.google.requests.length, 0);
  const job = (await f.db.query('SELECT status,last_error,attempts FROM eduson_booking.sync_jobs')).rows[0];
  assert.equal(job.status, 'error');
  assert.equal(job.last_error, 'SYNC_ATTEMPTS_EXHAUSTED');
  assert.equal(job.attempts, 8);
});
test('a delayed cancellation projects its archived facts even when the booking was restored already', {skip: !available}, async t => {
  const f = await fixture(t);
  const cancellation = {timestamp: '2026-11-03T08:20:00.000Z', reason: 'Archived reason', firstCancellation: true, contactMethod: 'Phone', comment: 'Archived comment', manager: 'Archived manager'};
  f.setBooking(snapshot({state: 'scheduled', cancelReason: null, cancellation}));
  await enqueue(f.db, {kind: 'cancel'});
  await f.sync.runOnce();
  const row = f.google.tabs.get('Отмены')[1];
  assert.deepEqual(row.slice(0, 8), [cancellation.timestamp, snapshot().crmUrl, cancellation.reason, 'Да', cancellation.contactMethod, snapshot().age, cancellation.comment, cancellation.manager]);
  assert.equal(row[9], 'restored');
});
test('legacy unknown PC and parent attendance map to blank cells while known booleans retain their truth', () => {
  assert.equal(typeof module.mapBookingRow, 'function', 'Booking mapper must expose pure legacy truth mapping for regression checks');
  assert.deepEqual(module.mapBookingRow(snapshot({hasPc: null, parentPresent: null})).slice(6, 8), ['', '']);
  assert.deepEqual(module.mapBookingRow(snapshot({hasPc: false, parentPresent: false})).slice(6, 8), ['Нет', 'Нет']);
  assert.deepEqual(module.mapBookingRow(snapshot({hasPc: true, parentPresent: true})).slice(6, 8), ['Да', 'Да']);
});
