import test from 'node:test';
import assert from 'node:assert/strict';
import {filterHourMetricBookings,rollingScheduleDates,scheduleHourEntries,setScheduleHour,unionScheduleWeek} from './core.mjs';

test('each hourly metric opens the facts counted by that cell, including pending reserve allocations',()=>{
  const base={date:'2026-11-04',time:'12:00',age:10};
  const bookings=[
    {...base,id:'pending',state:'scheduled',confirmationStatus:'pending'},
    {...base,id:'confirmed',state:'scheduled',confirmationStatus:'confirmed'},
    {...base,id:'held',state:'completed',confirmationStatus:'confirmed'},
    {...base,id:'cc',state:'cancelled',cancelSource:'call_center'},
    {...base,id:'confirmed-cancelled',state:'cancelled',confirmationStatus:'confirmed',cancelSource:'call_center'},
    {...base,id:'sale',state:'cancelled',cancelSource:'sales'},
    {...base,id:'admin',state:'cancelled',cancelSource:'admin'},
    {...base,id:'other-date',date:'2026-11-05',state:'completed'},
  ];
  const filter=metric=>filterHourMetricBookings(bookings,{...base,tag:'10-12',metric,allocations:[{bookingId:'pending',kind:'reserve'}]}).map(row=>row.id);
  assert.deepEqual(filter('total'),['pending','confirmed','held','cc','confirmed-cancelled','sale','admin']);
  assert.deepEqual(filter('reserve'),['pending']);
  assert.deepEqual(filter('confirmed'),['confirmed','held','confirmed-cancelled']);
  assert.deepEqual(filter('cancelledConfirmation'),['cc','confirmed-cancelled']);
  assert.deepEqual(filter('cancelledSales'),['sale']);
  assert.deepEqual(filter('completed'),['held']);
});

test('capacity waiting detail contains only active records waiting for a real place',()=>{
  const base={date:'2026-11-04',time:'11:00',age:10};
  const bookings=[{...base,id:'ordinary',state:'scheduled',capacityHold:false},{...base,id:'held',state:'scheduled',capacityHold:true},{...base,id:'cancelled',state:'cancelled',capacityHold:true},{...base,id:'other-hour',time:'12:00',state:'scheduled',capacityHold:true}];
  assert.deepEqual(filterHourMetricBookings(bookings,{...base,metric:'capacityHeld'}).map(b=>b.id),['held']);
});

test('schedule editor spans 14 rolling dates including the 21:00 lesson ending at 22:00',()=>{
  const dates=rollingScheduleDates('2026-12-29');
  assert.equal(dates.length,14);assert.equal(dates[0],'2026-12-29');assert.equal(dates.at(-1),'2027-01-11');
  const day=setScheduleHour({date:dates[0],intervals:[],reserveCapacity:1},21);
  assert.deepEqual(day.intervals,[{start:'21:00',end:'22:00',reserveCapacity:1}]);
});

test('hour toggles preserve mixed reserve overrides and do not mutate the previous draft',()=>{
  const original={date:'2026-11-04',version:3,reserveCapacity:1,intervals:[{start:'10:00',end:'12:00',reserveCapacity:0},{start:'12:00',end:'14:00',reserveCapacity:1}]};
  const changed=setScheduleHour(original,11);
  assert.deepEqual([...scheduleHourEntries(changed)],[[10,0],[12,1],[13,1]]);
  assert.equal(changed.version,3);assert.equal(original.intervals[0].end,'12:00');
  assert.deepEqual([...scheduleHourEntries(setScheduleHour(changed,11,{reserveCapacity:1}))],[[10,0],[11,1],[12,1],[13,1]]);
});

test('copy week adds source hours while retaining target hours, reserves and date versions',()=>{
  const dates=rollingScheduleDates('2026-11-04');
  const days=dates.map((date,index)=>({date,version:index+1,reserveCapacity:1,intervals:[]}));
  days[0]=setScheduleHour(days[0],17,{reserveCapacity:0});
  days[0]=setScheduleHour(days[0],18,{reserveCapacity:0});
  days[7]=setScheduleHour(days[7],18,{reserveCapacity:1});
  days[7]=setScheduleHour(days[7],12,{reserveCapacity:1});
  const copy=unionScheduleWeek(days,dates.slice(0,7),dates.slice(7));
  assert.deepEqual([...scheduleHourEntries(copy[7])],[[12,1],[17,0],[18,1]]);
  assert.equal(copy[7].version,8);assert.deepEqual(copy[0],days[0]);
});
