// Toolbar badge while a timer runs (background.js): elapsed time in red instead
// of the day total, a once-a-minute alarm exactly while it runs, and the day
// total back when it stops.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, ymd } = require('./helpers');

const API = 'https://times.example.test/api/v1/tracked-time';
const DAY = 'https://times.example.test/api/v1/my-tracked-time';
// Below target: grey on a weekday, neutral on Saturday/Sunday (no target then).
const BELOW = [0, 6].includes(new Date().getDay()) ? '#2563eb' : '#6b7280';
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const TIMER = (m) => ({ startedAt: minutesAgo(m), issue: { source: 'https://git.example.test', project_id: '3', issue_id: '14', label: '#14 x' }, comment: '' });

function load({ sync = { apiUrl: API, apiKey: 'KEY' }, local = {}, total = 150 } = {}) {
  const store = { sync: { ...sync }, local: { ...local } };
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in store[name]) out[k] = store[name][k]; });
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    set: (obj, cb) => { Object.assign(store[name], obj); if (cb) cb(); return Promise.resolve(); },
  });
  const listeners = { alarm: [], storage: [] };
  const calls = { badge: [], colors: [], alarms: [], cleared: [], fetches: [] };
  const chrome = {
    store, calls,
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (fn) => listeners.storage.push(fn) } },
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    alarms: {
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      create: (name, info) => calls.alarms.push({ name, ...info }),
      clear: (name) => { calls.cleared.push(name); return Promise.resolve(true); },
    },
    action: {
      onClicked: { addListener() {} },
      setBadgeText: ({ text }) => { calls.badge.push(text); return Promise.resolve(); },
      setBadgeBackgroundColor: ({ color }) => { calls.colors.push(color); return Promise.resolve(); },
    },
    notifications: { onClicked: { addListener() {} }, create() {}, clear() {} },
    scripting: {},
  };
  const fetch = (url, init) => {
    calls.fetches.push({ url, init });
    const body = { day_total_minutes: total, entries: [] };
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => '' } });
  };
  const bg = loadBackground({ chrome, fetch });
  bg.listeners = listeners;
  return bg;
}
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('badge while a timer runs', () => {
  it('shows the elapsed time on a red badge instead of the day total', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(42) } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['0:42']);
    assert.deepEqual(bg.chrome.calls.colors, ['#c62828']);
    assert.deepEqual(bg.chrome.calls.fetches, [], 'no day-total fetch needed');
  });

  it('shows hours and minutes for long timers', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(125) } });
    await bg.applyTimerBadge({});
    assert.deepEqual(bg.chrome.calls.badge, ['2:05']);
  });

  it('keeps the timer on the badge when the UI reports a day total', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(5) } });
    await bg.handleDayTotalMessage({ date: ymd(new Date()), totalMinutes: 75 });
    assert.deepEqual(bg.chrome.calls.badge, ['0:05']);
    assert.deepEqual(bg.chrome.calls.colors, ['#c62828']);
  });

  it('shows the timer even before the API is configured or signed in', async () => {
    const bg = load({ sync: {}, local: { omnitimeTimer: TIMER(3) } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['0:03']);
  });

  it('respects "show badge" off', async () => {
    const bg = load({ sync: { apiUrl: API, apiKey: 'KEY', showBadge: false }, local: { omnitimeTimer: TIMER(3) } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['']);
  });

  it('ignores a corrupt stored timer', async () => {
    const bg = load({ local: { omnitimeTimer: { startedAt: 'soon' } } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['2:30']);
    assert.deepEqual(bg.chrome.calls.colors, [BELOW]);
  });
});

describe('timer alarm and restore', () => {
  it('arms a one-minute alarm while the timer runs', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(1) } });
    await bg.refreshTimerBadge();
    assert.deepEqual(bg.chrome.calls.alarms, [{ name: 'timerBadge', delayInMinutes: 1, periodInMinutes: 1 }]);
    assert.deepEqual(bg.chrome.calls.badge, ['0:01']);
  });

  it('clears the alarm and brings the day total back when the timer stopped', async () => {
    const bg = load();
    await bg.refreshTimerBadge();
    assert.deepEqual(bg.chrome.calls.cleared, ['timerBadge']);
    assert.deepEqual(bg.chrome.calls.badge, ['2:30']);
    assert.deepEqual(bg.chrome.calls.colors, [BELOW]);
  });

  it('reacts to the timer key changing in storage and to the alarm tick', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(2) } });
    bg.listeners.storage.forEach((fn) => fn({ omnitimeTimer: { newValue: TIMER(2) } }, 'local'));
    await flush();
    assert.equal(bg.chrome.calls.alarms.at(-1).name, 'timerBadge');
    assert.equal(bg.chrome.calls.badge.at(-1), '0:02');
    bg.listeners.alarm.forEach((fn) => fn({ name: 'timerBadge' }));
    await flush();
    assert.equal(bg.chrome.calls.badge.at(-1), '0:02');
    // Stopped: the key is gone.
    delete bg.chrome.store.local.omnitimeTimer;
    bg.listeners.storage.forEach((fn) => fn({ omnitimeTimer: { oldValue: TIMER(2) } }, 'local'));
    await flush();
    assert.ok(bg.chrome.calls.cleared.includes('timerBadge'));
    assert.equal(bg.chrome.calls.badge.at(-1), '2:30');
  });

  it('ignores other storage areas and keys', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(2) } });
    bg.listeners.storage.forEach((fn) => fn({ omnitimeTimer: { newValue: TIMER(2) } }, 'sync'));
    bg.listeners.storage.forEach((fn) => fn({ other: { newValue: 1 } }, 'local'));
    await flush();
    assert.deepEqual(bg.chrome.calls.alarms, []);
  });

  it('re-arms the tick on startup when a timer is still stored', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(2) } });
    bg.scheduleBadgeAlarms();
    await flush();
    assert.ok(bg.chrome.calls.alarms.some((a) => a.name === 'timerBadge'));
  });
});
