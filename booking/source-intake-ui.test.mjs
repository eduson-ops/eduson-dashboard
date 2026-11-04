import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const core=await import(new URL('./core.mjs',import.meta.url));
const source=await readFile(new URL('./app.js',import.meta.url),'utf8');

class Node {
  constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.open=false;this.disabled=false;this.children=[];}
  addEventListener(){}querySelector(){return null;}querySelectorAll(){return [];}contains(){return false;}
  append(node){this.children.push(node);}remove(){}focus(){}showModal(){this.open=true;}close(){this.open=false;}
}

async function fixture(response=()=>({issues:[]})) {
  const ids=new Map(['#app','#editor','#notifications','#main','#tabs','#connection'].map(key=>[key,new Node()]));
  const requests=[];
  const document={querySelector:key=>ids.get(key)||null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>new Node(),activeElement:null,getElementById:()=>null};
  const box=vm.createContext({core,document,window:{addEventListener(){}},location:{hash:''},console,Intl,URL,URLSearchParams,AbortController,Date,setTimeout:()=>0,clearTimeout(){},setInterval(){},structuredClone,fetch:async(url,init)=>{
    requests.push({url,init});
    const result=await response(url,init);
    return new Response(JSON.stringify(result?.body??result),{status:result?.status??200});
  }});
  // Run the real app functions without starting login, timers, or network bootstrap.
  let body=source.replace(/^import (\{[^\n]+\}) from [^\n]+\r?\n/,'const $1=core;\n');
  assert.notEqual(body,source,'The app core import must be available to the VM fixture');
  const entry=body.lastIndexOf('\ntry {await bootstrap();}');
  assert.ok(entry>=0,'The app bootstrap entrypoint must be isolated from the VM fixture');
  body=body.slice(0,entry);
  await vm.runInContext(`(async()=>{${body}\nglobalThis.ui={state,handleAction,renderSourceIntakeStatus:typeof renderSourceIntakeStatus==='function'?renderSourceIntakeStatus:null,openSourceIntakeIssues:typeof openSourceIntakeIssues==='function'?openSourceIntakeIssues:null};})()`,box);
  box.ui.state.user={role:'admin',id:'admin',name:'Synthetic admin'};
  box.ui.state.csrfToken='synthetic-csrf';
  box.ui.state.sourceIntake={enabled:true,issues:1,errors:0};
  box.ui.state.view='admin';
  return {...box.ui,dialog:ids.get('#editor'),requests};
}

const issue=(code='UNKNOWN_STAFF_MAPPING',extra={})=>({id:'issue-1',observation_id:'observation-1',record_id:'123',code,summary:{studentName:'Synthetic student',parentName:'Synthetic parent',phone:'+79990000000',date:'2026-11-10',time:'12:00',crmUrl:'https://synthetic.amocrm.ru/leads/detail/123'},...extra});

test('source issue alert stays absent for happy/disabled/missing status and every non-admin role',async()=>{
  const f=await fixture();assert.equal(typeof f.renderSourceIntakeStatus,'function');
  assert.match(f.renderSourceIntakeStatus(),/Проверить записи/);
  for(const status of [null,undefined,{enabled:false,issues:2},{enabled:true,issues:0,errors:0}]){
    f.state.sourceIntake=status;assert.equal(f.renderSourceIntakeStatus(),'');
  }
  f.state.sourceIntake={enabled:true,issues:3,errors:0};
  for(const role of ['sales','confirmation','call_center']){
    f.state.user.role=role;assert.equal(f.renderSourceIntakeStatus(),'');
    await f.openSourceIntakeIssues();assert.equal(f.requests.length,0);assert.equal(f.dialog.open,false);
  }
});

test('issue details escape source text, reject executable CRM URLs and preserve invalid dates without raw payload',async()=>{
  const f=await fixture(()=>({issues:[
    issue('AMO_AUTHORITY',{summary:{studentName:'<img src=x onerror=alert(1)>',parentName:'<script>bad</script>',phone:'<b>phone</b>',date:'2026-11-10',time:'12:00',crmUrl:'javascript:alert(1)'},raw:{secret:'DO-NOT-SHOW'}}),
    issue('INVALID_DATE',{summary:{studentName:'Invalid date example',date:'2026-02-31',time:'12:00'}}),
  ]}));
  assert.equal(typeof f.openSourceIntakeIssues,'function');await f.openSourceIntakeIssues();
  assert.match(f.dialog.innerHTML,/&lt;img/);
  assert.doesNotMatch(f.dialog.innerHTML,/<img|<script|javascript:|DO-NOT-SHOW/);
  assert.match(f.dialog.innerHTML,/Нужна сверка с AmoCRM/);
  assert.doesNotMatch(f.dialog.innerHTML,/data-action="source-intake-retry"/);
  assert.match(f.dialog.innerHTML,/2026-02-31/);assert.doesNotMatch(f.dialog.innerHTML,/03\.03\.2026/);
});

test('manual retry uses CSRF and exact observation ID only for the approved issue codes',async()=>{
  for(const code of ['UNKNOWN_STAFF_MAPPING','MIGRATION_LINK_REQUIRED','EXISTING_CAPACITY_CONFLICT','SOURCE_IDENTITY_CONFLICT','AMO_AUTHORITY']){
    let retried=false;
    const f=await fixture((url,init)=>{
      if(init.method==='POST'){retried=true;return {observation:{status:'pending'}};}
      if(url.endsWith('/issues'))return {issues:retried?[]:[issue(code)]};
      if(url.endsWith('/status'))return {enabled:true,issues:0,errors:0};
      return {bookings:[],hours:[]};
    });
    await f.openSourceIntakeIssues();
    const target={dataset:{action:'source-intake-retry',id:'observation-1'},disabled:false,textContent:'Повторить обработку'};
    await f.handleAction({target:{closest:()=>target}});
    const posts=f.requests.filter(request=>request.init.method==='POST');
    assert.equal(posts.length,code==='AMO_AUTHORITY'?0:1,code);
    if(posts.length){assert.equal(posts[0].url,'/api/integrations/rubitime/issues/observation-1/retry');assert.equal(posts[0].init.headers['X-CSRF-Token'],'synthetic-csrf');}
  }
});

test('missing issue endpoint hides the optional integration alert without breaking the page',async()=>{
  const f=await fixture(()=>({status:404,body:{error:'not found'}}));
  await f.openSourceIntakeIssues();assert.equal(f.renderSourceIntakeStatus(),'');assert.equal(f.dialog.open,false);
});

test('booking UI marks stale data and exposes mobile card labels for lesson rows',()=>{
  assert.match(source,/function renderFreshness\(\)/);
  assert.match(source,/state\.dataStale/);
  assert.match(source,/data-label="Ученик"/);
  assert.match(source,/data-label="Статус"/);
});

test('completed view exposes the creation-day filter and booking creation timestamp for retro review',()=>{
  assert.match(source,/id="completed-created-from"/);
  assert.match(source,/id="completed-created-to"/);
  assert.match(source,/createdFrom/);
  assert.match(source,/createdTo/);
  assert.match(source,/createdAt/);
  assert.match(source,/Записано в/);
});

test('admin view exposes the creation-day retro slice',()=>{
  assert.match(source,/Записано в этот день/);
  assert.match(source,/data-action="retro-hour"/);
  assert.match(source,/Воронка дня/);
  assert.match(source,/confirmation-history-issues/);
});
