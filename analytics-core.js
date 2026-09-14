/* Independent source facts and pure analytics. No requests, storage or writes. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SalesAnalytics = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  var clean = function (value) { return value == null ? '' : String(value).trim(); };
  var pad = function (value) { return String(value).padStart(2, '0'); };
  var calendar = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
  function instantDay(value) {
    var date = new Date(value), parts = {};
    if (!Number.isFinite(date.getTime())) return '';
    calendar.formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function dateKey(value) {
    var text = clean(value), match, y, m, d;
    var iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$)/i;
    if ((match = text.match(iso))) { y=+match[1];m=+match[2];d=+match[3]; }
    else if ((match=text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:$|\s\d{1,2}:\d{2}(?::\d{2})?$)/))) { y=+match[3];m=+match[2];d=+match[1]; }
    else if ((match=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s\d{1,2}:\d{2}(?::\d{2})?$)/))) { y=+match[3];m=+match[1];d=+match[2]; }
    else return '';
    var date = new Date(Date.UTC(y,m-1,d));
    if (y<1900 || date.getUTCFullYear()!==y || date.getUTCMonth()!==m-1 || date.getUTCDate()!==d) return '';
    var clock=text.match(/[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(clock && (+clock[1]>23 || +clock[2]>59 || +(clock[3]||0)>59)) return '';
    if (/\d{4}-\d{2}-\d{2}[T\s].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return instantDay(text.replace(' ','T'));
    return y+'-'+pad(m)+'-'+pad(d);
  }
  function displayDate(day) { return day ? day.slice(8,10)+'.'+day.slice(5,7)+'.'+day.slice(0,4) : ''; }
  function money(value) {
    var text=clean(value).replace(/\u2212/g,'-').replace(/\s*(?:₽|руб\.?|RUB)$/i,'').trim();
    if (!/^[+-]?(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d{1,2})?$/.test(text)) return null;
    text=text.replace(/[ \u00a0\u202f]/g,'').replace(',','.');
    var negative=text[0]==='-', parts=text.replace(/^[+-]/,'').split('.');
    var minor=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
    return Number.isSafeInteger(minor) ? (negative?-minor:minor) : null;
  }
  function extractCrmId(value) {
    var text=clean(value);
    if (/^\d+$/.test(text)) return text;
    try {
      var url=new URL(text);
      if (!/^https?:$/.test(url.protocol)) return '';
      var match=url.pathname.match(/\/(?:leads\/)?detail\/(\d+)\/?$/) || url.pathname.match(/\/leads\/(\d+)\/?$/);
      return match?match[1]:'';
    } catch (_) { return ''; }
  }
  function sourceRows(rows) {
    return (Array.isArray(rows)?rows:[]).slice(1).map(function (row,index) { return {cells:row,row:index+2}; })
      .filter(function (entry) { return Array.isArray(entry.cells)&&entry.cells.some(function (value) { return clean(value); }); });
  }
  function buildModel(input) {
    input=input||{};
    function optionalColumn(source,pattern){return ((input[source]||[])[0]||[]).findIndex(function(header){return pattern.test(clean(header));});}
    var channelColumn=optionalColumn('form',/канал/i),notesColumn=optionalColumn('form',/комментар|примечан|заметк/i),recordingColumn=optionalColumn('payments',/запись.*урок|записи.*урок/i);
    var managers=sourceRows(input.managers).map(function (entry) { return {name:clean(entry.cells[0]),active:/^(да|yes|1)$/i.test(clean(entry.cells[1]))}; }).filter(function (manager) {return manager.name;});
    var names=Array.from(new Set(managers.map(function (manager) {return manager.name;}))), aliases=input.managerAliases||{};
    function canonical(raw) {
      var name=clean(raw).replace(/\s+/g,' ');
      if (Object.prototype.hasOwnProperty.call(aliases,name)) name=clean(aliases[name]);
      var exact=names.find(function (item) {return item.toLowerCase()===name.toLowerCase();});
      if(exact) return exact;
      var pattern=/^([a-zа-яё]+(?:-[a-zа-яё]+)*) ([a-zа-яё][a-zа-яё.]*)$/i, parts=name.match(pattern);
      var candidates=parts?names.filter(function (item) {var p=item.match(pattern);return p&&p[1].toLowerCase()===parts[1].toLowerCase()&&p[2][0].toLowerCase()===parts[2][0].toLowerCase();}):[];
      return candidates.length===1?candidates[0]:name;
    }
    function base(entry,source,manager,crm,date) {
      var day=dateKey(date), name=canonical(manager), rawCrm=clean(crm), id=extractCrmId(rawCrm), issues=[];
      if(!day) issues.push('invalid_date');
      if(!name) issues.push('missing_manager'); else if(!names.includes(name)) issues.push('unknown_manager');
      if(!rawCrm) issues.push('missing_crm'); else if(!id) issues.push('invalid_crm');
      return {source:source,row:entry.row,issues:issues,ts:clean(entry.cells[0]),manager:name,crm:rawCrm,crmId:id,day:day,date:displayDate(day)};
    }
    function parse(source, mapper) {
      var entries=sourceRows(input[source]), records=entries.map(mapper), groups=new Map();
      entries.forEach(function (entry,index) {var key=JSON.stringify(entry.cells.map(clean));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(index);});
      groups.forEach(function (indices) {if(indices.length>1)indices.forEach(function (index) {records[index].issues.push('possible_duplicate');});});
      return records;
    }
    var lessons=parse('form',function (entry) {
      var r=entry.cells, fact=base(entry,'form',r[1],r[4],r[2]);
      return Object.assign(fact,{time:clean(r[3]),rec:clean(r[5]),practice:clean(r[6]),age:clean(r[7]),pack:clean(r[8]),paymentVariant:clean(r[9]),agreement:clean(r[10]),objection:clean(r[11]),notes:notesColumn>=0?clean(r[notesColumn]):'',channel:channelColumn>=0?clean(r[channelColumn]):'',paid:false});
    });
    var payments=parse('payments',function (entry) {
      var r=entry.cells,fact=base(entry,'payments',r[1],r[2],r[3]),minor=money(r[7]);
      if(minor===null)fact.issues.push('invalid_amount');
      if(minor<0)fact.issues.push('negative_correction');
      return Object.assign(fact,{paydate:fact.date,practice:clean(r[4]),pack:clean(r[5]),paytype:clean(r[6]),rec:recordingColumn>=0?clean(r[recordingColumn]):'',renewal:/продлен|повторн/i.test(clean(r[6])),amountMinor:minor,rev:minor===null?null:minor/100,positive:minor!==null&&minor>0,lessonRow:null});
    });
    var cancels=parse('cancels',function (entry) {
      var r=entry.cells;return Object.assign(base(entry,'cancels',r[7],r[1],r[0]),{reason:clean(r[2]),is_first:clean(r[3]),contact:clean(r[4]),age:clean(r[5]),comment:clean(r[6])});
    });
    var lessonReports=lessons.slice(),lessonIds=new Map();
    lessons.forEach(function (lesson) {if(lesson.crmId){if(!lessonIds.has(lesson.crmId))lessonIds.set(lesson.crmId,[]);lessonIds.get(lesson.crmId).push(lesson);}});
    // A primary payment form also reports a paid MK. Reconcile across the full
    // history before filtering dates, so later instalments cannot add another MK.
    var paidReports=new Map();
    payments.forEach(function(payment){
      if(payment.renewal || !payment.positive || lessonIds.has(payment.crmId))return;
      var key=payment.crmId?'crm:'+payment.crmId:'row:'+payment.row;
      if(!paidReports.has(key))paidReports.set(key,[]);
      paidReports.get(key).push(payment);
    });
    paidReports.forEach(function(rows){
      rows.sort(function(a,b){return (a.day||'9999').localeCompare(b.day||'9999')||a.row-b.row;});
      var first=rows[0],conflict=new Set(rows.map(function(p){return p.manager;}).filter(Boolean)).size>1;
      if(conflict)rows.forEach(function(p){p.issues.push('conflicting_lesson_manager');});
      var lesson=Object.assign({},first,{manager:conflict?'':first.manager,paid:true,scenario:'pay_on_lesson',dateBasis:'payment',time:'',age:'',channel:'',objection:'',agreement:'',notes:''});
      lessons.push(lesson);
      if(first.crmId)lessonIds.set(first.crmId,[lesson]);
      else {first.lessonRow=first.row;first.lessonSource='payments';}
    });
    payments.forEach(function (payment) {
      var candidates=lessonIds.get(payment.crmId)||[];
      if(payment.crmId&&candidates.length===1){payment.lessonRow=candidates[0].row;payment.lessonSource=candidates[0].source;if(payment.positive&&!payment.renewal)candidates[0].paid=true;}
      else if(candidates.length>1)payment.issues.push('ambiguous_lesson');
      else if(payment.crmId&&!payment.renewal)payment.issues.push('unmatched_lesson');
    });
    var issues=[];
    lessonReports.concat(payments,cancels).forEach(function (fact) {fact.issues.forEach(function (code) {issues.push({source:fact.source,row:fact.row,code:code});});});
    return {lessons:lessons,lessonReports:lessonReports,payments:payments,cancels:cancels,managers:managers,issues:issues};
  }
  function select(model,query) {
    query=query||{};
    var from=query.from?dateKey(query.from):'',to=query.to?dateKey(query.to):'';
    var invalid=(query.from&&!from)||(query.to&&!to)||(from&&to&&from>to);
    function matches(fact) {return !invalid&&!!fact.day&&(!from||fact.day>=from)&&(!to||fact.day<=to)&&(!query.manager||(query.manager==='__unassigned__'?!fact.manager:fact.manager===query.manager));}
    var lessons=model.lessons.filter(matches),payments=model.payments.filter(function (fact) {return matches(fact)&&(query.includeRenewals!==false||!fact.renewal);}),cancels=model.cancels.filter(matches);
    var primary=payments.filter(function (p) {return !p.renewal;}),renewals=payments.filter(function (p) {return p.renewal;});
    function count(rows) {return rows.filter(function (p) {return p.positive;}).length;}
    function sum(rows) {return rows.reduce(function (total,p) {return total+(p.amountMinor===null?0:p.amountMinor);},0)/100;}
    var mk=lessons.length,paid=count(payments),rev=sum(payments),cancelled=cancels.length;
    return {lessons:lessons,payments:payments,cancels:cancels,totals:{mk:mk,paid:paid,rev:rev,conv:mk?paid/mk*100:null,avg:paid?rev/paid:null,rpm:mk?rev/mk:null,primaryPaid:count(primary),renewalPaid:count(renewals),primaryRev:sum(primary),renewalRev:sum(renewals),cancelled:cancelled,attendance:mk+cancelled?mk/(mk+cancelled)*100:null}};
  }
  function period(mode,options) {
    options=options||{};
    if(mode==='custom'){var from=dateKey(options.from),to=dateKey(options.to);return from&&to&&from<=to?{from:from,to:to}:{from:'',to:''};}
    var today=instantDay(options.now===undefined?new Date():options.now);
    if(!today)return {from:'',to:''};
    var date=new Date(today+'T00:00:00Z'),start=new Date(date),end=new Date(date);
    if(mode==='week'){start.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);end=new Date(start);end.setUTCDate(start.getUTCDate()+6);}
    if(mode==='month'){start.setUTCDate(1);end=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0));}
    return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
  }
  function daily(model,query) {
    var selected=select(model,query),days=Array.from(new Set(selected.lessons.concat(selected.payments,selected.cancels).map(function (fact) {return fact.day;}))).sort();
    return days.map(function (day) {return Object.assign({day:day},select(model,Object.assign({},query,{from:day,to:day})).totals);});
  }
  return Object.freeze({buildModel:buildModel,select:select,daily:daily,period:period,dateKey:dateKey,parseMoney:money,extractCrmId:extractCrmId});
});
