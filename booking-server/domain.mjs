import { randomUUID } from 'node:crypto';
import { recordConfirmation, recordAttendance } from './compensation.mjs';

const HOURS = Array.from({ length: 12 }, (_, i) => `${String(i + 10).padStart(2, '0')}:00`);
const ROLES = ['admin', 'call_center', 'confirmation', 'sales'];
const SYSTEM = { id: 'system', role: 'admin', name: 'Система' };
// Scope is derived from a trusted append-only source event. The original import
// remains the origin/manager evidence, and malformed JSON can never reach a cast.
const SCOPE_VERSION_SQL = `CASE WHEN jsonb_typeof(scope.payload->'version')='number'
  AND (scope.payload->>'version') ~ '^[1-9][0-9]{0,9}$'
  THEN (scope.payload->>'version')::numeric ELSE NULL END`;
const EFFECTIVE_LEGACY_UNKNOWN_SQL = `COALESCE(
  (SELECT scope.payload->'elapsedUnknown'='true'::jsonb
    FROM eduson_booking.audit_events scope
    WHERE scope.booking_id=b.id AND scope.action='legacy_scope_changed'
      AND scope.actor_id='source:rubitime' AND scope.actor_role='admin'
      AND jsonb_typeof(scope.payload)='object'
      AND jsonb_typeof(scope.payload->'historyOnly')='boolean'
      AND jsonb_typeof(scope.payload->'elapsedUnknown')='boolean'
      AND scope.payload->'historyOnly'=scope.payload->'elapsedUnknown'
      AND scope.payload->'historyOnly'=to_jsonb(b.history_only)
      AND (${SCOPE_VERSION_SQL})<=b.version
      AND EXISTS(SELECT 1 FROM eduson_booking.audit_events origin WHERE origin.booking_id=b.id AND origin.action='legacy_imported')
    ORDER BY (${SCOPE_VERSION_SQL}) DESC,scope.created_at DESC,scope.id DESC LIMIT 1),
  (SELECT origin.payload->'elapsedUnknown'='true'::jsonb FROM eduson_booking.audit_events origin
    WHERE origin.booking_id=b.id AND origin.action='legacy_imported' ORDER BY origin.created_at,origin.id LIMIT 1),false)`;
const BOOKING_SELECT = `SELECT b.*,u.name AS assigned_name,r.payload AS report_payload,
  (SELECT (e.payload-'raw') || jsonb_build_object('actorId',e.actor_id,'actorRole',e.actor_role) FROM eduson_booking.audit_events e WHERE e.booking_id=b.id AND e.action IN ('cancelled','expired','legacy_cancelled') ORDER BY (e.payload->>'version')::int DESC,e.created_at DESC LIMIT 1) AS cancellation_payload
  ,(SELECT e.payload FROM eduson_booking.audit_events e WHERE e.booking_id=b.id AND e.action='legacy_imported' ORDER BY e.created_at,e.id LIMIT 1) AS legacy_payload
  ,${EFFECTIVE_LEGACY_UNKNOWN_SQL} AS legacy_elapsed_unknown
  FROM eduson_booking.bookings b LEFT JOIN eduson_booking.users u ON u.id=b.assigned_to LEFT JOIN eduson_booking.reports r ON r.booking_id=b.id`;
const iso = value => value == null ? null : new Date(value).toISOString();
const dateString = value => typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);

export class DomainError extends Error {
  constructor(status, message, code = undefined) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new DomainError(status, message, code); };
const assert = (condition, status, message, code) => { if (!condition) fail(status, message, code); };
const authorized = (actor, roles = ROLES) => assert(actor?.id && roles.includes(actor.role) && actor.active !== false, 403, 'Недостаточно прав для этого действия.', 'FORBIDDEN');

function text(value, label, { required = false, max = 2000 } = {}) {
  assert(value == null || typeof value === 'string', 400, `${label}: требуется текст.`, 'VALIDATION');
  const result = (value || '').trim();
  assert(!required || result.length > 0, 400, `Заполните поле «${label}».`, 'VALIDATION');
  assert(result.length <= max, 400, `${label}: слишком длинное значение.`, 'VALIDATION');
  return result;
}
function url(value, label) {
  const result = text(value, label, { max: 2048 });
  if (result) {
    let parsed;
    try { parsed = new URL(result); } catch { fail(400, `${label}: укажите корректную ссылку.`, 'VALIDATION'); }
    assert(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 400, `${label}: требуется ссылка http или https.`, 'VALIDATION');
  }
  return result;
}
function validatedPhone(value) {
  const result=text(value,'Телефон',{required:true,max:40});
  const digits=result.replace(/\D/g,'');
  assert(digits.length>=10 && digits.length<=15,400,'Телефон должен содержать от 10 до 15 цифр.','VALIDATION');
  return result;
}
function validatedCrm(value) {
  const result=url(value,'CRM');
  const parsed=result ? new URL(result) : null;
  const suffix='.amocrm.ru',subdomain=parsed?.hostname.slice(0,-suffix.length)||'';
  assert(parsed?.protocol==='https:' && parsed.hostname.endsWith(suffix) && subdomain.length>0 && subdomain.split('.').every(Boolean) && parsed.pathname.length>1 && /^https:\/\/[^\s/]+\.amocrm\.ru\/\S+$/i.test(result),400,'Укажите ссылку HTTPS на запись в AmoCRM.','VALIDATION');
  return result;
}
function validDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 400, 'Дата должна иметь формат ГГГГ-ММ-ДД.', 'VALIDATION');
  const parsed = new Date(`${value}T00:00:00Z`);
  assert(Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value, 400, 'Укажите существующую дату.', 'VALIDATION');
  return value;
}
function dateWindow(from, to) {
  validDate(from); validDate(to);
  const start = +new Date(`${from}T00:00:00Z`), end = +new Date(`${to}T00:00:00Z`);
  assert(end >= start && end - start <= 30 * 86400000, 400, 'Период должен включать от 1 до 31 дня.', 'VALIDATION');
  return Array.from({ length: (end - start) / 86400000 + 1 }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
}
function ageValue(value) {
  assert(Number.isInteger(value) && value >= 1 && value <= 18, 400, 'Возраст должен быть целым числом от 1 до 18.', 'VALIDATION');
  return value;
}
function minute(value, allow24 = false) {
  assert(typeof value === 'string' && /^\d{2}:\d{2}$/.test(value), 400, 'Время должно иметь формат ЧЧ:ММ.', 'VALIDATION');
  const [h, m] = value.split(':').map(Number);
  assert((h < 24 && m < 60) || (allow24 && h === 24 && m === 0), 400, 'Укажите корректное время.', 'VALIDATION');
  return h * 60 + m;
}
function ageRange(group) {
  if (Number.isInteger(group)) return [group, group];
  if (group && typeof group === 'object' && Number.isInteger(group.min) && Number.isInteger(group.max)) return [group.min, group.max];
  if (typeof group === 'string') {
    const match = group.trim().match(/^(\d{1,2})\s*(?:[-–—]\s*(\d{1,2}))?(?:\s*(?:лет|года?|years?))?$/i);
    if (match) return [Number(match[1]), Number(match[2] || match[1])];
  }
  fail(400, 'Возрастные теги задайте числами или диапазонами, например 8–12.', 'VALIDATION');
}
function ageGroups(value) {
  assert(Array.isArray(value) && value.length <= 20, 400, 'Укажите список возрастных диапазонов.', 'VALIDATION');
  for (const group of value) { const [min, max] = ageRange(group); assert(min >= 1 && max <= 18 && min <= max, 400, 'Возрастной диапазон должен находиться в пределах 1–18.', 'VALIDATION'); }
  return value;
}
function eligible(user, age) { return !user.age_groups.length || user.age_groups.some(group => { const [min, max] = ageRange(group); return age >= min && age <= max; }); }
function intervals(value) {
  assert(Array.isArray(value) && value.length <= 24, 400, 'Укажите рабочие интервалы.', 'VALIDATION');
  const sorted = value.map(item => {
    assert(item && typeof item === 'object', 400, 'Некорректный рабочий интервал.', 'VALIDATION');
    const start = minute(item.start), end = minute(item.end, true);
    assert(end > start, 400, 'Конец интервала должен быть позже начала.', 'VALIDATION');
    assert(item.reserveCapacity === undefined || [0,1].includes(item.reserveCapacity),400,'На интервал разрешено не более одного резервного места.','VALIDATION');
    return { start: item.start, end: item.end, from: start, to: end, ...(item.reserveCapacity === undefined ? {} : {reserveCapacity:item.reserveCapacity}) };
  }).sort((a, b) => a.from - b.from);
  const result = [];
  for (const item of sorted) {
    const previous = result.at(-1);
    assert(!previous || item.from >= previous.to, 400, 'Рабочие интервалы не должны пересекаться.', 'VALIDATION');
    if (previous && previous.to === item.from && previous.reserveCapacity === item.reserveCapacity) { previous.end = item.end; previous.to = item.to; }
    else result.push({ ...item });
  }
  return result.map(({ start, end, reserveCapacity }) => ({ start, end, ...(reserveCapacity === undefined ? {} : {reserveCapacity}) }));
}
function available(schedule, time) {
  const start = minute(time);
  return schedule.intervals.some(interval => minute(interval.start) <= start && minute(interval.end, true) >= start + 60);
}
function intervalReserve(schedule,time) {
  const start=minute(time);
  const interval=schedule.intervals.find(item=>minute(item.start)<=start && minute(item.end,true)>=start+60);
  return interval?.reserveCapacity ?? schedule.reserve_capacity;
}
function legacyObject(row) {
  if(!row.legacy_payload)return null;
  const missingFields=[];
  for(const [field,column] of [['studentName','student_name'],['parentName','parent_name'],['phone','phone'],['crmUrl','crm_url']])if(!row[column]?.trim())missingFields.push(field);
  for(const [field,column] of [['hasPc','has_pc'],['parentPresent','parent_present']])if(row[column]===null)missingFields.push(field);
  const resolved=['completed','cancelled'].includes(row.state);
  const elapsedUnknown=!resolved && row.legacy_elapsed_unknown===true;
  return {source:row.legacy_payload.source,managerName:row.legacy_payload.managerName,elapsedUnknown,missingFields,needsReview:!resolved && (missingFields.length>0 || elapsedUnknown)};
}
function bookingObject(row) {
  return {
    id: row.id, date: dateString(row.date), time: row.time, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at),
    studentName: row.student_name, parentName: row.parent_name, phone: row.phone, crmUrl: row.crm_url, age: row.age,
    hasPc: row.has_pc, parentPresent: row.parent_present, comment: row.comment,
    confirmationStatus: row.confirmation_status, confirmationDueAt: iso(row.confirmation_due_at), confirmedAt: iso(row.confirmed_at),
    assignedTo: row.assigned_to, assignedName: row.assigned_name || null, assignmentKind: row.assignment_kind, state: row.state,
    cancelReason: row.cancel_reason, cancelSource: row.cancel_source, createdBy: row.created_by,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at), cancelledAt: iso(row.cancelled_at),
    version: row.version, isTest: row.is_test === true, historyOnly: row.history_only === true, capacityHold:row.capacity_hold === true,
    report: row.report_payload || null, cancellation: row.cancellation_payload || null, legacy:legacyObject(row)
  };
}
function managerObject(row) { return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, ageGroups: row.age_groups }; }
function scheduleObject(row) { return { managerId: row.manager_id, date: dateString(row.date), intervals: row.intervals, reserveCapacity: row.reserve_capacity, version: row.version }; }
function visible(actor, row) { return actor.role !== 'sales' ? actor.role !== 'call_center' || row.created_by === actor.id : row.assigned_to === actor.id; }
function canChange(actor, row) { authorized(actor); assert(visible(actor, row), 403, 'У вас нет доступа к этому занятию.', 'FORBIDDEN'); }
function versionCheck(row, input) { assert(Number.isInteger(input?.version) && input.version === row.version, 409, 'Занятие уже изменилось. Обновите страницу.', 'VERSION_CONFLICT'); }
function operationalBooking(row) { assert(!row.history_only, 409, 'Исход архивного занятия подтверждает администратор через проверку данных.', 'ARCHIVE_RESOLUTION_REQUIRED'); }

/** Persistent business operations. Every capacity-changing transaction uses one database lock. */
export class BookingService {
  constructor(db, { now = () => new Date(), random = Math.random } = {}) { this.db = db; this.now = now; this.random = random; }
  instant() { const value = new Date(this.now()); assert(Number.isFinite(+value), 500, 'Некорректное время сервера.'); return value; }
  async mutation(fn) {
    return this.db.transaction(async tx => {
      // A table lock also covers pending pool entries that do not yet have an assignee.
      // It prevents write skew across separate PostgreSQL clients and processes.
      await tx.query('LOCK TABLE eduson_booking.bookings, eduson_booking.schedules, eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
      return fn(tx);
    });
  }
  async get(tx, id) {
    assert(typeof id === 'string' && id.length <= 128, 400, 'Некорректный идентификатор занятия.', 'VALIDATION');
    const row = (await tx.query(`${BOOKING_SELECT} WHERE b.id=$1`, [id])).rows[0];
    assert(row, 404, 'Занятие не найдено.', 'NOT_FOUND');
    return row;
  }
  async record(tx, actor, row, action, payload = {}, kind = 'booking') {
    const at = this.instant().toISOString();
    const cancellation = ['cancelled','expired'].includes(action) ? { timestamp:at,reason:row.cancel_reason,firstCancellation:!row.cancellation_payload,contactMethod:'',comment:row.comment,manager:actor.name || actor.id,source:row.cancel_source } : {};
    await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), row.id, actor.id, actor.role, action, JSON.stringify({ ...cancellation,...payload,version:row.version }), at]);
    // Each action updates the main booking projection as well as its report or cancellation facts.
    for (const projectionKind of kind === 'booking' ? ['booking'] : [kind,'booking']) {
      await tx.query('INSERT INTO eduson_booking.sync_jobs(id,booking_id,kind,version,status,attempts,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,0,$6,$6) ON CONFLICT(booking_id,kind,version) DO NOTHING', [randomUUID(), row.id, projectionKind, row.version, 'pending', at]);
    }
    await this.markSheetsDirty(tx);
  }
  async markSheetsDirty(tx) {
    await tx.query(`INSERT INTO eduson_booking.sheet_projections(key,version,status,attempts,updated_at) VALUES('schedule',1,'pending',0,$1)
      ON CONFLICT(key) DO UPDATE SET version=eduson_booking.sheet_projections.version+1,status='pending',attempts=0,last_error=NULL,updated_at=EXCLUDED.updated_at`,[this.instant().toISOString()]);
  }
  async change(tx, row, changes) {
    const entries = Object.entries(changes);
    const params = entries.map(([, value]) => value);
    params.push(this.instant().toISOString(), row.id);
    const assignments = [...entries.map(([key], index) => `${key}=$${index + 1}`), `updated_at=$${entries.length + 1}`, 'version=version+1'];
    await tx.query(`UPDATE eduson_booking.bookings SET ${assignments.join(',')} WHERE id=$${entries.length + 2}`, params);
    return this.get(tx, row.id);
  }
  async context(tx, date, time, excludeId = null, { historical = false } = {}) {
    // Historical publications describe capacity then; present staff settings only govern current/future work.
    const users = (await tx.query("SELECT u.*,s.intervals,s.reserve_capacity FROM eduson_booking.users u JOIN eduson_booking.schedules s ON s.manager_id=u.id WHERE s.date=$1 AND ($2::boolean OR (u.role='sales' AND u.active=true)) ORDER BY u.id", [date,historical])).rows.filter(row => available(row, time)).map(row=>({...row,age_groups:historical?[]:row.age_groups,reserve_capacity:intervalReserve(row,time)}));
    const bookings = (await tx.query(`${BOOKING_SELECT} WHERE b.date=$1 AND b.time=$2 AND b.state<>'cancelled' AND b.history_only=false AND b.capacity_hold=false AND ($3::text IS NULL OR b.id<>$3) ORDER BY b.created_at,b.id`, [date, time, excludeId])).rows;
    const slots = users.flatMap(user => [{ key: `${user.id}:primary`, user, kind: 'primary' }, ...(user.reserve_capacity ? [{ key: `${user.id}:reserve`, user, kind: 'reserve' }] : [])]);
    return { users, bookings, slots };
  }
  matchResult(context, extra = [], forced = null) {
    const bookings = [...context.bookings, ...extra];
    const occupied = new Map();
    const pending = [];
    for (const b of bookings) {
      const target = forced?.id === b.id ? forced : b.assigned_to ? { managerId: b.assigned_to, kind: b.assignment_kind } : null;
      if (target) {
        const slot = context.slots.find(s => s.user.id === target.managerId && s.kind === target.kind);
        if (!slot || !eligible(slot.user, b.age) || occupied.has(slot.key)) return null;
        occupied.set(slot.key, b.id);
      } else pending.push(b);
    }
    const fixed = new Set(occupied.keys());
    const byId = new Map(pending.map(b => [b.id, b]));
    const visit = (b, seen, allowReserve) => {
      // Every primary place is considered before reserve; source preferences apply within a kind.
      const orderedSlots = [...context.slots].sort((a, c) => Number(a.kind === 'reserve') - Number(c.kind === 'reserve') || (b.legacy_payload?.managerName ? Number(c.user.name === b.legacy_payload.managerName) - Number(a.user.name === b.legacy_payload.managerName) : 0));
      for (const slot of orderedSlots) {
        if ((!allowReserve && slot.kind === 'reserve') || fixed.has(slot.key) || seen.has(slot.key) || !eligible(slot.user, b.age)) continue;
        seen.add(slot.key);
        const previous = occupied.get(slot.key);
        if (!previous || visit(byId.get(previous), seen, allowReserve)) { occupied.set(slot.key, b.id); return true; }
      }
      return false;
    };
    // An early reserve must not stop an augmenting path from finding another primary place.
    const unmatched = pending.filter(b => !visit(b, new Set(), false));
    return unmatched.every(b => visit(b, new Set(), true)) ? occupied : null;
  }
  match(context,extra=[],forced=null) {
    return this.matchResult(context,extra,forced)!==null;
  }
  primaryDeficit(context, confirmed) {
    const slots = context.slots.filter(slot => slot.kind === 'primary');
    const demanded = new Set(confirmed.map(b => b.id));
    const occupied = new Map(), fixed = new Set(), satisfied = new Set();
    // Lessons already running or held cannot move to another salesperson.
    for (const row of context.bookings) {
      if (!['in_progress', 'completed'].includes(row.state) || row.assignment_kind !== 'primary') continue;
      const slot = slots.find(candidate => candidate.user.id === row.assigned_to && eligible(candidate.user, row.age));
      if (slot && !occupied.has(slot.key)) {
        occupied.set(slot.key, row.id); fixed.add(slot.key);
        if (demanded.has(row.id)) satisfied.add(row.id);
      }
    }
    const pending = confirmed.filter(row => !satisfied.has(row.id));
    const byId = new Map(pending.map(row => [row.id, row]));
    const visit = (row, seen) => {
      for (const slot of slots) {
        if (fixed.has(slot.key) || seen.has(slot.key) || !eligible(slot.user, row.age)) continue;
        seen.add(slot.key);
        const previous = occupied.get(slot.key);
        if (!previous || visit(byId.get(previous), seen)) { occupied.set(slot.key, row.id); return true; }
      }
      return false;
    };
    let matched = satisfied.size;
    for (const row of pending) if (visit(row, new Set())) matched++;
    return confirmed.length - matched;
  }
  async assignment(tx, row, requested = null) {
    const ctx = await this.context(tx, dateString(row.date), row.time, row.id);
    const own = { ...row, assigned_to: null, assignment_kind: null };
    if (requested) {
      assert(this.match(ctx, [own], { id: row.id, ...requested }), 409, 'Менеджер занят, не работает в это время или не подходит по возрасту.', 'ASSIGNMENT_UNAVAILABLE');
      return requested;
    }
    for (const kind of ['primary', 'reserve']) {
      const candidates = ctx.slots.filter(slot => slot.kind === kind && eligible(slot.user, row.age)).map(slot => {
        const ledger = this.matchResult(ctx, [own], { id:row.id, managerId:slot.user.id, kind });
        return { slot, reserves:ledger === null ? Infinity : ctx.slots.filter(candidate => candidate.kind === 'reserve' && ledger.has(candidate.key)).length };
      }).filter(candidate => Number.isFinite(candidate.reserves));
      const minimumReserve = Math.min(...candidates.map(candidate => candidate.reserves));
      const choices = candidates.filter(candidate => candidate.reserves === minimumReserve).map(candidate => candidate.slot);
      if (choices.length) {
        const random = Number(this.random());
        const selected = choices[Math.min(choices.length - 1, Math.max(0, Math.floor((Number.isFinite(random) ? random : 0) * choices.length)))];
        return { managerId: selected.user.id, kind };
      }
    }
    fail(409, 'Нет свободного менеджера для этого занятия.', 'CAPACITY_FULL');
  }
  async createBooking(actor, input = {}) {
    authorized(actor, ['admin', 'call_center']);
    assert(input.isTest === undefined || typeof input.isTest === 'boolean', 400, 'Укажите признак тестового занятия.', 'VALIDATION');
    assert(!input.isTest || actor.role === 'admin', 403, 'Тестовое занятие создаёт администратор.', 'FORBIDDEN');
    assert(input.historyOnly === undefined || input.historyOnly === false, 400, 'Архивные записи создаются только при переносе данных.', 'VALIDATION');
    assert(input.capacityHold === undefined || input.capacityHold === false, 400, 'Ожидание места задаётся только при восстановлении записей из источника.', 'VALIDATION');
    const date = validDate(input.date);
    assert(HOURS.includes(input.time), 400, 'Выберите начало занятия с 10:00 до 21:00, с шагом один час.', 'VALIDATION');
    const startsAt = new Date(`${date}T${input.time}:00+03:00`);
    const values = {
      student: text(input.studentName, 'Имя ученика', { required: true, max: 160 }), parent: text(input.parentName, 'Имя родителя', { required: true, max: 160 }),
      phone: validatedPhone(input.phone), crm: validatedCrm(input.crmUrl), age: ageValue(input.age),
      comment: text(input.comment, 'Комментарий', { max: 5000 }), key: text(input.idempotencyKey, 'Ключ запроса', { required:true, max:128 })
    };
    assert(typeof input.hasPc === 'boolean' && typeof input.parentPresent === 'boolean', 400, 'Укажите наличие компьютера и присутствие родителя.', 'VALIDATION');
    return this.mutation(async tx => {
      if (values.key) {
        const previous = (await tx.query(`${BOOKING_SELECT} WHERE b.created_by=$1 AND b.idempotency_key=$2`, [actor.id, values.key])).rows[0];
        if (previous) return bookingObject(previous);
      }
      const now = this.instant();
      assert(startsAt > now, 400, 'Нельзя записать новое занятие в прошлое.', 'VALIDATION');
      const id = randomUUID();
      const ctx = await this.context(tx, date, input.time);
      assert(this.match(ctx, [{ id, age: values.age }]), 409, 'На это время нет свободных мест для выбранного возраста.', 'CAPACITY_FULL');
      await tx.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,comment,confirmation_due_at,created_by,idempotency_key,created_at,updated_at,is_test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18)`, [id,date,input.time,startsAt.toISOString(),new Date(+startsAt+3600000).toISOString(),values.student,values.parent,values.phone,values.crm,values.age,input.hasPc,input.parentPresent,values.comment,new Date(+startsAt-7200000).toISOString(),actor.id,values.key,now.toISOString(),input.isTest === true]);
      const row = await this.get(tx, id);
      await this.record(tx, actor, row, 'created');
      return bookingObject(await this.get(tx, id));
    });
  }
  async confirmBooking(actor, id, input = {}) {
    authorized(actor, ['admin', 'confirmation']);
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      versionCheck(row, input);
      operationalBooking(row);
      assert(row.state === 'scheduled' && row.confirmation_status === 'pending', 409, 'Можно подтвердить только ожидающее занятие.', 'INVALID_STATE');
      assert(this.instant() <= new Date(row.confirmation_due_at), 409, 'Срок подтверждения истёк: подтвердить занятие нужно за два часа до начала.', 'CONFIRMATION_DEADLINE_PASSED');
      assert(new Date(row.starts_at) > this.instant(), 409, 'Нельзя подтвердить занятие после его начала.', 'INVALID_STATE');
      const assigned = await this.assignment(tx, row);
      row = await this.change(tx, row, { confirmation_status: 'confirmed', confirmed_at: this.instant().toISOString(), assigned_to: assigned.managerId, assignment_kind: assigned.kind, capacity_hold:false });
      await recordConfirmation(tx, { booking:row, actor, at:iso(row.confirmed_at) });
      await this.record(tx, actor, row, 'confirmed', { managerId: assigned.managerId, kind: assigned.kind });
      return bookingObject(row);
    });
  }
  async assignBooking(actor, id, input = {}) {
    authorized(actor, ['admin']);
    assert(typeof input.managerId === 'string' && ['primary', 'reserve'].includes(input.kind), 400, 'Выберите менеджера и основное или резервное место.', 'VALIDATION');
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      versionCheck(row, input);
      operationalBooking(row);
      assert(row.state === 'scheduled' && row.confirmation_status === 'confirmed', 409, 'Назначение доступно только для подтверждённого будущего занятия.', 'INVALID_STATE');
      const assigned = await this.assignment(tx, row, { managerId: input.managerId, kind: input.kind });
      const previous = { managerId: row.assigned_to, kind: row.assignment_kind };
      row = await this.change(tx, row, { assigned_to: assigned.managerId, assignment_kind: assigned.kind });
      await this.record(tx, actor, row, 'assigned', { previous, managerId: assigned.managerId, kind: assigned.kind });
      return bookingObject(row);
    });
  }
  async startBooking(actor, id, input = {}) {
    authorized(actor, ['sales', 'admin']);
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      operationalBooking(row);
      assert(row.state === 'scheduled' && row.confirmation_status === 'confirmed' && row.assignment_kind === 'primary', 409, 'Начать можно только подтверждённое основное занятие.', 'INVALID_STATE');
      row = await this.change(tx, row, { state: 'in_progress', started_at: this.instant().toISOString() });
      await this.record(tx, actor, row, 'started');
      return bookingObject(row);
    });
  }
  async completeBooking(actor, id, input = {}) {
    authorized(actor, ['sales', 'admin']);
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      operationalBooking(row);
      assert(row.state === 'in_progress' && row.assignment_kind === 'primary', 409, 'Завершить можно только начатое основное занятие.', 'INVALID_STATE');
      row = await this.change(tx, row, { state: 'completed', completed_at: this.instant().toISOString() });
      await recordAttendance(tx, { booking:row, at:iso(row.completed_at) });
      await this.record(tx, actor, row, 'completed');
      return bookingObject(row);
    });
  }
  async cancelBooking(actor, id, input = {}) {
    authorized(actor);
    const reason = text(input.reason, 'Причина отмены', { required: true, max: 2000 });
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      operationalBooking(row);
      assert(['scheduled', 'in_progress'].includes(row.state), 409, 'Это занятие нельзя отменить в текущем состоянии.', 'INVALID_STATE');
      if (actor.role === 'sales') assert(reason === 'Ученик не пришёл', 403, 'Для менеджера доступна причина «Ученик не пришёл».', 'FORBIDDEN');
      row = await this.change(tx, row, { state: 'cancelled', cancel_reason: reason, cancel_source: actor.role, cancelled_at: this.instant().toISOString(), capacity_hold:false });
      await this.record(tx, actor, row, 'cancelled', { reason, source: actor.role }, 'cancel');
      return bookingObject(await this.get(tx, id));
    });
  }
  async restoreBooking(actor, id, input = {}) {
    authorized(actor, ['admin', 'confirmation', 'call_center']);
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      operationalBooking(row);
      assert(row.state === 'cancelled', 409, 'Восстановить можно только отменённое занятие.', 'INVALID_STATE');
      assert(new Date(row.ends_at) > this.instant(), 409, 'Нельзя восстановить закончившийся интервал.', 'INVALID_STATE');
      const ctx = await this.context(tx, dateString(row.date), row.time, row.id);
      assert(this.match(ctx, [{ ...row, assigned_to: null, assignment_kind: null }]), 409, 'Нет свободного места для восстановления.', 'CAPACITY_FULL');
      const assignment = row.confirmation_status === 'confirmed' ? await this.assignment(tx, row) : null;
      row = await this.change(tx, row, { state: 'scheduled', assigned_to: assignment?.managerId || null, assignment_kind: assignment?.kind || null, cancel_reason: null, cancel_source: null, cancelled_at: null, started_at: null, capacity_hold:false });
      await this.record(tx, actor, row, 'restored', {}, 'cancel');
      return bookingObject(row);
    });
  }
  async saveReport(actor, id, input = {}) {
    authorized(actor, ['admin', 'sales']);
    const report = {
      practice: text(input.practice, 'Практика', { required: true, max: 300 }), package: text(input.package, 'Пакет', { required: true, max: 300 }),
      paymentMethod: text(input.paymentMethod, 'Способ оплаты', { required: true, max: 200 }), agreement: text(input.agreement, 'Договорённость', { max: 5000 }),
      objection: text(input.objection, 'Возражение', { max: 5000 }), channel: text(input.channel, 'Канал', { required: true, max: 200 }),
      amountNet: input.amountNet, recordingUrl: url(input.recordingUrl, 'Запись занятия')
    };
    assert(typeof report.amountNet === 'number' && Number.isFinite(report.amountNet) && report.amountNet >= 0 && report.amountNet <= 1000000000 && Math.abs(report.amountNet * 100 - Math.round(report.amountNet * 100)) < 0.000001, 400, 'Сумма должна быть неотрицательным числом с точностью до копеек.', 'VALIDATION');
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      assert(row.state === 'completed' && row.assignment_kind === 'primary', 409, 'Отчёт доступен после завершения основного занятия.', 'INVALID_STATE');
      const previous = row.report_payload;
      if (previous && Object.entries(report).every(([key, value]) => previous[key] === value)) return bookingObject(row);
      row = await this.change(tx, row, {});
      const at = this.instant().toISOString();
      const payload = { ...report, bookingId: row.id, timestamp: previous?.timestamp || at, teacher: row.assigned_name, date: dateString(row.date), time: row.time, crmUrl: row.crm_url, age: row.age };
      await tx.query('INSERT INTO eduson_booking.reports(booking_id,payload,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT(booking_id) DO UPDATE SET payload=EXCLUDED.payload,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at', [row.id, JSON.stringify(payload), row.version, at]);
      await this.record(tx, actor, row, 'report_saved', {}, 'report');
      return bookingObject(await this.get(tx, id));
    });
  }
  async updateBookingDetails(actor,id,input={}) {
    authorized(actor);
    const mapping={studentName:'student_name',parentName:'parent_name',phone:'phone',crmUrl:'crm_url',age:'age',hasPc:'has_pc',parentPresent:'parent_present',comment:'comment'};
    assert(input && typeof input==='object' && !Array.isArray(input),400,'Передайте поля занятия.','VALIDATION');
    for(const key of Object.keys(input))assert(key==='version'||Object.hasOwn(mapping,key),400,'Можно менять только контактные данные и сведения об ученике.','VALIDATION');
    const changes={};
    for(const [key,column] of Object.entries(mapping)) {
      if(!Object.hasOwn(input,key))continue;
      if(key==='studentName'||key==='parentName')changes[column]=text(input[key],key==='studentName'?'Имя ученика':'Имя родителя',{required:true,max:160});
      else if(key==='phone')changes[column]=validatedPhone(input[key]);
      else if(key==='crmUrl')changes[column]=validatedCrm(input[key]);
      else if(key==='age')changes[column]=ageValue(input[key]);
      else if(key==='comment')changes[column]=text(input[key],'Комментарий',{max:5000});
      else {assert(typeof input[key]==='boolean',400,'Укажите Да или Нет для компьютера и присутствия родителя.','VALIDATION');changes[column]=input[key];}
    }
    assert(Object.keys(changes).length>0,400,'Не указаны данные для изменения.','VALIDATION');
    return this.mutation(async tx=>{
      let row=await this.get(tx,id);canChange(actor,row);versionCheck(row,input);
      if(Object.entries(changes).every(([key,value])=>row[key]===value))return bookingObject(row);
      row=await this.change(tx,row,changes);
      if(Object.hasOwn(changes,'age') && row.state!=='cancelled')assert(this.match(await this.context(tx,dateString(row.date),row.time)),409,'Возраст не подходит назначенному менеджеру или доступным местам.','CAPACITY_CONFLICT');
      if(row.report_payload) {
        const payload={...row.report_payload,crmUrl:row.crm_url,age:row.age,teacher:row.assigned_name,date:dateString(row.date),time:row.time};
        await tx.query('UPDATE eduson_booking.reports SET payload=$1,version=$2,updated_at=$3 WHERE booking_id=$4',[JSON.stringify(payload),row.version,this.instant().toISOString(),id]);
      }
      await this.record(tx,actor,row,'details_updated',{fields:Object.keys(changes)},row.report_payload?'report':'booking');
      return bookingObject(await this.get(tx,id));
    });
  }
  async resolveLegacy(actor,id,input={}) {
    authorized(actor,['admin']);
    assert(['completed','cancelled'].includes(input.outcome),400,'Выберите подтверждённый исход перенесённого занятия.','VALIDATION');
    const reason=text(input.reason,'Основание решения',{required:true,max:2000});
    if(input.outcome==='completed')assert(typeof input.managerId==='string'&&input.managerId,400,'Укажите менеджера, который провёл занятие.','VALIDATION');
    return this.mutation(async tx=>{
      let row=await this.get(tx,id);versionCheck(row,input);
      assert(row.legacy_elapsed_unknown===true && row.state==='scheduled' && new Date(row.ends_at)<=this.instant(),409,'Решение доступно только для прошедшей перенесённой записи с неизвестным исходом.','INVALID_STATE');
      if(input.outcome==='cancelled') {
        row=await this.change(tx,row,{state:'cancelled',cancel_reason:reason,cancel_source:actor.role,cancelled_at:this.instant().toISOString()});
        await this.record(tx,actor,row,'cancelled',{reason,source:actor.role,resolvedLegacy:true},'cancel');
      } else {
        const manager=(await tx.query("SELECT id FROM eduson_booking.users WHERE id=$1 AND role='sales' AND (active=true OR $2::boolean)",[input.managerId,row.history_only===true])).rows[0];
        assert(manager,400,'Укажите менеджера, который провёл занятие.','VALIDATION');
        if(!row.history_only) {
          const overlap=(await tx.query("SELECT id FROM eduson_booking.bookings WHERE assigned_to=$1 AND assignment_kind='primary' AND state<>'cancelled' AND history_only=false AND starts_at<$2 AND ends_at>$3 AND id<>$4",[input.managerId,row.ends_at,row.starts_at,id])).rows;
          assert(overlap.length===0,409,'У менеджера уже есть основное занятие в этом интервале.','ASSIGNMENT_UNAVAILABLE');
          try {await this.assignment(tx,row,{managerId:input.managerId,kind:'primary'});} catch(error) {if(error.status===409)fail(409,'Откройте этот интервал в расписании или выберите фактического менеджера.','ASSIGNMENT_UNAVAILABLE');throw error;}
        }
        row=await this.change(tx,row,{state:'completed',assigned_to:input.managerId,assignment_kind:'primary',completed_at:this.instant().toISOString()});
        await recordAttendance(tx, { booking:row, at:iso(row.completed_at) });
        await this.record(tx,actor,row,'legacy_resolved_completed',{reason,managerId:input.managerId});
      }
      return bookingObject(await this.get(tx,id));
    });
  }
  async listBookings(actor, filters = {}) {
    authorized(actor);
    const conditions = [], values = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (actor.role === 'sales') add('b.assigned_to=?', actor.id);
    if (actor.role === 'call_center') add('b.created_by=?', actor.id);
    if (filters.id) add('b.id=?', text(filters.id, 'Идентификатор', { max: 128 }));
    if (filters.date) add('b.date=?', validDate(filters.date));
    if (filters.from) add('b.date>=?', validDate(filters.from));
    if (filters.to) add('b.date<=?', validDate(filters.to));
    const scope = filters.scope || 'active';
    assert(['active', 'completed', 'trash', 'all'].includes(scope), 400, 'Неизвестный раздел занятий.', 'VALIDATION');
    if (scope === 'active') conditions.push("b.state IN ('scheduled','in_progress') AND b.history_only=false");
    if (scope === 'completed') conditions.push("(b.state='completed' OR b.history_only=true)");
    if (scope === 'trash') conditions.push("b.state='cancelled'");
    return (await this.db.query(`${BOOKING_SELECT}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY b.date,b.time,b.created_at,b.id`, values)).rows.map(bookingObject);
  }
  async listSlots(actor, { date, from, to, age } = {}) {
    authorized(actor);
    const dates = from !== undefined || to !== undefined ? dateWindow(from, to) : [validDate(date)];
    const selectedAge = age == null || age === '' ? null : ageValue(typeof age === 'string' ? Number(age) : age);
    return this.db.transaction(async tx => {
      const result = [];
      for (const slotDate of dates) for (const time of HOURS) {
        const ctx = await this.context(tx, slotDate, time);
        const candidates = selectedAge === null ? ctx.slots : ctx.slots.filter(s => eligible(s.user, selectedAge));
        const capacity = candidates.length;
        let remaining = 0;
        if (selectedAge === null) remaining = Math.max(0, capacity - ctx.bookings.length);
        else {
          const extra = [];
          while (extra.length < capacity) {
            extra.push({ id: `__available_${extra.length}`, age: selectedAge });
            if (!this.match(ctx, extra)) break;
            remaining++;
          }
        }
        result.push({ date:slotDate,time,capacity,used: capacity-remaining,remaining,primaryCapacity: candidates.filter(s => s.kind === 'primary').length,reserveCapacity: candidates.filter(s => s.kind === 'reserve').length,confirmedCount: ctx.bookings.filter(b => b.confirmation_status === 'confirmed').length });
      }
      return result;
    });
  }
  /** Internal: the caller owns the surrounding transaction and capacity table lock. */
  async validateCapacity(tx) {
    const affected = (await tx.query("SELECT DISTINCT date,time FROM eduson_booking.bookings WHERE state<>'cancelled' AND history_only=false AND capacity_hold=false AND ends_at>$1", [this.instant().toISOString()])).rows;
    for (const booking of affected) assert(this.match(await this.context(tx,dateString(booking.date),booking.time)), 409, 'Изменение нарушает доступные места или назначения будущих занятий.', 'CAPACITY_CONFLICT');
  }
  /** Internal recovery operation: existing normal bookings retain priority over newly imported rows. */
  async holdExcessImportedPending(tx, bookingIds) {
    if(!bookingIds.length)return [];
    const rows=(await tx.query(`${BOOKING_SELECT} WHERE b.id=ANY($1::text[]) AND b.state='scheduled' AND b.confirmation_status='pending' AND b.history_only=false ORDER BY b.created_at,b.id`,[bookingIds])).rows;
    const imported=new Set(rows.map(row=>row.id)),contexts=new Map(),held=[];
    for(const row of rows) {
      const date=dateString(row.date),key=`${date}/${row.time}`;
      if(!contexts.has(key)) {
        const context=await this.context(tx,date,row.time);context.bookings=context.bookings.filter(booking=>!imported.has(booking.id));
        assert(this.match(context),409,'Существующие записи требуют исправления ёмкости.','CAPACITY_CONFLICT');contexts.set(key,context);
      }
      const context=contexts.get(key);
      if(this.match(context,[row]))context.bookings.push(row);
      else {
        const changed=await this.change(tx,row,{capacity_hold:true});
        await this.record(tx,SYSTEM,changed,'capacity_hold_created',{reason:'Недостаточно открытых мест при восстановлении подтверждённого источника'});
        held.push(changed.id);
      }
    }
    return held;
  }
  async reconcileCapacityHolds() {
    return this.mutation(async tx=>{
      const rows=(await tx.query(`${BOOKING_SELECT} WHERE b.capacity_hold=true AND b.state='scheduled' AND b.confirmation_status='pending' AND b.history_only=false AND b.ends_at>$1 ORDER BY b.created_at,b.id`,[this.instant().toISOString()])).rows;
      const bookingIds=[];
      for(const row of rows) {
        const context=await this.context(tx,dateString(row.date),row.time);
        if(!this.match(context,[row]))continue;
        const changed=await this.change(tx,row,{capacity_hold:false});
        await this.record(tx,SYSTEM,changed,'capacity_hold_released',{reason:'Появилось подходящее открытое место'});bookingIds.push(row.id);
      }
      const remaining=(await tx.query("SELECT count(*)::int n FROM eduson_booking.bookings WHERE capacity_hold=true AND state='scheduled' AND confirmation_status='pending' AND history_only=false")).rows[0].n;
      return{promoted:bookingIds.length,remaining,bookingIds};
    });
  }
  async saveSchedule(actor, input = {}) {
    authorized(actor, ['admin', 'sales']);
    const managerId = input.managerId || actor.id;
    assert(actor.role === 'admin' || managerId === actor.id, 403, 'Можно менять только своё расписание.', 'FORBIDDEN');
    const date = validDate(input.date), work = intervals(input.intervals);
    const groups = input.ageGroups === undefined ? undefined : ageGroups(input.ageGroups);
    assert(input.reserveCapacity === undefined || [0,1].includes(input.reserveCapacity), 400, 'На интервал разрешено не более одного резервного места.', 'VALIDATION');
    return this.mutation(async tx => {
      const user = (await tx.query("SELECT * FROM eduson_booking.users WHERE id=$1 AND role='sales' AND active=true", [managerId])).rows[0];
      assert(user, 404, 'Активный менеджер не найден.', 'NOT_FOUND');
      const previous = (await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2', [managerId,date])).rows[0];
      if (input.version !== undefined) assert(input.version === (previous?.version || 0), 409, 'Расписание уже изменилось. Обновите страницу.', 'VERSION_CONFLICT');
      const reserve = input.reserveCapacity ?? previous?.reserve_capacity ?? 1;
      const at = this.instant().toISOString();
      await tx.query('INSERT INTO eduson_booking.schedules(manager_id,date,intervals,reserve_capacity,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(manager_id,date) DO UPDATE SET intervals=EXCLUDED.intervals,reserve_capacity=EXCLUDED.reserve_capacity,updated_at=EXCLUDED.updated_at,version=eduson_booking.schedules.version+1', [managerId,date,JSON.stringify(work),reserve,at]);
      if (groups !== undefined) await tx.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2', [JSON.stringify(groups),managerId]);
      // Validate the whole pending pool after the proposed change; rollback protects assignments too.
      const affected = (await tx.query("SELECT DISTINCT date,time FROM eduson_booking.bookings WHERE state<>'cancelled' AND history_only=false AND capacity_hold=false AND (date=$1 OR ($2::boolean AND date>=$3))", [date,groups !== undefined,at.slice(0,10)])).rows;
      for (const booking of affected) assert(this.match(await this.context(tx,dateString(booking.date),booking.time)), 409, 'Расписание нужно сохранить вместе с назначенными занятиями и доступными местами.', 'CAPACITY_CONFLICT');
      const day = scheduleObject((await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2', [managerId,date])).rows[0]);
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES ($1,NULL,$2,$3,$4,$5,$6)', [randomUUID(),actor.id,actor.role,'schedule_saved',JSON.stringify({ ...day, ageGroups: groups ?? user.age_groups }),at]);
      await this.markSheetsDirty(tx);
      return day;
    });
  }
  async saveScheduleRange(actor, input = {}) {
    authorized(actor, ['admin', 'sales']);
    const managerId = input.managerId || actor.id;
    assert(actor.role === 'admin' || managerId === actor.id, 403, 'Можно менять только своё расписание.', 'FORBIDDEN');
    const window = new Set(dateWindow(input.from, input.to));
    assert(Array.isArray(input.days) && input.days.length <= 31, 400, 'Укажите дни расписания в выбранном периоде.', 'VALIDATION');
    const groups = input.ageGroups === undefined ? undefined : ageGroups(input.ageGroups);
    const seen = new Set();
    const days = input.days.map(day => {
      assert(day && typeof day === 'object' && !Array.isArray(day), 400, 'Укажите день расписания.', 'VALIDATION');
      const date = validDate(day.date);
      assert(window.has(date) && !seen.has(date), 400, 'Даты должны быть уникальными и входить в выбранный период.', 'VALIDATION');
      seen.add(date);
      assert(Number.isInteger(day.version) && day.version >= 0, 400, 'Укажите версию каждого дня расписания.', 'VALIDATION');
      assert(day.reserveCapacity === undefined || [0, 1].includes(day.reserveCapacity), 400, 'На интервал разрешено не более одного резервного места.', 'VALIDATION');
      return { date, version: day.version, intervals: intervals(day.intervals), reserveCapacity: day.reserveCapacity };
    });
    return this.mutation(async tx => {
      const user = (await tx.query("SELECT * FROM eduson_booking.users WHERE id=$1 AND role='sales' AND active=true", [managerId])).rows[0];
      assert(user, 404, 'Активный менеджер не найден.', 'NOT_FOUND');
      const at = this.instant().toISOString();
      const saved = [];
      for (const day of days) {
        const previous = (await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2', [managerId, day.date])).rows[0];
        assert(day.version === (previous?.version || 0), 409, 'Расписание уже изменилось. Обновите страницу.', 'VERSION_CONFLICT');
        await tx.query('INSERT INTO eduson_booking.schedules(manager_id,date,intervals,reserve_capacity,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(manager_id,date) DO UPDATE SET intervals=EXCLUDED.intervals,reserve_capacity=EXCLUDED.reserve_capacity,updated_at=EXCLUDED.updated_at,version=eduson_booking.schedules.version+1', [managerId, day.date, JSON.stringify(day.intervals), day.reserveCapacity ?? previous?.reserve_capacity ?? 1, at]);
        saved.push(scheduleObject((await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2', [managerId, day.date])).rows[0]));
      }
      if (groups !== undefined) await tx.query('UPDATE eduson_booking.users SET age_groups=$1 WHERE id=$2', [JSON.stringify(groups), managerId]);
      await this.validateCapacity(tx);
      const result = { days: saved, ageGroups: groups ?? user.age_groups };
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES ($1,NULL,$2,$3,$4,$5,$6)', [randomUUID(), actor.id, actor.role, 'schedule_range_saved', JSON.stringify({ managerId, from:input.from, to:input.to, ...result }), at]);
      await this.markSheetsDirty(tx);
      return result;
    });
  }
  async getSchedule(actor, filters = {}) {
    authorized(actor);
    const managerId = filters.managerId || (actor.role === 'sales' ? actor.id : null);
    if (actor.role === 'sales') assert(managerId === actor.id, 403, 'Доступно только своё расписание.', 'FORBIDDEN');
    const conditions = [], values = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (managerId) add('s.manager_id=?',managerId);
    if (filters.from) add('s.date>=?',validDate(filters.from));
    if (filters.to) add('s.date<=?',validDate(filters.to));
    if (filters.date) add('s.date=?',validDate(filters.date));
    const days = (await this.db.query(`SELECT s.* FROM eduson_booking.schedules s JOIN eduson_booking.users u ON u.id=s.manager_id WHERE u.active=true${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''} ORDER BY s.date,s.manager_id`,values)).rows.map(scheduleObject);
    const groups = managerId ? (await this.db.query('SELECT age_groups FROM eduson_booking.users WHERE id=$1',[managerId])).rows[0]?.age_groups || [] : [];
    return { days, ageGroups: groups };
  }
  async getSheetSnapshot(actor) {
    authorized(actor,['admin']);
    return this.db.transaction(async tx=>{
      await tx.query('LOCK TABLE eduson_booking.bookings, eduson_booking.schedules, eduson_booking.users IN SHARE MODE');
      const schedules=(await tx.query('SELECT s.*,u.name FROM eduson_booking.schedules s JOIN eduson_booking.users u ON u.id=s.manager_id ORDER BY s.date,u.name,s.manager_id')).rows;
      const ownedBookingIds=(await tx.query('SELECT id FROM eduson_booking.bookings ORDER BY id')).rows.map(row=>row.id);
      const managedSchedules=schedules.map(row=>({date:dateString(row.date),manager:row.name}));
      const ownership=new Map();
      for(const schedule of schedules) {
        const key=JSON.stringify([dateString(schedule.date),schedule.name]);
        if(!ownership.has(key))ownership.set(key,[]);
        ownership.get(key).push(schedule.manager_id);
      }
      const unresolved=[...ownership.entries()].filter(([,ids])=>new Set(ids).size>1).map(([key,managerIds])=>{
        const [date,manager]=JSON.parse(key);return {code:'AMBIGUOUS_MANAGER_NAME',date,manager,managerIds};
      });
      if(unresolved.length)return {managedSchedules,scheduleRows:[],slotRows:[],ownedBookingIds,unresolved};
      const scheduleRows=[],slotRows=[],contexts=new Map();
      const snapshotAt=this.instant();
      const readContext=(date,time)=>this.context(tx,date,time,null,{historical:+new Date(`${date}T${time}:00+03:00`)+3600000<=+snapshotAt});
      for(const schedule of schedules)for(const time of HOURS) {
        if(!available(schedule,time))continue;
        const date=dateString(schedule.date),key=`${date}/${time}`;
        if(!contexts.has(key))contexts.set(key,await readContext(date,time));
        if(contexts.get(key).users.some(user=>user.id===schedule.manager_id))scheduleRows.push({manager:schedule.name,date,time});
      }
      // An orphaned active interval is a projection error, never silently omitted.
      const occupied=(await tx.query("SELECT DISTINCT date,time FROM eduson_booking.bookings WHERE state<>'cancelled' AND history_only=false AND capacity_hold=false ORDER BY date,time")).rows;
      for(const row of occupied) {
        const date=dateString(row.date),key=`${date}/${row.time}`;
        if(!contexts.has(key))contexts.set(key,await readContext(date,row.time));
      }
      for(const [key,context] of [...contexts.entries()].sort(([a],[b])=>a.localeCompare(b))) {
        const ledger=this.matchResult(context);
        assert(ledger!==null,409,'Не удалось сопоставить все занятия с расписанием. Проверьте доступные интервалы и возрастные теги.','PROJECTION_UNRESOLVED');
        const separator=key.indexOf('/'),date=key.slice(0,separator),time=key.slice(separator+1);
        for(const slot of [...context.slots].sort((a,b)=>a.user.name.localeCompare(b.user.name,'ru')||a.user.id.localeCompare(b.user.id)||(a.kind==='primary'?-1:1))) {
          const bookingId=ledger.get(slot.key)||'';
          slotRows.push({date,time,manager:slot.user.name,status:bookingId?'booked':'wait',bookingId});
        }
      }
      return {managedSchedules,scheduleRows,slotRows,ownedBookingIds,unresolved:[]};
    });
  }
  async managers(actor) {
    authorized(actor);
    return (await this.db.query("SELECT id,email,name,role,active,age_groups FROM eduson_booking.users WHERE role='sales' AND active=true ORDER BY name,id")).rows.map(managerObject);
  }
  async expireUnconfirmed() {
    return this.mutation(async tx => {
      const rows = (await tx.query(`${BOOKING_SELECT} WHERE b.confirmation_status='pending' AND b.state='scheduled' AND b.history_only=false AND b.ends_at<=$1 AND NOT (${EFFECTIVE_LEGACY_UNKNOWN_SQL}) ORDER BY b.ends_at,b.id`,[this.instant().toISOString()])).rows;
      for (const original of rows) {
        const row = await this.change(tx,original,{ state:'cancelled',cancel_reason:'Занятие не подтверждено и не состоялось',cancel_source:'system',cancelled_at:this.instant().toISOString(),capacity_hold:false });
        await this.record(tx,SYSTEM,row,'expired',{ reason:row.cancel_reason,source:'system' },'cancel');
      }
      return rows.length;
    });
  }
  async listAudit(actor, { bookingId } = {}) {
    authorized(actor,['admin']);
    const rows = (await this.db.query(`SELECT * FROM eduson_booking.audit_events${bookingId ? ' WHERE booking_id=$1' : ''} ORDER BY created_at,id`,bookingId ? [bookingId] : [])).rows;
    return rows.map(row => ({ id:row.id,bookingId:row.booking_id,actorId:row.actor_id,actorRole:row.actor_role,action:row.action,payload:row.payload,createdAt:iso(row.created_at) }));
  }
  async getAnalyticsLessons(actor, filters = {}) {
    authorized(actor,['admin']);
    const bookings = await this.listBookings(actor,{ ...filters,scope:'completed' });
    return bookings.filter(b => b.report && !b.isTest).map(b => ({ ...b.report,bookingId:b.id,assignedTo:b.assignedTo,state:b.state,completedAt:b.completedAt,version:b.version }));
  }
  async getAnalyticsCancellations(actor, filters = {}) {
    authorized(actor,['admin']);
    return (await this.listBookings(actor,{ ...filters,scope:'trash' })).filter(b => !b.isTest).map(b => ({
      bookingId:b.id,date:b.date,time:b.time,startsAt:b.startsAt,
      // Keep the existing teacher field compatible; cancellation.manager is the archived actor.
      teacher:b.assignedName,assignedTeacher:b.assignedName,assignedTo:b.assignedTo,
      crmUrl:b.crmUrl,age:b.age,reason:b.cancelReason,source:b.cancellation?.source ?? b.cancelSource,
      cancellation:b.cancellation,actorId:b.cancellation?.actorId ?? null,
      actorRole:b.cancellation?.actorRole ?? null,actorName:b.cancellation?.authorUnknown ? null : b.cancellation?.manager ?? null,
      confirmationStatus:b.confirmationStatus,version:b.version,cancelledAt:b.cancelledAt
    }));
  }
  async stats(actor, { date, tag } = {}) {
    authorized(actor,['admin']);
    validDate(date);
    const range = tag ? ageRange(tag) : null;
    const inTag = age => !range || age >= range[0] && age <= range[1];
    return this.db.transaction(async tx => {
      const all = (await tx.query('SELECT * FROM eduson_booking.bookings WHERE date=$1',[date])).rows.filter(b => inTag(b.age));
      const hours = [];
      for (const time of HOURS) {
        const ctx = await this.context(tx,date,time,null,{ historical:+new Date(`${date}T${time}:00+03:00`)+3600000<=+this.instant() });
        const managers = ctx.users.filter(u => !range || Array.from({length:range[1]-range[0]+1},(_,i)=>range[0]+i).some(a=>eligible(u,a))).map(u => ({id:u.id,name:u.name,ageGroups:u.age_groups,reserveCapacity:u.reserve_capacity}));
        const bookings = all.filter(b => b.time === time), active = bookings.filter(b => b.state !== 'cancelled');
        const capacity = managers.reduce((sum,m)=>sum+1+m.reserveCapacity,0);
        const confirmed = active.filter(b=>b.confirmation_status==='confirmed').length;
        const ledger = this.matchResult(ctx);
        const allocations = ledger === null ? [] : ctx.slots.filter(slot => ledger.has(slot.key)).map(slot => ({ bookingId:ledger.get(slot.key), managerId:slot.user.id, managerName:slot.user.name, kind:slot.kind })).filter(allocation => active.some(booking => booking.id === allocation.bookingId));
        const reservedIds = new Set(allocations.filter(allocation => allocation.kind === 'reserve').map(allocation => allocation.bookingId));
        hours.push({ time,managers:managers.length,managerList:managers,allocations,capacity,total:active.length,capacityHeld:active.filter(b=>b.capacity_hold).length,reserve:active.filter(b=>b.assignment_kind==='reserve' || reservedIds.has(b.id)).length,confirmed,
          cancelledConfirmation:bookings.filter(b=>b.state==='cancelled' && ['confirmation','call_center','system'].includes(b.cancel_source)).length,
          cancelledSales:bookings.filter(b=>b.state==='cancelled' && b.cancel_source==='sales').length,
          completed:active.filter(b=>b.state==='completed').length,inProgress:active.filter(b=>b.state==='in_progress').length,
          assigned:active.filter(b=>b.assigned_to).length,unassigned:active.filter(b=>!b.assigned_to).length,deficit:this.primaryDeficit(ctx,active.filter(b=>b.confirmation_status==='confirmed')) });
      }
      const fields = ['capacity','total','capacityHeld','reserve','confirmed','cancelledConfirmation','cancelledSales','completed','inProgress','assigned','unassigned','deficit'];
      return { hours,totals:Object.fromEntries(fields.map(field=>[field,hours.reduce((sum,h)=>sum+h[field],0)])) };
    });
  }
}
