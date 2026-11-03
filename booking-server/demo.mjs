import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.mjs';
import { createApp } from './server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = await openDatabase({ dataDir: resolve(root, '.booking-demo') });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
const demoDate = date.toISOString().slice(0, 10);
const app = await createApp({ db, demo: true, demoDate, enableWorkers: false });
const system = { id: 'system', role: 'admin', name: 'Система' };
const password = 'EdusonDemo2026!';
const definitions = [
  ['admin@demo.local', 'Администратор', 'admin'],
  ['kc@demo.local', 'Менеджер КЦ', 'call_center'],
  ['confirm@demo.local', 'Менеджер подтверждения', 'confirmation'],
  ['sale@demo.local', 'Анна · тестовый сейл', 'sales'],
  ['sale2@demo.local', 'Дмитрий · тестовый сейл', 'sales'],
  ['sale3@demo.local', 'Мария · тестовый сейл', 'sales'],
];
const users = {};
for (const [email, name, role] of definitions) {
  const old = (await app.auth.users(system)).find(x => x.email === email);
  users[email] = old || await app.auth.createUser(system, { email, name, role, password });
}
const kc = users['kc@demo.local']; const confirmation = users['confirm@demo.local'];
for (const user of Object.values(users).filter(x => x.role === 'sales')) {
  await app.service.saveSchedule(system, { managerId: user.id, date: demoDate, intervals: [{ start: '10:00', end: '22:00' }], ageGroups: ['5-7', '8-9', '10-12', '13-14'], reserveCapacity: 1 });
}
async function lesson(number, time, confirmed = false) {
  let booking = await app.service.createBooking(kc, { date: demoDate, time, studentName: `Тестовый ученик ${number}`, parentName: `Тестовый родитель ${number}`, phone: '+799900000' + String(number).padStart(2, '0'), crmUrl: `https://eduson.amocrm.ru/leads/detail/${990000 + number}`, age: number % 2 ? 8 : 10, hasPc: true, parentPresent: true, comment: 'Синтетическая запись для проверки интерфейса', idempotencyKey: `demo-${demoDate}-${number}` });
  if (confirmed && booking.confirmationStatus === 'pending' && booking.state !== 'cancelled') booking = await app.service.confirmBooking(confirmation, booking.id, { version: booking.version });
  return booking;
}
for (let i = 1; i <= 4; i++) await lesson(i, '14:00', true);
await lesson(5, '15:00'); await lesson(6, '15:00');
let completed = await lesson(7, '12:00', true);
const teacher = Object.values(users).find(x => x.id === completed.assignedTo);
if (completed.state === 'scheduled') completed = await app.service.startBooking(teacher, completed.id, { version: completed.version });
if (completed.state === 'in_progress') completed = await app.service.completeBooking(teacher, completed.id, { version: completed.version });
if (!completed.report) await app.service.saveReport(teacher, completed.id, { version: completed.version, practice: 'Python', package: '12 занятий', paymentMethod: 'Без оплаты', agreement: 'Родитель обсудит программу дома', objection: 'Нужно согласовать расписание', channel: 'Сайт', amountNet: 0, recordingUrl: 'https://example.com/demo-recording' });
let cancelled = await lesson(8, '16:00');
if (cancelled.state !== 'cancelled') await app.service.cancelBooking(confirmation, cancelled.id, { version: cancelled.version, reason: 'Демонстрация отменённого урока' });
const port = await app.listen(Number(process.env.PORT || 4180));
console.log(`DEMO: http://127.0.0.1:${port} | date ${demoDate}`);
console.log('Synthetic accounts: admin@demo.local, kc@demo.local, confirm@demo.local, sale@demo.local');
console.log(`Demo password only: ${password}`);
async function stop() { await app.close(); await db.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
