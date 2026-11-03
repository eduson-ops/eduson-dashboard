import { randomUUID } from 'node:crypto';
import { createGoogleSheetsClient, SheetSyncError, safeSheetSyncError, normalizeSheetHeader } from './google-sheets-client.mjs';
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;
const DAY_MS = 86_400_000;
const GOOGLE_EPOCH = Date.UTC(1899, 11, 30);
const TABS = [
  {name: 'Расписание', width: 3, last: 'C', headers: [['Менеджер','Manager'],'Дата','Время'], manager: 0, date: 1, time: 2, kind: 'schedule'},
  {name: 'Слоты', width: 5, last: 'E', headers: ['Дата','Время','Менеджер','Статус'], manager: 2, date: 0, time: 1, kind: 'slots'},
];
const fail = code => {throw new SheetSyncError(code);};
const text = value => value == null ? '' : String(value);
const pairKey = row => JSON.stringify([row.date, row.manager]);
const slotKey = row => JSON.stringify([row.date, row.time, row.manager]);
const range = (tab, cells) => `'${tab.name}'!${cells}`;
function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || year < 1900 || year > 9999) fail('SHEET_DATE_INVALID');
  return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function parseDate(value) {
  if (typeof value === 'number' || /^\d{4,7}$/.test(text(value))) {
    const serial = Number(value);
    if (!Number.isInteger(serial) || serial < 1 || serial > 2958465) fail('SHEET_DATE_INVALID');
    const date = new Date(GOOGLE_EPOCH + serial * DAY_MS);
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const input = text(value).trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(input);
  if (match) return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  fail('SHEET_DATE_INVALID');
}
function parseTime(value) {
  if (typeof value === 'number') {
    const minutes = value * 24 * 60;
    if (value < 0 || value >= 1 || Math.abs(minutes - Math.round(minutes)) > 0.000001) fail('SHEET_TIME_INVALID');
    return `${String(Math.floor(Math.round(minutes) / 60)).padStart(2,'0')}:${String(Math.round(minutes) % 60).padStart(2,'0')}`;
  }
  const match = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(text(value).trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) fail('SHEET_TIME_INVALID');
  return `${match[1].padStart(2,'0')}:${match[2]}`;
}
const displayDate = date => `${date.slice(8,10)}.${date.slice(5,7)}.${date.slice(0,4)}`;
function canonicalRow(row, withTime = true) {
  if (!row || typeof row.manager !== 'string' || !row.manager.trim()) fail('SHEET_SNAPSHOT_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(row.date))) fail('SHEET_SNAPSHOT_INVALID');
  return {...row, date: parseDate(row.date), manager: row.manager, ...(withTime ? {time: parseTime(row.time)} : {})};
}
function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.managedSchedules) || !Array.isArray(snapshot.scheduleRows) || !Array.isArray(snapshot.slotRows) || !Array.isArray(snapshot.unresolved)) fail('SHEET_SNAPSHOT_INVALID');
  if (snapshot.unresolved.length) fail('SHEET_SNAPSHOT_UNRESOLVED');
  const managedSchedules = snapshot.managedSchedules.map(row => canonicalRow(row, false));
  const managed = new Set(managedSchedules.map(pairKey));
  const scheduleRows = snapshot.scheduleRows.map(row => canonicalRow(row));
  const slotRows = snapshot.slotRows.map(row => canonicalRow(row));
  const unique = new Set();
  for (const row of scheduleRows) {
    if (!managed.has(pairKey(row)) || unique.has(slotKey(row))) fail('SHEET_SNAPSHOT_INVALID');
    unique.add(slotKey(row));
  }
  for (const row of slotRows) {
    if (!managed.has(pairKey(row)) || !['wait','booked'].includes(row.status) || (row.status === 'booked' && !row.bookingId) || (row.status === 'wait' && row.bookingId)) fail('SHEET_SNAPSHOT_INVALID');
  }
  const ownedBookingIds = [...new Set([...(snapshot.ownedBookingIds || []).map(String), ...slotRows.map(row => text(row.bookingId)).filter(Boolean)])];
  return {managedSchedules, scheduleRows, slotRows, ownedBookingIds};
}
function planTab(tab, values, snapshot, previous) {
  if (!Array.isArray(values) || values.some(row => !Array.isArray(row))) fail('SHEET_RESPONSE_INVALID');
  const header = values[0] || [];
  for (const [index, wanted] of tab.headers.entries()) {
    const allowed=Array.isArray(wanted)?wanted:[wanted];
    if (!allowed.some(value=>normalizeSheetHeader(header[index])===normalizeSheetHeader(value))) fail('SHEET_HEADER_MISMATCH');
  }
  if (tab.kind === 'slots' && text(header[4]) && normalizeSheetHeader(header[4]) !== 'booking id') fail('SHEET_HEADER_MISMATCH');
  const owned = new Set([...snapshot.managedSchedules, ...(previous.managedSchedules || []), ...(previous.attemptedManagedSchedules || [])].map(row => pairKey(canonicalRow(row, false))));
  const knownIds = new Set([...snapshot.ownedBookingIds, ...(previous.ownedBookingIds || []).map(String)]);
  const desired = tab.kind === 'slots' ? snapshot.slotRows : snapshot.scheduleRows;
  const groups = new Map();
  for (const row of desired) {
    const key = slotKey(row);
    const cells = tab.kind === 'slots' ? [displayDate(row.date), row.time, row.manager, row.status, text(row.bookingId)] : [row.manager, displayDate(row.date), row.time];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cells);
  }
  const writes = [];
  const counts = new Map();
  for (let index = 1; index < values.length; index++) {
    const cells = Array.from({length: tab.width}, (_, offset) => values[index][offset] ?? '');
    if (cells.every(value => value === '')) continue;
    const row = {date: parseDate(cells[tab.date]), time: parseTime(cells[tab.time]), manager: text(cells[tab.manager])};
    if (!row.manager.trim()) fail('SHEET_SNAPSHOT_INVALID');
    const belongs = owned.has(pairKey(row));
    if (tab.kind === 'slots' && text(cells[4]) && !knownIds.has(text(cells[4])) && (belongs || !text(header[4]))) fail('SHEET_FOREIGN_OWNER');
    if (!belongs) continue;
    const key = slotKey(row), offset = counts.get(key) || 0;
    const next = groups.get(key)?.[offset] || Array(tab.width).fill('');
    counts.set(key, offset + 1);
    if (cells.some((cell, offset) => cell !== next[offset])) writes.push({range: range(tab, `A${index + 1}:${tab.last}${index + 1}`), values: [next]});
  }
  const append = [];
  for (const [key, rows] of groups) append.push(...rows.slice(counts.get(key) || 0));
  if (tab.kind === 'slots' && !text(header[4])) writes.push({range: range(tab, 'E1:E1'), values: [['Booking ID']]});
  return {tab, writes, append, appendRange: range(tab, `A${values.length + 1}:${tab.last}`)};
}

/** Coalesces schedule mutations into a single, exclusively leased Sheets projection. */
export function createScheduleSheetSynchronizer({db, getSnapshot, serviceAccountPath, spreadsheetId, enabled = false, fetchImpl = fetch, now = () => new Date()} = {}) {
  let running = false;
  const clock = () => new Date(typeof now === 'function' ? now() : now);
  const client = createGoogleSheetsClient({serviceAccountPath, spreadsheetId, fetchImpl, now});
  async function claim() {
    const at = clock();
    return db.transaction(async tx => {
      const found = await tx.query("SELECT * FROM eduson_booking.sheet_projections WHERE key='schedule' FOR UPDATE");
      const row = found.rows[0];
      if (!row || (row.lease_token && row.lease_until && new Date(row.lease_until) > at) || row.status === 'done') return null;
      if (row.attempts >= MAX_ATTEMPTS) {
        if (row.status === 'processing') await tx.query("UPDATE eduson_booking.sheet_projections SET status='error',last_error='SYNC_ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE key='schedule'", [at]);
        return null;
      }
      if (row.status === 'error' && at.valueOf() - new Date(row.updated_at).valueOf() < Math.min(3_600_000, 5_000 * 2 ** Math.max(0, row.attempts - 1))) return null;
      const token = randomUUID();
      const claimed = await tx.query("UPDATE eduson_booking.sheet_projections SET status='processing',attempts=attempts+1,last_error=NULL,lease_token=$1,lease_until=$2,updated_at=$3 WHERE key='schedule' RETURNING *", [token, new Date(at.valueOf() + LEASE_MS), at]);
      return claimed.rows[0];
    });
  }
  async function renewLease(job) {
    const at = clock();
    const result = await db.query("UPDATE eduson_booking.sheet_projections SET lease_until=$3 WHERE key='schedule' AND lease_token=$1 AND lease_until>$2 RETURNING key", [job.lease_token, at, new Date(at.valueOf() + LEASE_MS)]);
    if (!result.rows.length) fail('SYNC_LEASE_LOST');
  }
  async function runOnce() {
    if (!enabled) return {processed: false, reason: 'disabled'};
    if (running) return {processed: false, reason: 'busy'};
    if (!serviceAccountPath || !spreadsheetId) return {processed: false, error: 'SYNC_CONFIGURATION'};
    running = true;
    try {
      const job = await claim();
      if (!job) return {processed: false};
      try {
        let rawSnapshot;
        try {rawSnapshot = await getSnapshot();}
        catch (error) {
          if (error.code === 'PROJECTION_UNRESOLVED') fail('SHEET_SNAPSHOT_UNRESOLVED');
          throw error;
        }
        const snapshot = validateSnapshot(rawSnapshot);
        const previous = job.previous_payload || {};
        const reads = await Promise.all(TABS.map(tab => client.request(range(tab, `A:${tab.last}`), {unformatted: true})));
        // Validate both sheets and compute the complete ownership-limited plan before writing either.
        const plans = TABS.map((tab, index) => planTab(tab, reads[index].values || [], snapshot, previous));
        const updates = plans.flatMap(plan => plan.writes);
        if (updates.length || plans.some(plan => plan.append.length)) {
          // Persist uncertain ownership before the first external write. A lost response
          // followed by another rename must not orphan the partially written name.
          const attempted = [...new Map([...(previous.attemptedManagedSchedules || []), ...snapshot.managedSchedules].map(row => [pairKey(row), row])).values()];
          const recorded = await db.query("UPDATE eduson_booking.sheet_projections SET previous_payload=jsonb_set(COALESCE(previous_payload,'{}'::jsonb),'{attemptedManagedSchedules}',$2::jsonb) WHERE key='schedule' AND lease_token=$1 RETURNING key", [job.lease_token, JSON.stringify(attempted)]);
          if (!recorded.rows.length) fail('SYNC_LEASE_LOST');
        }
        if (updates.length) { await renewLease(job); await client.batchUpdate(updates); }
        for (const plan of plans) if (plan.append.length) {
          await renewLease(job);
          await client.request(plan.appendRange, {method: 'POST', values: plan.append, append: true, insertDataOption: 'OVERWRITE'});
        }
        const payload = {managedSchedules: snapshot.managedSchedules, ownedBookingIds: snapshot.ownedBookingIds};
        const finished = await db.query("UPDATE eduson_booking.sheet_projections SET status=CASE WHEN version=$2 THEN 'done' ELSE 'pending' END,last_error=NULL,lease_token=NULL,lease_until=NULL,previous_payload=$3::jsonb,updated_at=$4 WHERE key='schedule' AND lease_token=$1 RETURNING status", [job.lease_token, job.version, JSON.stringify(payload), clock()]);
        if (!finished.rows.length) fail('SYNC_LEASE_LOST');
        return {processed: true, status: finished.rows[0].status};
      } catch (error) {
        const code = safeSheetSyncError(error);
        await db.query("UPDATE eduson_booking.sheet_projections SET status=CASE WHEN version=$2 THEN 'error' ELSE 'pending' END,last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=$4 WHERE key='schedule' AND lease_token=$1", [job.lease_token, job.version, code, clock()]);
        return {processed: true, status: 'error', error: code};
      }
    } finally {running = false;}
  }
  async function status() {
    const row = (await db.query("SELECT status,last_error FROM eduson_booking.sheet_projections WHERE key='schedule'")).rows[0];
    return {enabled: Boolean(enabled), pending: row && ['pending','processing'].includes(row.status) ? 1 : 0, error: row?.status === 'error' ? 1 : 0, lastError: row?.last_error ? safeSheetSyncError({code: row.last_error}) : null};
  }
  return {runOnce, status};
}
