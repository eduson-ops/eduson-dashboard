/* Read-only availability totals and compact manager cards. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScheduleOverview = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function clean(value) { return value == null ? '' : String(value).trim(); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function build(managers, scheduleData, dateKeys) {
    var rows = [], seen = new Set(), totalHours = 0, emptyCount = 0;
    var dates = Array.isArray(dateKeys) ? dateKeys : [];
    var schedule = scheduleData || {};
    (Array.isArray(managers) ? managers : []).forEach(function (manager) {
      var name = clean(manager);
      // Match the dashboard's role rule: the first word is exactly МВП.
      if (!name || name.split(/\s+/)[0].toLowerCase() === 'мвп' || seen.has(name)) return;
      seen.add(name);
      var total = 0, activeDays = 0;
      var days = dates.map(function (date) {
        var hours = schedule[name] && schedule[name][date];
        var count = hours ? Object.keys(hours).reduce(function (sum, hour) {
          return sum + (hours[hour] ? 1 : 0);
        }, 0) : 0;
        total += count;
        if (count) activeDays++;
        return count;
      });
      rows.push({ name: name, total: total, days: days, activeDays: activeDays, dayCount: dates.length });
      totalHours += total;
      if (!total) emptyCount++;
    });
    return { rows: rows, totalHours: totalHours, emptyCount: emptyCount, managerCount: rows.length };
  }

  function filter(rows, options) {
    options = options || {};
    var query = clean(options.query).toLowerCase();
    return (rows || []).filter(function (row) {
      return (!query || row.name.toLowerCase().includes(query)) && (!options.emptyOnly || row.total === 0);
    });
  }

  function cardsHtml(rows, emptyMessage) {
    if (!rows || !rows.length) {
      return '<li class="so-no-results">' +
        escapeHtml(emptyMessage == null ? 'Менеджеры не найдены' : emptyMessage) + '</li>';
    }
    return rows.map(function (row) {
      var empty = row.total === 0, name = escapeHtml(row.name);
      return '<li class="so-card' + (empty ? ' so-empty' : '') + '">' +
        '<div class="so-name" title="' + name + '">' + name + '</div>' +
        '<div class="so-value"><strong class="so-hours">' + escapeHtml(row.total) + '</strong><span>ч</span></div>' +
        '<div class="so-days">' + (empty ? 'Нет открытых часов' :
          escapeHtml(row.activeDays) + ' из ' + escapeHtml(row.dayCount) + ' дней') + '</div></li>';
    }).join('');
  }

  return Object.freeze({ build: build, filter: filter, cardsHtml: cardsHtml });
});
