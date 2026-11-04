import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.mjs';

const slack=await import('../slack-notifications.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const TEAM='TTEST',CHANNEL='CSUMMARY',A='USERRA',B='USERRB',C='USERRC';
const config={enabled:true,token:'SYNTHETIC-SECRET',teamId:TEAM,summaryChannelId:CHANNEL,baseUrl:'https://booking.example.test/',staffMap:{'sales-a':A,'sales-b':B,'sales-c':C}};
function provider(){
  const calls=[],posts=[],messages=new Map(),failures=[],hooks=new Map();let counter=0,team=TEAM,held=null;
  const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
  const fetchImpl=async(url,options={})=>{
    const address=new URL(url),method=address.pathname.split('/').at(-1),body=options.method==='GET'?Object.fromEntries(address.searchParams):JSON.parse(options.body||'{}');calls.push({method,body,httpMethod:options.method});
    if(hooks.has(method)){const hook=hooks.get(method);hooks.delete(method);await hook();}
    const failure=failures.findIndex(f=>f.method===method),mode=failure<0?null:failures.splice(failure,1)[0].mode;
    if(mode==='429')return response({ok:false,error:'ratelimited'},429,{'retry-after':'60'});
    if(mode==='rejected')return response({ok:false,error:'not_in_channel'});
    if(mode==='500')return response({ok:false,error:'internal_error'},500);
    if(mode==='network')throw Error('TOKEN SYNTHETIC-SECRET customer@example.test');
    if(method==='auth.test')return response({ok:true,team_id:team,user_id:'UBOT',bot_id:'BBOT'});
    if(method==='users.info')return response({ok:true,user:{id:body.user,team_id:TEAM,deleted:false,is_bot:false}});
    if(method==='conversations.info')return response({ok:true,channel:{id:body.channel,is_member:true,is_archived:false}});
    if(method==='conversations.open')return response({ok:true,channel:{id:'D'+body.users.slice(1),user:body.users,is_im:true}});
    if(method==='chat.postMessage'){
      const ts='1900000000.'+String(++counter).padStart(6,'0');posts.push({...body,ts});messages.set(body.channel+':'+ts,body.text);
      if(held){const hook=held;held=null;await hook();}
      if(mode==='lost')throw Error('accepted then lost TOKEN SYNTHETIC-SECRET customer@example.test');
      if(mode==='invalid')return response({ok:true,channel:'CFOREIGN',ts});
      return response({ok:true,channel:body.channel,ts});
    }
    if(method==='chat.update'){
      assert.ok(messages.has(body.channel+':'+body.ts));messages.set(body.channel+':'+body.ts,body.text);
      return response({ok:true,channel:body.channel,ts:body.ts});
    }
    assert.fail('Unexpected Slack API '+method);
  };
  return{calls,posts,messages,fetchImpl,fail:(method,mode)=>failures.push({method,mode}),setTeam:value=>{team=value;},holdNextPost:hook=>{held=hook;},beforeReply:(method,hook)=>hooks.set(method,hook)};
}
async function fixture(t,extra={}){
  const db=await openDatabase({memory:true});t.after(()=>db.close());await slack.initializeSlackSchema(db);
  for(const [id,role]of [['admin','admin'],['sales-a','sales'],['sales-b','sales'],['sales-c','sales'],['sales-unmapped','sales']])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$3,$4,$5)',[id,id+'@test.local',id,role,'unused']);
  let now=new Date('2030-01-02T05:00:00Z');const g=provider();let figures={hours:[{time:'10:00',managers:2,capacity:4,managerList:[{id:'sales-a',name:'Synthetic A'},{id:'sales-b',name:'Synthetic B'}],allocations:[]}]};
  const options={db,config:{...config,...extra},now:()=>now,fetchImpl:g.fetchImpl,getStats:async()=>figures};
  const worker=slack.createSlackNotifications(options);
  async function booking(id='b1',values={}){
    const date=values.date||'2030-01-02',time=values.time||'10:00',start=new Date(`${date}T${time}:00+03:00`),end=values.endsAt||new Date(+start+3600000);
    await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,created_by,confirmation_status,assigned_to,assignment_kind,state,completed_at,is_test,history_only,version)
      VALUES($1,$2,$3,$4,$5,'Synthetic <@everyone>','','','',10,true,true,$6,'admin',$7,$8,$9,$10,$11,$12,$13,$14)`,[id,date,time,start,end,new Date(+start-7200000),values.confirmationStatus||'confirmed',values.managerId===null?null:values.managerId||'sales-a',values.managerId===null?null:values.kind||'primary',values.state||'scheduled',values.completedAt||null,!!values.isTest,!!values.historyOnly,values.version||1]);
  }
  async function event(id='e1',bookingId='b1',version=1,action='confirmed',payload={}){await db.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,$4,$5,$6,$7)',[id,bookingId,'admin','admin',action,JSON.stringify({version,managerId:'sales-a',kind:'primary',...payload}),now]);}
  return{db,g,worker,options,booking,event,now:()=>now,setNow:value=>{now=new Date(value);},advance:ms=>{now=new Date(+now+ms);},setFigures:value=>{figures=value;},baseline:()=>worker.runOnce()};
}

test('Slack exports exist',()=>{for(const name of ['initializeSlackSchema','createSlackNotifications'])assert.equal(typeof slack[name],'function',name);});

test('an in-progress lesson past its scheduled end reminds the manager to record the outcome without assuming attendance',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('unfinished',{state:'in_progress'});
  f.setNow('2030-01-02T08:16:00Z');await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.match(f.g.posts[0].text,/статус|итог/);assert.doesNotMatch(f.g.posts[0].text,/Урок завершён/);
  assert.equal((await f.db.query("SELECT state FROM eduson_booking.bookings WHERE id='unfinished'")).rows[0].state,'in_progress');
});

test('an assigned confirmed lesson never started also requests its actual outcome once, not a fabricated report',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('not-started');f.setNow('2030-01-02T08:16:00Z');
  await f.worker.runOnce();f.advance(3600000);await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.match(f.g.posts[0].text,/статус|итог/);
  assert.equal((await f.db.query("SELECT state FROM eduson_booking.bookings WHERE id='not-started'")).rows[0].state,'scheduled');
});

test('overdue unfinished lessons from before activation and unconfirmed rows do not trigger old report reminders',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('historic',{date:'2030-01-01',state:'in_progress'});await f.booking('pending',{confirmationStatus:'pending'});
  f.setNow('2030-01-02T08:16:00Z');await f.worker.runOnce();assert.equal(f.g.posts.length,0);
});

test('report reminder defers when completion during preflight moves its deadline instead of cancelling it forever',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('late-completion',{state:'in_progress'});f.setNow('2030-01-02T08:16:00Z');
  f.g.beforeReply('users.info',()=>f.db.query("UPDATE eduson_booking.bookings SET state='completed',completed_at=$1 WHERE id='late-completion'",[f.now()]));
  await f.worker.runOnce();assert.equal(f.g.posts.length,0);
  const job=(await f.db.query("SELECT status,retry_at,attempts FROM eduson_booking.slack_notification_jobs WHERE booking_id='late-completion' AND kind='report'")).rows[0];
  assert.equal(job.status,'pending');assert.equal(job.attempts,0);assert.equal(new Date(job.retry_at).toISOString(),'2030-01-02T08:31:00.000Z');
  f.setNow('2030-01-02T08:30:59Z');await f.worker.runOnce();assert.equal(f.g.posts.length,0);
  f.advance(1000);await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.posts[0].channel,'DSERRA');assert.match(f.g.posts[0].text,/Урок завершён/);
  await f.worker.runOnce();assert.equal(f.g.posts.length,1);
});

test('report reminder returns to A after an A-B-A transfer cancels its first preflight',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('returned-report',{state:'in_progress'});f.setNow('2030-01-02T08:16:00Z');
  f.g.beforeReply('users.info',()=>f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-b',version=2 WHERE id='returned-report'"));
  await f.worker.runOnce();assert.equal(f.g.posts.length,0);
  assert.equal((await f.db.query("SELECT status FROM eduson_booking.slack_notification_jobs WHERE booking_id='returned-report' AND manager_id='sales-a'")).rows[0].status,'cancelled');
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-a',version=3 WHERE id='returned-report'");f.advance(1001);
  await f.worker.runOnce();assert.equal(f.g.posts.length,1);assert.equal(f.g.posts[0].channel,'DSERRA');
  await slack.createSlackNotifications(f.options).runOnce();assert.equal(f.g.posts.length,1);
});

for(const receiptStatus of ['known','uncertain'])test(`report reminder with a ${receiptStatus} receipt never replays after the owner returns`,async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('receipt-return',{state:'in_progress'});f.setNow('2030-01-02T08:16:00Z');
  if(receiptStatus==='uncertain')f.g.fail('chat.postMessage','lost');
  await f.worker.runOnce();assert.equal(f.g.posts.length,1);
  const original=(await f.db.query("SELECT id,logical_key FROM eduson_booking.slack_notification_jobs WHERE booking_id='receipt-return' AND manager_id='sales-a'")).rows[0];
  assert.equal((await f.db.query('SELECT status FROM eduson_booking.slack_notification_messages WHERE logical_key=$1',[original.logical_key])).rows[0].status,receiptStatus);
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-b',version=2 WHERE id='receipt-return'");f.advance(1001);await f.worker.runOnce();
  // Recovery must respect delivery evidence even if a job was subsequently cancelled.
  await f.db.query("UPDATE eduson_booking.slack_notification_jobs SET status='cancelled' WHERE id=$1",[original.id]);
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-a',version=3 WHERE id='receipt-return'");f.advance(1001);
  await f.worker.runOnce();await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.posts.filter(post=>post.channel==='DSERRA').length,1);
  assert.equal((await f.db.query('SELECT status FROM eduson_booking.slack_notification_messages WHERE logical_key=$1',[original.logical_key])).rows[0].status,receiptStatus);
});

test('disabled mode does not establish a baseline, claim jobs or contact Slack',async t=>{
  const f=await fixture(t,{enabled:false,token:''});await f.booking();await f.event();
  assert.equal((await f.worker.runOnce()).processed,false);assert.equal(f.g.calls.length,0);assert.equal((await f.worker.status()).enabled,false);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.slack_notification_state')).rows[0].n,0);
  assert.equal((await f.worker.status()).lastError,null);
});

test('activation baselines existing assignments and completed records without a historical mass ping',async t=>{
  const f=await fixture(t);await f.booking();await f.event();await f.booking('old-done',{state:'completed',completedAt:f.now(),time:'11:00'});
  await f.baseline();f.advance(20*60_000);await f.worker.runOnce();
  assert.equal(f.g.posts.length,0);assert.equal((await f.worker.status()).pending,0);assert.ok((await f.worker.status()).activationAt);
  const replacement=slack.createSlackNotifications(f.options);await replacement.runOnce();assert.equal(f.g.posts.length,0);
});

test('a new assignment at the same timestamp as activation sends once to the verified personal DM',async t=>{
  const f=await fixture(t);await f.booking();await f.event('old');await f.baseline();await f.event('new');
  assert.equal((await f.worker.runOnce()).status,'sent');await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.posts[0].channel,'DSERRA');assert.match(f.g.posts[0].text,/10:00/);assert.match(f.g.posts[0].text,/МСК/);assert.doesNotMatch(f.g.posts[0].text,/<@everyone>/);
  assert.equal(f.g.calls.filter(c=>c.method==='conversations.open').length,1);assert.equal((await f.worker.status()).sent,1);
});

test('missing staff mapping remains visible and a later explicit mapping releases the same job',async t=>{
  const f=await fixture(t);await f.booking('b1',{managerId:'sales-unmapped'});await f.baseline();await f.event('e1','b1',1,'confirmed',{managerId:'sales-unmapped'});await f.worker.runOnce();
  let status=await f.worker.status();assert.equal(status.blockedMapping,1);assert.deepEqual(status.unmappedManagers.map(x=>x.managerId),['sales-unmapped']);assert.equal(f.g.posts.length,0);
  const worker=slack.createSlackNotifications({...f.options,config:{...config,staffMap:{...config.staffMap,'sales-unmapped':'USERUNMAPPED'}}});await worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.posts[0].channel,'DSERUNMAPPED');assert.equal((await worker.status()).blockedMapping,0);
});

test('reassignment supersedes an unsent old assignment and targets the current salesperson',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event('first');
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-b',version=2 WHERE id='b1'");await f.event('transfer','b1',2,'assigned',{managerId:'sales-b',previous:{managerId:'sales-a',kind:'primary'}});
  for(let i=0;i<4;i++)await f.worker.runOnce();
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRB').length,1);assert.equal(f.g.posts.filter(p=>p.channel==='DSERRA'&&/вам назначен/i.test(p.text)).length,0);assert.match(f.g.posts.find(p=>p.channel==='DSERRA').text,/передан/i);
});

test('saving an unchanged assignment neither duplicates nor suppresses the original assignment notice',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event('confirmed');
  await f.db.query("UPDATE eduson_booking.bookings SET version=2 WHERE id='b1'");await f.event('same','b1',2,'assigned',{previous:{managerId:'sales-a',kind:'primary'}});
  await f.worker.runOnce();assert.equal(f.g.posts.length,1);
  await f.db.query("UPDATE eduson_booking.bookings SET version=3 WHERE id='b1'");await f.event('same-again','b1',3,'assigned',{previous:{managerId:'sales-a',kind:'primary'}});f.advance(1000);await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);
});

test('rapid A to B to C reassignment releases A even when the intermediate assignment is coalesced',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event('first');await f.worker.runOnce();
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-b',version=2 WHERE id='b1'");await f.event('to-b','b1',2,'assigned',{managerId:'sales-b',previous:{managerId:'sales-a',kind:'primary'}});
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-c',version=3 WHERE id='b1'");await f.event('to-c','b1',3,'assigned',{managerId:'sales-c',previous:{managerId:'sales-b',kind:'primary'}});
  f.advance(1000);for(let i=0;i<5;i++)await f.worker.runOnce();
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRA'&&/передан/i.test(p.text)).length,1);
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRC'&&/вам назначен/i.test(p.text)).length,1);
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRB'&&/вам назначен/i.test(p.text)).length,0);
});

test('a lesson returned to A cancels the stale release notice for A',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event('first');await f.worker.runOnce();
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-b',version=2 WHERE id='b1'");await f.event('away','b1',2,'assigned',{managerId:'sales-b',previous:{managerId:'sales-a',kind:'primary'}});
  await f.worker.runOnce();
  await f.db.query("UPDATE eduson_booking.bookings SET assigned_to='sales-a',version=3 WHERE id='b1'");await f.event('returned','b1',3,'assigned',{managerId:'sales-a',previous:{managerId:'sales-b',kind:'primary'}});
  f.advance(1001);for(let i=0;i<5;i++)await f.worker.runOnce();
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRA'&&/передан/i.test(p.text)).length,0);
});

test('report reminder waits until max(end,complete)+15 minutes and is sent once',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();
  await f.db.query("UPDATE eduson_booking.bookings SET state='completed',completed_at=$1 WHERE id='b1'",[f.now()]);
  await f.worker.runOnce();assert.equal(f.g.posts.length,0);
  f.setNow('2030-01-02T08:14:59Z');await f.worker.runOnce();assert.equal(f.g.posts.filter(p=>p.channel.startsWith('D')).length,0);
  f.advance(1000);await f.worker.runOnce();await f.worker.runOnce();
  assert.equal(f.g.posts.filter(p=>p.channel==='DSERRA').length,1);assert.match(f.g.posts.find(p=>p.channel==='DSERRA').text,/отчёт/i);
});

test('saved reports, cancelled lessons, tests, archives and lessons older than three days never get report pings',async t=>{
  const f=await fixture(t);await f.baseline();
  for(const [id,values]of [['saved',{}],['cancelled',{state:'cancelled'}],['test',{isTest:true,managerId:'sales-b'}],['history',{historyOnly:true,managerId:null}],['old',{date:'2029-12-28'}]])await f.booking(id,{state:'completed',completedAt:f.now(),...values});
  await f.db.query("INSERT INTO eduson_booking.reports(booking_id,payload)VALUES('saved','{}')");
  f.setNow('2030-01-02T08:16Z');for(let i=0;i<5;i++)await f.worker.runOnce();assert.equal(f.g.posts.filter(p=>p.channel.startsWith('D')).length,0);
});

test('a report saved while a reminder is retrying cancels the reminder before any send',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.db.query("UPDATE eduson_booking.bookings SET state='completed',completed_at=$1 WHERE id='b1'",[f.now()]);
  f.setNow('2030-01-02T08:16Z');f.g.fail('chat.postMessage','429');await f.worker.runOnce();
  await f.db.query("INSERT INTO eduson_booking.reports(booking_id,payload)VALUES('b1','{}')");f.advance(61000);await f.worker.runOnce();assert.equal(f.g.posts.length,0);assert.equal((await f.worker.status()).cancelled,1);
});

test('hour summary posts at T-15 and updates the same receipt every five minutes without duplicates',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('normal');await f.booking('test',{isTest:true,managerId:'sales-b'});await f.booking('history',{historyOnly:true,managerId:null});
  f.setNow('2030-01-02T06:44:59Z');await f.worker.runOnce();assert.equal(f.g.posts.length,0);
  f.advance(1000);await f.worker.runOnce();assert.equal(f.g.posts.length,1);assert.equal(f.g.posts[0].channel,CHANNEL);assert.match(f.g.posts[0].text,/Записей: \*1\*/);assert.match(f.g.posts[0].text,/МИМК: \*2\*/);
  await f.worker.runOnce();assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,0);
  f.advance(5*60_000);await f.worker.runOnce();assert.equal(f.g.posts.length,1);assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,1);assert.equal(f.g.calls.find(c=>c.method==='chat.update').body.ts,f.g.posts[0].ts);
});

test('an accepted post with a lost response is quarantined and never sent again on retry or restart',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();f.g.fail('chat.postMessage','lost');await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal((await f.worker.status()).uncertain,1);f.advance(10*60_000);await f.worker.runOnce();await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.posts.length,1);assert.doesNotMatch(JSON.stringify(await f.worker.status()),/SYNTHETIC-SECRET|customer@example/);
});

test('a database failure after an accepted post quarantines the delivery across retry and restart',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();
  await f.db.query(`CREATE FUNCTION eduson_booking.fail_slack_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.ts IS NOT NULL THEN RAISE EXCEPTION 'synthetic receipt persistence failure'; END IF; RETURN NEW; END$$`);
  await f.db.query('CREATE TRIGGER fail_slack_receipt BEFORE UPDATE ON eduson_booking.slack_notification_messages FOR EACH ROW EXECUTE FUNCTION eduson_booking.fail_slack_receipt()');
  await f.worker.runOnce();f.advance(6000);await f.worker.runOnce();await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.posts.length,1);assert.equal((await f.worker.status()).uncertain,1);
  const job=(await f.db.query('SELECT status,attempts,last_error FROM eduson_booking.slack_notification_jobs')).rows[0];
  assert.equal(job.status,'uncertain');assert.equal(job.attempts,1);assert.equal(job.last_error,'SLACK_DELIVERY_UNCERTAIN');
  const receipt=(await f.db.query('SELECT status,ts FROM eduson_booking.slack_notification_messages')).rows[0];assert.equal(receipt.status,'uncertain');assert.equal(receipt.ts,null);
});

test('a database failure after chat.update keeps the known receipt and retries without a new post',async t=>{
  const f=await fixture(t);await f.baseline();f.setNow('2030-01-02T06:45Z');await f.worker.runOnce();
  await f.db.query(`CREATE FUNCTION eduson_booking.fail_slack_update_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic update receipt persistence failure'; END$$`);
  await f.db.query('CREATE TRIGGER fail_slack_update_receipt BEFORE UPDATE ON eduson_booking.slack_notification_messages FOR EACH ROW EXECUTE FUNCTION eduson_booking.fail_slack_update_receipt()');
  f.advance(5*60_000);await f.worker.runOnce();await f.db.query('DROP TRIGGER fail_slack_update_receipt ON eduson_booking.slack_notification_messages');f.advance(6000);await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,2);assert.equal((await f.worker.status()).uncertain,0);
  assert.equal((await f.db.query('SELECT status,ts FROM eduson_booking.slack_notification_messages')).rows[0].status,'known');
});

test('an uncertain summary post cannot produce another post in a later five-minute bucket',async t=>{
  const f=await fixture(t);await f.baseline();f.setNow('2030-01-02T06:45Z');f.g.fail('chat.postMessage','lost');await f.worker.runOnce();f.advance(5*60_000);await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal((await f.worker.status()).uncertain,1);
});

test('429 honors Retry-After while an explicit rejection uses bounded safe retries',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();f.g.fail('chat.postMessage','429');await f.worker.runOnce();
  f.advance(59000);await f.worker.runOnce();assert.equal(f.g.posts.length,0);f.advance(1000);await f.worker.runOnce();assert.equal(f.g.posts.length,1);
  await f.booking('b2',{date:'2030-01-03'});await f.event('e2','b2');for(let i=0;i<10;i++){f.g.fail('chat.postMessage','rejected');await f.worker.runOnce();f.advance(3600000);}
  const job=(await f.db.query("SELECT attempts,status,last_error FROM eduson_booking.slack_notification_jobs WHERE booking_id='b2'")).rows[0];assert.equal(job.attempts,8);assert.equal(job.status,'error');assert.equal(job.last_error,'SLACK_REJECTED');
});

test('a 429 method cooldown blocks other jobs and persists across worker restart without spending attempts',async t=>{
  const f=await fixture(t);await f.booking('b1');await f.booking('b2',{date:'2030-01-03'});await f.baseline();await f.event('e1','b1');await f.event('e2','b2');
  f.g.fail('chat.postMessage','429');await f.worker.runOnce();const calls=f.g.calls.length,first=(await f.db.query("SELECT booking_id FROM eduson_booking.slack_notification_jobs WHERE attempts=1")).rows[0].booking_id,other=first==='b1'?'b2':'b1';f.advance(1001);
  await slack.createSlackNotifications(f.options).runOnce();
  assert.equal(f.g.calls.length,calls);assert.equal(f.g.posts.length,0);
  const otherJob=(await f.db.query('SELECT attempts FROM eduson_booking.slack_notification_jobs WHERE booking_id=$1',[other])).rows[0];assert.equal(otherJob.attempts,0);
  f.advance(58998);await slack.createSlackNotifications(f.options).runOnce();assert.equal(f.g.calls.length,calls);
  f.advance(1);await slack.createSlackNotifications(f.options).runOnce();assert.equal(f.g.posts.length,1);
});

test('chat.update retries a network failure safely using the known timestamp',async t=>{
  const f=await fixture(t);await f.baseline();f.setNow('2030-01-02T06:45Z');await f.worker.runOnce();f.advance(5*60_000);f.g.fail('chat.update','network');await f.worker.runOnce();f.advance(10000);await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,2);assert.equal((await f.worker.status()).uncertain,0);
});

test('a workspace mismatch is visible without sending any message',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();f.g.setTeam('TFOREIGN');await f.worker.runOnce();
  assert.equal(f.g.posts.length,0);assert.equal((await f.worker.status()).lastError,'SLACK_TEAM_MISMATCH');
});

test('Slack metadata reads use GET query parameters and message methods retain JSON POST',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();await f.worker.runOnce();
  assert.equal(f.g.calls.find(c=>c.method==='users.info').httpMethod,'GET');assert.equal(f.g.calls.find(c=>c.method==='users.info').body.user,A);
  assert.equal(f.g.calls.find(c=>c.method==='chat.postMessage').httpMethod,'POST');
});

test('a report saved during Slack preflight prevents the pending reminder from being posted',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.db.query("UPDATE eduson_booking.bookings SET state='completed',completed_at=$1 WHERE id='b1'",[f.now()]);f.setNow('2030-01-02T08:16Z');
  f.g.beforeReply('users.info',()=>f.db.query("INSERT INTO eduson_booking.reports(booking_id,payload)VALUES('b1','{}')"));
  await f.worker.runOnce();assert.equal(f.g.posts.length,0);assert.equal((await f.worker.status()).cancelled,1);
});

test('cancelled blocked assignments no longer request a staff mapping',async t=>{
  const f=await fixture(t);await f.booking('b1',{managerId:'sales-unmapped'});await f.baseline();await f.event('e1','b1',1,'confirmed',{managerId:'sales-unmapped'});await f.worker.runOnce();
  await f.db.query("UPDATE eduson_booking.bookings SET state='cancelled' WHERE id='b1'");await f.worker.runOnce();
  assert.equal((await f.worker.status()).blockedMapping,0);assert.equal((await f.worker.status()).cancelled,1);assert.equal(f.g.posts.length,0);
});

test('summary planning failure is visible and does not prevent personal assignment delivery',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();f.setFigures(null);f.setNow('2030-01-02T06:45Z');await f.worker.runOnce();
  const status=await f.worker.status();assert.equal(f.g.posts.filter(p=>p.channel.startsWith('D')).length,1);assert.equal(status.plannerError,'SLACK_STATS_UNAVAILABLE');assert.equal(status.error,1);
});

test('a held lesson with no historic confirmation is completed, never awaiting confirmation in a summary',async t=>{
  const f=await fixture(t);await f.baseline();await f.booking('held',{state:'completed',confirmationStatus:'pending',completedAt:new Date('2030-01-02T08:00Z')});f.setNow('2030-01-02T08:01Z');await f.worker.runOnce();
  assert.match(f.g.posts[0].text,/ожидают: \*0\*/);assert.match(f.g.posts[0].text,/завершено: \*1\*/);
});

test('the final end+15 minute update tolerates the normal seconds offset of a worker tick',async t=>{
  const f=await fixture(t);await f.baseline();f.setNow('2030-01-02T06:45:10Z');await f.worker.runOnce();f.setNow('2030-01-02T08:15:10Z');await f.worker.runOnce();
  assert.equal(f.g.posts.length,1);assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,1);
  f.setNow('2030-01-02T08:16:10Z');await f.worker.runOnce();assert.equal(f.g.calls.filter(c=>c.method==='chat.update').length,1);
});

test('a live lease excludes another worker and an expired transmitting post becomes uncertain without replay',async t=>{
  const f=await fixture(t);await f.booking();await f.baseline();await f.event();let release,arrived;
  const blocked=new Promise(r=>{release=r;}),entered=new Promise(r=>{arrived=r;});f.g.holdNextPost(async()=>{arrived();await blocked;});
  const first=f.worker.runOnce();await entered;const second=slack.createSlackNotifications(f.options);assert.equal((await second.runOnce()).processed,false);
  f.advance(5*60_000+1);await second.runOnce();release();await first;
  assert.equal(f.g.posts.length,1);assert.equal((await second.status()).uncertain,1);
});
