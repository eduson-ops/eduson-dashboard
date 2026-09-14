/* Event views with traceable MK reports from lesson and payment forms. */
'use strict';

function avText(id, text) { var el=document.getElementById(id); if(el) el.textContent=text; }
function avHtml(id, html) { var el=document.getElementById(id); if(el) el.innerHTML=html; }
function avName(name) { return name || 'Не указан'; }
function avMoney(value) { return analyticsMetric(value,' ₽'); }
function avNumber(value, suffix) { return value===null || value===undefined ? '—' : (suffix==='%'?Number(value.toFixed(1)).toLocaleString('ru'):fmt(value))+(suffix||''); }
function avDate(day) { return day ? day.split('-').reverse().join('.') : 'Дата не указана'; }
function avNote(text) { return '<p class="ops-note" style="margin:8px 0;line-height:1.6">'+esc(text)+'</p>'; }
function avUnavailable() { return avNote('Источник не загружен. Текущий результат не подтверждён.'); }
function avTitle(id, title) {
  var el=document.getElementById(id), panel=el && el.closest('.panel');
  if(panel && panel.querySelector('.pt')) panel.querySelector('.pt').textContent=title;
}
function avPeriod(query) { return avDate(query.from)+' — '+avDate(query.to)+' · МСК'; }
function avTable(headers, rows) {
  if(!rows.length) return avNote('За выбранный период записей нет.');
  return '<div style="overflow-x:auto"><table class="tt"><thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+'</tr></thead><tbody>'+rows.map(function(row){return '<tr>'+row.map(function(cell){return '<td>'+cell+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table></div>';
}
function avCrm(row) { var url=safeUrl(row.crm); return url?'<a class="crml" href="'+url+'" target="_blank" rel="noopener noreferrer">Сделка ↗</a>':'—'; }
function avOrigin(row) {
  var labels={form:'Отчёты МК',payments:'Оплаты',cancels:'Отмены'};
  return '<a href="'+sourceRowLink(row.source,row.row)+'" target="_blank" rel="noopener">'+esc((labels[row.source]||row.source||'Источник')+' · строка '+row.row)+'</a>'+(row.issues && row.issues.length?'<br><span class="ops-warning">Требует проверки</span>':'');
}
function avPaymentCaveat(rows) {
  var invalid=rows.filter(function(r){return r.amountMinor===null;}).length;
  var duplicates=rows.filter(function(r){return (r.issues||[]).includes('possible_duplicate');}).length;
  return (invalid?'Некорректная сумма в '+invalid+' отчётах: эти суммы не включены, итог неполный. ':'')+(duplicates?'Возможные дубли: '+duplicates+' строк; оставлены до сверки.':'');
}
function avCount(rows, key, split) {
  var values=new Map();
  rows.forEach(function(row){ var raw=String(row[key]||'').trim(); var keys=split?raw.split(',').map(function(v){return v.trim();}).filter(Boolean):[raw||'Не указано'];
    keys.forEach(function(value){values.set(value,(values.get(value)||0)+1);}); });
  return Array.from(values).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0],'ru');});
}
function avChart(key, id, labels, datasets, ready, note) {
  dc(key);
  var canvas=document.getElementById(id); if(!canvas) return;
  var panel=canvas.closest('.panel'), notice=panel && panel.querySelector('[data-av-note="'+id+'"]');
  if(panel && !notice){notice=document.createElement('p');notice.className='ops-note';notice.dataset.avNote=id;panel.appendChild(notice);}
  if(notice) notice.textContent=!ready?'Источник не загружен. Текущий результат не подтверждён.':note||(!labels.length?'За выбранный период записей нет.':'');
  canvas.parentElement.style.display=ready && labels.length?'':'none';
  if(!ready || !labels.length || typeof Chart==='undefined') return;
  var c=gc(), hasRatio=datasets.some(function(d){return d.yAxisID==='ratio';});
  var scales={x:{ticks:{color:c.tick,font:{size:10}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:c.tick,font:{size:10}},grid:{color:c.grid}}};
  if(hasRatio) scales.ratio={position:'right',beginAtZero:true,ticks:{color:c.tick,callback:function(v){return v+'%';}},grid:{display:false}};
  charts[key]=new Chart(canvas,{type:'bar',data:{labels:labels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1,labels:{color:c.tick,font:{size:10}}}},scales:scales}});
}
function avBars(key,id,entries,ready,label,note){avChart(key,id,entries.map(function(x){return x[0];}),[{label:label||'Записей',data:entries.map(function(x){return x[1];}),backgroundColor:'#60a5fa88',borderRadius:3}],ready,note);}
function avLessonRegister(rows) {
  return avTable(['Дата МК','Менеджер','Время','Практика','Запись / договорённость','CRM','Источник'],rows.slice().sort(function(a,b){return b.day.localeCompare(a.day)||b.row-a.row;}).map(function(r){
    var recording=safeUrl(r.rec);
    return [esc(avDate(r.day))+(r.dateBasis==='payment'?'<br><span class="ops-note">По дате первичной оплаты</span>':''),esc(avName(r.manager)),esc(r.time||'—'),esc(r.practice||'—'),(recording?'<a href="'+recording+'" target="_blank" rel="noopener noreferrer">Запись ↗</a>':'Нет записи')+'<br>'+esc(r.agreement||'Нет договорённости'),avCrm(r),avOrigin(r)];
  }));
}
function avPaymentRegister(rows) {
  return avNote(avPaymentCaveat(rows))+avTable(['Дата оплаты','Менеджер оплаты','Тип','Сумма','Связь с МК','CRM','Источник'],rows.slice().sort(function(a,b){return b.day.localeCompare(a.day)||b.row-a.row;}).map(function(r){return [esc(avDate(r.day)),esc(avName(r.manager)),esc(r.renewal?'Продление':r.paytype||'Первичная'),esc(avMoney(r.rev)),!analyticsReady(['form','payments'])?'Источник МК недоступен':r.lessonRow?'<a href="'+sourceRowLink(r.lessonSource,r.lessonRow)+'" target="_blank" rel="noopener">'+(r.lessonSource==='payments'?'МК из оплаты':'Отчёт МК')+' · строка '+r.lessonRow+'</a>':'Нет однозначной связи',avCrm(r),avOrigin(r)];}));
}
function avRegisters(selection, lessonReady, paymentReady) {
  return '<details open><summary style="cursor:pointer;padding:10px 0;font-weight:600">Проведённые МК'+(lessonReady?' · '+selection.lessons.length:'')+'</summary>'+(lessonReady?avLessonRegister(selection.lessons):avUnavailable())+'</details><details><summary style="cursor:pointer;padding:10px 0;font-weight:600">Оплаты'+(paymentReady?' · '+selection.payments.length:'')+'</summary>'+(paymentReady?avPaymentRegister(selection.payments):avUnavailable())+'</details>';
}
function avFacts(t, ready) {
  var items=[['МК по отчётам',ready.lesson?t.mk:null],['Оплаты по отчётам',ready.payment?t.paid:null],['Отчёты об отменах',ready.cancel?t.cancelled:null]];
  return '<div class="ms4">'+items.map(function(item){return '<div class="kpi"><div class="kl">'+esc(item[0])+'</div><div class="kv">'+avNumber(item[1])+'</div></div>';}).join('')+'</div>'+avNote('МК — отчёты об уроках и первичные оплаты без отдельного отчёта. Совпадения по сделке учтены один раз. Дата МК — из отчёта об уроке, а при его отсутствии — дата первой первичной оплаты. Продления не добавляют МК.');
}

function renderAnalytics() {
  var selection=analyticsSelection(), q=analyticsQuery(), ready={lesson:analyticsReady(['form','payments']),payment:analyticsReady(['payments']),cancel:analyticsReady(['cancels'])};
  var header=document.querySelector('#page-analytics .page-eyebrow'), sub=document.querySelector('#page-analytics .page-sub');
  if(header) header.textContent=avPeriod(q);
  if(sub) sub.textContent='Проведённые МК и оплаты за выбранный период · '+(q.includeRenewals?'с продлениями':'без продлений');
  avTitle('funnel-chart','Факты за период');avHtml('funnel-chart',avFacts(selection.totals,ready));
  avTitle('timeSlotC','Проведённые МК по времени');
  var times=avCount(selection.lessons.map(function(r){return {bucket:r.time?String(r.time).split(':')[0].padStart(2,'0')+':00':'Время не указано'};}),'bucket').sort(function(a,b){return a[0].localeCompare(b[0]);});
  avBars('timeSlot','timeSlotC',times,ready.lesson,'МК');
  avTitle('payDelayC','Связь первичных оплат с МК');
  var primary=selection.payments.filter(function(r){return !r.renewal && r.positive;});
  avBars('payDelay','payDelayC',[['Однозначная связь',primary.filter(function(r){return !!r.lessonRow;}).length],['Без однозначной связи',primary.filter(function(r){return !r.lessonRow;}).length]],ready.payment && ready.lesson,'Оплат','МК подтверждается отчётом об уроке или первичной оплатой. Повторы между источниками объединены по точному CRM ID; при нескольких отчётах об уроке связь остаётся неоднозначной.');
  avTitle('ageC','Возраст в отчётах о МК');avBars('age','ageC',avCount(selection.lessons,'age'),ready.lesson,'МК');
  avBars('paytype','paytypeC',avCount(selection.payments,'paytype'),ready.payment,'Отчётов об оплатах');
  avBars('obj','objC',avCount(selection.lessons,'objection'),ready.lesson,'МК');
  avBars('pract','practC',avCount(selection.lessons,'practice'),ready.lesson,'МК');
  avTitle('packC','Пакеты в отчётах об оплатах');avBars('pack','packC',avCount(selection.payments,'pack'),ready.payment,'Отчётов об оплатах');
  var daily=SalesAnalytics.daily(analyticsModel,q), labels=daily.map(function(r){return avDate(r.day);});
  avTitle('revdayC','Выручка по дате оплаты');
  avChart('revday','revdayC',labels,[{label:'Выручка, ₽',data:daily.map(function(r){return r.rev;}),backgroundColor:'#f5c84288'}],ready.payment,'По отчётам об оплатах; состав совпадает с выбранным фильтром продлений. '+avPaymentCaveat(selection.payments));
  avTitle('convC','Оплаты дня / МК дня');
  avChart('conv','convC',labels,[{label:'Оплаты / МК, %',data:daily.map(function(r){return r.conv;}),type:'line',borderColor:'#3ecf8e',backgroundColor:'transparent',spanGaps:false,yAxisID:'ratio'}],ready.payment && ready.lesson,'Отношение потоков одного дня. Может превышать 100% из-за отложенных оплат. При нуле МК — нет значения.');
  avTitle('all-table','Каналы и журналы событий');avHtml('all-table',(ready.lesson?'<details><summary style="cursor:pointer;padding:10px 0;font-weight:600">Маркетинговые каналы проведённых МК</summary>'+avTable(['Канал из отчёта','МК'],avCount(selection.lessons,'channel').map(function(row){return [esc(row[0]),String(row[1])];}))+'</details>':'')+avRegisters(selection,ready.lesson,ready.payment));
}

function renderCancels() {
  var selection=analyticsSelection(), ready=analyticsReady(['cancels']), lessonReady=analyticsReady(['form','payments']), t=selection.totals;
  avHtml('cancels-kpi','<div class="ms4">'+[['МК по отчётам',lessonReady?t.mk:null],['Отчёты об отменах',ready?t.cancelled:null],['МК / (МК + отмены)',ready && lessonReady?t.attendance:null]].map(function(item,i){return '<div class="kpi"><div class="kl">'+esc(item[0])+'</div><div class="kv">'+avNumber(item[1],i===2?'%':'')+'</div></div>';}).join('')+'</div>'+avNote('Оценка по отчётам, не точная доходимость записанных клиентов. Отмены относятся к дате отправки отчёта; МК — к дате занятия. Историческая полнота записей и переносы не подтверждены.'));
  var daily=SalesAnalytics.daily(analyticsModel,analyticsQuery());
  avTitle('arrivalDayC','МК и отчёты об отменах по дням');
  var datasets=[];
  if(lessonReady)datasets.push({label:'МК',data:daily.map(function(r){return r.mk;}),backgroundColor:'#3ecf8e88'});
  if(ready)datasets.push({label:'Отчёты отмен',data:daily.map(function(r){return r.cancelled;}),backgroundColor:'#f0525288'});
  avChart('arrivalDay','arrivalDayC',daily.map(function(r){return avDate(r.day);}),datasets,ready||lessonReady,ready && lessonReady?'': 'Один из источников не загружен; показан только доступный ряд.');
  avBars('cancelReason','cancelReasonC',avCount(selection.cancels,'reason'),ready);
  avBars('cancelFirst','cancelFirstC',avCount(selection.cancels,'is_first'),ready);
  avBars('cancelContact','cancelContactC',avCount(selection.cancels,'contact',true),ready,'Упоминаний','Один отчёт может содержать несколько способов связи.');
  avBars('cancelAge','cancelAgeC',avCount(selection.cancels,'age'),ready);
  avBars('cancelMgr','cancelMgrC',avCount(selection.cancels,'manager'),ready);
  avHtml('cancels-table',ready?avTable(['Отчёт отправлен','Менеджер','Причина','Комментарий','CRM','Источник'],selection.cancels.slice().sort(function(a,b){return b.day.localeCompare(a.day)||b.row-a.row;}).map(function(r){return [esc(avDate(r.day)),esc(avName(r.manager)),esc(r.reason||'—'),esc(r.comment||'—'),avCrm(r),avOrigin(r)];})):avUnavailable());
}

function weekConv(name,weeksAgo) {
  if(!analyticsReady(['form','payments']))return null;
  var bounds=SalesAnalytics.period('week'),d=new Date(bounds.from+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()-7*(weeksAgo||0));var from=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+6);
  var q=Object.assign({},analyticsQuery(name),{from:from,to:d.toISOString().slice(0,10)});
  return SalesAnalytics.select(analyticsModel,q).totals.conv;
}
function renderManagers() {
  var q=analyticsQuery(), selection=analyticsSelection(), lessonReady=analyticsReady(['form','payments']), payReady=analyticsReady(['payments']), names=new Set();
  if(lessonReady)selection.lessons.forEach(function(r){names.add(r.manager||'__unassigned__');});
  if(payReady)selection.payments.forEach(function(r){names.add(r.manager||'__unassigned__');});
  if(analyticsReady(['cancels']))selection.cancels.forEach(function(r){names.add(r.manager||'__unassigned__');});
  if(q.manager)names.add(q.manager);
  else (analyticsModel.managers||[]).forEach(function(m){if(m.active)names.add(m.name);});
  var rows=Array.from(names).map(function(name){return {name:name,t:analyticsSelection(name).totals};}).sort(function(a,b){return payReady?(b.t.rev||0)-(a.t.rev||0):a.name.localeCompare(b.name,'ru');});
  var header=document.querySelector('#mgr-page-hdr .page-eyebrow'),sub=document.querySelector('#mgr-page-hdr .page-sub');
  if(header)header.textContent=avPeriod(q);if(sub)sub.textContent='Деньги относятся к менеджеру оплаты, МК — к менеджеру занятия. '+(q.includeRenewals?'Продления включены. ':'Продления исключены. ')+(payReady?avPaymentCaveat(selection.payments):'Источник оплат не загружен. ')+(!lessonReady?'Источник МК не загружен.':'');
  avHtml('mgr-cards',rows.length?rows.map(function(r){var name=r.name==='__unassigned__'?'Не указан':r.name;return '<button type="button" class="mgr-card" data-av-manager="'+esc(r.name)+'" style="text-align:left;color:var(--text);font:inherit;cursor:pointer"><div class="mgr-card-head"><div class="mgr-card-avatar emoji">'+esc(mgrEmoji(name))+'</div><div><div class="mgr-card-name">'+esc(name)+'</div><div class="mgr-card-sub">'+avNumber(lessonReady?r.t.mk:null)+' МК · '+avNumber(payReady?r.t.paid:null)+' оплат</div></div></div><div class="mgr-card-stats"><div class="mgr-stat"><div class="mgr-stat-lbl">Выручка</div><div class="mgr-stat-val">'+avMoney(payReady?r.t.rev:null)+'</div></div><div class="mgr-stat"><div class="mgr-stat-lbl">Оплаты / МК</div><div class="mgr-stat-val">'+avNumber(lessonReady&&payReady?r.t.conv:null,'%')+'</div></div></div></button>';}).join(''):avNote('Нет событий за выбранный период.'));
  document.querySelectorAll('[data-av-manager]').forEach(function(button){button.addEventListener('click',function(){openMgr(button.dataset.avManager);});});
  if(currentDetailManager)avRenderManagerDetail(currentDetailManager);
}
function avRenderManagerDetail(name) {
  var selection=analyticsSelection(name), t=selection.totals, lessonReady=analyticsReady(['form','payments']), payReady=analyticsReady(['payments']);
  avText('mname',name==='__unassigned__'?'Не указан':name);avText('mav',mgrEmoji(name));avText('msub',avPeriod(analyticsQuery(name))+' · деньги по дате оплаты, МК по дате занятия');
  var cards=[['МК по отчётам',avNumber(lessonReady?t.mk:null)],['Оплаты',avNumber(payReady?t.paid:null)],['Выручка',avMoney(payReady?t.rev:null)],['Оплаты / МК',avNumber(lessonReady&&payReady?t.conv:null,'%')],['Средний платёж',avMoney(payReady?t.avg:null)],['Выручка / МК',avMoney(lessonReady&&payReady?t.rpm:null)],['Первичная выручка',avMoney(payReady?t.primaryRev:null)],['Выручка продлений',avMoney(payReady?t.renewalRev:null)]];
  avHtml('mstats',cards.map(function(item){return '<div class="kpi"><div class="kl">'+esc(item[0])+'</div><div class="kv" style="font-size:17px">'+esc(item[1])+'</div></div>';}).join(''));
  var daily=SalesAnalytics.daily(analyticsModel,analyticsQuery(name));avTitle('mwC','Выручка по дате оплаты');avBars('mw','mwC',daily.map(function(r){return [avDate(r.day),r.rev];}),payReady,'Выручка, ₽');
  avBars('mo','moC',avCount(selection.lessons,'objection'),lessonReady,'МК');
  avTitle('mlessons','Журналы менеджера');avHtml('mlessons',avRegisters(selection,lessonReady,payReady));
}
function openMgr(name) {
  currentDetailManager=name;avRenderManagerDetail(name);
  document.getElementById('mgr-list').style.display='none';document.getElementById('mgr-detail').style.display='block';showPage('managers');
}

function renderRetention() {
  var q=analyticsQuery(), ready=analyticsReady(['payments']), selection=analyticsSelection();
  var page=document.getElementById('page-retention');
  if(page){var sub=page.querySelector('.page-sub'),eyebrow=page.querySelector('.page-eyebrow');if(sub)sub.textContent='Повторные оплаты по точному CRM ID. Одна сделка не обязательно равна одному клиенту.';if(eyebrow)eyebrow.textContent=avPeriod(q)+' · '+(q.includeRenewals?'с продлениями':'без продлений');}
  [['ret-k-count','Оплат продления за период'],['ret-k-rev','Выручка продлений за период'],['ret-k-churn','Сделки с повторной оплатой'],['ret-k-ltv','Выручка на сделку за доступную историю']].forEach(function(pair){var el=document.getElementById(pair[0]),card=el&&el.closest('.kpi');if(card&&card.querySelector('.kl'))card.querySelector('.kl').textContent=pair[1];});
  if(!ready){['ret-k-count','ret-k-rev','ret-k-churn','ret-k-ltv'].forEach(function(id){avText(id,'—');});['ret-k-count-s','ret-k-rev-s','ret-k-churn-s','ret-k-ltv-s'].forEach(function(id){avText(id,'Источник оплат не загружен');});['ret-mgr-table','ret-cohort','ret-log'].forEach(function(id){avHtml(id,avUnavailable());});avChart('retMonth','retMonthC',[],[],false);return;}
  var history=SalesAnalytics.select(analyticsModel,Object.assign({},q,{from:'',to:q.to})).payments;
  var byCrm=new Map();history.forEach(function(p){if(!p.crmId)return;if(!byCrm.has(p.crmId))byCrm.set(p.crmId,[]);byCrm.get(p.crmId).push(p);});
  var known=Array.from(byCrm.values()), repeat=known.filter(function(rows){return rows.filter(function(p){return p.positive;}).length>1;}).length;
  var validKnown=known.filter(function(rows){return rows.some(function(p){return p.positive;});});
  var knownRevenue=validKnown.reduce(function(sum,rows){return sum+rows.reduce(function(s,p){return s+(p.amountMinor===null?0:p.amountMinor);},0);},0)/100;
  var invalidAmounts=history.filter(function(p){return p.amountMinor===null;}).length;
  avText('ret-k-count',avNumber(selection.totals.renewalPaid));avText('ret-k-count-s','В выбранном периоде и составе оплат');
  avText('ret-k-rev',avMoney(selection.totals.renewalRev));avText('ret-k-rev-s','По отчётам об оплатах');
  avText('ret-k-churn',repeat+' / '+validKnown.length);avText('ret-k-churn-s','За историю до '+avDate(q.to)+'; повторный платёж может быть доплатой');
  avText('ret-k-ltv',avMoney(invalidAmounts?null:(validKnown.length?knownRevenue/validKnown.length:null)));
  avText('ret-k-ltv-s',history.filter(function(p){return !p.crmId;}).length+' оплат без CRM исключено'+(invalidAmounts?'; есть некорректные суммы':''));
  var daily=SalesAnalytics.daily(analyticsModel,q);avTitle('retMonthC','Выручка оплат за выбранный период');avChart('retMonth','retMonthC',daily.map(function(d){return avDate(d.day);}),[{label:'Первичная, ₽',data:daily.map(function(d){return d.primaryRev;}),backgroundColor:'#60a5fa88'},{label:'Продления, ₽',data:daily.map(function(d){return d.renewalRev;}),backgroundColor:'#3ecf8e88'}],true);
  var mgrs=new Map();selection.payments.forEach(function(p){var key=p.manager||'__unassigned__';if(!mgrs.has(key))mgrs.set(key,[]);mgrs.get(key).push(p);});
  avTitle('ret-mgr-table','Оплаты по менеджерам за период');avHtml('ret-mgr-table',avTable(['Менеджер','Первичных оплат','Продлений','Выручка'],Array.from(mgrs).map(function(entry){var rows=entry[1],invalid=rows.some(function(p){return p.amountMinor===null;});return [esc(entry[0]==='__unassigned__'?'Не указан':entry[0]),String(rows.filter(function(p){return !p.renewal&&p.positive;}).length),String(rows.filter(function(p){return p.renewal&&p.positive;}).length),esc(avMoney(invalid?null:rows.reduce(function(s,p){return s+p.amountMinor;},0)/100))];})));
  var cohorts=new Map();validKnown.forEach(function(rows){var first=rows.filter(function(p){return p.positive&&!p.renewal;}).sort(function(a,b){return a.day.localeCompare(b.day)||a.row-b.row;})[0];if(!first)return;var month=first.day.slice(0,7);if(!cohorts.has(month))cohorts.set(month,[]);cohorts.get(month).push(rows);});
  var effectiveEnd=q.to<SalesAnalytics.period('today').from?q.to:SalesAnalytics.period('today').from;
  var endMonth=effectiveEnd.slice(0,7), cohortRows=Array.from(cohorts).sort(function(a,b){return b[0].localeCompare(a[0]);}).map(function(entry){var month=entry[0],groups=entry[1],cells=[esc(month),String(groups.length)];for(var offset=1;offset<=6;offset++){var parts=month.split('-').map(Number),date=new Date(Date.UTC(parts[0],parts[1]-1+offset,1)),target=date.toISOString().slice(0,7);if(target>endMonth){cells.push('—');continue;}var count=groups.filter(function(rows){return rows.some(function(p){return p.positive&&p.renewal&&p.day.slice(0,7)===target;});}).length;cells.push(Math.round(count/groups.length*100)+'% · '+count+'/'+groups.length+(target===endMonth&&Number(effectiveEnd.slice(8))<new Date(Date.UTC(Number(effectiveEnd.slice(0,4)),Number(effectiveEnd.slice(5,7)),0)).getUTCDate()?'<br><span class="ops-note">месяц не закрыт</span>':''));}return cells;});
  avTitle('ret-cohort','Сделки с оплатой продления по месяцам');avHtml('ret-cohort',q.includeRenewals===false?avNote('Продления исключены выбранным фильтром. Для просмотра повторных покупок включите продления.') : avNote('Когорта — месяц первой наблюдаемой первичной оплаты. В ячейке уникальные CRM-сделки с продлением, не число платежей. Это не отток: сроки пакетов неизвестны. История ограничена доступными отчётами, фильтром менеджера и датой конца периода.')+avTable(['Когорта','Сделок','M+1','M+2','M+3','M+4','M+5','M+6'],cohortRows));
  avTitle('ret-log','Оплаты за выбранный период');avHtml('ret-log',avPaymentRegister(selection.payments));
}
