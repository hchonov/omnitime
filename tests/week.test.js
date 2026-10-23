// Starred issues (bookmarks), the Week tab and absences: API client URLs,
// optimistic star toggle with rollback, the empty-query Starred / Recent /
// Frequent list, week math + grouping, the absence chip in My day's strip, and
// that absences never reach chrome.storage.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, makeEvent, settle, ymd } = require('./helpers');

const today = () => ymd(new Date());
// Objects from the jsdom realm, compared by value.
const plain = (x) => JSON.parse(JSON.stringify(x));
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const mondayOf = (dateStr) => addDays(dateStr, -((new Date(dateStr + 'T00:00:00').getDay() + 6) % 7));

const CONTEXT = { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Current issue #14' };
const ISSUES = [
  { issue_internal_id: 55, issue_external_id: '5', label: 'Sync', project: 'P', milestone: 'M1', bookmarked: false },
  { issue_internal_id: 56, issue_external_id: '6', label: 'Planning', project: 'P', bookmarked: true },
];
const FREQUENT = [
  { issue_internal_id: 1, issue_external_id: '1', label: 'Daily', project: 'P', suggested_minutes: 15, suggested_label: '0:15' },
  { issue_internal_id: 56, issue_external_id: '6', label: 'Planning', project: 'P', suggested_minutes: 30, suggested_label: '0:30' },
  { issue_internal_id: 2, issue_external_id: '2', label: 'Retainer', project: 'R', suggested_minutes: 30, suggested_label: '0:30' },
];
const STARRED = [{ issue_internal_id: 56, issue_external_id: '6', label: 'Planning', project: 'P', milestone: 'M1', bookmarked: true }];

// A week for the fake API: one entry today and on Monday, absences on the
// Monday (full), the Tuesday (half) and the Sunday (ignored: weekend).
function weekFor(date) {
  const mon = mondayOf(date);
  return {
    date,
    daily_working_hours: 8,
    week_entries: [
      { id: 1, date: mon, start: '10:00', stop: '11:00', duration_minutes: 60, duration_label: '1:00', project: 'Alpha', issue_label: 'Alpha / Build', issue_external_id: '9', comment: 'Later one' },
      { id: 2, date: mon, start: '08:00', stop: '08:30', duration_minutes: 30, duration_label: '0:30', project: 'Beta', issue_label: 'Sync', issue_external_id: '5', comment: '' },
      { id: 3, date: addDays(mon, 2), start: '09:00', stop: '13:00', duration_minutes: 240, duration_label: '4:00', project: 'Alpha', issue_label: 'Build', issue_external_id: '9', comment: 'Wed' },
    ],
    absences: [
      { date: mon, half_day: false, label: 'Absent' },
      { date: addDays(mon, 1), half_day: true, label: 'Absent' },
      { date: addDays(mon, 6), half_day: false, label: 'Absent' },
    ],
  };
}

function fakeApi(over = {}) {
  const calls = [];
  const rec = (name, ret) => (...args) => {
    calls.push([name, ...args]);
    try {
      return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const api = {
    calls,
    issueTime: rec('issueTime', { tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    myDay: rec('myDay', (date) => {
      const mon = mondayOf(date);
      const week = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ label: 'x', date: addDays(mon, i), total_minutes: i === 0 ? 90 : i === 2 ? 240 : 0, total_label: '0:00', active: addDays(mon, i) === date }));
      return { date, week, week_total_label: '5:30', day_total_label: '0:00', entries: [] };
    }),
    frequent: rec('frequent', { issues: FREQUENT }),
    search: rec('search', { issues: ISSUES }),
    create: rec('create', { id: 9 }),
    update: rec('update', {}),
    remove: rec('remove', null),
    week: rec('week', (date) => weekFor(date)),
    bookmarks: rec('bookmarks', { issues: STARRED }),
    bookmark: rec('bookmark', (id) => ({ issue_internal_id: id, bookmarked: true })),
    unbookmark: rec('unbookmark', null),
  };
  Object.entries(over).forEach(([k, v]) => { api[k] = v === null ? undefined : rec(k, v); });
  return api;
}

async function open({ api = fakeApi(), local = {}, context = CONTEXT, activeTab = 'myday' } = {}) {
  const store = { ...local };
  const writes = [];
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { writes.push(JSON.stringify(obj)); Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const modal = env.window.OmniTime.openModal({ apiClient: api, context: { ...context }, activeTab, settings: { dayStart: 8, dayEnd: 17 } });
  await settle();
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  return {
    ...env, root, api, store, writes, modal, q,
    calls: (name) => api.calls.filter(([n]) => n === name),
    typing(el, value) {
      el.value = value;
      el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    },
  };
}

async function openSearch(opts) {
  const f = await open(opts);
  f.q('.omnitime-add-btn').click();
  f.search = f.q('.omnitime-search__input');
  return f;
}
const groupTitles = (f) => [...f.root.querySelectorAll('.omnitime-search__group')].map((g) => g.textContent);
const labels = (f) => [...f.root.querySelectorAll('.omnitime-search__results [role="option"]')].map((o) => o.dataset.label);

describe('API client: bookmarks + week', () => {
  const { window } = loadDom(['core.js']);
  const record = () => {
    const calls = [];
    return { calls, transport: (...args) => { calls.push(args); return Promise.resolve(null); } };
  };

  it('derives the new endpoints from the tracked-time URL', () => {
    const { calls, transport } = record();
    const c = window.OmniTime.createApiClient(transport, 'https://times.example.test/api/v1/tracked-time');
    c.week('2026-01-14');
    c.bookmarks();
    c.bookmark(12345);
    c.unbookmark(12345);
    assert.deepEqual(calls.map((a) => [a[0], a[1]]), [
      ['GET', 'https://times.example.test/api/v1/my-tracked-week?_format=json&date=2026-01-14'],
      ['GET', 'https://times.example.test/api/v1/my-bookmarks?_format=json'],
      ['POST', 'https://times.example.test/api/v1/bookmark?_format=json'],
      ['DELETE', 'https://times.example.test/api/v1/bookmark/12345?_format=json'],
    ]);
    assert.deepEqual(plain(calls[2][2]), { issue_internal_id: 12345 });
    assert.equal(calls[0].length, 2, 'no extra transport args without ifNoneMatch');
  });

  it('honours overrides and passes If-None-Match to the transport', () => {
    const { calls, transport } = record();
    const c = window.OmniTime.createApiClient(transport, {
      trackedTime: 'https://a.test/api/v1/tracked-time',
      week: 'https://b.test/w',
      bookmarks: 'https://b.test/bm',
      bookmark: 'https://b.test/b/',
    });
    c.week('2026-01-14', { ifNoneMatch: 'v7' });
    c.bookmarks();
    c.unbookmark(5);
    assert.equal(calls[0][1], 'https://b.test/w?_format=json&date=2026-01-14');
    assert.deepEqual(plain(calls[0][3]), { headers: { 'If-None-Match': 'v7' } });
    assert.equal(calls[1][1], 'https://b.test/bm?_format=json');
    assert.equal(calls[2][1], 'https://b.test/b/5?_format=json');
  });
});

describe('week math', () => {
  const { window } = loadDom(['core.js']);
  const { weekMonday, groupWeek } = window.OmniTime;

  it('finds the Monday across month and year boundaries and DST changes (Europe/Berlin)', () => {
    const table = [
      ['2026-10-19', '2026-10-19'], ['2026-10-25', '2026-10-19'], // Sunday of the DST end
      ['2026-10-26', '2026-10-26'], ['2026-11-01', '2026-10-26'], // month boundary
      ['2027-01-01', '2026-12-28'], ['2027-01-03', '2026-12-28'], // year boundary
      ['2026-03-29', '2026-03-23'], ['2026-03-30', '2026-03-30'], // DST start
      ['2024-02-29', '2024-02-26'], ['2024-03-03', '2024-02-26'], // leap day
    ];
    for (const [date, monday] of table) assert.equal(weekMonday(date), monday, date);
  });

  it('lists seven consecutive days even across a DST change', () => {
    const w = groupWeek({ date: '2026-10-22', week_entries: [], absences: [] });
    assert.deepEqual(plain(w.days.map((d) => d.date)), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    const s = groupWeek({ date: '2026-03-29' });
    assert.deepEqual(plain(s.days.map((d) => d.date)), ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']);
    const y = groupWeek({ date: '2026-12-31' });
    assert.equal(y.days[6].date, '2027-01-03');
  });

  it('groups entries by day (sorted by start), totals, targets and absence credit', () => {
    const w = groupWeek(weekFor('2026-10-22'));
    const [mon, tue, wed, thu, , sat, sun] = w.days;
    assert.deepEqual(plain(mon.entries.map((e) => e.id)), [2, 1], 'by start time');
    assert.equal(mon.total, 90);
    assert.equal(wed.total, 240);
    assert.equal(w.total, 330);
    assert.equal(w.target, 480);
    assert.deepEqual(plain(mon.absence), { half_day: false });
    assert.equal(mon.target, 0, 'full-day absence: no target');
    assert.deepEqual(plain(tue.absence), { half_day: true });
    assert.equal(tue.target, 240, 'half-day absence: half the target');
    assert.equal(thu.target, 480);
    assert.equal(sat.target, 0, 'no target on Saturday');
    assert.equal(sun.target, 0);
    assert.equal(sun.absence, null, 'weekend absences are ignored');
    assert.equal(w.targetTotal, 0 + 240 + 480 + 480 + 480);
  });

  it('uses daily_working_hours, falls back to 8 h, and merges two items on one date', () => {
    const w = groupWeek({ date: '2026-10-22', daily_working_hours: 6, absences: [] });
    assert.equal(w.days[0].target, 360);
    assert.equal(groupWeek({ date: '2026-10-22' }).days[0].target, 480);
    const m = groupWeek({ date: '2026-10-22', absences: [{ date: '2026-10-20', half_day: true }, { date: '2026-10-20', half_day: true }] });
    assert.deepEqual(plain(m.days[1].absence), { half_day: false });
    assert.equal(m.days[1].target, 0);
  });
});

describe('starred issues', () => {
  it('lists Starred, then Recent, then Frequent on an empty query (each issue once)', async () => {
    const f = await openSearch({ local: { omnitimeRecentIssues: [{ issue_id: 56, label: 'Planning #6' }, { issue_id: 1, label: 'Daily #1' }] } });
    f.search.focus();
    await settle();
    assert.deepEqual(groupTitles(f), ['Starred', 'Recent', 'Frequent']);
    assert.deepEqual(labels(f), ['Planning #6', 'Daily #1', 'Retainer #2']);
    const star = f.q('.omnitime-search__results .omnitime-star');
    assert.equal(star.getAttribute('aria-pressed'), 'true');
    assert.equal(star.textContent, '★');
    assert.match(star.getAttribute('aria-label'), /^Star Planning #6/);
    assert.equal(f.calls('bookmarks').length, 1);
  });

  it('caches my-bookmarks per modal open', async () => {
    const f = await openSearch();
    f.search.focus();
    await settle();
    f.search.blur();
    f.q('.omnitime-search').dispatchEvent(new f.window.FocusEvent('focusout', { bubbles: true }));
    f.search.focus();
    f.search.click();
    await settle();
    assert.equal(f.calls('bookmarks').length, 1);
  });

  it('marks starred search results and stars one optimistically', async () => {
    const f = await openSearch();
    f.search.focus();
    f.typing(f.search, 'sy');
    await settle(200);
    const stars = [...f.root.querySelectorAll('.omnitime-search__results .omnitime-star')];
    assert.deepEqual(stars.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
    assert.equal(stars[0].tabIndex, -1, 'focus stays in the combobox');
    stars[0].click();
    assert.equal(stars[0].getAttribute('aria-pressed'), 'true', 'flipped before the response');
    assert.deepEqual(f.calls('bookmark').map((c) => c[1]), [55]);
    await settle();
    // Cleared query: the new star is listed first.
    f.typing(f.search, '');
    await settle();
    assert.deepEqual(groupTitles(f).slice(0, 1), ['Starred']);
    assert.deepEqual(labels(f).slice(0, 2), ['Sync #5', 'Planning #6']);
  });

  it('rolls the star back and says so when the request fails', async () => {
    const api = fakeApi({ unbookmark: () => { throw Object.assign(new Error('nope'), { status: 500 }); } });
    const f = await openSearch({ api });
    f.search.focus();
    await settle();
    const star = f.q('.omnitime-search__results .omnitime-star');
    star.click();
    assert.equal(star.getAttribute('aria-pressed'), 'false', 'optimistic');
    await settle();
    assert.equal(star.getAttribute('aria-pressed'), 'true', 'rolled back');
    assert.match(f.q('.omnitime-toast__msg').textContent, /Couldn't update the star/);
    f.search.blur();
    f.typing(f.search, 'x');
    f.typing(f.search, '');
    await settle();
    assert.deepEqual(groupTitles(f)[0], 'Starred', 'still starred');
  });

  it('stars the picked issue from the target chip (keyboard path)', async () => {
    const f = await openSearch();
    f.search.focus();
    f.typing(f.search, 'sy');
    await settle(200);
    f.q('.omnitime-search__results .omnitime-search__item').click();
    const chipStar = f.q('.omnitime-target__star');
    assert.equal(chipStar.hidden, false);
    assert.equal(chipStar.getAttribute('aria-pressed'), 'false');
    assert.ok(chipStar.tabIndex >= 0);
    chipStar.click();
    assert.equal(chipStar.getAttribute('aria-pressed'), 'true');
    await settle();
    assert.deepEqual(f.calls('bookmark').map((c) => c[1]), [55]);
    // The current issue (no internal id) has no star.
    f.q('.omnitime-target__reset').click();
    assert.equal(chipStar.hidden, true);
  });

  it('offers no stars when the server has no bookmarks endpoint', async () => {
    const api = fakeApi({ bookmarks: () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
    const f = await openSearch({ api });
    f.search.focus();
    await settle();
    assert.deepEqual(groupTitles(f), ['Frequent']);
    assert.equal(f.q('.omnitime-search__results .omnitime-star'), null);
  });
});

describe('Week tab', () => {
  it('shows Monday-Sunday with entries, totals vs target and absence chips', async () => {
    const f = await open();
    const tab = f.q('#omnitime-tab-week');
    assert.ok(tab, 'Week tab present');
    tab.click();
    await settle();
    // An empty weekend is hidden until asked for ("Show weekend").
    const btn = f.q('.omnitime-wk__weekend');
    assert.equal(f.root.querySelectorAll('.omnitime-wk__day').length, 5);
    assert.equal(btn.hidden, false);
    assert.equal(btn.textContent, 'Show weekend');
    btn.click();
    await settle();
    assert.equal(btn.textContent, 'Hide weekend');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    const days = [...f.root.querySelectorAll('.omnitime-wk__day')];
    assert.equal(days.length, 7);
    assert.equal(days[0].dataset.date, mondayOf(today()));
    assert.equal(days[0].querySelector('.omnitime-wk__total').textContent, '1:30', 'full-day absence: no target shown');
    assert.equal(days[0].querySelector('.omnitime-absent').textContent, 'Absent');
    assert.match(days[1].querySelector('.omnitime-absent').textContent, /Absent ½/);
    assert.equal(days[1].querySelector('.omnitime-wk__total').textContent.replace(/\s+/g, ' ').trim(), '0:00 / 4:00');
    assert.equal(days[3].querySelector('.omnitime-wk__total').textContent.replace(/\s+/g, ' ').trim(), '0:00 / 8:00');
    assert.equal(days[5].querySelector('.omnitime-wk__of'), null, 'no target on Saturday');
    assert.equal(days[6].querySelector('.omnitime-absent'), null, 'weekend absence not shown');
    const cards = [...days[0].querySelectorAll('.omnitime-wk__entry')];
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, /08:00–08:30/);
    assert.match(cards[1].className, /omnitime-wk__entry--p\d/);
    assert.match(f.q('.omnitime-wk__sum').textContent.replace(/\s+/g, ' '), /Total 5:30 \/ 28:00/);
  });

  it('pages weeks (one request per week, cached) and opens a day in My day', async () => {
    const f = await open();
    f.q('#omnitime-tab-week').click();
    await settle();
    const weeksBefore = f.calls('week').length;
    f.q('.omnitime-wk [data-nav="prev"]').click();
    await settle();
    assert.equal(f.q('.omnitime-wk__day').dataset.date, addDays(mondayOf(today()), -7));
    assert.equal(f.q('.omnitime-wk [data-nav="this"]').disabled, false);
    f.q('.omnitime-wk [data-nav="next"]').click();
    await settle();
    assert.equal(f.calls('week').length, weeksBefore + 1, 'the current week came from the cache');
    const wed = f.root.querySelectorAll('.omnitime-wk__head')[2];
    wed.click();
    await settle();
    const wedDate = addDays(mondayOf(today()), 2);
    assert.equal(f.q('#omnitime-tab-myday').getAttribute('aria-selected'), 'true');
    assert.equal(f.calls('myDay').at(-1)[1], wedDate);
  });

  it('refetches a cached week once My day shows different totals', async () => {
    const f = await open();
    f.q('#omnitime-tab-week').click();
    await settle();
    const n = f.calls('week').length;
    // My day reports another total for Monday than the cached week has.
    f.api.myDay = (date) => {
      f.api.calls.push(['myDay', date]);
      return Promise.resolve({ date, week: [{ date: mondayOf(today()), total_minutes: 999, total_label: 'x' }], entries: [] });
    };
    f.q('#omnitime-tab-myday').click();
    await settle();
    f.q('#omnitime-tab-week').click();
    await settle();
    assert.equal(f.calls('week').length, n + 1);
  });

  it('has no Week tab without the client method', async () => {
    const f = await open({ api: fakeApi({ week: null }) });
    assert.equal(f.q('#omnitime-tab-week'), null);
    assert.ok(f.q('#omnitime-tab-myday'));
  });

  it('shows My day + Week tabs without an issue context', async () => {
    const f = await open({ context: {} });
    assert.equal(f.q('#omnitime-tab-issue'), null);
    assert.ok(f.q('#omnitime-tab-week'));
  });
});

describe('absences in My day', () => {
  it('marks the strip lazily with one week request, and exposes state.absenceFor', async () => {
    const f = await open();
    await settle();
    const mon = mondayOf(today());
    const cell = (d) => f.q(`.omnitime-week__day[data-date="${d}"]`);
    assert.equal(cell(mon).querySelector('.omnitime-absent').textContent, 'Absent');
    assert.ok(cell(mon).classList.contains('omnitime-week__day--absent'), 'dimmed');
    assert.match(cell(mon).getAttribute('aria-label'), /, absent$/);
    assert.match(cell(addDays(mon, 1)).querySelector('.omnitime-absent').textContent, /½/);
    assert.equal(cell(addDays(mon, 3)).querySelector('.omnitime-absent'), null);
    assert.equal(cell(addDays(mon, 6)).querySelector('.omnitime-absent'), null, 'weekend');
    // Paging days within the week: no new week request.
    cell(addDays(mon, 3)).click();
    await settle();
    cell(addDays(mon, 4)).click();
    await settle();
    assert.equal(f.calls('week').length, 1);
    assert.ok(cell(mon).querySelector('.omnitime-absent'), 'chip shown on rebuild from the cache');
  });

  it('never writes absences to chrome.storage', async () => {
    const f = await openSearch({ local: { omnitimeRecentIssues: [] } });
    f.q('#omnitime-tab-week').click();
    await settle();
    f.q('.omnitime-wk [data-nav="prev"]').click();
    await settle();
    f.q('#omnitime-tab-myday').click();
    await settle();
    // Book an entry (writes the recent list) to have at least one write.
    f.q('.omnitime-add-btn').click();
    f.q('.omnitime-f-start').value = '11:30';
    f.q('.omnitime-save').click();
    await settle();
    assert.ok(f.calls('week').length >= 2);
    assert.ok(f.writes.length >= 1);
    for (const w of f.writes) assert.doesNotMatch(w, /absen|half_day|Absent/i);
  });

  it('keeps the strip as is when the week endpoint is missing', async () => {
    const f = await open({ api: fakeApi({ week: () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } }) });
    await settle();
    assert.equal(f.q('.omnitime-absent'), null);
    assert.equal(f.errors.length, 0);
  });
});
