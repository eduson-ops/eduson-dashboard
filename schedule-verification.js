/* Exact, read-only verification of a manager's replacement schedule. */
(function (root) {
  'use strict';

  function text(value) { return value == null ? '' : String(value).trim(); }
  function dateKey(value) {
    var str = text(value), match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      var local = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!local) return null;
      match = [str, local[3], local[2], local[1]];
    }
    var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (year < 1900 || year > 9999) return null;
    var date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return String(year) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  function hourKey(value) {
    var match = text(value).match(/^(\d{1,2}):00(?::00)?$/);
    return match && Number(match[1]) < 24 ? Number(match[1]) : null;
  }
  function parseRows(rows) {
    var records = [], invalidRows = [], schedule = Object.create(null);
    var header = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
    if (header.length < 3 || text(header[0]).toLowerCase() !== 'менеджер' || text(header[1]).toLowerCase() !== 'дата' || text(header[2]).toLowerCase() !== 'время') {
      return { ok: false, records: records, invalidRows: [0], schedule: schedule };
    }
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (Array.isArray(row) && row.every(function (cell) { return !text(cell); })) continue;
      var manager = Array.isArray(row) ? text(row[0]) : '';
      var date = Array.isArray(row) ? dateKey(row[1]) : null;
      var hour = Array.isArray(row) ? hourKey(row[2]) : null;
      if (!manager || !date || hour === null) { invalidRows.push(i); continue; }
      records.push({ manager: manager, date: date, hour: hour });
      var displayDate = date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
      if (!schedule[manager]) schedule[manager] = Object.create(null);
      if (!schedule[manager][displayDate]) schedule[manager][displayDate] = Object.create(null);
      schedule[manager][displayDate][hour] = true;
    }
    return { ok: invalidRows.length === 0, records: records, invalidRows: invalidRows, schedule: schedule };
  }

  function verify(options) {
    options = options || {};
    var result = { ok: false, reason: '', missing: [], extra: [], duplicates: [], invalidRows: [], schedule: null };
    if (options.sourceState !== 'success') { result.reason = 'unavailable'; return result; }
    var manager = text(options.manager), range = options.range;
    var from = range ? dateKey(range.from) : null, to = range ? dateKey(range.to) : null;
    var inside = function (date) { return !range || (date >= from && date <= to); };
    if (!manager || !Array.isArray(options.expected) || (range && (!from || !to || from > to))) {
      result.reason = 'invalid-expected'; return result;
    }
    var expected = new Set();
    for (var i = 0; i < options.expected.length; i++) {
      var slot = options.expected[i] || {}, date = dateKey(slot.date), hour = hourKey(slot.time);
      var key = date + '|' + hour;
      if (!date || hour === null || !inside(date) || expected.has(key)) { result.reason = 'invalid-expected'; return result; }
      expected.add(key);
    }
    var parsed = parseRows(options.rows);
    if (!parsed.ok) { result.reason = 'invalid-source'; result.invalidRows = parsed.invalidRows; return result; }
    var actual = new Set(), duplicateKeys = new Set();
    parsed.records.forEach(function (record) {
      if (record.manager !== manager || !inside(record.date)) return;
      var key = record.date + '|' + record.hour;
      if (actual.has(key)) duplicateKeys.add(key);
      actual.add(key);
    });
    expected.forEach(function (key) { if (!actual.has(key)) result.missing.push(key); });
    actual.forEach(function (key) { if (!expected.has(key)) result.extra.push(key); });
    result.missing.sort(); result.extra.sort(); result.duplicates = Array.from(duplicateKeys).sort();
    result.ok = !result.missing.length && !result.extra.length && !result.duplicates.length;
    result.reason = result.ok ? 'confirmed' : 'mismatch';
    // Callers can inspect a parsed mismatch, but must commit it only after their own policy check.
    result.schedule = parsed.schedule;
    return result;
  }

  root.ScheduleVerification = Object.freeze({ verify: verify, parseRows: parseRows });
})(typeof globalThis !== 'undefined' ? globalThis : this);
