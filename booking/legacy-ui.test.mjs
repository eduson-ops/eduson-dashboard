import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './core.mjs';

test('an unknown boolean remains distinct from an explicit negative answer', () => {
  assert.equal(core.booleanFact?.(null,'Есть','Нет'),'Не указано');
  assert.equal(core.booleanFact?.(undefined,'Есть','Нет'),'Не указано');
  assert.equal(core.booleanFact?.(false,'Есть','Нет'),'Нет');
  assert.equal(core.booleanFact?.(true,'Есть','Нет'),'Есть');
});

test('only an admin can resolve the unknown outcome of a transferred scheduled booking', () => {
  const booking={state:'scheduled',legacy:{source:'vds_sqlite',elapsedUnknown:true}};
  assert.equal(core.canResolveLegacy?.({role:'admin'},booking),true);
  assert.equal(core.canResolveLegacy?.({role:'confirmation'},booking),false);
  assert.equal(core.canResolveLegacy?.({role:'admin'},{...booking,state:'completed'}),false);
  assert.equal(core.canResolveLegacy?.({role:'admin'},{state:'scheduled'}),false);
  assert.equal(core.canResolveLegacy?.({role:'admin'},{...booking,legacy:{elapsedUnknown:false}}),false);
});

test('confirmation actions stop immediately after the deadline and never operate on archive rows',()=>{
  const actor={role:'confirmation'},booking={state:'scheduled',confirmationStatus:'pending',confirmationDueAt:'2026-11-04T10:00:00Z'};
  assert.equal(core.canConfirmBooking?.(actor,booking,new Date('2026-11-04T10:00:00Z')),true);
  assert.equal(core.canConfirmBooking?.(actor,booking,new Date('2026-11-04T10:00:00.001Z')),false);
  assert.equal(core.canConfirmBooking?.(actor,{...booking,historyOnly:true},new Date('2026-11-04T09:00:00Z')),false);
  assert.equal(core.canConfirmBooking?.({role:'sales'},booking,new Date('2026-11-04T09:00:00Z')),false);
  assert.equal(core.canConfirmBooking?.(actor,{...booking,state:'cancelled'},new Date('2026-11-04T09:00:00Z')),false);
});

test('archive rows expose neither assignment nor restoration actions',()=>{
  const admin={role:'admin'},booking={state:'scheduled',confirmationStatus:'confirmed',endsAt:'2026-11-05T13:00:00Z'};
  assert.equal(core.canAssignBooking?.(admin,booking),true);
  assert.equal(core.canAssignBooking?.(admin,{...booking,historyOnly:true}),false);
  assert.equal(core.canAssignBooking?.(admin,{...booking,confirmationStatus:'pending'}),false);
  assert.equal(core.canRestoreBooking?.(admin,{...booking,state:'cancelled'},new Date('2026-11-04T09:00Z')),true);
  assert.equal(core.canRestoreBooking?.(admin,{...booking,state:'cancelled',historyOnly:true},new Date('2026-11-04T09:00Z')),false);
  assert.equal(core.canRestoreBooking?.(admin,{...booking,state:'cancelled'},new Date('2026-11-06T09:00Z')),false);
});

test('inactive sales appear only in archive resolution choices and never change the active assignment directory',()=>{
  const active=[{id:'live',name:'Действующий',role:'sales',active:true}];
  const users=[...active,{id:'past',name:'Архивный',role:'sales',active:false},{id:'confirm',role:'confirmation',active:false}];
  const archived={historyOnly:true};
  assert.deepEqual(core.legacyResolutionManagers?.({role:'admin'},archived,active,users)?.map(x=>x.id),['live','past']);
  assert.deepEqual(core.legacyResolutionManagers?.({role:'admin'},{},active,users)?.map(x=>x.id),['live']);
  assert.deepEqual(core.legacyResolutionManagers?.({role:'confirmation'},archived,active,users),[]);
  assert.deepEqual(active.map(x=>x.id),['live']);
});

test('contact correction is limited to permitted roles and the current booking owner', () => {
  const booking={createdBy:'kc-owner',assignedTo:'sales-owner'};
  assert.equal(core.canEditDetails?.({id:'kc-owner',role:'call_center'},booking),true);
  assert.equal(core.canEditDetails?.({id:'kc-other',role:'call_center'},booking),false);
  assert.equal(core.canEditDetails?.({id:'sales-owner',role:'sales'},booking),true);
  assert.equal(core.canEditDetails?.({id:'sales-other',role:'sales'},booking),false);
  assert.equal(core.canEditDetails?.({role:'confirmation'},booking),true);
  assert.equal(core.canEditDetails?.({role:'admin'},booking),true);
});

test('details patch omits unchanged empty and unknown fields and never includes assignment or dates', () => {
  const original={studentName:'',parentName:'',phone:'',crmUrl:'',age:7,hasPc:null,parentPresent:false,comment:''};
  const form={...original,phone:'00000000000',age:'7',hasPc:'',parentPresent:'false',date:'2026-11-01',assignedTo:'different-user'};
  assert.deepEqual(core.changedDetails?.(original,form),{phone:'00000000000'});
  assert.deepEqual(core.changedDetails?.(original,{...form,hasPc:'false'}),{phone:'00000000000',hasPc:false});
  assert.deepEqual(core.changedDetails?.({...original,age:null},{...original,age:'',hasPc:'',parentPresent:'false'}),{});
});

test('saving an untouched mixed-capacity day preserves every interval override', () => {
  const day={date:'2026-11-01',version:4,reserveCapacity:1,intervals:[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'11:00',end:'12:00',reserveCapacity:1},{start:'14:00',end:'15:00'}]};
  const payload=core.schedulePayload?.(day,{managerId:'manager-id',ageGroups:['5-7']});
  assert.deepEqual(payload,{managerId:'manager-id',date:day.date,intervals:day.intervals,ageGroups:['5-7'],reserveCapacity:1,version:4});
  assert.equal(core.effectiveReserveCapacity?.(day.intervals[0],day),0);
  assert.equal(core.effectiveReserveCapacity?.(day.intervals[2],day),1);
});

test('an explicit day-wide reserve change replaces overrides without mutating the previous draft', () => {
  const day={reserveCapacity:1,intervals:[{start:'10:00',end:'11:00',reserveCapacity:0},{start:'11:00',end:'12:00',reserveCapacity:1}]};
  const changed=core.setDayReserveCapacity?.(day,0);
  assert.deepEqual(changed?.intervals.map(interval=>interval.reserveCapacity),[0,0]);
  assert.equal(changed?.reserveCapacity,0);
  assert.deepEqual(day.intervals.map(interval=>interval.reserveCapacity),[0,1]);
});
