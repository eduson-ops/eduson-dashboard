import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {migrateV3} from '../migration-v3.mjs';

const names=['Виноградова Нина','Куюмджу Дарья','Папашвили Давид','Перебейносов Андрей'];
const ids=['existing-nina','existing-daria','existing-david','existing-andrei'];
const at='2026-11-04T07:00:00.000Z';
const admin={id:'migration-admin',role:'admin'};
function source(){
  const csv=[1,2].map((id,index)=>({rubitimeId:id,employeeName:'Павлов Владимир',parentName:'Родитель',phone:'+79990000000',childName:`private-child-${id}`,childAge:10,hasComputerRaw:'Да',parentAttendingRaw:'Да',startLocal:`2026-10-${index?'29':'03'}T18:00:00`,createdLocal:'2026-10-01T12:00:00',durationMinutes:60,rawStatusTitle:'Записан',timezone:'Europe/Moscow',orderId:'same-not-a-lead-id',comment:'private-comment',csvRaw:{original:id}}));
  const api=csv.map(c=>({id:c.rubitimeId,record:c.startLocal.replace('T',' '),created_at:'2026-10-01 12:00:30',updated_at:null,duration:'60',status:0,status_title:'Записан',cooperator_title:c.employeeName}));
  return{snapshot:{capturedAt:at,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время'],['Виноградова Н.','04.11.2026','10:00'],['Виноградова Нина','04.11.2026','10:00'],['Виноградова Н.','04.11.2026','11:00'],['Виноградова Н.','04.11.2026','12:00'],['Федяинов Ж.','08.04.2026','17:00'],['Павлов В.','29.10.2026','18:00']]},managers:{values:[['Имя','Активен'],['Виноградова Н.','да'],['Федяинов Е.','да'],['Павлов В.','да']]}}},rubitime:{csv,api},records:[]};
}
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const[index,name]of names.entries())await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active)VALUES($1,$2,$3,\'sales\',\'untouched\',true)',[ids[index],`migration-${index}@test.local`,name]);
  await db.query(`INSERT INTO eduson_booking.schedules(manager_id,date,intervals,reserve_capacity,version)VALUES($1,'2026-11-04',$2,1,7)`,[ids[0],JSON.stringify([{start:'10:00',end:'11:00',reserveCapacity:1},{start:'11:00',end:'12:00',reserveCapacity:0}])]);
  await db.query(`INSERT INTO eduson_booking.sheet_projections(key,version,previous_payload)VALUES('schedule',3,$1)`,[JSON.stringify({marker:'preserve',managedSchedules:[{manager:'Previous ownership',date:'2026-09-01'}]})]);
  return db;
}
const dry=(db,input,options={})=>migrateV3(db,input,{now:()=>new Date(at),...options});
const apply=async(db,input,options={})=>{const plan=await dry(db,input,options);assert.equal(plan.ok,true,JSON.stringify(plan));return migrateV3(db,input,{now:()=>new Date(at),apply:true,expectedDatabaseFingerprint:plan.databaseFingerprint,...options});};

test('dry-run maps a full calendar union and source IDs without writing or exposing private values',async t=>{
  const db=await fixture(t),input=source();
  input.rubitime.csv[0].childAge='10';
  const plan=await dry(db,input);
  assert.equal(plan.ok,true);assert.equal(plan.applied,false);
  assert.equal(plan.counts.sourceRows,6);assert.equal(plan.counts.canonicalPrimaryHours,5);assert.equal(plan.counts.aliasDuplicateHours,1);
  assert.equal(plan.counts.managerDays,3);assert.equal(plan.counts.records,2);assert.equal(plan.counts.historyRecords,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.schedules')).rows[0].n,1);
  assert.equal((await db.query("SELECT to_regclass('eduson_booking.migration_v3_runs') name")).rows[0].name,null);
  assert.doesNotMatch(JSON.stringify(plan),/private-child|private-comment|79990000000|Родитель/);
  assert.match(plan.databaseFingerprint,/^[a-f0-9]{64}$/);
});

test('apply preserves existing UUIDs and exact reserves and archives uncertain source records without fake calendar',async t=>{
  const db=await fixture(t),input=source();
  const result=await apply(db,input);
  assert.equal(result.applied,true);assert.equal(result.idempotent,false);
  const users=(await db.query('SELECT * FROM eduson_booking.users ORDER BY id')).rows;
  for(const[index,name]of names.entries()){const user=users.find(u=>u.id===ids[index]);assert.equal(user.name,name);assert.equal(user.password_hash,'untouched');assert.equal(user.active,true);}
  assert.equal(users.filter(u=>u.name==='Федяинов Ж.').length,1);assert.equal(users.some(u=>u.name==='Федяинов Е.'),false);
  assert.equal(users.find(u=>u.name==='Федяинов Ж.').active,false);assert.equal(users.find(u=>u.name==='Павлов В.').active,false);
  const day=(await db.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1',[ids[0]])).rows[0];
  assert.equal(day.version,8);
  assert.deepEqual(day.intervals,[{start:'10:00',end:'11:00',reserveCapacity:1},{start:'11:00',end:'12:00',reserveCapacity:0},{start:'12:00',end:'13:00',reserveCapacity:1}]);
  const rows=(await db.query('SELECT * FROM eduson_booking.bookings ORDER BY id')).rows;
  assert.equal(rows.length,2);
  assert.ok(rows.every(b=>b.history_only && !b.is_test && b.state==='scheduled' && b.confirmation_status==='pending' && !b.assigned_to && !b.completed_at && !b.crm_url));
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.sync_jobs')).rows[0].n,0);
  const mapping=(await db.query('SELECT * FROM eduson_booking.migration_v3_sources ORDER BY source_id')).rows;
  assert.deepEqual(mapping.map(m=>[m.source,m.source_id]),[['rubitime','1'],['rubitime','2']]);
  assert.equal(mapping[0].raw.csv.orderId,'same-not-a-lead-id');assert.equal(mapping[1].raw.api.id,2);
  const snapshot=await new BookingService(db,{now:()=>new Date(at)}).getSheetSnapshot(admin);
  assert.equal(snapshot.scheduleRows.length,5);
  assert.ok(snapshot.slotRows.every(r=>r.date!=='2026-10-03'));
  const projection=(await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
  assert.equal(projection.previous_payload.marker,'preserve');
  assert.ok(projection.previous_payload.attemptedManagedSchedules.some(p=>p.manager==='Виноградова Н.'&&p.date==='2026-11-04'));
  assert.ok(projection.previous_payload.managedSchedules.some(p=>p.manager==='Previous ownership'));
});

test('idempotent retry never resets changed user facts, bookings or schedule projection version',async t=>{
  const db=await fixture(t),input=source();await apply(db,input);
  const before=(await db.query("SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].version;
  await db.query("UPDATE eduson_booking.users SET age_groups='[\"13-14\"]',active=false WHERE id=$1",[ids[0]]);
  const retry=await migrateV3(db,input,{apply:true,now:()=>new Date(at),expectedDatabaseFingerprint:'stale-but-already-applied'});
  assert.equal(retry.idempotent,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,2);
  assert.equal((await db.query("SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].version,before);
  assert.equal((await db.query('SELECT active FROM eduson_booking.users WHERE id=$1',[ids[0]])).rows[0].active,false);
});

test('stale preview and changed stable source identity fail atomically without partial calendar writes',async t=>{
  const db=await fixture(t),input=source();const plan=await dry(db,input);
  await db.query('UPDATE eduson_booking.schedules SET version=version+1 WHERE manager_id=$1',[ids[0]]);
  await assert.rejects(migrateV3(db,input,{apply:true,now:()=>new Date(at),expectedDatabaseFingerprint:plan.databaseFingerprint}),{code:'DATABASE_SNAPSHOT_CHANGED'});
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,0);
  await apply(db,input);
  const changed=structuredClone(input);changed.rubitime.csv[0].comment='Changed private field';changed.snapshot.sheet.schedule.values.push(['Виноградова Н.','05.11.2026','10:00']);
  const conflict=await dry(db,changed);assert.equal(conflict.ok,false);assert.ok(conflict.issues.some(i=>i.code==='SOURCE_RECORD_CHANGED'));
  await assert.rejects(migrateV3(db,changed,{apply:true,now:()=>new Date(at),expectedDatabaseFingerprint:conflict.databaseFingerprint}),{code:'INVALID_MIGRATION_SOURCE'});
  assert.equal((await db.query("SELECT count(*)::int n FROM eduson_booking.schedules WHERE date='2026-11-05'")).rows[0].n,0);
});

test('API/CSV disagreement and guessed historical completion are held as issues',async t=>{
  const db=await fixture(t),input=source();input.rubitime.api[0].status=1;
  const bad=await dry(db,input);assert.equal(bad.ok,false);assert.ok(bad.issues.some(i=>i.code==='RUBITIME_STATUS_UNSUPPORTED'));
  input.rubitime.api[0].status=0;
  input.records=[{sourceIdentity:{source:'amocrm',id:'lead-1'},date:'2026-10-05',time:'18:00',age:10,state:'completed',raw:{}}];
  const guessed=await dry(db,input);assert.equal(guessed.ok,false);assert.ok(guessed.issues.some(i=>i.code==='OUTCOME_EVIDENCE_REQUIRED'));
});

test('a later calendar batch retains inferred source timestamps and identity fingerprints across import clocks',async t=>{
  const db=await fixture(t),input=source();
  input.records=[{sourceIdentity:{source:'amocrm',id:'missing-timestamps'},date:'2026-10-05',time:'18:00',age:10,raw:{original:'stable source'}}];
  await apply(db,input);
  const before=(await db.query("SELECT b.created_at,b.updated_at,s.fingerprint FROM eduson_booking.bookings b JOIN eduson_booking.migration_v3_sources s ON s.booking_id=b.id WHERE s.source='amocrm'")).rows[0];
  assert.equal(new Date(before.created_at).toISOString(),input.snapshot.capturedAt);
  const next=structuredClone(input);next.snapshot.sheet.schedule.values.push(['Виноградова Н.','06.11.2026','10:00']);
  const options={now:()=>new Date('2026-11-05T07:00:00.000Z')};
  const preview=await migrateV3(db,next,options);assert.equal(preview.ok,true,JSON.stringify(preview.issues));
  await migrateV3(db,next,{...options,apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint});
  const after=(await db.query("SELECT b.created_at,b.updated_at,s.fingerprint FROM eduson_booking.bookings b JOIN eduson_booking.migration_v3_sources s ON s.booking_id=b.id WHERE s.source='amocrm'")).rows[0];
  assert.deepEqual(after,before);
});

async function existingBooking(db){
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by,confirmation_status,assigned_to,assignment_kind,state,version)
    VALUES('existing-booking','2026-11-04','12:00','2026-11-04T09:00Z','2026-11-04T10:00Z','','','','https://eduson.amocrm.ru/leads/detail/9001',10,NULL,NULL,'2026-11-04T07:00Z','legacy-import','confirmed',$1,'primary','in_progress',4)`,[ids[0]]);
  const record={sourceIdentity:{source:'amocrm',id:'9001'},date:'2026-11-04',time:'12:00',age:10,studentName:'CRM student',crmUrl:'https://eduson.amocrm.ru/leads/detail/9001',raw:{leadId:9001}};
  const evidence={sourceIdentity:record.sourceIdentity,bookingId:'existing-booking',expectedVersion:4,evidence:{kind:'exact_crm_date_time',crmUrl:record.crmUrl,date:record.date,time:record.time,raw:{verifiedLeadId:9001}}};
  return{record,evidence};
}
test('an existing CRM and hour match requires explicit adoption evidence',async t=>{
  const db=await fixture(t),input=source(),{record}=await existingBooking(db);input.records=[record];
  const preview=await dry(db,input);assert.equal(preview.ok,false);assert.ok(preview.issues.some(i=>i.code==='EXISTING_BOOKING_EVIDENCE_REQUIRED'));
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,1);
});
test('exact adoption adds identity and raw provenance without touching existing booking facts or version',async t=>{
  const db=await fixture(t),input=source(),{record,evidence}=await existingBooking(db);input.records=[record];
  const before=(await db.query("SELECT * FROM eduson_booking.bookings WHERE id='existing-booking'")).rows[0];
  const options={existingRecordEvidence:[evidence],enqueueFutureBookings:true};
  const preview=await dry(db,input,options);assert.equal(preview.ok,true,JSON.stringify(preview.issues));assert.equal(preview.counts.adoptedRecords,1);
  await apply(db,input,options);
  assert.deepEqual((await db.query("SELECT * FROM eduson_booking.bookings WHERE id='existing-booking'")).rows[0],before);
  const mapping=(await db.query("SELECT * FROM eduson_booking.migration_v3_sources WHERE source='amocrm'")).rows[0];
  assert.equal(mapping.booking_id,'existing-booking');assert.deepEqual(mapping.raw,record.raw);
  assert.equal((await db.query("SELECT count(*)::int n FROM eduson_booking.audit_events WHERE action='migration_v3_source_adopted'")).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,3);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.sync_jobs')).rows[0].n,0);
});
test('stale or mismatched adoption evidence holds the complete batch before calendar writes',async t=>{
  const db=await fixture(t),input=source(),{record,evidence}=await existingBooking(db);input.records=[record];
  const stale={...evidence,expectedVersion:3};
  const preview=await dry(db,input,{existingRecordEvidence:[stale]});assert.equal(preview.ok,false);assert.ok(preview.issues.some(i=>i.code==='EXISTING_BOOKING_VERSION_CONFLICT'));
  await assert.rejects(migrateV3(db,input,{apply:true,now:()=>new Date(at),expectedDatabaseFingerprint:preview.databaseFingerprint,existingRecordEvidence:[stale]}),{code:'INVALID_MIGRATION_SOURCE'});
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.schedules')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,1);
  const wrong={...evidence,evidence:{...evidence.evidence,time:'13:00'}};
  const mismatch=await dry(db,input,{existingRecordEvidence:[wrong]});assert.equal(mismatch.ok,false);assert.ok(mismatch.issues.some(i=>i.code==='EXISTING_BOOKING_EVIDENCE_MISMATCH'));
});
