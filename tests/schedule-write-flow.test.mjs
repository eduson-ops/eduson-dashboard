import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const verifier = fs.readFileSync(new URL('../schedule-verification.js', import.meta.url), 'utf8');
const region = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const flow = region('async function submitSchedule(', '// Re-fetch')
  + region('async function verifyScheduleSubmit(', '// ═')
  + region('async function performUndo(', 'window.showUndoToast=');
const header = ['Менеджер', 'Дата', 'Время'];
const rows = (...items) => [header, ...items];
const before = rows(['A', '15.09.2026', '10:00']);
const after = rows(['A', '15.09.2026', '09:00']);
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ reads = [before, after], postError = null, postEffect = null, storage = new Map() } = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', textContent: '', disabled: false,
      classList: { add() {}, remove() {} }, scrollIntoView() {} });
    return elements.get(id);
  };
  const calls = { posts: [], audits: [], undos: [], renders: [], alerts: [] };
  const runtime = vm.createContext({
    console: { warn() {}, error() {}, log() {} }, Date, Math, Promise, AbortController,
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    document: { getElementById: getElement },
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    currentEditMgr: 'A', selectedSlots: { '15.09.2026': { 9: true } },
    scheduleData: { A: { '15.09.2026': { 10: true } } },
    WEB_APP_URL: 'https://example.invalid/no-live-post', dashboardLoadPromise: null,
    opsSourceStates: { schedule: { state: 'success' } }, __pendingUndo: null,
    esc: value => String(value), normDate: value => value, confirm: () => true,
    alert: value => calls.alerts.push(value),
    fetch: async (_url, options) => {
      calls.posts.push(JSON.parse(options.body));
      if (postEffect) postEffect(runtime);
      if (postError) throw new Error(postError);
      return { type: 'opaque' };
    },
    fetchCSV: async () => {
      const next = reads.length > 1 ? reads.shift() : reads[0];
      runtime.opsSourceStates.schedule.state = next?.error ? 'error' : 'success';
      return next?.error ? next.cached || [] : next;
    },
    renderSchedule: () => calls.renders.push(plain(runtime.scheduleData)),
    auditLogPush: entry => calls.audits.push(plain(entry)), auditLogGet: () => calls.audits,
    showUndoToast: (...args) => calls.undos.push(plain(args)), hideUndoToast() {},
  });
  runtime.window = runtime;
  vm.runInContext(verifier + flow, runtime);
  return { runtime, calls, elements, storage, reads };
}

test('a partial save stays unconfirmed and cannot post again on retry', async () => {
  const h = harness({ reads: [before, before] });
  await h.runtime.submitSchedule();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.audits.length, 0);
  assert.equal(h.calls.undos.length, 0);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 10: true } } });
  assert.ok(h.storage.get('eks-slots-backup-A'));
  await h.runtime.submitSchedule();
  assert.equal(h.calls.posts.length, 1, 'retry must read the pending attempt, never duplicate the POST');
  assert.equal(h.calls.audits.length, 0);
});

test('late confirmation on retry records success once without another POST', async () => {
  const h = harness({ reads: [before, before] });
  await h.runtime.submitSchedule();
  h.reads.splice(0, h.reads.length, after);
  await h.runtime.submitSchedule();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.audits.length, 1);
  assert.equal(h.calls.undos.length, 1);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 9: true } } });
  assert.equal(h.storage.get('eks-slots-backup-A'), undefined);
});

test('a network rejection still checks the source because the write may have arrived', async () => {
  const h = harness({ reads: [before, after], postError: 'connection reset' });
  await h.runtime.submitSchedule();
  assert.equal(h.calls.audits.length, 1);
  assert.equal(h.calls.undos.length, 1);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 9: true } } });
});

test('a failed fresh read never confirms matching cached rows', async () => {
  const h = harness({ reads: [{ error: true, cached: after }] });
  assert.equal(await h.runtime.verifyScheduleSubmit('A', [{ date: '15.09.2026', time: '09:00' }]), false);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 10: true } } });
});

test('clear requires no remaining rows for the manager across all dates', async () => {
  const h = harness({ reads: [before, rows(['A', '30.10.2026', '09:00'])] });
  h.runtime.selectedSlots = {};
  await h.runtime.submitSchedule();
  assert.equal(h.calls.audits.length, 0);
  h.reads.splice(0, h.reads.length, rows());
  await h.runtime.submitSchedule();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.audits.length, 1);
  assert.deepEqual(plain(h.runtime.scheduleData), {});
});

test('undo cannot claim success or mutate schedule on opaque POST alone', async () => {
  const h = harness({ reads: [after, after] });
  h.runtime.scheduleData = { A: { '15.09.2026': { 9: true } } };
  h.runtime.__pendingUndo = { manager: 'A', prev: { '15.09.2026': { 10: true } }, timer: 1 };
  await h.runtime.performUndo();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.audits.length, 0);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 9: true } } });
  await h.runtime.performUndo();
  assert.equal(h.calls.posts.length, 1);
  h.reads.splice(0, h.reads.length, before);
  await h.runtime.performUndo();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.audits.length, 1);
  assert.equal(h.calls.audits[0].type, 'schedule_undo');
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 10: true } } });
});

test('pending attempts survive reload and block a new manager write', async () => {
  const h = harness({ reads: [before, before] });
  await h.runtime.submitSchedule();
  const reloaded = harness({ reads: [before], storage: h.storage });
  reloaded.runtime.currentEditMgr = 'B';
  await reloaded.runtime.submitSchedule();
  assert.equal(reloaded.calls.posts.length, 0);
  assert.equal(reloaded.calls.audits.length, 0);
});

test('an in-flight click cannot start a second submit or undo', async () => {
  const h = harness();
  h.runtime.__submittingSchedule = true;
  h.runtime.__pendingUndo = { manager: 'A', prev: {}, timer: 1 };
  await h.runtime.submitSchedule();
  await h.runtime.performUndo();
  assert.equal(h.calls.posts.length, 0);
});

test('edits made during the request stay in the editor and survive confirmation in the draft cache', async () => {
  const h = harness({ postEffect(runtime) { runtime.selectedSlots['15.09.2026'][11] = true; } });
  await h.runtime.submitSchedule();
  assert.equal(h.calls.audits.length, 1);
  assert.deepEqual(plain(h.runtime.selectedSlots), { '15.09.2026': { 9: true, 11: true } });
  assert.deepEqual(JSON.parse(h.storage.get('eks-slots-backup-A')).slots,
    [{ date: '15.09.2026', time: '09:00' }, { date: '15.09.2026', time: '11:00' }]);
  assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 9: true } } });
});

test('edits made during an unconfirmed request also survive in the draft cache', async () => {
  const h = harness({ reads: [before, before], postEffect(runtime) { runtime.selectedSlots['15.09.2026'][11] = true; } });
  await h.runtime.submitSchedule();
  assert.equal(h.calls.audits.length, 0);
  assert.deepEqual(JSON.parse(h.storage.get('eks-slots-backup-A')).slots,
    [{ date: '15.09.2026', time: '09:00' }, { date: '15.09.2026', time: '11:00' }]);
  const savedAttempt = JSON.parse(h.storage.get('eks-schedule-pending-write'));
  assert.deepEqual(savedAttempt.slots, [{ date: '15.09.2026', time: '09:00' }]);
});

test('undo confirmation preserves an existing manager draft', async () => {
  const draft = JSON.stringify({ manager: 'A', slots: [{ date: '16.09.2026', time: '11:00' }] });
  const h = harness({ reads: [after, before], storage: new Map([['eks-slots-backup-A', draft]]) });
  h.runtime.__pendingUndo = { manager: 'A', prev: { '15.09.2026': { 10: true } }, timer: 1 };
  await h.runtime.performUndo();
  assert.equal(h.calls.audits.length, 1);
  assert.equal(h.storage.get('eks-slots-backup-A'), draft);
});

test('unavailable preflight blocks replacements, while a confirmed no-op needs no POST', async () => {
  const unavailable = harness({ reads: [{ error: true, cached: before }] });
  await unavailable.runtime.submitSchedule();
  assert.equal(unavailable.calls.posts.length, 0);
  assert.deepEqual(plain(unavailable.runtime.selectedSlots), { '15.09.2026': { 9: true } });
  const unchanged = harness({ reads: [after] });
  await unchanged.runtime.submitSchedule();
  assert.equal(unchanged.calls.posts.length, 0);
  assert.equal(unchanged.calls.audits.length, 0);
  assert.equal(unchanged.calls.undos.length, 0);
});

test('write confirmation rejects 80 percent, extra dates, and duplicate rows', async () => {
  const expected = [9, 10, 11, 12, 13].map(hour => ({ date: '15.09.2026', time: `${hour}:00` }));
  const actual = expected.map(slot => ['A', slot.date, slot.time]);
  for (const incomplete of [rows(...actual.slice(0, 4)), rows(...actual, ['A', '30.10.2026', '09:00']), rows(...actual, actual[0])]) {
    const h = harness({ reads: [incomplete] });
    assert.equal(await h.runtime.verifyScheduleSubmit('A', expected), false);
    assert.deepEqual(plain(h.runtime.scheduleData), { A: { '15.09.2026': { 10: true } } });
  }
  const h = harness({ reads: [rows(...actual, ['B', '30.10.2026', '15:00'])] });
  assert.equal(await h.runtime.verifyScheduleSubmit('A', expected), true);
  assert.deepEqual(plain(h.runtime.scheduleData.B), { '30.10.2026': { 15: true } });
});
