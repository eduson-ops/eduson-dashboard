import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {openDatabase} from '../db.mjs';

const operational=await import('../operational-reports.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('operational-reports.mjs'))return {};
  throw error;
});
const admin={id:'op-admin',name:'Администратор',role:'admin'};
const sale={id:'op-sale',name:'Первый методист',role:'sales'};
const other={id:'op-other',name:'Второй методист',role:'sales'};
const confirmer={id:'op-confirm',name:'Анна Багдасарян',role:'confirmation'};
const PAYMENT_HEADERS=['Отметка времени','Кто провёл урок ','  Ссылка на CRM  ','  Дата оплаты  ','  Практика  ','Пакет','  Способ оплаты  ','Сумма оплаты ','Ссылка на запись урока, заливать сюда : https://disk.360.yandex.ru/client/disk/example'];
const CONFIRM_HEADERS=['Отметка времени','Вставь АМО ','Кто МИМК?','Во сколько слот? '];
const ENROLL_HEADERS=['','Ссылка на амо','Добавление в ВК','Дата УР','Сумма платежа','Оплачено занятий','Дополнительно занятий','Проведено занятий','Проведено дополнительных занятий','Формат','Продукт','Возраст','Кол-во мес','Часовой','Имя родителя','Телефон родителя','ТГ родителя','ФИО ребенка','ТГ ребенка','Телефон ребенка','Почта ребенка','Дата и время от родителя','Дата вводного урока','Время вводного урока','Назначить преподавателя вводного урока','Написали родителю','Провести вводный урок','Response ID Тайпформ','Слоты из анкеты в понедельник','Слоты из анкеты во вторник','Слоты из анкеты в среду','Слоты из анкеты в четверг','Слоты из анкеты в пятницу','Слоты из анкеты в субботу','Слоты из анкеты в воскресенье','Назначена группа','Группа ','Время занятий','','','Дата первого урока курса','Основной преподаватель','Комментарий по спец. условиям'];
const ENROLL_TAB='Реестр учеников Eduson - вводный урок';
const input=(extra={})=>({idempotencyKey:'payment-test-key',bookingId:'op-booking',paidAt:'2026-11-04',crmUrl:'https://eduson.amocrm.ru/leads/detail/12345',amountNet:12000,practice:'Python',package:'12 занятий',paymentMethod:'Карта',studentName:'Тестовый ученик',parentName:'Тестовый родитель',phone:'+79990000001',age:10,paidLessons:12,format:'Индивидуальный',recordingUrl:'https://example.test/recording',...extra});

async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());
  await operational.initializeOperationalSchema(db);
  for(const user of [admin,sale,other,confirmer])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',[user.id,user.id+'@example.test',user.name,user.role,'unused']);
  await db.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,confirmation_due_at,assigned_to,assignment_kind,created_by)
    VALUES('op-booking','2026-11-04','12:00','2026-11-04T09:00Z','2026-11-04T10:00Z','Тестовый ученик','Тестовый родитель','+79990000001','https://eduson.amocrm.ru/leads/detail/12345',10,true,true,'2026-11-04T07:00Z',$1,'primary','test-caller')`,[sale.id]);
  let now=new Date('2026-11-04T09:00:00Z');
  const service=new operational.OperationalPaymentService(db,{now:()=>now});
  return{db,service,advance:ms=>{now=new Date(+now+ms);},now:()=>now};
}

test('operational payment and outbox exports exist',()=>{
  for(const name of ['initializeOperationalSchema','OperationalPaymentService','enqueueOperationalJob','createOperationalSynchronizer'])assert.equal(typeof operational[name],'function',name);
});

test('a payment is stored once before two independent projection jobs and never creates a lesson report',async t=>{
  const f=await fixture(t);const payment=await f.service.createPayment(sale,input());
  assert.equal(payment.amountNet,12000);assert.equal(payment.managerId,sale.id);assert.equal(payment.managerName,sale.name);assert.equal(payment.bookingId,'op-booking');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.payments')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.reports')).rows[0].n,0);
  assert.deepEqual((await f.db.query('SELECT kind,entity_id FROM eduson_booking.operation_jobs ORDER BY kind')).rows,[{kind:'enrollment',entity_id:payment.id},{kind:'payment',entity_id:payment.id}]);
  const repeated=await Promise.all([f.service.createPayment(sale,input()),f.service.createPayment(sale,input())]);
  assert.ok(repeated.every(x=>x.id===payment.id));
  await assert.rejects(()=>f.service.createPayment(sale,input({amountNet:13000})),{status:409});
});

test('payment creation enforces role, assigned ownership, required financial facts and a stable key',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.service.createPayment(confirmer,input()),{status:403});
  await assert.rejects(()=>f.service.createPayment(other,input()),{status:403});
  await assert.rejects(()=>f.service.createPayment(sale,input({managerId:other.id})),{status:403});
  for(const patch of [{amountNet:0},{amountNet:1.5},{amountNet:-1},{idempotencyKey:''},{paidAt:'2026-02-30'},{phone:'123'},{paidLessons:0},{age:0},{format:''},{crmUrl:'https://evil.test/path?x=.amocrm.ru/'},{studentEmail:'invalid'}])await assert.rejects(()=>f.service.createPayment(sale,input(patch)),{status:400});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.payments')).rows[0].n,0);
});

test('a standalone payment is allowed and role-filtered lists preserve the manager snapshot',async t=>{
  const f=await fixture(t);const payment=await f.service.createPayment(sale,input({bookingId:null}));
  assert.equal(payment.bookingId,null);
  assert.equal((await f.service.listPayments(sale,{from:'2026-11-04',to:'2026-11-04'})).length,1);
  assert.equal((await f.service.listPayments(other,{})).length,0);
  assert.equal((await f.service.listPayments(admin,{from:'2026-11-05'})).length,0);
  await f.db.query('UPDATE eduson_booking.users SET name=$1 WHERE id=$2',['Новое имя',sale.id]);
  assert.equal((await f.service.getPayment(payment.id)).managerName,sale.name);
  assert.equal('inputFingerprint'in(await f.service.getPayment(payment.id)),false);
});

test('an administrator chooses a real sales manager and a failed enrollment job insert rolls back the payment',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.service.createPayment(admin,input({bookingId:null})),{status:400});
  await assert.rejects(()=>f.service.createPayment(admin,input({bookingId:null,managerId:confirmer.id})),{status:400});
  await f.db.query(`CREATE FUNCTION eduson_booking.fail_payment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.kind='enrollment' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END$$`);
  await f.db.query('CREATE TRIGGER fail_payment_outbox BEFORE INSERT ON eduson_booking.operation_jobs FOR EACH ROW EXECUTE FUNCTION eduson_booking.fail_payment_outbox()');
  await assert.rejects(()=>f.service.createPayment(admin,input({managerId:sale.id})));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.payments')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.operation_jobs')).rows[0].n,0);
});

test('test bookings cannot enroll a fake pupil or create a financial report',async t=>{
  const f=await fixture(t);
  // The parent adds this column to the common schema; keep this module's test isolated too.
  await f.db.query('ALTER TABLE eduson_booking.bookings ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false');
  await f.db.query("UPDATE eduson_booking.bookings SET is_test=true WHERE id='op-booking'");
  await assert.rejects(()=>f.service.createPayment(sale,input()),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM eduson_booking.payments')).rows[0].n,0);
});

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
async function key(t){const dir=await mkdtemp(join(tmpdir(),'op-sheets-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'synthetic-key.json');await writeFile(file,JSON.stringify({client_email:'test@example.invalid',private_key:pair.privateKey.export({type:'pkcs8',format:'pem'})}));return file;}
function google(){
  const tabs=new Map([['main:Оплаты',[PAYMENT_HEADERS.slice()]],['main:Подтверждения',[CONFIRM_HEADERS.slice()]],['enrollment:'+ENROLL_TAB,[ENROLL_HEADERS.slice()]]]);
  const requests=[];let lostTarget=null,failTarget=null,appendHook=null;
  const response=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
  const col=text=>[...text].reduce((sum,c)=>sum*26+c.charCodeAt(0)-64,0)-1;
  async function fetchImpl(url,options={}){
    requests.push({url:String(url),...options});
    if(String(url)==='https://oauth2.googleapis.com/token')return response({access_token:'SYNTHETIC',expires_in:3600});
    const u=new URL(url),batch=u.pathname.match(/^\/v4\/spreadsheets\/(main|enrollment):batchUpdate$/);
    if(batch){
      assert.equal(options.method,'POST');const body=JSON.parse(options.body);assert.equal(body.requests.length,1);
      const append=body.requests[0].appendCells;assert.equal(append.fields,'userEnteredValue');
      const names={1338934770:'Подтверждения',1367593612:'Оплаты',0:ENROLL_TAB},name=batch[1]+':'+names[append.sheetId],rows=tabs.get(name);assert.ok(rows,name);
      if(failTarget===name)return new Response('{}',{status:403});
      for(const row of append.rows)rows.push(row.values.map(c=>{const v=c.userEnteredValue;assert.equal('formulaValue'in v,false);assert.equal(Object.keys(v).length,1);return v.stringValue??v.numberValue??v.boolValue;}));
      if(appendHook){const hook=appendHook;appendHook=null;await hook(name);}
      if(lostTarget===name){lostTarget=null;throw Error('accepted then lost SECRET-TOKEN customer@example.invalid');}
      return response({replies:[{}]});
    }
    const match=u.pathname.match(/^\/v4\/spreadsheets\/(main|enrollment)\/values\/(.+)$/);assert.ok(match,String(url));
    const range=decodeURIComponent(match[2]),append=range.endsWith(':append');
    const address=range.replace(/:append$/,'').match(/^'(.+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);assert.ok(address,range);
    const name=match[1]+':'+address[1],rows=tabs.get(name);assert.ok(rows,name);
    if(failTarget===name)return new Response('{}',{status:403});
    const start=col(address[2]),end=col(address[4]||address[2]),row=Number(address[3]||1)-1,last=address[5]?Number(address[5]):(address[3]&&!address[4]?Number(address[3]):rows.length);
    if(!options.method||options.method==='GET')return response({values:rows.slice(row,last).map(x=>x.slice(start,end+1))});
    assert.equal(u.searchParams.get('valueInputOption'),'RAW');const values=JSON.parse(options.body).values;
    if(append)assert.fail('Use appendCells: a leading empty column must not shift the logical table.');
    else values.forEach((x,i)=>{rows[row+i]||=[];x.forEach((value,j)=>{rows[row+i][start+j]=value;});});
    return response({updatedRows:values.length});
  }
  return{tabs,requests,fetchImpl,lose:name=>{lostTarget=name;},fail:name=>{failTarget=name;},recover:()=>{failTarget=null;},afterAppend:hook=>{appendHook=hook;}};
}
async function syncFixture(t,extra={}){
  const f=await fixture(t),g=google(),serviceAccountPath=await key(t);
  const config={db:f.db,spreadsheetId:'main',enrollmentSpreadsheetId:'enrollment',serviceAccountPath,enabled:true,fetchImpl:g.fetchImpl,now:f.now,getPayment:id=>f.service.getPayment(id),getConfirmation:async id=>({bookingId:id,confirmedAt:'2026-11-04T08:00:00Z',crmUrl:'https://eduson.amocrm.ru/leads/detail/12345',managerName:sale.name,time:'12:00',actorName:confirmer.name,version:1}),...extra};
  return{...f,g,config,sync:operational.createOperationalSynchronizer(config)};
}
const writes=g=>g.requests.filter(x=>x.method&&x.method!=='GET'&&!x.url.includes('oauth2.googleapis.com'));

test('both payment projections retain the existing business columns and use separate stable IDs',async t=>{
  const f=await syncFixture(t),p=await f.service.createPayment(sale,input({registryDate:'2026-11-03',bonusLessons:2,months:3,parentTelegram:'@parent',studentEmail:'student@example.test',weekAvailability:{mon:'17:00',fri:'18:00'},specialConditions:'=UNTRUSTED()'}));
  await f.sync.runOnce();await f.sync.runOnce();
  const paid=f.g.tabs.get('main:Оплаты'),enrolled=f.g.tabs.get('enrollment:'+ENROLL_TAB);
  assert.deepEqual(paid[0].slice(9),['Payment ID','Booking ID']);assert.equal(paid.length,2);assert.equal(paid[1][7],12000);assert.equal(paid[1][8],'https://example.test/recording');assert.equal(paid[1][9],p.id);assert.equal(paid[1][10],'op-booking');
  assert.deepEqual(enrolled[0].slice(43),['Payment ID','Booking ID']);assert.equal(enrolled.length,2);assert.equal(enrolled[1][1],p.crmUrl);assert.equal(enrolled[1][3],'03.11.2026');assert.equal(enrolled[1][4],12000);assert.equal(enrolled[1][5],12);assert.equal(enrolled[1][6],2);assert.equal(enrolled[1][7],'');assert.equal(enrolled[1][25],'');assert.equal(enrolled[1][28],'17:00');assert.equal(enrolled[1][32],'18:00');assert.equal(enrolled[1][42],'=UNTRUSTED()');assert.equal(enrolled[1][43],p.id);
  assert.equal((await f.sync.status()).pending,0);assert.equal((await f.sync.status()).error,0);
});

test('a lost append is retried by stable ID without erasing registry staff work',async t=>{
  const f=await syncFixture(t);await f.service.createPayment(sale,input());f.g.lose('enrollment:'+ENROLL_TAB);
  await f.sync.runOnce();await f.sync.runOnce();
  const rows=f.g.tabs.get('enrollment:'+ENROLL_TAB);assert.equal(rows.length,2);rows[1][35]='Да';rows[1][36]='Назначенная группа';rows[1][24]='Позже назначенный преподаватель';
  f.advance(10000);await f.sync.runOnce();
  assert.equal(rows.length,2);assert.equal(rows[1][35],'Да');assert.equal(rows[1][36],'Назначенная группа');assert.equal(rows[1][24],'Позже назначенный преподаватель');assert.equal((await f.sync.status()).error,0);
});

test('one unavailable destination leaves a durable retry while the other projection succeeds once',async t=>{
  const f=await syncFixture(t);await f.service.createPayment(sale,input());f.g.fail('enrollment:'+ENROLL_TAB);
  await f.sync.runOnce();await f.sync.runOnce();assert.equal(f.g.tabs.get('main:Оплаты').length,2);assert.equal((await f.sync.status()).error,1);
  f.advance(10000);f.g.recover();await f.sync.runOnce();assert.equal(f.g.tabs.get('main:Оплаты').length,2);assert.equal(f.g.tabs.get('enrollment:'+ENROLL_TAB).length,2);assert.equal((await f.sync.status()).error,0);
});

test('confirmation projections retain historical anonymous rows and record the actual confirmer',async t=>{
  const f=await syncFixture(t);f.g.tabs.get('main:Подтверждения').push(['old timestamp','old CRM','old manager','10:00']);
  await f.db.transaction(tx=>operational.enqueueOperationalJob(tx,{kind:'confirmation',entityId:'op-booking',version:1}));
  await f.sync.runOnce();const rows=f.g.tabs.get('main:Подтверждения');
  assert.equal(rows.length,3);assert.deepEqual(rows[1],['old timestamp','old CRM','old manager','10:00']);assert.deepEqual(rows[0].slice(4),['Booking ID','Кто подтвердил']);assert.equal(rows[2][4],'op-booking');assert.equal(rows[2][5],confirmer.name);
});

test('metadata header guards stop writes to an unrelated column',async t=>{
  const f=await syncFixture(t);await f.service.createPayment(sale,input());f.g.tabs.get('main:Оплаты')[0][9]='Foreign ID';
  await f.sync.runOnce();await f.sync.runOnce();assert.equal((await f.sync.status()).lastError,'SHEET_HEADER_MISMATCH');assert.equal(writes(f.g).filter(x=>decodeURIComponent(x.url).includes("'Оплаты'!")).length,0);
  f.g.tabs.get('main:Оплаты')[0][9]='';f.g.tabs.get('main:Оплаты').push(Array.from({length:10},(_,i)=>i===9?'foreign data':''));f.advance(10000);await f.sync.runOnce();assert.equal((await f.sync.status()).lastError,'SHEET_HEADER_MISMATCH');
});

test('duplicate payment IDs fail closed without modifying an existing row',async t=>{
  const f=await syncFixture(t),p=await f.service.createPayment(sale,input()),rows=f.g.tabs.get('main:Оплаты');
  rows[0].push('Payment ID','Booking ID');
  const old=['old','manager','CRM','date','practice','package','method',10,'recording',p.id,'op-booking'];
  rows.push(old.slice(),old.slice());
  await f.sync.runOnce();await f.sync.runOnce();
  assert.equal((await f.sync.status()).lastError,'SHEET_DUPLICATE_ID');assert.equal(rows.length,3);assert.deepEqual(rows[1],old);assert.deepEqual(rows[2],old);
  assert.equal(writes(f.g).some(x=>x.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/main')),false);
});

test('a second worker does not project while another worker owns an unexpired lease',async t=>{
  const f=await syncFixture(t);await f.db.transaction(tx=>operational.enqueueOperationalJob(tx,{kind:'confirmation',entityId:'op-booking',version:1}));
  let release,arrived;const blocked=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrived=resolve;});
  f.g.afterAppend(async()=>{arrived();await blocked;});
  const first=f.sync.runOnce();await entered;
  const second=operational.createOperationalSynchronizer(f.config);assert.equal((await second.runOnce()).processed,false);
  assert.equal((await f.db.query('SELECT attempts FROM eduson_booking.operation_jobs')).rows[0].attempts,1);
  release();assert.equal((await first).status,'done');assert.equal(f.g.tabs.get('main:Подтверждения').length,2);
});

test('an expired worker cannot overwrite the successful lease takeover or append twice',async t=>{
  const f=await syncFixture(t),p=await f.service.createPayment(sale,input());
  // Isolate one immutable destination so a different job cannot hide a takeover bug.
  await f.db.query("DELETE FROM eduson_booking.operation_jobs WHERE kind='payment'");
  let release,arrived;const blocked=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrived=resolve;});
  f.g.afterAppend(async()=>{arrived();await blocked;});
  const first=f.sync.runOnce();await entered;f.advance(5*60_000+1);
  const second=operational.createOperationalSynchronizer(f.config);assert.equal((await second.runOnce()).status,'done');
  release();assert.equal((await first).error,'SYNC_LEASE_LOST');
  const job=(await f.db.query('SELECT * FROM eduson_booking.operation_jobs')).rows[0];
  assert.equal(job.status,'done');assert.equal(job.last_error,null);assert.equal(job.lease_token,null);assert.equal(job.lease_until,null);assert.equal(job.attempts,2);
  const rows=f.g.tabs.get('enrollment:'+ENROLL_TAB);assert.equal(rows.length,2);assert.equal(rows[1][43],p.id);
});

test('a provider error is durably sanitized and immediate retries honor the backoff',async t=>{
  const f=await syncFixture(t);await f.db.transaction(tx=>operational.enqueueOperationalJob(tx,{kind:'confirmation',entityId:'op-booking',version:1}));
  f.g.lose('main:Подтверждения');assert.equal((await f.sync.runOnce()).error,'NETWORK_FAILED');
  const job=(await f.db.query('SELECT * FROM eduson_booking.operation_jobs')).rows[0];assert.equal(job.status,'error');assert.equal(job.last_error,'NETWORK_FAILED');assert.equal(job.attempts,1);
  assert.equal((await f.sync.runOnce()).processed,false);assert.equal((await f.db.query('SELECT attempts FROM eduson_booking.operation_jobs')).rows[0].attempts,1);
  f.advance(5000);assert.equal((await f.sync.runOnce()).status,'done');assert.equal(f.g.tabs.get('main:Подтверждения').length,2);
});

test('a crashed final attempt becomes terminal and never writes again',async t=>{
  const f=await syncFixture(t);await f.db.transaction(tx=>operational.enqueueOperationalJob(tx,{kind:'confirmation',entityId:'op-booking',version:1}));
  await f.db.query("UPDATE eduson_booking.operation_jobs SET attempts=8,status='processing',lease_token='crashed',lease_until=$1",[new Date(+f.now()-1)]);
  assert.equal((await f.sync.runOnce()).processed,false);const job=(await f.db.query('SELECT * FROM eduson_booking.operation_jobs')).rows[0];
  assert.equal(job.status,'error');assert.equal(job.last_error,'SYNC_ATTEMPTS_EXHAUSTED');assert.equal(job.lease_token,null);assert.equal(f.g.requests.length,0);
});

test('disabled operational sync never claims a job, opens a key or calls a provider',async t=>{
  const f=await syncFixture(t,{enabled:false,serviceAccountPath:'Z:/missing/private-key.json',fetchImpl:()=>{throw Error('provider called');}});await f.service.createPayment(sale,input());
  assert.equal((await f.sync.runOnce()).processed,false);assert.equal((await f.sync.status()).pending,2);assert.equal((await f.db.query('SELECT sum(attempts)::int n FROM eduson_booking.operation_jobs')).rows[0].n,0);
});
