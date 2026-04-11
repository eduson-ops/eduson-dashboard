require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const axios = require('axios');
// Groq — free LLM API (llama-3)

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN    = process.env.BOT_TOKEN;
const CHAT_ID      = process.env.CHAT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}
console.log(`🔑 BOT_TOKEN: ${BOT_TOKEN.slice(0, 10)}... (длина: ${BOT_TOKEN.length})`);
console.log(`💬 CHAT_ID: ${process.env.CHAT_ID || 'не задан'}`);

const SHEET_ID = '1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18';
const GVZ = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=`;

const URLS = {
  form:     GVZ + '1621541455',   // Отчёт о МК — 0=ts,1=mgr,2=date,3=time,4=crm,5=rec,6=practice,7=age,8=pack,9=notes,10=agreement,11=objection
  payments: GVZ + '1367593612',   // Оплаты      — 0=ts,1=mgr,2=crm,3=paydate,4=practice,5=pack,6=paytype,7=revenue
  cancels:  GVZ + '901678043',    // Отмены      — 0=ts,1=crm,2=reason,3=is_first,4=contact,5=age,6=comment,7=manager
  managers: GVZ + '1534781490',
  targets:  GVZ + '325926893',
  slots:    GVZ + '1587702885',   // Слоты       — Date,Time,Manager,Status
};

const FALLBACK_MGRS = ['Перебейносов А.', 'Куюмджу Д.', 'Николаев Г.', 'Папашвили Д.', 'Федяинов Е.', 'Масимова Р.'];

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════
function parseCSV(txt) {
  const rows = [];
  const lines = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = '', inQ = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') {
        if (inQ && line[j + 1] === '"') { cur += '"'; j++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

function normDate(s) {
  if (!s) return '';
  s = s.trim().replace(/^"|"$/g, '');
  // dd.MM.yyyy (с возможным временем после пробела)
  if (/^\d{2}\.\d{2}\.\d{4}/.test(s)) return s.split(' ')[0].split('T')[0];
  // ISO: yyyy-MM-dd
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const p = s.split('T')[0].split('-');
    return `${p[2]}.${p[1]}.${p[0]}`;
  }
  // US: M/D/YYYY или M/D/YYYY H:MM:SS (Google Forms)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const p = s.split(' ')[0].split('/'); // отрезаем время
    return `${p[1].padStart(2, '0')}.${p[0].padStart(2, '0')}.${p[2]}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return fmtDate(d);
  return s;
}

function fmtDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function yesterday() {
  return fmtDate(new Date(Date.now() - 86400000));
}

function today() {
  return fmtDate(new Date());
}

function weekDates() {
  const set = new Set();
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    set.add(fmtDate(d));
  }
  return set;
}

function fmtNum(n) {
  return Math.round(n).toLocaleString('ru');
}

function cc(s) {
  return (s || '').replace(/^"|"$/g, '').trim();
}

async function fetchSheet(key) {
  const url = `${URLS[key]}&t=${Date.now()}`; // cache-bust
  const res = await axios.get(url, {
    timeout: 12000,
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  });
  const rows = parseCSV(res.data);
  return rows.slice(1); // без заголовка
}

async function getManagers() {
  try {
    const rows = await fetchSheet('managers');
    const mgrs = rows.map(r => cc(r[0])).filter(Boolean);
    return mgrs.length ? mgrs : FALLBACK_MGRS;
  } catch {
    return FALLBACK_MGRS;
  }
}

// ═══════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════
const mainKeyboard = Markup.keyboard([
  ['📊 Вчера', '📅 Сегодня'],
  ['📈 Неделя', '🎯 План'],
  ['🗓 Сегодня', '🗓 Завтра'],
  ['❌ Отмены', '⚠️ Алерт'],
  ['💬 Спросить'],
]).resize();

// ═══════════════════════════════════════
// REPORT BUILDERS
// ═══════════════════════════════════════

async function buildDailySummary(dateStr) {
  const [mkRows, payRows, managers] = await Promise.all([
    fetchSheet('form'),
    fetchSheet('payments'),
    getManagers(),
  ]);

  const mkDay  = mkRows.filter(r => normDate(cc(r[2])) === dateStr);
  const payDay = payRows.filter(r => normDate(cc(r[3])) === dateStr);

  if (mkDay.length === 0 && payDay.length === 0) {
    return `📊 *Сводка за ${dateStr}*\n\n_Данных нет — выходной или никто не вносил._`;
  }

  // Stats per manager
  const stats = {};
  for (const mgr of managers) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };

  for (const r of mkDay) {
    const mgr = cc(r[1]);
    if (!stats[mgr]) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };
    stats[mgr].mk++;
    if (cc(r[10]).toLowerCase().includes('да')) stats[mgr].agreed++;
  }

  for (const r of payDay) {
    const mgr = cc(r[1]);
    if (!stats[mgr]) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };
    stats[mgr].pays++;
    stats[mgr].rev += parseFloat(cc(r[7]).replace(/[^\d.]/g, '') || 0);
  }

  const totalMK  = mkDay.length;
  const totalRev = payDay.reduce((s, r) => s + parseFloat(cc(r[7]).replace(/[^\d.]/g, '') || 0), 0);
  const totalPay = payDay.length;

  let msg = `📊 *Сводка за ${dateStr}*\n\n`;
  msg += `МК: *${totalMK}* · Оплат: *${totalPay}* · Выручка: *${fmtNum(totalRev)} ₽*\n`;
  msg += `━━━━━━━━━━━━━━━\n`;

  const active = Object.entries(stats).filter(([, s]) => s.mk > 0 || s.rev > 0);
  if (!active.length) {
    msg += '_Активных менеджеров не найдено_';
    return msg;
  }

  for (const [mgr, s] of active) {
    const name = mgr.split(' ')[0];
    msg += `\n👤 *${name}*`;
    msg += `\n  МК: ${s.mk}`;
    if (s.agreed > 0) msg += ` · согл: ${s.agreed}`;
    if (s.pays > 0)   msg += `\n  Оплат: ${s.pays} · ${fmtNum(s.rev)} ₽`;
    msg += '\n';
  }

  // AI insight
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft    = daysInMonth - now.getDate();
  const insight = await getAIInsight('daily', {
    date: dateStr,
    totalMK, totalPay, totalRev: Math.round(totalRev),
    revLeft: Math.round(Math.max(0, 1885140 - totalRev)), // fallback target
    daysLeft,
    managers: active.map(([mgr, s]) => ({ name: mgr.split(' ')[0], mk: s.mk, pays: s.pays, rev: Math.round(s.rev) })),
  });
  if (insight) msg += `\n🤖 _${insight}_`;

  return msg;
}

async function buildWeeklySummary() {
  const [mkRows, payRows, managers] = await Promise.all([
    fetchSheet('form'),
    fetchSheet('payments'),
    getManagers(),
  ]);

  const dates = weekDates();
  const mkWeek  = mkRows.filter(r => dates.has(normDate(cc(r[2]))));
  const payWeek = payRows.filter(r => dates.has(normDate(cc(r[3]))));

  const stats = {};
  for (const mgr of managers) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };

  for (const r of mkWeek) {
    const mgr = cc(r[1]);
    if (!stats[mgr]) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };
    stats[mgr].mk++;
    if (cc(r[10]).toLowerCase().includes('да')) stats[mgr].agreed++;
  }

  for (const r of payWeek) {
    const mgr = cc(r[1]);
    if (!stats[mgr]) stats[mgr] = { mk: 0, agreed: 0, pays: 0, rev: 0 };
    stats[mgr].pays++;
    stats[mgr].rev += parseFloat(cc(r[7]).replace(/[^\d.]/g, '') || 0);
  }

  const totalRev = Object.values(stats).reduce((s, v) => s + v.rev, 0);
  const totalMK  = mkWeek.length;
  const totalPay = payWeek.length;

  const sortedDates = [...dates].sort();
  const from = sortedDates[0];
  const to   = sortedDates[sortedDates.length - 1];

  let msg = `📈 *Итог недели* (${from} — ${to})\n\n`;
  msg += `МК: *${totalMK}* · Оплат: *${totalPay}* · Выручка: *${fmtNum(totalRev)} ₽*\n`;
  msg += `━━━━━━━━━━━━━━━\n`;

  const sorted = Object.entries(stats)
    .filter(([, s]) => s.mk > 0 || s.rev > 0)
    .sort((a, b) => b[1].rev - a[1].rev);

  for (const [mgr, s] of sorted) {
    const name = mgr.split(' ')[0];
    const conv = s.mk > 0 ? Math.round(s.pays / s.mk * 100) : 0;
    msg += `\n👤 *${name}*`;
    msg += `\n  МК: ${s.mk} · Оплат: ${s.pays} · ${fmtNum(s.rev)} ₽`;
    if (conv > 0) msg += ` · конв ${conv}%`;
    msg += '\n';
  }

  // AI insight
  const insight = await getAIInsight('weekly', {
    totalMK: mkWeek.length, totalPay: payWeek.length,
    totalRev: Math.round(Object.values(stats).reduce((s, v) => s + v.rev, 0)),
    managers: sorted.map(([mgr, s]) => ({
      name: mgr.split(' ')[0], mk: s.mk, pays: s.pays,
      rev: Math.round(s.rev), conv: s.mk > 0 ? Math.round(s.pays / s.mk * 100) : 0,
    })),
  });
  if (insight) msg += `\n🤖 _${insight}_`;

  return msg;
}

async function buildCancels(dateStr) {
  const [slotRows, mkRows, cancelRows] = await Promise.all([
    fetchSheet('slots'),
    fetchSheet('form'),
    fetchSheet('cancels'),
  ]);
  // cancels: 0=ts, 1=crm, 2=reason, 3=is_first, 4=contact, 5=age, 6=comment, 7=manager

  // Записей сегодня (слоты)
  let totalSlots = 0;
  for (const r of slotRows) {
    const col0 = cc(r[0]);
    const isDate = col0 && !col0.match(/^\d{1,2}:\d{2}$/) && col0.length > 5;
    const slotDate = isDate ? normDate(col0) : dateStr;
    if (slotDate === dateStr) totalSlots++;
  }

  // Успешных уроков (МК за сегодня)
  const successful = mkRows.filter(r => normDate(cc(r[2])) === dateStr).length;

  // Отмены за сегодня (по дате timestamp)
  const todayCancels = cancelRows.filter(r => normDate(cc(r[0])) === dateStr);

  let msg = `📋 *Итог за ${dateStr}*\n\n`;
  msg += `📅 Записей: *${totalSlots}*\n`;
  msg += `✅ Успешных: *${successful}*\n`;
  msg += `❌ Отмен: *${todayCancels.length}*\n`;

  if (todayCancels.length > 0) {
    msg += `\n`;
    for (const r of todayCancels) {
      const crm  = cc(r[1]) || '—';
      const mgr  = cc(r[7]) || '—';
      const name = mgr.split(' ')[0];
      msg += `• AMO: ${crm} — ${name}\n`;
    }
  }

  return msg;
}

async function buildPlanProgress() {
  const now = new Date();
  const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const currentMonth = monthNames[now.getMonth()];
  const currentYear = now.getFullYear();

  const [mkRows, payRows, tarRows] = await Promise.all([
    fetchSheet('form'),
    fetchSheet('payments'),
    fetchSheet('targets'),
  ]);

  // Таргеты текущего месяца
  let targets = { mk: 52, rev: 1885140, avg: 36000 };
  for (const r of tarRows) {
    const rm = cc(r[0]);
    if (rm.includes(currentMonth) && rm.includes(String(currentYear))) {
      targets = {
        mk:  parseInt(cc(r[1])) || 52,
        rev: parseInt(cc(r[2]).replace(/[^\d]/g, '')) || 1885140,
        avg: parseInt(cc(r[3]).replace(/[^\d]/g, '')) || 36000,
      };
      break;
    }
  }

  // Фильтр по текущему месяцу (даты в формате dd.MM.yyyy)
  const monthSuffix = `${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
  const mkMonth  = mkRows.filter(r => normDate(cc(r[2])).endsWith(monthSuffix));
  const payMonth = payRows.filter(r => normDate(cc(r[3])).endsWith(monthSuffix));

  const totalMK  = mkMonth.length;
  const totalPay = payMonth.length;
  const totalRev = payMonth.reduce((s, r) => s + parseFloat(cc(r[7]).replace(/[^\d.]/g, '') || 0), 0);

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysPassed  = now.getDate();
  const daysLeft    = daysInMonth - daysPassed;
  const timePct     = Math.round(daysPassed / daysInMonth * 100);
  const revPct      = Math.min(999, Math.round(totalRev / targets.rev * 100));
  const mkPct       = Math.min(999, Math.round(totalMK / targets.mk * 100));

  const revLeft = Math.max(0, targets.rev - totalRev);
  const mkLeft  = Math.max(0, targets.mk - totalMK);
  const conv    = totalMK > 0 ? Math.round(totalPay / totalMK * 100) : 0;

  function bar(pct) {
    const filled = Math.min(10, Math.round(pct / 10));
    return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
  }

  let msg = `🎯 *План на ${currentMonth} ${currentYear}*\n`;
  msg += `День ${daysPassed} из ${daysInMonth} (${timePct}% месяца)\n\n`;

  msg += `💰 *Выручка*\n`;
  msg += `${bar(revPct)}\n`;
  msg += `${fmtNum(totalRev)} из ${fmtNum(targets.rev)} ₽\n`;
  if (daysLeft > 0 && revLeft > 0) msg += `_нужно ~${fmtNum(revLeft / daysLeft)} ₽/день_\n`;
  else if (revLeft <= 0) msg += `_✅ план выполнен!_\n`;
  msg += '\n';

  msg += `📋 *МК*\n`;
  msg += `${bar(mkPct)}\n`;
  msg += `${totalMK} из ${targets.mk}\n`;
  if (daysLeft > 0 && mkLeft > 0) msg += `_нужно ~${(mkLeft / daysLeft).toFixed(1)} МК/день_\n`;
  else if (mkLeft <= 0) msg += `_✅ план выполнен!_\n`;
  msg += '\n';

  msg += `Оплат: *${totalPay}* · Конверсия: *${conv}%*`;

  // AI insight
  const insight = await getAIInsight('plan', {
    daysPassed, daysInMonth, daysLeft, timePct,
    totalMK, targetMK: targets.mk, mkPct,
    totalRev: Math.round(totalRev), targetRev: targets.rev, revPct,
  });
  if (insight) msg += `\n\n🤖 _${insight}_`;

  return msg;
}

async function buildScheduleToday(dateStr) {
  const rows = await fetchSheet('slots');
  // Cols: Date, Time, Manager, Status  (или Time, Manager, Status — старый формат)
  const now = new Date();

  const slots = [];
  for (const r of rows) {
    const col0 = cc(r[0]), col1 = cc(r[1]), col2 = cc(r[2]), col3 = cc(r[3] || '');
    const isDate = col0 && !col0.match(/^\d{1,2}:\d{2}$/) && col0.length > 5;
    const slotDate = isDate ? normDate(col0) : dateStr;
    const time     = isDate ? col1 : col0;
    const who      = isDate ? col2 : col1;
    if (!time || !who) continue;
    if (slotDate !== dateStr) continue;

    // Статус по времени
    const [hh, mm] = time.split(':').map(Number);
    const start = new Date(now); start.setHours(hh, mm, 0, 0);
    const end   = new Date(start.getTime() + 3600000);
    let status;
    if (end < now)             status = 'done';
    else if (start <= now)     status = 'live';
    else                       status = 'wait';

    slots.push({ time, who, status });
  }

  if (!slots.length) return `📅 *Записи на ${dateStr}*\n\n_Слоты не найдены_`;

  slots.sort((a, b) => a.time.localeCompare(b.time));

  const icons = { done: '✅', live: '🔴', wait: '⏳' };
  let msg = `📅 *Записи на ${dateStr}*\n\n`;
  for (const s of slots) {
    const name = s.who.split(' ')[0];
    msg += `${icons[s.status]} \`${s.time}\` — ${name}\n`;
  }
  msg += `\nВсего: *${slots.length}* слотов`;
  return msg;
}

async function buildMissingAlert(dateStr) {
  const [mkRows, slotRows] = await Promise.all([
    fetchSheet('form'),
    fetchSheet('slots'),
  ]);

  // Кто имеет слоты сегодня
  const withSlots = new Set();
  for (const r of slotRows) {
    const col0 = cc(r[0]), col1 = cc(r[1]), col2 = cc(r[2]);
    const isDate = col0 && !col0.match(/^\d{1,2}:\d{2}$/) && col0.length > 5;
    const slotDate = isDate ? normDate(col0) : dateStr;
    const who      = isDate ? col2 : col1;
    if (slotDate === dateStr && who) withSlots.add(who);
  }

  // Кто внёс МК за этот день
  const submitted = new Set(
    mkRows
      .filter(r => normDate(cc(r[2])) === dateStr)
      .map(r => cc(r[1]))
  );

  // Алерт только для тех у кого были слоты сегодня
  const missing = [...withSlots].filter(m => !submitted.has(m));
  return missing;
}

// ═══════════════════════════════════════
// DATA CONTEXT FOR Q&A
// ═══════════════════════════════════════
async function buildDataContext() {
  const [mkRows, payRows, cancelRows, tarRows] = await Promise.all([
    fetchSheet('form'),
    fetchSheet('payments'),
    fetchSheet('cancels'),
    fetchSheet('targets'),
  ]);

  // Таргеты текущего месяца
  const now = new Date();
  const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const curMonth = monthNames[now.getMonth()];
  let targets = { mk: 52, rev: 1885140 };
  for (const r of tarRows) {
    if (cc(r[0]).includes(curMonth)) {
      targets = { mk: parseInt(cc(r[1])) || 52, rev: parseInt(cc(r[2]).replace(/[^\d]/g,'')) || 1885140 };
      break;
    }
  }

  // МК — последние 60 дней
  const mkLines = mkRows
    .filter(r => cc(r[1]) && cc(r[2]))
    .slice(-300)
    .map(r => `МК: дата=${normDate(cc(r[2]))} менеджер=${cc(r[1])} согласие=${cc(r[10])||'нет'}`);

  // Оплаты — последние 60 дней
  const payLines = payRows
    .filter(r => cc(r[1]) && cc(r[3]))
    .slice(-200)
    .map(r => `Оплата: дата=${normDate(cc(r[3]))} менеджер=${cc(r[1])} сумма=${cc(r[7])} пакет=${cc(r[5])||cc(r[4])}`);

  // Отмены — последние 60 дней
  const cancelLines = cancelRows
    .filter(r => cc(r[0]))
    .slice(-100)
    .map(r => `Отмена: дата=${normDate(cc(r[0]))} менеджер=${cc(r[7])||'?'} причина=${cc(r[2])} amо=${cc(r[1])}`);

  return (
    `Данные школы Eduson Kids (все даты в формате ДД.ММ.ГГГГ).\n` +
    `Плановые цели на ${curMonth}: МК=${targets.mk}, выручка=${targets.rev} ₽\n\n` +
    `=== МК (${mkLines.length} записей) ===\n${mkLines.join('\n')}\n\n` +
    `=== Оплаты (${payLines.length} записей) ===\n${payLines.join('\n')}\n\n` +
    `=== Отмены (${cancelLines.length} записей) ===\n${cancelLines.join('\n')}`
  );
}

async function askDashboard(question) {
  if (!GROQ_KEY) return '❌ GROQ_API_KEY не задан — AI недоступен.';
  const context = await buildDataContext();

  const prompt =
    `Ты аналитик отдела продаж детской онлайн-школы Eduson Kids.\n` +
    `Отвечай на русском, конкретно, с цифрами из данных. Без лишней воды.\n` +
    `Если данных для ответа нет — так и скажи.\n\n` +
    `=== ДАННЫЕ ===\n${context}\n\n` +
    `=== ВОПРОС ===\n${question}`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile', // более умная модель для Q&A
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.3,
    },
    {
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

// ═══════════════════════════════════════
// AI INSIGHT
// ═══════════════════════════════════════
async function getAIInsight(type, data) {
  if (!GROQ_KEY) return null;

  let prompt = '';

  if (type === 'daily') {
    const needPerDay = data.daysLeft > 0 ? Math.round(data.revLeft / data.daysLeft) : 0;
    prompt =
      `Ты жёсткий, конкретный РОП детской онлайн-школы Eduson Kids.\n` +
      `Пиши как живой человек — коротко, без воды, с конкретными именами и цифрами.\n` +
      `Формат: 2-3 коротких предложения. Никаких заголовков и списков.\n` +
      `Обязательно: кто молодец (конкретно), кто отстаёт (конкретно), одно действие на сегодня.\n\n` +
      `День: ${data.date}\n` +
      `МК проведено: ${data.totalMK} | Оплат: ${data.totalPay} | Выручка: ${data.totalRev.toLocaleString('ru')} ₽\n` +
      `До плана осталось: ${data.revLeft.toLocaleString('ru')} ₽, нужно ~${needPerDay.toLocaleString('ru')} ₽/день\n` +
      `Менеджеры: ${data.managers.map(m => `${m.name} — ${m.mk} МК, ${m.pays} оплат, ${m.rev.toLocaleString('ru')} ₽`).join(' | ')}\n` +
      `Если данных мало или все нули — скажи что день ещё идёт или выходной.`;
  }

  if (type === 'weekly') {
    const convAvg = data.totalMK > 0 ? Math.round(data.totalPay / data.totalMK * 100) : 0;
    prompt =
      `Ты жёсткий, конкретный РОП детской онлайн-школы Eduson Kids.\n` +
      `Напиши итог недели — 3 предложения, без заголовков, с именами и цифрами.\n` +
      `Структура: 1) кто лучший и почему, 2) кто тянет вниз и что конкретно не так, 3) главный фокус на следующую неделю.\n\n` +
      `Итог недели:\n` +
      `МК: ${data.totalMK} | Оплат: ${data.totalPay} | Выручка: ${data.totalRev.toLocaleString('ru')} ₽ | Конверсия: ${convAvg}%\n` +
      `Менеджеры (сортировка по выручке):\n` +
      data.managers.map(m => `  ${m.name}: ${m.mk} МК, ${m.pays} оплат, ${m.rev.toLocaleString('ru')} ₽, конв ${m.conv}%`).join('\n');
  }

  if (type === 'plan') {
    const dailyRevNeeded = data.daysLeft > 0 ? Math.round((data.targetRev - data.totalRev) / data.daysLeft) : 0;
    const dailyMkNeeded  = data.daysLeft > 0 ? ((data.targetMK - data.totalMK) / data.daysLeft).toFixed(1) : 0;
    const behindSchedule = data.revPct < data.timePct;
    prompt =
      `Ты жёсткий, конкретный РОП детской онлайн-школы Eduson Kids.\n` +
      `Напиши 2 предложения про ход месяца — конкретно, без воды.\n` +
      `Скажи отстаём или опережаем график, и одно чёткое действие.\n\n` +
      `День ${data.daysPassed} из ${data.daysInMonth} (${data.timePct}% месяца прошло)\n` +
      `Выручка: ${data.totalRev.toLocaleString('ru')} ₽ из ${data.targetRev.toLocaleString('ru')} ₽ — выполнено ${data.revPct}% ${behindSchedule ? '⚠️ ОТСТАЁМ' : '✅ ОПЕРЕЖАЕМ'}\n` +
      `МК: ${data.totalMK} из ${data.targetMK} — ${data.mkPct}%\n` +
      `Чтобы закрыть план нужно: ${dailyRevNeeded.toLocaleString('ru')} ₽/день и ${dailyMkNeeded} МК/день до конца месяца.`;
  }

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    console.error('[groq] Ошибка:', e.response?.data || e.message);
    return null;
  }
}

// ═══════════════════════════════════════
// BOT
// ═══════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);

// Middleware: логируем команды
bot.use((ctx, next) => {
  if (ctx.message?.text) console.log(`[${new Date().toLocaleTimeString('ru')}] ${ctx.from?.username || ctx.from?.first_name}: ${ctx.message.text}`);
  return next();
});

// /chatid
bot.command('chatid', ctx => {
  ctx.reply(`Твой Chat ID: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
});

// /start
bot.command('start', ctx => {
  ctx.reply(
    '👋 Привет! Я бот дашборда Eduson Kids.\nНажимай кнопки внизу 👇',
    mainKeyboard
  );
});

// /помощь
bot.command(['help', 'помощь'], ctx => {
  ctx.reply('📋 Используй кнопки внизу или команды:\n/svod /week /cancels /alert /plan', mainKeyboard);
});

async function reply(ctx, msg) {
  ctx.replyWithMarkdown(msg, mainKeyboard);
}

// 📊 Вчера
async function handleSvod(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildDailySummary(yesterday());
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['svod', 'stats'], handleSvod);
bot.hears(/^(📊 Вчера|\/сводка)/i, handleSvod);

// 📅 Сегодня
async function handleToday(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildDailySummary(today());
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['today', 'segodnya'], handleToday);
bot.hears(/^(📅 Сегодня|\/сегодня)/i, handleToday);

// 📈 Неделя
async function handleWeek(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildWeeklySummary();
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['week', 'nedelya'], handleWeek);
bot.hears(/^(📈 Неделя|\/неделя)/i, handleWeek);

// 🎯 План
async function handlePlan(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildPlanProgress();
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['plan'], handlePlan);
bot.hears(/^(🎯 План|\/план)/i, handlePlan);

// ❌ Отмены
async function handleCancels(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildCancels(today());
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['cancels', 'otmeny'], handleCancels);
bot.hears(/^(❌ Отмены|\/отмены)/i, handleCancels);

// 🗓 Расписание сегодня
async function handleSchedule(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildScheduleToday(today());
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['schedule', 'rasp'], handleSchedule);
bot.hears(/^(🗓 Сегодня|\/расписание)/i, handleSchedule);

// 🗓 Расписание завтра
async function handleTomorrow(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const tom = fmtDate(new Date(Date.now() + 86400000));
    const msg = await buildScheduleToday(tom);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    reply(ctx, msg);
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['tomorrow', 'zavtra'], handleTomorrow);
bot.hears(/^(🗓 Завтра|\/завтра)/i, handleTomorrow);

// ⚠️ Алерт
async function handleAlert(ctx) {
  const date = today();
  const wait = await ctx.reply('⏳ Проверяю...');
  try {
    const missing = await buildMissingAlert(date);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    if (!missing.length) {
      ctx.reply('✅ Все менеджеры внесли МК сегодня', mainKeyboard);
    } else {
      reply(ctx, `⚠️ *Не внесли МК за ${date}:*\n${missing.map(m => `• ${m}`).join('\n')}`);
    }
  } catch (e) { ctx.reply('❌ Ошибка: ' + e.message); }
}
bot.command(['alert'], handleAlert);
bot.hears(/^(⚠️ Алерт|\/алерт)/i, handleAlert);

// ═══════════════════════════════════════
// PAYMENT POLLING STATE
// ═══════════════════════════════════════
let lastPaymentCount = null;

async function checkNewPayments() {
  const rows = await fetchSheet('payments');
  const count = rows.length;

  // Первый запуск — запоминаем сколько строк сейчас
  if (lastPaymentCount === null) {
    lastPaymentCount = count;
    console.log(`[payments] Инициализация: ${count} строк`);
    return;
  }

  console.log(`[payments] Строк: ${count}, было: ${lastPaymentCount}`);
  if (count <= lastPaymentCount) return; // ничего нового

  const newRows = rows.slice(lastPaymentCount);
  console.log(`[payments] Новых строк: ${newRows.length}`);

  for (const r of newRows) {
    const mgr     = cc(r[1]) || '—';
    const crm     = cc(r[2]) || '—';
    const pack    = cc(r[5]) || cc(r[4]) || '—';
    const paytype = cc(r[6]) || '—';
    const rev     = parseFloat(cc(r[7]).replace(/[^\d.]/g, '') || 0);

    const msg =
      `💰 *Новая оплата!*\n\n` +
      `👤 ${mgr}\n` +
      `🔗 AMO: ${crm}\n` +
      `💵 Сумма: *${fmtNum(rev)} ₽*\n` +
      `📦 Пакет: ${pack}\n` +
      `💳 Тип: ${paytype}`;

    await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`[payments] Алерт отправлен: ${mgr} ${fmtNum(rev)} ₽`);
  }

  lastPaymentCount = count;
}

// 💬 Кнопка "Спросить" — показывает подсказку
bot.hears('💬 Спросить', ctx => {
  ctx.reply(
    '💬 Просто напиши вопрос — я загружу данные и отвечу.\n\n' +
    'Например:\n' +
    '• Как у нас дела по отменам на первой неделе апреля?\n' +
    '• Кто лучший менеджер за март?\n' +
    '• Сколько МК провёл Папашвили на этой неделе?\n' +
    '• Почему падает конверсия?'
  );
});

// 💬 Свободный вопрос — любой текст не из кнопок
bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  // Пропускаем команды и кнопки клавиатуры
  if (text.startsWith('/')) return;
  const buttons = ['📊 Вчера','📅 Сегодня','📈 Неделя','🎯 План','🗓 Сегодня','🗓 Завтра','❌ Отмены','⚠️ Алерт','💬 Спросить'];
  if (buttons.includes(text)) return;

  const wait = await ctx.reply('🤔 Анализирую данные...');
  try {
    const answer = await askDashboard(text);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    ctx.reply(`💬 ${answer}`, mainKeyboard);
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
});

// ═══════════════════════════════════════
// CRON — автоматические сообщения
// ═══════════════════════════════════════
if (CHAT_ID) {
  // Утренняя сводка за вчера + прогресс плана — 9:00 МСК (пн–пт)
  cron.schedule('0 9 * * 1-5', async () => {
    console.log('[cron] Утренняя сводка...');
    try {
      const [svod, plan, sched] = await Promise.all([
        buildDailySummary(yesterday()),
        buildPlanProgress(),
        buildScheduleToday(today()),
      ]);
      bot.telegram.sendMessage(CHAT_ID, svod,  { parse_mode: 'Markdown' });
      bot.telegram.sendMessage(CHAT_ID, plan,  { parse_mode: 'Markdown' });
      bot.telegram.sendMessage(CHAT_ID, sched, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.telegram.sendMessage(CHAT_ID, '❌ Ошибка автосводки: ' + e.message);
    }
  }, { timezone: 'Europe/Moscow' });

  // Алерт кто не внёс МК — 19:30 МСК (пн–пт)
  cron.schedule('30 19 * * 1-5', async () => {
    console.log('[cron] Проверка алерта...');
    try {
      const missing = await buildMissingAlert(today());
      if (missing.length) {
        const msg = `⚠️ *Не внесли МК за сегодня (${today()}):*\n${missing.map(m => `• ${m}`).join('\n')}`;
        bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error('[cron] Alert error:', e.message);
    }
  }, { timezone: 'Europe/Moscow' });

  // Итог недели — пятница 18:00 МСК
  cron.schedule('0 18 * * 5', async () => {
    console.log('[cron] Итог недели...');
    try {
      const msg = await buildWeeklySummary();
      bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.telegram.sendMessage(CHAT_ID, '❌ Ошибка итога недели: ' + e.message);
    }
  }, { timezone: 'Europe/Moscow' });

  // Polling новых оплат — каждые 10 минут
  checkNewPayments(); // инициализация при старте
  cron.schedule('*/10 * * * *', async () => {
    try { await checkNewPayments(); }
    catch (e) { console.error('[payments] Ошибка polling:', e.message); }
  });

  console.log('⏰ Cron задачи запущены (МСК):');
  console.log('   Сводка:    пн–пт 9:00');
  console.log('   Алерт:     пн–пт 19:30');
  console.log('   Неделя:    пт 18:00');
  console.log('   Оплаты:    каждые 10 мин');
} else {
  console.log('⚠️  CHAT_ID не задан — автосообщения отключены');
}

// ═══════════════════════════════════════
// LAUNCH
// ═══════════════════════════════════════
bot.launch();
console.log('✅ Бот запущен');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
