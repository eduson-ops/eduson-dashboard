export function businessDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow', year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
export function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate()+amount);
  return value.toISOString().slice(0,10);
}
export function weekDates(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const monday = addDays(date, -(day === 0 ? 6 : day-1));
  return Array.from({length:7},(_,i)=>addDays(monday,i));
}
export function safeUrl(value) {
  if (!/^https?:\/\//i.test(String(value || ''))) return '';
  try {const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : '';} catch {return '';}
}
export function matchesSearch(booking, query) {
  const term = String(query || '').trim().toLocaleLowerCase('ru');
  return !term || [booking.studentName,booking.parentName,booking.phone,booking.crmUrl,booking.assignedName].some(v=>String(v||'').toLocaleLowerCase('ru').includes(term));
}
export function isHourOverloaded(hour) {
  return hour.deficit == null
    ? Number(hour.confirmed || 0) > Number(hour.managers || 0)
    : Number(hour.deficit) > 0;
}
export function filterHourBookings(bookings, {time,tag='',search=''} = {}) {
  const range=tag ? String(tag).match(/^(\d+)\s*[-–—]\s*(\d+)$/) : null;
  return bookings.filter(booking=>booking.time===time && matchesSearch(booking,search)
    && (!tag || (range && Number(booking.age)>=Number(range[1]) && Number(booking.age)<=Number(range[2]))));
}
export function booleanFact(value, yes, no, unknown='Не указано') {
  return value === true ? yes : value === false ? no : unknown;
}
export function legacyOutcomeUnknown(booking) {
  return booking?.state === 'scheduled' && booking.legacy?.elapsedUnknown === true;
}
export function canResolveLegacy(actor, booking) {
  return actor?.role === 'admin' && legacyOutcomeUnknown(booking);
}
export function canConfirmBooking(actor,booking,now=new Date()) {
  const timing=confirmationTiming(booking||{},now);
  return ['admin','confirmation'].includes(actor?.role)&&booking?.state==='scheduled'
    &&booking.confirmationStatus==='pending'&&!booking.historyOnly&&!legacyOutcomeUnknown(booking)
    &&Boolean(timing.due)&&!timing.overdue;
}
export function canAssignBooking(actor,booking) {
  return actor?.role==='admin'&&booking?.state==='scheduled'&&booking.confirmationStatus==='confirmed'
    &&!booking.historyOnly&&!legacyOutcomeUnknown(booking);
}
export function canRestoreBooking(actor,booking,now=new Date()) {
  return ['admin','confirmation','call_center'].includes(actor?.role)&&booking?.state==='cancelled'
    &&!booking.historyOnly&&new Date(booking.endsAt)>now;
}
export function legacyResolutionManagers(actor,booking,activeManagers=[],users=[]) {
  if(actor?.role!=='admin')return [];
  const source=booking?.historyOnly?users:activeManagers;
  return [...new Map(source.filter(manager=>booking?.historyOnly?manager.role==='sales':manager.active!==false)
    .map(manager=>[manager.id,manager])).values()];
}
export function canEditDetails(actor, booking) {
  if(!actor || !booking)return false;
  return ['admin','confirmation'].includes(actor.role)
    || (actor.role === 'call_center' && Boolean(actor.id) && booking.createdBy === actor.id)
    || (actor.role === 'sales' && Boolean(actor.id) && booking.assignedTo === actor.id);
}
const detailFields=['studentName','parentName','phone','crmUrl','age','hasPc','parentPresent','comment'];
function normalizeDetail(field, value) {
  if(['hasPc','parentPresent'].includes(field))return value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
  if(field === 'age')return value === '' || value == null ? null : Number(value);
  return String(value ?? '').trim();
}
export function changedDetails(original, values) {
  const changes={};
  for(const field of detailFields){
    if(!Object.hasOwn(values,field))continue;
    const value=normalizeDetail(field,values[field]);
    if(!Object.is(value,normalizeDetail(field,original[field])))changes[field]=value;
  }
  return changes;
}
export function effectiveReserveCapacity(interval, day) {
  return Number(interval.reserveCapacity ?? day.reserveCapacity ?? 1);
}
export function setDayReserveCapacity(day, value) {
  const reserveCapacity=Number(value);
  const update=intervals=>intervals.map(interval=>({...interval,reserveCapacity}));
  return {...day,reserveCapacity,intervals:update(day.intervals),...(day.disabledIntervals?{disabledIntervals:update(day.disabledIntervals)}:{})};
}
export function schedulePayload(day, {managerId,ageGroups}) {
  return {managerId,date:day.date,intervals:day.intervals.map(interval=>({start:interval.start,end:interval.end,...(interval.reserveCapacity == null?{}:{reserveCapacity:Number(interval.reserveCapacity)})})),ageGroups:[...ageGroups],reserveCapacity:Number(day.reserveCapacity??1),version:Number(day.version||0)};
}
export function confirmationTiming(booking, now = new Date()) {
  const due = new Date(booking.confirmationDueAt);
  const valid = Number.isFinite(due.getTime());
  return {due:valid?due:null, overdue:booking.confirmationStatus !== 'confirmed' && valid && due < now};
}
export function makeDraftStore(storage, userId) {
  const key = name => `eduson.booking.draft.${userId}.${name}`;
  return {
    read(name) {try {return JSON.parse(storage.getItem(key(name)) || '{}') || {};} catch {return {};}},
    save(name,value) {try {storage.setItem(key(name),JSON.stringify(value));} catch {}},
    remove(name) {try {storage.removeItem(key(name));} catch {}}
  };
}

export function selectableBookingSlots(rows,date,now=new Date()) {
  const found=new Map();
  for(const slot of rows||[]){
    const match=/^(\d{2}):(\d{2})$/.exec(String(slot.time||''));
    if(slot.date!==date || !match || Number(match[1])>23 || Number(match[2])>59)continue;
    const remaining=Number(slot.remaining);
    if(!Number.isFinite(remaining)||remaining<=0)continue;
    const startsAt=new Date(`${date}T${slot.time}:00+03:00`);
    if(!Number.isFinite(+startsAt)||+startsAt-+now<7200000)continue;
    if(!found.has(slot.time))found.set(slot.time,slot);
  }
  return [...found.values()].sort((a,b)=>a.time.localeCompare(b.time));
}

export function isBookingSelectionAvailable(rows,date,time,now=new Date()) {
  return selectableBookingSlots(rows,date,now).some(slot=>slot.time===time);
}

export function bookingDateRail(date,today=businessDate()) {
  const first=addDays(date,-2)<today?today:addDays(date,-2);
  return Array.from({length:5},(_,index)=>addDays(first,index));
}

export function bookingIntervalEnd(time) {
  const match=/^(\d{2}):(\d{2})$/.exec(String(time||''));
  if(!match||Number(match[1])>23||Number(match[2])>59)return null;
  const total=Number(match[1])*60+Number(match[2])+60;
  return {time:`${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`,dayOffset:Math.floor(total/1440)};
}

export function bookingStatusPresentation(booking) {
  const state=booking?.state;
  if(state==='completed')return {tone:'completed',label:'Завершён',outcomeUnknown:false};
  if(state==='cancelled')return {tone:'cancelled',label:'Отменён',outcomeUnknown:false};
  if(state==='in_progress')return {tone:'in_progress',label:'Урок в работе',outcomeUnknown:false};
  return {tone:booking?.confirmationStatus==='confirmed'?'confirmed':'pending',label:booking?.confirmationStatus==='confirmed'?'Урок подтверждён':'Ожидает подтверждения',outcomeUnknown:legacyOutcomeUnknown(booking)};
}

export function filterHourMetricBookings(bookings,{date,time,tag='',metric='all',allocations=[]}={}) {
  const allocatedReserve=new Set(allocations.filter(item=>item.kind==='reserve').map(item=>item.bookingId));
  return filterHourBookings(bookings,{time,tag}).filter(booking=>{
    if(date&&booking.date!==date)return false;
    const active=booking.state!=='cancelled';
    if(metric==='total')return true;
    if(metric==='capacityHeld')return active&&booking.capacityHold===true;
    if(metric==='reserve')return active&&(allocatedReserve.has(booking.id)||booking.assignmentKind==='reserve');
    if(metric==='confirmed')return active&&booking.confirmationStatus==='confirmed';
    if(metric==='cancelledConfirmation')return !active&&['confirmation','call_center','system'].includes(booking.cancelSource);
    if(metric==='cancelledSales')return !active&&booking.cancelSource==='sales';
    if(metric==='completed')return booking.state==='completed';
    if(metric==='inProgress')return booking.state==='in_progress';
    return true;
  });
}

export function rollingScheduleDates(from,count=14) {
  return Array.from({length:count},(_,index)=>addDays(from,index));
}

export function scheduleHourEntries(day) {
  const entries=new Map();
  for(const interval of day?.intervals||[]){
    const start=/^(\d{2}):00$/.exec(interval.start),end=/^(\d{2}):00$/.exec(interval.end);
    if(!start||!end)continue;
    for(let hour=Number(start[1]);hour<Number(end[1]);hour++)entries.set(hour,effectiveReserveCapacity(interval,day));
  }
  return entries;
}

export function scheduleDayFromHours(day,entries) {
  const sorted=[...entries].sort(([left],[right])=>left-right);
  const intervals=[];
  for(const [hour,reserveCapacity] of sorted){
    const start=`${String(hour).padStart(2,'0')}:00`,end=`${String(hour+1).padStart(2,'0')}:00`;
    const previous=intervals.at(-1);
    if(previous&&previous.end===start&&previous.reserveCapacity===reserveCapacity)previous.end=end;
    else intervals.push({start,end,reserveCapacity});
  }
  return {...day,intervals};
}

export function setScheduleHour(day,hour,{enabled,reserveCapacity}={}) {
  if(!Number.isInteger(hour)||hour<10||hour>21)return day;
  const entries=scheduleHourEntries(day);
  const shouldEnable=enabled??!entries.has(hour);
  if(shouldEnable)entries.set(hour,Number(reserveCapacity??entries.get(hour)??day.reserveCapacity??1));
  else entries.delete(hour);
  return scheduleDayFromHours(day,entries);
}

export function unionScheduleWeek(days,sourceDates,targetDates) {
  return days.map(day=>{
    const index=targetDates.indexOf(day.date);
    if(index<0)return day;
    const source=days.find(item=>item.date===sourceDates[index]);
    const entries=scheduleHourEntries(day);
    for(const [hour,reserve] of scheduleHourEntries(source))if(!entries.has(hour))entries.set(hour,reserve);
    return scheduleDayFromHours(day,entries);
  });
}
