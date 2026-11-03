import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets/';
const SAFE_ERRORS = new Set(['SYNC_CONFIGURATION','SYNC_ATTEMPTS_EXHAUSTED','SYNC_LEASE_LOST','SERVICE_ACCOUNT_INVALID','OAUTH_FAILED','NETWORK_FAILED','SHEET_HEADER_MISMATCH','SHEET_DUPLICATE_ID','SHEET_RESPONSE_INVALID','SHEET_FOREIGN_OWNER','SHEET_DATE_INVALID','SHEET_TIME_INVALID','SHEET_SNAPSHOT_INVALID','SHEET_SNAPSHOT_UNRESOLVED','BOOKING_NOT_FOUND','SYNC_JOB_KIND_INVALID','SYNC_FAILED']);
export class SheetSyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function safeSheetSyncError(error) {
  return SAFE_ERRORS.has(error?.code) || /^GOOGLE_HTTP_[1-5]\d{2}$/.test(error?.code || '') ? error.code : 'SYNC_FAILED';
}
export const normalizeSheetHeader = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru-RU');

/** Lazy service-account transport shared by both opt-in projection workers. */
export function createGoogleSheetsClient({serviceAccountPath, spreadsheetId, fetchImpl = fetch, now = () => new Date()} = {}) {
  let token = null;
  let tokenRequest = null;
  const clock = () => new Date(typeof now === 'function' ? now() : now);
  const base = `${SHEETS_URL}${encodeURIComponent(spreadsheetId)}`;
  async function fetchJson(url, options) {
    let response;
    try { response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(30_000)}); }
    catch { throw new SheetSyncError('NETWORK_FAILED'); }
    if (!response.ok) throw new SheetSyncError(`GOOGLE_HTTP_${response.status}`);
    try { return await response.json(); }
    catch { throw new SheetSyncError('SHEET_RESPONSE_INVALID'); }
  }
  async function mintToken() {
    let account;
    try {
      account = JSON.parse(await readFile(serviceAccountPath, 'utf8'));
      if (typeof account.client_email !== 'string' || typeof account.private_key !== 'string') throw new Error();
    } catch { throw new SheetSyncError('SERVICE_ACCOUNT_INVALID'); }
    const issuedAt = Math.floor(clock().valueOf() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: OAUTH_URL, iat: issuedAt, exp: issuedAt + 3600})}`;
    let assertion;
    try { assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`; }
    catch { throw new SheetSyncError('SERVICE_ACCOUNT_INVALID'); }
    const body = new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion});
    const result = await fetchJson(OAUTH_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: body.toString()});
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new SheetSyncError('OAUTH_FAILED');
    token = {value: result.access_token, expiresAt: clock().valueOf() + Math.min(Number(result.expires_in), 3600) * 1000};
    return token.value;
  }
  async function accessToken() {
    if (token && token.expiresAt > clock().valueOf() + 60_000) return token.value;
    if (!tokenRequest) tokenRequest = mintToken().finally(() => {tokenRequest = null;});
    return tokenRequest;
  }
  async function authorized(url, {method = 'GET', body} = {}) {
    const bearer = await accessToken();
    try {
      return await fetchJson(url, {method, headers: {Authorization: `Bearer ${bearer}`, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    } catch (error) {
      if (error.code === 'GOOGLE_HTTP_401') token = null;
      throw error;
    }
  }
  async function request(range, {method = 'GET', values, append = false, unformatted = false, insertDataOption = 'INSERT_ROWS'} = {}) {
    let url = `${base}/values/${encodeURIComponent(range)}${append ? ':append' : ''}`;
    if (method !== 'GET') url += `?valueInputOption=RAW${append ? `&insertDataOption=${insertDataOption}` : ''}`;
    else if (unformatted) url += '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
    return authorized(url, {method, ...(values ? {body: {majorDimension: 'ROWS', values}} : {})});
  }
  async function batchUpdate(data) {
    if (!data.length) return;
    return authorized(`${base}/values:batchUpdate`, {method: 'POST', body: {valueInputOption: 'RAW', data: data.map(item => ({...item, majorDimension: 'ROWS'}))}});
  }
  return {request, batchUpdate};
}
