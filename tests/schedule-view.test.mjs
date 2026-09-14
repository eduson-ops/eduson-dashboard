import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const html=read('index.html');
function app(){
 const els=new Map();
 const element=id=>({id,innerHTML:'',textContent:'',value:'',disabled:false,hidden:false,style:{},setAttribute(k,v){this[k]=v;},querySelectorAll(){return [];}});
 const doc={getElementById(id){if(!els.has(id))els.set(id,element(id));return els.get(id);},querySelectorAll(){return [];}};
 const managers=Array.from({length:20},(_,i)=>'Менеджер '+String(i+1).padStart(2,'0')).concat('МВП');
 const scheduleData=Object.fromEntries(managers.map((m,i)=>[m,{'15.09.2026':i%2?{}:{10:true,11:true}}]));
 const ctx=vm.createContext({document:doc,Date,Set,HOURS:['10:00','11:00'],HOUR_COLORS:{10:'red',11:'red'},managers,scheduleData,personalMgr:'',hmWeek:0,analyticsReady:()=>true,renderAuditLog(){},esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),mgrEmoji:()=>'',fmtDate:()=> '15.09.2026'});
 ctx.window=ctx;
 function range(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);vm.runInContext(html.slice(a,b),ctx);}
 if(fs.existsSync(new URL('../schedule-overview.js',import.meta.url)))vm.runInContext(read('schedule-overview.js'),ctx);
 range('function isMvp(', 'function scheduledDate(');
 range('function get14Days(', '// ─── Copy slots helper');
 range('var selectedHmDay =', 'function goToEditSched(');
 ctx.get14Days=()=>Array.from({length:7},(_,i)=>new Date(2026,8,15+i));
 return {ctx,els,scheduleData};
}
test('quality details live only in Control and retain the shared target for diagnostics',()=>{
 const main=html.slice(html.indexOf('id="page-main"'),html.indexOf('id="page-operations"'));
 const control=html.slice(html.indexOf('id="page-operations"'),html.indexOf('id="page-analytics"'));
 assert.doesNotMatch(main,/id="analytics-quality"/);
 assert.match(control,/id="analytics-quality"/);
 assert.equal((html.match(/id="analytics-quality"/g)||[]).length,1);
});

test('standalone source changes refresh shared diagnostics without requiring a main-page render',()=>{
 let displayed;
 const ctx=vm.createContext({Date,opsSourceStates:{},OpsControl:{updateSource:(previous,state,now,details)=>({...previous,state,...details})}});
 const start=html.indexOf('function recordOpsSource('),end=html.indexOf('function setOpsDay(',start);
 vm.runInContext(html.slice(start,end),ctx);
 // Initial source reads may precede analytics script initialization.
 ctx.recordOpsSource('schedule','loading');
 ctx.renderDataHealth=()=>{displayed=ctx.opsSourceStates.schedule;};
 ctx.recordOpsSource('schedule','error',{message:'Schedule unavailable'});
 assert.equal(displayed.state,'error');
 assert.equal(displayed.message,'Schedule unavailable');
 ctx.recordOpsSource('schedule','success',{rowCount:634});
 assert.equal(displayed.state,'success');
 assert.equal(displayed.rowCount,634);
});
test('twenty employees stay available; MVP is excluded; search and zero-hour filter affect both views but not totals',()=>{
 const {ctx,els,scheduleData}=app();const before=JSON.stringify(scheduleData);
 ctx.renderSchedule();
 assert.equal((els.get('hm-summary').innerHTML.match(/class="so-row/g)||[]).length,20);
 assert.doesNotMatch(els.get('hm-summary').innerHTML,/МВП/);
 assert.doesNotMatch(els.get('hm-table').innerHTML,/МВП/);
 const total=els.get('hm-total-banner').innerHTML;
 ctx.setHmSearch('менеджер 02');
 assert.equal((els.get('hm-table').innerHTML.match(/class="hm-row"/g)||[]).length,1);
 assert.equal(els.get('hm-total-banner').innerHTML,total);
 ctx.setHmSearch('');ctx.toggleHmEmpty();
 assert.equal((els.get('hm-summary').innerHTML.match(/class="so-row/g)||[]).length,10);
 assert.equal((els.get('hm-table').innerHTML.match(/class="hm-row"/g)||[]).length,10);
 assert.equal(JSON.stringify(scheduleData),before);
 ctx.personalMgr='Менеджер 01';ctx.hmEmptyOnly=false;ctx.renderSchedule();
 assert.equal((els.get('hm-summary').innerHTML.match(/class="so-row/g)||[]).length,1);
});
test('unavailable schedule shows no zero-hour classification or stale heatmap',()=>{
 const {ctx,els}=app();ctx.renderSchedule();ctx.analyticsReady=()=>false;ctx.renderSchedule();
 assert.match(els.get('hm-summary').innerHTML,/недоступен/);
 assert.doesNotMatch(els.get('hm-summary').innerHTML,/so-empty/);
 assert.equal(els.get('hm-table').innerHTML,'');
 assert.equal(els.get('hm-total-banner').innerHTML,'');
});
