const CRM_RE = /^https:\/\/[^\s/]+\.amocrm\.ru\/\S+$/i;

export function validateBookingInput(input) {
  const value = { ...input };
  const errors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))) errors.date = 'Дата обязательна';
  if (!/^([01]\d|2[0-3]):00$/.test(String(value.time || ''))) errors.time = 'Время должно быть целым часом';
  if (!String(value.sale || '').trim()) errors.sale = 'Сейл обязателен';
  if (!CRM_RE.test(String(value.crmUrl || '').trim())) errors.crmUrl = 'Нужна ссылка AmoCRM';
  const age = Number(value.age);
  if (!Number.isInteger(age) || age < 1 || age > 18) errors.age = 'Возраст: от 1 до 18 лет';
  const phone = String(value.phone || '').replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 15) errors.phone = 'Телефон должен содержать 10–15 цифр';
  if (!String(value.createdBy || '').trim()) errors.createdBy = 'Нужен автор записи';
  if (!String(value.idempotencyKey || '').trim()) errors.idempotencyKey = 'Нужен ключ повторной отправки';
  return Object.keys(errors).length ? { ok: false, errors } : {
    ok: true,
    value: { ...value, date: String(value.date), time: String(value.time), sale: String(value.sale).trim(), crmUrl: String(value.crmUrl).trim(), age, phone },
  };
}

export function getSlotCapacity(rows, booking) {
  return rows.filter(row => row.date === booking.date && row.time === booking.time && row.manager === booking.sale && String(row.status).toLowerCase() === 'wait').length;
}

export function canTransition(from, to) {
  return from === 'pending_confirmation' && ['confirmed', 'rejected'].includes(to);
}

export function createBooking(input, place, now = new Date()) {
  const checked = validateBookingInput(input);
  if (!checked.ok) throw new Error(Object.values(checked.errors).join('; '));
  const value = checked.value;
  return {
    ...value,
    bookingId: `booking-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(), status: 'pending_confirmation', place,
  };
}

export function findExistingByIdempotencyKey(rows, key) {
  return rows.find(row => row.idempotencyKey === key);
}
