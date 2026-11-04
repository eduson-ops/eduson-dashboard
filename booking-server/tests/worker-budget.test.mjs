import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {createApp} from '../server.mjs';

async function fixture(t,{operations=true}={}){
  const db=await openDatabase({memory:true}),now=()=>new Date('2030-01-01T06:00Z');
  const app=await createApp({db,now,enableWorkers:false,syncOptions:{enabled:true,serviceAccountPath:'missing-synthetic-account.json',spreadsheetId:'synthetic-main',enrollmentSpreadsheetId:'synthetic-enrollment',fetchImpl:async()=>assert.fail('No real provider request is allowed')}});
  t.after(async()=>{await app.close();await db.close();});
  for(let i=0;i<8;i++){
    const id='budget-'+i;
    await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by)VALUES($1,'2030-01-02','12:00','2030-01-02T09:00Z','2030-01-02T10:00Z','Синтетический ученик','Родитель','+79990000000','',10,true,true,'2030-01-02T07:00Z','system')`,[id]);
    await db.query("INSERT INTO eduson_booking.sync_jobs(id,booking_id,kind,version)VALUES($1,$1,'booking',1)",[id]);
    if(operations)await db.query("INSERT INTO eduson_booking.operation_jobs(id,entity_id,kind,version)VALUES($1,$1,'payment',1)",[id]);
  }
  const attempts=async()=>({bookings:(await db.query('SELECT sum(attempts)::int n FROM eduson_booking.sync_jobs')).rows[0].n||0,operations:(await db.query('SELECT sum(attempts)::int n FROM eduson_booking.operation_jobs')).rows[0].n||0});
  return{app,attempts};
}

test('a provider failure storm uses one combined four-job budget and advances both durable queues',async t=>{
  const f=await fixture(t);await f.app.worker();assert.deepEqual(await f.attempts(),{bookings:2,operations:2});
  await f.app.worker();assert.deepEqual(await f.attempts(),{bookings:4,operations:4});
});

test('an empty operational queue leaves the entire four-job budget available for booking reports',async t=>{
  const f=await fixture(t,{operations:false});await f.app.worker();assert.deepEqual(await f.attempts(),{bookings:4,operations:0});
});
