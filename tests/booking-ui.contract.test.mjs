import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../booking-ui.js', import.meta.url), 'utf8');
test('dashboard exposes booking route and role container', () => { assert.match(html, /data-page="booking"/); assert.match(html, /id="page-booking"/); assert.match(html, /id="booking-app"/); assert.match(html, /booking-ui\.js/); });
test('published dashboard points to the authenticated platform and retires the legacy writer', () => { assert.match(ui, /https:\/\/booking\.82\.148\.17\.109\.sslip\.io\//); assert.doesNotMatch(ui, /script\.google\.com|form\.submit\(|jsonp\(|<form/); });
