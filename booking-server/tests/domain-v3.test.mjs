import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';

const admin={id:'v3-admin',name:'Администратор',role:'admin'};
const caller={id:'v3-caller',name:'КЦ',role:'call_center'};
const confirmer={id:'v3-confirm',name:'Подтверждение',role:'confirmation'};
const seller={id:'v3-sales',name:'Первый менеджер',role:'sales'};
const other={id:'v3-other',name:'Второй менеджер',role:'sales'};
const day='2026-11-10';
let sequence=0;
const booking=extra=>({date:day,time:'12:00',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',crmUrl:'https://eduson.amocrm.ru/leads/detail/1',age:10,hasPc:true,parentPresent:true,idempotencyKey:`v3-${++sequence}`,...extra});
const report={practice:'Scratch',package:'12 уроков',paymentMethod:'Без оплаты',agreement:'',objection:'',channel:'КЦ',amountNet:0,recordingUrl:''};
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmer,seller,other])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups)VALUES($1,$2,$3,$4,$5,true,$6)',[actor.id,`${actor.id}@test.local`,actor.name,actor.role,'unused','[]']);
  let now=new Date('2026-11-04T07:00Z');
  const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(seller,{date:day,intervals:[{start:'10:00',end:'14:00'}],reserveCapacity:1});
  return{db,service,setNow:value=>{now=new Date(value);}};
}

test('availability range returns real dates and capacities and rejects unbounded windows',async t=>{
  const {service}=await fixture(t);
  await service.saveSchedule(other,{date:'2026-11-11',intervals:[{start:'16:00',end:'17:00',reserveCapacity:0}],ageGroups:['13-14']});
  const slots=await service.listSlots(caller,{from:day,to:'2026-11-11',age:10});
  assert.equal(slots.length,24);
  assert.equal(slots.find(x=>x.date===day&&x.time==='12:00').remaining,2);
  assert.equal(slots.find(x=>x.date==='2026-11-11'&&x.time==='16:00').remaining,0);
  assert.equal((await service.listSlots(caller,{date:day})).length,12);
  await assert.rejects(service.listSlots(caller,{from:'2026-11-01',to:'2026-12-02'}),{status:400});
  await assert.rejects(service.listSlots(caller,{from:'2026-11-11',to:day}),{status:400});
  await assert.rejects(service.listSlots(caller,{from:day}),{status:400});
});

test('range save updates only supplied dates and retains exact interval reserve overrides',async t=>{
  const {service}=await fixture(t);
  await service.saveSchedule(seller,{date:'2026-11-08',intervals:[{start:'15:00',end:'16:00'}]});
  const result=await service.saveScheduleRange(seller,{managerId:seller.id,from:day,to:'2026-11-11',days:[
    {date:day,version:1,reserveCapacity:1,intervals:[{start:'17:00',end:'18:00',reserveCapacity:1},{start:'18:00',end:'19:00',reserveCapacity:1},{start:'19:00',end:'20:00',reserveCapacity:0}]},
    {date:'2026-11-11',version:0,reserveCapacity:0,intervals:[{start:'12:00',end:'13:00'}]}
  ],ageGroups:['8-12']});
  assert.deepEqual(result.days.map(x=>[x.date,x.version]),[[day,2],['2026-11-11',1]]);
  assert.deepEqual(result.days[0].intervals,[{start:'17:00',end:'19:00',reserveCapacity:1},{start:'19:00',end:'20:00',reserveCapacity:0}]);
  assert.deepEqual(result.ageGroups,['8-12']);
  const history=await service.getSchedule(seller,{date:'2026-11-08'});
  assert.deepEqual(history.days[0].intervals,[{start:'15:00',end:'16:00'}]);
});

test('a stale day rolls back the whole range including age tags and projection version',async t=>{
  const {db,service}=await fixture(t);
  await service.saveSchedule(seller,{date:'2026-11-11',intervals:[{start:'12:00',end:'13:00'}]});
  const before=(await db.query("SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].version;
  await assert.rejects(service.saveScheduleRange(seller,{from:day,to:'2026-11-11',ageGroups:['13-14'],days:[
    {date:day,version:1,intervals:[{start:'18:00',end:'19:00'}]},
    {date:'2026-11-11',version:0,intervals:[]}
  ]}),{status:409});
  const saved=await service.getSchedule(seller,{date:day});
  assert.equal(saved.days[0].version,1);
  assert.deepEqual(saved.days[0].intervals,[{start:'10:00',end:'14:00'}]);
  assert.deepEqual(saved.ageGroups,[]);
  assert.equal((await db.query("SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].version,before);
});

test('range save preserves ownership and occupied capacity without partial writes',async t=>{
  const {service}=await fixture(t);
  await service.createBooking(caller,booking());
  const input={from:day,to:'2026-11-11',days:[{date:day,version:1,intervals:[]},{date:'2026-11-11',version:0,intervals:[{start:'12:00',end:'13:00'}]}]};
  await assert.rejects(service.saveScheduleRange(caller,input),{status:403});
  await assert.rejects(service.saveScheduleRange(other,{...input,managerId:seller.id}),{status:403});
  await assert.rejects(service.saveScheduleRange(seller,input),{status:409});
  assert.equal((await service.getSchedule(seller,{date:'2026-11-11'})).days.length,0);
  await assert.rejects(service.saveScheduleRange(seller,{...input,days:[{date:'2026-11-12',version:0,intervals:[]}]}),{status:400});
  await assert.rejects(service.saveScheduleRange(seller,{...input,days:[input.days[0],input.days[0]]}),{status:400});
  await assert.rejects(service.saveScheduleRange(seller,{...input,days:[{date:day,intervals:[]}]}),{status:400});
  await assert.rejects(service.saveScheduleRange(seller,{from:day,to:day,ageGroups:['13-14'],days:[{date:day,version:1,intervals:[{start:'10:00',end:'14:00'}]}]}),{status:409});
  assert.deepEqual((await service.getSchedule(seller,{date:day})).ageGroups,[]);
});

test('pending allocation uses all eligible primary places before a reserve and exposes identities',async t=>{
  const {service}=await fixture(t);
  await service.saveSchedule(other,{date:day,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:1});
  const first=await service.createBooking(caller,booking()),second=await service.createBooking(caller,booking());
  let hour=(await service.stats(admin,{date:day})).hours.find(x=>x.time==='12:00');
  assert.equal(hour.reserve,0);
  assert.equal(hour.allocations.length,2);
  assert.ok(hour.allocations.every(x=>x.kind==='primary'&&x.managerName&&x.managerId));
  const third=await service.createBooking(caller,booking());
  hour=(await service.stats(admin,{date:day})).hours.find(x=>x.time==='12:00');
  assert.equal(hour.reserve,1);
  assert.deepEqual(hour.allocations.map(x=>x.bookingId).sort(),[first.id,second.id,third.id].sort());
  assert.equal(hour.allocations.filter(x=>x.kind==='primary').length,2);
  assert.equal(hour.managerList.length,2);
});

test('admin stats expose bookings created on the selected day across future lesson dates',async t=>{
  const {db,service}=await fixture(t);
  await service.saveSchedule(other,{date:'2026-11-11',intervals:[{start:'12:00',end:'13:00'}]});
  const todaySlot=await service.createBooking(caller,booking({idempotencyKey:'retro-today'}));
  const futureSlot=await service.createBooking(caller,booking({date:'2026-11-11',idempotencyKey:'retro-future'}));
  await db.query('UPDATE eduson_booking.bookings SET created_at=$1 WHERE id=$2',["2026-11-09T21:30:00Z",todaySlot.id]);
  await db.query('UPDATE eduson_booking.bookings SET created_at=$1 WHERE id=$2',["2026-11-10T20:30:00Z",futureSlot.id]);
  const stats=await service.stats(admin,{date:'2026-11-10'});
  const noon=stats.recordedHours.find(hour=>hour.time==='12:00');
  assert.equal(noon.total,2);
  assert.deepEqual(noon.bookingIds.sort(),[todaySlot.id,futureSlot.id].sort());
  assert.deepEqual(noon.lessonDates.sort(),['2026-11-10','2026-11-11']);
  assert.equal(stats.recordedTotals.total,2);
  assert.equal(stats.recordedFunnel.booked,2);
});

test('admin stats expose one process funnel for the selected lesson day',async t=>{
  const {service}=await fixture(t);
  const first=await service.createBooking(caller,booking({idempotencyKey:'funnel-first'}));
  await service.createBooking(caller,booking({idempotencyKey:'funnel-second'}));
  const confirmed=await service.confirmBooking(confirmer,first.id,{version:first.version});
  assert.equal(confirmed.assignmentKind,'primary');
  const funnel=(await service.stats(admin,{date:day})).funnel;
  assert.deepEqual(funnel,{booked:2,confirmed:1,assigned:1,started:0,completed:0,reported:0,paid:0});
});

test('admin business stats exclude test lessons from hourly and retro counters',async t=>{
  const {service}=await fixture(t);
  await service.createBooking(admin,booking({isTest:true,idempotencyKey:'stats-test'}));
  const stats=await service.stats(admin,{date:day});
  const hour=stats.hours.find(item=>item.time==='12:00');
  assert.equal(hour.total,0);
  assert.equal(stats.funnel.booked,0);
  assert.equal(stats.recordedHours.find(item=>item.time==='12:00').total,0);
});

test('canonical allocation maximizes primary places across constrained age groups',async t=>{
  const {db,service}=await fixture(t);
  const third={id:'v3-third',name:'Третий менеджер',role:'sales'};
  await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups)VALUES($1,$2,$3,$4,$5,true,$6)',[third.id,'third@test.local',third.name,third.role,'unused','[]']);
  await service.saveSchedule(seller,{date:day,intervals:[{start:'12:00',end:'13:00'}],ageGroups:['8-12']});
  await service.saveSchedule(other,{date:day,intervals:[{start:'12:00',end:'13:00'}],ageGroups:['8-18']});
  await service.saveSchedule(third,{date:day,intervals:[{start:'12:00',end:'13:00'}],ageGroups:['13-18']});
  const rows=[];
  for(const age of [10,10,14])rows.push(await service.createBooking(caller,booking({age})));
  for(const [index,row] of rows.entries())await db.query('UPDATE eduson_booking.bookings SET created_at=$1 WHERE id=$2',[`2026-11-04T07:00:0${index}Z`,row.id]);
  const hour=(await service.stats(admin,{date:day})).hours.find(x=>x.time==='12:00');
  assert.equal(hour.allocations.length,3);
  assert.equal(hour.reserve,0);
  assert.ok(hour.allocations.every(x=>x.kind==='primary'));
  const confirmed=await service.confirmBooking(confirmer,rows[2].id,{version:rows[2].version});
  assert.equal(confirmed.assignedTo,third.id);
  assert.equal((await service.stats(admin,{date:day})).hours.find(x=>x.time==='12:00').reserve,0);
});

test('external historical records stay archived without inventing calendar occupancy or outcomes',async t=>{
  const {db,service}=await fixture(t);
  const historical='2026-10-09',start=new Date(`${historical}T12:00:00+03:00`);
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by,history_only)
    VALUES('rubitime-history',$1,'12:00',$2,$3,'Исторический ученик','','','',10,NULL,NULL,$4,'legacy-import',true)`,[historical,start,new Date(+start+3600000),new Date(+start-7200000)]);
  const archive=await service.listBookings(admin,{scope:'completed'});
  assert.equal(archive.length,1);assert.equal(archive[0].state,'scheduled');assert.equal(archive[0].confirmationStatus,'pending');assert.equal(archive[0].historyOnly,true);
  assert.equal((await service.listBookings(admin,{scope:'active'})).length,0);
  assert.equal(await service.expireUnconfirmed(),0);
  const snapshot=await service.getSheetSnapshot(admin);
  assert.equal(snapshot.slotRows.length,8);assert.ok(snapshot.slotRows.every(x=>x.date===day));
  const hour=(await service.stats(admin,{date:historical})).hours.find(x=>x.time==='12:00');
  assert.equal(hour.total,1);assert.equal(hour.completed,0);assert.equal(hour.confirmed,0);assert.deepEqual(hour.allocations,[]);
});

test('only an admin creates a test lesson and it cannot become business lesson or cancellation analytics',async t=>{
  const {service}=await fixture(t);
  await assert.rejects(service.createBooking(caller,booking({isTest:true})),{status:403});
  await assert.rejects(service.createBooking(admin,booking({isTest:'yes'})),{status:400});
  await assert.rejects(service.createBooking(admin,booking({historyOnly:true})),{status:400});
  const finish=async extra=>{
    let row=await service.createBooking(admin,booking(extra));
    row=await service.confirmBooking(confirmer,row.id,{version:row.version});
    row=await service.startBooking(seller,row.id,{version:row.version});
    row=await service.completeBooking(seller,row.id,{version:row.version});
    return service.saveReport(seller,row.id,{...report,version:row.version});
  };
  const testLesson=await finish({time:'10:00',isTest:true});
  assert.equal(testLesson.isTest,true);
  const normal=await finish({time:'11:00'});assert.equal(normal.isTest,false);
  assert.deepEqual((await service.getAnalyticsLessons(admin)).map(x=>x.bookingId),[normal.id]);
  let cancelled=await service.createBooking(admin,booking({time:'13:00',isTest:true}));
  cancelled=await service.cancelBooking(admin,cancelled.id,{reason:'Тест',version:cancelled.version});
  assert.equal(cancelled.isTest,true);assert.equal((await service.getAnalyticsCancellations(admin)).length,0);
});

test('confirmation accepts the exact two-hour deadline and rejects the next millisecond without side effects',async t=>{
  const {db,service,setNow}=await fixture(t);
  const boundary=await service.createBooking(caller,booking()),late=await service.createBooking(caller,booking());
  setNow(boundary.confirmationDueAt);
  assert.equal((await service.confirmBooking(confirmer,boundary.id,{version:boundary.version})).confirmationStatus,'confirmed');
  const counts=async()=>{const result={};for(const table of ['sync_jobs','audit_events','compensation_events','booking_confirmations','operation_jobs'])result[table]=(await db.query(`SELECT count(*)::int n FROM eduson_booking.${table}`)).rows[0].n;result.projection=(await db.query("SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0].version;return result;};
  const before=await counts();setNow(+new Date(late.confirmationDueAt)+1);
  await assert.rejects(service.confirmBooking(confirmer,late.id,{version:late.version}),{status:409,code:'CONFIRMATION_DEADLINE_PASSED'});
  assert.deepEqual(await counts(),before);
  const [unchanged]=await service.listBookings(admin,{id:late.id,scope:'all'});
  assert.equal(unchanged.version,late.version);assert.equal(unchanged.confirmationStatus,'pending');assert.equal(unchanged.assignedTo,null);
});

async function archive(db,id){
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by,history_only)
    VALUES($1,'2026-10-09','12:00','2026-10-09T09:00Z','2026-10-09T10:00Z','Архив','','','',10,NULL,NULL,'2026-10-09T07:00Z','legacy-import',true)`,[id]);
  await db.query(`INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload)VALUES($1,$2,'legacy-import','admin','legacy_imported',$3)`,[`import-${id}`,id,JSON.stringify({source:'rubitime',elapsedUnknown:true})]);
}
test('ordinary cancellation cannot fabricate an outcome for an unknown archived lesson',async t=>{
  const {db,service}=await fixture(t);await archive(db,'archive-cancel');
  for(const actor of [confirmer,admin])await assert.rejects(service.cancelBooking(actor,'archive-cancel',{version:1,reason:'Нет подтверждения'}),{status:409,code:'ARCHIVE_RESOLUTION_REQUIRED'});
  assert.equal((await service.getAnalyticsCancellations(admin)).length,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.sync_jobs')).rows[0].n,0);
  assert.equal((await service.listBookings(admin,{scope:'completed'}))[0].state,'scheduled');
});
test('admin records a proven archived outcome and report without calendar or primary collisions',async t=>{
  const {db,service}=await fixture(t);await archive(db,'archive-held-1');await archive(db,'archive-held-2');
  await db.query('UPDATE eduson_booking.users SET active=false WHERE id=$1',[seller.id]);
  for(const id of ['archive-held-1','archive-held-2']){
    let row=await service.resolveLegacy(admin,id,{version:1,outcome:'completed',managerId:seller.id,reason:'Проверена исходная запись урока'});
    assert.equal(row.state,'completed');assert.equal(row.assignedTo,seller.id);assert.equal(row.historyOnly,true);
    row=await service.saveReport(admin,id,{...report,version:row.version});assert.equal(row.report.bookingId,id);
    await assert.rejects(service.cancelBooking(admin,id,{version:row.version,reason:'Обычная отмена'}),{status:409,code:'ARCHIVE_RESOLUTION_REQUIRED'});
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM eduson_booking.schedules WHERE date='2026-10-09'")).rows[0].n,0);
  const projection=await service.getSheetSnapshot(admin);assert.ok(projection.slotRows.every(s=>s.date!=='2026-10-09'));
  assert.equal((await service.getAnalyticsLessons(admin)).length,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.compensation_events')).rows[0].n,0);
});
