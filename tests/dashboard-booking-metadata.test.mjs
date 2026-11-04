import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const adapter=await readFile(new URL('../booking-analytics-adapter.js',import.meta.url),'utf8');
const start=html.indexOf('const SHEET_ID =');
const loader=html.slice(start,html.indexOf('function curMonthBounds()',start));
const headers=['timestamp','manager','date','time','crm','recording','practice','age','package','payment','agreement','objection','channel','amount','Booking ID','Test flag'];
const cancelHeaders=['timestamp','crm','reason','first','contact','age','comment','manager','Booking ID','Booking status'];
const lesson=(id,flag,practice='Python')=>['2026-11-04T12:00:00Z','Synthetic sales','2026-11-04','12:00','','https://example.invalid/recording',practice,10,'12 lessons','No payment','','','Synthetic',0,id,flag];
const cancel=(id,status,reason=id)=>['2026-11-04T12:00:00Z','',reason,'Да','',10,'','Synthetic sales',id,status];
const csv=rows=>rows.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');

async function load({withAdapter=false,apiStatus=403,forms=[headers],cancels=[cancelHeaders]}={}){
 const errors=[],calls=[],nodes=new Map();
 const node=()=>({classList:{add(){},remove(){}},style:{},hidden:false,textContent:'',innerHTML:'',setAttribute(){},appendChild(child){if(child.id)nodes.set(child.id,child);}});
 const document={readyState:'loading',body:node(),createElement:node,addEventListener(){},querySelectorAll:()=>[],getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}};
 const context=vm.createContext({document,URL,Response,Headers,Date,AbortController,AbortSignal,setTimeout,clearTimeout,
  location:{href:'https://synthetic.example/dashboard/',hostname:'synthetic.example',protocol:'https:',hash:''},
  localStorage:{getItem(){return null;}},addEventListener(){},console:{log(){},warn(){},error(...args){errors.push(args);}},
  EventSource:class{constructor(){throw Error('An unauthorized dashboard must not subscribe to booking events');}},
  fetch:async input=>{
   const address=new URL(typeof input==='string'?input:input.url||String(input),'https://synthetic.example');calls.push(address.pathname+address.search);
   if(address.pathname==='/api/analytics/snapshot')return new Response('{}',{status:apiStatus});
   const gid=address.searchParams.get('gid');
   return new Response(csv(gid==='1621541455'?forms:gid==='901678043'?cancels:gid==='1534781490'?[['Manager','Active'],['Synthetic sales','Да']]:[['header']]));
  }});
 context.window=context;
 if(withAdapter)vm.runInContext(adapter,context,{filename:'booking-analytics-adapter.js'});
 vm.runInContext(loader,context,{filename:'index.html'});
 for(const name of['renderMain','buildHotMgrFilter','renderHot','buildAnalyticsMgrFilter','renderAnalytics','renderManagers','renderSchedule','renderRetention'])context[name]=()=>{};
 await context.loadAll();assert.deepEqual(errors,[]);
 return{...JSON.parse(vm.runInContext('JSON.stringify({lessons,cancelsList})',context)),calls};
}

for(const withAdapter of[false,true]){
 const mode=withAdapter?'non-admin Sheets fallback':'standalone GitHub Pages';
 test(mode+' excludes test reports only under the named Test flag metadata header',async()=>{
  const named=[...headers];named[15]='  TeSt \n FLAG  ';
  const result=await load({withAdapter,forms:[named,lesson('test-true','TRUE'),lesson('test-one','1'),lesson('test-yes',' да '),lesson('real-false','FALSE'),lesson('','', 'Anonymous legacy report'),lesson('unknown-flag','unknown')]});
  assert.deepEqual(result.lessons.map(row=>row.bookingId),['real-false','','unknown-flag']);
  assert.equal(result.lessons[0].rec,'https://example.invalid/recording');
  assert.equal(result.lessons[0].paid,false);assert.equal(result.lessons[0].rev,0);
 });
 test(mode+' excludes restored cancellation rows only under the named Booking status header',async()=>{
  const named=[...cancelHeaders];named[9]=' BOOKING \n STATUS ';
  const result=await load({withAdapter,cancels:[named,cancel('restored',' restored '),cancel('restored-upper','RESTORED'),cancel('current','cancelled'),cancel('','','Anonymous legacy cancellation'),cancel('unknown','unknown')]});
  assert.deepEqual(result.cancelsList.map(row=>row.reason),['current','Anonymous legacy cancellation','unknown']);
 });
 test(mode+' preserves foreign or unnamed metadata and original anonymous report/cancellation rows',async()=>{
  for(const metadataHeader of['Foreign workflow note','']){
   const form=[...headers];form[15]=metadataHeader;
   const cancellation=[...cancelHeaders];cancellation[9]=metadataHeader;
   const result=await load({withAdapter,forms:[form,lesson('foreign-true','TRUE'),lesson('','1','Anonymous report')],cancels:[cancellation,cancel('foreign-restored','restored'),cancel('','restored','Anonymous cancellation')]});
   assert.deepEqual(result.lessons.map(row=>row.bookingId),['foreign-true','']);
   assert.deepEqual(result.cancelsList.map(row=>row.reason),['foreign-restored','Anonymous cancellation']);
  }
 });
}
