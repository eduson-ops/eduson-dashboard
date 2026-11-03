import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../db.mjs';
import { verifyPassword } from '../auth.mjs';
import { BookingService } from '../domain.mjs';
import { inspectLegacySnapshot, importLegacySnapshot } from '../legacy-import.mjs';

const slotHeaders = ['Дата', 'Время', 'Менеджер', 'Статус', ''];
const legacyHeaders = ['ID','Отметка времени','Дата','Время','Сейл','AmoCRM','Возраст','Телефон','Место','Статус','Автор','Изменено','Кто изменил','Idempotency-Key','Резервный журнал'];
const confirmationHeaders=['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? '];
const serialTimestamp=instant=>(+new Date(instant)+10800000-Date.UTC(1899,11,30))/86400000;
const names = ['Первый менеджер','Второй менеджер','Третий менеджер','Четвёртый менеджер'];
const capturedAt = '2026-11-03T18:00:00.000Z';
const serialDate = serial => new Date(Date.UTC(1899,11,30) + serial * 86400000).toISOString().slice(0,10);
const russianDate = serial => serialDate(serial).split('-').reverse().join('.');

function snapshot() {
  const triples = [ [46330, .625, names[0]], [46333, 11/24, names[1]] ];
  for (let i=0; triples.length<31; i++) {
    const triple = [46329 + Math.floor(i/12), (10+i%12)/24, names[i%4]];
    if (!triples.some(t => JSON.stringify(t) === JSON.stringify(triple))) triples.push(triple);
  }
  const slots = triples.flatMap((triple,i) => Array.from({length:i<21?2:1}, () => [...triple,'wait','']));
  const chosen = [triples[0],triples[1],triples[1],...triples.slice(2,10),triples[10],triples[11]];
  const bookings = chosen.map(([date,time,manager],i) => {
    const id = `vds-${i+1}`;
    const hhmm = `${String(Math.round(time*24)).padStart(2,'0')}:00`;
    const created = `2026-11-03T10:${String(i).padStart(2,'0')}:00+00:00`;
    return {id,payload:{id,date:russianDate(date),time:hhmm,manager,crmUrl:`https://eduson.amocrm.ru/leads/detail/${100+i}`,age:7+i%9,pc:i%2?'Нет':'Да',parent:i%2?'Да':'Нет',comment:`private-comment-${i}`,created},status:i<11?'active':'deleted',slot_row:1000+i,idem:`original-idem-${i}`,created,updated:`2026-11-03T11:${String(i).padStart(2,'0')}:00Z`};
  });
  const audit = bookings.flatMap((b,i) => [{id:i+1,booking:b.id,action:'create',at:b.created},...(b.status==='deleted'?[{id:100+i,booking:b.id,action:'cancel',at:b.updated}]:[])]);
  return {version:1,capturedAt,timezone:'Europe/Moscow',sqlite:{bookings,audit},sheet:{slots:{values:[slotHeaders,...slots]},legacyBookings:{values:[legacyHeaders,['script-1',46329.5,46330,.625,names[0],'https://eduson.amocrm.ru/leads/detail/900',12,'+79998887766',2,'confirmed','old-author@example.test',46329.625,'','original-script-key','ok'],...Array.from({length:29},(_,i)=>i===0?Array.from({length:14},(_,n)=>n===13?'unused-key':''):[])]},managers:{values:[['Имя','Активен'],...names.map(n=>[n,true])]}}};
}

async function database(t) { const db=await openDatabase({memory:true}); t.after(()=>db.close()); return db; }
const count = async (db, table) => (await db.query(`SELECT count(*)::int AS n FROM eduson_booking.${table}`)).rows[0].n;

test('dry-run validates all source records and exact capacity without touching a database', async () => {
  const source=snapshot();
  const result=inspectLegacySnapshot(source);
  assert.equal(result.ok,true);
  assert.equal(result.counts.bookings,14);
  assert.equal(result.counts.active,12);
  assert.equal(result.counts.cancelled,2);
  assert.equal(result.counts.slotRows,52);
  assert.equal(result.counts.slotTriples,31);
  assert.equal(result.counts.managers,4);
  assert.equal(result.counts.ignoredLegacyRows,29);
  assert.equal(result.counts.sqliteAuditEvents,15);
  const dry=await importLegacySnapshot({transaction(){throw Error('database touched');}},source,{apply:false});
  assert.equal(dry.applied,false);
  assert.deepEqual(dry.counts,result.counts);
  assert.doesNotMatch(JSON.stringify(result),/private-comment|Первый|7999888|original-idem/);
});

test('directory display padding is normalized without changing source booking names or raw evidence', async t => {
  const source=snapshot();
  source.sheet.managers.values[1][0]='  Первый   менеджер ';
  assert.equal(inspectLegacySnapshot(source).ok,true);
  const db=await database(t);
  await importLegacySnapshot(db,source,{apply:true});
  const manifest=(await db.query("SELECT payload FROM eduson_booking.audit_events WHERE action='legacy_snapshot_imported'")).rows[0].payload;
  assert.equal(manifest.raw.managers.values[1][0],'  Первый   менеджер ');
  source.sheet.managers.values[1][1]=false;
  assert.ok(inspectLegacySnapshot(source).issues.some(x=>x.code==='SOURCE_MANAGER_INACTIVE'));
});

test('real PostgreSQL import preserves 14 unique records, exact 52 places and unknown facts', async t => {
  const db=await database(t); const source=snapshot();
  const result=await importLegacySnapshot(db,source,{apply:true,now:()=>new Date('2026-11-03T19:00Z')});
  assert.equal(result.applied,true);
  assert.equal(await count(db,'bookings'),14);
  assert.equal(await count(db,'users'),4);
  assert.equal(await count(db,'sync_jobs'),0);
  const rows=(await db.query('SELECT * FROM eduson_booking.bookings ORDER BY id')).rows;
  const legacy=rows.find(b=>b.id==='script-1');
  assert.equal(new Date(legacy.date).toISOString().slice(0,10),'2026-11-04');
  assert.equal(legacy.time,'15:00');
  assert.equal(new Date(legacy.starts_at).toISOString(),'2026-11-04T12:00:00.000Z');
  assert.equal(new Date(legacy.created_at).toISOString(),'2026-11-03T09:00:00.000Z');
  assert.equal(new Date(legacy.updated_at).toISOString(),'2026-11-03T12:00:00.000Z');
  assert.equal(legacy.has_pc,null); assert.equal(legacy.parent_present,null);
  assert.equal(legacy.student_name,''); assert.equal(legacy.parent_name,'');
  assert.equal(legacy.phone,'+79998887766');
  assert.equal(legacy.confirmation_status,'confirmed');
  assert.equal(legacy.assignment_kind,'primary');
  assert.ok(legacy.assigned_to);
  for (const b of rows.filter(b=>b.id.startsWith('vds-'))) {
    assert.equal(b.created_by,'legacy-import'); assert.equal(b.phone,'');
    assert.equal(b.student_name,''); assert.equal(b.parent_name,'');
    assert.equal(b.confirmation_status,'pending'); assert.equal(b.assigned_to,null);
    assert.ok(b.idempotency_key.startsWith('original-idem-'));
    if (b.state==='cancelled') { assert.equal(b.cancel_source,'legacy_unknown'); assert.equal(b.cancel_reason,'legacy_unknown'); assert.ok(b.cancelled_at); }
  }
  const schedules=(await db.query('SELECT * FROM eduson_booking.schedules')).rows;
  const capacity=schedules.reduce((sum,s)=>sum+s.intervals.reduce((n,i)=>n+((Number(i.end.slice(0,2))*60+Number(i.end.slice(3)))-(Number(i.start.slice(0,2))*60+Number(i.start.slice(3))))/60*(1+i.reserveCapacity),0),0);
  assert.equal(capacity,52);
  assert.ok(schedules.some(s=>s.intervals.some(i=>i.reserveCapacity===0)));
  assert.ok(schedules.some(s=>s.intervals.some(i=>i.reserveCapacity===1)));
  const events=(await db.query("SELECT * FROM eduson_booking.audit_events WHERE action='legacy_imported' ORDER BY booking_id")).rows;
  assert.equal(events.length,14);
  assert.deepEqual(Object.keys(events[0].payload).sort(),['capturedAt','elapsedUnknown','fingerprint','managerName','raw','source']);
  const vds=events.find(e=>e.booking_id==='vds-1').payload;
  assert.equal(vds.source,'vds_sqlite');
  assert.deepEqual(vds.raw.booking,source.sqlite.bookings[0]);
  assert.deepEqual(vds.raw.audit,source.sqlite.audit.filter(e=>e.booking==='vds-1'));
  assert.equal(vds.raw.durationInferred,true);
  assert.equal(events.find(e=>e.booking_id==='vds-4').payload.elapsedUnknown,true);
  assert.equal(events.find(e=>e.booking_id==='vds-1').payload.elapsedUnknown,false);
  assert.equal(events.find(e=>e.booking_id==='script-1').payload.raw.confirmedAtInferred,true);
  assert.equal(await count(db,'audit_events'),32); // 14 imports + 15 old events + 2 cancellation facts + source manifest.
  assert.equal((await db.query("SELECT status,version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].status,'pending');
  const projected=await new BookingService(db).getSheetSnapshot({id:'admin',role:'admin'});
  assert.equal(projected.slotRows.length,52);
  assert.equal(projected.ownedBookingIds.length,14);
  assert.deepEqual(projected.unresolved,[]);
});

test('retry is idempotent and never rewrites import state or increments the projection', async t => {
  const db=await database(t), source=snapshot();
  await importLegacySnapshot(db,source,{apply:true});
  const before=(await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
  const result=await importLegacySnapshot(db,source,{apply:true});
  assert.equal(result.idempotent,true);
  assert.equal(await count(db,'bookings'),14); assert.equal(await count(db,'audit_events'),32);
  assert.deepEqual((await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0],before);
});

test('confirmation evidence uses exact CRM, slot, creation causality and full manager words',async t=>{
  const db=await database(t), source=snapshot(), original=source.sqlite.bookings[0];
  const confirmedAt='2026-11-03T12:31:55.000Z';
  const row=[serialTimestamp(confirmedAt),`${original.payload.crmUrl}/?ignored=1`,'менеджер Первый',.625];
  source.sheet.confirmations={values:[confirmationHeaders,row]};
  const inspection=inspectLegacySnapshot(source);
  assert.equal(inspection.ok,true); assert.equal(inspection.counts.matchedConfirmations,1);
  await importLegacySnapshot(db,source,{apply:true});
  const imported=(await db.query("SELECT * FROM eduson_booking.bookings WHERE id='vds-1'")).rows[0];
  assert.equal(imported.confirmation_status,'confirmed');
  assert.equal(new Date(imported.confirmed_at).toISOString(),confirmedAt);
  assert.equal(imported.assignment_kind,'primary'); assert.ok(imported.assigned_to);
  assert.equal(imported.state,'scheduled'); assert.equal(imported.completed_at,null);
  assert.equal(new Date(imported.created_at).toISOString(),new Date(original.created).toISOString());
  assert.equal(new Date(imported.updated_at).toISOString(),new Date(original.updated).toISOString());
  const event=(await db.query("SELECT * FROM eduson_booking.audit_events WHERE booking_id='vds-1' AND action='legacy_imported'")).rows[0];
  assert.deepEqual(event.payload.raw.confirmation,{row:2,values:row,headers:confirmationHeaders,confirmedAt});
  const evidence=(await db.query("SELECT * FROM eduson_booking.audit_events WHERE booking_id='vds-1' AND action='legacy_confirmation_evidence'")).rows[0];
  assert.equal(evidence.payload.confirmedAt,confirmedAt);
  assert.equal(evidence.actor_id,'legacy-import');
  assert.doesNotMatch(JSON.stringify(inspection),/менеджер|amocrm|12:31/);
});

test('confirmation history outside the causal matching slot is counted without being imported',()=>{
  const source=snapshot(), original=source.sqlite.bookings[0];
  source.sheet.confirmations={values:[confirmationHeaders,
    [serialTimestamp('2026-11-03T12:31:55Z'),'https://eduson.amocrm.ru/leads/detail/999999','unrelated','.625'],
    [serialTimestamp('2026-11-03T12:31:55Z'),original.payload.crmUrl,names[0],.5],
    [serialTimestamp('2026-11-04T12:31:55Z'),original.payload.crmUrl,names[0],.625],
    [serialTimestamp('2026-11-03T09:00:00Z'),original.payload.crmUrl,names[0],.625],
    ['invalid timestamp',original.payload.crmUrl,'unknown','invalid time'],
    ['bad unrelated','invalid crm','','']
  ]};
  const result=inspectLegacySnapshot(source);
  assert.equal(result.ok,true); assert.equal(result.counts.matchedConfirmations,0);
  assert.equal(result.counts.unmatchedConfirmations,1); assert.equal(result.counts.skippedConfirmations,5);
});

test('confirmation full-word conflicts, initials and multiple causal rows block with value-free issues',async t=>{
  const db=await database(t);
  for(const manager of ['Другой менеджер','Первый м.']) {
    const source=snapshot(); source.sheet.confirmations={values:[confirmationHeaders,[serialTimestamp('2026-11-03T12:31:55Z'),source.sqlite.bookings[0].payload.crmUrl,manager,.625]]};
    const result=inspectLegacySnapshot(source);
    assert.equal(result.ok,false); assert.ok(result.issues.some(i=>i.code==='CONFIRMATION_MANAGER_MISMATCH'));
    await assert.rejects(()=>importLegacySnapshot(db,source,{apply:true}),{code:'INVALID_LEGACY_SNAPSHOT'});
  }
  const duplicate=snapshot(), row=[serialTimestamp('2026-11-03T12:31:55Z'),duplicate.sqlite.bookings[0].payload.crmUrl,names[0],.625];
  duplicate.sheet.confirmations={values:[confirmationHeaders,row,[...row]]};
  assert.ok(inspectLegacySnapshot(duplicate).issues.some(i=>i.code==='AMBIGUOUS_CONFIRMATION_EVIDENCE'));
  const badHeaders=snapshot(); badHeaders.sheet.confirmations={values:[['Timestamp','CRM','Manager','Time']]};
  assert.equal(inspectLegacySnapshot(badHeaders).ok,false);
  assert.equal(await count(db,'bookings'),0);
});

test('past confirmation preserves unknown lesson outcome and its evidence fingerprint',async t=>{
  const db=await database(t), source=snapshot(); source.capturedAt='2026-11-04T18:00:00Z';
  source.sheet.confirmations={values:[confirmationHeaders,[serialTimestamp('2026-11-03T12:31:55Z'),source.sqlite.bookings[0].payload.crmUrl,names[0],.625]]};
  await importLegacySnapshot(db,source,{apply:true});
  const service=new BookingService(db,{now:()=>new Date('2026-11-04T19:00:00Z')});
  const booking=(await service.listBookings({id:'admin',role:'admin'})).find(b=>b.id==='vds-1');
  assert.equal(booking.confirmationStatus,'confirmed'); assert.equal(booking.state,'scheduled');
  assert.equal(booking.legacy.elapsedUnknown,true); assert.equal(booking.legacy.needsReview,true);
  const changed=structuredClone(source); changed.sheet.confirmations.values[1][0]=serialTimestamp('2026-11-03T12:32:00Z');
  await assert.rejects(()=>importLegacySnapshot(db,changed,{apply:true}),{code:'TARGET_BOOKINGS_CONFLICT'});
});

test('imported cancellation archive survives restore with original time and unknown author',async t=>{
  const db=await database(t), source=snapshot(), original=source.sqlite.bookings[11];
  source.capturedAt='2026-11-03T12:00:00Z';
  await importLegacySnapshot(db,source,{apply:true});
  const actor={id:'admin',role:'admin',name:'Новый администратор'};
  const service=new BookingService(db,{now:()=>new Date('2026-11-03T13:00:00Z')});
  const before=(await service.listBookings(actor,{scope:'all'})).find(b=>b.id===original.id);
  assert.equal(before.cancellation.timestamp,new Date(original.updated).toISOString());
  assert.equal(before.cancellation.authorUnknown,true);
  assert.equal(before.cancellation.source,'legacy_unknown');
  assert.notEqual(before.cancellation.manager,original.payload.manager);
  const restored=await service.restoreBooking(actor,original.id,{version:before.version});
  assert.equal(restored.state,'scheduled'); assert.equal(restored.cancelledAt,null);
  assert.equal(restored.cancellation.timestamp,new Date(original.updated).toISOString());
  assert.equal(restored.cancellation.authorUnknown,true);
  const raw=(await db.query("SELECT payload FROM eduson_booking.audit_events WHERE booking_id=$1 AND action='legacy_imported'",[original.id])).rows[0].payload.raw;
  assert.deepEqual(raw.booking,original);
  assert.deepEqual(raw.audit,source.sqlite.audit.filter(e=>e.booking===original.id));
});

test('confirmation refuses an ineligible reused manager without inventing a different assignee',async t=>{
  const db=await database(t),source=snapshot();
  source.sheet.confirmations={values:[confirmationHeaders,[serialTimestamp('2026-11-03T12:31:55Z'),source.sqlite.bookings[0].payload.crmUrl,names[0],.625]]};
  await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash,age_groups) VALUES('existing','existing@example.test',$1,'sales','unused',$2)",[names[0],JSON.stringify(['1-3'])]);
  await assert.rejects(()=>importLegacySnapshot(db,source,{apply:true}),{code:'MANAGER_AGE_INELIGIBLE'});
  assert.equal(await count(db,'bookings'),0);assert.equal(await count(db,'users'),1);
});

test('schedule or audit changes cannot pass an existing snapshot fingerprint', async t => {
  const db=await database(t), source=snapshot();
  await importLegacySnapshot(db,source,{apply:true});
  const changed=snapshot(); changed.sheet.slots.values.at(-1)[3]='booked';
  await assert.rejects(()=>importLegacySnapshot(db,changed,{apply:true}),{code:'TARGET_BOOKINGS_CONFLICT'});
  const auditChanged=snapshot(); auditChanged.sqlite.audit[0].action='other-original-action';
  await assert.rejects(()=>importLegacySnapshot(db,auditChanged,{apply:true}),{code:'TARGET_BOOKINGS_CONFLICT'});
  assert.equal(await count(db,'bookings'),14);
});

test('import projection coalesces while preserving an in-flight lease and rollback payload', async t => {
  const db=await database(t);
  await db.query(`INSERT INTO eduson_booking.sheet_projections(key,version,status,attempts,lease_token,lease_until,previous_payload,updated_at) VALUES('schedule',3,'processing',2,'worker-token','2026-11-04T00:00Z',$1,'2026-11-03T17:00Z')`,[JSON.stringify({legacy:'rollback-marker'})]);
  await importLegacySnapshot(db,snapshot(),{apply:true});
  const row=(await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
  assert.equal(row.version,4); assert.equal(row.status,'pending'); assert.equal(row.attempts,0);
  assert.equal(row.lease_token,'worker-token'); assert.deepEqual(row.previous_payload,{legacy:'rollback-marker'});
  assert.equal(new Date(row.lease_until).toISOString(),'2026-11-04T00:00:00.000Z');
});

test('two confirmed legacy records retain primary and reserve places', async t => {
  const db=await database(t), source=snapshot();
  source.sqlite.bookings[0].status='deleted';
  const second=[...source.sheet.legacyBookings.values[1]];
  second[0]='script-2'; second[5]='https://eduson.amocrm.ru/leads/detail/901'; second[13]='script-key-2';
  source.sheet.legacyBookings.values.push(second);
  await importLegacySnapshot(db,source,{apply:true});
  assert.deepEqual((await db.query("SELECT assignment_kind FROM eduson_booking.bookings WHERE id LIKE 'script-%' ORDER BY id")).rows.map(r=>r.assignment_kind),['primary','reserve']);
});

test('inactive source manager blocks import and identical SQLite duplicates count once', async t => {
  const db=await database(t), inactive=snapshot(); inactive.sheet.managers.values[1][1]=false;
  assert.equal(inspectLegacySnapshot(inactive).issues[0].code,'SOURCE_MANAGER_INACTIVE');
  await assert.rejects(()=>importLegacySnapshot(db,inactive,{apply:true}),{code:'INVALID_LEGACY_SNAPSHOT'});
  assert.equal(await count(db,'users'),0);
  const duplicated=snapshot(); duplicated.sqlite.bookings.push(structuredClone(duplicated.sqlite.bookings[0]));
  const result=await importLegacySnapshot(db,duplicated,{apply:true});
  assert.equal(result.counts.identicalDuplicates,1); assert.equal(await count(db,'bookings'),14);
});

test('directory whitespace is normalized only for exact inactive-name checking and raw stays unchanged',async t=>{
  const db=await database(t),source=snapshot();
  source.sheet.managers.values[1][0]='  Первый   менеджер ';
  source.sheet.managers.values.push(['Куюмджу Д. ',true],['Первый м. ',false]);
  assert.equal(inspectLegacySnapshot(source).ok,true);
  await importLegacySnapshot(db,source,{apply:true});
  const manifest=(await db.query("SELECT payload FROM eduson_booking.audit_events WHERE action='legacy_snapshot_imported'")).rows[0].payload.raw;
  assert.deepEqual(manifest.managers,source.sheet.managers);
  assert.equal(await count(db,'users'),4);
  const inactive=structuredClone(source);inactive.sheet.managers.values[1][1]=false;
  assert.ok(inspectLegacySnapshot(inactive).issues.some(i=>i.code==='SOURCE_MANAGER_INACTIVE'));
});

test('a changed fingerprint or partial target refuses import without overwriting anything', async t => {
  const db=await database(t), source=snapshot();
  await importLegacySnapshot(db,source,{apply:true});
  source.sqlite.bookings[0].payload.comment='changed';
  await assert.rejects(()=>importLegacySnapshot(db,source,{apply:true}),{code:'TARGET_BOOKINGS_CONFLICT'});
  assert.equal((await db.query("SELECT comment FROM eduson_booking.bookings WHERE id='vds-1'")).rows[0].comment,'private-comment-0');
  await db.query("DELETE FROM eduson_booking.bookings WHERE id='vds-2'");
  await assert.rejects(()=>importLegacySnapshot(db,snapshot(),{apply:true}),{code:'TARGET_BOOKINGS_CONFLICT'});
  assert.equal(await count(db,'bookings'),13);
});

test('cross-source ID collisions, differing duplicates and malformed rows fail closed', async t => {
  const db=await database(t);
  for (const mutate of [
    s=>s.sheet.legacyBookings.values[1][0]='vds-1',
    s=>s.sqlite.bookings.push({...s.sqlite.bookings[0],status:'deleted'}),
    s=>s.sheet.slots.values[1][1]='25:00',
    s=>s.sheet.slots.values.at(-1)[1]='09:00',
    s=>s.sheet.slots.values.at(-1)[1]='15:30',
    s=>s.sqlite.bookings[0].payload.pc='unknown',
    s=>s.sheet.legacyBookings.values[1][2]='11/4/2026',
    s=>s.sqlite.audit.push({id:900,booking:'missing',action:'create',at:capturedAt})
  ]) {
    const source=snapshot(); mutate(source);
    assert.equal(inspectLegacySnapshot(source).ok,false);
    await assert.rejects(()=>importLegacySnapshot(db,source,{apply:true}),{code:'INVALID_LEGACY_SNAPSHOT'});
    assert.equal(await count(db,'users'),0); assert.equal(await count(db,'bookings'),0);
  }
});

test('manager ambiguity rolls back accounts and schedules; exact sales name reuses the user', async t => {
  const db=await database(t);
  await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash) VALUES('old','owner@example.test',$1,'admin','unused')",[names[0]]);
  await assert.rejects(()=>importLegacySnapshot(db,snapshot(),{apply:true}),{code:'MANAGER_IDENTITY_CONFLICT'});
  assert.equal(await count(db,'users'),1); assert.equal(await count(db,'bookings'),0); assert.equal(await count(db,'schedules'),0);
  await db.query("UPDATE eduson_booking.users SET role='sales' WHERE id='old'");
  await importLegacySnapshot(db,snapshot(),{apply:true});
  assert.equal(await count(db,'users'),4);
  assert.equal((await db.query("SELECT assigned_to FROM eduson_booking.bookings WHERE id='script-1'")).rows[0].assigned_to,'old');
});

test('unrelated target schedules refuse import rather than silently add capacity', async t => {
  const db=await database(t);
  await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash) VALUES('unrelated','other@example.test','Другой менеджер','sales','unused')");
  await db.query("INSERT INTO eduson_booking.schedules(manager_id,date,intervals) VALUES('unrelated','2026-11-04',$1)",[JSON.stringify([{start:'10:00',end:'11:00'}])]);
  await assert.rejects(()=>importLegacySnapshot(db,snapshot(),{apply:true}),{code:'TARGET_SCHEDULE_CONFLICT'});
  assert.equal(await count(db,'users'),1); assert.equal(await count(db,'schedules'),1); assert.equal(await count(db,'bookings'),0);
});

test('failed transaction removes its private credential file and existing files are never replaced', async t => {
  const db=await database(t), dir=await mkdtemp(join(tmpdir(),'legacy-private-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'credentials.json');
  await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash) VALUES('conflict','owner@example.test',$1,'admin','unused')",[names[0]]);
  await assert.rejects(()=>importLegacySnapshot(db,snapshot(),{apply:true,credentialOutputPath:path}),{code:'MANAGER_IDENTITY_CONFLICT'});
  await assert.rejects(()=>stat(path),{code:'ENOENT'});
  await writeFile(path,'keep-private-content');
  await assert.rejects(()=>importLegacySnapshot(db,snapshot(),{apply:true,credentialOutputPath:path}),{code:'CREDENTIAL_FILE_EXISTS'});
  assert.equal(await readFile(path,'utf8'),'keep-private-content'); assert.equal(await count(db,'bookings'),0);
});

test('credentials file contains only created accounts and works; dry-run CLI exposes only aggregates', async t => {
  const db=await database(t), dir=await mkdtemp(join(tmpdir(),'legacy-import-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'credentials.json'), source=snapshot();
  const result=await importLegacySnapshot(db,source,{apply:true,credentialOutputPath:path});
  const credentials=JSON.parse(await readFile(path,'utf8'));
  assert.equal(credentials.length,4);
  assert.doesNotMatch(JSON.stringify(result),/password|Первый|manager\.01/);
  for (const c of credentials) {
    assert.ok(names.includes(c.name)); assert.match(c.email,/^manager\.\d{2}@eduson\.local$/);
    const user=(await db.query('SELECT * FROM eduson_booking.users WHERE email=$1',[c.email])).rows[0];
    assert.equal(await verifyPassword(c.password,user.password_hash),true);
  }
  if (process.platform!=='win32') assert.equal((await stat(path)).mode&0o777,0o600);
  const snapshotPath=join(dir,'snapshot.json'); await writeFile(snapshotPath,JSON.stringify(source));
  const unusedOutput=join(dir,'must-not-exist.json');
  const cli=spawnSync(process.execPath,['booking-server/legacy-import.mjs','--snapshot',snapshotPath,'--credentials-out',unusedOutput],{encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://invalid:invalid@127.0.0.1:1/invalid'}});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).counts.bookings,14);
  assert.doesNotMatch(cli.stdout+cli.stderr,/private-comment|Первый|7999888|old-author|password|postgres:/);
  await assert.rejects(()=>stat(unusedOutput),{code:'ENOENT'});
});
