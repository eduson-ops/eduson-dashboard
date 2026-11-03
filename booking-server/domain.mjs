import { randomUUID } from 'node:crypto';

const HOURS = Array.from({ length: 12 }, (_, i) => `${String(i + 10).padStart(2, '0')}:00`);
const ROLES = ['admin', 'call_center', 'confirmation', 'sales'];
const SYSTEM = { id: 'system', role: 'admin', name: 'Система' };
const BOOKING_SELECT = `SELECT b.*,u.name AS assigned_name,r.payload AS report_payload,
  (SELECT e.payload || jsonb_build_object('actorId',e.actor_id,'actorRole',e.actor_role) FROM eduson_booking.audit_events e WHERE e.booking_id=b.id AND e.action IN ('cancelled','expired') ORDER BY (e.payload->>'version')::int DESC,e.created_at DESC LIMIT 1) AS cancellation_payload
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
function validDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 400, 'Дата должна иметь формат ГГГГ-ММ-ДД.', 'VALIDATION');
  const parsed = new Date(`${value}T00:00:00Z`);
  assert(Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value, 400, 'Укажите существующую дату.', 'VALIDATION');
  return value;
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
    return { start: item.start, end: item.end, from: start, to: end };
  }).sort((a, b) => a.from - b.from);
  const result = [];
  for (const item of sorted) {
    const previous = result.at(-1);
    assert(!previous || item.from >= previous.to, 400, 'Рабочие интервалы не должны пересекаться.', 'VALIDATION');
    if (previous && previous.to === item.from) { previous.end = item.end; previous.to = item.to; }
    else result.push({ ...item });
  }
  return result.map(({ start, end }) => ({ start, end }));
}
function available(schedule, time) {
  const start = minute(time);
  return schedule.intervals.some(interval => minute(interval.start) <= start && minute(interval.end, true) >= start + 60);
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
    version: row.version, report: row.report_payload || null, cancellation: row.cancellation_payload || null
  };
}
function managerObject(row) { return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, ageGroups: row.age_groups }; }
function scheduleObject(row) { return { managerId: row.manager_id, date: dateString(row.date), intervals: row.intervals, reserveCapacity: row.reserve_capacity, version: row.version }; }
function visible(actor, row) { return actor.role !== 'sales' ? actor.role !== 'call_center' || row.created_by === actor.id : row.assigned_to === actor.id; }
function canChange(actor, row) { authorized(actor); assert(visible(actor, row), 403, 'У вас нет доступа к этому занятию.', 'FORBIDDEN'); }
function versionCheck(row, input) { assert(Number.isInteger(input?.version) && input.version === row.version, 409, 'Занятие уже изменилось. Обновите страницу.', 'VERSION_CONFLICT'); }

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
    // A cancellation transition also changes the main booking projection, including restore assignments.
    for (const projectionKind of kind === 'cancel' ? ['cancel', 'booking'] : [kind]) {
      await tx.query('INSERT INTO eduson_booking.sync_jobs(id,booking_id,kind,version,status,attempts,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,0,$6,$6) ON CONFLICT(booking_id,kind,version) DO NOTHING', [randomUUID(), row.id, projectionKind, row.version, 'pending', at]);
    }
  }
  async change(tx, row, changes) {
    const entries = Object.entries(changes);
    const params = entries.map(([, value]) => value);
    params.push(this.instant().toISOString(), row.id);
    const assignments = [...entries.map(([key], index) => `${key}=$${index + 1}`), `updated_at=$${entries.length + 1}`, 'version=version+1'];
    await tx.query(`UPDATE eduson_booking.bookings SET ${assignments.join(',')} WHERE id=$${entries.length + 2}`, params);
    return this.get(tx, row.id);
  }
  async context(tx, date, time, excludeId = null) {
    const users = (await tx.query("SELECT u.*,s.intervals,s.reserve_capacity FROM eduson_booking.users u JOIN eduson_booking.schedules s ON s.manager_id=u.id WHERE u.role='sales' AND u.active=true AND s.date=$1 ORDER BY u.id", [date])).rows.filter(row => available(row, time));
    const bookings = (await tx.query("SELECT * FROM eduson_booking.bookings WHERE date=$1 AND time=$2 AND state<>'cancelled' AND ($3::text IS NULL OR id<>$3)", [date, time, excludeId])).rows;
    const slots = users.flatMap(user => [{ key: `${user.id}:primary`, user, kind: 'primary' }, ...(user.reserve_capacity ? [{ key: `${user.id}:reserve`, user, kind: 'reserve' }] : [])]);
    return { users, bookings, slots };
  }
  match(context, extra = [], forced = null) {
    const bookings = [...context.bookings, ...extra];
    const occupied = new Map();
    const pending = [];
    for (const b of bookings) {
      const target = forced?.id === b.id ? forced : b.assigned_to ? { managerId: b.assigned_to, kind: b.assignment_kind } : null;
      if (target) {
        const slot = context.slots.find(s => s.user.id === target.managerId && s.kind === target.kind);
        if (!slot || !eligible(slot.user, b.age) || occupied.has(slot.key)) return false;
        occupied.set(slot.key, b.id);
      } else pending.push(b);
    }
    const fixed = new Set(occupied.keys());
    const byId = new Map(pending.map(b => [b.id, b]));
    const visit = (b, seen) => {
      for (const slot of context.slots) {
        if (fixed.has(slot.key) || seen.has(slot.key) || !eligible(slot.user, b.age)) continue;
        seen.add(slot.key);
        const previous = occupied.get(slot.key);
        if (!previous || visit(byId.get(previous), seen)) { occupied.set(slot.key, b.id); return true; }
      }
      return false;
    };
    return pending.every(b => visit(b, new Set()));
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
      const choices = ctx.slots.filter(slot => slot.kind === kind && eligible(slot.user, row.age) && this.match(ctx, [own], { id: row.id, managerId: slot.user.id, kind }));
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
    const date = validDate(input.date);
    assert(HOURS.includes(input.time), 400, 'Выберите начало занятия с 10:00 до 21:00, с шагом один час.', 'VALIDATION');
    const startsAt = new Date(`${date}T${input.time}:00+03:00`);
    const values = {
      student: text(input.studentName, 'Имя ученика', { required: true, max: 160 }), parent: text(input.parentName, 'Имя родителя', { required: true, max: 160 }),
      phone: text(input.phone, 'Телефон', { required: true, max: 40 }), crm: url(input.crmUrl, 'CRM'), age: ageValue(input.age),
      comment: text(input.comment, 'Комментарий', { max: 5000 }), key: text(input.idempotencyKey, 'Ключ запроса', { required:true, max:128 })
    };
    const crm = values.crm ? new URL(values.crm) : null;
    const crmSuffix = '.amocrm.ru';
    const crmSubdomain = crm?.hostname.slice(0, -crmSuffix.length) || '';
    assert(crm?.protocol === 'https:' && crm.hostname.endsWith(crmSuffix) && crmSubdomain.length > 0 && crmSubdomain.split('.').every(Boolean) && crm.pathname.length > 1 && /^https:\/\/[^\s/]+\.amocrm\.ru\/\S+$/i.test(values.crm), 400, 'Укажите ссылку HTTPS на запись в AmoCRM.', 'VALIDATION');
    const phoneDigits = values.phone.replace(/\D/g, '');
    assert(phoneDigits.length >= 10 && phoneDigits.length <= 15, 400, 'Телефон должен содержать от 10 до 15 цифр.', 'VALIDATION');
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
      await tx.query(`INSERT INTO eduson_booking.bookings(id,date,time,starts_at,ends_at,student_name,parent_name,phone,crm_url,age,has_pc,parent_present,comment,confirmation_due_at,created_by,idempotency_key,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`, [id,date,input.time,startsAt.toISOString(),new Date(+startsAt+3600000).toISOString(),values.student,values.parent,values.phone,values.crm,values.age,input.hasPc,input.parentPresent,values.comment,new Date(+startsAt-7200000).toISOString(),actor.id,values.key,now.toISOString()]);
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
      assert(row.state === 'scheduled' && row.confirmation_status === 'pending', 409, 'Можно подтвердить только ожидающее занятие.', 'INVALID_STATE');
      assert(new Date(row.starts_at) > this.instant(), 409, 'Нельзя подтвердить занятие после его начала.', 'INVALID_STATE');
      const assigned = await this.assignment(tx, row);
      row = await this.change(tx, row, { confirmation_status: 'confirmed', confirmed_at: this.instant().toISOString(), assigned_to: assigned.managerId, assignment_kind: assigned.kind });
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
      assert(row.state === 'in_progress' && row.assignment_kind === 'primary', 409, 'Завершить можно только начатое основное занятие.', 'INVALID_STATE');
      row = await this.change(tx, row, { state: 'completed', completed_at: this.instant().toISOString() });
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
      assert(['scheduled', 'in_progress'].includes(row.state), 409, 'Это занятие нельзя отменить в текущем состоянии.', 'INVALID_STATE');
      if (actor.role === 'sales') assert(reason === 'Ученик не пришёл', 403, 'Для менеджера доступна причина «Ученик не пришёл».', 'FORBIDDEN');
      row = await this.change(tx, row, { state: 'cancelled', cancel_reason: reason, cancel_source: actor.role, cancelled_at: this.instant().toISOString() });
      await this.record(tx, actor, row, 'cancelled', { reason, source: actor.role }, 'cancel');
      return bookingObject(await this.get(tx, id));
    });
  }
  async restoreBooking(actor, id, input = {}) {
    authorized(actor, ['admin', 'confirmation', 'call_center']);
    return this.mutation(async tx => {
      let row = await this.get(tx, id);
      canChange(actor, row); versionCheck(row, input);
      assert(row.state === 'cancelled', 409, 'Восстановить можно только отменённое занятие.', 'INVALID_STATE');
      assert(new Date(row.ends_at) > this.instant(), 409, 'Нельзя восстановить закончившийся интервал.', 'INVALID_STATE');
      const ctx = await this.context(tx, dateString(row.date), row.time, row.id);
      assert(this.match(ctx, [{ ...row, assigned_to: null, assignment_kind: null }]), 409, 'Нет свободного места для восстановления.', 'CAPACITY_FULL');
      const assignment = row.confirmation_status === 'confirmed' ? await this.assignment(tx, row) : null;
      row = await this.change(tx, row, { state: 'scheduled', assigned_to: assignment?.managerId || null, assignment_kind: assignment?.kind || null, cancel_reason: null, cancel_source: null, cancelled_at: null, started_at: null });
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
    if (scope === 'active') conditions.push("b.state IN ('scheduled','in_progress')");
    if (scope === 'completed') conditions.push("b.state='completed'");
    if (scope === 'trash') conditions.push("b.state='cancelled'");
    return (await this.db.query(`${BOOKING_SELECT}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY b.date,b.time,b.created_at,b.id`, values)).rows.map(bookingObject);
  }
  async listSlots(actor, { date, age } = {}) {
    authorized(actor);
    validDate(date);
    const selectedAge = age == null || age === '' ? null : ageValue(typeof age === 'string' ? Number(age) : age);
    return this.db.transaction(async tx => {
      const result = [];
      for (const time of HOURS) {
        const ctx = await this.context(tx, date, time);
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
        result.push({ date,time,capacity,used: capacity-remaining,remaining,primaryCapacity: candidates.filter(s => s.kind === 'primary').length,reserveCapacity: candidates.filter(s => s.kind === 'reserve').length,confirmedCount: ctx.bookings.filter(b => b.confirmation_status === 'confirmed').length });
      }
      return result;
    });
  }
  /** Internal: the caller owns the surrounding transaction and capacity table lock. */
  async validateCapacity(tx) {
    const affected = (await tx.query("SELECT DISTINCT date,time FROM eduson_booking.bookings WHERE state<>'cancelled' AND ends_at>$1", [this.instant().toISOString()])).rows;
    for (const booking of affected) assert(this.match(await this.context(tx,dateString(booking.date),booking.time)), 409, 'Изменение нарушает доступные места или назначения будущих занятий.', 'CAPACITY_CONFLICT');
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
      const affected = (await tx.query("SELECT DISTINCT date,time FROM eduson_booking.bookings WHERE state<>'cancelled' AND (date=$1 OR ($2::boolean AND date>=$3))", [date,groups !== undefined,at.slice(0,10)])).rows;
      for (const booking of affected) assert(this.match(await this.context(tx,dateString(booking.date),booking.time)), 409, 'Расписание нужно сохранить вместе с назначенными занятиями и доступными местами.', 'CAPACITY_CONFLICT');
      const day = scheduleObject((await tx.query('SELECT * FROM eduson_booking.schedules WHERE manager_id=$1 AND date=$2', [managerId,date])).rows[0]);
      await tx.query('INSERT INTO eduson_booking.audit_events(id,booking_id,actor_id,actor_role,action,payload,created_at) VALUES ($1,NULL,$2,$3,$4,$5,$6)', [randomUUID(),actor.id,actor.role,'schedule_saved',JSON.stringify({ ...day, ageGroups: groups ?? user.age_groups }),at]);
      return day;
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
  async managers(actor) {
    authorized(actor);
    return (await this.db.query("SELECT id,email,name,role,active,age_groups FROM eduson_booking.users WHERE role='sales' AND active=true ORDER BY name,id")).rows.map(managerObject);
  }
  async expireUnconfirmed() {
    return this.mutation(async tx => {
      const rows = (await tx.query("SELECT * FROM eduson_booking.bookings WHERE confirmation_status='pending' AND state='scheduled' AND ends_at<=$1 ORDER BY ends_at,id",[this.instant().toISOString()])).rows;
      for (const original of rows) {
        const row = await this.change(tx,original,{ state:'cancelled',cancel_reason:'Занятие не подтверждено и не состоялось',cancel_source:'system',cancelled_at:this.instant().toISOString() });
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
    return bookings.filter(b => b.report).map(b => ({ ...b.report,bookingId:b.id,assignedTo:b.assignedTo,state:b.state,completedAt:b.completedAt,version:b.version }));
  }
  async getAnalyticsCancellations(actor, filters = {}) {
    authorized(actor,['admin']);
    return (await this.listBookings(actor,{ ...filters,scope:'trash' })).map(b => ({
      bookingId:b.id,date:b.date,time:b.time,startsAt:b.startsAt,
      // Keep the existing teacher field compatible; cancellation.manager is the archived actor.
      teacher:b.assignedName,assignedTeacher:b.assignedName,assignedTo:b.assignedTo,
      crmUrl:b.crmUrl,age:b.age,reason:b.cancelReason,source:b.cancellation?.source ?? b.cancelSource,
      cancellation:b.cancellation,actorId:b.cancellation?.actorId ?? null,
      actorRole:b.cancellation?.actorRole ?? null,actorName:b.cancellation?.manager ?? null,
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
        const ctx = await this.context(tx,date,time);
        const managers = ctx.users.filter(u => !range || Array.from({length:range[1]-range[0]+1},(_,i)=>range[0]+i).some(a=>eligible(u,a))).map(u => ({id:u.id,name:u.name,ageGroups:u.age_groups,reserveCapacity:u.reserve_capacity}));
        const bookings = all.filter(b => b.time === time), active = bookings.filter(b => b.state !== 'cancelled');
        const capacity = managers.reduce((sum,m)=>sum+1+m.reserveCapacity,0);
        const confirmed = active.filter(b=>b.confirmation_status==='confirmed').length;
        hours.push({ time,managers:managers.length,managerList:managers,capacity,total:active.length,reserve:active.filter(b=>b.assignment_kind==='reserve').length,confirmed,
          cancelledConfirmation:bookings.filter(b=>b.state==='cancelled' && ['confirmation','call_center','system'].includes(b.cancel_source)).length,
          cancelledSales:bookings.filter(b=>b.state==='cancelled' && b.cancel_source==='sales').length,
          completed:active.filter(b=>b.state==='completed').length,inProgress:active.filter(b=>b.state==='in_progress').length,
          assigned:active.filter(b=>b.assigned_to).length,unassigned:active.filter(b=>!b.assigned_to).length,deficit:this.primaryDeficit(ctx,active.filter(b=>b.confirmation_status==='confirmed')) });
      }
      const fields = ['capacity','total','reserve','confirmed','cancelledConfirmation','cancelledSales','completed','inProgress','assigned','unassigned','deficit'];
      return { hours,totals:Object.fromEntries(fields.map(field=>[field,hours.reduce((sum,h)=>sum+h[field],0)])) };
    });
  }
}
