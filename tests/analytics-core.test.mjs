import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../analytics-core.js');
const raw = (lessons = [], payments = [], cancels = []) => ({form:[[],...lessons],payments:[[],...payments],cancels:[[],...cancels],managers:[[],['Иванов А.','да']]});
const lesson = (crm='12345',day='14.09.2026',manager='Иванов А.') => ['14.09.2026 10:00',manager,day,'11:00',crm,'record','Scratch','','','','agreement'];
const pay = (amount='100',crm='12345',day='15.09.2026',type='Первичная',manager='Иванов А.') => ['15.09.2026 10:00',manager,crm,day,'Scratch','pack',type,amount];
const query={from:'2026-09-01',to:'2026-09-30'};
test('optional report columns follow headers instead of treating a money column as marketing channel',()=>{
 const input=raw([lesson()],[pay()]);
 input.form[0]=Array(12).fill('');input.form[0].push('С какого канала пришли','Сумма оплаты');input.form[1][12]='Яндекс';input.form[1][13]='10000';
 input.payments[0]=Array(8).fill('');input.payments[0].push('Ссылка на запись урока');input.payments[1][8]='https://example.com/recording';
 const model=core.buildModel(input);assert.equal(model.lessons[0].channel,'Яндекс');assert.equal(model.lessons[0].notes,'');assert.equal(model.payments[0].rec,'https://example.com/recording');
});
test('all payments remain independent and lesson event date never moves',()=>{
 const model=core.buildModel(raw([lesson()],[pay('100'),pay('200')]));
 assert.equal(model.lessons.length,1); assert.equal(model.payments.length,2);
 assert.equal(core.select(model,query).totals.rev,300);
 assert.equal(core.select(model,{from:'2026-09-14',to:'2026-09-14'}).totals.mk,1);
 assert.equal(core.select(model,{from:'2026-09-15',to:'2026-09-15'}).totals.mk,0);
 assert.equal(model.payments[0].lessonRow,2);
});
test('unmatched, missing and ambiguous CRM never create or choose a lesson',()=>{
 const model=core.buildModel(raw([lesson(),lesson()],[pay('100'),pay('200',''),pay('300','99999')]));
 assert.equal(model.lessons.length,2); assert.ok(model.payments.every(p=>p.lessonRow===null));
 assert.equal(core.select(model,query).totals.rev,600);
 assert.equal(core.extractCrmId('https://crm.test/leads/detail/12345?utm=99999'),'12345');
 assert.equal(core.extractCrmId('https://crm.test/foo?phone=1234567'),'');
});
test('money keeps cents and sign; invalid amount is diagnostic rather than zero',()=>{
 const model=core.buildModel(raw([lesson()],[pay('1 234,50'),pay('-200,25'),pay('bad'),pay('1,234,5')]));
 const t=core.select(model,query).totals;
 assert.equal(t.rev,1034.25); assert.equal(t.paid,1);assert.equal(t.avg,1034.25);
 assert.equal(model.payments[2].rev,null); assert.ok(model.payments[2].issues.includes('invalid_amount'));
 assert.ok(model.payments[1].issues.includes('negative_correction'));
});
test('renewal toggle changes payments and conversions but never actual lesson count',()=>{
 const model=core.buildModel(raw([lesson()],[pay('100'),pay('50','12345','15.09.2026','Продление')]));
 const all=core.select(model,query).totals, primary=core.select(model,{...query,includeRenewals:false}).totals;
 assert.equal(all.mk,1);assert.equal(all.paid,2);assert.equal(all.conv,200);assert.equal(all.renewalPaid,1);
 assert.equal(primary.paid,1);assert.equal(primary.rev,100);assert.equal(primary.mk,1);
});
test('unknown managers count; unique initials map, same surnames do not merge',()=>{
 const input=raw([lesson('1','14.09.2026','Иванов Борис'),lesson('2','14.09.2026','Неизвестный')]);
 input.managers.push(['Иванов Б.','нет']);
 const model=core.buildModel(input);
 assert.equal(model.lessons[0].manager,'Иванов Б.');assert.equal(core.select(model,query).totals.mk,2);
 assert.equal(core.select(model,{...query,manager:'Неизвестный'}).totals.mk,1);
});
test('identical payloads flag both rows without silent dedup or timestamp uniqueness',()=>{
 const model=core.buildModel(raw([],[pay(),pay(),pay('200')]));
 assert.equal(model.payments.length,3);assert.equal(core.select(model,query).totals.rev,400);
 assert.ok(model.payments[0].issues.includes('possible_duplicate'));assert.ok(model.payments[1].issues.includes('possible_duplicate'));
 assert.ok(!model.payments[2].issues.includes('possible_duplicate'));
});
test('strict dates, no payment timestamp fallback, Moscow Sunday and offsets',()=>{
 assert.equal(core.dateKey('31.02.2026'),'');assert.equal(core.dateKey('2026-09-14T22:30:00Z'),'2026-09-15');
 assert.deepEqual(core.period('week',{now:'2026-09-13T12:00:00Z'}),{from:'2026-09-07',to:'2026-09-13'});
 assert.deepEqual(core.period('today',{now:'2026-09-14T22:30:00Z'}),{from:'2026-09-15',to:'2026-09-15'});
 assert.deepEqual(core.period('custom',{from:'2026-10-01',to:'2026-09-01'}),{from:'',to:''});
 assert.equal(core.select(core.buildModel(raw([],[pay('100','12345','')])),query).totals.rev,0);
});
test('empty denominators are null and cancellation attendance is report proxy',()=>{
 const model=core.buildModel(raw([],[pay()],[['14.09.2026 10:00','','reason','','','','','Иванов А.']]));
 const t=core.select(model,query).totals;
 assert.equal(t.conv,null);assert.equal(t.rpm,null);assert.equal(t.cancelled,1);assert.equal(t.attendance,0);
 assert.equal(core.select(core.buildModel(raw()),query).totals.avg,null);
 assert.deepEqual(core.daily(model,query).map(r=>r.day),['2026-09-14','2026-09-15']);
});
test('nonblank malformed rows remain facts with provenance; source input is not mutated',()=>{
 const input=raw([['timestamp']], [['timestamp']]); const before=JSON.stringify(input);
 const model=core.buildModel(input);assert.equal(model.lessons.length,1);assert.equal(model.payments.length,1);
 assert.equal(model.lessons[0].source,'form');assert.equal(model.lessons[0].row,2);
 assert.ok(model.lessons[0].issues.includes('invalid_date'));assert.equal(JSON.stringify(input),before);
});
test('unassigned manager selector is distinct from all managers',()=>{
 const model=core.buildModel(raw([lesson(),lesson('99999','14.09.2026','')]));
 assert.equal(core.select(model,{...query,manager:'__unassigned__'}).totals.mk,1);
 assert.equal(core.select(model,{...query,manager:''}).totals.mk,2);
});
