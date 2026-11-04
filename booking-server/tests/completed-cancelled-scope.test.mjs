import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {createApp} from '../server.mjs';
import {hashPassword} from '../auth.mjs';

const clock='2026-11-04T07:00:00Z';
const admin={id:'completed-admin',role:'admin'},caller={id:'completed-caller',role:'call_center'},otherCaller={id:'completed-other-caller',role:'call_center'},confirmation={id:'completed-confirmation',role:'confirmation'},sales={id:'completed-sales',role:'sales'},otherSales={id:'completed-other-sales',role:'sales'};
const ids=rows=>rows.map(row=>row.id).sort();

async function fixture(t,{dataset=false}={}){
 const db=await openDatabase({memory:true});t.after(()=>db.close());
 for(const actor of [admin,caller,otherCaller,confirmation,sales,otherSales])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$3,$4,\'unused\')',[actor.id,actor.id+'@test.local',actor.id,actor.role]);
 const service=new BookingService(db,{now:()=>new Date(clock),random:()=>0});
 const seed=async({id,date='2026-11-10',time='12:00',state='scheduled',assignedTo=sales.id,createdBy=caller.id,historyOnly=false})=>{
  const start=new Date(`${date}T${time}:00+03:00`),end=new Date(+start+3600000);
  await db.query('INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,age,has_pc,parent_present,confirmation_due_at,created_by,state,assigned_to,assignment_kind,confirmation_status,history_only,cancel_reason,cancel_source,cancelled_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,10,true,true,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[id,date,time,start.toISOString(),end.toISOString(),'Synthetic Child','Synthetic Parent','+79990000000',new Date(+start-7200000).toISOString(),createdBy,state,assignedTo,assignedTo?'primary':null,assignedTo?'confirmed':'pending',historyOnly,state==='cancelled'?'Synthetic cancellation':null,state==='cancelled'?'sales':null,state==='cancelled'?clock:null]);
 };
 if(dataset){
  for(const row of[
   {id:'own-completed',state:'completed'},
   {id:'own-cancelled',date:'2026-11-11',state:'cancelled'},
   {id:'own-history',date:'2026-10-10',historyOnly:true},
   {id:'own-active',time:'13:00'},
   {id:'own-progress',time:'14:00',state:'in_progress'},
   {id:'foreign-completed',state:'completed',assignedTo:otherSales.id,createdBy:otherCaller.id},
   {id:'foreign-cancelled',date:'2026-11-11',state:'cancelled',assignedTo:otherSales.id,createdBy:otherCaller.id},
   {id:'foreign-history',date:'2026-10-10',historyOnly:true,assignedTo:otherSales.id,createdBy:otherCaller.id},
   {id:'unassigned-cancelled',date:'2026-11-11',state:'cancelled',assignedTo:null,createdBy:otherCaller.id},
  ])await seed(row);
 }
 return{db,service,seed};
}

test('a salesperson finds an ordinarily cancelled assigned lesson in the completed tab after the real service flow',async t=>{
 const {db,service}=await fixture(t),date='2026-11-10';
 await service.saveSchedule(sales,{date,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0});
 const created=await service.createBooking(caller,{date,time:'12:00',studentName:'Synthetic Child',parentName:'Synthetic Parent',phone:'+79990000000',crmUrl:'https://synthetic.amocrm.ru/leads/detail/1',age:10,hasPc:true,parentPresent:true,idempotencyKey:'completed-cancelled-real-flow'});
 const confirmed=await service.confirmBooking(confirmation,created.id,{version:created.version});assert.equal(confirmed.assignedTo,sales.id);
 const cancelled=await service.cancelBooking(sales,created.id,{version:confirmed.version,reason:'Ученик не пришёл'});assert.equal(cancelled.historyOnly,false);
 const before=(await db.query('SELECT to_jsonb(b) AS value FROM eduson_booking.bookings b ORDER BY id')).rows;
 const auditCount=(await db.query('SELECT count(*)::int n FROM eduson_booking.audit_events')).rows[0].n;
 const completed=await service.listBookings(sales,{scope:'completed'});assert.deepEqual(ids(completed),[created.id]);assert.equal(completed[0].state,'cancelled');assert.equal(completed[0].cancelReason,'Ученик не пришёл');
 assert.equal((await service.listBookings(sales,{scope:'active'})).length,0);assert.deepEqual(ids(await service.listBookings(sales,{scope:'trash'})),[created.id]);
 assert.deepEqual((await db.query('SELECT to_jsonb(b) AS value FROM eduson_booking.bookings b ORDER BY id')).rows,before);
 assert.equal((await db.query('SELECT count(*)::int n FROM eduson_booking.audit_events')).rows[0].n,auditCount);
});

test('completed scope includes completed, cancelled and legacy history while retaining role ownership',async t=>{
 const {service}=await fixture(t,{dataset:true});
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed'})),['own-cancelled','own-completed','own-history']);
 assert.deepEqual(ids(await service.listBookings(otherSales,{scope:'completed'})),['foreign-cancelled','foreign-completed','foreign-history']);
 assert.deepEqual(ids(await service.listBookings(caller,{scope:'completed'})),['own-cancelled','own-completed','own-history']);
 const all=['foreign-cancelled','foreign-completed','foreign-history','own-cancelled','own-completed','own-history','unassigned-cancelled'];
 assert.deepEqual(ids(await service.listBookings(admin,{scope:'completed'})),all);assert.deepEqual(ids(await service.listBookings(confirmation,{scope:'completed'})),all);
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'active'})),['own-active','own-progress']);
 assert.deepEqual(ids(await service.listBookings(admin,{scope:'trash'})),['foreign-cancelled','own-cancelled','unassigned-cancelled']);
});

test('date, range and exact ID constraints apply to every branch of completed scope',async t=>{
 const {service}=await fixture(t,{dataset:true});
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed',date:'2026-11-11'})),['own-cancelled']);
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed',from:'2026-11-10',to:'2026-11-11'})),['own-cancelled','own-completed']);
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed',from:'2026-10-10',to:'2026-10-10'})),['own-history']);
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed',id:'foreign-history'})),[]);
 assert.deepEqual(ids(await service.listBookings(sales,{scope:'completed',id:'own-cancelled',to:'2026-11-10'})),[]);
 assert.deepEqual(ids(await service.listBookings(caller,{scope:'completed',id:'unassigned-cancelled'})),[]);
});

test('wider completed UI scope preserves the previous report analytics eligibility',async t=>{
 const {db,service}=await fixture(t,{dataset:true});
 for(const id of ['own-completed','own-cancelled','own-history'])await db.query('INSERT INTO eduson_booking.reports(booking_id,payload)VALUES($1,$2)',[id,JSON.stringify({practice:'Synthetic practice',recordingUrl:'https://example.invalid/recording'})]);
 const reports=await service.getAnalyticsLessons(admin);assert.deepEqual(reports.map(row=>row.bookingId).sort(),['own-completed','own-history']);
 assert.ok(reports.every(row=>row.recordingUrl==='https://example.invalid/recording'));
 const cancellations=await service.getAnalyticsCancellations(admin);assert.deepEqual(cancellations.map(row=>row.bookingId).sort(),['foreign-cancelled','own-cancelled','unassigned-cancelled']);
});

test('authenticated booking HTTP reads return an owner cancellation under completed scope with date filters',async t=>{
 const f=await fixture(t,{dataset:true});
 const password='Synthetic completed scope password 2030';await f.db.query('UPDATE eduson_booking.users SET password_hash=$1 WHERE id=$2',[await hashPassword(password),sales.id]);
 const app=await createApp({db:f.db,now:()=>new Date(clock),enableWorkers:false});t.after(()=>app.close());const base=`http://127.0.0.1:${await app.listen(0)}`;
 const login=await fetch(base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:sales.id+'@test.local',password})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const read=async query=>{const response=await fetch(base+'/api/bookings?'+query,{headers:{cookie}});assert.equal(response.status,200);return(await response.json()).bookings;};
 assert.deepEqual(ids(await read('scope=completed&from=2026-11-11&to=2026-11-11')),['own-cancelled']);
 assert.deepEqual(ids(await read('scope=completed&id=foreign-history')),[]);
 assert.equal((await fetch(base+'/api/bookings?scope=completed')).status,401);
});
