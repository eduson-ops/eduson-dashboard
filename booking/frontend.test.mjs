import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, addDays, weekDates, safeUrl, matchesSearch, confirmationTiming, makeDraftStore, isHourOverloaded, filterHourBookings } from './core.mjs';

test('business date uses Moscow at the UTC date boundary', () => {
  assert.equal(businessDate(new Date('2026-11-03T22:30:00Z')), '2026-11-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
test('calendar week begins Monday and crosses month boundaries', () => {
  assert.deepEqual(weekDates('2026-11-01'), ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
});
test('external links reject executable and protocol-relative URLs', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('//example.test'), '');
  assert.equal(safeUrl('https://example.test/a?b=1'), 'https://example.test/a?b=1');
});
test('CRM search ignores surrounding whitespace and case', () => {
  assert.equal(matchesSearch({crmUrl:'https://school.amocrm.ru/leads/detail/123', studentName:'Анна',phone:'+79991234567'}, '  123  '), true);
  assert.equal(matchesSearch({studentName:'Анна'}, 'анна'), true);
  assert.equal(matchesSearch({studentName:'Анна'}, 'Игорь'), false);
});
test('confirmation deadline does not treat a confirmed booking as overdue', () => {
  const booking = {confirmationDueAt:'2026-11-03T10:00:00Z',confirmationStatus:'pending'};
  assert.equal(confirmationTiming(booking, new Date('2026-11-03T10:01:00Z')).overdue, true);
  assert.equal(confirmationTiming({...booking,confirmationStatus:'confirmed'},new Date('2026-11-03T11:00:00Z')).overdue, false);
});
test('draft storage persists one submit key and isolates each user', () => {
  const data = new Map();
  const storage = {getItem:k=>data.get(k) ?? null, setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const first = makeDraftStore(storage,'u1');
  first.save('create',{studentName:'Мария',idempotencyKey:'stable-attempt'});
  assert.equal(makeDraftStore(storage,'u1').read('create').idempotencyKey,'stable-attempt');
  assert.deepEqual(makeDraftStore(storage,'u2').read('create'),{});
  first.remove('create');
  assert.deepEqual(first.read('create'),{});
});
test('canonical deficit flags age eligibility shortage even with enough total managers', () => {
  assert.equal(isHourOverloaded({managers:3,confirmed:2,deficit:1}),true);
  assert.equal(isHourOverloaded({managers:1,confirmed:2,deficit:0}),false);
  assert.equal(isHourOverloaded({managers:1,confirmed:2}),true);
  assert.equal(isHourOverloaded({managers:2,confirmed:2}),false);
});
test('hour drilldown applies the same inclusive age tag and search to all booking states', () => {
  const bookings=[
    {id:'lower',time:'12:00',age:8,studentName:'Анна',state:'scheduled'},
    {id:'upper',time:'12:00',age:9,studentName:'Анна',state:'cancelled'},
    {id:'too-young',time:'12:00',age:7,studentName:'Анна'},
    {id:'too-old',time:'12:00',age:10,studentName:'Анна'},
    {id:'other-hour',time:'13:00',age:8,studentName:'Анна'},
    {id:'other-search',time:'12:00',age:8,studentName:'Игорь'},
  ];
  assert.deepEqual(filterHourBookings(bookings,{time:'12:00',tag:'8-9',search:'анна'}).map(booking=>booking.id),['lower','upper']);
  assert.equal(filterHourBookings(bookings,{time:'12:00'}).length,5);
});
