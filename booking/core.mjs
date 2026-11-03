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
