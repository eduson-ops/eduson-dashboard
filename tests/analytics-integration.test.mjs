import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const html = read('index.html');
const plain = value => JSON.parse(JSON.stringify(value));
const headers = {
  form:['Отметка времени','Кто провёл урок?','Дата МК','Время МК','Ссылка на CRM','Ссылка на запись урока','Практика','Возраст','Пакет','Вариант оплаты','\n\nДоговорённости с клиентом','Итоговое возражение','С какого канала пришли','Сумма оплаты'],
  payments:['Отметка времени','Кто провёл урок','Ссылка на CRM','Дата оплаты','Практика','Пакет','Способ оплаты','Сумма оплаты'],
  managers:['Имя','Активен'],targets:['Месяц','МК план','Выручка план','Ср. чек план','₽/МК план'],
  slots:['Дата','Время','Менеджер'],schedule:['Менеджер','Дата','Время'],
  cancels:['Отметка времени','Ссылка на AMO','Причина отмены','Первичная отмена','Как пробовали связаться','Возраст','Комментарий','МИМК'],
};
const csv = rows => rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n');
const lesson = (manager='Иванов А.', day='14.09.2026', crm='101') => ['14.09.2026 12:00',manager,day,'11:00',crm,'','Scratch','','','','Позвонить'];
const payment = (amount, manager='Иванов А.', day='15.09.2026', type='Первичная', crm='101') => ['15.09.2026 12:00',manager,crm,day,'Python','Пакет',type,amount];
const data = (overrides={}) => Object.fromEntries(Object.entries(headers).map(([key, names]) => [key,[[...names], ...(overrides[key] || (key==='managers' ? [['Иванов А.','да'],['Петров Б.','да']] : []))]]));

// These sinks record DOM writes and Chart inputs. They do not emulate layout,
// browser events, Chart.js rendering, or execute any network request.
function element(id='') {
  const classes=new Set(), children=new Map();
  return { id, value:'', textContent:'', innerHTML:'', style:{}, dataset:{}, hidden:false,
    classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,enabled){const on=enabled ?? !classes.has(x);if(on)classes.add(x);else classes.delete(x);return on;}},
    setAttribute(key,value){this[key]=value;}, getAttribute(key){return this[key] ?? null;},
    querySelector(selector){if(!children.has(selector))children.set(selector,element(selector));return children.get(selector);},
    querySelectorAll(){return [];}, addEventListener(){}, appendChild(){},
    closest(selector){return this.querySelector('parent:'+selector);},
    get parentElement(){return this.querySelector('parent');},
  };
}
function dashboard(raw) {
  const ids=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],element(match[1])]));
  const selectors=new Map(), clipboard=[], requests=[], failures=new Map(), waits=new Map(), storage=new Map();
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-09-15T12:00:00Z']));} static now(){return new Date('2026-09-15T12:00:00Z').getTime();} }
  const document={
    getElementById:id=>ids.get(id) || null,
    querySelector(selector){if(!selectors.has(selector))selectors.set(selector,element(selector));return selectors.get(selector);},
    querySelectorAll(selector){return selector==='.period-error' ? [...ids.values()].filter(el=>el.id.endsWith('period-error')) : [];},
    createElement:()=>element(),
  };
  const runtime=vm.createContext({Date:FixedDate,URL,AbortController,document,
    localStorage:{getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value)},
    navigator:{clipboard:{writeText:async text=>{clipboard.push(text);}}},
    console:{log(){},warn(){},error(message,error){throw error;}},
    setTimeout:()=>1,clearTimeout(){},
    Chart:class { constructor(canvas,config){this.canvas=canvas;this.config=config;}destroy(){this.destroyed=true;} },
    // Unrelated scheduling/navigation sinks are outside the financial integration.
    renderOperations(){},renderSchedule(){},renderSlots(){},updatePersonaFooter(){},maybeShowOnboarding(){},showPage(){},
  });
  runtime.window=runtime;
  const run = code => vm.runInContext(code,runtime);
  const inline=(start,end)=>{const from=html.indexOf(start),to=html.indexOf(end,from);assert.ok(from>=0 && to>from,`${start} exists in the page`);run(html.slice(from,to));};
  // Use the shipped sources in their actual script order, including inline state
  // and request parsing. No copies of production calculations live in this test.
  for(const file of ['operations.js','analytics-core.js','dashboard-analytics.js','dashboard-load.js','analytics-views.js'])run(read(file));
  inline('const SHEET_ID =','function calDaysLeft(');
  inline('function loadAll(', '// OPERATIONAL CONTROL');
  inline('function recordOpsSource(', 'function opsMessage(');
  inline('function sparkPath(', '// МВП');
  inline('function isMvp(', 'function scheduledDate(');
  inline('function dc(', 'function switchAnalyticsTab(');
  inline('function backMgr(', 'function agrBtn(');
  inline('function closePersonaPicker(', 'function renderPersonaList(');
  inline('function setPersona(', 'function updatePersonaFooter(');
  inline('function shareToast(', '</script>');
  run('var scheduleData={};');
  const urls=run('URLS');
  runtime.fetch=async (url,options={})=>{
    const key=Object.keys(urls).find(key=>new URL(url).searchParams.get('gid')===new URL(urls[key]).searchParams.get('gid'));
    assert.ok(key,'request points to an existing dashboard source');
    assert.equal(options.method ?? 'GET','GET','refresh is read-only');
    requests.push(key);
    if(waits.has(key))await waits.get(key);
    return failures.has(key)?{ok:false,status:failures.get(key)}:{ok:true,text:async()=>csv(raw[key])};
  };
  function period(from='2026-09-01',to='2026-09-30',prefix='main-'){
    ids.get(prefix+'df-from').value=from;ids.get(prefix+'df-to').value=to;
    runtime[prefix?'applyMainCustom':'applyCustom']();
  }
  return {runtime,run,ids,clipboard,requests,failures,waits,storage,period,raw};
}
const money = value => value.toLocaleString('ru-RU',{maximumFractionDigits:0})+' ₽';
const chart = (app,key) => app.run('charts')[key]?.config.data;
const chartSum = (app,key) => chart(app,key).datasets.reduce((sum,series)=>sum+series.data.reduce((s,n)=>s+(n ?? 0),0),0);

test('CSV refresh includes paid-only MK without duplicating linked lessons or raw form reports',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('100'),payment('200'),payment('50','Иванов А.','15.09.2026','Первичная','999')]}));
  await app.runtime.loadAll();app.period();
  assert.equal(app.requests.length,7);
  assert.equal(app.run('actualLessonReports.length'),1);
  assert.equal(app.run('actualLessonReports[0].practice'),'Scratch');
  assert.equal(app.run('lessons.length'),2);
  assert.equal(app.run('analyticsModel.payments.length'),3);
  assert.equal(app.ids.get('kv-rev').textContent,money(350));
  assert.equal(app.ids.get('kv-mk').textContent,'2');
  assert.equal(app.ids.get('kv-conv').textContent,'150%');
  assert.equal(chartSum(app,'rev'),350);
  assert.equal(chartSum(app,'revday'),350);
  assert.deepEqual(plain(chart(app,'timeSlot').datasets[0].data),[1,1]);
});

test('twenty reconciled MK and ninety percent reach cards, manager detail, register and copied summary',async()=>{
  const reports=[lesson('Иванов А.','03.09.2026','101'),lesson('Иванов А.','04.09.2026','102'),lesson('Иванов А.','10.09.2026','103')];
  const payments=Array.from({length:18},(_,i)=>payment('100','Иванов А.','10.09.2026','Первичная',String(101+i*3)));
  const app=dashboard(data({form:reports,payments}));
  await app.runtime.loadAll();app.period();app.runtime.setAnalyticsMgr('Иванов А.');app.runtime.openMgr('Иванов А.');
  assert.equal(app.ids.get('kv-mk').textContent,'20');assert.equal(app.ids.get('kv-conv').textContent,'90%');
  assert.match(app.ids.get('mstats').innerHTML,/>20</);assert.match(app.ids.get('mstats').innerHTML,/>90%</);
  assert.match(app.ids.get('mlessons').innerHTML,/Проведённые МК · 20/);
  assert.match(app.ids.get('mlessons').innerHTML,/По дате первичной оплаты/);
  assert.match(app.ids.get('mlessons').innerHTML,/МК из оплаты/);
  app.runtime.shareReport();await Promise.resolve();
  assert.match(app.clipboard[0],/Проведено МК: 20/);assert.match(app.clipboard[0],/Конверсия: 90%/);
});

test('a failed refresh retains the snapshot while hiding only metrics that depend on it',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('125.50')]}));
  await app.runtime.loadAll();app.period();
  const snapshot=app.run('sourceSnapshots.payments');
  const previousChart=app.run('charts.rev');
  app.failures.set('payments',503);
  app.raw.form.push(lesson('Петров Б.','15.09.2026','202'));
  await app.runtime.loadAll();
  assert.equal(app.run('sourceSnapshots.payments'),snapshot);
  assert.equal(app.run('analyticsModel.payments[0].rev'),125.5);
  assert.equal(app.run('opsSourceStates.payments.state'),'error');
  assert.ok(app.run('opsSourceStates.payments.lastSuccessAt'));
  for(const id of ['kv-rev','kv-avg','kv-rpm','kv-conv'])assert.equal(app.ids.get(id).textContent,'—',id);
  assert.equal(app.ids.get('kv-mk').textContent,'—','MK count depends on both forms');
  assert.equal(chart(app,'timeSlot'),undefined);
  assert.equal(chart(app,'rev'),undefined);
  assert.equal(chart(app,'revday'),undefined);
  assert.equal(previousChart.destroyed,true);
  app.runtime.shareReport();assert.equal(app.clipboard.length,0);
  assert.match(app.ids.get('copy-toast').textContent,/недоступна/);
  app.failures.delete('payments');app.failures.set('form',503);
  await app.runtime.loadAll();
  assert.equal(app.ids.get('kv-rev').textContent,money(125.5));
  assert.equal(app.ids.get('kv-avg').textContent,money(125.5));
  for(const id of ['kv-mk','kv-rpm','kv-conv'])assert.equal(app.ids.get(id).textContent,'—',id);
  assert.equal(chart(app,'timeSlot'),undefined);
  app.failures.clear();app.raw.payments=[app.raw.payments[0]];
  await app.runtime.loadAll();
  assert.equal(app.ids.get('kv-rev').textContent,money(0),'healthy empty data is a real zero');
  assert.equal(app.run('analyticsModel.payments.length'),0);
});

test('partial source responses cannot expose a mixed generation or copy stale figures',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('100')]}));await app.runtime.loadAll();app.period();
  let release;
  app.waits.set('payments',new Promise(resolve=>{release=resolve;}));
  app.raw.form.push(lesson('Иванов А.','15.09.2026','102'));
  app.raw.payments.push(payment('200'));
  const refresh=app.runtime.loadAll();
  await new Promise(resolve=>setImmediate(resolve));
  try{
    assert.equal(app.run('opsSourceStates.form.state'),'success');
    assert.equal(app.run('opsSourceStates.payments.state'),'loading');
    assert.equal(app.runtime.analyticsReady(['form']),false,'fresh rows are not published before the whole generation is ready');
    assert.equal(app.ids.get('kv-rev').textContent,'—');
    assert.equal(app.ids.get('kv-mk').textContent,'—');
    app.runtime.shareReport();assert.equal(app.clipboard.length,0);
  }finally{release();await refresh;}
  assert.equal(app.ids.get('kv-rev').textContent,money(300));
  assert.equal(app.ids.get('kv-mk').textContent,'2');
  assert.equal(app.ids.get('kv-conv').textContent,'100%');
});

test('same-width changed source columns are rejected instead of relabelling payment facts',async()=>{
  const app=dashboard(data({payments:[payment('100')]}));await app.runtime.loadAll();app.period();
  const snapshot=app.run('sourceSnapshots.payments');
  [app.raw.payments[0][3],app.raw.payments[0][7]]=[app.raw.payments[0][7],app.raw.payments[0][3]];
  await app.runtime.loadAll();
  assert.equal(app.run('sourceSnapshots.payments'),snapshot);
  assert.equal(app.run('opsSourceStates.payments.state'),'error');
  assert.match(app.run('opsSourceStates.payments.message'),/заголовки|столбцы/i);
  assert.equal(app.ids.get('kv-rev').textContent,'—');
  assert.equal(app.run('analyticsModel.payments[0].rev'),100);
});

test('period and personal mode drive main cards, analytics charts, detail and copied report together',async()=>{
  const app=dashboard(data({form:[lesson(),lesson('Иванов А.','16.09.2026','102'),lesson('Петров Б.')],payments:[payment('100'),payment('200','Иванов А.','16.09.2026','Первичная','102'),payment('900','Петров Б.')]}));
  await app.runtime.loadAll();app.period('2026-09-14','2026-09-15','');
  app.runtime.setAnalyticsMgr('Петров Б.');app.runtime.openMgr('Петров Б.');
  app.runtime.setPersona('Иванов А.');
  assert.equal(app.storage.get('eks-me'),'Иванов А.');
  assert.equal(app.run('analyticsMgr'),'');
  assert.equal(app.run('currentDetailManager'),'');
  assert.equal(app.ids.get('mgr-detail').style.display,'none');
  assert.deepEqual(plain(app.runtime.analyticsQuery()),{from:'2026-09-14',to:'2026-09-15',manager:'Иванов А.',includeRenewals:true});
  assert.equal(app.ids.get('kv-rev').textContent,money(100));
  assert.equal(chartSum(app,'revday'),100);
  assert.equal(chartSum(app,'retMonth'),100);
  assert.deepEqual(plain(app.runtime.visibleMain()),plain(app.runtime.visibleAnalytics()));
  app.runtime.openMgr('Иванов А.');assert.equal(chartSum(app,'mw'),100);
  app.runtime.shareReport();await Promise.resolve();
  assert.match(app.clipboard[0],/14\.09\.2026 — 15\.09\.2026/);
  assert.match(app.clipboard[0],/Иванов А\./);
  assert.match(app.clipboard[0],/Выручка: 100 ₽/);
  assert.match(app.clipboard[0],/Проведено МК: 1/);
  assert.doesNotMatch(app.clipboard[0],/Петров|900|200 ₽/);
});

test('invalid custom dates keep the previous selection and show a corrective message',async()=>{
  const app=dashboard(data({payments:[payment('75')]}));await app.runtime.loadAll();app.period();
  const previous=plain(app.runtime.analyticsQuery()),value=app.ids.get('kv-rev').textContent;
  app.period('2026-09-20','2026-09-10');
  assert.deepEqual(plain(app.runtime.analyticsQuery()),previous);
  assert.equal(app.ids.get('kv-rev').textContent,value);
  assert.match(app.ids.get('main-period-error').textContent,/начало не позже окончания/);
  app.period('2026-09-15','2026-09-15');
  assert.equal(app.ids.get('main-period-error').textContent,'');
  assert.equal(app.runtime.analyticsQuery().from,'2026-09-15');
});

test('a delayed payment for an already reported MK does not move the lesson to payment day',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('100')]}));await app.runtime.loadAll();app.period('2026-09-15','2026-09-15');
  assert.equal(app.ids.get('kv-rev').textContent,money(100));assert.equal(app.ids.get('kv-mk').textContent,'0');
  assert.equal(app.ids.get('kv-conv').textContent,'—');assert.equal(app.ids.get('kv-rpm').textContent,'—');
  assert.deepEqual(plain(chart(app,'conv').datasets[0].data),[null]);
  assert.equal(chart(app,'timeSlot'),undefined,'payment does not create an attendance point');
  app.runtime.shareReport();await Promise.resolve();assert.match(app.clipboard[0],/Конверсия: —/);assert.match(app.clipboard[0],/Проведено МК: 0/);
});

test('renewal switch updates the same financial scope in every view and share output',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('100'),payment('50','Иванов А.','15.09.2026','Продление')]}));
  await app.runtime.loadAll();app.period();app.runtime.openMgr('Иванов А.');
  for(const enabled of [true,false,true]){
    if(app.run('COUNT_RENEWALS')!==enabled)app.runtime.toggleRenewals();
    const expected=enabled?150:100;
    assert.equal(app.ids.get('kv-rev').textContent,money(expected));assert.equal(app.ids.get('kv-mk').textContent,'1');
    for(const key of ['rev','team','revday','mw','retMonth'])assert.equal(chartSum(app,key),expected,key);
    assert.equal(app.ids.get('ret-k-rev').textContent,money(enabled?50:0));
    assert.equal(app.ids.get('renewToggle')['aria-checked'],String(enabled));
    app.runtime.shareReport();await Promise.resolve();
    assert.ok(app.clipboard.at(-1).includes('Выручка: '+money(expected)));
    assert.ok(app.clipboard.at(-1).includes(enabled?'С продлениями':'Без продлений'));
  }
  assert.equal(app.storage.get('eks-cr'),'1');
});

test('ranking restores status colors without making a searched manager the team leader',async()=>{
  const names=['Иванов А.','Петров Б.','Сидоров В.'];
  const reports=names.flatMap((name,n)=>Array.from({length:10},(_,i)=>lesson(name,'14.09.2026',String(1000+n*100+i))));
  const payments=names.flatMap((name,n)=>Array.from({length:[8,3,2][n]},(_,i)=>payment(n===0?'25000.25':'100.25',name,'15.09.2026','Первичная',String(1000+n*100+i))));
  const app=dashboard(data({form:reports,payments,managers:names.map(name=>[name,'да'])}));
  await app.runtime.loadAll();app.period();
  const row=name=>app.ids.get('tbody').innerHTML.match(new RegExp('<tr data-manager="'+name+'">[\\s\\S]*?</tr>'))[0];
  assert.match(row(names[0]),/mgr-badge top/);
  assert.match(row(names[0]),/pill g/);
  assert.match(row(names[0]),/class="gc"/);
  assert.match(row(names[0]),/class="bc"/);
  assert.match(row(names[1]),/pill y/);
  assert.match(row(names[2]),/pill r/);
  app.runtime.filterTeam('Петров');
  assert.doesNotMatch(app.ids.get('tbody').innerHTML,/mgr-badge top/);
  app.runtime.setAnalyticsMgr('Петров Б.');
  assert.doesNotMatch(app.ids.get('tbody').innerHTML,/mgr-badge top/);
  app.runtime.setAnalyticsMgr('');
  app.failures.set('payments',503);await app.runtime.loadAll();
  assert.doesNotMatch(app.ids.get('tbody').innerHTML,/mgr-badge|pill [gyr]|class="[gb]c"/);
});

test('rubles are rounded only for display across cards, registers, summary and chart tooltips',async()=>{
  const app=dashboard(data({form:[lesson()],payments:[payment('125.50')]}));
  await app.runtime.loadAll();app.period();
  assert.equal(app.run('analyticsSelection().totals.rev'),125.5);
  assert.equal(app.run('analyticsModel.payments[0].amountMinor'),12550);
  assert.equal(app.ids.get('kv-rev').textContent,'126 ₽');
  assert.equal(app.runtime.avMoney(37938.11),'37 938 ₽');
  assert.equal(app.runtime.analyticsMetric(null,' ₽'),'—');
  assert.equal(app.runtime.analyticsMetric(-125.5,' ₽'),'-126 ₽');
  assert.equal(app.runtime.analyticsMetric(66.666,'%'),'66,7%');
  assert.match(app.runtime.avPaymentRegister(app.run('analyticsSelection().payments')),/126 ₽/);
  app.runtime.shareReport();await Promise.resolve();
  assert.match(app.clipboard[0],/Выручка: 126 ₽/);
  for(const key of ['rev','team','revday']){
    const callback=app.run('charts')[key].config.options.plugins.tooltip.callbacks.label;
    assert.match(callback({dataset:{label:'Выручка, ₽'},parsed:{x:0,y:125.5}}),/126 ₽/);
  }
});
