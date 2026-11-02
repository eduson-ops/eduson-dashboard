(function (global) {
  'use strict';
  var ROLE_KEY = 'eks-booking-role';
  var API = global.BOOKING_API_URL || 'https://script.google.com/macros/s/AKfycbxkOxVAZKD4J5xqWayF1F7_Uglu-ZSeIeHjfVRtTs0tE9LlkbNNWl2t6kAm2cTk7KZFSw/exec';
  var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; }); };
  var roleName = { call_center: 'КЦ · первая линия', confirmation_manager: 'Вторая линия · подтверждение', sales: 'Сейл' };
  var readRole = function () { try { return localStorage.getItem(ROLE_KEY) || 'call_center'; } catch (_) { return 'call_center'; } };
  var writeRole = function (role) { try { localStorage.setItem(ROLE_KEY, role); } catch (_) {} };
  var jsonp = function (path) { return new Promise(function (resolve, reject) { var callback = '__booking_jsonp_' + Date.now() + '_' + Math.floor(Math.random() * 100000); var script = document.createElement('script'); var timer = setTimeout(function () { cleanup(); reject(new Error('Истёк таймаут booking endpoint')); }, 12000); var cleanup = function () { clearTimeout(timer); try { delete global[callback]; } catch (_) { global[callback] = undefined; } if (script.parentNode) script.parentNode.removeChild(script); }; global[callback] = function (data) { cleanup(); if (!data || data.ok === false) reject(new Error((data && data.error) || 'Ошибка записи')); else resolve(data); }; script.onerror = function () { cleanup(); reject(new Error('Не удалось загрузить booking endpoint')); }; var markedPath = path.replace(/([?&])action=([^&]*)/, '$1action=$2%7Ccallback%3A' + encodeURIComponent(callback)); if (markedPath === path) { var separator = path.indexOf('?') >= 0 ? '&' : '?'; markedPath = path + separator + 'callback=' + encodeURIComponent(callback); } script.src = API + markedPath; document.body.appendChild(script); }); };
  var postForm = function (body) { return new Promise(function (resolve, reject) { var frameName = '__booking_post_' + Date.now() + '_' + Math.floor(Math.random() * 100000); var frame = document.createElement('iframe'); frame.name = frameName; frame.style.display = 'none'; var form = document.createElement('form'); form.method = 'POST'; form.action = API; form.target = frameName; form.style.display = 'none'; Object.keys(body || {}).forEach(function (key) { var input = document.createElement('input'); input.type = 'hidden'; input.name = key; input.value = body[key] == null ? '' : body[key]; form.appendChild(input); }); document.body.appendChild(frame); document.body.appendChild(form); var done = false; var onMessage = function (event) { var data = event && event.data; if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { return; } } if (!data || data.source !== 'eduson-booking') return; finish(data.payload || data); }; var onLoad = function () { setTimeout(function () { if (done) return; try { var named = frame.contentWindow && frame.contentWindow.name; if (named) { var data = JSON.parse(named); if (data && data.source === 'eduson-booking') return finish(data.payload || data); } } catch (_) {} if (!done) finish({ ok: true, pending: true }); }, 500); }; var cleanup = function () { global.removeEventListener('message', onMessage); if (form.parentNode) form.parentNode.removeChild(form); if (frame.parentNode) frame.parentNode.removeChild(frame); }; var finish = function (result) { if (done) return; done = true; cleanup(); if (result && result.ok === false) reject(new Error(result.error || 'Ошибка записи')); else resolve(result || { ok: true, pending: true }); }; global.addEventListener('message', onMessage); frame.addEventListener('load', onLoad, { once: true }); form.submit(); setTimeout(function () { if (!done) finish({ ok: true, pending: true }); }, 8000); }); };
  var request = function (path, options) { var config = options || {}; if (config.body) return postForm(JSON.parse(config.body)); return jsonp(path); };
  var slots = function () { return (global.__bookingSlots || []).filter(function (slot) { return String(slot.status || 'wait').toLowerCase() === 'wait'; }); };
  var slotKey = function (slot) { return [slot.date, slot.time, slot.who || slot.manager].join('|'); };
  var monthNames = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  var dateLabel = function (value) {
    var parts = String(value || '').split('.');
    if (parts.length !== 3) return value;
    return String(Number(parts[0])).padStart(2, '0') + ' ' + (monthNames[Number(parts[1]) - 1] || parts[1]);
  };
  var groupSlots = function (rows) {
    var groups = {};
    (rows || []).forEach(function (slot) {
      var date = String(slot.date || '');
      var time = String(slot.time || '');
      if (!date || !time) return;
      if (!groups[date]) groups[date] = { date: date, count: 0, times: {} };
      groups[date].count += 1;
      var key = date + '|' + time;
      if (!groups[date].times[key]) groups[date].times[key] = { slot: slot, count: 0 };
      groups[date].times[key].count += 1;
    });
    return Object.keys(groups).map(function (date) {
      var group = groups[date];
      group.times = Object.keys(group.times).map(function (key) { return group.times[key]; });
      return group;
    });
  };
  var render = function (root, state) {
    var role = state.role; var bookings = state.bookings || [];
    var slotRows = slots();
    var slotGroups = groupSlots(slotRows);
    var firstGroup = slotGroups[0];
    var firstTime = firstGroup && firstGroup.times[0];
    var body = '';
    if (role === 'call_center') {
      var renderTimeGrid = function (group, selectedValue) {
        if (!group) return '<div class="booking-empty">Свободных слотов пока нет</div>';
        return '<div class="booking-time-grid">' + group.times.map(function (item) {
          var value = slotKey(item.slot);
          var active = value === selectedValue ? ' is-active' : '';
          var placeLabel = item.count === 1 ? '1 место' : item.count + ' места';
          return '<button type="button" class="booking-slot-btn' + active + '" data-slot-value="' + esc(value) + '"><strong>' + esc(item.slot.time) + '</strong><span>' + placeLabel + '</span></button>';
        }).join('') + '</div>';
      };
      var initialValue = firstTime ? slotKey(firstTime.slot) : '';
      var dateButtons = slotGroups.map(function (group, index) {
        return '<button type="button" class="booking-date-btn' + (index === 0 ? ' is-active' : '') + '" data-booking-date="' + esc(group.date) + '"><strong>' + esc(dateLabel(group.date)) + '</strong><span>' + group.count + ' мест</span></button>';
      }).join('');
      body = '<form id="booking-create-form" class="booking-form">'
        + '<section class="booking-picker" aria-label="Выбор даты и времени">'
        + '<div class="booking-picker-head"><div><span class="booking-picker-kicker">Шаг 1</span><h3>Выберите дату и время</h3></div><span class="booking-free-summary">Свободно мест <b>' + slotRows.length + '</b></span></div>'
        + '<div class="booking-date-list">' + (dateButtons || '<div class="booking-empty">Свободных слотов пока нет</div>') + '</div>'
        + '<div id="booking-slot-grid" class="booking-slot-grid-wrap">' + renderTimeGrid(firstGroup, initialValue) + '</div>'
        + '<input type="hidden" name="slot" id="booking-slot-value" value="' + esc(initialValue) + '" required></section>'
        + '<label>Ссылка AmoCRM<input name="crmUrl" type="url" placeholder="https://...amocrm.ru/..." required></label>'
        + '<label>Возраст ребёнка<input name="age" type="number" min="1" max="18" required></label>'
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
    var form = root.querySelector('#booking-create-form'); if (form) {
      form.addEventListener('submit', function (event) { submitCreate(event, root); });
      var slotValue = form.querySelector('#booking-slot-value');
      var slotGrid = form.querySelector('#booking-slot-grid');
      var activateDate = function (date) {
        var group = slotGroups.find(function (item) { return item.date === date; });
        var first = group && group.times[0];
        form.querySelectorAll('[data-booking-date]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.bookingDate === date); });
        if (slotGrid) slotGrid.innerHTML = renderTimeGrid(group, first ? slotKey(first.slot) : '');
        if (slotValue) slotValue.value = first ? slotKey(first.slot) : '';
      };
      form.querySelectorAll('[data-booking-date]').forEach(function (button) { button.addEventListener('click', function () { activateDate(this.dataset.bookingDate); }); });
      if (slotGrid) slotGrid.addEventListener('click', function (event) {
        var button = event.target.closest('[data-slot-value]');
        if (!button) return;
        slotGrid.querySelectorAll('[data-slot-value]').forEach(function (item) { item.classList.remove('is-active'); });
        button.classList.add('is-active');
        if (slotValue) slotValue.value = button.dataset.slotValue;
      });
    }
    root.querySelectorAll('[data-booking-action]').forEach(function (button) { button.addEventListener('click', function () { transition(this.dataset.bookingAction, this.dataset.bookingId, root); }); });
  };
  var bookingList = function (bookings) { return bookings.length ? '<div class="booking-list">' + bookings.map(function (booking) { return '<article class="booking-card"><b>' + esc(booking.date + ' · ' + booking.time) + '</b><span>' + esc(booking.sale) + ' · ' + esc(booking.phone) + '</span><span class="booking-pill ' + esc(booking.status) + '">' + esc(booking.status) + '</span><a href="' + esc(booking.crmUrl) + '" target="_blank" rel="noopener">AmoCRM ↗</a></article>'; }).join('') + '</div>' : '<div class="booking-empty">Записей пока нет</div>'; };
  var confirmationCard = function (booking) { return '<article class="booking-card booking-card-pending"><b>' + esc(booking.date + ' · ' + booking.time) + '</b><span>' + esc(booking.sale) + ' · ' + esc(booking.phone) + ' · ' + esc(booking.age) + ' лет</span><a href="' + esc(booking.crmUrl) + '" target="_blank" rel="noopener">AmoCRM ↗</a><div class="booking-actions"><button data-booking-action="confirm" data-booking-id="' + esc(booking.bookingId) + '">Подтвердить</button><button data-booking-action="reject" data-booking-id="' + esc(booking.bookingId) + '">Отклонить</button></div></article>'; };
  var refresh = function (root) { var role = readRole(); var sale = ''; try { sale = localStorage.getItem('eks-me') || ''; } catch (_) {} request('?action=list&role=' + encodeURIComponent(role) + '&sale=' + encodeURIComponent(sale)).then(function (data) { render(root, { role: role, bookings: data.bookings || [] }); }).catch(function (error) { render(root, { role: role, bookings: [] }); var status = root.querySelector('#booking-form-status'); if (status) status.textContent = error.message + ' · проверь endpoint'; }); };
  var submitCreate = function (event, root) { event.preventDefault(); var form = event.currentTarget; var data = new FormData(form); var slot = String(data.get('slot')).split('|'); var button = form.querySelector('button[type="submit"]'); var status = form.querySelector('#booking-form-status'); button.disabled = true; status.textContent = 'Сохраняю заявку…'; request('', { method: 'POST', body: JSON.stringify({ action: 'create', date: slot[0], time: slot[1], sale: slot[2] || data.get('sale'), crmUrl: data.get('crmUrl'), age: data.get('age'), phone: data.get('phone'), idempotencyKey: 'cc-' + Date.now() }) }).then(function (result) { if (result.pending) { status.textContent = 'Запрос отправлен. Обновляю «Мои заявки»…'; setTimeout(function () { refresh(root); }, 1200); return; } status.textContent = 'Заявка ' + result.bookingId + ' создана и отправлена второй линии.'; form.reset(); refresh(root); }).catch(function (error) { status.textContent = error.message; }).finally(function () { button.disabled = false; }); };
  var transition = function (action, bookingId, root) { request('', { method: 'POST', body: JSON.stringify({ action: action, bookingId: bookingId }) }).then(function () { refresh(root); }).catch(function (error) { alert(error.message); }); };
  global.initBookingUI = function (root) { refresh(root); };
  global.refreshBookingUI = function () { var root = document.getElementById('booking-app'); if (root) refresh(root); };
})(window);
