import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sessionDigest, readCookie, cookieHeader, requireCsrf, createLoginLimiter, requestAddress } from '../auth.mjs';

test('password hashes are salted and reject incorrect or malformed passwords', async () => {
  const one = await hashPassword('Eduson test password 2026');
  const two = await hashPassword('Eduson test password 2026');
  assert.notEqual(one, two);
  assert.equal(one.includes('Eduson test'), false);
  assert.equal(await verifyPassword('Eduson test password 2026', one), true);
  assert.equal(await verifyPassword('wrong password', one), false);
  assert.equal(await verifyPassword('anything', 'broken'), false);
  await assert.rejects(hashPassword('short'), /10/);
});

test('session digests and cookies do not expose session storage values', () => {
  const token = 'a'.repeat(64);
  assert.notEqual(sessionDigest(token), token);
  const header = cookieHeader(token, { secure: true });
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.equal(readCookie('other=x; eduson_booking_session=' + token), token);
  assert.equal(readCookie('bad=%E0%A4%A'), null);
});

test('mutations need both csrf token and a matching browser origin', () => {
  const session = { csrfToken: 'secret' };
  assert.doesNotThrow(() => requireCsrf({ headers: { 'x-csrf-token': 'secret', origin: 'http://127.0.0.1:4180', host: '127.0.0.1:4180' } }, session));
  assert.throws(() => requireCsrf({ headers: { 'x-csrf-token': 'wrong', host: 'localhost' } }, session), e => e.status === 403);
  assert.throws(() => requireCsrf({ headers: { 'x-csrf-token': 'secret', origin: 'https://evil.example', host: 'localhost' } }, session), e => e.status === 403);
});

test('failed login throttling expires without extending a lock on each attempt', () => {
  let now = 1000;
  const limiter = createLoginLimiter({ maxAttempts: 2, windowMs: 100, now: () => now });
  assert.equal(limiter.blocked('one'), false);
  limiter.failure('one'); limiter.failure('one');
  assert.equal(limiter.blocked('one'), true);
  assert.equal(limiter.blocked('two'), false);
  now = 1101;
  assert.equal(limiter.blocked('one'), false);
  limiter.failure('one'); limiter.clear('one');
  assert.equal(limiter.blocked('one'), false);
});

test('forwarded client addresses need explicit trust and a loopback proxy', () => {
  const request = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(requestAddress(request('127.0.0.1', '198.51.100.8')), '127.0.0.1');
  assert.equal(requestAddress(request('203.0.113.9', '198.51.100.8'), { trustProxy: true }), '203.0.113.9');
  assert.equal(requestAddress(request('127.0.0.1', '192.0.2.100, 198.51.100.8'), { trustProxy: true }), '198.51.100.8');
  assert.equal(requestAddress(request('::1', '198.51.100.8'), { trustProxy: true }), '198.51.100.8');
  assert.equal(requestAddress(request('::ffff:127.0.0.1', '::ffff:198.51.100.8'), { trustProxy: true }), '::ffff:198.51.100.8');
  assert.equal(requestAddress(request('127.0.0.1', 'not-an-ip'), { trustProxy: true }), '127.0.0.1');
});
