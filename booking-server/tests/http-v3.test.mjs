import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {createApp} from '../server.mjs';

test('HTTP v3 connects schedule, automatic confirmation accrual and separate durable payment reports',async t=>{
  const db=await openDatabase({memory:true});
  const app=await createApp({db,now:()=>new Date('2030-01-01T06:00Z'),enableWorkers:false});
  t.after(async()=>{await app.close();await db.close();});
  const base=`http://127.0.0.1:${await app.listen(0)}`;
  const password='HTTP v3 test password';const users={};
  for(const [key,role] of Object.entries({admin:'admin',anna:'confirmation',sales:'sales',kc:'call_center'})){
    const user=await app.auth.createUser({id:'system',role:'admin'},{email:key+'@v3.test',name:key,role,password});
    const response=await fetch(base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:user.email,password})});
    users[key]={...await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]};
  }
  async function call(key,path,method='GET',input){const s=users[key];const r=await fetch(base+path,{method,headers:{cookie:s.cookie,'content-type':'application/json','x-csrf-token':s.csrfToken},...(input?{body:JSON.stringify(input)}:{})});return{status:r.status,data:await r.json()};}
  const range=await call('sales','/api/schedule/range','PUT',{from:'2030-01-02',to:'2030-01-03',days:[{date:'2030-01-02',version:0,reserveCapacity:1,intervals:[{start:'12:00',end:'14:00'}]}]});
  assert.equal(range.status,200);assert.equal(range.data.days.length,1);
  const slots=await call('kc','/api/slots?from=2030-01-02&to=2030-01-03');
  assert.equal(slots.data.slots.find(x=>x.date==='2030-01-02'&&x.time==='12:00').remaining,2);
  let result=await call('kc','/api/bookings','POST',{date:'2030-01-02',time:'12:00',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',age:10,hasPc:true,parentPresent:true,crmUrl:'https://eduson.amocrm.ru/leads/detail/1',idempotencyKey:'v3-http-booking'});
  assert.equal(result.status,201);let booking=result.data.booking;
  result=await call('anna',`/api/bookings/${booking.id}/confirm`,'POST',{version:booking.version});assert.equal(result.status,200);booking=result.data.booking;
  assert.equal(booking.assignedTo,users.sales.user.id);
  result=await call('anna','/api/compensation?from=2030-01-01&to=2030-01-31');assert.equal(result.status,200);assert.equal(result.data.total,100);
  assert.equal((await call('sales','/api/compensation')).status,403);
  assert.equal((await call('anna','/api/compensation?from=2030-99-01')).status,400);
  result=await call('sales',`/api/bookings/${booking.id}/start`,'POST',{version:booking.version});booking=result.data.booking;
  result=await call('sales',`/api/bookings/${booking.id}/complete`,'POST',{version:booking.version});booking=result.data.booking;
  assert.equal((await call('anna','/api/compensation?from=2030-01-01&to=2030-01-31')).data.total,300);
  assert.equal((await call('sales','/api/payments')).data.payments.length,0);
  const payment={bookingId:booking.id,idempotencyKey:'v3-http-payment',crmUrl:booking.crmUrl,paidAt:'2030-01-02',amountNet:1000,practice:'Scratch',package:'12 уроков',paymentMethod:'Карта',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',age:10,paidLessons:12,bonusLessons:0,format:'Индивидуальный'};
  result=await call('sales','/api/payments','POST',payment);assert.equal(result.status,201);const id=result.data.payment.id;
  assert.equal((await call('sales','/api/payments','POST',payment)).data.payment.id,id);
  assert.equal((await call('admin','/api/payments')).data.payments.length,1);
  assert.equal((await call('anna','/api/payments')).status,403);
  const status=await call('admin','/api/sync');assert.equal(status.status,200);assert.equal(status.data.operations.pending,3);assert.ok(status.data.pending>=3);
});

test('background worker releases a recovered waiting record when a real methodist opens a place',async t=>{
  const db=await openDatabase({memory:true}),now=()=>new Date('2030-01-01T06:00Z');
  const app=await createApp({db,now,enableWorkers:false});t.after(async()=>{await app.close();await db.close();});
  const system={id:'system',role:'admin'},password='Worker v3 test password';
  const admin=await app.auth.createUser(system,{email:'admin@holds.test',name:'Админ',role:'admin',password});
  const sale=await app.auth.createUser(system,{email:'sale@holds.test',name:'Сейл',role:'sales',password});
  const second=await app.auth.createUser(system,{email:'second@holds.test',name:'Второй сейл',role:'sales',password});
  await app.service.saveSchedule(sale,{date:'2030-01-02',intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0});
  const row=await app.service.createBooking(admin,{date:'2030-01-02',time:'12:00',studentName:'Ученик',parentName:'Родитель',phone:'+79990000000',age:10,hasPc:true,parentPresent:true,crmUrl:'https://eduson.amocrm.ru/leads/detail/1',idempotencyKey:'worker-base'});
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by,capacity_hold) SELECT 'worker-held',date,time,starts_at,ends_at,'Восстановленный ученик',parent_name,phone,'https://eduson.amocrm.ru/leads/detail/2',age,has_pc,parent_present,confirmation_due_at,'legacy-import',true FROM eduson_booking.bookings WHERE id=$1`,[row.id]);
  await app.worker();assert.equal((await db.query("SELECT capacity_hold FROM eduson_booking.bookings WHERE id='worker-held'")).rows[0].capacity_hold,true);
  await app.service.saveSchedule(second,{date:'2030-01-02',intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0});
  await app.worker();assert.equal((await db.query("SELECT capacity_hold FROM eduson_booking.bookings WHERE id='worker-held'")).rows[0].capacity_hold,false);
  assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.compensation_events')).rows[0].n,0);
});
