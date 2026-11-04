import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { createApp } from '../server.mjs';

test('notifications are private to admin and remain independent of Google sync', async t => {
  const db = await openDatabase({memory:true});
  const app = await createApp({db,enableWorkers:false,slackOptions:{config:{enabled:true,token:''}}});
  t.after(async()=>{await app.close();await db.close();});
  const base = `http://127.0.0.1:${await app.listen(0)}`, password='Notifications private test 2030';
  const sessions={};
  for(const role of ['admin','sales','confirmation','call_center']) {
    await app.auth.createUser({id:'system',role:'admin'},{name:role,email:role+'@notifications.test',role,password});
    const r=await fetch(base+'/api/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:role+'@notifications.test',password})});
    sessions[role]=r.headers.get('set-cookie').split(';')[0];
  }
  assert.equal((await fetch(base+'/api/notifications/status')).status,401);
  for(const role of ['sales','confirmation','call_center']) assert.equal((await fetch(base+'/api/notifications/status',{headers:{cookie:sessions[role]}})).status,403);
  const statusResponse=await fetch(base+'/api/notifications/status',{headers:{cookie:sessions.admin}});
  assert.equal(statusResponse.status,200);
  const status=await statusResponse.json();
  assert.equal(status.enabled,true);assert.equal(status.configured,false);assert.equal(status.lastError,'SLACK_CONFIGURATION');
  const bootstrap=await (await fetch(base+'/api/bootstrap',{headers:{cookie:sessions.admin}})).json();
  assert.equal(bootstrap.notifications.lastError,'SLACK_CONFIGURATION');
  const salesBootstrap=await(await fetch(base+'/api/bootstrap',{headers:{cookie:sessions.sales}})).json();
  assert.equal(salesBootstrap.notifications,undefined);
  await app.worker();
  const sync=await (await fetch(base+'/api/sync',{headers:{cookie:sessions.admin}})).json();
  assert.equal(sync.errors,0);assert.equal(sync.lastError,null);
});

test('application worker delivers a new real assignment with Google disabled, after a quiet baseline', async t => {
  const db=await openDatabase({memory:true});let now=new Date('2030-01-02T05:00:00Z');const posts=[];
  for(const [id,role] of [['admin','admin'],['sales','sales']]) await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$1,$3,$4)',[id,id+'@worker.test',role,'unused']);
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url),method=u.pathname.split('/').at(-1),body=options.method==='GET'?Object.fromEntries(u.searchParams):JSON.parse(options.body||'{}');
    let result;
    if(method==='auth.test')result={ok:true,team_id:'TTEST',user_id:'UBOT',bot_id:'BBOT'};
    else if(method==='users.info')result={ok:true,user:{id:body.user,team_id:'TTEST',deleted:false,is_bot:false}};
    else if(method==='conversations.open')result={ok:true,channel:{id:'DSALES',user:body.users,is_im:true}};
    else if(method==='chat.postMessage'){posts.push(body);result={ok:true,channel:body.channel,ts:'1900000000.000001'};}
    else assert.fail('Unexpected method '+method);
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  };
  const app=await createApp({db,now:()=>now,enableWorkers:false,slackOptions:{fetchImpl,config:{enabled:true,token:'SYNTHETIC-ONLY-SECRET',teamId:'TTEST',summaryChannelId:'CSUMMARY',staffMap:{sales:'USALES'},baseUrl:'https://booking.example.test/'}}});
  t.after(async()=>{await app.close();await db.close();});
  await app.worker();assert.equal(posts.length,0);
  const sale={id:'sales',role:'sales'},admin={id:'admin',role:'admin'};
  await app.service.saveSchedule(sale,{date:'2030-01-02',intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:1});
  const b=await app.service.createBooking(admin,{date:'2030-01-02',time:'12:00',studentName:'Проверка доставки',parentName:'Родитель',phone:'+79990000000',age:10,hasPc:true,parentPresent:true,crmUrl:'https://eduson.amocrm.ru/leads/detail/1',idempotencyKey:'notification-worker'});
  await app.service.confirmBooking(admin,b.id,{version:b.version});
  await app.worker();await app.worker();
  assert.equal(posts.length,1);assert.equal(posts[0].channel,'DSALES');assert.match(posts[0].text,/12:00/);
  const publicStatus=await app.notifications.status();assert.equal(publicStatus.sent,1);assert.doesNotMatch(JSON.stringify(publicStatus),/SYNTHETIC-ONLY-SECRET|Проверка доставки/);
});
