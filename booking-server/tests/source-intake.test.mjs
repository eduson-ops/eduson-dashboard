import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {migrateV3} from '../migration-v3.mjs';
import {initializeSourceIntakeSchema,createSourceIntake} from '../source-intake.mjs';

const admin={id:'intake-admin',role:'admin'},caller={id:'intake-cc',role:'call_center'},confirmation={id:'intake-confirm',role:'confirmation'},sales={id:'intake-sales',role:'sales',name:'Методист'};
const date='2026-11-10',clock='2026-11-04T07:00:00Z';
const record=extra=>({date,time:'12:00',durationMinutes:60,studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',crmUrl:'',age:10,hasPc:true,parentPresent:true,comment:'A',...extra});
const observation=(revision='1',extra={})=>({accountId:'synthetic-account',recordId:'record-1',revision,event:'upsert',observedAt:clock,record:record(),raw:{synthetic:true},...extra});
async function fixture(t,{reserveCapacity=1}={}){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmation,sales])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$3,$4,\'unused\')',[actor.id,actor.id+'@test.local',actor.name||actor.id,actor.role]);
  let now=new Date(clock);const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(sales,{date,intervals:[{start:'12:00',end:'14:00'}],reserveCapacity});
  await initializeSourceIntakeSchema(db);
  const config={db,service,now:()=>now,staffMap:{'synthetic-account':{'provider-staff-1':sales.id}}};
  const intake=createSourceIntake(config);
  return{db,service,intake,config,setNow:value=>now=new Date(value),bookings:()=>service.listBookings(admin,{scope:'all'})};
}
const count=async(db,table)=>(await db.query(`SELECT count(*)::int n FROM eduson_booking.${table}`)).rows[0].n;

test('durable accept survives restart and creates one honest pending booking with no invented CRM or schedule',async t=>{
  const {db,intake,config,bookings}=await fixture(t);
  const accepted=await intake.accept(observation());assert.equal(accepted.status,'pending');assert.equal((await bookings()).length,0);
  const restarted=createSourceIntake(config);assert.equal((await restarted.runOnce()).applied,1);
  const [row]=await bookings();assert.equal(row.crmUrl,'');assert.equal(row.confirmationStatus,'pending');assert.equal(row.assignedTo,null);assert.equal(row.isTest,false);
  assert.equal(await count(db,'schedules'),1);assert.equal(await count(db,'sync_jobs'),1);assert.equal(await count(db,'compensation_events'),0);
  const retry=await restarted.observe({...observation(),observedAt:'2026-11-04T08:00:00Z'});assert.equal(retry.duplicate,true);assert.equal((await bookings()).length,1);assert.equal(await count(db,'sync_jobs'),1);
  assert.deepEqual((await db.query('SELECT raw FROM eduson_booking.source_intake_observations')).rows[0].raw,{synthetic:true});
});

test('queued accept detaches the exact hashed record and raw snapshot before its first await',async t=>{
  const {db,intake,bookings}=await fixture(t);
  let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const occupying=db.transaction(async()=>{entered();await blocked;});await ready;
  const input=observation('1',{record:record({comment:'original verified comment'}),raw:{nested:{marker:'original'},items:['original']}}),original=structuredClone(input);
  const pending=intake.accept(input);
  input.record.comment='mutated while waiting';input.record.age=13;input.raw.nested.marker='mutated while waiting';input.raw.items.push('mutated');
  release();await occupying;await pending;await intake.runOnce();
  const journal=(await db.query('SELECT input_hash,payload,raw FROM eduson_booking.source_intake_observations')).rows[0];
  assert.deepEqual(journal.payload.record,original.record);assert.deepEqual(journal.raw,original.raw);assert.deepEqual(journal.payload.raw,original.raw);
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  const fingerprint=createHash('sha256').update(JSON.stringify(ordered({event:journal.payload.event,record:journal.payload.record,raw:journal.raw}))).digest('hex');
  assert.equal(journal.input_hash,fingerprint);assert.equal((await bookings())[0].comment,original.record.comment);assert.equal((await bookings())[0].age,10);
  assert.equal((await intake.observe(original)).duplicate,true);assert.equal((await bookings()).length,1);
});

test('source parent names stay honestly optional while ordinary booking validation remains unchanged',async t=>{
  const {intake,service,bookings}=await fixture(t);
  for(const [index,parentName] of ['',undefined,'   '].entries()){
    const applied=await intake.observe(observation('1',{recordId:`blank-parent-${index}`,record:record({parentName,phone:`+7999000000${index}`})}));
    assert.equal(applied.status,'applied');
  }
  assert.ok((await bookings()).every(row=>row.parentName===''));
  await assert.rejects(service.createBooking(caller,{...record({parentName:'',phone:'+79990000009'}),crmUrl:'https://test.amocrm.ru/leads/detail/1',idempotencyKey:'ordinary-blank-parent'}),{status:400,code:'VALIDATION'});
});

test('omitted source comments preserve imported facts while an explicit verified empty comment clears them',async t=>{
  const {intake,bookings}=await fixture(t);await intake.observe(observation('1',{record:record({comment:'original imported comment'})}));
  const omitted=record();delete omitted.comment;await intake.observe(observation('2',{record:omitted}));assert.equal((await bookings())[0].comment,'original imported comment');
  await intake.observe(observation('3',{record:record({comment:''})}));assert.equal((await bookings())[0].comment,'');
});

test('historical source facts and updates remain SQL-only until admin resolution without deleting older jobs',async t=>{
  const {intake,db,service}=await fixture(t);const archived=record({date:'2026-10-10',comment:'source archive'});
  const created=await intake.observe(observation('1',{record:archived}));assert.equal(created.status,'applied');
  assert.equal(await count(db,'sync_jobs'),0);
  assert.equal((await db.query('SELECT history_only FROM eduson_booking.bookings WHERE id=$1',[created.bookingId])).rows[0].history_only,true);
  assert.ok((await service.getSheetSnapshot(admin)).slotRows.every(row=>!row.bookingId));
  await db.query("INSERT INTO eduson_booking.sync_jobs(id,booking_id,kind,version,status)VALUES('older-unrelated-job',$1,'booking',99,'pending')",[created.bookingId]);
  await intake.observe(observation('2',{record:{...archived,comment:'updated archive'}}));
  assert.deepEqual((await db.query('SELECT id FROM eduson_booking.sync_jobs')).rows,[{id:'older-unrelated-job'}]);
  const row=(await service.listBookings(admin,{scope:'completed'}))[0];
  await service.resolveLegacy(admin,row.id,{version:row.version,outcome:'completed',managerId:sales.id,reason:'Подтверждено точным историческим отчётом'});
  assert.equal(await count(db,'sync_jobs'),2);
});

test('a future source booking corrected into the past records unknown-outcome evidence and permits admin proof',async t=>{
  const {intake,db,service,bookings}=await fixture(t);const created=await intake.observe(observation());
  const moved=await intake.observe(observation('2',{record:record({date:'2026-10-10'})}));assert.equal(moved.status,'applied');assert.equal(moved.bookingId,created.bookingId);
  let row=(await bookings())[0];assert.equal(row.historyOnly,true);assert.equal(row.legacy?.elapsedUnknown,true);
  assert.ok((await service.getSheetSnapshot(admin)).slotRows.every(slot=>!slot.bookingId));assert.equal(await count(db,'sync_jobs'),1);
  const evidence=(await db.query("SELECT payload FROM eduson_booking.audit_events WHERE booking_id=$1 AND action='legacy_imported'",[row.id])).rows[0].payload;
  assert.equal(evidence.sourceObservation.observationId,moved.observationId);assert.equal(evidence.sourceObservation.revision,'2');assert.match(evidence.sourceObservation.inputHash,/^[a-f0-9]{64}$/);
  row=await service.resolveLegacy(admin,row.id,{version:row.version,outcome:'completed',managerId:sales.id,reason:'Проверенный отчёт подтверждает факт проведения'});
  assert.equal(row.state,'completed');assert.equal(row.historyOnly,true);assert.equal(row.legacy.elapsedUnknown,false);assert.equal(await count(db,'sync_jobs'),2);
});

test('revision journal prevents stale and same-revision mutation and permits higher-revision A-B-A',async t=>{
  const {intake,bookings,db}=await fixture(t);
  await intake.observe(observation('10'));await intake.observe(observation('11',{record:record({comment:'B',time:'13:00'})}));
  assert.equal((await bookings())[0].comment,'B');
  assert.equal((await intake.observe(observation('9',{record:record({comment:'stale'})}))).status,'stale');
  const conflict=await intake.observe(observation('11',{record:record({comment:'same revision changed'})}));assert.equal(conflict.code,'REVISION_HASH_CONFLICT');
  assert.equal((await bookings())[0].comment,'B');await intake.observe(observation('12'));
  const [row]=await bookings();assert.equal(row.comment,'A');assert.equal(row.time,'12:00');assert.equal(row.version,3);
  assert.equal(await count(db,'bookings'),1);assert.equal((await intake.listIssues()).some(i=>i.code==='REVISION_HASH_CONFLICT'),false);
  assert.equal((await intake.listIssues({includeResolved:true})).find(i=>i.code==='REVISION_HASH_CONFLICT').resolution,'superseded');
});

test('superseded queued observations never apply and account IDs isolate provider record IDs',async t=>{
  const {intake,db,bookings}=await fixture(t);
  await intake.accept(observation('1'));await intake.accept(observation('2',{record:record({comment:'latest'})}));
  await intake.runOnce();assert.equal((await bookings())[0].comment,'latest');assert.equal((await bookings())[0].version,1);
  await intake.observe(observation('1',{accountId:'other-account',record:record({phone:'+79990000001'})}));
  assert.equal(await count(db,'bookings'),2);assert.equal(await count(db,'source_intake_records'),2);
});

test('unknown fields and staff mappings retain raw as visible issues without partial booking facts',async t=>{
  const {intake,db}=await fixture(t);
  for(const [id,patch,code] of [['missing-age',{age:null},'INCOMPLETE_RECORD'],['missing-pc',{hasPc:null},'INCOMPLETE_RECORD'],['unknown-staff',{staffId:'unknown'},'UNKNOWN_STAFF_MAPPING'],['unsupported-duration',{durationMinutes:30},'UNSUPPORTED_DURATION']]){
    const result=await intake.observe(observation('1',{recordId:id,record:record(patch),raw:{marker:id}}));assert.equal(result.status,'issue');assert.equal(result.code,code);
  }
  assert.equal(await count(db,'bookings'),0);assert.equal(await count(db,'source_intake_observations'),4);assert.equal((await intake.listIssues()).length,4);
  const mapped=await intake.observe(observation('1',{recordId:'mapped',record:record({staffId:'provider-staff-1'})}));assert.equal(mapped.status,'applied');
  assert.equal((await db.query('SELECT assigned_to FROM eduson_booking.bookings')).rows[0].assigned_to,null);
});

test('real capacity overflow is retained as hold, respects ordinary priority, and moves without creating hours',async t=>{
  const {intake,db,service,bookings}=await fixture(t,{reserveCapacity:0});
  await service.createBooking(caller,{...record({phone:'+79990000009'}),crmUrl:'https://test.amocrm.ru/leads/detail/1',idempotencyKey:'ordinary'});
  await intake.observe(observation());let imported=(await bookings()).find(b=>b.createdBy==='source:rubitime');assert.equal(imported.capacityHold,true);
  await intake.observe(observation('2',{record:record({time:'13:00'})}));imported=(await bookings()).find(b=>b.id===imported.id);assert.equal(imported.capacityHold,false);
  await intake.observe(observation('3',{record:record({date:'2026-11-11'})}));imported=(await bookings()).find(b=>b.id===imported.id);assert.equal(imported.capacityHold,true);
  assert.equal(await count(db,'schedules'),1);assert.equal(await count(db,'compensation_events'),0);
  assert.equal((await service.stats(admin,{date:'2026-11-11'})).totals.capacityHeld,1);
});

test('manual edits, confirmation, reports, payments, and Amo authority prevent source overwrites',async t=>{
  const {intake,db,service,bookings}=await fixture(t);
  await intake.observe(observation());let row=(await bookings())[0];await service.updateBookingDetails(admin,row.id,{version:row.version,comment:'Manual'});
  let blocked=await intake.observe(observation('2',{record:record({comment:'source'})}));assert.equal(blocked.code,'BOOKING_MODIFIED');assert.equal((await bookings())[0].comment,'Manual');
  for(const [id,sql,code] of [
    ['confirmed',"UPDATE eduson_booking.bookings SET confirmation_status='confirmed' WHERE id=$1",'BOOKING_PROTECTED'],
    ['report',"INSERT INTO eduson_booking.reports(booking_id,payload)VALUES($1,'{}')",'BOOKING_PROTECTED'],
    ['payment',`INSERT INTO eduson_booking.payments(id,booking_id,manager_id,created_by,idempotency_key,input_fingerprint,payload)VALUES('payment',$1,'${sales.id}','${admin.id}','payment','fingerprint','{}')`,'BOOKING_PROTECTED']
  ]){
    await intake.observe(observation('1',{recordId:id,record:record({phone:'+79990000'+String(100+id.length)})}));row=(await db.query('SELECT booking_id FROM eduson_booking.source_intake_records WHERE record_id=$1',[id])).rows[0];
    await db.query(sql,[row.booking_id]);blocked=await intake.observe(observation('2',{recordId:id,record:record({comment:'overwrite'})}));assert.equal(blocked.code,code);
  }
  const input={snapshot:{capturedAt:clock,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время']]},managers:{values:[['Имя','Активен']]}}},records:[{sourceIdentity:{source:'amocrm',id:'amo-authoritative'},...record({phone:'+79990000099',crmUrl:'https://test.amocrm.ru/leads/detail/200'}),raw:{synthetic:true}}]};
  const preview=await migrateV3(db,input,{now:()=>new Date(clock),holdExcessPending:true});await migrateV3(db,input,{apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint,now:()=>new Date(clock),holdExcessPending:true});
  const before=(await db.query("SELECT b.* FROM eduson_booking.bookings b JOIN eduson_booking.migration_v3_sources s ON s.booking_id=b.id WHERE s.source='amocrm'")).rows[0];
  blocked=await intake.observe(observation('1',{recordId:'amo-collision',record:record({crmUrl:'https://test.amocrm.ru/leads/detail/200'})}));assert.equal(blocked.code,'SOURCE_IDENTITY_CONFLICT');
  assert.deepEqual((await db.query('SELECT * FROM eduson_booking.bookings WHERE id=$1',[before.id])).rows[0],before);
  const mixed=await intake.observe(observation('1',{recordId:'mixed-source',record:record({phone:'+79990000888'})}));
  await db.query("INSERT INTO eduson_booking.migration_v3_sources(source,source_id,booking_id,fingerprint,raw,imported_at)VALUES('amocrm','mixed-amo',$1,'synthetic','{}',$2)",[mixed.bookingId,clock]);
  blocked=await intake.observe(observation('2',{recordId:'mixed-source',event:'delete',record:undefined}));assert.equal(blocked.code,'AMO_AUTHORITY');
  assert.equal((await bookings()).find(row=>row.id===mixed.bookingId).state,'scheduled');
});

test('source cancellation is truthful and limited to unchanged Rubitime-only pending bookings',async t=>{
  const {intake,db,bookings}=await fixture(t);await intake.observe(observation());
  const cancelled=await intake.observe(observation('2',{event:'cancel',record:undefined,raw:{reason:'Родитель отменил'}}));assert.equal(cancelled.status,'applied');
  const [row]=await bookings();assert.equal(row.state,'cancelled');assert.equal(row.cancelReason,'Отменён в Rubitime');assert.equal(row.cancelSource,'rubitime');
  const audit=(await db.query("SELECT payload FROM eduson_booking.audit_events WHERE action='cancelled'")).rows[0].payload;
  assert.equal(audit.sourceObservation.event,'cancel');assert.deepEqual(audit.sourceObservation.raw,{reason:'Родитель отменил'});
  assert.equal(await count(db,'compensation_events'),0);
  const held=await intake.observe(observation('3',{event:'delete',record:undefined}));assert.equal(held.code,'BOOKING_PROTECTED');
});

test('failure after receipt commit is retryable after restart without losing raw or duplicating booking',async t=>{
  const {intake,db,config,bookings,setNow}=await fixture(t);
  await intake.accept(observation());
  await db.query(`CREATE FUNCTION eduson_booking.intake_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private provider error'; END $$`);
  await db.query('CREATE TRIGGER intake_test_fail BEFORE INSERT ON eduson_booking.bookings FOR EACH ROW EXECUTE FUNCTION eduson_booking.intake_test_fail()');
  const failed=await intake.runOnce();assert.equal(failed.errors,1);assert.equal((await bookings()).length,0);assert.equal(await count(db,'source_intake_observations'),1);
  assert.doesNotMatch(JSON.stringify(await intake.status()),/private provider error/);
  await db.query('DROP TRIGGER intake_test_fail ON eduson_booking.bookings');setNow('2026-11-04T07:01:00Z');
  assert.equal((await createSourceIntake(config).runOnce()).applied,1);assert.equal((await bookings()).length,1);
});

test('migration seeds exact provider IDs, including a preexisting receipt, and protects later manual facts',async t=>{
  const {db,intake,service,bookings}=await fixture(t);
  const csv=[1,2].map(n=>({rubitimeId:n,employeeName:'Исторический методист',parentName:'Родитель',phone:`+7999000000${n}`,childName:`Архив ${n}`,childAge:10,hasComputerRaw:'Да',parentAttendingRaw:'Да',startLocal:`2026-10-0${n}T12:00:00`,createdLocal:'2026-10-01T08:00:00',durationMinutes:60,rawStatusTitle:'Записан',timezone:'Europe/Moscow',orderId:'not-an-amo-id',comment:'original'}));
  const input={snapshot:{capturedAt:clock,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время']]},managers:{values:[['Имя','Активен']]}}},rubitime:{csv,api:csv.map(row=>({id:row.rubitimeId,record:row.startLocal.replace('T',' '),created_at:'2026-10-01 08:00:00',duration:'60',status:0,status_title:'Записан',cooperator_title:row.employeeName}))}};
  const preview=await migrateV3(db,input,{now:()=>new Date(clock)});assert.equal(preview.ok,true);await migrateV3(db,input,{apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint,now:()=>new Date(clock)});
  const links=(await db.query("SELECT * FROM eduson_booking.migration_v3_sources ORDER BY source_id")).rows;
  const changed=(await bookings()).find(row=>row.id===links[1].booking_id);await service.updateBookingDetails(admin,changed.id,{version:changed.version,comment:'Manual source correction'});
  const prior=await intake.observe(observation('1',{recordId:'1',record:record({phone:'+79990000008'})}));assert.equal(prior.code,'MIGRATION_LINK_REQUIRED');
  assert.deepEqual(await intake.seedMigrationLinks({accountId:'synthetic-account'}),{seeded:2,protected:1});
  assert.deepEqual(await intake.seedMigrationLinks({accountId:'synthetic-account'}),{seeded:0,protected:0});
  await assert.rejects(intake.seedMigrationLinks({accountId:'other-account'}),{code:'MIGRATION_LINK_CONFLICT'});
  const moved=await intake.observe(observation('2',{recordId:'1',record:record({phone:'+79990000001'})}));assert.equal(moved.status,'applied');assert.equal(moved.bookingId,links[0].booking_id);
  const protectedResult=await intake.observe(observation('1',{recordId:'2',record:record({phone:'+79990000002'})}));assert.equal(protectedResult.code,'BOOKING_MODIFIED');
  assert.equal(await count(db,'bookings'),2);assert.equal((await bookings()).find(row=>row.id===links[1].booking_id).comment,'Manual source correction');
});

test('cancellation never overwrites confirmed, assigned, running, completed, reported, or paid bookings',async t=>{
  const {db,intake,bookings}=await fixture(t);
  const mutations=["confirmation_status='confirmed'",`assigned_to='${sales.id}',assignment_kind='primary'`,"state='in_progress'","state='completed'"];
  for(const [index,sql] of mutations.entries()){
    const recordId=`protected-${index}`;const applied=await intake.observe(observation('1',{recordId,record:record({phone:`+799900000${10+index}`})}));assert.equal(applied.status,'applied');
    await db.query(`UPDATE eduson_booking.bookings SET ${sql} WHERE id=$1`,[applied.bookingId]);
    const response=await intake.observe(observation('2',{recordId,event:'delete',record:undefined}));assert.equal(response.code,'BOOKING_PROTECTED');
    assert.notEqual((await bookings()).find(row=>row.id===applied.bookingId).state,'cancelled');
  }
  for(const [index,kind] of ['report','payment'].entries()){
    const recordId=`cancel-${kind}`,applied=await intake.observe(observation('1',{recordId,record:record({phone:`+799900000${30+index}`})}));
    if(kind==='report')await db.query("INSERT INTO eduson_booking.reports(booking_id,payload)VALUES($1,'{}')",[applied.bookingId]);
    else await db.query("INSERT INTO eduson_booking.payments(id,booking_id,manager_id,created_by,idempotency_key,input_fingerprint,payload)VALUES('cancel-payment',$1,$2,$3,'cancel-payment','synthetic','{}')",[applied.bookingId,sales.id,admin.id]);
    assert.equal((await intake.observe(observation('2',{recordId,event:'cancel',record:undefined}))).code,'BOOKING_PROTECTED');
  }
});

test('large revisions are exact, invalid envelopes reject, and invalid calendar facts remain visible',async t=>{
  const {intake,bookings,db}=await fixture(t);
  for(const value of [1,'01','-1','1.2','2026-11-04'])await assert.rejects(intake.accept(observation(value)),{code:'INVALID_REVISION'});
  await intake.observe(observation('9007199254740993'));await intake.observe(observation('9007199254740994',{record:record({comment:'larger'})}));
  assert.equal((await bookings())[0].comment,'larger');
  const invalid=await intake.observe(observation('1',{recordId:'invalid-date',record:record({date:'2026-02-31'})}));assert.equal(invalid.code,'INVALID_DATE');
  const concurrent=await Promise.all(['9007199254740995','9007199254740996'].map((value,index)=>intake.observe(observation(value,{record:record({comment:`revision ${index}`})}))));
  assert.equal((await bookings())[0].comment,'revision 1');assert.equal(await count(db,'bookings'),1);assert.ok(concurrent.every(item=>['stale','applied'].includes(item.status)));
});

test('mapping issues can reprocess the same immutable observation after an explicit mapping correction',async t=>{
  const {intake,config,db}=await fixture(t);
  const failed=await intake.observe(observation('1',{record:record({staffId:'corrected-staff'})}));assert.equal(failed.code,'UNKNOWN_STAFF_MAPPING');
  config.staffMap['synthetic-account']['corrected-staff']=sales.id;
  const queued=await intake.retryIssue({observationId:failed.observationId});assert.equal(queued.status,'pending');
  await intake.runOnce();assert.equal(await count(db,'bookings'),1);assert.equal((await intake.listIssues()).length,0);
  assert.equal((await intake.listIssues({includeResolved:true}))[0].resolution,'reprocessed');
});

test('a revision conflict before processing freezes both queued variants until a higher trusted revision',async t=>{
  const {intake,bookings,db}=await fixture(t);
  await intake.accept(observation('1'));const conflict=await intake.accept(observation('1',{record:record({comment:'conflicting variant'})}));
  assert.equal(conflict.code,'REVISION_HASH_CONFLICT');await intake.runOnce();assert.equal((await bookings()).length,0);
  const statuses=(await db.query('SELECT status,code FROM eduson_booking.source_intake_observations')).rows;
  assert.ok(statuses.every(row=>row.status==='issue'&&row.code==='REVISION_HASH_CONFLICT'));assert.equal((await intake.listIssues()).length,2);
  const next=await intake.observe(observation('2',{record:record({comment:'trusted higher revision'})}));assert.equal(next.status,'applied');assert.equal((await bookings())[0].comment,'trusted higher revision');
  await intake.observe(observation('1',{record:record({comment:'another old contradictory variant'})}));
  const current=await intake.observe(observation('3',{record:record({comment:'still current'})}));assert.equal(current.status,'applied');
});

test('safe system capacity promotion preserves source ownership while later manual updates still block',async t=>{
  const {db,intake,service,bookings}=await fixture(t,{reserveCapacity:0});
  await service.createBooking(caller,{...record({phone:'+79990000009'}),crmUrl:'https://test.amocrm.ru/leads/detail/1',idempotencyKey:'priority'});
  const created=await intake.observe(observation());assert.equal((await bookings()).find(row=>row.id===created.bookingId).capacityHold,true);
  await service.saveSchedule(sales,{date,intervals:[{start:'12:00',end:'14:00'}],reserveCapacity:1});
  assert.equal((await service.reconcileCapacityHolds()).promoted,1);
  const updated=await intake.observe(observation('2',{record:record({comment:'honest source update'})}));assert.equal(updated.status,'applied');
  const row=(await bookings()).find(row=>row.id===created.bookingId);assert.equal(row.comment,'honest source update');assert.equal(row.capacityHold,false);
  await service.updateBookingDetails(admin,row.id,{version:row.version,comment:'manual'});
  const blocked=await intake.observe(observation('3',{record:record({comment:'source must not overwrite'})}));assert.equal(blocked.code,'BOOKING_MODIFIED');
  assert.equal((await db.query('SELECT comment FROM eduson_booking.bookings WHERE id=$1',[row.id])).rows[0].comment,'manual');
});

test('a committed higher receipt supersedes only older issues for the same account and record without rewriting history',async t=>{
  const {db,intake,setNow}=await fixture(t);
  const old=await intake.observe(observation('1',{record:record({staffId:'unknown-staff'}),raw:{marker:'original raw'}}));
  await intake.observe(observation('1',{recordId:'other-record',record:record({staffId:'unknown-staff'})}));
  await intake.observe(observation('1',{accountId:'other-account',record:record({staffId:'unknown-staff'})}));
  const before=(await db.query('SELECT id,payload,raw,status,code,processed_at FROM eduson_booking.source_intake_observations WHERE id=$1',[old.observationId])).rows[0];
  const audits=await count(db,'audit_events');setNow('2026-11-04T07:01:00Z');
  const accepted=await intake.accept(observation('2',{record:record({comment:'new trusted receipt'})}));assert.equal(accepted.status,'pending');
  assert.equal((await intake.status()).issues,2);assert.deepEqual((await intake.listIssues()).map(row=>[row.account_id,row.record_id]).sort(),[['other-account','record-1'],['synthetic-account','other-record']].sort());
  const issue=(await intake.listIssues({includeResolved:true})).find(row=>row.observation_id===old.observationId);assert.equal(issue.resolution,'superseded');assert.equal(new Date(issue.resolved_at).toISOString(),'2026-11-04T07:01:00.000Z');
  assert.deepEqual((await db.query('SELECT id,payload,raw,status,code,processed_at FROM eduson_booking.source_intake_observations WHERE id=$1',[old.observationId])).rows[0],before);assert.equal(await count(db,'audit_events'),audits);
  await assert.rejects(intake.retryIssue({observationId:old.observationId}),{code:'OBSERVATION_SUPERSEDED'});
  assert.equal((await intake.runOnce({observationId:accepted.observationId})).applied,1);assert.equal((await intake.listIssues({includeResolved:true})).find(row=>row.observation_id===old.observationId).resolution,'superseded');
});

test('a bad higher head has one current issue while same-head hash conflicts remain actionable',async t=>{
  const {intake,db}=await fixture(t);
  await intake.observe(observation('1',{record:record({age:null})}));await intake.accept(observation('1',{record:record({age:null,comment:'contradictory old variant'})}));assert.equal((await intake.listIssues()).length,2);
  const latest=await intake.observe(observation('2',{record:record({phone:'invalid'})}));assert.equal(latest.code,'INVALID_PHONE');
  assert.deepEqual((await intake.listIssues()).map(row=>row.observation_id),[latest.observationId]);const history=await intake.listIssues({includeResolved:true});assert.equal(history.length,3);assert.equal(history.filter(row=>row.resolution==='superseded').length,2);
  await intake.accept(observation('2',{record:record({phone:'invalid',comment:'same head contradictory variant'})}));
  assert.equal((await intake.listIssues()).length,2);const revisions=(await db.query('SELECT revision FROM eduson_booking.source_intake_observations WHERE id=ANY($1::text[])',[(await intake.listIssues()).map(row=>row.observation_id)])).rows;assert.ok(revisions.every(row=>String(row.revision)==='2'));
  assert.equal((await db.query("SELECT revision_conflicted FROM eduson_booking.source_intake_records WHERE account_id='synthetic-account' AND record_id='record-1'")).rows[0].revision_conflicted,true);
});

test('late lower-revision conflicts are stored as superseded and duplicate receipts never reopen old issues',async t=>{
  const {intake,db}=await fixture(t);const first=await intake.accept(observation('1'));await intake.accept(observation('2',{record:record({comment:'trusted current'})}));
  const oldConflict=await intake.accept(observation('1',{record:record({comment:'late lower contradictory variant'})}));assert.equal(oldConflict.code,'REVISION_HASH_CONFLICT');
  assert.equal((await intake.listIssues()).length,0);const history=await intake.listIssues({includeResolved:true});assert.equal(history.length,2);assert.ok(history.every(row=>row.resolution==='superseded'&&row.resolved_at));
  assert.equal((await intake.accept(observation('1'))).duplicate,true);assert.equal((await intake.listIssues()).length,0);
  const head=(await db.query("SELECT latest_revision,revision_conflicted FROM eduson_booking.source_intake_records WHERE account_id='synthetic-account' AND record_id='record-1'")).rows[0];assert.equal(String(head.latest_revision),'2');assert.equal(head.revision_conflicted,false);
  assert.equal((await intake.runOnce()).applied,1);assert.equal(await count(db,'source_intake_observations'),3);assert.deepEqual((await db.query('SELECT raw FROM eduson_booking.source_intake_observations WHERE id=$1',[first.observationId])).rows[0].raw,{synthetic:true});
});

test('superseding issues and accepting a higher raw receipt commit atomically',async t=>{
  const {db,intake}=await fixture(t);await intake.observe(observation('1',{record:record({age:null})}));
  await db.query("CREATE FUNCTION eduson_booking.fail_issue_supersession() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected supersession failure'; END $$");
  await db.query('CREATE TRIGGER fail_issue_supersession BEFORE UPDATE ON eduson_booking.source_intake_issues FOR EACH ROW EXECUTE FUNCTION eduson_booking.fail_issue_supersession()');
  await assert.rejects(intake.accept(observation('2')),/injected supersession failure/);
  assert.equal(await count(db,'source_intake_observations'),1);assert.equal((await intake.listIssues()).length,1);assert.equal(String((await db.query('SELECT latest_revision FROM eduson_booking.source_intake_records')).rows[0].latest_revision),'1');
  await db.query('DROP TRIGGER fail_issue_supersession ON eduson_booking.source_intake_issues');await intake.accept(observation('2'));assert.equal((await intake.listIssues()).length,0);assert.equal(await count(db,'source_intake_observations'),2);
});

test('a known inactive source salesperson proves identity without assignment while confirmation uses active capacity',async t=>{
  const {db,intake,config,service,bookings}=await fixture(t),inactiveId='archival-source-sales';
  await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active)VALUES($1,$2,'Архивный методист','sales','unused',false)",[inactiveId,inactiveId+'@test.local']);
  config.staffMap['synthetic-account']['archival-provider']=inactiveId;config.staffMap['synthetic-account']['admin-provider']=admin.id;
  const schedules=await count(db,'schedules');
  const accepted=await intake.observe(observation('1',{record:record({staffId:'archival-provider'})}));assert.equal(accepted.status,'applied');
  const [pending]=await bookings();assert.equal(pending.state,'scheduled');assert.equal(pending.confirmationStatus,'pending');assert.equal(pending.assignedTo,null);assert.equal(pending.assignmentKind,null);assert.equal(pending.capacityHold,false);
  assert.equal((await db.query('SELECT active FROM eduson_booking.users WHERE id=$1',[inactiveId])).rows[0].active,false);assert.equal(await count(db,'schedules'),schedules);
  const confirmed=await service.confirmBooking(confirmation,pending.id,{version:pending.version});assert.equal(confirmed.assignedTo,sales.id);assert.notEqual(confirmed.assignedTo,inactiveId);
  for(const [recordId,staffId,phone] of [['unknown-id','unknown-provider','+79990000002'],['wrong-role','admin-provider','+79990000003']]){
    const blocked=await intake.observe(observation('1',{recordId,record:record({staffId,phone,time:'13:00'})}));assert.equal(blocked.code,'UNKNOWN_STAFF_MAPPING');
  }
  assert.equal((await bookings()).length,1);assert.equal(await count(db,'schedules'),schedules);assert.equal((await db.query('SELECT active FROM eduson_booking.users WHERE id=$1',[inactiveId])).rows[0].active,false);
});
