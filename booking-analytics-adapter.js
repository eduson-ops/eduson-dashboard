/* Loaded before the legacy dashboard: bridge only its two booking CSV sources. */
(function () {
  'use strict';
  var nativeFetch = window.fetch.bind(window);
  var sheetPath = '/spreadsheets/d/1U5L4zrFcqPAy4_6VXA5xHxqM2xAKPkWW-At2neINj18/gviz/tq';
  var cache = null, pending = null, generation = 0;
  var legacy = Object.create(null), problems = Object.create(null);
  var events = null, lastRevision = null, reloadTimer = null, reloading = false, reloadAgain = false;

  function renderStatus() {
    if (!document.body) return;
    var node = document.getElementById('booking-analytics-status');
    var messages = Object.keys(problems).map(function (key) { return problems[key]; });
    if (!node && !messages.length) return;
    if (!node) {
      node = document.createElement('div');
      node.id = 'booking-analytics-status';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:10000;padding:12px 16px;background:#382c14;color:#fff3ce;border:1px solid #a78741;border-radius:8px;font:14px/1.45 sans-serif;';
      document.body.appendChild(node);
    }
    node.textContent = messages.join(' ');
    node.hidden = !messages.length;
  }
  function problem(key, message) {
    if (message) problems[key] = message;
    else delete problems[key];
    renderStatus();
  }

  function csvKind(input, init) {
    try {
      var method = String(init && init.method || input && input.method || 'GET').toUpperCase();
      if (method !== 'GET') return null;
      var url = new URL(typeof input === 'string' ? input : input.url || String(input), window.location.href);
      if (url.origin !== 'https://docs.google.com' || url.pathname !== sheetPath || url.searchParams.get('tqx') !== 'out:csv') return null;
      if (url.searchParams.get('gid') === '1621541455') return 'form';
      if (url.searchParams.get('gid') === '901678043') return 'cancels';
    } catch (_) { /* Other fetch inputs keep the browser's normal behavior. */ }
    return null;
  }

  // RFC4180, including embedded newlines and quotes. Never split CSV by lines.
  function parseCsv(text) {
    var rows = [], row = [], cell = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (value) { return value !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    if (quoted) throw new Error('Invalid CSV');
    if (cell !== '' || row.length) {
      row.push(cell);
      if (row.some(function (value) { return value !== ''; })) rows.push(row);
    }
    return rows;
  }
  function serializeCsv(rows) {
    return rows.map(function (row) {
      return row.map(function (value) { return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
  }
  function lessonRow(report) {
    return [report.timestamp, report.teacher, report.date, report.time, report.crmUrl, report.recordingUrl,
      report.practice, report.age, report.package, report.paymentMethod, report.agreement, report.objection,
      report.channel, report.amountNet, report.bookingId];
  }
  function cancelRow(cancel) {
    var archived = cancel.cancellation || {};
    var first = archived.firstCancellation == null ? '' : archived.firstCancellation ? 'Да' : 'Нет';
    // Match the Sheets projection: cancellation facts belong to their saved actor.
    // The current assigned teacher is only a fallback for older API records.
    return [archived.timestamp ?? cancel.cancelledAt ?? cancel.updatedAt, cancel.crmUrl,
      archived.reason ?? cancel.reason ?? cancel.cancelReason, first, archived.contactMethod,
      cancel.age, archived.comment ?? cancel.comment, archived.manager ?? cancel.manager ?? cancel.teacher,
      cancel.bookingId, 'cancelled'];
  }
  function validSnapshot(value) {
    if (!value || !Array.isArray(value.lessons) || !Array.isArray(value.cancellations) || !Array.isArray(value.managedBookingIds)) return false;
    if (!value.managedBookingIds.every(function (id) { return typeof id === 'string' && id.trim() !== ''; })) return false;
    var ids = new Set(value.managedBookingIds);
    return [value.lessons, value.cancellations].every(function (list) {
      var seen = new Set();
      return list.every(function (record) {
        if (!record || typeof record.bookingId !== 'string' || !ids.has(record.bookingId) || seen.has(record.bookingId)) return false;
        seen.add(record.bookingId);
        return true;
      });
    });
  }
  function stopEvents() {
    if (events) events.close();
    events = null;
    lastRevision = null;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  function scheduleReload() {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async function () {
      reloadTimer = null;
      if (reloading) { reloadAgain = true; return; }
      if (typeof window.loadAll !== 'function') return;
      reloading = true;
      try { await window.loadAll(); }
      catch (_) { problem('refresh', 'Не удалось обновить аналитику. Обновите страницу.'); }
      finally {
        reloading = false;
        if (reloadAgain) { reloadAgain = false; scheduleReload(); }
      }
    }, 250);
  }
  function startEvents() {
    if (events || typeof window.EventSource !== 'function') return;
    events = new window.EventSource('/api/events');
    events.addEventListener('changed', function (event) {
      var revision;
      try { revision = JSON.parse(event.data).revision; } catch (_) { return; }
      if (!Number.isInteger(revision) || revision < 0 || revision === lastRevision) return;
      lastRevision = revision;
      // The first revision also closes the gap between snapshot read and subscription.
      // Reconnects with an unchanged revision do not trigger another refresh.
      generation++;
      cache = null;
      scheduleReload();
    });
  }
  async function snapshot() {
    if (cache && cache.expires > Date.now()) return cache.value;
    if (pending && pending.generation === generation) return pending.promise;
    var requestGeneration = generation;
    var request = { generation: requestGeneration, promise: null };
    request.promise = (async function () {
      var value = null;
      try {
        var response = await nativeFetch('/api/analytics/snapshot', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (response.status === 401 || response.status === 403) {
          stopEvents();
          problem('api', null);
        } else {
          if (!response.ok) throw new Error('Analytics unavailable');
          value = await response.json();
          if (!validSnapshot(value)) throw new Error('Invalid analytics snapshot');
          problem('api', null);
          startEvents();
        }
      } catch (_) {
        value = null;
        problem('api', 'Данные нового букинга недоступны. Показаны только данные Google Sheets. Обновите страницу или повторите позже.');
      }
      if (requestGeneration !== generation) return snapshot();
      cache = { expires: Date.now() + 5000, value: value };
      return value;
    })();
    pending = request;
    try { return await request.promise; }
    finally { if (pending === request) pending = null; }
  }
  function mergedResponse(source, text, value, kind) {
    var rows = parseCsv(text), idColumn = kind === 'form' ? 14 : 8;
    var ids = new Set(value.managedBookingIds);
    var result = [rows[0].slice()];
    result[0][idColumn] = result[0][idColumn] || 'Booking ID';
    if (kind === 'cancels') result[0][9] = result[0][9] || 'Booking status';
    rows.slice(1).forEach(function (row) {
      var id = String(row[idColumn] || '').trim();
      if (!id || !ids.has(id)) result.push(row);
    });
    (kind === 'form' ? value.lessons : value.cancellations).forEach(function (record) {
      result.push(kind === 'form' ? lessonRow(record) : cancelRow(record));
    });
    var headers = new Headers(source.headers);
    // A replacement body no longer has the upstream wire encoding or byte length.
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(serializeCsv(result), { status: source.status, statusText: source.statusText, headers: headers });
  }

  window.fetch = async function (input, init) {
    var kind = csvKind(input, init);
    if (!kind) return nativeFetch(input, init);
    var response, text;
    try {
      response = await nativeFetch(input, init);
      if (!response.ok) throw new Error('Google Sheets unavailable');
      text = await response.clone().text();
      var rows = parseCsv(text);
      if (!rows.length || rows[0].length < (kind === 'form' ? 14 : 8) || /<!doctype|<html|google\.visualization\.Query\.setResponse/i.test(text)) throw new Error('Google Sheets did not return CSV');
      legacy[kind] = { response: response.clone(), text: text };
      problem(kind, null);
    } catch (error) {
      problem(kind, 'Google Sheets: не удалось обновить ' + (kind === 'form' ? 'отчёты о занятиях.' : 'отмены.') + (legacy[kind] ? ' Показаны последние доступные данные таблицы.' : ' История таблицы недоступна.'));
      if (!legacy[kind]) {
        if (response && !response.ok) return response;
        if (response) return new Response('Google Sheets did not return valid CSV', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        throw error;
      }
      response = legacy[kind].response.clone();
      text = legacy[kind].text;
    }
    var value = await snapshot();
    if (!value) return response;
    return mergedResponse(response, text, value, kind);
  };

  function patchNavigation() {
    if (typeof window.showPage === 'function' && !window.showPage.bookingBridge) {
      var original = window.showPage;
      window.showPage = function (id) {
        if (id === 'booking') return window.location.assign('/');
        return original.apply(this, arguments);
      };
      window.showPage.bookingBridge = true;
    }
    if (window.location.hash === '#booking') window.location.assign('/');
    renderStatus();
  }
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest && event.target.closest('[data-page="booking"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign('/');
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', patchNavigation);
  else patchNavigation();
  window.addEventListener('pagehide', stopEvents);
})();
