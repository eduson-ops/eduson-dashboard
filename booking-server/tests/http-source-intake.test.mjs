import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {createApp} from '../server.mjs';

const token='SyntheticIntakeBearer0123456789OnlyForTests';
const input=()=>({accountId:'synthetic-account',recordId:'source-1',revision:'1',event:'upsert',observedAt:'2030-01-01T06:00:00Z',record:{date:'2030-01-02',time:'12:00',durationMinutes:60,studentName:'Проверка источника',parentName:'',phone:'+79990000000',age:10,hasPc:true,parentPresent:true},raw:{synthetic:true}});
async function fixture(t,{enabled=true}={}){
  const db=await openDatabase({memory:true});
  const app=await createApp({db,now:()=>new Date('2030-01-01T06:00:00Z'),enableWorkers:false,intakeOptions:{config:{enabled,token,accountIds:['synthetic-account'],staffMap:{'synthetic-account':{}}}}});
  t.after(async()=>{await app.close();await db.close();});
  const base=`http://127.0.0.1:${await app.listen(0)}`;
  const request=async(body,{bearer=token,headers={},method='POST'}={})=>{
    const r=await fetch(base+'/api/integrations/rubitime/observations',{method,headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
    return{status:r.status,body:await r.json()};
  };
  return{db,app,base,request};
}

test('bearer intake commits one durable receipt before processing, survives duplicate transport and publishes through the worker',async t=>{
  const f=await fixture(t);
  for(const bearer of ['',token+'wrong'])assert.equal((await f.request(input(),{bearer})).status,401);
  let response=await f.request({...input(),accountId:'another-account'});assert.equal(response.status,403);
  response=await f.request(input());assert.equal(response.status,202);assert.equal(response.body.accepted,true);assert.equal(response.body.observation.status,'pending');assert.equal(response.body.observation.revision,'1');
  const observationId=response.body.observation.observationId;
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,0);
  response=await f.request(input());assert.equal(response.status,202);assert.equal(response.body.observation.observationId,observationId);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.source_intake_observations')).rows[0].n,1);
  await f.app.worker();
  const [booking]=await f.app.service.listBookings({id:'system',role:'admin'},{scope:'all'});
  assert.equal(booking.studentName,'Проверка источника');assert.equal(booking.parentName,'');assert.equal(booking.confirmationStatus,'pending');assert.equal(booking.assignedTo,null);assert.equal(booking.capacityHold,true);
  response=await f.request(input());assert.equal(response.body.observation.status,'applied');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.bookings')).rows[0].n,1);
  assert.equal((await f.request({...input(),revision:'2',record:{...input().record,age:null}})).status,202);
  await f.app.worker();assert.equal((await f.app.sourceIntake.status()).issues,1);
});

test('source administration requires a real admin session and never exposes bearer or raw input',async t=>{
  const f=await fixture(t),password='Source private test password 2030',sessions={};
  for(const role of ['admin','sales']){
    const user=await f.app.auth.createUser({id:'system',role:'admin'},{name:role,email:role+'@source.test',role,password});
    const r=await fetch(f.base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:user.email,password})});
    sessions[role]={...(await r.json()),cookie:r.headers.get('set-cookie').split(';')[0]};
  }
  const request=async(path,role)=>{const r=await fetch(f.base+path,{headers:role?{cookie:sessions[role].cookie}:{authorization:'Bearer '+token}});return{status:r.status,body:await r.json()};};
  assert.equal((await request('/api/integrations/rubitime/status')).status,401);
  assert.equal((await request('/api/integrations/rubitime/status','sales')).status,403);
  assert.equal((await request('/api/integrations/rubitime/issues','sales')).status,403);
  const invalid={...input(),record:{...input().record,staffId:'unmapped'},raw:{secretMarker:'RAW-MUST-STAY-PRIVATE'}};
  assert.equal((await f.request(invalid)).status,202);await f.app.worker();
  const status=await request('/api/integrations/rubitime/status','admin');assert.equal(status.status,200);assert.equal(status.body.issues,1);assert.equal(status.body.enabled,true);assert.ok(status.body.lastReceivedAt);
  const issues=await request('/api/integrations/rubitime/issues','admin');assert.equal(issues.status,200);assert.equal(issues.body.issues.length,1);assert.equal(issues.body.issues[0].code,'UNKNOWN_STAFF_MAPPING');assert.equal(issues.body.issues[0].summary.studentName,'Проверка источника');
  assert.doesNotMatch(JSON.stringify({status,issues}),new RegExp(token+'|RAW-MUST-STAY-PRIVATE'));
  const bootstrap=await request('/api/bootstrap','admin');assert.equal(bootstrap.body.sourceIntake.enabled,true);
  assert.equal((await request('/api/bootstrap','sales')).body.sourceIntake,undefined);
  const id=issues.body.issues[0].observation_id;
  let retry=await fetch(f.base+`/api/integrations/rubitime/issues/${id}/retry`,{method:'POST',headers:{cookie:sessions.admin.cookie,'content-type':'application/json'},body:'{}'});assert.equal(retry.status,403);
  retry=await fetch(f.base+`/api/integrations/rubitime/issues/${id}/retry`,{method:'POST',headers:{cookie:sessions.admin.cookie,'content-type':'application/json','x-csrf-token':sessions.admin.csrfToken},body:'{}'});assert.equal(retry.status,200);
});

test('disabled intake has no public receiver, while enabled intake bounds payload and validates before journaling',async t=>{
  const off=await fixture(t,{enabled:false});assert.equal((await off.request(input())).status,404);
  const f=await fixture(t);let response=await f.request({...input(),revision:'invalid'});assert.equal(response.status,400);assert.equal(response.body.code,'INVALID_REVISION');
  response=await f.request({...input(),raw:{tooLarge:'a'.repeat(270000)}});assert.equal(response.status,413);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.source_intake_observations')).rows[0].n,0);
});
