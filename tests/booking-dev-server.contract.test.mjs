import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../booking-dev-server.mjs', import.meta.url), 'utf8');

test('dev server exposes booking GET and POST contract', () => {
  assert.match(source, /url\.pathname === '\/booking'/);
  assert.match(source, /body\.action === 'create'/);
  assert.match(source, /store\.transition/);
});
