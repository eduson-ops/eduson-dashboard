import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {migrateV3} from '../migration-v3.mjs';

const admin={id:'hold-admin',role:'admin'},caller={id:'hold-caller',role:'call_center'},confirmer={id:'hold-confirmer',role:'confirmation'};
const seller={id:'hold-sales',name:'Виноградова Нина',role:'sales'},other={id:'hold-other',name:'Другой методист',role:'sales'};
const date='2026-11-10',clock='2026-11-04T07:00:00Z';
const normal=extra=>({date,time:'12:00',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',crmUrl:'https://example.amocrm.ru/leads/detail/10',age:10,hasPc:true,parentPresent:true,idempotencyKey:'normal',...extra});
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmer,seller,other])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$3,$4,\'unused\')',[actor.id,actor.id+'@test.local',actor.name||actor.id,actor.role]);
  let now=new Date(clock);const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(seller,{date,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:1});
  const ordinary=await service.createBooking(caller,normal());
  const input={snapshot:{capturedAt:clock,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время'],['Виноградова Н.',date,'12:00']]},managers:{values:[['Имя','Активен'],['Виноградова Н.','да']]}}},records:[1,2,3].map(n=>({sourceIdentity:{source:'amocrm',id:`synthetic-${n}`},date,time:'12:00',age:10,studentName:`Импорт ${n}`,phone:'',crmUrl:`https://example.amocrm.ru/leads/detail/${100+n}`,createdAt:`2026-11-01T0${n}:00:00Z`,raw:{synthetic:true,ordinal:n}}))};
  const migrate=async options=>{const preview=await migrateV3(db,input,{now:()=>now,...options});assert.equal(preview.ok,true,JSON.stringify(preview));return migrateV3(db,input,{now:()=>now,apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint,...options});};
  const mapped=async()=>{const rows=await service.listBookings(admin,{scope:'all'});const links=(await db.query('SELECT source_id,booking_id FROM eduson_booking.migration_v3_sources ORDER BY source_id')).rows;return links.map(link=>({...rows.find(r=>r.id===link.booking_id),sourceId:link.source_id}));};
  return{db,service,ordinary,migrate,mapped,setNow:value=>{now=new Date(value);}};
}
test('explicit authoritative recovery retains overflow while ordinary creation and occupancy remain bounded',async t=>{
  const {db,service,migrate,mapped}=await fixture(t);
  await assert.rejects(migrate({}),{code:'CAPACITY_CONFLICT'});
  assert.equal((await service.listBookings(admin,{scope:'all'})).length,1);
  const result=await migrate({holdExcessPending:true,enqueueFutureBookings:true});
  assert.equal(result.counts.capacityHeld,2);
  const rows=await mapped();assert.deepEqual(rows.filter(r=>r.capacityHold).map(r=>r.sourceId),['synthetic-2','synthetic-3']);
  assert.ok(rows.every(r=>r.state==='scheduled'&&r.confirmationStatus==='pending'));
  assert.equal((await service.listBookings(admin,{scope:'active'})).length,4);
  const hour=(await service.stats(admin,{date})).hours.find(h=>h.time==='12:00');
  assert.equal(hour.total,4);assert.equal(hour.capacity,2);assert.equal(hour.capacityHeld,2);assert.equal(hour.allocations.length,2);assert.equal(hour.unassigned,4);
  const snapshot=await service.getSheetSnapshot(admin);assert.equal(snapshot.slotRows.length,2);assert.equal(snapshot.ownedBookingIds.length,4);
  assert.equal((await service.listSlots(caller,{date,age:10})).find(s=>s.time==='12:00').remaining,0);
  await assert.rejects(service.createBooking(caller,normal({idempotencyKey:'extra'})),{code:'CAPACITY_FULL'});
  await assert.rejects(service.createBooking(admin,normal({idempotencyKey:'bypass',capacityHold:true})),{status:400});
  const jobs=(await db.query("SELECT DISTINCT booking_id FROM eduson_booking.sync_jobs WHERE kind='booking'")).rows;
  assert.ok(rows.every(r=>jobs.some(j=>j.booking_id===r.id)));
});
test('hold confirmation cannot take normal pending places or earn wages without an available assignment',async t=>{
  const {db,service,migrate,mapped,ordinary}=await fixture(t);await migrate({holdExcessPending:true});
  const held=(await mapped()).find(r=>r.sourceId==='synthetic-2');
  await assert.rejects(service.confirmBooking(confirmer,held.id,{version:held.version}),{code:'CAPACITY_FULL'});
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.compensation_events')).rows[0].n,0);
  assert.equal((await mapped()).find(r=>r.id===held.id).capacityHold,true);
  await service.cancelBooking(admin,ordinary.id,{version:ordinary.version,reason:'Свободное место'});
  const accepted=await service.confirmBooking(confirmer,held.id,{version:held.version});
  assert.equal(accepted.capacityHold,false);assert.equal(accepted.confirmationStatus,'confirmed');assert.ok(accepted.assignedTo);
  assert.equal((await db.query('SELECT sum(amount)::int n FROM eduson_booking.compensation_events')).rows[0].n,100);
});
test('reconciliation promotes the oldest eligible hold after a real schedule opening without paying wages',async t=>{
  const {db,service,migrate,mapped}=await fixture(t);await migrate({holdExcessPending:true});
  await service.saveSchedule(other,{date,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0,ageGroups:['13-18']});
  assert.equal((await service.reconcileCapacityHolds()).promoted,0);
  await service.saveSchedule(other,{date,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0,ageGroups:['8-12']});
  const result=await service.reconcileCapacityHolds();assert.equal(result.promoted,1);assert.equal(result.remaining,1);
  const rows=await mapped();assert.equal(rows.find(r=>r.sourceId==='synthetic-2').capacityHold,false);assert.equal(rows.find(r=>r.sourceId==='synthetic-3').capacityHold,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.compensation_events')).rows[0].n,0);
  assert.equal((await service.getSheetSnapshot(admin)).slotRows.filter(s=>s.bookingId).length,3);
  assert.equal((await service.reconcileCapacityHolds()).promoted,0);
});
