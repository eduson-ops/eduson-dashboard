import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {migrateV3} from '../migration-v3.mjs';

const admin={id:'cutoff-admin',role:'admin'},caller={id:'cutoff-caller',role:'call_center'},confirmer={id:'cutoff-confirmation',role:'confirmation'},sales={id:'cutoff-sales',role:'sales'};
const date='2030-01-02',due='2030-01-02T09:00:00.000Z';
const input=extra=>({date,time:'14:00',studentName:'Проверка срока записи',parentName:'Родитель',phone:'+79990000000',crmUrl:'https://test.amocrm.ru/leads/detail/1',age:10,hasPc:true,parentPresent:true,idempotencyKey:'cutoff-normal',...extra});
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmer,sales])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$1,$3,\'unused\')',[actor.id,actor.id+'@test.invalid',actor.role]);
  let now=new Date('2030-01-02T08:00:00.000Z');const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(sales,{date,intervals:[{start:'14:00',end:'15:00'}],reserveCapacity:1});
  return{db,service,setNow:value=>{now=new Date(value);}};
}
const writes=async db=>(await db.query(`SELECT (SELECT count(*)::int FROM eduson_booking.bookings) bookings,(SELECT count(*)::int FROM eduson_booking.audit_events) audits,(SELECT count(*)::int FROM eduson_booking.sync_jobs) jobs,(SELECT count(*)::int FROM eduson_booking.compensation_events) compensation,(SELECT version FROM eduson_booking.sheet_projections WHERE key='schedule') projection_version`)).rows[0];

test('ordinary call-center and admin booking reject the expired two-hour cutoff without consuming capacity or writing facts',async t=>{
  const {db,service,setNow}=await fixture(t),before=await writes(db);
  for(const now of ['2030-01-02T09:00:00.001Z','2030-01-02T10:00:00.000Z']){
    setNow(now);
    for(const actor of [caller,admin])await assert.rejects(service.createBooking(actor,input({idempotencyKey:now+actor.id})),{status:409,code:'BOOKING_CUTOFF_PASSED',message:'Записать на урок можно не позднее чем за 2 часа до начала. Выберите другое время.'});
    const slot=(await service.listSlots(caller,{date,age:10})).find(row=>row.time==='14:00');
    assert.deepEqual([slot.capacity,slot.remaining],[2,2]);assert.deepEqual(await writes(db),before);
  }
});

test('ordinary booking at the exact two-hour boundary can immediately confirm and start',async t=>{
  const {service,setNow}=await fixture(t);setNow(due);
  const created=await service.createBooking(caller,input());assert.equal(created.confirmationDueAt,due);
  const confirmed=await service.confirmBooking(confirmer,created.id,{version:created.version});assert.equal(confirmed.confirmationStatus,'confirmed');assert.equal(confirmed.assignedTo,sales.id);
  const started=await service.startBooking(sales,confirmed.id,{version:confirmed.version});assert.equal(started.state,'in_progress');
});

test('a lost creation response can retry its existing idempotency key after the cutoff without new writes',async t=>{
  const {db,service,setNow}=await fixture(t),payload=input(),created=await service.createBooking(caller,payload),before=await writes(db);
  setNow('2030-01-02T10:00:00.000Z');
  const repeated=await service.createBooking(caller,payload);assert.equal(repeated.id,created.id);assert.equal(repeated.version,created.version);assert.deepEqual(await writes(db),before);
  await assert.rejects(service.createBooking(caller,{...payload,idempotencyKey:'a-new-booking'}),{status:409,code:'BOOKING_CUTOFF_PASSED'});assert.deepEqual(await writes(db),before);
});

test('authoritative source facts inside the cutoff remain importable as truthful pending bookings',async t=>{
  const {db,service,setNow}=await fixture(t);const now=new Date('2030-01-02T10:00:00.000Z');setNow(now);
  const source={snapshot:{capturedAt:now.toISOString(),timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время']]},managers:{values:[['Имя','Активен']]}}},records:[{sourceIdentity:{source:'rubitime',id:'cutoff-source'},...input(),crmUrl:'',raw:{synthetic:true}}]};
  const preview=await migrateV3(db,source,{now:()=>now});assert.equal(preview.ok,true);
  await migrateV3(db,source,{now:()=>now,apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint});
  const [row]=await service.listBookings(admin,{scope:'all'});assert.equal(row.state,'scheduled');assert.equal(row.confirmationStatus,'pending');assert.equal(row.confirmationDueAt,due);assert.equal(row.historyOnly,false);
});
