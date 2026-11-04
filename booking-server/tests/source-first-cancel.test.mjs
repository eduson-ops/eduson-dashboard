import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {createSourceIntake} from '../source-intake.mjs';
import {migrateV3} from '../migration-v3.mjs';

const admin={id:'first-cancel-admin',role:'admin'},caller={id:'first-cancel-cc',role:'call_center'},confirmation={id:'first-cancel-confirmation',role:'confirmation'},sales={id:'first-cancel-sales',role:'sales'};
const account='first-cancel-account',clock='2030-01-01T06:00:00.000Z',observedAt='2030-01-01T05:55:00.000Z',date='2030-01-02';
const record=extra=>({date,time:'12:00',durationMinutes:60,studentName:'Отменённый ученик',parentName:'',phone:'+79990000001',crmUrl:'',age:10,hasPc:true,parentPresent:true,comment:'Проверенная заметка',...extra});
const cancellation=extra=>({accountId:account,recordId:'501',revision:'1',event:'cancel',observedAt,record:record(),raw:{api:{id:501,status:4},synthetic:true},...extra});
async function fixture(t,{schedule=false}={}){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmation,sales])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$1,$3,\'unused\')',[actor.id,actor.id+'@test.invalid',actor.role]);
  let now=new Date(clock);const service=new BookingService(db,{now:()=>now,random:()=>0}),config={db,service,now:()=>now};
  if(schedule)await service.saveSchedule(sales,{date,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:1});
  return{db,service,intake:createSourceIntake(config),config,setNow:value=>{now=new Date(value);},bookings:()=>service.listBookings(admin,{scope:'all'})};
}
const count=async(db,table)=>(await db.query('SELECT count(*)::int n FROM eduson_booking.'+table)).rows[0].n;
const importRecord=async(db,source,sourceId,values)=>{
  const input={snapshot:{capturedAt:clock,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время']]},managers:{values:[['Имя','Активен']]}}},records:[{sourceIdentity:{source,id:sourceId},...values,raw:{synthetic:true}}]};
  const options={now:()=>new Date(clock)},preview=await migrateV3(db,input,options);assert.equal(preview.ok,true,JSON.stringify(preview.issues));
  await migrateV3(db,input,{...options,apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint});
};

test('a complete first-seen status4 cancellation creates one truthful cancelled fact without availability or assignment',async t=>{
  const {db,service,intake,bookings}=await fixture(t);
  const result=await intake.observe(cancellation({record:record({staffId:'unmapped-cancelled-salesperson'})}));assert.equal(result.status,'applied');
  const [row]=await bookings();const expectedId='intake-'+createHash('sha256').update(JSON.stringify([account,'501'])).digest('hex').slice(0,40);
  assert.equal(row.id,expectedId);assert.equal(row.version,1);assert.equal(row.state,'cancelled');assert.equal(row.confirmationStatus,'pending');assert.equal(row.cancelSource,'rubitime');assert.equal(row.cancelReason,'Отменён в Rubitime');
  assert.equal(row.assignedTo,null);assert.equal(row.assignmentKind,null);assert.equal(row.capacityHold,false);assert.equal(row.isTest,false);assert.equal(row.historyOnly,false);
  assert.equal(row.cancelledAt,clock);assert.equal(row.cancellation.sourceObservedAt,observedAt);assert.equal(row.cancellation.timestamp,clock);assert.equal(row.cancellation.raw,undefined);
  assert.equal((await service.getAnalyticsCancellations(admin)).length,1);assert.equal((await service.listBookings(admin,{scope:'active'})).length,0);assert.equal((await service.listBookings(admin,{scope:'trash'})).length,1);
  assert.equal(await count(db,'schedules'),0);assert.equal((await service.getSheetSnapshot(admin)).slotRows.length,0);assert.equal(await count(db,'compensation_events'),0);assert.equal(await count(db,'payments'),0);assert.equal(await count(db,'reports'),0);
  assert.deepEqual((await db.query('SELECT kind,version FROM eduson_booking.sync_jobs ORDER BY kind')).rows,[{kind:'booking',version:1},{kind:'cancel',version:1}]);
  assert.equal((await db.query('SELECT raw FROM eduson_booking.source_intake_observations')).rows[0].raw.api.status,4);
});

test('duplicate cancellation receipts and restarted consumers preserve one stable booking and one cancellation audit',async t=>{
  const {db,intake,config}=await fixture(t);const accepted=await intake.accept(cancellation());assert.equal(accepted.status,'pending');
  const restarted=createSourceIntake(config);assert.equal((await restarted.runOnce()).applied,1);
  const bookingId=(await db.query('SELECT id FROM eduson_booking.bookings')).rows[0].id;
  const retry=await restarted.observe(cancellation());assert.equal(retry.duplicate,true);assert.equal(retry.bookingId,bookingId);
  await createSourceIntake(config).runOnce();await createSourceIntake(config).observe(cancellation());
  assert.equal(await count(db,'bookings'),1);assert.equal(await count(db,'source_intake_observations'),1);assert.equal(await count(db,'sync_jobs'),2);
  assert.equal((await db.query("SELECT count(*)::int n FROM eduson_booking.audit_events WHERE action='cancelled'")).rows[0].n,1);
});

test('all four roles see unchanged physical capacity after a cancelled source record is recovered',async t=>{
  const {db,service,intake}=await fixture(t,{schedule:true});const before=(await service.listSlots(caller,{date,age:10})).find(row=>row.time==='12:00');
  await intake.observe(cancellation({raw:{api:{id:'501',status:'4'}}}));
  for(const actor of [admin,caller,confirmation,sales])assert.deepEqual((await service.listSlots(actor,{date,age:10})).find(row=>row.time==='12:00'),before);
  const snapshot=await service.getSheetSnapshot(admin);assert.equal(snapshot.scheduleRows.length,1);assert.equal(snapshot.slotRows.length,2);assert.ok(snapshot.slotRows.every(row=>row.status==='wait'&&!row.bookingId));
  const hour=(await service.stats(admin,{date})).hours.find(row=>row.time==='12:00');assert.deepEqual([hour.total,hour.confirmed,hour.allocations.length,hour.capacity],[0,0,0,2]);assert.equal(await count(db,'compensation_events'),0);
});

test('historical proven cancellations remain SQL-only and still reach the cancellation analytics',async t=>{
  const {db,intake,service,bookings}=await fixture(t);await intake.observe(cancellation({record:record({date:'2029-12-20'})}));
  const [row]=await bookings();assert.equal(row.state,'cancelled');assert.equal(row.historyOnly,true);assert.equal((await service.listBookings(admin,{scope:'completed'})).length,1);
  assert.equal((await service.getAnalyticsCancellations(admin)).length,1);assert.equal(await count(db,'sync_jobs'),0);assert.equal((await service.getSheetSnapshot(admin)).slotRows.length,0);
});

test('missing facts, deletion, missing API snapshots, wrong IDs and unsupported statuses retain issues without inventing bookings',async t=>{
  const {db,intake}=await fixture(t);
  const variants=[
    {record:undefined,code:'SOURCE_BOOKING_MISSING'},
    {record:record({age:null}),code:'SOURCE_BOOKING_MISSING'},
    {event:'delete',code:'SOURCE_BOOKING_MISSING'},
    {raw:{api:{id:501,httpStatus:404}},code:'CANCELLATION_EVIDENCE_REQUIRED'},
    {raw:{api:{id:999,status:4}},code:'CANCELLATION_EVIDENCE_REQUIRED'},
    {raw:{api:{id:501,status:0}},code:'CANCELLATION_EVIDENCE_REQUIRED'},
    {raw:{api:{id:501,status:' 4 '}},code:'CANCELLATION_EVIDENCE_REQUIRED'},
    {raw:{api:[]},code:'CANCELLATION_EVIDENCE_REQUIRED'}
  ];
  for(const [index,variant] of variants.entries()){
    const {code,...patch}=variant,payload=cancellation({...patch,revision:String(index+1)}),result=await intake.observe(payload);
    assert.equal(result.status,'issue');assert.equal(result.code,code);assert.equal(await count(db,'bookings'),0);
  }
  assert.equal(await count(db,'source_intake_observations'),variants.length);assert.equal(await count(db,'sync_jobs'),0);assert.equal(await count(db,'compensation_events'),0);
});

test('manual contact matches and Amo CRM identity matches hold first-seen cancellation without touching existing facts',async t=>{
  const {db,service,intake}=await fixture(t,{schedule:true});
  const manual=await service.createBooking(caller,{...record(),parentName:'Родитель',crmUrl:'https://test.amocrm.ru/leads/detail/10',idempotencyKey:'manual'});
  const before=(await db.query('SELECT * FROM eduson_booking.bookings WHERE id=$1',[manual.id])).rows[0];
  assert.equal((await intake.observe(cancellation())).code,'SOURCE_IDENTITY_CONFLICT');assert.deepEqual((await db.query('SELECT * FROM eduson_booking.bookings WHERE id=$1',[manual.id])).rows[0],before);
  const crmUrl='https://test.amocrm.ru/leads/detail/20';await importRecord(db,'amocrm','lead-20',record({phone:'+79990000002',crmUrl}));
  const imported=(await db.query("SELECT b.* FROM eduson_booking.bookings b JOIN eduson_booking.migration_v3_sources s ON s.booking_id=b.id WHERE s.source='amocrm'")).rows[0];
  const blocked=await intake.observe(cancellation({recordId:'502',raw:{api:{id:502,status:4}},record:record({time:'13:00',phone:'+79990000003',crmUrl})}));assert.equal(blocked.code,'SOURCE_IDENTITY_CONFLICT');
  assert.deepEqual((await db.query('SELECT * FROM eduson_booking.bookings WHERE id=$1',[imported.id])).rows[0],imported);assert.equal(await count(db,'bookings'),2);assert.equal((await service.getAnalyticsCancellations(admin)).length,0);
});

test('an existing Rubitime migration identity must be seeded before a first-seen cancellation can bind it',async t=>{
  const {db,intake,bookings}=await fixture(t,{schedule:true});await importRecord(db,'rubitime','501',record());
  const [before]=await bookings();const blocked=await intake.observe(cancellation());assert.equal(blocked.code,'MIGRATION_LINK_REQUIRED');
  const [after]=await bookings();assert.deepEqual(after,before);assert.equal(await count(db,'bookings'),1);
});

test('known untouched pending bookings still cancel without normalized facts or new raw-proof requirements',async t=>{
  const {db,intake,bookings}=await fixture(t);await intake.observe({...cancellation(),event:'upsert',raw:{synthetic:true}});
  const [before]=await bookings();assert.equal(before.state,'scheduled');assert.equal(before.capacityHold,true);
  const result=await intake.observe(cancellation({revision:'2',record:undefined,raw:{trustedExistingSourceNotice:true}}));assert.equal(result.status,'applied');
  const [after]=await bookings();assert.equal(after.id,before.id);assert.equal(after.state,'cancelled');assert.equal(after.version,before.version+1);assert.equal(after.capacityHold,false);assert.equal(await count(db,'compensation_events'),0);
});
