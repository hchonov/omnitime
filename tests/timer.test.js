// The running timer (timer.js): booking rules, the storage-backed controller
// (shared between tabs), and its UI in the modal header, the "This issue" tab
// and the stop confirms.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, settle, makeEvent, key } = require('./helpers');

const CTX = { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Fix login' };
const ISSUE = { source: CTX.source, project_id: '3', issue_id: '14', label: '#14 Fix login' };
const OTHER = { source: CTX.source, project_id: '3', issue_id: '99', label: '#99 Other thing' };

// A chrome.storage.local stand-in that fires onChanged like the browser does
// (to every listener, i.e. every "tab" sharing this hub).
function makeStorage(initial = {}) {
  const data = { ...initial };
  const events = makeEvent();
  const fire = (changes) => events.fire(changes, 'local');
  return {
    data, events,
    local: {
      get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]))),
      set: (obj, cb) => {
        const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: data[k], newValue: v }]));
        Object.assign(data, obj);
        fire(changes);
        if (cb) cb();
      },
      remove: (k, cb) => {
        const changes = { [k]: { oldValue: data[k] } };
        delete data[k];
        fire(changes);
        if (cb) cb();
      },
    },
  };
}

// An API double that records creates/removes and can be told to fail.
function fakeApi({ failCreateAt = null, issueOpen = true } = {}) {
  const calls = [];
  let nextId = 700;
  let creates = 0;
  return {
    calls,
    issueTime: () => Promise.resolve({
      tracked_time: [], total_sum: 0, details: [], issue: { open: issueOpen, external_id: CTX.issue_id, title: 'Fix login' },
    }),
    myDay: (date) => Promise.resolve({
      date, week: [{ label: 'M', date, total_minutes: 0, total_label: '0:00', active: true }],
      day_total_minutes: 90, day_total_label: '1:30', entries: [],
    }),
    frequent: () => Promise.resolve({ issues: [] }),
    search: () => Promise.resolve({ issues: [] }),
    create: (payload) => {
      calls.push(['create', payload]);
      if (failCreateAt !== null && creates++ === failCreateAt) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
      return Promise.resolve({ id: nextId++ });
    },
    update: () => Promise.resolve({}),
    remove: (id) => { calls.push(['remove', id]); return Promise.resolve(null); },
  };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const stored = (startedAt, issue = ISSUE, comment = '') => ({ startedAt, issue, comment });

describe('booking rules (planBooking)', () => {
  const { window } = loadDom(['timer.js']);
  const T = window.OmniTimeTimer;
  const at = (h, m, s = 0, day = 22) => new window.Date(2026, 9, day, h, m, s);
  const timer = (start) => ({ startedAt: start.toISOString(), issue: ISSUE, comment: '' });
  const plan = (start, end) => T.planBooking(timer(start), end);
  const flat = (p) => JSON.parse(JSON.stringify(p.chunks));

  it('rounds the start and the duration to 5 minutes', () => {
    const p = plan(at(10, 3), at(10, 50)); // 47 min
    assert.equal(p.duration, 45);
    assert.deepEqual(flat(p), [{ date: '2026-10-22', start_time: '10:05', duration: 45 }]);
    assert.equal(plan(at(10, 2), at(10, 52)).chunks[0].start_time, '10:00');
    assert.equal(plan(at(10, 0), at(10, 53)).duration, 55);
  });

  it('books at least 5 minutes and discards under 2.5', () => {
    assert.equal(plan(at(10, 0), at(10, 3)).duration, 5);
    assert.equal(plan(at(10, 0, 0), at(10, 2, 30)).duration, 5);
    assert.equal(plan(at(10, 0, 0), at(10, 2, 29)).discard, true);
    assert.equal(plan(at(10, 0), at(10, 0)).discard, true);
    assert.equal(plan(at(10, 0), at(9, 0)).discard, true); // end before start
  });

  it('splits at 240 minutes', () => {
    const p = plan(at(8, 0), at(14, 0)); // 6 h
    assert.deepEqual(flat(p), [
      { date: '2026-10-22', start_time: '08:00', duration: 240 },
      { date: '2026-10-22', start_time: '12:00', duration: 120 },
    ]);
    assert.equal(plan(at(8, 0), at(12, 0)).chunks.length, 1); // exactly 4 h: one entry
    assert.equal(plan(at(8, 0), at(12, 5)).chunks.length, 2);
  });

  it('splits at midnight, each chunk on its own date', () => {
    const p = plan(at(23, 0), at(1, 0, 0, 23)); // 2 h across midnight
    assert.deepEqual(flat(p), [
      { date: '2026-10-22', start_time: '23:00', duration: 60 },
      { date: '2026-10-23', start_time: '00:00', duration: 60 },
    ]);
  });

  it('combines midnight and the 240-minute limit', () => {
    const p = plan(at(21, 0), at(5, 0, 0, 23)); // 8 h
    assert.deepEqual(flat(p).map((c) => [c.date, c.start_time, c.duration]), [
      ['2026-10-22', '21:00', 180], ['2026-10-23', '00:00', 240], ['2026-10-23', '04:00', 60],
    ]);
    assert.equal(p.chunks.reduce((s, c) => s + c.duration, 0), p.duration);
  });

  it('rounds a start just before midnight into the next day', () => {
    const p = plan(at(23, 58), at(0, 30, 0, 23));
    assert.equal(p.chunks[0].date, '2026-10-23');
    assert.equal(p.chunks[0].start_time, '00:00');
    assert.equal(p.chunks.length, 1);
  });

  it('builds the form/widget payload: external ids, else the internal id; comment only when set', () => {
    const c = { date: '2026-10-22', start_time: '10:05', duration: 45 };
    assert.deepEqual({ ...T.chunkPayload(timer(at(10, 0)), c) }, {
      date: '2026-10-22', start_time: '10:05', duration: 45, source: CTX.source, project_id: '3', issue_id: '14',
    });
    const byId = { startedAt: at(10, 0).toISOString(), issue: { issue_internal_id: 1004, label: 'x' }, comment: 'pairing' };
    assert.deepEqual({ ...T.chunkPayload(byId, c) }, { date: '2026-10-22', start_time: '10:05', duration: 45, issue_internal_id: 1004, comment: 'pairing' });
  });

  it('formats the elapsed time without running ahead', () => {
    assert.equal(T.formatElapsed(0), '0:00');
    assert.equal(T.formatElapsed(42.9), '0:42');
    assert.equal(T.formatElapsed(125), '2:05');
  });

  it('labels an issue "#14 Fix login", also from a GitLab title that carries the number', () => {
    assert.equal(T.issueLabel('14', 'Fix login'), '#14 Fix login');
    assert.equal(T.issueLabel('14', 'Fix login (#14)'), '#14 Fix login');
    assert.equal(T.issueLabel('14', ''), '#14');
  });

  it('treats corrupt storage values as no timer', () => {
    assert.equal(T.normalize(null), null);
    assert.equal(T.normalize({ startedAt: 'soon', issue: ISSUE }), null);
    assert.equal(T.normalize({ startedAt: new Date().toISOString(), issue: { label: 'no ids' } }), null);
    assert.equal(T.normalize({ startedAt: new Date().toISOString(), issue: { issue_internal_id: 5, label: 'ok' } }).issue.label, 'ok');
  });
});

describe('forgotten timers (10 h guard)', () => {
  const { window } = loadDom(['timer.js']);
  const T = window.OmniTimeTimer;
  const at = (h, m, day = 22) => new window.Date(2026, 9, day, h, m);
  const timer = (start) => ({ startedAt: start.toISOString(), issue: ISSUE, comment: '' });

  it('is stale after 10 hours, not before', () => {
    assert.equal(T.isStale(timer(at(8, 0)), at(18, 0)), false);
    assert.equal(T.isStale(timer(at(8, 0)), at(18, 1)), true);
  });

  it('defaults the end to startedAt + 1 h', () => {
    assert.equal(T.defaultEndTime(timer(at(9, 30))), '10:30');
  });

  it('resolves a typed end time to the first such time after the start', () => {
    const t = timer(at(9, 0, 20));
    const now = at(12, 0, 22);
    assert.equal(T.resolveEnd(t, '17:30', now).end.getTime(), at(17, 30, 20).getTime());
    assert.equal(T.resolveEnd(timer(at(22, 0, 20)), '01:00', now).end.getTime(), at(1, 0, 21).getTime()); // past midnight
  });

  it('rejects malformed and future end times', () => {
    const t = timer(at(9, 0, 21));
    assert.equal(T.resolveEnd(t, 'soon', at(12, 0, 22)).error, 'invalid');
    assert.equal(T.resolveEnd(t, '25:00', at(12, 0, 22)).error, 'invalid');
    assert.equal(T.resolveEnd(timer(at(9, 0, 22)), '17:00', at(12, 0, 22)).error, 'future');
  });
});

describe('controller: storage and sync between tabs', () => {
  const { window } = loadDom(['timer.js']);
  const T = window.OmniTimeTimer;
  const make = (store, now) => T.createController({ storage: store.local, events: store.events, now });

  it('persists the timer and a second instance (another tab) sees it', async () => {
    const store = makeStorage();
    const a = make(store);
    const b = make(store);
    const seen = [];
    b.subscribe((t) => seen.push(t && t.issue.label));
    await a.start(ISSUE);
    assert.equal(store.data.omnitimeTimer.issue.label, '#14 Fix login');
    assert.deepEqual(seen, ['#14 Fix login']);
    assert.equal(b.current().issue.issue_id, '14');
    await a.discard();
    assert.deepEqual(seen, ['#14 Fix login', null]);
    assert.equal('omnitimeTimer' in store.data, false);
  });

  it('a fresh instance loads a timer from an earlier session', async () => {
    const store = makeStorage({ omnitimeTimer: stored('2026-10-22T07:00:00.000Z') });
    assert.equal((await make(store).load()).issue.label, '#14 Fix login');
  });

  it('listens to storage only while someone subscribed', () => {
    const store = makeStorage();
    const c = make(store);
    assert.equal(store.events.listeners.size, 0);
    const off = c.subscribe(() => {});
    assert.equal(store.events.listeners.size, 1);
    off();
    assert.equal(store.events.listeners.size, 0);
  });

  it('refuses to start while another timer runs', async () => {
    const store = makeStorage();
    const c = make(store);
    await c.start(ISSUE);
    await assert.rejects(c.start(OTHER), (e) => e.code === 'timer-running' && e.timer.issue.issue_id === '14');
    assert.equal(store.data.omnitimeTimer.issue.issue_id, '14');
  });

  it('rejects an issue it cannot book against', async () => {
    const c = make(makeStorage());
    await assert.rejects(c.start({ label: 'nothing' }), (e) => e.code === 'bad-issue');
  });
});

describe('controller: stop, undo and errors', () => {
  const { window } = loadDom(['timer.js']);
  const T = window.OmniTimeTimer;
  const make = (store, now) => T.createController({ storage: store.local, events: store.events, now });
  const at = (h, m, day = 22) => new window.Date(2026, 9, day, h, m);

  it('books the rounded entry, clears the timer and returns what Undo needs', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(10, 3).toISOString(), ISSUE, 'pairing') });
    const api = fakeApi();
    const c = make(store, () => at(10, 50));
    const result = await c.stop(api, {});
    assert.deepEqual(api.calls.map(([, p]) => ({ ...p })), [{
      date: '2026-10-22', start_time: '10:05', duration: 45, source: CTX.source, project_id: '3', issue_id: '14', comment: 'pairing',
    }]);
    assert.equal(store.data.omnitimeTimer, undefined);
    assert.equal(c.current(), null);
    assert.deepEqual([...result.ids], [700]);
    assert.equal(result.minutes, 45);
  });

  it('posts one entry per chunk in order', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(21, 0).toISOString()) });
    const api = fakeApi();
    const result = await make(store, () => at(5, 0, 23)).stop(api, {});
    assert.deepEqual(api.calls.map(([, p]) => [p.date, p.start_time, p.duration]), [
      ['2026-10-22', '21:00', 180], ['2026-10-23', '00:00', 240], ['2026-10-23', '04:00', 60],
    ]);
    assert.deepEqual([...result.ids], [700, 701, 702]);
  });

  it('Undo deletes the created entries and starts the timer again with its original start', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(10, 0).toISOString()) });
    const api = fakeApi();
    const c = make(store, () => at(11, 0));
    const result = await c.stop(api, {});
    assert.equal(c.current(), null);
    await c.undo(api, result);
    assert.deepEqual(api.calls.filter(([m]) => m === 'remove'), [['remove', 700]]);
    assert.equal(store.data.omnitimeTimer.startedAt, at(10, 0).toISOString());
    assert.equal(c.current().issue.issue_id, '14');
  });

  it('Undo refuses when another timer started meanwhile (it would be lost)', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(10, 0).toISOString()) });
    const api = fakeApi();
    const c = make(store, () => at(11, 0));
    const result = await c.stop(api, {});
    await c.start(OTHER);
    await assert.rejects(c.undo(api, result), (e) => e.code === 'timer-running');
    assert.equal(api.calls.filter(([m]) => m === 'remove').length, 0);
    assert.equal(store.data.omnitimeTimer.issue.issue_id, '99');
  });

  it('an API error keeps the timer (and takes back chunks already booked)', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(21, 0).toISOString()) });
    const api = fakeApi({ failCreateAt: 1 });
    const c = make(store, () => at(5, 0, 23));
    await assert.rejects(c.stop(api, {}), (e) => e.status === 500);
    assert.equal(store.data.omnitimeTimer.startedAt, at(21, 0).toISOString());
    assert.equal(c.current().issue.issue_id, '14');
    assert.deepEqual(api.calls.filter(([m]) => m === 'remove'), [['remove', 700]]);
    // A retry is possible afterwards.
    const ok = fakeApi();
    await c.stop(ok, {});
    assert.equal(c.current(), null);
  });

  it('refuses to book under 2.5 minutes ("too-short") without touching the API', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(10, 0).toISOString()) });
    const api = fakeApi();
    await assert.rejects(make(store, () => at(10, 2)).stop(api, {}), (e) => e.code === 'too-short');
    assert.equal(api.calls.length, 0);
    assert.ok(store.data.omnitimeTimer);
  });

  it('asks for the real end after 10 hours, then books up to it', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(8, 0, 20).toISOString()) });
    const api = fakeApi();
    const c = make(store, () => at(12, 0, 22));
    await assert.rejects(c.stop(api, {}), (e) => e.code === 'needs-end');
    assert.equal(api.calls.length, 0);
    const result = await c.stop(api, { end: at(9, 0, 20) });
    assert.equal(result.minutes, 60);
    assert.deepEqual(api.calls.map(([, p]) => [p.date, p.start_time, p.duration]), [['2026-10-20', '08:00', 60]]);
  });

  it('rejects with "no-timer" when it was stopped elsewhere', async () => {
    await assert.rejects(make(makeStorage()).stop(fakeApi(), {}), (e) => e.code === 'no-timer');
  });

  it('does not book twice when stopped twice at once', async () => {
    const store = makeStorage({ omnitimeTimer: stored(at(10, 0).toISOString()) });
    const api = fakeApi();
    const c = make(store, () => at(11, 0));
    const [r1, r2] = await Promise.allSettled([c.stop(api, {}), c.stop(api, {})]);
    assert.equal(r1.status, 'fulfilled');
    assert.equal(r2.status, 'rejected');
    assert.equal(api.calls.filter(([m]) => m === 'create').length, 1);
  });
});

// --- The UI ---
async function open({ store = makeStorage(), api = fakeApi(), context = CTX, tab, totals } = {}) {
  const sent = [];
  const chrome = {
    storage: { local: store.local, onChanged: store.events },
    runtime: { sendMessage: (m, cb) => { sent.push(m); if (cb) cb({ success: true, notModified: true }); } },
  };
  const env = loadDom(['ical-parser.js', 'timer.js', 'core.js'], { chrome });
  const modal = env.window.OmniTime.openModal({
    apiClient: api, context: { ...context }, activeTab: tab, settings: { dayStart: 8, dayEnd: 17 },
    onDayTotal: totals || ((date, total) => sent.push({ date, total })),
  });
  await settle(40);
  return { ...env, root: uiRoot(env.document), api, store, modal, sent };
}
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
const slotOf = (root) => root.querySelector('.omnitime-header-timer');
const toastText = (root) => (root.querySelector('.omnitime-toast') || { textContent: '' }).textContent;

describe('header pill', () => {
  it('is hidden without a timer and shows "time, issue, Stop" while one runs', async () => {
    const t = await open();
    assert.equal(slotOf(t.root).hidden, true);
    t.store.local.set({ omnitimeTimer: stored(minutesAgo(42)) });
    await settle();
    assert.equal(slotOf(t.root).hidden, false);
    assert.equal(t.root.querySelector('.omnitime-timerpill__time').textContent, '0:42');
    assert.equal(t.root.querySelector('.omnitime-timerpill__issue').textContent, '#14 Fix login');
    assert.equal(t.root.querySelector('.omnitime-timerpill__stop').textContent, 'Stop');
  });

  it('shows a timer that was already running when the modal opened', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(5)) }) });
    assert.equal(slotOf(t.root).hidden, false);
    assert.equal(t.root.querySelector('.omnitime-timerpill__time').textContent, '0:05');
  });

  it('follows the timer when another tab starts or stops it', async () => {
    const t = await open();
    t.store.events.fire({ omnitimeTimer: { newValue: stored(minutesAgo(3)) } }, 'local');
    assert.equal(slotOf(t.root).hidden, false);
    t.store.events.fire({ omnitimeTimer: { oldValue: stored(minutesAgo(3)) } }, 'local');
    assert.equal(slotOf(t.root).hidden, true);
  });

  it('is keyboard reachable: Stop is a button in the tab order with a descriptive name', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(42)) }) });
    const stop = t.root.querySelector('.omnitime-timerpill__stop');
    assert.equal(stop.tagName, 'BUTTON');
    assert.ok(stop.tabIndex >= 0);
    assert.equal(stop.getAttribute('aria-label'), 'Stop timer, running 0:42 on #14 Fix login');
    assert.equal(t.root.querySelector('.omnitime-timerpill').getAttribute('role'), 'group');
  });

  it('is cleaned up on close: no storage listeners left, no pill', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(5)) }) });
    assert.ok(t.store.events.listeners.size > 0);
    t.modal.cleanup();
    assert.equal(t.store.events.listeners.size, 0);
    assert.equal(t.document.querySelector('omnitime-root'), null);
  });

  it('works in the toolbar overlay without an issue context', async () => {
    const t = await open({ context: {}, store: makeStorage({ omnitimeTimer: stored(minutesAgo(5)) }) });
    assert.equal(slotOf(t.root).hidden, false);
  });
});

describe('Stop', () => {
  it('books an entry for the issue, clears the timer, reports the day total and offers Undo', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(47)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle(60);
    const creates = t.api.calls.filter(([m]) => m === 'create').map(([, p]) => p);
    assert.equal(creates.length >= 1, true);
    assert.equal(creates.reduce((s, p) => s + p.duration, 0), 45);
    assert.equal(creates[0].issue_id, '14');
    assert.equal(t.store.data.omnitimeTimer, undefined);
    assert.equal(slotOf(t.root).hidden, true);
    assert.match(toastText(t.root), /Booked 0:45/);
    assert.match(toastText(t.root), /Undo/);
    assert.deepEqual(t.sent.filter((m) => m.total !== undefined).map((m) => m.total), [90]);
  });

  it('Undo removes the entries and the timer runs again', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(47)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle(60);
    click(t.root.querySelector('.omnitime-toast__action'));
    await settle(60);
    assert.ok(t.api.calls.some(([m, id]) => m === 'remove' && id === 700));
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '14');
    assert.equal(slotOf(t.root).hidden, false);
    assert.match(toastText(t.root), /running again/);
  });

  it('under 2.5 minutes offers Discard instead of booking', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(1)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle();
    const panel = t.root.querySelector('.omnitime-timerpanel');
    assert.match(panel.textContent, /too short/i);
    assert.equal(t.api.calls.length, 0);
    const discard = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Discard');
    click(discard);
    await settle();
    assert.equal(t.store.data.omnitimeTimer, undefined);
    assert.equal(t.api.calls.length, 0);
    assert.equal(slotOf(t.root).hidden, true);
  });

  it('"Keep running" closes the panel and leaves the timer', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(1)) }) });
    const stop = t.root.querySelector('.omnitime-timerpill__stop');
    click(stop);
    await settle();
    click([...t.root.querySelectorAll('.omnitime-timerpanel button')].find((b) => b.textContent === 'Keep running'));
    assert.equal(t.root.querySelector('.omnitime-timerpanel'), null);
    assert.ok(t.store.data.omnitimeTimer);
    assert.equal(t.root.activeElement, stop);
  });

  it('Escape closes the confirm before the dialog', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(1)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle();
    key(t.window, t.root.querySelector('.omnitime-timerpanel button'), 'Escape');
    assert.equal(t.root.querySelector('.omnitime-timerpanel'), null);
    assert.ok(t.document.querySelector('omnitime-root'), 'dialog still open');
    assert.ok(t.store.data.omnitimeTimer);
  });

  it('after 10 hours asks for the end time (default startedAt + 1 h) instead of booking 10 h', async () => {
    const started = minutesAgo(12 * 60);
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(started) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle();
    assert.equal(t.api.calls.length, 0);
    const input = t.root.querySelector('.omnitime-timerpanel input[type="time"]');
    const s = new t.window.Date(started);
    const expected = new t.window.Date(s.getTime() + 3600000);
    assert.equal(input.value, `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`);
    assert.match(t.root.querySelector('.omnitime-timerpanel__hint').textContent, /Books 1:00/);
    click([...t.root.querySelectorAll('.omnitime-timerpanel button')].find((b) => b.textContent === 'Book'));
    await settle(60);
    const creates = t.api.calls.filter(([m]) => m === 'create').map(([, p]) => p);
    assert.equal(creates.reduce((n, p) => n + p.duration, 0), 60);
    assert.equal(t.store.data.omnitimeTimer, undefined);
  });

  it('rejects a malformed or future end time in the confirm without booking', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(11 * 60)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle();
    const input = t.root.querySelector('.omnitime-timerpanel input[type="time"]');
    const book = () => click([...t.root.querySelectorAll('.omnitime-timerpanel button')].find((b) => b.textContent === 'Book'));
    input.value = '';
    book();
    assert.match(t.root.querySelector('.omnitime-timerpanel__error').textContent, /Enter a time/);
    assert.equal(t.api.calls.length, 0);
    assert.ok(t.store.data.omnitimeTimer);
  });

  it('an API error keeps the timer and shows the error with Retry', async () => {
    const api = fakeApi({ failCreateAt: 0 });
    const t = await open({ api, store: makeStorage({ omnitimeTimer: stored(minutesAgo(47)) }) });
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle(60);
    const panel = t.root.querySelector('.omnitime-timerpanel');
    assert.equal(panel.getAttribute('role'), 'alert');
    assert.match(panel.textContent, /Couldn't book the timer \(HTTP 500\)\. It is still running\./);
    assert.ok(t.store.data.omnitimeTimer);
    assert.equal(slotOf(t.root).hidden, false);
    click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
    await settle(60);
    assert.equal(t.store.data.omnitimeTimer, undefined);
    assert.match(toastText(t.root), /Booked 0:45/);
  });

  it('reloads My day after booking so the entry shows up', async () => {
    let days = 0;
    const api = fakeApi();
    const myDay = api.myDay;
    api.myDay = (d) => { days++; return myDay(d); };
    const t = await open({ api, context: {}, store: makeStorage({ omnitimeTimer: stored(minutesAgo(47)) }) });
    const before = days;
    click(t.root.querySelector('.omnitime-timerpill__stop'));
    await settle(80);
    assert.ok(days > before, 'My day was fetched again');
  });
});

describe('Start timer on "This issue"', () => {
  const startBtn = (root) => root.querySelector('.omnitime-timer-start');

  it('sits next to "Track time on this issue"', async () => {
    const t = await open();
    assert.ok(startBtn(t.root));
    assert.equal(startBtn(t.root).textContent.trim(), 'Start timer');
    assert.equal(startBtn(t.root).nextElementSibling, t.root.querySelector('.omnitime-issuehead__track'));
  });

  it('starts the timer for this issue; the pill appears and the button turns into Stop', async () => {
    const t = await open();
    click(startBtn(t.root));
    await settle();
    const timer = t.store.data.omnitimeTimer;
    assert.deepEqual({ ...timer.issue }, ISSUE);
    assert.ok(Math.abs(Date.parse(timer.startedAt) - Date.now()) < 5000);
    assert.equal(slotOf(t.root).hidden, false);
    assert.equal(t.root.querySelector('.omnitime-timerpill__issue').textContent, '#14 Fix login');
    assert.match(startBtn(t.root).textContent, /Stop timer · 0:00/);
  });

  it('is not offered for a closed issue', async () => {
    const t = await open({ api: fakeApi({ issueOpen: false }) });
    assert.equal(startBtn(t.root), null);
  });

  it('starting while another timer runs asks first (inline), then books it and starts this one', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(47), OTHER) }) });
    click(startBtn(t.root));
    await settle();
    const panel = t.root.querySelector('.omnitime-timerpanel');
    assert.match(panel.textContent, /A timer is running on #99 Other thing \(0:47\)/);
    assert.equal(t.api.calls.length, 0);
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '99');
    click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Book and start'));
    await settle(80);
    const creates = t.api.calls.filter(([m]) => m === 'create').map(([, p]) => p);
    assert.equal(creates[0].issue_id, '99');
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '14');
  });

  it('Cancel in that confirm leaves the running timer alone', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(47), OTHER) }) });
    click(startBtn(t.root));
    await settle();
    click([...t.root.querySelectorAll('.omnitime-timerpanel button')].find((b) => b.textContent === 'Cancel'));
    assert.equal(t.root.querySelector('.omnitime-timerpanel'), null);
    assert.equal(t.api.calls.length, 0);
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '99');
  });

  it('the Stop state of the button books this issue\'s timer', async () => {
    const t = await open({ store: makeStorage({ omnitimeTimer: stored(minutesAgo(47)) }) });
    assert.match(startBtn(t.root).textContent, /Stop timer · 0:47/);
    click(startBtn(t.root));
    await settle(80);
    assert.equal(t.store.data.omnitimeTimer, undefined);
    assert.ok(t.api.calls.some(([m]) => m === 'create'));
  });
});

describe('sidebar widget', () => {
  const WCTX = { source: 'https://gitlab.example.test', project_id: '7', issue_id: '42', issue_label: 'Fix the thing (#42)' };
  const NOW = () => new Date(2026, 9, 22, 14, 7);

  async function setup(initial = {}) {
    const store = makeStorage(initial);
    const sent = [];
    const chrome = {
      storage: { local: store.local, onChanged: store.events },
      runtime: { sendMessage: (m, cb) => { sent.push(m); if (cb) cb({ success: true }); } },
    };
    const env = loadDom(['ical-parser.js', 'timer.js', 'core.js', 'sidebar-widget.js'], { chrome });
    const api = fakeApi();
    api.issueTime = () => Promise.resolve({ tracked_time: [], total_sum: 30, details: [], issue: { open: true } });
    const target = env.document.createElement('div');
    env.document.body.appendChild(target);
    const widget = env.window.OmniTimeSidebar.attach(target, { apiClient: api, context: { ...WCTX }, now: NOW, undoMs: 500, expanded: true });
    await settle(40);
    const root = widget.host.shadowRoot;
    return { ...env, store, api, sent, widget, root, q: (s) => root.querySelector(s) };
  }
  const minsBefore = (m) => new Date(NOW().getTime() - m * 60000).toISOString();

  it('offers "▶ Start" and starts a timer for the issue with a "#42 …" label', async () => {
    const t = await setup();
    const start = t.q('.omnitime-sw__start');
    assert.equal(start.hidden, false);
    assert.equal(start.textContent, '▶ Start');
    assert.ok(t.q('[data-el="summary"]').contains(start), 'Start sits in the summary line');
    assert.ok(!t.q('[data-el="actions"]').contains(start));
    assert.equal(t.q('[data-el="timer"]').hidden, true);
    click(start);
    await settle();
    assert.deepEqual({ ...t.store.data.omnitimeTimer.issue }, { source: WCTX.source, project_id: '7', issue_id: '42', label: '#42 Fix the thing' });
    assert.equal(t.q('[data-el="timer"]').hidden, false);
    assert.equal(t.q('.omnitime-sw__start').hidden, true);
  });

  it('shows "● 0:42 · Stop" in the summary line for the issue it runs on', async () => {
    const t = await setup({ omnitimeTimer: stored(minsBefore(42), { source: WCTX.source, project_id: '7', issue_id: '42', label: '#42 Fix the thing' }) });
    // The widget uses the page clock for "now"; the stored start is relative to it.
    assert.match(t.q('[data-el="timer"]').textContent.replace(/\s+/g, ' ').trim(), /^● \d+:\d\d · Stop$/);
    assert.equal(t.q('[data-el="timer"]').hidden, false);
    assert.equal(t.q('.omnitime-sw__start').hidden, true);
  });

  it('does not show the running state for another issue, and Start asks first', async () => {
    const t = await setup({ omnitimeTimer: stored(minutesAgo(47), OTHER) });
    assert.equal(t.q('[data-el="timer"]').hidden, true);
    click(t.q('.omnitime-sw__start'));
    await settle();
    assert.match(t.q('.omnitime-timerpanel').textContent, /A timer is running on #99 Other thing/);
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '99');
  });

  it('Stop books the entry, shows "Booked … · Undo" and clears the timer; Undo restores it', async () => {
    const t = await setup({ omnitimeTimer: stored(minutesAgo(32), { source: WCTX.source, project_id: '7', issue_id: '42', label: '#42 Fix the thing' }) });
    t.widget.destroy();
    // The widget's clock is fixed in 2026; use a wall-clock widget for the booking flow.
    const target = t.document.createElement('div');
    t.document.body.appendChild(target);
    const widget = t.window.OmniTimeSidebar.attach(target, { apiClient: t.api, context: { ...WCTX }, undoMs: 500, expanded: true });
    await settle(40);
    const root = widget.host.shadowRoot;
    click(root.querySelector('[data-el="timerStop"]'));
    await settle(80);
    const creates = t.api.calls.filter(([m]) => m === 'create').map(([, p]) => p);
    assert.equal(creates.length >= 1, true);
    assert.equal(creates[0].issue_id, '42');
    assert.equal(t.store.data.omnitimeTimer, undefined);
    assert.match(root.querySelector('[data-el="msg"]').textContent, /Booked 0:30 · Undo/);
    assert.ok(t.sent.some((m) => m.action === 'OMNI_DAY_TOTAL' && m.totalMinutes === 90));
    click(root.querySelector('[data-el="msg"] button'));
    await settle(80);
    assert.ok(t.api.calls.some(([m, id]) => m === 'remove' && id === 700));
    assert.equal(t.store.data.omnitimeTimer.issue.issue_id, '42');
    widget.destroy();
  });

  it('destroy stops listening to the timer', async () => {
    const t = await setup();
    assert.ok(t.store.events.listeners.size > 0);
    t.widget.destroy();
    assert.equal(t.store.events.listeners.size, 0);
  });
});

describe('legacy "active" entries in My day', () => {
  it('are labelled incomplete in the entry text and aria-label', async () => {
    const api = fakeApi();
    api.myDay = (date) => Promise.resolve({
      date, week: [{ label: 'M', date, total_minutes: 0, total_label: '0:00', active: true }],
      day_total_minutes: 0, day_total_label: '0:00',
      entries: [{
        id: 5, start: '09:00', stop: '09:00', duration_minutes: 0, duration_label: '0:00', project: 'P',
        milestone: '', issue_label: 'Old form', issue_external_id: '5', issue_internal_id: 5, issue_link: '',
        comment: '', status: 'unbooked', editable: false, break_label: null, active: true,
      }],
    });
    const t = await open({ api, context: {} });
    const block = t.root.querySelector('.omnitime-tl__entry');
    assert.match(block.getAttribute('aria-label'), /incomplete/);
    assert.match(block.textContent, /incomplete/);
  });
});
