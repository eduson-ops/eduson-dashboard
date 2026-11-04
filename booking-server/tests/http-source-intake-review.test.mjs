import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';
import {createApp} from '../server.mjs';

const token='SyntheticReviewBearer0123456789OnlyForTests';
const intakeConfig={enabled:true,token,accountIds:['review-account'],staffMap:{}};
const options=(db,now=()=>new Date('2030-01-01T06:00:00Z'))=>({db,now,enableWorkers:false,intakeOptions:{config:intakeConfig}});
const input=()=>({accountId:'review-account',recordId:'review-source-1',revision:'1',event:'upsert',observedAt:'2030-01-01T06:00:00Z',record:{date:'2030-01-02',time:'12:00',durationMinutes:60,studentName:'Synthetic receiver review',parentName:'',phone:'+79990000000',age:10,hasPc:true,parentPresent:true},raw:{marker:'PRIVATE-RAW-SYNTHETIC'}});
async function fixture(t){
  let now=new Date('2030-01-01T06:00:00Z');const db=await openDatabase({memory:true}),app=await createApp(options(db,()=>now));
  t.after(async()=>{await app.close();await db.close();});
  return{db,app,base:`http://127.0.0.1:${await app.listen(0)}`,now:()=>now,setNow:value=>{now=new Date(value);}};
}
const send=async(base,{authorization='Bearer '+token,cookie,csrfToken,query='',payload=input()}={})=>{
  const response=await fetch(base+'/api/integrations/rubitime/observations'+query,{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{}),...(cookie?{cookie}:{}),...(csrfToken?{'x-csrf-token':csrfToken}:{})},body:JSON.stringify(payload)});
  return{status:response.status,body:await response.json()};
};
const count=async(db,table)=>(await db.query(`SELECT count(*)::int n FROM eduson_booking.${table}`)).rows[0].n;

test('admin cookies, CSRF and query parameters cannot replace the receiver bearer credential',async t=>{
  const f=await fixture(t),password='Synthetic review login password 2030';
  await f.app.auth.createUser({id:'system',role:'admin'},{name:'Synthetic admin',email:'receiver-review@example.invalid',role:'admin',password});
  const response=await fetch(f.base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'receiver-review@example.invalid',password})});
  assert.equal(response.status,200);const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  for(const credential of [{authorization:'',cookie,csrfToken:session.csrfToken},{authorization:'Bearer '+token+'wrong',cookie,csrfToken:session.csrfToken},{authorization:'',query:'?token='+token}])assert.equal((await send(f.base,credential)).status,401);
  assert.equal(await count(f.db,'source_intake_observations'),0);
  await assert.rejects(createApp({...options(f.db),intakeOptions:{config:{...intakeConfig,token:'PRIVATE-MALFORMED-SECRET'}}}),error=>error.message==='RUBITIME_CONFIGURATION_INVALID'&&!error.message.includes('PRIVATE-MALFORMED-SECRET'));
  const accepted=await send(f.base,{cookie:'unrelated=invalid'});assert.equal(accepted.status,202);assert.equal(accepted.body.observation.status,'pending');
});

test('HTTP receipts survive restart and queued rescheduling precedes expiry without duplicate bookings',async t=>{
  const f=await fixture(t);const receipt=await send(f.base);assert.equal(receipt.status,202);assert.equal(await count(f.db,'bookings'),0);
  await f.app.close();const restarted=await createApp(options(f.db,f.now));
  try{
    const base=`http://127.0.0.1:${await restarted.listen(0)}`;
    const repeated=await send(base);assert.equal(repeated.status,202);assert.equal(repeated.body.observation.observationId,receipt.body.observation.observationId);assert.equal(repeated.body.observation.duplicate,true);
    assert.equal(await count(f.db,'source_intake_observations'),1);assert.equal(await count(f.db,'bookings'),0);
    await restarted.worker();await restarted.worker();assert.equal(await count(f.db,'bookings'),1);
    const final=await send(base);assert.equal(final.body.observation.status,'applied');assert.equal(final.body.observation.observationId,receipt.body.observation.observationId);
    assert.equal((await f.db.query('SELECT raw FROM eduson_booking.source_intake_observations')).rows[0].raw.marker,'PRIVATE-RAW-SYNTHETIC');
    assert.doesNotMatch(JSON.stringify(final.body),/PRIVATE-RAW-SYNTHETIC|Synthetic receiver review/);
    f.setNow('2030-01-02T10:01:00Z');
    const moved=await send(base,{payload:{...input(),revision:'2',observedAt:f.now().toISOString(),record:{...input().record,date:'2030-01-03'}}});assert.equal(moved.status,202);
    await restarted.worker();const [booking]=await restarted.service.listBookings({id:'system',role:'admin'},{scope:'all'});
    assert.equal(booking.date,'2030-01-03');assert.equal(booking.state,'scheduled');assert.equal(await count(f.db,'bookings'),1);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM eduson_booking.audit_events WHERE action='expired'")).rows[0].n,0);
  }finally{await restarted.close();}
});

test('a receipt storage failure returns a redacted 500 without acknowledgement or partial head and can retry safely',async t=>{
  const f=await fixture(t);
  await f.db.query("CREATE FUNCTION eduson_booking.fail_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-RECEIPT-STORAGE-DETAIL'; END $$");
  await f.db.query('CREATE TRIGGER fail_review_receipt BEFORE INSERT ON eduson_booking.source_intake_observations FOR EACH ROW EXECUTE FUNCTION eduson_booking.fail_review_receipt()');
  const failed=await send(f.base);assert.equal(failed.status,500);assert.equal(failed.body.accepted,undefined);assert.doesNotMatch(JSON.stringify(failed.body),/PRIVATE-RECEIPT-STORAGE-DETAIL|PRIVATE-RAW-SYNTHETIC|SyntheticReviewBearer/);
  assert.equal(await count(f.db,'source_intake_records'),0);assert.equal(await count(f.db,'source_intake_observations'),0);assert.equal(await count(f.db,'bookings'),0);
  await f.db.query('DROP TRIGGER fail_review_receipt ON eduson_booking.source_intake_observations');
  const accepted=await send(f.base);assert.equal(accepted.status,202);assert.equal(await count(f.db,'source_intake_observations'),1);
  await f.app.worker();assert.equal(await count(f.db,'bookings'),1);
});
