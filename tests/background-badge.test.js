const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read, ymd } = require('./helpers');

// Evaluate ical-parser.js + background.js in one context (as Chrome's
// importScripts / Firefox's manifest scripts list do) with recording stubs.
// A Date whose "now" is pinned (local time), so weekday/time rules are stable.
function fixedDate(iso) {
  const RealDate = Date;
  const t = new RealDate(iso).getTime();
  return class FixedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(t); }
    static now() { return t; }
  };
}

function load({ sync = {}, local = {}, session = {}, responses = {}, now } = {}) {
  const store = { sync: { ...sync }, local: { ...local }, session: { ...session } };
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in store[name]) out[k] = store[name][k]; });
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    set: (obj, cb) => { Object.assign(store[name], obj); if (cb) cb(); return Promise.resolve(); },
    remove: (keys) => { [].concat(keys).forEach((k) => delete store[name][k]); return Promise.resolve(); },
  });
  const event = () => ({ addListener() {} });
  const calls = { badge: [], colors: [], alarms: [], cleared: [], notifications: [], fetches: [] };
  const chrome = {
    store,
    calls,
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: event() },
    runtime: { id: 'omnitime-id', getURL: (p) => `chrome-extension://omnitime-id/${p}`, onMessage: event(), onInstalled: event(), onStartup: event(), openOptionsPage() { calls.options = true; } },
    alarms: {
      onAlarm: event(),
      create: (name, info) => calls.alarms.push({ name, ...info }),
      clear: (name) => { calls.cleared.push(name); return Promise.resolve(true); },
    },
    action: {
      onClicked: event(),
      setBadgeText: ({ text }) => { calls.badge.push(text); return Promise.resolve(); },
      setBadgeBackgroundColor: ({ color }) => { calls.colors.push(color); return Promise.resolve(); },
    },
    notifications: { onClicked: event(), create: (id, opts) => calls.notifications.push({ id, ...opts }), clear() {} },
    scripting: {},
  };
  const fetch = (url, init) => {
    calls.fetches.push({ url, init });
    const body = responses[url.split('?')[0]] || {};
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => '' } });
  };
  const context = { chrome, fetch, navigator: { userAgent: 'Chrome' }, console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, Promise, Date: now ? fixedDate(now) : Date };
  context.importScripts = () => vm.runInContext(read('ical-parser.js'), context);
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  return context;
}

const API = 'https://times.example.test/api/v1/tracked-time';
const DAY = 'https://times.example.test/api/v1/my-tracked-time';
const WEEK = 'https://times.example.test/api/v1/my-tracked-week';
const TUE = '2026-07-14'; // pinned weekday for the target rules
const SAT = '2026-07-18';
const at = (date, time = '18:00:00') => `${date}T${time}`;
const GREY = '#6b7280';
const GREEN = '#16a34a';
const BLUE = '#2563eb';
const today = () => ymd(new Date());

describe('badge formatting and colour', () => {
  const bg = load();
  it('formats minutes as h:mm and rejects invalid input', () => {
    assert.equal(bg.formatBadgeText(0), '0:00');
    assert.equal(bg.formatBadgeText(150), '2:30');
    assert.equal(bg.formatBadgeText(605), '10:05');
    assert.equal(bg.formatBadgeText(-1), '');
    assert.equal(bg.formatBadgeText(NaN), '');
    assert.equal(bg.formatBadgeText(null), '');
  });
  it('is grey below target, green at or above, neutral without a target', () => {
    assert.equal(bg.badgeColor(479, 480), '#6b7280');
    assert.equal(bg.badgeColor(480, 480), '#16a34a');
    assert.equal(bg.badgeColor(600, 480), '#16a34a');
    assert.equal(bg.badgeColor(10, 0), '#2563eb');
  });
  it('defaults the target to 480 and honours 0', () => {
    assert.equal(bg.dailyTarget({}), 480);
    assert.equal(bg.dailyTarget({ dailyTargetMinutes: 0 }), 0);
    assert.equal(bg.dailyTarget({ dailyTargetMinutes: 360 }), 360);
  });
});

describe('myDayUrl', () => {
  const bg = load();
  it('derives the sibling endpoint and honours the override', () => {
    assert.equal(bg.myDayUrl({ apiUrl: API }, '2026-07-14'), `${DAY}?_format=json&date=2026-07-14`);
    assert.equal(bg.myDayUrl({ apiUrl: API, endpoints: { myDay: 'https://x.example.test/day' } }, '2026-07-14'), 'https://x.example.test/day?_format=json&date=2026-07-14');
    assert.equal(bg.myDayUrl({}, '2026-07-14'), null);
  });
});

describe('refreshBadge', () => {
  const setup = (extra = {}, total = 150) => load({
    sync: { apiUrl: API, apiKey: 'KEY', ...extra },
    responses: { [DAY]: { day_total_minutes: total, entries: [] } },
  });

  it('shows the total on a grey badge below target', async () => {
    const bg = load({ now: at(TUE), sync: { apiUrl: API, apiKey: 'KEY' }, responses: { [DAY]: { day_total_minutes: 150, entries: [] } } });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.badge, ['2:30']);
    assert.deepEqual(bg.chrome.calls.colors, [GREY]);
    assert.equal(bg.chrome.calls.fetches[0].init.headers['api-key'], 'KEY');
    assert.ok(bg.chrome.calls.fetches[0].url.endsWith(`date=${TUE}`));
  });
  it('uses the Google bearer token when signed in', async () => {
    const bg = load({ now: at(TUE), sync: { apiUrl: API }, local: { googleSignedIn: true }, session: { googleAuthToken: 'tok' }, responses: { [DAY]: { day_total_minutes: 500 } } });
    await bg.refreshBadge();
    assert.equal(bg.chrome.calls.fetches[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(bg.chrome.calls.colors, [GREEN]);
  });
  it('colours by the API target: a 6 h target is green at 6 h', async () => {
    const bg = load({
      now: at(TUE),
      sync: { apiUrl: API, apiKey: 'KEY', dailyTargetMinutes: 480 },
      responses: { [DAY]: { day_total_minutes: 360, target_minutes: 360, entries: [] } },
    });
    await bg.refreshBadge();
    assert.deepEqual(bg.chrome.calls.colors, [GREEN]);
  });
  it('is grey below the API target and falls back to the setting without one', async () => {
    const below = load({ now: at(TUE), sync: { apiUrl: API, apiKey: 'KEY' }, responses: { [DAY]: { day_total_minutes: 359, target_minutes: 360 } } });
    await below.refreshBadge();
    assert.deepEqual(below.chrome.calls.colors, [GREY]);
    const setting = load({ now: at(TUE), sync: { apiUrl: API, apiKey: 'KEY', dailyTargetMinutes: 120 }, responses: { [DAY]: { day_total_minutes: 130 } } });
    await setting.refreshBadge();
    assert.deepEqual(setting.chrome.calls.colors, [GREEN]);
  });
  it('has no target on Saturday, or when the target is off', async () => {
    const sat = load({ now: at(SAT), sync: { apiUrl: API, apiKey: 'KEY' }, responses: { [DAY]: { day_total_minutes: 100, target_minutes: 480 } } });
    await sat.refreshBadge();
    assert.deepEqual(sat.chrome.calls.colors, [BLUE]);
    const off = load({ now: at(TUE), sync: { apiUrl: API, apiKey: 'KEY', dailyTargetMinutes: 0 }, responses: { [DAY]: { day_total_minutes: 100, target_minutes: 480 } } });
    await off.refreshBadge();
    assert.deepEqual(off.chrome.calls.colors, [BLUE]);
  });
  it('dayTargetFor: weekend 0, setting 0 wins, API first, then the setting', () => {
    const bg = load();
    assert.equal(bg.dayTargetFor({}, { target_minutes: 360 }, TUE), 360);
    assert.equal(bg.dayTargetFor({ dailyTargetMinutes: 300 }, {}, TUE), 300);
    assert.equal(bg.dayTargetFor({}, null, TUE), 480);
    assert.equal(bg.dayTargetFor({}, { target_minutes: null }, TUE), 480);
    assert.equal(bg.dayTargetFor({}, { target_minutes: 360 }, SAT), 0);
    assert.equal(bg.dayTargetFor({ dailyTargetMinutes: 0 }, { target_minutes: 360 }, TUE), 0);
  });
  it('clears the badge when disabled, unconfigured, signed out or on a bad response', async () => {
    for (const bg of [
      setup({ showBadge: false }),
      load({ sync: { apiUrl: API } }), // no credentials
      load({ sync: { apiKey: 'KEY' } }), // no URL
      load({ sync: { apiUrl: API, apiKey: 'KEY' }, responses: { [DAY]: { entries: [] } } }), // no total field
    ]) {
      await bg.refreshBadge();
      assert.deepEqual(bg.chrome.calls.badge, ['']);
    }
  });
});

describe('OMNI_DAY_TOTAL', () => {
  it('applies a total for today without fetching and ignores other days', async () => {
    const bg = load({ now: at(TUE), sync: { dailyTargetMinutes: 60 } });
    await bg.handleDayTotalMessage({ date: '2000-01-01', totalMinutes: 99 });
    assert.deepEqual(bg.chrome.calls.badge, []);
    await bg.handleDayTotalMessage({ date: TUE, totalMinutes: 75 });
    assert.deepEqual(bg.chrome.calls.badge, ['1:15']);
    assert.deepEqual(bg.chrome.calls.colors, [GREEN]);
    assert.deepEqual(bg.chrome.calls.fetches, []);
  });
  it('uses the API target seen by the last refresh', async () => {
    const bg = load({
      now: at(TUE),
      sync: { apiUrl: API, apiKey: 'KEY' },
      responses: { [DAY]: { day_total_minutes: 100, target_minutes: 360, entries: [] } },
    });
    await bg.refreshBadge();
    await bg.handleDayTotalMessage({ date: TUE, totalMinutes: 360 });
    assert.equal(bg.chrome.calls.colors.at(-1), GREEN, '360 reaches the 6 h API target');
    assert.equal(bg.chrome.calls.fetches.length, 1, 'no second fetch');
  });
  it('learns the API target with one refresh when it is not known yet', async () => {
    const bg = load({
      now: at(TUE),
      sync: { apiUrl: API, apiKey: 'KEY' },
      responses: { [DAY]: { day_total_minutes: 360, target_minutes: 360, entries: [] } },
    });
    await bg.handleDayTotalMessage({ date: TUE, totalMinutes: 360 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bg.chrome.calls.fetches.length, 1);
    assert.equal(bg.chrome.calls.colors.at(-1), GREEN);
    await bg.handleDayTotalMessage({ date: TUE, totalMinutes: 361 });
    assert.equal(bg.chrome.calls.fetches.length, 1, 'cached now');
  });
  it('shows no target colour for a reported total on a Saturday', async () => {
    const bg = load({ now: at(SAT), sync: { dailyTargetMinutes: 480 } });
    await bg.handleDayTotalMessage({ date: SAT, totalMinutes: 75 });
    assert.deepEqual(bg.chrome.calls.colors, [BLUE]);
  });
  it('clears the badge when showBadge is off', async () => {
    const bg = load({ sync: { showBadge: false } });
    await bg.handleDayTotalMessage({ date: today(), totalMinutes: 75 });
    assert.deepEqual(bg.chrome.calls.badge, ['']);
  });
});

describe('reminder scheduling', () => {
  const bg = load();
  const at = (s) => new Date(s); // local time, TZ pinned by helpers
  const fmt = (d) => d && `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  it('picks today when the time is still ahead on a weekday', () => {
    assert.equal(fmt(bg.nextReminderTime(at('2026-07-14T10:00:00'), '17:30')), '2026-07-14 17:30');
  });
  it('moves to the next day once the time has passed', () => {
    assert.equal(fmt(bg.nextReminderTime(at('2026-07-14T18:00:00'), '17:30')), '2026-07-15 17:30');
  });
  it('skips the weekend', () => {
    assert.equal(fmt(bg.nextReminderTime(at('2026-07-17T18:00:00'), '17:30')), '2026-07-20 17:30'); // Fri evening
    assert.equal(fmt(bg.nextReminderTime(at('2026-07-18T08:00:00'), '17:30')), '2026-07-20 17:30'); // Saturday
  });
  it('rejects malformed times', () => {
    assert.equal(bg.nextReminderTime(new Date(), '25:00'), null);
    assert.equal(bg.nextReminderTime(new Date(), 'soon'), null);
  });
  it('creates the alarm only when enabled and clears it otherwise', async () => {
    const on = load({ sync: { reminderEnabled: true, reminderTime: '17:30' } });
    await on.scheduleReminder();
    assert.equal(on.chrome.calls.alarms.length, 1);
    assert.equal(on.chrome.calls.alarms[0].name, 'endOfDayReminder');
    assert.ok(on.chrome.calls.alarms[0].when > Date.now());
    const off = load({ sync: { reminderEnabled: false } });
    await off.scheduleReminder();
    assert.deepEqual(off.chrome.calls.alarms, []);
    assert.deepEqual(off.chrome.calls.cleared, ['endOfDayReminder']);
  });
});

describe('reminder message', () => {
  const bg = load();
  it('combines untracked time and unbooked meetings', () => {
    assert.equal(bg.buildReminderMessage(330, 480, 3), '2:30 untracked · 3 meetings unbooked');
    assert.equal(bg.buildReminderMessage(330, 480, 1), '2:30 untracked · 1 meeting unbooked');
    assert.equal(bg.buildReminderMessage(330, 480, 0), '2:30 untracked');
    assert.equal(bg.buildReminderMessage(500, 480, 2), '2 meetings unbooked');
  });
  it('stays silent when everything is done or there is no target', () => {
    assert.equal(bg.buildReminderMessage(480, 480, 0), null);
    assert.equal(bg.buildReminderMessage(0, 0, 0), null);
  });
});

describe('countUnbookedEvents', () => {
  const bg = load();
  const D = '2026-07-14';
  const ev = (title, startMinutes, extra = {}) => ({ title, date: D, startMinutes, endMinutes: startMinutes + 30, uid: '', ...extra });

  it('builds the same keys core.js stores (uid or title series, original start)', () => {
    assert.equal(bg.calOccurrenceKey(ev('  Stand-Up ', 9 * 60 + 5), D), 'title:stand-up@2026-07-14T09:05');
    assert.equal(bg.calOccurrenceKey(ev('x', 600, { uid: 'abc' }), D), 'uid:abc@2026-07-14T10:00');
  });
  it('skips events booked from the calendar while the entry still exists', () => {
    const events = [ev('A', 540, { uid: 'a' }), ev('B', 600), ev('C', 660)];
    const links = { 'uid:a@2026-07-14T09:00': { entryId: 7, date: D }, 'title:c@2026-07-14T11:00': { entryId: 8, date: D } };
    const entries = [{ id: 7, start: '14:00', duration_minutes: 30 }]; // entry 8 was deleted
    assert.equal(bg.countUnbookedEvents(events, links, entries, D, 18 * 60), 2);
  });
  it('treats an overlapping tracked entry as handled and ignores other days', () => {
    const events = [ev('A', 540), ev('B', 600), ev('Other day', 540, { date: '2026-07-15' })];
    const entries = [{ id: 1, start: '09:15', duration_minutes: 30 }];
    assert.equal(bg.countUnbookedEvents(events, {}, entries, D, 18 * 60), 1);
  });
  it('counts only 5-240 minute events that have started, like Book meetings', () => {
    const events = [
      ev('Short', 540, { endMinutes: 543 }),          // 3 min: too short
      ev('Block', 600, { endMinutes: 600 + 241 }),    // 4 h 1 min: too long
      ev('Exactly 4 h', 660, { endMinutes: 660 + 240 }), // counts
      ev('Just 5 min', 720, { endMinutes: 725 }),     // counts
      ev('Later', 17 * 60),                           // not started at 15:00
    ];
    assert.equal(bg.countUnbookedEvents(events, {}, [], D, 15 * 60), 2);
    assert.equal(bg.countUnbookedEvents(events, {}, [], D, 17 * 60), 3, 'counts once it has started');
  });
});

describe('runReminder', () => {
  const CAL_JSON = (items) => ({ items });
  const gev = (summary, start, end, extra = {}) => ({
    id: summary, summary,
    start: { dateTime: `${TUE}T${start}:00` }, end: { dateTime: `${TUE}T${end}:00` }, ...extra,
  });
  const setup = ({ week = { absences: [] }, day = { day_total_minutes: 330, entries: [] }, items, now = at(TUE), sync = {} } = {}) => load({
    now,
    sync: { apiUrl: API, apiKey: 'KEY', reminderEnabled: true, dailyTargetMinutes: 480, ...sync },
    local: items ? { googleCalJson: CAL_JSON(items) } : {},
    responses: { [DAY]: day, [WEEK]: week },
  });
  const messages = (bg) => bg.chrome.calls.notifications.map((n) => n.message);

  it('notifies with the computed message', async () => {
    const bg = setup();
    await bg.runReminder();
    assert.deepEqual(messages(bg), ['2:30 untracked']);
  });
  it('does nothing on a weekend', async () => {
    const bg = setup({ now: at(SAT) });
    await bg.runReminder();
    assert.deepEqual(messages(bg), []);
  });
  it('uses the API target (a 6 h day reaching 6 h is not nagged)', async () => {
    const bg = setup({ day: { day_total_minutes: 360, target_minutes: 360, entries: [] } });
    await bg.runReminder();
    assert.deepEqual(messages(bg), []);
  });
  it('stays silent on a full absence day with no meetings', async () => {
    const bg = setup({ day: { day_total_minutes: 0, entries: [] }, week: { absences: [{ date: TUE, half_day: false, label: 'Absent' }] } });
    await bg.runReminder();
    assert.deepEqual(messages(bg), []);
  });
  it('halves the target on a half absence day', async () => {
    const half = { absences: [{ date: TUE, half_day: true, label: 'Absent' }] };
    const bg = setup({ day: { day_total_minutes: 100, entries: [] }, week: half });
    await bg.runReminder();
    assert.deepEqual(messages(bg), ['2:20 untracked'], 'target 4:00, tracked 1:40');
    const done = setup({ day: { day_total_minutes: 240, entries: [] }, week: half });
    await done.runReminder();
    assert.deepEqual(messages(done), []);
  });
  it('ignores absences on other days and a failed week request', async () => {
    const other = setup({ week: { absences: [{ date: '2026-07-15', half_day: false }] } });
    await other.runReminder();
    assert.deepEqual(messages(other), ['2:30 untracked']);
    const failing = setup();
    const real = failing.fetch;
    failing.fetch = (url, init) => (String(url).includes('my-tracked-week') ? Promise.reject(new Error('down')) : real(url, init));
    await failing.runReminder();
    assert.deepEqual(messages(failing), ['2:30 untracked']);
  });
  it('never writes the week response (absences) to storage', async () => {
    const bg = setup({ week: { absences: [{ date: TUE, half_day: true, label: 'Absent' }] } });
    await bg.runReminder();
    const stored = JSON.stringify(bg.chrome.store);
    assert.ok(!stored.includes('half_day') && !stored.includes('Absent'));
    assert.ok(bg.chrome.calls.fetches.some((f) => f.url.includes('my-tracked-week')), 'the week was read');
  });
  it('counts started meetings only: not a 4 h out-of-office block, not one that starts later', async () => {
    const bg = setup({
      day: { day_total_minutes: 480, entries: [] },
      now: at(TUE, '15:00:00'),
      items: [
        gev('Standup', '09:00', '09:30'),
        gev('Block', '10:00', '14:30'),  // 4 h 30 min
        gev('Evening', '16:00', '17:00'), // not started at 15:00
      ],
    });
    await bg.runReminder();
    assert.deepEqual(messages(bg), ['1 meeting unbooked']);
  });
});

describe('last sync time', () => {
  it('stores omnitimeCalSyncedAt after an iCal sync and a 304', async () => {
    const bg = load({ sync: { icalUrl: 'https://cal.example.test/feed.ics' } });
    await bg.syncCalendarNow();
    assert.ok(!Number.isNaN(Date.parse(bg.chrome.store.local.omnitimeCalSyncedAt)));
  });
  it('stores omnitimeCalSyncedAt after a Google sync', async () => {
    const bg = load({ sync: { useGoogleCalendar: true }, local: { googleSignedIn: true }, session: { googleAuthToken: 'tok' } });
    await bg.syncCalendarNow();
    assert.ok(bg.chrome.store.local.omnitimeCalSyncedAt);
  });
});

describe('Google Calendar sync request', () => {
  it('asks for default events only and a partial response (no attendees list, organiser, links)', async () => {
    const bg = load({ sync: { useGoogleCalendar: true }, local: { googleSignedIn: true }, session: { googleAuthToken: 'tok' } });
    await bg.syncCalendarNow();
    const call = bg.chrome.calls.fetches[0];
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
    assert.equal(url.searchParams.get('eventTypes'), 'default');
    const fields = url.searchParams.get('fields');
    assert.ok(fields.startsWith('items(') && fields.includes('attendees(self,responseStatus)') && fields.includes('nextPageToken'));
    ['organizer', 'creator', 'conferenceData', 'attachments', 'htmlLink'].forEach((f) => assert.ok(!fields.includes(f), f));
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
  });
  it('does not call Google without a token', async () => {
    const bg = load({ sync: { useGoogleCalendar: true } });
    const res = await bg.syncCalendarNow();
    assert.equal(res.success, false);
    assert.deepEqual(bg.chrome.calls.fetches, []);
  });
});
