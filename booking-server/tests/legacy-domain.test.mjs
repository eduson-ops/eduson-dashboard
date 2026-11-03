import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { BookingService } from '../domain.mjs';

const admin={id:'admin',role:'admin',name:'Администратор'};
const seller={id:'seller',role:'sales',name:'Менеджер А'};
const other={id:'other',role:'sales',name:'Менеджер Б'};
const confirmer={id:'confirmer',role:'confirmation',name:'Подтверждение'};
const caller={id:'caller',role:'call_center',name:'КЦ'};
const day='2026-11-03';
let sequence=0;
const input=extra=>({date:day,time:'15:00',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',crmUrl:'https://eduson.amocrm.ru/leads/detail/1',age:10,hasPc:true,parentPresent:true,comment:'',idempotencyKey:`legacy-domain-${++sequence}`,...extra});
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,seller,other,confirmer,caller])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES($1,$2,$3,$4,$5,true,$6)',[actor.id,`${actor.id}@example.test`,actor.name,actor.role,'unused','[]']);
  let now=new Date('2026-11-03T09:00:00Z');
  const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(seller,{date:day,intervals:[{start:'10:00',end:'17:00'}]});
  return {db,service,setNow:value=>{now=new Date(value)}};
}
async function legacy(db,{id='legacy-1',time='10:00',elapsedUnknown=true,assigned=null,confirmed=false,...extra}={}){
  const start=new Date(`${day}T${time}:00+03:00`);
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,comment,confirmation_status,confirmation_due_at,assigned_to,assignment_kind,created_by,idempotency_key,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'','','',$6,10,NULL,NULL,'Исходный комментарий',$7,$8,$9,$10,'legacy-import',$11,$12,$12)`,[id,day,time,start,new Date(+start+3600000),'https://eduson.amocrm.ru/leads/detail/1',confirmed?'confirmed':'pending',new Date(+start-7200000),assigned,assigned?'primary':null,`legacy-${id}`,'2026-11-03T08:00:00Z']);
  await db.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[`import-${id}`,id,'legacy-import','admin','legacy_imported',JSON.stringify({source:'vds_sqlite',managerName:seller.name,capturedAt:'2026-11-03T09:00:00Z',elapsedUnknown,raw:{secretSource:'raw client data'},...extra}),'2026-11-03T09:00:00Z']);
  return id;
}

test('per-interval reserve overrides preserve exact hourly capacity and merge only equal overrides',async t=>{
  const {service}=await fixture(t);
  const dayResult=await service.saveSchedule(seller,{date:day,reserveCapacity:1,intervals:[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'11:00',end:'12:00',reserveCapacity:1},{start:'12:00',end:'13:00',reserveCapacity:1},{start:'14:00',end:'15:00'}]});
  assert.deepEqual(dayResult.intervals,[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'11:00',end:'13:00',reserveCapacity:1},{start:'14:00',end:'15:00'}]);
  const slots=await service.listSlots(admin,{date:day});
  assert.equal(slots.find(s=>s.time==='10:00').capacity,1);
  assert.equal(slots.find(s=>s.time==='11:00').capacity,2);
  assert.equal(slots.find(s=>s.time==='14:00').capacity,2);
  assert.equal((await service.stats(admin,{date:day})).hours.find(h=>h.time==='10:00').capacity,1);
  await assert.rejects(service.saveSchedule(seller,{date:day,intervals:[{start:'10:00',end:'11:00',reserveCapacity:2}]}),{status:400});
});

test('legacy unknown facts are public as missing fields while past held status stays protected',async t=>{
  const {db,service,setNow}=await fixture(t);
  const old=await legacy(db);
  await legacy(db,{id:'legacy-future',time:'15:00',elapsedUnknown:false});
  setNow('2026-11-03T14:00:00Z');
  assert.equal(await service.expireUnconfirmed(),1);
  const [record]=await service.listBookings(admin,{id:old,scope:'all'});
  assert.equal(record.state,'scheduled');
  assert.deepEqual(record.legacy,{source:'vds_sqlite',managerName:seller.name,elapsedUnknown:true,missingFields:['studentName','parentName','phone','hasPc','parentPresent'],needsReview:true});
  assert.equal(JSON.stringify(record).includes('raw client data'),false);
  await assert.rejects(service.createBooking(caller,input({time:'16:00',hasPc:null})),{status:400});
  const normal=await service.createBooking(caller,input({date:'2026-11-04',time:'15:00'})).catch(error=>error);
  assert.ok(normal instanceof Error); // no next-day schedule: strict create cannot consume unconfigured slots.
});

test('legacy contact corrections enforce version ownership and eligible age without inventing missing values',async t=>{
  const {db,service}=await fixture(t);
  const id=await legacy(db,{time:'15:00',elapsedUnknown:false,assigned:seller.id,confirmed:true});
  let [record]=await service.listBookings(admin,{id,scope:'all'});
  await assert.rejects(service.updateBookingDetails(other,id,{studentName:'Чужое изменение',version:record.version}),{status:403});
  record=await service.updateBookingDetails(seller,id,{studentName:'Настоящее имя',phone:'+44 1234 567890',hasPc:false,version:record.version});
  assert.equal(record.studentName,'Настоящее имя');assert.equal(record.parentName,'');assert.equal(record.parentPresent,null);
  assert.deepEqual(record.legacy.missingFields,['parentName','parentPresent']);
  await assert.rejects(service.updateBookingDetails(admin,id,{phone:'bad',version:record.version}),{status:400});
  await assert.rejects(service.updateBookingDetails(admin,id,{date:'2026-11-04',version:record.version}),{status:400});
  await assert.rejects(service.updateBookingDetails(admin,id,{parentName:'Родитель',version:record.version-1}),{status:409});
  await db.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2',['["8-12"]',seller.id]);
  await assert.rejects(service.updateBookingDetails(admin,id,{age:15,version:record.version}),{status:409});
});

test('admin resolves elapsed legacy only with explicit outcome proof and can report an unconfirmed held lesson',async t=>{
  const {db,service}=await fixture(t);
  const id=await legacy(db);
  let [record]=await service.listBookings(admin,{id,scope:'all'});
  await assert.rejects(service.resolveLegacy(confirmer,id,{outcome:'completed',managerId:seller.id,reason:'Проверено',version:record.version}),{status:403});
  await assert.rejects(service.resolveLegacy(admin,id,{outcome:'completed',reason:'Проверено',version:record.version}),{status:400});
  record=await service.resolveLegacy(admin,id,{outcome:'completed',managerId:seller.id,reason:'Проверена запись урока',version:record.version});
  assert.equal(record.state,'completed');assert.equal(record.confirmationStatus,'pending');assert.equal(record.confirmedAt,null);assert.equal(record.assignedTo,seller.id);assert.equal(record.assignmentKind,'primary');assert.equal(record.legacy.needsReview,false);
  record=await service.saveReport(seller,id,{practice:'Scratch',package:'Без покупки',paymentMethod:'Без оплаты',agreement:'',objection:'',channel:'КЦ',amountNet:0,recordingUrl:'',version:record.version});
  assert.equal(record.report.bookingId,id);
  const reportTimestamp=record.report.timestamp;
  record=await service.updateBookingDetails(seller,id,{crmUrl:'https://eduson.amocrm.ru/leads/detail/2',age:11,version:record.version});
  assert.equal(record.report.crmUrl,'https://eduson.amocrm.ru/leads/detail/2');assert.equal(record.report.age,11);assert.equal(record.report.timestamp,reportTimestamp);
  assert.deepEqual((await db.query('SELECT kind FROM eduson_booking.sync_jobs WHERE booking_id=$1 AND version=$2 ORDER BY kind',[id,record.version])).rows.map(row=>row.kind),['booking','report']);
  const cancelledId=await legacy(db,{id:'legacy-cancel',time:'11:00'});
  const [cancelled]=await service.listBookings(admin,{id:cancelledId,scope:'all'});
  const result=await service.resolveLegacy(admin,cancelledId,{outcome:'cancelled',reason:'Родитель подтвердил отмену',version:cancelled.version});
  assert.equal(result.cancelReason,'Родитель подтвердил отмену');assert.equal(result.legacy.needsReview,false);
  await assert.rejects(service.resolveLegacy(admin,id,{outcome:'cancelled',reason:'Повтор',version:record.version}),{status:409});
});

test('sheet snapshot uses canonical matching, exact reserves, history and managed empty days',async t=>{
  const {db,service}=await fixture(t);
  await service.saveSchedule(seller,{date:day,intervals:[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'15:00',end:'16:00',reserveCapacity:1}]});
  await service.saveSchedule(other,{date:day,intervals:[{start:'15:00',end:'16:00',reserveCapacity:0}],ageGroups:['13-15']});
  await service.saveSchedule(seller,{date:'2026-11-04',intervals:[]});
  await legacy(db,{id:'past-held-unknown'});
  const a=await service.createBooking(caller,input());const b=await service.createBooking(caller,input());
  const snapshot=await service.getSheetSnapshot(admin);
  assert.equal(snapshot.slotRows.length,4);
  assert.equal(snapshot.scheduleRows.length,3);
  assert.ok(snapshot.managedSchedules.some(row=>row.date==='2026-11-04'&&row.manager===seller.name));
  assert.equal(snapshot.slotRows.filter(row=>row.status==='booked').length,3);
  assert.equal(snapshot.slotRows.find(row=>row.bookingId===a.id).manager,seller.name);
  assert.equal(snapshot.slotRows.find(row=>row.bookingId===b.id).manager,seller.name);
  assert.deepEqual(snapshot.unresolved,[]);
  assert.ok(snapshot.ownedBookingIds.includes(a.id));
  assert.deepEqual(snapshot,await service.getSheetSnapshot(admin));
  await assert.rejects(service.getSheetSnapshot(seller),{status:403});
});

test('coalesced projection marks booking and schedule changes without clearing an active lease',async t=>{
  const {db,service}=await fixture(t);
  let row=(await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
  assert.equal(row.version,1);assert.equal(row.status,'pending');
  await db.query("UPDATE eduson_booking.sheet_projections SET status='processing',lease_token='worker-token',lease_until='2030-01-01T00:00:00Z'");
  await service.createBooking(caller,input());
  row=(await db.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
  assert.equal(row.version,2);assert.equal(row.status,'pending');assert.equal(row.lease_token,'worker-token');assert.equal(row.attempts,0);
});

test('snapshot fails instead of dropping orphaned occupancy and normal SQL rows cannot hide unknown boolean facts',async t=>{
  const {db,service}=await fixture(t);
  const created=await service.createBooking(caller,input());
  await assert.rejects(db.query('UPDATE eduson_booking.bookings SET has_pc=NULL WHERE id=$1',[created.id]),{code:'23514'});
  await db.query('DELETE FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2',[seller.id,day]);
  await assert.rejects(service.getSheetSnapshot(admin),{status:409,code:'PROJECTION_UNRESOLVED'});
});

test('snapshot refuses ambiguous public manager and day ownership without banning equal names globally',async t=>{
  const {db,service}=await fixture(t);
  await db.query('UPDATE eduson_booking.users SET name=$1 WHERE id=$2',[seller.name,other.id]);
  await service.saveSchedule(other,{date:day,intervals:[{start:'15:00',end:'16:00'}]});
  const snapshot=await service.getSheetSnapshot(admin);
  assert.equal(snapshot.unresolved.length,1);
  assert.equal(snapshot.unresolved[0].code,'AMBIGUOUS_MANAGER_NAME');
  assert.equal(snapshot.unresolved[0].date,day);
  assert.equal(snapshot.unresolved[0].manager,seller.name);
  assert.deepEqual(snapshot.unresolved[0].managerIds.sort(),[other.id,seller.id].sort());
});

test('ended published capacity and historical occupancy survive current staff active role and age edits',async t=>{
  const {db,service,setNow}=await fixture(t);
  await service.saveSchedule(seller,{date:day,intervals:[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'15:00',end:'16:00',reserveCapacity:1}]});
  await service.saveSchedule(seller,{date:'2026-11-04',intervals:[{start:'15:00',end:'16:00'}]});
  await legacy(db,{id:'old-unknown'});
  let held=await service.createBooking(caller,input());
  held=await service.confirmBooking(confirmer,held.id,{version:held.version});
  held=await service.startBooking(seller,held.id,{version:held.version});
  await service.completeBooking(seller,held.id,{version:held.version});
  setNow('2026-11-03T14:00:00Z');
  const original=(await service.getSheetSnapshot(admin)).slotRows.filter(row=>row.date===day);
  assert.equal(original.length,3);assert.equal(original.filter(row=>row.status==='booked').length,2);
  for(const change of [{active:false},{role:'call_center'},{ageGroups:['13-15']}]) {
    await db.query("UPDATE eduson_booking.users SET active=true,role='sales',age_groups='[]' WHERE id=$1",[seller.id]);
    await db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.bookings, eduson_booking.schedules, eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
      if(Object.hasOwn(change,'active'))await tx.query('UPDATE eduson_booking.users SET active=$1 WHERE id=$2',[change.active,seller.id]);
      if(change.role)await tx.query('UPDATE eduson_booking.users SET role=$1 WHERE id=$2',[change.role,seller.id]);
      if(change.ageGroups)await tx.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2',[JSON.stringify(change.ageGroups),seller.id]);
      await service.validateCapacity(tx);await service.markSheetsDirty(tx);
    });
    const projected=await service.getSheetSnapshot(admin);
    assert.deepEqual(projected.slotRows.filter(row=>row.date===day),original);
    assert.ok(projected.managedSchedules.some(row=>row.date==='2026-11-04'));
    const expectedFuture=change.ageGroups?2:0;
    assert.equal(projected.slotRows.filter(row=>row.date==='2026-11-04').length,expectedFuture);
    assert.equal(projected.scheduleRows.filter(row=>row.date==='2026-11-04').length,expectedFuture?1:0);
    await assert.rejects(service.createBooking(caller,input({date:'2026-11-04'})),{status:409});
  }
  assert.equal((await service.listBookings(admin,{id:'old-unknown',scope:'all'}))[0].legacy.elapsedUnknown,true);
});

test('historical snapshot boundary uses exclusive interval end and keeps ongoing intervals strict',async t=>{
  const {db,service,setNow}=await fixture(t);
  let booking=await service.createBooking(caller,input());
  booking=await service.confirmBooking(confirmer,booking.id,{version:booking.version});
  booking=await service.startBooking(seller,booking.id,{version:booking.version});
  await db.query('UPDATE eduson_booking.users SET active=false WHERE id=$1',[seller.id]);
  setNow('2026-11-03T12:59:59.999Z');
  await assert.rejects(service.getSheetSnapshot(admin),{status:409});
  setNow('2026-11-03T13:00:00.000Z');
  assert.ok((await service.getSheetSnapshot(admin)).slotRows.some(row=>row.bookingId===booking.id));
  assert.equal((await service.listBookings(admin,{id:booking.id,scope:'all'}))[0].state,'in_progress');
});

test('legacy cancellation archive preserves original unknown author and timestamp after restoration',async t=>{
  const {db,service}=await fixture(t);
  const id=await legacy(db,{id:'old-cancelled',time:'15:00',elapsedUnknown:false});
  await db.query("UPDATE eduson_booking.bookings SET state='cancelled',cancel_source='legacy',cancel_reason=NULL,cancelled_at='2026-11-03T08:30:00Z' WHERE id=$1",[id]);
  await db.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',['legacy-cancel-event',id,'legacy-import','admin','legacy_cancelled',JSON.stringify({timestamp:'2026-11-03T08:30:00.000Z',reason:'legacy_unknown',source:'legacy_unknown',authorUnknown:true,manager:'Неизвестен',contactMethod:'',comment:'Исходный комментарий',firstCancellation:true,version:1,raw:{actor:seller.name}}),'2026-11-03T08:30:00Z']);
  const [before]=await service.listBookings(admin,{id,scope:'all'});
  assert.equal(before.cancellation.timestamp,'2026-11-03T08:30:00.000Z');
  assert.equal(before.cancellation.authorUnknown,true);
  const restored=await service.restoreBooking(admin,id,{version:before.version});
  assert.equal(restored.cancellation.timestamp,before.cancellation.timestamp);
  assert.equal(restored.cancellation.manager,'Неизвестен');
  assert.equal(JSON.stringify(restored).includes('raw'),false);
});
