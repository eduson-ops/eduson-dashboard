(function (global) {
  'use strict';
  var ROLE_KEY = 'eks-booking-role';
  var API = global.BOOKING_API_URL || 'https://script.google.com/macros/s/AKfycbxkOxVAZKD4J5xqWayF1F7_Uglu-ZSeIeHjfVRtTs0tE9LlkbNNWl2t6kAm2cTk7KZFSw/exec';
  var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; }); };
  var roleName = { call_center: 'КЦ · первая линия', confirmation_manager: 'Вторая линия · подтверждение', sales: 'Сейл' };
  var readRole = function () { try { return localStorage.getItem(ROLE_KEY) || 'call_center'; } catch (_) { return 'call_center'; } };
  var writeRole = function (role) { try { localStorage.setItem(ROLE_KEY, role); } catch (_) {} };
  var request = function (path, options) { var config = Object.assign({}, options || {}); if (config.body) config.headers = { 'Content-Type': 'application/json' }; return fetch(API + path, config).then(function (response) { return response.json().then(function (data) { if (!response.ok || data.ok === false) throw new Error(data.error || 'Ошибка записи'); return data; }); }); };
  var slots = function () { return (global.__bookingSlots || []).filter(function (slot) { return String(slot.status || 'wait').toLowerCase() === 'wait'; }); };
  var slotKey = function (slot) { return [slot.date, slot.time, slot.who || slot.manager].join('|'); };
  var render = function (root, state) {
    var role = state.role; var bookings = state.bookings || []; var managers = global.__bookingManagers || [];
    var slotRows = slots();
    var body = '';
    if (role === 'call_center') {
      body = '<form id="booking-create-form" class="booking-form">'
        + '<label>Сейл<select name="sale" required>' + managers.map(function (name) { return '<option>' + esc(name) + '</option>'; }).join('') + '</select></label>'
        + '<label>Свободный слот<select name="slot" required>' + slotRows.map(function (slot) { return '<option value="' + esc(slotKey(slot)) + '">' + esc(slot.date + ' · ' + slot.time + ' · ' + (slot.who || slot.manager)) + '</option>'; }).join('') + '</select></label>'
        + '<label>Ссылка AmoCRM<input name="crmUrl" type="url" placeholder="https://...amocrm.ru/..." required></label>'
        + '<label>Возраст клиента<input name="age" type="number" min="1" max="18" required></label>'
        + '<label>Телефон клиента<input name="phone" type="tel" placeholder="+7 999 123-45-67" required></label>'
        + '<button class="booking-primary" type="submit">Создать заявку →</button><div id="booking-form-status" role="status"></div></form>'
        + '<h3 class="booking-section-title">Мои заявки</h3>' + bookingList(bookings);
    } else if (role === 'confirmation_manager') {
      body = '<p class="booking-note">Новые заявки КЦ ждут проверки данных и свободного места.</p><div class="booking-queue">' + (bookings.length ? bookings.map(confirmationCard).join('') : '<div class="booking-empty">Очередь пуста</div>') + '</div>';
    } else {
      body = '<p class="booking-note">Здесь появляются только подтверждённые записи, назначенные выбранному сейлу.</p>' + bookingList(bookings);
    }
    root.innerHTML = '<div class="booking-toolbar"><label>Режим<select id="booking-role-select">' + Object.keys(roleName).map(function (key) { return '<option value="' + key + '"' + (key === role ? ' selected' : '') + '>' + roleName[key] + '</option>'; }).join('') + '</select></label><span class="booking-status-line">Данные обновляются через booking endpoint</span></div>' + body;
    var roleSelect = root.querySelector('#booking-role-select'); if (roleSelect) roleSelect.addEventListener('change', function () { writeRole(this.value); refresh(root); });
    var form = root.querySelector('#booking-create-form'); if (form) form.addEventListener('submit', function (event) { submitCreate(event, root); });
    root.querySelectorAll('[data-booking-action]').forEach(function (button) { button.addEventListener('click', function () { transition(this.dataset.bookingAction, this.dataset.bookingId, root); }); });
  };
  var bookingList = function (bookings) { return bookings.length ? '<div class="booking-list">' + bookings.map(function (booking) { return '<article class="booking-card"><b>' + esc(booking.date + ' · ' + booking.time) + '</b><span>' + esc(booking.sale) + ' · ' + esc(booking.phone) + '</span><span class="booking-pill ' + esc(booking.status) + '">' + esc(booking.status) + '</span><a href="' + esc(booking.crmUrl) + '" target="_blank" rel="noopener">AmoCRM ↗</a></article>'; }).join('') + '</div>' : '<div class="booking-empty">Записей пока нет</div>'; };
  var confirmationCard = function (booking) { return '<article class="booking-card booking-card-pending"><b>' + esc(booking.date + ' · ' + booking.time) + '</b><span>' + esc(booking.sale) + ' · ' + esc(booking.phone) + ' · ' + esc(booking.age) + ' лет</span><a href="' + esc(booking.crmUrl) + '" target="_blank" rel="noopener">AmoCRM ↗</a><div class="booking-actions"><button data-booking-action="confirm" data-booking-id="' + esc(booking.bookingId) + '">Подтвердить</button><button data-booking-action="reject" data-booking-id="' + esc(booking.bookingId) + '">Отклонить</button></div></article>'; };
  var refresh = function (root) { var role = readRole(); var sale = ''; try { sale = localStorage.getItem('eks-me') || ''; } catch (_) {} request('?action=list&role=' + encodeURIComponent(role) + '&sale=' + encodeURIComponent(sale)).then(function (data) { render(root, { role: role, bookings: data.bookings || [] }); }).catch(function (error) { render(root, { role: role, bookings: [] }); var status = root.querySelector('#booking-form-status'); if (status) status.textContent = error.message + ' · проверь endpoint'; }); };
  var submitCreate = function (event, root) { event.preventDefault(); var form = event.currentTarget; var data = new FormData(form); var slot = String(data.get('slot')).split('|'); var button = form.querySelector('button[type="submit"]'); var status = form.querySelector('#booking-form-status'); button.disabled = true; status.textContent = 'Сохраняю заявку…'; request('', { method: 'POST', body: JSON.stringify({ action: 'create', date: slot[0], time: slot[1], sale: data.get('sale'), crmUrl: data.get('crmUrl'), age: data.get('age'), phone: data.get('phone'), idempotencyKey: 'cc-' + Date.now() }) }).then(function (result) { status.textContent = 'Заявка ' + result.bookingId + ' создана и отправлена второй линии.'; form.reset(); refresh(root); }).catch(function (error) { status.textContent = error.message; }).finally(function () { button.disabled = false; }); };
  var transition = function (action, bookingId, root) { request('', { method: 'POST', body: JSON.stringify({ action: action, bookingId: bookingId }) }).then(function () { refresh(root); }).catch(function (error) { alert(error.message); }); };
  global.initBookingUI = function (root) { refresh(root); };
  global.refreshBookingUI = function () { var root = document.getElementById('booking-app'); if (root) refresh(root); };
})(window);
