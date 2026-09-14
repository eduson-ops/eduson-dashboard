import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const core=createRequire(import.meta.url)('../analytics-core.js');
const manager='Иванов А.';
const lesson=(crm,day='03.09.2026')=>['03.09.2026 10:00',manager,day,'12:00',crm,'','Python'];
const payment=(crm,day='08.09.2026',type='Первичная',amount='100')=>['08.09.2026 10:00',manager,crm,day,'Python','Пакет',type,amount];
const input=(form,payments)=>({form:[[],...form],payments:[[],...payments],managers:[[],[manager,'да']]});
const month={from:'2026-09-01',to:'2026-09-30'};

test('three lesson reports and eighteen primary payments with one overlap count twenty MK',()=>{
 const model=core.buildModel(input([lesson('101'),lesson('102'),lesson('103')],Array.from({length:18},(_,i)=>payment(String(103+i)))));
 const selection=core.select(model,{...month,manager});
 assert.equal(selection.totals.mk,20);
 assert.equal(selection.totals.paid,18);
 assert.equal(selection.totals.conv,90);
 assert.equal(model.lessonReports.length,3);
 assert.equal(model.lessons.filter(r=>r.source==='payments').length,17);
 assert.equal(core.select(model,{...month,includeRenewals:false}).totals.mk,20);
});

test('repeated payments keep their money but add only one paid lesson per exact deal across periods',()=>{
 const model=core.buildModel(input([], [payment('101','08.09.2026'),payment('101','31.08.2026'),payment('101','09.09.2026','Продление')]));
 assert.equal(model.lessons.length,1);
 assert.equal(model.lessons[0].date,'31.08.2026');
 assert.equal(model.lessons[0].source,'payments');
 assert.equal(model.lessons[0].row,3);
 assert.ok(model.payments.every(r=>r.lessonRow===3 && r.lessonSource==='payments'));
 assert.equal(core.select(model,month).totals.mk,0);
 assert.equal(core.select(model,month).totals.paid,2);
 assert.equal(core.select(model,month).totals.rev,200);
});

test('known lesson date takes precedence and ambiguous reports do not create an extra paid lesson',()=>{
 const model=core.buildModel(input([lesson('101'),lesson('102'),lesson('102','04.09.2026')],[payment('101'),payment('102')]));
 assert.equal(model.lessons.length,3);
 assert.equal(model.payments[0].lessonSource,'form');
 assert.equal(model.payments[1].lessonRow,null);
 assert.ok(model.payments[1].issues.includes('ambiguous_lesson'));
 assert.equal(core.select(model,{from:'2026-09-08',to:'2026-09-08'}).totals.mk,0);
});

test('renewals, refunds and unreadable amounts never add a paid lesson',()=>{
 const model=core.buildModel(input([], [payment('101','08.09.2026','Продление'),payment('102','08.09.2026','Первичная','-100'),payment('103','08.09.2026','Первичная','?')]));
 assert.equal(model.lessons.length,0);
});

test('without a CRM ID separate paid reports remain visible with source diagnostics',()=>{
 const model=core.buildModel(input([], [payment(''),payment('')]));
 assert.equal(model.lessons.length,2);
 assert.deepEqual(model.lessons.map(r=>r.row),[2,3]);
 assert.ok(model.payments.every(r=>r.issues.includes('missing_crm')));
});

test('a paid lesson with conflicting managers is counted once and flagged without assigning it arbitrarily',()=>{
 const other=payment('101');other[1]='Петров Б.';
 const model=core.buildModel(input([], [payment('101'),other]));
 assert.equal(model.lessons.length,1);assert.equal(model.lessons[0].manager,'');
 assert.ok(model.payments.every(r=>r.issues.includes('conflicting_lesson_manager')));
 assert.equal(core.select(model,{...month,manager}).totals.rev,100);
});
