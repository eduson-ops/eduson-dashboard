import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../booking-ui.js', import.meta.url), 'utf8');
test('dashboard exposes booking route and role container', () => { assert.match(html, /data-page="booking"/); assert.match(html, /id="page-booking"/); assert.match(html, /id="booking-app"/); assert.match(html, /booking-ui\.js/); });
test('booking UI contains roles and child fields', () => { assert.match(ui, /call_center/); assert.match(ui, /confirmation_manager/); assert.match(ui, /name="crmUrl"/); assert.match(ui, /Возраст ребёнка/); assert.match(ui, /Свободно слотов/); assert.doesNotMatch(ui, /Сейл<select name="sale"/); assert.match(ui, /name="age"/); assert.match(ui, /name="phone"/); assert.match(ui, /data-booking-action="confirm"/); });
