/* Read-only operational views. Deliberately independent of payment/KPI merging. */
(function (root) {
  'use strict';
  var clean = function (value) { return value == null ? '' : String(value).trim(); };
  var pad = function (value) { return String(value).padStart(2, '0'); };
  var moscowCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });

  function moscowDate(instant) {
    var date = new Date(instant), parts = {};
    if (isNaN(date.getTime())) return '';
    moscowCalendar.formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  function dateKey(value) {
    var text = clean(value), match, year, month, day;
    if ((match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/))) {
      year = +match[1]; month = +match[2]; day = +match[3];
    } else if ((match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:$|\s)/))) {
      year = +match[3]; month = +match[2]; day = +match[1];
    } else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s)/))) {
      year = +match[3]; month = +match[1]; day = +match[2];
    } else return '';
    var date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    // Offset-bearing ISO timestamps are instants; plain sheet dates already refer to Moscow.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return moscowDate(text);
    return year + '-' + pad(month) + '-' + pad(day);
  }

  function selectedDate(mode, custom, now) {
    if (mode === 'custom') return dateKey(custom);
    var key = moscowDate(now || new Date());
    if (!key || mode !== 'tomorrow') return key;
    var date = new Date(key + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function sourceRows(rawRows) {
    return (rawRows || []).slice(1).filter(function (row) {
      return Array.isArray(row) && row.some(function (cell) { return clean(cell); });
    });
  }

  function parseReports(rawRows, canonicalize) {
    var managerName = canonicalize || clean;
    return sourceRows(rawRows).map(function (row) {
      return {
        ts: clean(row[0]), manager: managerName(clean(row[1])), date: clean(row[2]), time: clean(row[3]),
        crm: clean(row[4]), rec: clean(row[5]), practice: clean(row[6]), age: clean(row[7]),
        pack: clean(row[8]), paymentVariant: clean(row[9]), agreement: clean(row[10]), objection: clean(row[11]),
        notes: clean(row[12]), channel: clean(row[13]),
        rev: 0, paid: false, paytype: '', scenario: 'no_pay'
      };
    });
  }

  function parseCancels(rawRows, canonicalize) {
    var managerName = canonicalize || clean;
    return sourceRows(rawRows).map(function (row) {
      return {
        ts: clean(row[0]), crm: clean(row[1]), reason: clean(row[2]), is_first: clean(row[3]),
        contact: clean(row[4]), age: clean(row[5]), comment: clean(row[6]), manager: managerName(clean(row[7]))
      };
    });
  }

  function matchManager(value, managers, aliases) {
    var names = managers || [], mapping = aliases || {};
    var rawManager = clean(value);
    var manager = Object.prototype.hasOwnProperty.call(mapping, rawManager) ? mapping[rawManager] : rawManager;
    var exact = names.find(function (name) { return clean(name).toLowerCase() === manager.toLowerCase(); });
    if (!exact) {
      // Accept a full name only when both the surname and first initial identify one manager.
      // Extra event-title text and multiple same-initial candidates stay unknown.
      function nameParts(name) {
        return clean(name).toLowerCase().replace(/\s+/g, ' ').match(/^([a-zа-яё]+(?:-[a-zа-яё]+)*) ([a-zа-яё][a-zа-яё.]*)$/i);
      }
      var rawParts = nameParts(manager);
      var candidates = rawParts ? Array.from(new Set(names.filter(function (name) {
        var parts = nameParts(name);
        return parts && parts[1] === rawParts[1] && parts[2][0] === rawParts[2][0];
      }))) : [];
      if (candidates.length === 1) exact = candidates[0];
    }
    return { manager: exact || manager, knownManager: !!exact };
  }

  function parseSlots(rawRows, managers, aliases) {
    var result = { rows: [], invalidDates: 0, invalidTimes: 0, unknownManagers: 0 };
    (rawRows || []).slice(1).forEach(function (row) {
      if (!row || !row.some(function (cell) { return clean(cell); })) return;
      var date = dateKey(row[0]);
      if (!date || row.length < 4) { result.invalidDates++; return; }
      var time = clean(row[1]).match(/^(\d{1,2}):(\d{2})$/);
      if (!time || +time[1] > 23 || +time[2] > 59) { result.invalidTimes++; return; }
      var matched = matchManager(row[2], managers, aliases);
      if (!matched.knownManager) result.unknownManagers++;
      result.rows.push({ date: date, time: pad(+time[1]) + ':' + time[2], manager: matched.manager || 'Не указан', knownManager: matched.knownManager });
    });
    return result;
  }

  function updateSource(previous, state, now, details) {
    var result = Object.assign({}, previous || {}, details || {}, { state: state, lastAttemptAt: now });
    if (state === 'success') { result.lastSuccessAt = now; result.message = ''; }
    if (state === 'loading') result.message = '';
    return result;
  }

  function buildView(options) {
    var input = options || {}, date = dateKey(input.date), manager = input.personalManager || input.manager || '';
    var states = input.sources || {};
    var loaded = function (key) { return !!date && states[key] && states[key].state === 'success'; };
    var belongs = function (row) { return !manager || row.manager === manager; };
    var allReports = (input.reports || []).filter(function (row) { return row.scenario !== 'pay_on_lesson'; });
    var allCancels = input.cancels || [];
    var reports = allReports.filter(belongs), cancels = allCancels.filter(belongs);
    var result = { date: date, slots: null, reports: null, cancels: null, incompleteCount: null, invalidReportDates: 0, invalidCancelDates: 0, missingReportManagers: 0, missingCancelManagers: 0 };
    if (loaded('slots')) {
      result.slots = (input.slots || []).filter(function (row) { return belongs(row) && dateKey(row.date) === date; })
        .slice().sort(function (a, b) { return a.time.localeCompare(b.time) || a.manager.localeCompare(b.manager, 'ru'); });
    }
    if (loaded('form')) {
      result.missingReportManagers = allReports.filter(function (row) { return !clean(row.manager); }).length;
      result.invalidReportDates = reports.filter(function (row) { return !dateKey(row.date); }).length;
      result.reports = reports.filter(function (row) { return dateKey(row.date) === date; }).map(function (row) {
        var missing = [];
        if (!clean(row.manager)) missing.push('Менеджер');
        if (!clean(row.crm)) missing.push('CRM');
        if (!clean(row.rec)) missing.push('Запись');
        if (!clean(row.agreement)) missing.push('Договорённость');
        return Object.assign({}, row, { missing: missing });
      }).sort(function (a, b) { return b.missing.length - a.missing.length || clean(a.time).localeCompare(clean(b.time)); });
      result.incompleteCount = result.reports.filter(function (row) { return row.missing.length; }).length;
    }
    if (loaded('cancels')) {
      result.missingCancelManagers = allCancels.filter(function (row) { return !clean(row.manager); }).length;
      result.invalidCancelDates = cancels.filter(function (row) { return !dateKey(row.ts); }).length;
      result.cancels = cancels.filter(function (row) { return dateKey(row.ts) === date; });
    }
    return result;
  }

  root.OpsControl = Object.freeze({ dateKey: dateKey, selectedDate: selectedDate, matchManager: matchManager, parseSlots: parseSlots, parseReports: parseReports, parseCancels: parseCancels, updateSource: updateSource, buildView: buildView });
})(typeof globalThis === 'object' ? globalThis : this);
