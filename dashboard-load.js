/* Read-only source refresh. Failed sources retain their snapshot, but their metrics are unavailable. */
async function loadAllData(){
  if(window.__submittingSchedule)return;
  opsDataReady=false;renderOperations();renderAnalyticsAll();renderSchedule();
  var loader=document.getElementById('loader');if(loader)loader.classList.add('visible');
  try{
    var keys=['form','payments','managers','targets','slots','schedule','cancels'];
    var values=await Promise.all(keys.map(fetchCSV)),raw={};keys.forEach(function(key,index){raw[key]=values[index];});
    analyticsModel=SalesAnalytics.buildModel({form:raw.form,payments:raw.payments,cancels:raw.cancels,managers:raw.managers,managerAliases:OPS_SLOT_MANAGERS});
    opsDataReady=true;
    managers=analyticsModel.managers.filter(function(row){return row.active;}).map(function(row){return row.name;});
    if(!managers.length && !analyticsReady(['managers']))managers=FALLBACK_MGRS.slice();
    window.__canonicalMgr=function(name){return OpsControl.matchManager(name,analyticsModel.managers.map(function(row){return row.name;}),OPS_SLOT_MANAGERS).manager;};
    lessons=analyticsModel.lessons;renewals=analyticsModel.payments.filter(function(row){return row.renewal;});cancelsList=analyticsModel.cancels;
    actualLessonReports=lessons;actualCancelReports=cancelsList;
    opsSlotData=OpsControl.parseSlots(raw.slots,managers,OPS_SLOT_MANAGERS);
    allSlots=opsSlotData.rows.map(function(row){return {date:row.date,time:row.time,who:row.manager,status:'wait'};});
    var day=SalesAnalytics.period('today').from,next=new Date(day+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
    slots=allSlots.filter(function(row){return row.date===day;});tomorrowSlots=allSlots.filter(function(row){return row.date===next.toISOString().slice(0,10);});

    targets={mk:null,rev:null,avg:null,rpm:null,conv:null};
    var monthNames=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    var month=monthNames[Number(day.slice(5,7))-1],year=day.slice(0,4);
    (raw.targets||[]).slice(1).forEach(function(row){
      if(cc(row[0]).toLowerCase().includes(month.toLowerCase())&&cc(row[0]).includes(year)){
        var mk=Number(cc(row[1]));targets={mk:Number.isFinite(mk)&&mk>=0?mk:null,rev:SalesAnalytics.parseMoney(row[2]),avg:SalesAnalytics.parseMoney(row[3]),rpm:SalesAnalytics.parseMoney(row[4]),conv:null};
        ['rev','avg','rpm'].forEach(function(key){if(targets[key]!=null)targets[key]/=100;});
      }
    });
    if(analyticsReady(['schedule']) && !window.__submittingSchedule){
      var parsed={},invalid=false;
      (raw.schedule||[]).slice(1).forEach(function(row){
        if(!row.some(function(cell){return cc(cell);}))return;
        var name=cc(row[0]),dayKey=SalesAnalytics.dateKey(row[1]),clock=cc(row[2]).match(/^(\d{1,2}):00(?::00)?$/);
        if(!name||!dayKey||!clock||Number(clock[1])>23){invalid=true;return;}
        var ds=analyticsDayLabel(dayKey);if(!parsed[name])parsed[name]={};if(!parsed[name][ds])parsed[name][ds]={};parsed[name][ds][Number(clock[1])]=true;
      });
      if(invalid)recordOpsSource('schedule','error',{message:'Есть некорректные строки расписания. Предыдущая версия сохранена.'});
      else scheduleData=parsed;
    }
    opsDataReady=true;renderOperations();renderAnalyticsAll();renderSchedule();
    if(typeof updatePersonaFooter==='function')updatePersonaFooter();
    if(typeof maybeShowOnboarding==='function')maybeShowOnboarding();
  }catch(error){
    opsDataReady=false;
    console.error('dashboard refresh',error);
    document.getElementById('alert-text').textContent='Не удалось обновить дашборд: '+error.message;
  }finally{renderOperations();if(loader)loader.classList.remove('visible');}
}
