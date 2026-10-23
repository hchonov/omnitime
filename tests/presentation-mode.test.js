// Presentation mode in the service worker (background.js): the toolbar icon's
// right-click checkbox item (created on install/startup with the stored state,
// a click toggles chrome.storage.local), the cleared badge (day total and
// running timer), and the skipped end-of-day reminder.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read, ymd } = require('./helpers');

const API = 'https://times.example.test/api/v1/tracked-time';
const DAY = 'https://times.example.test/api/v1/my-tracked-time';
const WEEK = 'https://times.example.test/api/v1/my-tracked-week';
const KEY = 'omnitimePresentationMode';
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const TIMER = (m) => ({ startedAt: minutesAgo(m), issue: { source: 'https://git.example.test', project_id: '3', issue_id: '14', label: '#14 x' }, comment: '' });
const flush = () => new Promise((r) => setTimeout(r, 15));

// A Tuesday, so the weekday reminder rules apply whatever day the suite runs.
function fixedDate(iso) {
  const RealDate = Date;
  const t = new RealDate(iso).getTime();
  return class FixedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(t); }
    static now() { return t; }
  };
}

function load({ sync = { apiUrl: API, apiKey: 'KEY', reminderEnabled: true }, local = {}, now, menu = true } = {}) {
  const store = { sync: { ...sync }, local: { ...local }, session: {} };
  const listeners = { alarm: [], storage: [], installed: [], startup: [], menuClick: [], message: [] };
  const calls = { badge: [], colors: [], alarms: [], cleared: [], fetches: [], notifications: [], menu: [] };
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in store[name]) out[k] = store[name][k]; });
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    // Like the browser: writing fires onChanged with the old and new value.
    set: (obj, cb) => {
      const changes = {};
      Object.keys(obj).forEach((k) => { changes[k] = { oldValue: store[name][k], newValue: obj[k] }; });
      Object.assign(store[name], obj);
      listeners.storage.forEach((fn) => fn(changes, name));
      if (cb) cb();
      return Promise.resolve();
    },
    remove: (keys) => { [].concat(keys).forEach((k) => delete store[name][k]); return Promise.resolve(); },
  });
  const listener = (list) => ({ addListener: (fn) => list.push(fn) });
  const items = new Map(); // id -> create properties (the "menu")
  const chrome = {
    store, calls, items,
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: listener(listeners.storage) },
    runtime: {
      id: 'omnitime-id', getURL: (p) => `chrome-extension://omnitime-id/${p}`,
      onMessage: listener(listeners.message), onInstalled: listener(listeners.installed), onStartup: listener(listeners.startup),
    },
    alarms: {
      onAlarm: listener(listeners.alarm),
      create: (name, info) => calls.alarms.push({ name, ...info }),
      clear: (name) => { calls.cleared.push(name); return Promise.resolve(true); },
    },
    action: {
      onClicked: { addListener() {} },
      setBadgeText: ({ text }) => { calls.badge.push(text); return Promise.resolve(); },
      setBadgeBackgroundColor: ({ color }) => { calls.colors.push(color); return Promise.resolve(); },
    },
    notifications: { onClicked: { addListener() {} }, create: (id, opts) => calls.notifications.push({ id, ...opts }), clear() {} },
    scripting: { unregisterContentScripts: () => Promise.resolve(), registerContentScripts: () => Promise.resolve() },
  };
  if (menu) {
    chrome.contextMenus = {
      onClicked: listener(listeners.menuClick),
      removeAll: (cb) => { calls.menu.push('removeAll'); items.clear(); if (cb) cb(); },
      create: (props, cb) => {
        if (items.has(props.id)) { chrome.runtime.lastError = { message: 'duplicate id' }; if (cb) cb(); chrome.runtime.lastError = undefined; return; }
        calls.menu.push('create');
        items.set(props.id, { ...props });
        if (cb) cb();
      },
      update: (id, props, cb) => {
        if (!items.has(id)) { chrome.runtime.lastError = { message: 'no such item' }; if (cb) cb(); chrome.runtime.lastError = undefined; return; }
        calls.menu.push('update');
        Object.assign(items.get(id), props);
        if (cb) cb();
      },
    };
  }
  const fetch = (url, init) => {
    calls.fetches.push({ url, init });
    const body = url.startsWith(WEEK) ? { absences: [] } : { day_total_minutes: 150, entries: [] };
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => '' } });
  };
  const context = { chrome, fetch, navigator: { userAgent: 'Chrome' }, console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, Promise, Date: now ? fixedDate(now) : Date };
  context.importScripts = () => vm.runInContext(read('ical-parser.js'), context);
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  context.listeners = listeners;
  return context;
}

const menuItem = (bg) => bg.chrome.items.get(KEY);
const fire = (list, ...args) => list.forEach((fn) => fn(...args));

describe('presentation mode: toolbar icon menu', () => {
  it('is a checkbox item in the action context, created on install, unchecked by default', async () => {
    const bg = load();
    fire(bg.listeners.installed);
    await flush();
    const item = menuItem(bg);
    assert.ok(item);
    assert.equal(item.type, 'checkbox');
    assert.equal(item.title, 'Presentation mode (hide tracking)');
    assert.deepEqual([...item.contexts], ['action']);
    assert.equal(item.checked, false);
  });

  it('is created again on browser startup with the stored state', async () => {
    const bg = load({ local: { [KEY]: true } });
    fire(bg.listeners.startup);
    await flush();
    assert.equal(menuItem(bg).checked, true);
  });

  it('survives install and startup running together (no duplicate id)', async () => {
    const bg = load();
    fire(bg.listeners.installed);
    fire(bg.listeners.startup);
    await flush();
    assert.equal(bg.chrome.items.size, 1);
    assert.equal(bg.chrome.calls.menu.filter((c) => c === 'create').length, 2);
  });

  it('a click toggles the stored value, and the check mark follows storage changes', async () => {
    const bg = load();
    fire(bg.listeners.installed);
    await flush();
    fire(bg.listeners.menuClick, { menuItemId: KEY, checked: true });
    await flush();
    assert.equal(bg.chrome.store.local[KEY], true);
    assert.equal(menuItem(bg).checked, true);
    fire(bg.listeners.menuClick, { menuItemId: KEY, checked: false });
    await flush();
    assert.equal(bg.chrome.store.local[KEY], false);
    assert.equal(menuItem(bg).checked, false);
    // Flipped elsewhere (the options page): the menu follows.
    await bg.chrome.storage.local.set({ [KEY]: true });
    await flush();
    assert.equal(menuItem(bg).checked, true);
  });

  it('flips the stored value when the click carries no checked state, ignores other items', async () => {
    const bg = load({ local: { [KEY]: true } });
    fire(bg.listeners.menuClick, { menuItemId: 'something-else', checked: false });
    await flush();
    assert.equal(bg.chrome.store.local[KEY], true);
    fire(bg.listeners.menuClick, { menuItemId: KEY });
    await flush();
    assert.equal(bg.chrome.store.local[KEY], false);
  });

  it('rebuilds a missing item when only its check mark should change', async () => {
    const bg = load();
    await bg.chrome.storage.local.set({ [KEY]: true }); // the worker restarted: no item yet
    await flush();
    assert.equal(menuItem(bg).checked, true);
  });

  it('works where contextMenus is not available', async () => {
    const bg = load({ menu: false });
    fire(bg.listeners.installed);
    await bg.chrome.storage.local.set({ [KEY]: true });
    await flush();
    assert.equal(bg.chrome.store.local[KEY], true);
  });
});

describe('presentation mode: badge', () => {
  const today = () => ymd(new Date());

  it('clears the day-total badge without fetching, and restores it when turned off', async () => {
    const bg = load({ local: { [KEY]: true } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['']);
    assert.deepEqual(bg.chrome.calls.fetches, []);
    await bg.chrome.storage.local.set({ [KEY]: false });
    await flush();
    assert.equal(bg.chrome.calls.badge.at(-1), '2:30');
  });

  it('ignores the day totals the UI reports while on', async () => {
    const bg = load({ local: { [KEY]: true } });
    await bg.handleDayTotalMessage({ date: today(), totalMinutes: 75 });
    assert.deepEqual(bg.chrome.calls.badge, ['']);
    await bg.chrome.storage.local.set({ [KEY]: false });
    await bg.handleDayTotalMessage({ date: today(), totalMinutes: 75 });
    assert.equal(bg.chrome.calls.badge.at(-1), '1:15');
  });

  it('turning it on live clears the badge, a running timer included', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(42) } });
    await bg.refreshTimerBadge();
    assert.equal(bg.chrome.calls.badge.at(-1), '0:42');
    await bg.chrome.storage.local.set({ [KEY]: true });
    await flush();
    assert.equal(bg.chrome.calls.badge.at(-1), '');
    assert.ok(bg.chrome.calls.cleared.includes('timerBadge'), 'the tick stops');
    // The alarm tick (still scheduled in another worker life) stays quiet too.
    bg.listeners.alarm.forEach((fn) => fn({ name: 'timerBadge' }));
    bg.listeners.alarm.forEach((fn) => fn({ name: 'refreshBadge' }));
    await flush();
    assert.equal(bg.chrome.calls.badge.at(-1), '');
    assert.ok(bg.chrome.calls.badge.every((t) => t === '' || t === '0:42'), 'no timer or total shown while on');
  });

  it('turning it off brings the running timer badge back and re-arms its tick', async () => {
    const bg = load({ local: { omnitimeTimer: TIMER(42), [KEY]: true } });
    await bg.refreshTimerBadge();
    assert.equal(bg.chrome.calls.badge.at(-1), '');
    await bg.chrome.storage.local.set({ [KEY]: false });
    await flush();
    assert.equal(bg.chrome.calls.badge.at(-1), '0:42');
    assert.equal(bg.chrome.calls.alarms.at(-1).name, 'timerBadge');
  });
});

describe('presentation mode: reminder', () => {
  const TUE = '2026-07-14T18:00:00';

  it('still shows the reminder when off (control)', async () => {
    const bg = load({ now: TUE });
    await bg.runReminder();
    assert.equal(bg.chrome.calls.notifications.length, 1);
  });

  it('skips the reminder (and its fetches) while on; the alarm still re-arms', async () => {
    const bg = load({ now: TUE, local: { [KEY]: true } });
    bg.listeners.alarm.forEach((fn) => fn({ name: 'endOfDayReminder' }));
    await flush();
    assert.deepEqual(bg.chrome.calls.notifications, []);
    assert.deepEqual(bg.chrome.calls.fetches, []);
    assert.ok(bg.chrome.calls.alarms.some((a) => a.name === 'endOfDayReminder'), 're-armed for the next weekday');
  });
});
