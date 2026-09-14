/* Read-only availability totals and compact manager table rows. */
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

  function rowsHtml(rows, emptyMessage) {
    if (!rows || !rows.length) {
      return '<tr><td colspan="3" class="so-no-results">' +
        escapeHtml(emptyMessage == null ? 'Менеджеры не найдены' : emptyMessage) + '</td></tr>';
    }
    return rows.map(function (row) {
      var empty = row.total === 0;
      return '<tr class="so-row' + (empty ? ' so-empty' : '') + '">' +
        '<td class="so-name">' + escapeHtml(row.name) + '</td>' +
        '<td class="so-hours">' + (empty ? 'Нет часов' : escapeHtml(row.total) + ' ч') + '</td>' +
        '<td class="so-days">' + escapeHtml(row.activeDays) + ' из ' + escapeHtml(row.dayCount) + ' дней</td></tr>';
    }).join('');
  }

  return Object.freeze({ build: build, filter: filter, rowsHtml: rowsHtml });
});
