import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './core.mjs';

test('booking widget only offers actual free future slots for the selected Moscow day',()=>{
  const now=new Date('2026-11-04T09:00:00Z');
  const slot=(time,remaining=1,date='2026-11-04')=>({date,time,remaining,capacity:2});
  const rows=[slot('14:00',2),slot('12:00'),slot('11:00'),slot('13:00',0),slot('15:00',-1),slot('16:00',Infinity),slot('17:00',1,'2026-11-05'),slot('25:00'),slot('14:00',2)];
  assert.deepEqual(core.selectableBookingSlots?.(rows,'2026-11-04',now).map(s=>[s.time,s.remaining]),[['14:00',2]]);
});

test('changing an age or an availability result cannot retain an unavailable booking selection',()=>{
  const now=new Date('2026-11-04T06:00:00Z');
  const rows=[{date:'2026-11-04',time:'12:00',remaining:1}];
  assert.equal(core.isBookingSelectionAvailable?.(rows,'2026-11-04','12:00',now),true);
  assert.equal(core.isBookingSelectionAvailable?.([{...rows[0],remaining:0}],'2026-11-04','12:00',now),false);
  assert.equal(core.isBookingSelectionAvailable?.(rows,'2026-11-05','12:00',now),false);
  assert.equal(core.isBookingSelectionAvailable?.(rows,'2026-11-04','13:00',now),false);
});

test('the date rail clamps to today and keeps a future selected day in its five-day window',()=>{
  assert.deepEqual(core.bookingDateRail?.('2026-11-04','2026-11-04'),['2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08']);
  assert.deepEqual(core.bookingDateRail?.('2026-12-01','2026-11-04'),['2026-11-29','2026-11-30','2026-12-01','2026-12-02','2026-12-03']);
});

test('the displayed 60-minute interval keeps an explicit next-day marker at midnight',()=>{
  assert.deepEqual(core.bookingIntervalEnd?.('18:00'),{time:'19:00',dayOffset:0});
  assert.deepEqual(core.bookingIntervalEnd?.('23:59'),{time:'00:59',dayOffset:1});
  assert.equal(core.bookingIntervalEnd?.('25:00'),null);
});

test('confirmation display preserves known facts without inventing a held legacy outcome',()=>{
  const booking={state:'scheduled',confirmationStatus:'pending',legacy:{elapsedUnknown:true}};
  assert.deepEqual(core.bookingStatusPresentation?.(booking),{tone:'pending',label:'Ожидает подтверждения',outcomeUnknown:true});
  assert.deepEqual(core.bookingStatusPresentation?.({...booking,confirmationStatus:'confirmed'}),{tone:'confirmed',label:'Урок подтверждён',outcomeUnknown:true});
  assert.deepEqual(core.bookingStatusPresentation?.({...booking,state:'cancelled'}),{tone:'cancelled',label:'Отменён',outcomeUnknown:false});
  assert.deepEqual(core.bookingStatusPresentation?.({...booking,state:'completed'}),{tone:'completed',label:'Завершён',outcomeUnknown:false});
});
