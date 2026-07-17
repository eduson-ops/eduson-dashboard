import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const block = html.match(/\/\/ RUN RATE HELPERS START([\s\S]*?)\/\/ RUN RATE HELPERS END/);

test('run-rate helpers are embedded in index.html', () => {
  assert.ok(block, 'RUN RATE HELPERS block is missing');
});

test('calcRunRate forecasts revenue over calendar days', () => {
  assert.ok(block, 'RUN RATE HELPERS block is missing');
  const context = {};
  vm.createContext(context);
  vm.runInContext(block[1], context);

  assert.equal(context.countCalendarDays(new Date(2026, 6, 1), new Date(2026, 6, 31)), 31);
  assert.equal(context.countCalendarDays(new Date(2026, 6, 1), new Date(2026, 6, 16)), 16);
  assert.equal(context.calcRunRate(200058, new Date(2026, 6, 16)), 387612);
  assert.equal(context.calcRunRate(0, new Date(2026, 6, 16)), 0);
  assert.equal(context.calcRunRate(1000, new Date(2026, 6, 31)), 1000);
});

test('ranking exposes average check and run rate', () => {
  assert.match(html, /<th[^>]*>Ср\. чек<\/th>/);
  assert.match(html, /Run rate/);
  assert.match(html, /calcRunRate\(/);
  assert.match(html, /mainDfMode\s*===\s*'all'/);
  assert.match(html, /% от плана/);
});
