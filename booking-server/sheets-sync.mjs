import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets/';
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const SAFE_ERRORS = new Set(['SYNC_CONFIGURATION', 'SYNC_ATTEMPTS_EXHAUSTED', 'SERVICE_ACCOUNT_INVALID', 'OAUTH_FAILED', 'NETWORK_FAILED', 'SHEET_HEADER_MISMATCH', 'SHEET_DUPLICATE_ID', 'SHEET_RESPONSE_INVALID', 'BOOKING_NOT_FOUND', 'SYNC_JOB_KIND_INVALID', 'SYNC_FAILED']);
const BOOKING_HEADERS = ['ID', 'Дата', 'Время', 'Менеджер', 'AmoCRM', 'Возраст ребёнка', 'ПК', 'Родитель', 'Комментарий', 'Статус', 'Создано', 'Изменено'];
const REPORT_HEADERS = [']', 'Кто провёл урок?', 'Дата МК', 'Время МК', 'Ссылка на CRM', 'Ссылка на запись урока', 'Практика', 'Возраст', 'Какой пакет предложил/оплатили', 'Вариант оплаты', 'Договорённости с клиентом', 'Итоговое возражение', 'С какого канала пришли (смотри скрин)', 'Сумма оплаты (после комиссий банка) без копеек'];
const CANCEL_HEADERS = ['Отметка времени', 'Ссылка на AMO', 'Причина отмены', 'Первичная отмена или нет?', 'Как пробовали связаться?', 'Возраст', 'Комментарий', 'МИМК'];
const TARGETS = {
  booking: {tab: 'Booking VDS', headers: BOOKING_HEADERS, lastColumn: 'L', idColumn: 'A'},
  report: {tab: 'Ответы формы', headers: REPORT_HEADERS, lastColumn: 'O', idColumn: 'O', extraHeaders: ['Booking ID']},
  cancel: {tab: 'Отмены', headers: CANCEL_HEADERS, lastColumn: 'J', idColumn: 'I', extraHeaders: ['Booking ID', 'Booking status']},
};

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function safeError(error) {
  return SAFE_ERRORS.has(error?.code) || /^GOOGLE_HTTP_[1-5]\d{2}$/.test(error?.code || '') ? error.code : 'SYNC_FAILED';
}
const cell = value => value == null ? '' : value instanceof Date ? value.toISOString() : value;
const yesNo = value => value == null ? '' : value ? 'Да' : 'Нет';
const normalizeHeader = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru-RU');

/** The original report sheet has fourteen business columns; stable identity is separate. */
export function mapReportRow(booking) {
  const report = booking.report || {};
  return [report.timestamp ?? booking.updatedAt, report.teacher ?? booking.assignedName, report.date ?? booking.date,
    report.time ?? booking.time, report.crmUrl ?? booking.crmUrl, report.recordingUrl, report.practice,
    report.age ?? booking.age, report.package, report.paymentMethod, report.agreement, report.objection,
    report.channel, report.amountNet].map(cell);
}
function mapBookingRow(booking) {
  const state = booking.state === 'scheduled' ? (booking.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending_confirmation') : booking.state;
  return [booking.id, booking.date, booking.time, booking.assignedName, booking.crmUrl, booking.age,
    yesNo(booking.hasPc), yesNo(booking.parentPresent), booking.comment, state, booking.createdAt, booking.updatedAt].map(cell);
}
function mapCancellationRow(booking) {
  const cancellation = booking.cancellation || {};
  return [cancellation.timestamp ?? booking.cancelledAt ?? booking.updatedAt, booking.crmUrl,
    cancellation.reason ?? booking.cancelReason, yesNo(cancellation.firstCancellation), cancellation.contactMethod,
    booking.age, cancellation.comment ?? booking.comment, cancellation.manager ?? booking.assignedName].map(cell);
}

/** Creates an opt-in projection worker. Construction never reads a key or contacts Google. */
export function createSheetSynchronizer({db, getBooking, serviceAccountPath, spreadsheetId, enabled = false, fetchImpl = fetch, now = () => new Date()} = {}) {
  let token = null;
  let running = false;
  const clock = () => new Date(typeof now === 'function' ? now() : now);
  const rangeFor = (target, cells) => `'${target.tab}'!${cells}`;
  const valuesUrl = range => `${SHEETS_URL}${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;

  async function fetchJson(url, options) {
    let response;
    try { response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(30_000)}); }
    catch { throw new SyncError('NETWORK_FAILED'); }
    if (!response.ok) throw new SyncError(`GOOGLE_HTTP_${response.status}`);
    try { return await response.json(); }
    catch { throw new SyncError('SHEET_RESPONSE_INVALID'); }
  }
  async function accessToken() {
    if (token && token.expiresAt > clock().valueOf() + 60_000) return token.value;
    let account;
    try {
      account = JSON.parse(await readFile(serviceAccountPath, 'utf8'));
      if (typeof account.client_email !== 'string' || typeof account.private_key !== 'string') throw new Error();
    } catch { throw new SyncError('SERVICE_ACCOUNT_INVALID'); }
    const issuedAt = Math.floor(clock().valueOf() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: OAUTH_URL, iat: issuedAt, exp: issuedAt + 3600})}`;
    let assertion;
    try { assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`; }
    catch { throw new SyncError('SERVICE_ACCOUNT_INVALID'); }
    const body = new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion});
    const result = await fetchJson(OAUTH_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: body.toString()});
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new SyncError('OAUTH_FAILED');
    token = {value: result.access_token, expiresAt: clock().valueOf() + Math.min(Number(result.expires_in), 3600) * 1000};
    return token.value;
  }
  async function sheetRequest(range, {method = 'GET', values, append = false} = {}) {
    const bearer = await accessToken();
    let url = valuesUrl(range) + (append ? ':append' : '');
    if (method !== 'GET') url += `?valueInputOption=RAW${append ? '&insertDataOption=INSERT_ROWS' : ''}`;
    try {
      return await fetchJson(url, {method, headers: {Authorization: `Bearer ${bearer}`, ...(values ? {'Content-Type': 'application/json'} : {})}, ...(values ? {body: JSON.stringify({majorDimension: 'ROWS', values})} : {})});
    } catch (error) {
      if (error.code === 'GOOGLE_HTTP_401') token = null;
      throw error;
    }
  }
  async function validateHeaders(target) {
    // Read the complete owned range before adding any metadata column.
    const result = await sheetRequest(rangeFor(target, `A1:${target.lastColumn}1`));
    const actual = result.values?.[0] || [];
    for (let index = 0; index < target.headers.length; index++) {
      const wanted = normalizeHeader(target.headers[index]);
      const found = normalizeHeader(actual[index]);
      const matches = target === TARGETS.report && index === 5 ? found.startsWith(wanted) : found === wanted;
      if (!matches) throw new SyncError('SHEET_HEADER_MISMATCH');
    }
    let needsMetadata = false;
    for (const [offset, header] of (target.extraHeaders || []).entries()) {
      const found = normalizeHeader(actual[target.headers.length + offset]);
      if (found && found !== normalizeHeader(header)) throw new SyncError('SHEET_HEADER_MISMATCH');
      if (!found) needsMetadata = true;
    }
    if (needsMetadata) {
      // A blank header does not make an occupied column safe to take over.
      const metadata = (await sheetRequest(rangeFor(target, `${target.idColumn}2:${target.lastColumn}`))).values || [];
      for (const [offset] of target.extraHeaders.entries()) {
        if (!normalizeHeader(actual[target.headers.length + offset]) && metadata.some(row => cell(row[offset]) !== '')) {
          throw new SyncError('SHEET_HEADER_MISMATCH');
        }
      }
      await sheetRequest(rangeFor(target, `${target.idColumn}1:${target.lastColumn}1`), {method: 'PUT', values: [target.extraHeaders]});
    }
  }
  async function project(job, booking) {
    const target = TARGETS[job.kind];
    if (!target) throw new SyncError('SYNC_JOB_KIND_INVALID');
    if (job.kind === 'report' && !booking.report) return;
    await validateHeaders(target);
    // Each attempt reads stable IDs again, including an append whose response was lost.
    const ids = (await sheetRequest(rangeFor(target, `${target.idColumn}2:${target.idColumn}`))).values || [];
    const matches = ids.flatMap((row, index) => String(row[0] ?? '') === String(booking.id) ? [index + 2] : []);
    if (matches.length > 1) throw new SyncError('SHEET_DUPLICATE_ID');
    const rowNumber = matches[0];
    let values;
    if (job.kind === 'booking') values = mapBookingRow(booking);
    if (job.kind === 'report') values = [...mapReportRow(booking), booking.id];
    if (job.kind === 'cancel') {
      const cancelled = booking.state === 'cancelled';
      let fact = mapCancellationRow(booking);
      // Restore changes only state. Preserve the cancellation fact already projected.
      if (!cancelled && rowNumber) {
        const previous = (await sheetRequest(rangeFor(target, `A${rowNumber}:H${rowNumber}`))).values?.[0] || [];
        fact = Array.from({length: 8}, (_, index) => cell(previous[index]));
      }
      values = [...fact, booking.id, cancelled ? 'cancelled' : 'restored'];
    }
    if (rowNumber) await sheetRequest(rangeFor(target, `A${rowNumber}:${target.lastColumn}${rowNumber}`), {method: 'PUT', values: [values]});
    else await sheetRequest(rangeFor(target, `A:${target.lastColumn}`), {method: 'POST', append: true, values: [values]});
  }
  async function claim() {
    const timestamp = clock();
    const staleAt = new Date(timestamp.valueOf() - LEASE_MS);
    return db.transaction(async tx => {
      // A short table lock makes the lease claim exclusive across worker processes.
      // No network request holds a database transaction or lock.
      await tx.query('LOCK TABLE eduson_booking.sync_jobs IN SHARE ROW EXCLUSIVE MODE');
      await tx.query(`UPDATE eduson_booking.sync_jobs SET status='error',last_error='SYNC_ATTEMPTS_EXHAUSTED',updated_at=$2
        WHERE status='processing' AND updated_at <= $1 AND attempts >= $3`, [staleAt, timestamp, MAX_ATTEMPTS]);
      const active = await tx.query(`SELECT id FROM eduson_booking.sync_jobs WHERE status='processing' AND updated_at > $1 LIMIT 1`, [staleAt]);
      if (active.rows.length) return null;
      const result = await tx.query(`SELECT * FROM eduson_booking.sync_jobs
        WHERE COALESCE(attempts,0) < $1 AND (status='pending'
          OR (status='processing' AND updated_at <= $2)
          OR (status='error' AND updated_at <= $3::timestamptz - (LEAST(3600000,5000 * POWER(2,GREATEST(0,COALESCE(attempts,0)-1))) * interval '1 millisecond')))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [MAX_ATTEMPTS, staleAt, timestamp]);
      const job = result.rows[0];
      if (!job) return null;
      const claimed = await tx.query(`UPDATE eduson_booking.sync_jobs SET status='processing',attempts=COALESCE(attempts,0)+1,last_error=NULL,updated_at=$2 WHERE id=$1 RETURNING *`, [job.id, timestamp]);
      return claimed.rows[0];
    });
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
        const booking = await getBooking(job.booking_id);
        if (!booking || String(booking.id) !== String(job.booking_id)) throw new SyncError('BOOKING_NOT_FOUND');
        await project(job, booking);
        await db.query(`UPDATE eduson_booking.sync_jobs SET status='done',last_error=NULL,updated_at=$2 WHERE id=$1`, [job.id, clock()]);
        return {processed: true, status: 'done'};
      } catch (error) {
        const code = safeError(error);
        await db.query(`UPDATE eduson_booking.sync_jobs SET status='error',last_error=$2,updated_at=$3 WHERE id=$1`, [job.id, code, clock()]);
        return {processed: true, status: 'error', error: code};
      }
    } finally { running = false; }
  }
  async function status() {
    const [counts, latest] = await Promise.all([
      db.query(`SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending, COUNT(*) FILTER (WHERE status='error')::int AS error FROM eduson_booking.sync_jobs`),
      db.query(`SELECT last_error FROM eduson_booking.sync_jobs WHERE status='error' ORDER BY updated_at DESC,id DESC LIMIT 1`),
    ]);
    return {enabled: Boolean(enabled), pending: Number(counts.rows[0]?.pending || 0), error: Number(counts.rows[0]?.error || 0), lastError: latest.rows.length ? safeError({code: latest.rows[0].last_error}) : null};
  }
  return {runOnce, status};
}
