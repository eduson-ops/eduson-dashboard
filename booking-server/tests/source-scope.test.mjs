import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../db.mjs';
import {BookingService} from '../domain.mjs';
import {createSourceIntake} from '../source-intake.mjs';
import {canConfirmBooking,canResolveLegacy,legacyOutcomeUnknown} from '../../booking/core.mjs';

const admin={id:'scope-admin',role:'admin'},sales={id:'scope-sales',role:'sales'},confirmation={id:'scope-confirmation',role:'confirmation'};
const past='2030-01-01',future='2030-01-03';
async function fixture(t){
  const db=await openDatabase({memory:true});t.after(()=>db.close());let clock=new Date('2030-01-02T06:00:00Z');
  for(const actor of [admin,sales,confirmation])await db.query("INSERT INTO eduson_booking.users(id,email,name,role,password_hash)VALUES($1,$2,$1,$3,'unused')",[actor.id,actor.id+'@scope.test',actor.role]);
  const service=new BookingService(db,{now:()=>clock,random:()=>0});await service.saveSchedule(sales,{date:future,intervals:[{start:'12:00',end:'13:00'}],reserveCapacity:0});
  const intake=createSourceIntake({db,service,now:()=>clock});
  const observe=async(revision,date)=>{clock=new Date(+clock+1000);return intake.observe({accountId:'scope-account',recordId:'scope-record',revision:String(revision),event:'upsert',observedAt:clock.toISOString(),record:{date,time:'12:00',durationMinutes:60,studentName:'Synthetic Student',parentName:'Synthetic Parent',phone:'+79990000000',crmUrl:'',age:10,hasPc:true,parentPresent:true,comment:'Source facts'},raw:{synthetic:true,revision,date}});};
  const row=async()=>(await service.listBookings(admin,{scope:'all'}))[0];
  const audit=async()=>db.query('SELECT id,actor_id,actor_role,action,payload,created_at FROM eduson_booking.audit_events WHERE booking_id=$1 ORDER BY created_at,id',[(await row()).id]).then(result=>result.rows);
  const scope=async(payload,{actorId='source:rubitime',actorRole='admin',action='legacy_scope_changed',at='2030-01-02T05:00:00Z'}={})=>db.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at)VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),(await row()).id,actorId,actorRole,action,JSON.stringify(payload),at]);
  const origin=async()=>scope({source:'rubitime',managerName:'Original manager metadata',elapsedUnknown:true},{actorId:'migration',action:'legacy_imported',at:'2029-12-01T00:00:00Z'});
  return{db,service,intake,observe,row,audit,scope,origin,now:()=>clock,setClock:value=>clock=new Date(value)};
}
const count=async(db,table)=>(await db.query('SELECT count(*)::int n FROM eduson_booking.'+table)).rows[0].n;

test('source past-future-past-future changes only effective legacy scope and preserves every earlier audit',async t=>{
  const f=await fixture(t),states=[];await f.observe(1,past);const original=await f.audit();
  states.push(await f.row());for(const[revision,date]of [[2,future],[3,past],[4,future]]){assert.equal((await f.observe(revision,date)).status,'applied');states.push(await f.row());}
  assert.deepEqual(states.map(row=>row.historyOnly),[true,false,true,false]);assert.deepEqual(states.map(row=>row.legacy.elapsedUnknown),[true,false,true,false]);assert.deepEqual(states.map(row=>canConfirmBooking(confirmation,row,f.now())),[false,true,false,true]);
  const audits=await f.audit();for(const old of original)assert.deepEqual(audits.find(row=>row.id===old.id),old);
  const scopes=audits.filter(row=>row.action==='legacy_scope_changed').sort((a,b)=>a.payload.version-b.payload.version);assert.equal(scopes.length,3);
  assert.deepEqual(scopes.map(row=>row.payload.version),[2,3,4]);assert.deepEqual(scopes.map(row=>row.payload.historyOnly),[false,true,false]);assert.deepEqual(scopes.map(row=>row.payload.elapsedUnknown),[false,true,false]);
  for(const entry of scopes){assert.equal(entry.actor_id,'source:rubitime');assert.equal(entry.actor_role,'admin');assert.equal(entry.payload.sourceObservation.accountId,'scope-account');assert.equal(entry.payload.sourceObservation.recordId,'scope-record');assert.match(entry.payload.sourceObservation.inputHash,/^[a-f0-9]{64}$/);}
  assert.ok(states.every(row=>row.state==='scheduled'&&row.confirmationStatus==='pending'&&row.assignedTo===null));
  for(const table of ['reports','payments','compensation_events'])assert.equal(await count(f.db,table),0);
});

test('rescheduled future source rows agree between frontend eligibility and actual server confirmation',async t=>{
  const f=await fixture(t);await f.observe(1,past);await f.observe(2,future);const row=await f.row();assert.equal(row.capacityHold,false);assert.equal(canConfirmBooking(confirmation,row,f.now()),true);
  const confirmed=await f.service.confirmBooking(confirmation,row.id,{version:row.version});assert.equal(confirmed.confirmationStatus,'confirmed');assert.equal(confirmed.assignedTo,sales.id);assert.equal(legacyOutcomeUnknown(confirmed),false);
});

test('a rescheduled unconfirmed future lesson expires after its end despite its preserved old archive marker',async t=>{
  const f=await fixture(t);await f.observe(1,past);await f.observe(2,future);assert.equal((await f.row()).capacityHold,false);f.setClock('2030-01-03T10:00:01Z');
  assert.equal(await f.service.expireUnconfirmed(),1);const expired=await f.row();assert.equal(expired.state,'cancelled');assert.equal(expired.cancelSource,'system');assert.equal((await f.audit()).filter(row=>row.action==='legacy_imported').length,1);
});

test('returning to the past restores admin resolution without inventing an outcome during the move',async t=>{
  const f=await fixture(t);for(const[revision,date]of [[1,past],[2,future],[3,past]])await f.observe(revision,date);const row=await f.row();
  assert.equal(canResolveLegacy(admin,row),true);assert.equal(canConfirmBooking(confirmation,row,f.now()),false);assert.equal(await f.service.expireUnconfirmed(),0);assert.equal(await count(f.db,'compensation_events'),0);
  await assert.rejects(f.service.confirmBooking(confirmation,row.id,{version:row.version}),{code:'ARCHIVE_RESOLUTION_REQUIRED'});
  const resolved=await f.service.resolveLegacy(admin,row.id,{version:row.version,outcome:'completed',managerId:sales.id,reason:'Synthetic explicit historical evidence'});assert.equal(resolved.state,'completed');assert.equal(resolved.legacy.elapsedUnknown,false);
});

test('untrusted or malformed scope payloads cannot clear legacy authority or crash JSON version parsing',async t=>{
  const f=await fixture(t);await f.observe(1,future);await f.origin();const version=(await f.row()).version;
  const valid={version,historyOnly:false,elapsedUnknown:false,sourceObservation:{synthetic:true}};
  const invalid=[
    {payload:valid,options:{actorId:admin.id}},
    {payload:valid,options:{actorRole:'sales'}},
    {payload:valid,options:{action:'source_intake_updated'}},
    ...[{elapsedUnknown:'false'},{historyOnly:'false'},{historyOnly:true},{version:String(version)},{version:0},{version:-1},{version:1.5},{version:version+1},{version:'1);DROP TABLE audit_events'},{version:{}},{version:null},{version:1e100}].map(patch=>({payload:{...valid,...patch}})),
    {payload:[false]},
  ];
  for(const entry of invalid){await f.scope(entry.payload,entry.options);const row=await f.row();assert.equal(row.legacy.elapsedUnknown,true);assert.equal(canConfirmBooking(confirmation,row,f.now()),false);}
  await f.scope({...valid,managerName:'Must not replace origin',source:'wrong-origin'});const row=await f.row();assert.equal(row.legacy.elapsedUnknown,false);assert.equal(row.legacy.source,'rubitime');assert.equal(row.legacy.managerName,'Original manager metadata');assert.equal(canConfirmBooking(confirmation,row,f.now()),true);
  await f.scope({version,historyOnly:true,elapsedUnknown:true},{at:'2050-01-01T00:00:00Z'});const liveAfter=await f.row();
  const archived=await fixture(t);await archived.observe(1,past);const pastBefore=await archived.row();await archived.scope({version:pastBefore.version,historyOnly:false,elapsedUnknown:false});const pastAfter=await archived.row();
  assert.deepEqual({liveUnknown:liveAfter.legacy.elapsedUnknown,archiveUnknown:pastAfter.legacy.elapsedUnknown},{liveUnknown:false,archiveUnknown:true},'even a trusted well-typed same-version audit must match the current history flag');
  assert.equal(canConfirmBooking(confirmation,liveAfter,f.now()),true);assert.equal(canResolveLegacy(admin,pastAfter),true);
});

test('effective scope selects the highest valid booking version before clocks and ignores future versions',async t=>{
  const f=await fixture(t);await f.observe(1,future);await f.origin();const booking=await f.row();await f.db.query('UPDATE eduson_booking.bookings SET version=12 WHERE id=$1',[booking.id]);
  await f.scope({version:11,historyOnly:false,elapsedUnknown:false},{at:'2020-01-01T00:00:00Z'});
  await f.scope({version:8,historyOnly:true,elapsedUnknown:true},{at:'2040-01-01T00:00:00Z'});
  await f.scope({version:13,historyOnly:true,elapsedUnknown:true},{at:'2050-01-01T00:00:00Z'});
  const row=await f.row();assert.equal(row.legacy.elapsedUnknown,false);assert.equal(row.legacy.managerName,'Original manager metadata');assert.equal(canConfirmBooking(confirmation,row,f.now()),true);
});

test('scope events cannot give ordinary rows legacy authority and no-scope legacy behavior stays compatible',async t=>{
  const f=await fixture(t);await f.observe(1,future);await f.scope({version:1,historyOnly:true,elapsedUnknown:true});assert.equal((await f.row()).legacy,null);
  f.setClock('2030-01-03T10:00:01Z');assert.equal(await f.service.expireUnconfirmed(),1);
  const old=await fixture(t);await old.observe(1,future);await old.origin();assert.equal((await old.row()).legacy.elapsedUnknown,true);old.setClock('2030-01-03T10:00:01Z');assert.equal(await old.service.expireUnconfirmed(),0);assert.equal(canResolveLegacy(admin,await old.row()),true);
});
