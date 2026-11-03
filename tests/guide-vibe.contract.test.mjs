import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('guide exposes the vibe-coding tab and all three practices', () => {
  assert.match(html, /showGuideTab\('vibe',this\)/);
  assert.match(html, /id="gtab-vibe"/);
  assert.match(html, /2D-платформер/);
  assert.match(html, /2D-игра аркада/);
  assert.match(html, /Лендинг своего продукта/);
  assert.match(html, /\['courses','vibe','reports','prices'\]/);
});
