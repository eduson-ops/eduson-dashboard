import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('ranking exposes average check and revenue per MK', () => {
  assert.match(html, /<th[^>]*>Ср\. чек<\/th>/);
  assert.match(html, /<th[^>]*>₽\/МК<\/th>/);
  const rankingHeader = html.match(/<tbody id="tbody"><\/tbody>/)
    ? html.slice(0, html.indexOf('<tbody id="tbody"></tbody>'))
    : html;
  assert.doesNotMatch(rankingHeader, /Run rate/);
  assert.doesNotMatch(html, /calcRunRate\(/);
});
