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
