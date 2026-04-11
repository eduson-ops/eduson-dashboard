require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const axios = require('axios');

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

const SHEET_ID = '1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18';
const GVZ = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=`;

const URLS = {
  form:     GVZ + '1621541455',   // Отчёт о МК — 0=ts,1=mgr,2=date,3=time,4=crm,5=rec,6=practice,7=age,8=pack,9=notes,10=agreement,11=objection
  payments: GVZ + '1367593612',   // Оплаты      — 0=ts,1=mgr,2=crm,3=paydate,4=practice,5=pack,6=paytype,7=revenue
  cancels:  GVZ + '901678043',    // Отмены      — 0=ts,1=crm,2=reason,3=is_first,4=contact,5=age,6=comment,7=manager
  managers: GVZ + '1534781490',
  targets:  GVZ + '325926893',
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
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const p = s.split('T')[0].split('-');
    return `${p[2]}.${p[1]}.${p[0]}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const p = s.split('/');
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
  const res = await axios.get(URLS[key], { timeout: 12000 });
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
    const name = mgr.split(' ')[0]; // фамилия
    msg += `\n👤 *${name}*`;
    msg += `\n  МК: ${s.mk}`;
    if (s.agreed > 0) msg += ` · согл: ${s.agreed}`;
    if (s.pays > 0)   msg += `\n  Оплат: ${s.pays} · ${fmtNum(s.rev)} ₽`;
    msg += '\n';
  }

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

  return msg;
}

async function buildCancels(limit = 15) {
  const rows = await fetchSheet('cancels');
  // 0=ts, 1=crm, 2=reason, 3=is_first, 4=contact, 5=age, 6=comment, 7=manager

  const recent = rows.filter(r => cc(r[0])).slice(-limit).reverse();

  if (!recent.length) return '✅ Отмен нет';

  let msg = `❌ *Последние отмены* (${recent.length})\n\n`;

  for (const r of recent) {
    const date    = normDate(cc(r[0])) || cc(r[0]);
    const mgr     = cc(r[7]) || '—';
    const reason  = cc(r[2]) || '—';
    const isFirst = cc(r[3]);
    const name    = mgr.split(' ')[0];

    msg += `• *${date}* — ${name}\n`;
    msg += `  Причина: ${reason}`;
    if (isFirst) msg += ` · ${isFirst === 'Да' ? '1й МК' : 'повторный'}`;
    msg += '\n';
  }

  return msg;
}

async function buildMissingAlert(dateStr) {
  const [mkRows, managers] = await Promise.all([
    fetchSheet('form'),
    getManagers(),
  ]);

  // Кто внёс МК за этот день
  const submitted = new Set(
    mkRows
      .filter(r => normDate(cc(r[2])) === dateStr)
      .map(r => cc(r[1]))
  );

  const missing = managers.filter(m => !submitted.has(m));
  return missing;
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
    '👋 Привет! Я бот дашборда Eduson Kids.\n\n' +
    'Команды:\n' +
    '/svod — МК и оплаты за вчера\n' +
    '/week — итог последних 7 дней\n' +
    '/cancels — последние отмены МК\n' +
    '/alert — кто не внёс МК сегодня\n' +
    '/help — этот список\n\n' +
    'Работают и русские: /сводка /неделя /отмены /алерт'
  );
});

// /помощь
bot.command(['help', 'помощь'], ctx => {
  ctx.reply(
    '📋 *Команды*\n\n' +
    '/svod — МК и оплаты за вчера\n' +
    '/week — итог за 7 дней\n' +
    '/cancels — последние 15 отмен\n' +
    '/alert — кто не внёс МК сегодня\n\n' +
    'Русские варианты тоже работают:\n/сводка /неделя /отмены /алерт',
    { parse_mode: 'Markdown' }
  );
});

// /svod + /сводка
async function handleSvod(ctx) {
  const date = yesterday();
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildDailySummary(date);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    ctx.replyWithMarkdown(msg);
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
}
bot.command(['svod', 'stats'], handleSvod);
bot.hears(/^\/сводка/i, handleSvod);

// /week + /неделя
async function handleWeek(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildWeeklySummary();
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    ctx.replyWithMarkdown(msg);
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
}
bot.command(['week', 'nedelya'], handleWeek);
bot.hears(/^\/неделя/i, handleWeek);

// /cancels + /отмены
async function handleCancels(ctx) {
  const wait = await ctx.reply('⏳ Загружаю...');
  try {
    const msg = await buildCancels(15);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    ctx.replyWithMarkdown(msg);
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
}
bot.command(['cancels', 'otmeny'], handleCancels);
bot.hears(/^\/отмены/i, handleCancels);

// /alert + /алерт
async function handleAlert(ctx) {
  const date = today();
  const wait = await ctx.reply('⏳ Проверяю...');
  try {
    const missing = await buildMissingAlert(date);
    await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    if (!missing.length) {
      ctx.reply('✅ Все менеджеры внесли МК сегодня');
    } else {
      ctx.replyWithMarkdown(`⚠️ *Не внесли МК за ${date}:*\n${missing.map(m => `• ${m}`).join('\n')}`);
    }
  } catch (e) {
    ctx.reply('❌ Ошибка: ' + e.message);
  }
}
bot.command(['alert'], handleAlert);
bot.hears(/^\/алерт/i, handleAlert);

// ═══════════════════════════════════════
// CRON — автоматические сообщения
// ═══════════════════════════════════════
if (CHAT_ID) {
  // Утренняя сводка за вчера — 9:00 МСК (пн–пт)
  cron.schedule('0 9 * * 1-5', async () => {
    console.log('[cron] Утренняя сводка...');
    try {
      const msg = await buildDailySummary(yesterday());
      bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
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

  console.log('⏰ Cron задачи запущены (МСК):');
  console.log('   Сводка:    пн–пт 9:00');
  console.log('   Алерт:     пн–пт 19:30');
  console.log('   Неделя:    пт 18:00');
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
