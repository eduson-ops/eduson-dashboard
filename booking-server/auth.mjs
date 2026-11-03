import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const scrypt = promisify(scryptCallback);
const ROLES = new Set(['call_center', 'confirmation', 'sales', 'admin']);
export const COOKIE_NAME = 'eduson_booking_session';
const SESSION_MS = 8 * 60 * 60 * 1000;

function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
function equal(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw fault('Пароль должен содержать от 10 до 256 символов');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 256 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(String(hash))) return false;
  const [, salt, stored] = hash.split(':');
  const key = await scrypt(password, salt, 64);
  return equal(key.toString('hex'), stored);
}

export function sessionDigest(token) { return createHash('sha256').update(String(token)).digest('hex'); }
export function readCookie(header = '') {
  try {
    const part = String(header).split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '='));
    return part ? decodeURIComponent(part.slice(COOKIE_NAME.length + 1)) : null;
  } catch { return null; }
}
export function cookieHeader(token, { secure = false, clear = false } = {}) {
  return `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
export function checkOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    const allowed = publicOrigin ? parsed.origin === new URL(publicOrigin).origin : parsed.host === req.headers.host && ['http:', 'https:'].includes(parsed.protocol);
    if (allowed) return;
  } catch { /* invalid origins are denied */ }
  throw fault('Запрос отправлен с другого сайта', 403);
}
export function requireCsrf(req, session, { publicOrigin } = {}) {
  checkOrigin(req, publicOrigin);
  if (!session?.csrfToken || !equal(req.headers['x-csrf-token'], session.csrfToken)) throw fault('Сессия формы устарела. Обновите страницу', 403);
}

export function createLoginLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const attempts = new Map();
  function entry(key) {
    const value = attempts.get(key);
    if (value && value.until <= now()) { attempts.delete(key); return null; }
    return value;
  }
  return {
    blocked: key => (entry(key)?.count || 0) >= maxAttempts,
    failure(key) {
      if (attempts.size > 5000) {
        for (const [k, v] of attempts) if (v.until <= now()) attempts.delete(k);
        if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
      }
      const value = entry(key) || { count: 0, until: now() + windowMs };
      value.count++; attempts.set(key, value);
    },
    clear: key => attempts.delete(key),
  };
}

export function requestAddress(req, { trustProxy = false } = {}) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (!trustProxy || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer.toLowerCase())) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  if (forwarded.length > 1024) return peer;
  const candidate = forwarded.split(',').at(-1).trim();
  return isIP(candidate) ? candidate : peer;
}

function publicUser(row) {
  return row && { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, ageGroups: row.age_groups || [] };
}
function admin(actor) { if (actor?.role !== 'admin') throw fault('Доступ только администратору', 403); }
function validateUser(input) {
  const name = String(input.name || '').trim(); const email = String(input.email || '').trim().toLowerCase();
  if (!name || name.length > 120) throw fault('Укажите имя до 120 символов');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw fault('Укажите корректную почту');
  if (!ROLES.has(input.role)) throw fault('Неизвестная роль');
  return { name, email, role: input.role };
}
function ageGroups(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some(x => !/^\d{1,2}-\d{1,2}$/.test(x) || +x.split('-')[0] < 1 || +x.split('-')[1] > 18 || +x.split('-')[0] > +x.split('-')[1])) throw fault('Возрастные группы должны иметь вид 5-7');
  return [...new Set(value)];
}

export async function createAuth(db, { now = () => new Date(), validateUserChange } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS eduson_booking.sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES eduson_booking.users(id),
    csrf_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dummyHash = await hashPassword(randomBytes(20).toString('hex'));
  return {
    async login(email, password) {
      const { rows } = await db.query('SELECT * FROM eduson_booking.users WHERE lower(email)=$1', [String(email || '').trim().toLowerCase()]);
      const row = rows[0]; const valid = await verifyPassword(password, row?.password_hash || dummyHash);
      if (!row?.active || !valid) throw fault('Неверная почта или пароль', 401);
      const token = randomBytes(32).toString('hex'); const csrfToken = randomBytes(32).toString('hex');
      await db.query('DELETE FROM eduson_booking.sessions WHERE expires_at < $1', [now()]);
      await db.query('INSERT INTO eduson_booking.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)', [sessionDigest(token), row.id, csrfToken, new Date(+now() + SESSION_MS)]);
      return { user: publicUser(row), token, csrfToken };
    },
    async session(token) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
      const { rows } = await db.query(`SELECT u.*,s.csrf_token FROM eduson_booking.sessions s JOIN eduson_booking.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.active=true`, [sessionDigest(token), now()]);
      return rows[0] ? { user: publicUser(rows[0]), csrfToken: rows[0].csrf_token } : null;
    },
    async logout(token) { if (token) await db.query('DELETE FROM eduson_booking.sessions WHERE token_hash=$1', [sessionDigest(token)]); },
    async users(actor) { admin(actor); return (await db.query('SELECT id,email,name,role,active,age_groups FROM eduson_booking.users ORDER BY name')).rows.map(publicUser); },
    async createUser(actor, input) {
      admin(actor); const user = validateUser(input); const groups = ageGroups(input.ageGroups || []); const hash = await hashPassword(input.password);
      try {
        const { rows } = await db.query(`INSERT INTO eduson_booking.users(id,email,name,role,password_hash,active,age_groups,created_at) VALUES($1,$2,$3,$4,$5,true,$6,$7) RETURNING *`, [randomUUID(), user.email, user.name, user.role, hash, JSON.stringify(groups), now()]);
        return publicUser(rows[0]);
      } catch (e) { if (e.code === '23505') throw fault('Пользователь с этой почтой уже существует', 409); throw e; }
    },
    async updateUser(actor, id, input) {
      admin(actor);
      const password = input.password ? await hashPassword(input.password) : null;
      return db.transaction(async tx => {
        await tx.query('LOCK TABLE eduson_booking.bookings,eduson_booking.schedules,eduson_booking.users IN SHARE ROW EXCLUSIVE MODE');
        const old = (await tx.query('SELECT * FROM eduson_booking.users WHERE id=$1', [id])).rows[0];
        if (!old) throw fault('Пользователь не найден', 404);
        const next = validateUser({ ...old, ...input });
        const active = input.active === undefined ? old.active : input.active;
        if (typeof active !== 'boolean') throw fault('Некорректное значение активности');
        if (old.role === 'admin' && old.active && (next.role !== 'admin' || !active)) {
          const count = (await tx.query("SELECT count(*)::int AS n FROM eduson_booking.users WHERE role='admin' AND active=true")).rows[0].n;
          if (count <= 1) throw fault('Нельзя отключить последнего администратора', 409);
        }
        const groups = ageGroups(input.ageGroups === undefined ? old.age_groups || [] : input.ageGroups);
        const result = await tx.query('UPDATE eduson_booking.users SET email=$2,name=$3,role=$4,active=$5,age_groups=$6,password_hash=$7 WHERE id=$1 RETURNING *', [id, next.email, next.name, next.role, active, JSON.stringify(groups), password || old.password_hash]);
        if (validateUserChange && (active !== old.active || next.role !== old.role || JSON.stringify(groups) !== JSON.stringify(old.age_groups))) await validateUserChange(tx);
        if (password || !active || next.role !== old.role) await tx.query('DELETE FROM eduson_booking.sessions WHERE user_id=$1', [id]);
        return publicUser(result.rows[0]);
      });
    },
  };
}
