/* Shared period, source health and financial views. Facts are calculated in analytics-core.js. */
var analyticsModel = SalesAnalytics.buildModel({});
var sourceSnapshots = {};
var currentDetailManager = '';

function analyticsReady(keys) {
  return opsDataReady && (keys || ['form','payments']).every(function(key){return opsSourceStates[key] && opsSourceStates[key].state === 'success';});
}
function analyticsQuery(managerOverride) {
  var period=SalesAnalytics.period(mainDfMode==='all'?'month':mainDfMode,{from:mainDfFrom,to:mainDfTo});
  return Object.assign(period,{manager:personalMgr || (managerOverride===undefined?analyticsMgr:managerOverride) || '',includeRenewals:COUNT_RENEWALS});
}
function analyticsSelection(managerOverride) { return SalesAnalytics.select(analyticsModel,analyticsQuery(managerOverride)); }
function analyticsMetric(value,suffix) {
  if(value==null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('ru-RU',{maximumFractionDigits:suffix==='%'?1:2})+(suffix||'');
}
function analyticsDayLabel(day) { return day?day.split('-').reverse().join('.'):'—'; }
function sourceRowLink(source,row) {
  var url=new URL(URLS[source]);
  return 'https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/edit#gid='+url.searchParams.get('gid')+'&range=A'+row;
}
function visible(){return analyticsSelection().lessons;}
function visibleMain(){return analyticsSelection().lessons;}
function visibleAnalytics(){return analyticsSelection().lessons;}
function visibleCancels(){return analyticsSelection().cancels;}
function visibleRenewalsMain(){return analyticsSelection().payments.filter(function(p){return p.renewal;});}

function syncAnalyticsFilters() {
  ['main','analytics'].forEach(function(page){
    document.querySelectorAll('#page-'+page+' .dfilter > .dfbtn').forEach(function(button){
      var handler=button.getAttribute('onclick')||'';
      button.classList.toggle('active',handler.indexOf("'"+mainDfMode+"'")>=0);
    });
  });
  ['main-custom-dates','custom-dates'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display=mainDfMode==='custom'?'flex':'none';});
  ['main-df-from','df-from'].forEach(function(id){var el=document.getElementById(id);if(el)el.value=mainDfFrom||'';});
  ['main-df-to','df-to'].forEach(function(id){var el=document.getElementById(id);if(el)el.value=mainDfTo||'';});
  var q=analyticsQuery(), label=analyticsDayLabel(q.from)+(q.to!==q.from?' — '+analyticsDayLabel(q.to):'');
  document.querySelectorAll('.analytics-period-label').forEach(function(el){el.textContent=label+' · '+(personalMgr||analyticsMgr||'Вся команда')+' · '+(COUNT_RENEWALS?'с продлениями':'без продлений');});
}
function renderAnalyticsAll(){
  syncAnalyticsFilters();buildAnalyticsMgrFilter();renderMain();renderAnalytics();renderCancels();renderManagers();renderRetention();
  if(currentDetailManager && document.getElementById('mgr-detail').style.display!=='none')openMgr(personalMgr||currentDetailManager);
}
function setMainDfPer(mode){
  if(mode==='custom'){
    var q=analyticsQuery();mainDfFrom=mainDfFrom||q.from;mainDfTo=mainDfTo||q.to;
  }
  mainDfMode=dfMode=mode;dfFrom=mainDfFrom;dfTo=mainDfTo;renderAnalyticsAll();
}
function setDfPer(mode){setMainDfPer(mode);}
function applyAnalyticsCustom(prefix){
  var from=document.getElementById(prefix+'df-from').value,to=document.getElementById(prefix+'df-to').value;
  var checked=SalesAnalytics.period('custom',{from:from,to:to});
  var error=document.getElementById(prefix+'period-error');
  if(!checked.from){if(error)error.textContent='Укажите даты: начало не позже окончания.';return;}
  document.querySelectorAll('.period-error').forEach(function(el){el.textContent='';});
  mainDfFrom=dfFrom=from;mainDfTo=dfTo=to;mainDfMode=dfMode='custom';renderAnalyticsAll();
}
function applyMainCustom(){applyAnalyticsCustom('main-');}
function applyCustom(){applyAnalyticsCustom('');}
function setAnalyticsMgr(name){analyticsMgr=name||'';renderAnalyticsAll();}
function buildAnalyticsMgrFilter(){
  var wrap=document.getElementById('analytics-mgr-filter');if(!wrap)return;
  var names=Array.from(new Set(managers.concat(analyticsModel.lessons,analyticsModel.payments,analyticsModel.cancels).map(function(row){return typeof row==='string'?row:row.manager||'__unassigned__';}))).sort();
  var selected=personalMgr||analyticsMgr;
  if(personalMgr)names=[personalMgr];else names.unshift('');
  wrap.innerHTML='<span style="font-size:11px;color:var(--sub)">Менеджер:</span>'+names.map(function(name){
    return '<button class="dfbtn'+(selected===name?' active':'')+'" data-manager="'+esc(name)+'">'+esc(name==='__unassigned__'?'Не указан':name||'Все')+'</button>';
  }).join('');
  wrap.querySelectorAll('button').forEach(function(button){button.addEventListener('click',function(){setAnalyticsMgr(button.dataset.manager);});});
}
function syncRenewalToggle(){var b=document.getElementById('renewToggle');if(b){b.classList.toggle('on',COUNT_RENEWALS);b.setAttribute('aria-checked',String(COUNT_RENEWALS));}}
function toggleRenewals(){COUNT_RENEWALS=!COUNT_RENEWALS;try{localStorage.setItem('eks-cr',COUNT_RENEWALS?'1':'0');}catch(e){}renderAnalyticsAll();}

function renderDataHealth(){
  var names=OPS_SOURCE_NAMES, failed=Object.keys(names).filter(function(key){return !analyticsReady([key]);});
  var alert=document.getElementById('alert-text');
  alert.textContent=failed.length?'Не обновились: '+failed.map(function(key){return names[key];}).join(', ')+'. Зависимые показатели недоступны.':'Данные загружены. Уроки учитываются по дате урока, деньги — по дате оплаты.';
  alert.parentElement.classList.toggle('data-warning',failed.length>0);
  var upd=document.getElementById('upd'), stamps=Object.keys(names).map(function(key){return opsSourceStates[key]&&opsSourceStates[key].lastSuccessAt;}).filter(Boolean);
  upd.textContent=failed.length?'Часть данных недоступна':stamps.length?'Обновлено '+new Date(Math.min.apply(null,stamps.map(function(x){return new Date(x).getTime();}))).toLocaleTimeString('ru',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'})+' МСК':'Загрузка';
  var badge=document.querySelector('.live-b');if(badge)badge.textContent=failed.length?'ПРОВЕРЬТЕ ДАННЫЕ':'ОБНОВЛЕНО';
  var el=document.getElementById('analytics-quality');if(!el)return;
  var issues=analyticsModel.issues||[], codes={invalid_date:'Не распознана дата — строка исключена из периода',missing_manager:'Не указан менеджер',unknown_manager:'Имя не найдено в справочнике',missing_crm:'Нет ссылки на сделку',invalid_crm:'Не распознана ссылка на сделку',possible_duplicate:'Возможный повтор строки — проверьте, обе сохранены в расчёте',invalid_amount:'Не распознана сумма — не включена в деньги',negative_correction:'Отрицательная корректировка суммы',ambiguous_lesson:'Несколько уроков этой сделки — оплата не привязана к конкретному уроку',unmatched_lesson:'Оплата без отчёта об уроке'};
  var sourceHtml=Object.keys(names).map(function(key){var state=opsSourceStates[key]||{};return '<li><strong>'+esc(names[key])+'</strong>: '+(state.state==='success'?'загружено, строк '+state.rowCount:esc(state.message||'загрузка'))+(state.lastSuccessAt?' · последнее успешное чтение '+esc(new Date(state.lastSuccessAt).toLocaleString('ru',{timeZone:'Europe/Moscow'})):'')+'</li>';}).join('');
  el.innerHTML='<summary>Источники и проверка данных · '+issues.length+' замечаний</summary><ul>'+sourceHtml+'</ul>'+(issues.length?'<div class="data-quality-list">'+issues.map(function(issue){return '<div><a href="'+sourceRowLink(issue.source,issue.row)+'" target="_blank" rel="noopener">'+esc(names[issue.source])+' · строка '+issue.row+'</a> — '+esc(codes[issue.code]||issue.code)+'</div>';}).join('')+'</div>':'<p>Ошибок заполнения не обнаружено.</p>');
}

function renderMain(){
  syncRenewalToggle();syncAnalyticsFilters();
  var selection=analyticsSelection(),t=selection.totals, payOk=analyticsReady(['payments']), mkOk=analyticsReady(['form']);
  document.getElementById('main-eyebrow').textContent=personalMgr?'Личный режим · '+personalMgr:'Операционка · Команда';
  document.getElementById('main-title').textContent=mainDfMode==='today'?(personalMgr?'Мой день':'Сегодня'):'Итоги периода';
  document.getElementById('main-sub').textContent='Записи, проведённые уроки и оплаты';
  function metric(id,value,suffix){document.getElementById(id).textContent=analyticsMetric(value,suffix);}
  metric('kv-rev',payOk?t.rev:null,' ₽');metric('kv-mk',mkOk?t.mk:null,'');metric('kv-conv',payOk&&mkOk?t.conv:null,'%');
  metric('kv-avg',payOk?t.avg:null,' ₽');metric('kv-rpm',payOk&&mkOk?t.rpm:null,' ₽');
  document.getElementById('ks-rev').textContent=payOk?t.paid+' оплат · первичные '+analyticsMetric(t.primaryRev,' ₽')+(COUNT_RENEWALS?' · продления '+analyticsMetric(t.renewalRev,' ₽'):''):'Таблица оплат недоступна';
  document.getElementById('ks-mk').textContent='По отчётам о проведённых уроках';
  document.getElementById('ks-conv').textContent='Оплаты периода ÷ МК периода';
  document.getElementById('ks-avg').textContent='Выручка ÷ количество оплат';
  document.getElementById('ks-rpm').textContent='Выручка ÷ проведённые МК';
  ['rev','mk','conv','avg','rpm'].forEach(function(key){document.getElementById('kt-'+key).textContent='';});
  renderDataHealth();renderTeamTable(null,document.getElementById('search').value);renderSlots();renderProg();renderRevChart();renderTeamChart();renderKpiSparks();
}
function analyticsManagers(selection){
  return Array.from(new Set(selection.lessons.concat(selection.payments).map(function(row){return row.manager||'__unassigned__';}))).map(function(name){
    var totals=SalesAnalytics.select(analyticsModel,Object.assign({},analyticsQuery(),{manager:name})).totals;return Object.assign({name:name},totals);
  }).sort(function(a,b){return b.rev-a.rev||b.mk-a.mk||a.name.localeCompare(b.name,'ru');});
}
function renderTeamTable(unused,filter){
  var t=analyticsSelection().totals, rows=analyticsManagers(analyticsSelection()), payOk=analyticsReady(['payments']),mkOk=analyticsReady(['form']);
  function cells(r){return '<td>'+analyticsMetric(mkOk?r.mk:null)+'</td><td>'+analyticsMetric(payOk?r.paid:null)+'</td><td>'+analyticsMetric(payOk&&mkOk?r.conv:null,'%')+'</td><td>'+analyticsMetric(payOk?r.rev:null,' ₽')+'</td><td>'+analyticsMetric(payOk?r.avg:null,' ₽')+'</td><td>'+analyticsMetric(payOk&&mkOk?r.rpm:null,' ₽')+'</td>';}
  var filtered=rows.filter(function(row){return !filter||(row.name==='__unassigned__'?'Не указан':row.name).toLowerCase().includes(filter.toLowerCase());});
  var body=document.getElementById('tbody');
  body.innerHTML=filtered.map(function(row){return '<tr data-manager="'+esc(row.name)+'"><td class="tn"><button class="manager-open" data-manager="'+esc(row.name)+'">'+mgrEmoji(row.name)+' '+esc(row.name==='__unassigned__'?'Не указан':row.name)+'</button></td>'+cells(row)+'</tr>';}).join('')+(rows.length?'<tr class="total"><td>Итого по выбранному периоду</td>'+cells(t)+'</tr>':'<tr><td colspan="7">'+(payOk&&mkOk?'За период нет уроков и оплат.':'Данные недоступны — проверьте источники.')+'</td></tr>');
  body.querySelectorAll('.manager-open').forEach(function(button){button.addEventListener('click',function(){openMgr(button.dataset.manager);});});
}
function filterTeam(value){renderTeamTable(null,value);}
function renderProg(){
  var q=SalesAnalytics.period('month'),t=SalesAnalytics.select(analyticsModel,Object.assign(q,{includeRenewals:COUNT_RENEWALS})).totals;
  var container=document.querySelector('.cdown');container.hidden=!!personalMgr;container.style.display=personalMgr?'none':'';
  var planOk=analyticsReady(['targets'])&&targets.rev!=null&&targets.mk!=null;
  var today=SalesAnalytics.period('today').from,day=Number(today.slice(8)),total=Number(q.to.slice(8)),left=total-day;
  document.getElementById('rdays').textContent=left;document.getElementById('rfg').style.strokeDashoffset=2*Math.PI*30*(left/total);
  document.getElementById('cc-rev').textContent=analyticsMetric(planOk&&analyticsReady(['payments'])?Math.max(0,targets.rev-t.rev):null,' ₽');
  document.getElementById('cc-rev2').textContent=planOk?'План отдела на месяц '+analyticsMetric(targets.rev,' ₽'):'План на месяц не задан';
  var remainder=planOk&&analyticsReady(['payments'])?Math.max(0,targets.rev-t.rev):null;
  document.getElementById('cc-day').textContent=analyticsMetric(remainder!=null&&left>0?remainder/left:null,' ₽');
  document.getElementById('cc-mk').textContent=analyticsMetric(planOk&&analyticsReady(['form'])?Math.max(0,targets.mk-t.mk):null,' МК');
  var el=document.getElementById('prog');
  if(personalMgr){el.innerHTML='<p class="analytics-note">Личный план не задан. Показатели выше относятся только к выбранному менеджеру.</p>';return;}
  if(!planOk){el.innerHTML='<p class="analytics-note">План на текущий месяц не задан или недоступен.</p>';return;}
  el.innerHTML=[{label:'МК за месяц',value:analyticsReady(['form'])?t.mk:null,target:targets.mk},{label:'Выручка за месяц',value:analyticsReady(['payments'])?t.rev:null,target:targets.rev}].map(function(row){var ratio=row.value!=null&&row.target>0?row.value/row.target*100:null;return '<div class="pr"><span class="pl">'+row.label+'</span><div class="pt2"><div class="pf g" style="width:'+Math.max(0,Math.min(100,ratio||0))+'%"></div></div><span class="pp">'+analyticsMetric(ratio,'%')+'</span></div>';}).join('');
}
function renderRevChart(){
  dc('rev');if(!analyticsReady(['payments']))return;
  var rows=SalesAnalytics.daily(analyticsModel,analyticsQuery()), c=gc();
  charts.rev=new Chart(document.getElementById('revC'),{type:'bar',data:{labels:rows.map(function(row){return analyticsDayLabel(row.day);}),datasets:[{label:'Выручка',data:rows.map(function(row){return row.rev;}),backgroundColor:'#f5c84299',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:c.tick},grid:{display:false}},y:{ticks:{color:c.tick},grid:{color:c.grid}}}}});
}
function renderTeamChart(){
  dc('team');if(!analyticsReady(['payments']))return;
  var rows=analyticsManagers(analyticsSelection()),c=gc();
  charts.team=new Chart(document.getElementById('teamC'),{type:'bar',data:{labels:rows.map(function(row){return row.name==='__unassigned__'?'Не указан':row.name;}),datasets:[{label:'Выручка',data:rows.map(function(row){return row.rev;}),backgroundColor:'#60a5fa99',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:c.tick},grid:{display:false}},y:{ticks:{color:c.tick},grid:{color:c.grid}}}}});
}
function renderKpiSparks(){
  var rows=SalesAnalytics.daily(analyticsModel,analyticsQuery());
  ['rev','mk','conv','avg','rpm'].forEach(function(key){var ready=analyticsReady(key==='mk'?['form']:['form','payments']),el=document.getElementById('spark-'+key);el.innerHTML=ready&&rows.length>1?sparkPath(rows.map(function(row){return row[key]||0;}),68,22):'';});
}
function shareReport(){
  if(!analyticsReady(['form','payments'])){var toast=document.getElementById('copy-toast');toast.textContent='Сводка недоступна: дождитесь загрузки уроков и оплат.';toast.classList.add('visible');setTimeout(function(){toast.classList.remove('visible');},3500);return;}
  var q=analyticsQuery(),t=analyticsSelection().totals;
  var lines=['Eduson Kids · '+analyticsDayLabel(q.from)+(q.to!==q.from?' — '+analyticsDayLabel(q.to):''),q.manager||'Вся команда',COUNT_RENEWALS?'С продлениями':'Без продлений','', 'Выручка: '+analyticsMetric(t.rev,' ₽'),'Проведено МК: '+t.mk,'Оплат: '+t.paid,'Конверсия: '+analyticsMetric(t.conv,'%'),'Средний чек: '+analyticsMetric(t.avg,' ₽'),'Выручка / МК: '+analyticsMetric(t.rpm,' ₽'),''];
  analyticsManagers(analyticsSelection()).forEach(function(row){lines.push((row.name==='__unassigned__'?'Не указан':row.name)+': '+row.mk+' МК · '+row.paid+' оплат · '+analyticsMetric(row.rev,' ₽'));});
  lines.push('','Оплаты по дате оплаты; МК по дате урока. Конверсия = оплаты периода / МК периода.');
  if(analyticsModel.issues.length)lines.push('В исходных данных есть замечания: проверьте раздел источников.');
  var text=lines.join('\n');
  if(navigator.clipboard){navigator.clipboard.writeText(text).then(shareToast).catch(function(){window.prompt('Скопируйте сводку',text);});}
  else window.prompt('Скопируйте сводку',text);
}
