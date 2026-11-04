import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {migrateV3} from '../migration-v3.mjs';
import {createSourceIntake} from '../source-intake.mjs';

const clock='2026-11-04T07:00:00Z',account='existing-collision-account';
const admin={id:'collision-admin',role:'admin'},sales={id:'collision-sales',role:'sales',name:'Synthetic Methodologist'};
const record=(extra={})=>({date:'2026-10-10',time:'12:00',durationMinutes:60,studentName:'Synthetic Child 1',parentName:'Synthetic Parent',phone:'+79990000000',crmUrl:'',age:10,hasPc:true,parentPresent:true,comment:'original',staffId:'provider-staff',...extra});
const observation=(recordId,revision='1',extra={})=>({accountId:account,recordId,revision,event:'upsert',observedAt:clock,record:record(),raw:{synthetic:true,revision},...extra});
const count=async(db,table)=>(await db.query(`SELECT count(*)::int n FROM eduson_booking.${table}`)).rows[0].n;

async function fixture(t,{migratedPair=false}={}){
 const db=await openDatabase({memory:true});t.after(()=>db.close());
 for(const actor of [admin,sales])await db.query('INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$3,$4,\'unused\')',[actor.id,actor.id+'@test.local',actor.name||actor.id,actor.role]);
 const service=new BookingService(db,{now:()=>new Date(clock),random:()=>0});
 const intake=createSourceIntake({db,service,now:()=>new Date(clock),staffMap:{[account]:{'provider-staff':sales.id}}});
 if(migratedPair){
  const csv=[1,2].map(n=>({rubitimeId:n,employeeName:sales.name,parentName:'Synthetic Parent',phone:'+79990000000',childName:`Synthetic Child ${n}`,childAge:10,hasComputerRaw:'Да',parentAttendingRaw:'Да',startLocal:'2026-10-10T12:00:00',createdLocal:'2026-10-01T08:00:00',durationMinutes:60,rawStatusTitle:'Записан',timezone:'Europe/Moscow',orderId:'unproved-order',comment:'original'}));
  const input={snapshot:{capturedAt:clock,timezone:'Europe/Moscow',sheet:{schedule:{values:[['Менеджер','Дата','Время']]},managers:{values:[['Имя','Активен']]}}},rubitime:{csv,api:csv.map(row=>({id:row.rubitimeId,record:row.startLocal.replace('T',' '),created_at:'2026-10-01 08:00:00',duration:'60',status:0,status_title:'Записан',cooperator_title:row.employeeName}))}};
  const preview=await migrateV3(db,input,{now:()=>new Date(clock)});assert.equal(preview.ok,true);
  await migrateV3(db,input,{apply:true,expectedDatabaseFingerprint:preview.databaseFingerprint,now:()=>new Date(clock)});
  assert.deepEqual(await intake.seedMigrationLinks({accountId:account}),{seeded:2,protected:0});
 }
 return{db,service,intake,bookings:()=>service.listBookings(admin,{scope:'all'}),sourceRows:()=>db.query('SELECT * FROM eduson_booking.source_intake_records ORDER BY record_id').then(result=>result.rows)};
}

test('already bound migrated records sharing phone and hour update only their own facts',async t=>{
 const f=await fixture(t,{migratedPair:true}),links=await f.sourceRows(),before=await f.bookings();
 assert.equal(before.length,2);assert.notEqual(links[0].booking_id,links[1].booking_id);
 for(const n of [1,2]){
  const result=await f.intake.observe(observation(String(n),'1',{record:record({studentName:`Synthetic Child ${n}`,comment:`verified source comment ${n}`})}));
  assert.equal(result.status,'applied');assert.equal(result.bookingId,links[n-1].booking_id);
 }
 const after=await f.bookings();assert.equal(after.length,2);assert.deepEqual(after.map(row=>row.id).sort(),before.map(row=>row.id).sort());
 for(const n of [1,2]){const row=after.find(row=>row.id===links[n-1].booking_id);assert.equal(row.comment,`verified source comment ${n}`);assert.equal(row.studentName,`Synthetic Child ${n}`);assert.equal(row.version,2);assert.equal(row.historyOnly,true);assert.equal(row.assignedTo,null);}
 assert.equal((await f.intake.status()).issues,0);
 for(const table of ['schedules','sync_jobs','reports','payments','compensation_events'])assert.equal(await count(f.db,table),0);
});

test('unchanged phone identity allows formatting updates on a known shared household record',async t=>{
 const f=await fixture(t,{migratedPair:true}),links=await f.sourceRows();
 const result=await f.intake.observe(observation('1','1',{record:record({phone:'+7 (999) 000-00-00',comment:'verified formatting'})}));
 assert.equal(result.status,'applied');assert.equal(result.bookingId,links[0].booking_id);
 const rows=await f.bookings();assert.equal(rows.find(row=>row.id===links[0].booking_id).phone,'+7 (999) 000-00-00');assert.equal(rows.find(row=>row.id===links[1].booking_id).phone,'+79990000000');
});

test('known source identity changes still stop at another record and retry never forces adoption',async t=>{
 const f=await fixture(t);
 const first=await f.intake.observe(observation('first','1',{record:record({phone:'+79990000001'})}));
 const second=await f.intake.observe(observation('second','1',{record:record({date:'2026-10-11',phone:'+79990000002',studentName:'Synthetic Other Child'})}));
 assert.equal(first.status,'applied');assert.equal(second.status,'applied');const before=await f.bookings();
 const blocked=await f.intake.observe(observation('first','2',{record:record({date:'2026-10-11',phone:'+79990000002',comment:'must stay blocked'})}));
 assert.equal(blocked.code,'SOURCE_IDENTITY_CONFLICT');assert.deepEqual(await f.bookings(),before);
 assert.equal((await f.intake.retryIssue({observationId:blocked.observationId})).status,'pending');
 assert.equal((await f.intake.runOnce()).issues,1);assert.deepEqual(await f.bookings(),before);
 assert.equal((await f.intake.listIssues())[0].code,'SOURCE_IDENTITY_CONFLICT');
});

test('unknown source records cannot adopt an existing migrated household through phone and hour',async t=>{
 const f=await fixture(t,{migratedPair:true}),before=await f.bookings();
 const blocked=await f.intake.observe(observation('unknown','1',{record:record({comment:'must not create or adopt'})}));
 assert.equal(blocked.code,'SOURCE_IDENTITY_CONFLICT');assert.equal(blocked.bookingId,null);assert.deepEqual(await f.bookings(),before);
});

test('CRM collisions remain blocked for new sources and for identity changes on known sources',async t=>{
 const f=await fixture(t,{migratedPair:true}),crm='https://synthetic.amocrm.ru/leads/detail/200';
 const first=await f.intake.observe(observation('first','1',{record:record({phone:'+79990000001'})}));
 const second=await f.intake.observe(observation('crm-owner','1',{record:record({date:'2026-10-11',phone:'+79990000002',crmUrl:crm})}));
 assert.equal(second.status,'applied');
 await f.db.query("INSERT INTO eduson_booking.migration_v3_sources(source,source_id,booking_id,fingerprint,raw,imported_at)VALUES('amocrm','authoritative-crm-owner',$1,'synthetic','{}',$2)",[second.bookingId,clock]);
 const before=await f.bookings();
 const newSource=await f.intake.observe(observation('new-crm-source','1',{record:record({date:'2026-10-12',phone:'+79990000003',crmUrl:crm})}));assert.equal(newSource.code,'SOURCE_IDENTITY_CONFLICT');
 const changedSource=await f.intake.observe(observation('first','2',{record:record({phone:'+79990000001',crmUrl:crm+'/',comment:'must not replace CRM'})}));assert.equal(changedSource.code,'SOURCE_IDENTITY_CONFLICT');
 assert.deepEqual(await f.bookings(),before);assert.equal(before.find(row=>row.id===first.bookingId).crmUrl,'');
});

test('a pristine shared identity never bypasses manual changes or Amo authority on its own booking',async t=>{
 const f=await fixture(t,{migratedPair:true}),links=await f.sourceRows();
 let rows=await f.bookings();const manual=rows.find(row=>row.id===links[0].booking_id);
 await f.service.updateBookingDetails(admin,manual.id,{version:manual.version,comment:'manual preserved'});
 await f.db.query("INSERT INTO eduson_booking.migration_v3_sources(source,source_id,booking_id,fingerprint,raw,imported_at)VALUES('amocrm','amo-authoritative',$1,'synthetic','{}',$2)",[links[1].booking_id,clock]);
 const before=await f.bookings();
 assert.equal((await f.intake.observe(observation('1','1',{record:record({comment:'must not overwrite manual'})}))).code,'BOOKING_MODIFIED');
 assert.equal((await f.intake.observe(observation('2','1',{record:record({studentName:'Synthetic Child 2',comment:'must not overwrite Amo'})}))).code,'AMO_AUTHORITY');
 assert.deepEqual(await f.bookings(),before);
});

test('administrator retries an immutable issue left by an older collision rule without a new provider revision',async t=>{
 const f=await fixture(t,{migratedPair:true}),input=observation('1','1',{record:record({comment:'trusted existing source comment'}),raw:{synthetic:true,immutable:'original receipt'}});
 const accepted=await f.intake.accept(input);
 // Persist the exact state produced by the earlier release's broad collision check.
 await f.db.query("UPDATE eduson_booking.source_intake_observations SET status='issue',code='SOURCE_IDENTITY_CONFLICT',processed_at=$1 WHERE id=$2",[clock,accepted.observationId]);
 await f.db.query("INSERT INTO eduson_booking.source_intake_issues(id,observation_id,account_id,record_id,code,created_at)VALUES($1,$2,$3,'1','SOURCE_IDENTITY_CONFLICT',$4)",[randomUUID(),accepted.observationId,account,clock]);
 const immutable=await f.db.query('SELECT input_hash,payload,raw,revision FROM eduson_booking.source_intake_observations WHERE id=$1',[accepted.observationId]);
 const retry=await f.intake.retryIssue({observationId:accepted.observationId});assert.equal(retry.status,'pending');assert.equal(retry.observationId,accepted.observationId);
 assert.equal((await f.intake.runOnce()).applied,1);
 assert.deepEqual((await f.db.query('SELECT input_hash,payload,raw,revision FROM eduson_booking.source_intake_observations WHERE id=$1',[accepted.observationId])).rows,immutable.rows);
 assert.equal(await count(f.db,'source_intake_observations'),1);assert.equal(await count(f.db,'bookings'),2);assert.equal((await f.intake.listIssues()).length,0);assert.equal((await f.intake.listIssues({includeResolved:true}))[0].resolution,'reprocessed');
 assert.equal((await f.bookings()).find(row=>row.id===retry.bookingId||row.comment==='trusted existing source comment').comment,'trusted existing source comment');
 await assert.rejects(f.intake.retryIssue({observationId:accepted.observationId}),{code:'ISSUE_REQUIRES_REVIEW'});
});
