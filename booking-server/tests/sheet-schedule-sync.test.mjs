import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
const module = await import('../sheet-schedule-sync.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('sheet-schedule-sync.mjs')) return {};
  throw error;
});
const available = typeof module.createScheduleSheetSynchronizer === 'function';
const privateKey = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({type: 'pkcs8', format: 'pem'});
const baseSnapshot = () => ({managedSchedules: [{manager: 'Owned', date: '2026-11-04'}],
  scheduleRows: [{manager: 'Owned', date: '2026-11-04', time: '14:00'}],
  slotRows: [{manager: 'Owned', date: '2026-11-04', time: '14:00', status: 'booked', bookingId: 'booking-1'},
    {manager: 'Owned', date: '2026-11-04', time: '14:00', status: 'wait', bookingId: ''}],
  ownedBookingIds: ['booking-1', 'cancelled-booking'], unresolved: []});
async function database(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`CREATE SCHEMA eduson_booking; CREATE TABLE eduson_booking.sheet_projections (
    key TEXT PRIMARY KEY,version INT DEFAULT 1,status TEXT DEFAULT 'pending',attempts INT DEFAULT 0,last_error TEXT,
    lease_token TEXT,lease_until TIMESTAMPTZ,previous_payload JSONB DEFAULT '{}',updated_at TIMESTAMPTZ);
    INSERT INTO eduson_booking.sheet_projections(key,updated_at) VALUES ('schedule','2026-11-03T09:00:00Z');`);
  return {query: (sql, values) => pg.query(sql, values), transaction: callback => pg.transaction(tx => callback({query: (sql, values) => tx.query(sql, values)}))};
}
function fakeGoogle() {
  const tabs = new Map([
    ['Расписание', [['Manager', 'Дата', 'Время'], ['Owned', '04.11.2026', '14:00']]],
    ['Слоты', [['Дата', 'Время', 'Менеджер', 'Статус'], ['04.11.2026', '14:00', 'Owned', 'wait', ''], ['04.11.2026', '14:00', 'Owned', 'wait', '']]],
  ]);
  const requests = [];
  let loseAppend = false;
  const response = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  const column = text => [...text].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  function locate(range) {
    const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);
    assert.ok(match, `Unexpected range ${range}`);
    return {rows: tabs.get(match[1].replaceAll("''", "'")), fromColumn: column(match[2]), fromRow: Number(match[3] || 1) - 1,
      toColumn: column(match[4] || match[2]), toRow: match[5] ? Number(match[5]) : null};
  }
  function write({range, values}) {
    const {rows, fromColumn, fromRow} = locate(range);
    values.forEach((row, offset) => {
      rows[fromRow + offset] ||= [];
      row.forEach((value, index) => { rows[fromRow + offset][fromColumn + index] = value; });
    });
  }
  const fetch = async (url, options = {}) => {
    const address = new URL(url);
    requests.push({url: String(url), ...options});
    if (address.hostname === 'oauth2.googleapis.com') return response({access_token: 'TEST-TOKEN', expires_in: 3600});
    assert.equal(address.hostname, 'sheets.googleapis.com');
    const body = options.body ? JSON.parse(options.body) : null;
    if (address.pathname.endsWith('/values:batchUpdate')) {
      assert.equal(body.valueInputOption, 'RAW');
      body.data.forEach(write);
      return response({totalUpdatedRows: body.data.length});
    }
    const decoded = decodeURIComponent(address.pathname.split('/values/')[1] || '');
    const append = decoded.endsWith(':append');
    const range = decoded.replace(/:append$/, '');
    const {rows, fromColumn, toColumn, fromRow, toRow} = locate(range);
    if (!options.method || options.method === 'GET') {
      let values = rows.slice(fromRow, toRow || rows.length).map(row => row.slice(fromColumn, toColumn + 1));
      while (values.length && values.at(-1).every(value => value === '' || value == null)) values.pop();
      return response({values});
    }
    assert.equal(address.searchParams.get('valueInputOption'), 'RAW');
    if (append) {
      assert.equal(address.searchParams.get('insertDataOption'), 'OVERWRITE', 'Appending may not insert entire Sheet rows');
      write({range: range.replace(/\d*:([A-Z]+)$/, `${Math.max(fromRow, rows.length) + 1}:$1`), values: body.values});
      if (loseAppend) { loseAppend = false; throw new Error('append applied but its response was lost'); }
    } else write({range, values: body.values});
    return response({updatedRows: body.values.length});
  };
  return {tabs, requests, fetch, loseNextAppend: () => {loseAppend = true;}};
}
async function fixture(t, options = {}) {
  const db = await database(t);
  const directory = await mkdtemp(join(tmpdir(), 'schedule-sync-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const serviceAccountPath = join(directory, 'test.json');
  await writeFile(serviceAccountPath, JSON.stringify({client_email: 'synthetic@example.invalid', private_key: privateKey}));
  const google = fakeGoogle();
  let current = new Date('2026-11-03T09:00:00Z'), snapshot = baseSnapshot();
  const config = {db, getSnapshot: async () => snapshot, serviceAccountPath, spreadsheetId: 'TEST-SHEET', enabled: true, fetchImpl: google.fetch, now: () => current, ...options};
  const sync = module.createScheduleSheetSynchronizer(config);
  return {db, google, sync, config, setSnapshot: next => {snapshot = next;}, advance: ms => {current = new Date(current.valueOf() + ms);}};
}
const writes = google => google.requests.filter(request => request.method && request.method !== 'GET' && !request.url.includes('oauth2.googleapis.com'));
const facts = rows => rows.slice(1).filter(row => row.some(value => value !== '' && value != null));

test('schedule synchronizer export exists', () => assert.equal(typeof module.createScheduleSheetSynchronizer, 'function', 'Schedule and slots projection must be implemented'));
test('configured PG tabs receive the complete projection while both legacy tabs stay untouched', {skip: !available}, async t => {
  const names={scheduleSheetName:'Booking VDS — Расписание',slotsSheetName:'Booking VDS — Слоты'};
  const f=await fixture(t,names),legacy=structuredClone([...f.google.tabs]);
  f.google.tabs.set(names.scheduleSheetName,[['Менеджер','Дата','Время'],['Owned','04.11.2026','13:00']]);
  f.google.tabs.set(names.slotsSheetName,[['Дата','Время','Менеджер','Статус']]);
  assert.equal((await f.sync.runOnce()).status,'done');
  assert.deepEqual(facts(f.google.tabs.get(names.scheduleSheetName)),[['Owned','04.11.2026','14:00']]);
  assert.deepEqual(facts(f.google.tabs.get(names.slotsSheetName)),[['04.11.2026','14:00','Owned','booked','booking-1'],['04.11.2026','14:00','Owned','wait','']]);
  assert.equal(f.google.tabs.get(names.slotsSheetName)[0][4],'Booking ID');
  for(const [name,rows] of legacy)assert.deepEqual(f.google.tabs.get(name),rows);
  const ranges=f.google.requests.filter(r=>!r.url.includes('oauth2.googleapis.com')).flatMap(r=>r.url.includes('values:batchUpdate')?JSON.parse(r.body).data.map(value=>value.range):[decodeURIComponent(new URL(r.url).pathname.split('/values/')[1]).replace(/:append$/,'')]);
  assert.ok(ranges.length>=5);assert.ok(ranges.every(range=>range.startsWith("'Booking VDS — Расписание'!")||range.startsWith("'Booking VDS — Слоты'!")));
  const before=f.google.requests.length;assert.equal((await f.sync.runOnce()).processed,false);assert.equal(f.google.requests.length,before);
});
test('configured tab names quote internal apostrophes in reads, updates and appends', {skip: !available}, async t => {
  const names={scheduleSheetName:"PG O'Brien — Расписание",slotsSheetName:"PG O'Brien — Слоты"};
  const f=await fixture(t,names);f.google.tabs.set(names.scheduleSheetName,[['Manager','Дата','Время']]);f.google.tabs.set(names.slotsSheetName,[['Дата','Время','Менеджер','Статус']]);
  assert.equal((await f.sync.runOnce()).status,'done');
  assert.equal(facts(f.google.tabs.get(names.slotsSheetName))[0][4],'booking-1');
  assert.ok(f.google.requests.some(r=>decodeURIComponent(r.url).includes("'PG O''Brien — Слоты'!")));
  const batch=writes(f.google).find(r=>r.url.includes('values:batchUpdate'));assert.equal(JSON.parse(batch.body).data[0].range,"'PG O''Brien — Слоты'!E1:E1");
});
test('ambiguous, malformed or colliding tab configuration fails before network or database access', {skip: !available}, () => {
  let calls=0;
  const blocked={db:{query(){calls++;throw Error('DB forbidden');}},fetchImpl(){calls++;throw Error('Network forbidden');}};
  for(const name of ['',null,42,' Слоты','Слоты ','Slots\n','Slots\u0000','Slots!A1:C','Slots[A]','A:B','A/B','A\\B','A?B','A*B','e\u0301','a'.repeat(101)])for(const field of ['scheduleSheetName','slotsSheetName']){
    assert.throws(()=>module.createScheduleSheetSynchronizer({...blocked,[field]:name}),error=>error.code==='SYNC_CONFIGURATION',`${field}: ${JSON.stringify(name)}`);
  }
  for(const names of [{scheduleSheetName:'Слоты',slotsSheetName:'Слоты'},{scheduleSheetName:'Слоты',slotsSheetName:'слоты'}])assert.throws(()=>module.createScheduleSheetSynchronizer({...blocked,...names}),error=>error.code==='SYNC_CONFIGURATION');
  assert.equal(calls,0);
});
test('actual Russian schedule header is accepted without changing business headers', {skip: !available}, async t => {
  const f=await fixture(t);
  f.google.tabs.get('Расписание')[0]=['Менеджер','Дата','Время'];
  const result=await f.sync.runOnce();
  assert.equal(result.error,undefined);
  assert.equal((await f.db.query("SELECT status FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].status,'done');
  assert.deepEqual(await f.sync.status(),{enabled:true,pending:0,error:0,lastError:null});
  assert.deepEqual(f.google.tabs.get('Расписание')[0],['Менеджер','Дата','Время']);
  assert.equal(f.google.tabs.get('Слоты')[1][4],'booking-1');
});
test('exact duplicate slot capacity is preserved with one booked stable ID', {skip: !available}, async t => {
  const f = await fixture(t);
  await f.sync.runOnce();
  assert.deepEqual(facts(f.google.tabs.get('Слоты')), [['04.11.2026','14:00','Owned','booked','booking-1'],['04.11.2026','14:00','Owned','wait','']]);
  assert.deepEqual(facts(f.google.tabs.get('Расписание')), [['Owned','04.11.2026','14:00']]);
  assert.equal(f.google.tabs.get('Слоты')[0][4], 'Booking ID');
  assert.equal(writes(f.google).length, 1, 'Owned row updates should use one batch request');
});
test('unmanaged history and another manager on the same day retain all cells and positions', {skip: !available}, async t => {
  const f = await fixture(t);
  const oldSlot = ['01.04.2026', '10:00', 'Owned', 'booked', 'history-external-id'];
  const otherSlot = ['04.11.2026', '14:00', 'Other', 'booked', 'other-external-id'];
  f.google.tabs.get('Слоты')[0][4] = 'Booking ID';
  f.google.tabs.get('Слоты').push(oldSlot.slice(), otherSlot.slice());
  f.google.tabs.get('Расписание').push(['Owned', '01.04.2026', '10:00'], ['Other','04.11.2026','14:00']);
  const beforeSchedule = f.google.tabs.get('Расписание').slice(2).map(row => row.slice());
  await f.sync.runOnce();
  assert.deepEqual(f.google.tabs.get('Слоты').slice(3), [oldSlot, otherSlot]);
  assert.deepEqual(f.google.tabs.get('Расписание').slice(2), beforeSchedule);
});
test('closing a managed day clears only its owned cells and keeps unmanaged rows in place', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты').push(['04.11.2026','14:00','Other','wait','']);
  f.google.tabs.get('Расписание').push(['Other','04.11.2026','14:00']);
  f.setSnapshot({...baseSnapshot(), slotRows: [], scheduleRows: []});
  await f.sync.runOnce();
  assert.deepEqual(f.google.tabs.get('Слоты').slice(1), [Array(5).fill(''), Array(5).fill(''), ['04.11.2026','14:00','Other','wait','']]);
  assert.deepEqual(f.google.tabs.get('Расписание').slice(1), [Array(3).fill(''), ['Other','04.11.2026','14:00']]);
});
test('manager rename removes previous owned keys and creates the new canonical rows once', {skip: !available}, async t => {
  const f = await fixture(t);
  await f.sync.runOnce();
  const renamed = baseSnapshot();
  for (const rows of [renamed.managedSchedules, renamed.scheduleRows, renamed.slotRows]) rows.forEach(row => {row.manager = 'Renamed';});
  f.setSnapshot(renamed);
  await f.db.query("UPDATE eduson_booking.sheet_projections SET version=version+1,status='pending',attempts=0");
  await f.sync.runOnce();
  assert.deepEqual(facts(f.google.tabs.get('Расписание')), [['Renamed','04.11.2026','14:00']]);
  assert.equal(facts(f.google.tabs.get('Слоты')).length, 2);
  assert.ok(facts(f.google.tabs.get('Слоты')).every(row => row[2] === 'Renamed'));
  const job = (await f.db.query('SELECT previous_payload FROM eduson_booking.sheet_projections')).rows[0];
  assert.deepEqual(job.previous_payload.managedSchedules, renamed.managedSchedules);
});
test('foreign metadata header blocks every sheet write', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты')[0][4] = 'Foreign owner';
  const result = await f.sync.runOnce();
  assert.equal(result.error, 'SHEET_HEADER_MISMATCH');
  assert.equal(writes(f.google).length, 0);
});
test('foreign booking ID in an owned row blocks every sheet write', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты')[1][4] = 'foreign-booking';
  const result = await f.sync.runOnce();
  assert.equal(result.error, 'SHEET_FOREIGN_OWNER');
  assert.equal(writes(f.google).length, 0);
});
test('recognized historical booking IDs allow an empty metadata header to be adopted safely', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты')[1][4] = 'cancelled-booking';
  await f.sync.runOnce();
  assert.equal(f.google.tabs.get('Слоты')[0][4], 'Booking ID');
  assert.equal(f.google.tabs.get('Слоты')[1][4], 'booking-1');
});
test('dirty version during a live lease stays pending and another worker cannot write concurrently', {skip: !available}, async t => {
  let release, observed;
  const entered = new Promise(resolve => {observed = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {getSnapshot: async () => {observed(); await gate; return baseSnapshot();}});
  const running = f.sync.runOnce();
  await entered;
  await f.db.query("UPDATE eduson_booking.sheet_projections SET version=version+1,status='pending',attempts=0");
  const second = module.createScheduleSheetSynchronizer(f.config);
  assert.equal((await second.runOnce()).processed, false);
  release();
  await running;
  const job = (await f.db.query('SELECT status,version,lease_token,previous_payload FROM eduson_booking.sheet_projections')).rows[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.version, 2);
  assert.equal(job.lease_token, null);
  assert.deepEqual(job.previous_payload.managedSchedules, baseSnapshot().managedSchedules);
});
test('lost append response retries from actual rows and creates no duplicate capacity', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты').splice(1);
  f.google.tabs.get('Расписание').splice(1);
  f.google.loseNextAppend();
  assert.equal((await f.sync.runOnce()).status, 'error');
  f.advance(10_000);
  await f.sync.runOnce();
  assert.equal(facts(f.google.tabs.get('Слоты')).length, 2);
  assert.equal(facts(f.google.tabs.get('Расписание')).length, 1);
  assert.equal((await f.db.query('SELECT status FROM eduson_booking.sheet_projections')).rows[0].status, 'done');
});
test('disabled worker does not fetch, read sensitive keys or claim a job', {skip: !available}, async t => {
  const db = await database(t);
  const sync = module.createScheduleSheetSynchronizer({db, getSnapshot: () => {throw new Error('forbidden');}, serviceAccountPath: 'Z:/missing/key.json', spreadsheetId: 'TEST', fetchImpl: () => {throw new Error('network forbidden');}});
  assert.equal((await sync.runOnce()).processed, false);
  assert.equal((await sync.status()).enabled, false);
  assert.equal((await db.query('SELECT attempts FROM eduson_booking.sheet_projections')).rows[0].attempts, 0);
});
test('ambiguous or corrupted dates refuse writes instead of dropping unknown rows', {skip: !available}, async t => {
  const f = await fixture(t);
  f.google.tabs.get('Слоты')[1][0] = '04/11/2026';
  assert.equal((await f.sync.runOnce()).error, 'SHEET_DATE_INVALID');
  assert.equal(writes(f.google).length, 0);
});
test('Google numeric dates and numeric times resolve to the same owned row', {skip: !available}, async t => {
  const f = await fixture(t);
  const serial = (Date.UTC(2026, 10, 4) - Date.UTC(1899, 11, 30)) / 86_400_000;
  f.google.tabs.get('Слоты')[1][0] = serial;
  f.google.tabs.get('Слоты')[1][1] = 14 / 24;
  f.google.tabs.get('Расписание')[1][1] = '2026-11-04';
  await f.sync.runOnce();
  assert.equal(facts(f.google.tabs.get('Слоты')).length, 2);
  assert.equal(f.google.tabs.get('Слоты')[1][0], '04.11.2026');
});
test('unresolved canonical occupancy refuses projection before any external write', {skip: !available}, async t => {
  const f = await fixture(t);
  f.setSnapshot({...baseSnapshot(), unresolved: [{bookingId: 'synthetic', reason: 'unmatched'}]});
  assert.equal((await f.sync.runOnce()).error, 'SHEET_SNAPSHOT_UNRESOLVED');
  assert.equal(writes(f.google).length, 0);
});
test('concurrent initial reads share one OAuth token request', {skip: !available}, async t => {
  const f = await fixture(t);
  await f.sync.runOnce();
  assert.equal(f.google.requests.filter(request => request.url.includes('oauth2.googleapis.com')).length, 1);
});
test('unknown append followed by another rename cleans every attempted ownership key on retry', {skip: !available}, async t => {
  const f = await fixture(t);
  await f.sync.runOnce();
  const middle = baseSnapshot();
  for (const rows of [middle.managedSchedules, middle.scheduleRows, middle.slotRows]) rows.forEach(row => {row.manager = 'Middle';});
  f.setSnapshot(middle);
  await f.db.query("UPDATE eduson_booking.sheet_projections SET version=version+1,status='pending',attempts=0");
  f.google.loseNextAppend();
  assert.equal((await f.sync.runOnce()).status, 'error');
  const final = baseSnapshot();
  for (const rows of [final.managedSchedules, final.scheduleRows, final.slotRows]) rows.forEach(row => {row.manager = 'Final';});
  f.setSnapshot(final);
  await f.db.query("UPDATE eduson_booking.sheet_projections SET version=version+1,status='pending',attempts=0");
  await f.sync.runOnce();
  assert.deepEqual(facts(f.google.tabs.get('Расписание')), [['Final','04.11.2026','14:00']]);
  assert.ok(facts(f.google.tabs.get('Слоты')).every(row => row[2] === 'Final'));
  const state = (await f.db.query('SELECT previous_payload FROM eduson_booking.sheet_projections')).rows[0].previous_payload;
  assert.deepEqual(state.managedSchedules, final.managedSchedules);
  assert.ok(!state.attemptedManagedSchedules?.length);
});
test('domain unresolved conflict is reported safely before fetching Google', {skip: !available}, async t => {
  const f = await fixture(t, {getSnapshot: () => {const error = new Error('customer PII'); error.code = 'PROJECTION_UNRESOLVED'; error.status = 409; throw error;}});
  assert.equal((await f.sync.runOnce()).error, 'SHEET_SNAPSHOT_UNRESOLVED');
  assert.equal(f.google.requests.length, 0);
});
test('schedule retries obey backoff and the eight-attempt limit without exposing error text', {skip: !available}, async t => {
  let requests = 0;
  const f = await fixture(t, {fetchImpl: async () => {requests++; throw new Error('Bearer SECRET private_key PRIVATE customer@example.test PASSWORD-HASH');}});
  assert.equal((await f.sync.runOnce()).error, 'NETWORK_FAILED');
  const first = requests;
  assert.equal((await f.sync.runOnce()).processed, false);
  assert.equal(requests, first);
  for (let attempt = 0; attempt < 10; attempt++) {f.advance(3_600_000); await f.sync.runOnce();}
  const row = (await f.db.query('SELECT attempts,status,last_error FROM eduson_booking.sheet_projections')).rows[0];
  assert.equal(row.attempts, 8);
  assert.equal(row.status, 'error');
  assert.doesNotMatch(JSON.stringify(row) + JSON.stringify(await f.sync.status()), /SECRET|PRIVATE|customer@example|PASSWORD-HASH|Bearer/);
});
test('an expired lease is reclaimed and the old worker cannot overwrite the new projection', {skip: !available}, async t => {
  let release, entered;
  const observed = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {getSnapshot: async () => {entered(); await gate; return baseSnapshot();}});
  const oldRun = f.sync.runOnce();
  await observed;
  f.advance(6 * 60_000);
  const next = baseSnapshot();
  next.slotRows.forEach(row => {row.status = 'wait'; row.bookingId = '';});
  const replacement = module.createScheduleSheetSynchronizer({...f.config, getSnapshot: async () => next});
  assert.equal((await replacement.runOnce()).status, 'done');
  const before = JSON.stringify([...f.google.tabs]);
  release();
  assert.equal((await oldRun).error, 'SYNC_LEASE_LOST');
  assert.equal(JSON.stringify([...f.google.tabs]), before);
  assert.equal((await f.db.query('SELECT status FROM eduson_booking.sheet_projections')).rows[0].status, 'done');
});
test('a stale final processing attempt becomes a terminal error without fetching Google', {skip: !available}, async t => {
  const f = await fixture(t);
  await f.db.query("UPDATE eduson_booking.sheet_projections SET status='processing',attempts=8,lease_token='expired',lease_until='2026-11-03T08:00:00Z'");
  await f.sync.runOnce();
  const row = (await f.db.query('SELECT status,lease_token,last_error FROM eduson_booking.sheet_projections')).rows[0];
  assert.equal(row.status, 'error');
  assert.equal(row.lease_token, null);
  assert.equal(row.last_error, 'SYNC_ATTEMPTS_EXHAUSTED');
  assert.equal(f.google.requests.length, 0);
});
test('real domain mutations project pending bookings, cancellation release and a closed day', {skip: !available}, async t => {
  const {openDatabase} = await import('../db.mjs');
  const {BookingService} = await import('../domain.mjs');
  const db = await openDatabase({memory: true});
  t.after(() => db.close());
  const admin = {id: 'admin', role: 'admin', name: 'Admin'};
  const seller = {id: 'seller', role: 'sales', name: 'Owned'};
  const caller = {id: 'caller', role: 'call_center', name: 'Caller'};
  for (const actor of [admin,seller,caller]) await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES ($1,$2,$3,$4,$5,true,$6)', [actor.id, `${actor.id}@example.invalid`, actor.name, actor.role, 'unused', '[]']);
  const service = new BookingService(db, {now: () => new Date('2026-11-03T09:00:00Z'), random: () => 0});
  await service.saveSchedule(seller, {date: '2026-11-04', intervals: [{start: '14:00', end: '15:00'}], reserveCapacity: 1});
  const booking = await service.createBooking(caller, {date: '2026-11-04', time: '14:00', studentName: 'Synthetic', parentName: 'Synthetic', phone: '+79990000000', crmUrl: 'https://synthetic.amocrm.ru/leads/detail/42', age: 10, hasPc: true, parentPresent: true, comment: '', idempotencyKey: 'schedule-integration'});
  const f = await fixture(t, {db, getSnapshot: () => service.getSheetSnapshot(admin)});
  await f.sync.runOnce();
  let rows = facts(f.google.tabs.get('Слоты'));
  assert.equal(rows.filter(row => row[3] === 'booked').length, 1);
  assert.equal(rows.find(row => row[3] === 'booked')[4], booking.id);
  await service.cancelBooking(caller, booking.id, {version: booking.version, reason: 'Synthetic cancellation'});
  await f.sync.runOnce();
  rows = facts(f.google.tabs.get('Слоты'));
  assert.equal(rows.filter(row => row[3] === 'wait').length, 2);
  await service.saveSchedule(seller, {date: '2026-11-04', intervals: [], reserveCapacity: 1});
  await f.sync.runOnce();
  assert.equal(facts(f.google.tabs.get('Слоты')).length, 0);
  assert.equal(facts(f.google.tabs.get('Расписание')).length, 0);
});
