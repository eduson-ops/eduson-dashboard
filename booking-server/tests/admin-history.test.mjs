import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { BookingService } from '../domain.mjs';
import { matchConfirmationRows, createConfirmationHistorySynchronizer } from '../confirmation-history.mjs';

const admin={id:'history-admin',role:'admin',name:'Администратор'};
const caller={id:'history-caller',role:'call_center',name:'КЦ'};
const confirmer={id:'history-confirmation',role:'confirmation',name:'Анна Багдасарян'};
const seller={id:'history-sales',role:'sales',name:'Нина Виноградова'};

async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  for(const actor of [admin,caller,confirmer,seller])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups) VALUES($1,$2,$3,$4,$5,true,$6)',[actor.id,`${actor.id}@test.local`,actor.name,actor.role,'unused','[]']);
  let now=new Date('2026-11-04T09:00:00Z');
  const service=new BookingService(db,{now:()=>now,random:()=>0});
  await service.saveSchedule(seller,{date:'2026-11-10',intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:1});
  return{db,service,setNow:value=>{now=new Date(value);}};
}

test('hourly admin total keeps cancelled bookings visible for the historical slot',async t=>{
  const {service}=await fixture(t);
  const row=await service.createBooking(caller,{date:'2026-11-10',time:'12:00',studentName:'Исторический ученик',parentName:'Родитель',phone:'+79990000000',crmUrl:'https://eduson.amocrm.ru/leads/detail/9101',age:10,hasPc:true,parentPresent:true,comment:'',idempotencyKey:'history-total'});
  await service.cancelBooking(caller,row.id,{reason:'Не подтвердили',version:row.version});
  const hour=(await service.stats(admin,{date:'2026-11-10'})).hours.find(item=>item.time==='12:00');
  assert.equal(hour.total,1);
  assert.equal(hour.cancelledConfirmation,1);
});

test('confirmation form row links to a future booking by CRM, slot and causal timestamps',()=>{
  const booking={id:'booking-1',date:'2026-11-04',time:'18:00',startsAt:'2026-11-04T15:00:00.000Z',createdAt:'2026-11-04T09:00:00.000Z',crmUrl:'https://eduson.amocrm.ru/leads/detail/9102'};
  const result=matchConfirmationRows([
    ['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? '],
    ['04.11.2026 13:07:53',booking.crmUrl,'Нина Виноградова','18:00:00']
  ],[booking]);
  assert.deepEqual(result.matches,[{rowNumber:2,bookingId:'booking-1',confirmedAt:'2026-11-04T10:07:53.000Z',managerName:'Нина Виноградова'}]);
  assert.equal(result.unmatched,0);
  assert.equal(result.ambiguous,0);
  const reordered=matchConfirmationRows([
    ['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? '],
    ['04.11.2026 13:07:53',booking.crmUrl,'Нина Виноградова','18:00:00']
  ],[{...booking,sourceManager:'Виноградова Нина'}]);
  assert.equal(reordered.matches[0].bookingId,'booking-1');
});

test('confirmation history sync confirms the matching future booking once and assigns a primary slot',async t=>{
  const {db,service}=await fixture(t);
  const row=await service.createBooking(caller,{date:'2026-11-10',time:'12:00',studentName:'Будущий ученик',parentName:'Родитель',phone:'+79990000001',crmUrl:'https://eduson.amocrm.ru/leads/detail/9103',age:10,hasPc:true,parentPresent:true,comment:'',idempotencyKey:'history-sync'});
  const client={request:async()=>({values:[['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? ','Booking ID','Кто подтвердил'],['04.11.2026 12:00:00',row.crmUrl,'Нина Виноградова','12:00:00','','']]})};
  const sync=createConfirmationHistorySynchronizer({db,service,client,enabled:true,now:()=>new Date('2026-11-04T10:00:00Z')});
  assert.deepEqual(await sync.runOnce(),{processed:1,matched:1,ambiguous:0,unmatched:0,skipped:0});
  const confirmed=(await service.listBookings(admin,{id:row.id,scope:'all'}))[0];
  assert.equal(confirmed.confirmationStatus,'confirmed');
  assert.equal(confirmed.assignmentKind,'primary');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM eduson_booking.booking_confirmations')).rows[0].count,1);
  assert.deepEqual(await sync.runOnce(),{processed:0,matched:0,ambiguous:0,unmatched:0,skipped:0});
});

test('confirmation history backfills the confirmer fact for an already confirmed legacy booking',async t=>{
  const {db,service}=await fixture(t);
  const row=await service.createBooking(caller,{date:'2026-11-10',time:'12:00',studentName:'Старый ученик',parentName:'Родитель',phone:'+79990000002',crmUrl:'https://eduson.amocrm.ru/leads/detail/9104',age:10,hasPc:true,parentPresent:true,comment:'',idempotencyKey:'history-backfill'});
  await db.query("UPDATE eduson_booking.bookings SET confirmation_status='confirmed',confirmed_at='2026-11-04T10:00:00Z' WHERE id=$1",[row.id]);
  const client={request:async()=>({values:[['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? ','Booking ID','Кто подтвердил'],['04.11.2026 12:30:00',row.crmUrl,'Нина Виноградова','12:00:00','','']]})};
  const sync=createConfirmationHistorySynchronizer({db,service,client,enabled:true,now:()=>new Date('2026-11-04T10:00:00Z')});
  assert.equal((await sync.runOnce()).matched,1);
  assert.equal((await db.query('SELECT actor_role,source FROM eduson_booking.booking_confirmations WHERE booking_id=$1',[row.id])).rows[0].source,'google-form');
});

test('historical stats retain a confirmation event after the lesson is cancelled',async t=>{
  const {db,service}=await fixture(t);
  const row=await service.createBooking(caller,{date:'2026-11-10',time:'12:00',studentName:'Отменённый ученик',parentName:'Родитель',phone:'+79990000003',crmUrl:'https://eduson.amocrm.ru/leads/detail/9105',age:10,hasPc:true,parentPresent:true,comment:'',idempotencyKey:'history-cancelled-confirmation'});
  await service.cancelBooking(caller,row.id,{reason:'Отмена после подтверждения',version:row.version});
  const client={request:async()=>({values:[['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? ','Booking ID','Кто подтвердил'],['04.11.2026 12:30:00',row.crmUrl,'Нина Виноградова','12:00:00','','']]})};
  const sync=createConfirmationHistorySynchronizer({db,service,client,enabled:true,now:()=>new Date('2026-11-04T10:00:00Z')});
  await sync.runOnce();
  const hour=(await service.stats(admin,{date:'2026-11-10'})).hours.find(item=>item.time==='12:00');
  assert.equal(hour.total,1);
  assert.equal(hour.confirmed,1);
});
