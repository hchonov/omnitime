// PMs viewing a colleague's week: API client URLs (uid, people), the person
// picker (visible only with can_view_others; combobox keys, debounce,
// out-of-order answers), the read-only "Viewing ..." week, recent people in
// memory only, and the clickable names in "This issue" and the sidebar widget.
// All people are synthetic.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, makeEvent, settle, ymd, key } = require('./helpers');

const today = () => ymd(new Date());
const plain = (x) => JSON.parse(JSON.stringify(x));
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const mondayOf = (dateStr) => addDays(dateStr, -((new Date(dateStr + 'T00:00:00').getDay() + 6) % 7));

const CONTEXT = { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Current issue #14' };
const DANA = { uid: 101, name: 'Dana Example' };
const DANIEL = { uid: 102, name: 'Daniel Sample' };
const DARIUS = { uid: 103, name: 'Darius Demo' };

const ownWeek = (date, can) => ({
  date, daily_working_hours: 8,
  week_entries: [{ id: 1, date: mondayOf(date), start: '09:00', stop: '10:00', duration_minutes: 60, duration_label: '1:00', project: 'Alpha', issue_label: 'Build', issue_external_id: '9', comment: 'mine', editable: true }],
  absences: [],
  ...(can === 'omit' ? {} : { can_view_others: can }),
});
// A colleague's week: read-only entries, a half day absent on the Tuesday.
const otherWeek = (date, person, hours = 6) => ({
  date, daily_working_hours: hours,
  week_entries: [{ id: 50, date: mondayOf(date), start: '08:00', stop: '12:00', duration_minutes: 240, duration_label: '4:00', project: 'Beta', issue_label: 'Review', issue_external_id: '7', comment: 'theirs', editable: false, status: 'booked' }],
  absences: [{ date: addDays(mondayOf(date), 1), half_day: true, label: 'Absent' }],
  user: person, can_view_others: true,
});

function fakeApi({ can = true, over = {} } = {}) {
  const calls = [];
  const rec = (name, ret) => (...args) => {
    calls.push([name, ...args]);
    try { return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); } catch (e) { return Promise.reject(e); }
  };
  const byUid = { 101: DANA, 102: DANIEL, 103: DARIUS };
  const api = {
    calls,
    issueTime: rec('issueTime', { tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    myDay: rec('myDay', (date) => ({ date, week: [], week_total_label: '0:00', day_total_label: '0:00', entries: [] })),
    frequent: rec('frequent', { issues: [] }),
    search: rec('search', { issues: [] }),
    create: rec('create', { id: 9 }),
    update: rec('update', {}),
    remove: rec('remove', null),
    week: rec('week', (date, opts) => (opts && opts.uid != null
      ? (byUid[opts.uid] ? otherWeek(date, byUid[opts.uid]) : Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })))
      : ownWeek(date, can))),
    people: rec('people', (q) => ({ people: Object.values(byUid).filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) })),
    bookmarks: rec('bookmarks', { issues: [] }),
    bookmark: rec('bookmark', {}),
    unbookmark: rec('unbookmark', null),
  };
  Object.entries(over).forEach(([k, v]) => { api[k] = v === null ? undefined : rec(k, v); });
  return api;
}

async function open({ api = fakeApi(), activeTab = 'week', context = CONTEXT, person, store = {} } = {}) {
  const writes = [];
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { writes.push(JSON.stringify(obj)); Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
        remove: (keys, cb) => { [].concat(keys).forEach((k) => delete store[k]); if (cb) cb(); },
      },
      sync: { set: (obj) => { writes.push(JSON.stringify(obj)); } },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const modal = env.window.OmniTime.openModal({ apiClient: api, context: { ...context }, activeTab, person, settings: { dayStart: 8, dayEnd: 17 } });
  await settle();
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];
  const f = {
    ...env, root, api, writes, store, modal, q, qa,
    calls: (name) => api.calls.filter(([n]) => n === name),
    typing(el, value) {
      el.value = value;
      el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    },
    openPicker: async () => { q('.omnitime-wk__whobtn').click(); await settle(); },
    options: () => qa('.omnitime-wk__wholist [role="option"][data-idx]').map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
    // Open the picker, find colleagues for `text`, pick the nth result by mouse.
    async pickByTyping(text, name) {
      await f.openPicker();
      f.typing(q('.omnitime-wk__whoinput'), text);
      await settle(220);
      const opt = qa('.omnitime-wk__whoopt').find((o) => o.textContent.includes(name));
      opt.click();
      await settle();
    },
  };
  return f;
}

describe('API client: people + week uid', () => {
  const { window } = loadDom(['core.js']);
  const record = () => {
    const calls = [];
    return { calls, transport: (...args) => { calls.push(args); return Promise.resolve(null); } };
  };

  it('adds uid to the week request and derives /people from the tracked-time URL', () => {
    const { calls, transport } = record();
    const c = window.OmniTime.createApiClient(transport, 'https://times.example.test/api/v1/tracked-time');
    c.week('2026-01-14');
    c.week('2026-01-14', { uid: 101 });
    c.people('da n');
    assert.deepEqual(calls.map((a) => [a[0], a[1]]), [
      ['GET', 'https://times.example.test/api/v1/my-tracked-week?_format=json&date=2026-01-14'],
      ['GET', 'https://times.example.test/api/v1/my-tracked-week?_format=json&date=2026-01-14&uid=101'],
      ['GET', 'https://times.example.test/api/v1/people?_format=json&q=da%20n'],
    ]);
  });

  it('keeps If-None-Match next to uid and honours a people override', () => {
    const { calls, transport } = record();
    const c = window.OmniTime.createApiClient(transport, { trackedTime: 'https://a.test/api/v1/tracked-time', people: 'https://b.test/who' });
    c.week('2026-01-14', { uid: 5, ifNoneMatch: 'v1' });
    c.people('da');
    assert.equal(calls[0][1], 'https://a.test/api/v1/my-tracked-week?_format=json&date=2026-01-14&uid=5');
    assert.deepEqual(plain(calls[0][3]), { headers: { 'If-None-Match': 'v1' } });
    assert.equal(calls[1][1], 'https://b.test/who?_format=json&q=da');
  });

  it('survives a swappable client (people is part of the client)', () => {
    const { calls, transport } = record();
    const live = window.OmniTime.swappableClient(window.OmniTime.createApiClient(transport, 'https://a.test/api/v1/tracked-time'));
    live.client.people('da');
    assert.equal(calls[0][1], 'https://a.test/api/v1/people?_format=json&q=da');
  });
});

describe('person picker visibility', () => {
  it('is absent without can_view_others (regular users, old servers)', async () => {
    for (const can of [false, 'omit']) {
      const f = await open({ api: fakeApi({ can }) });
      assert.ok(f.q('.omnitime-wk__grid'), 'week loaded');
      assert.equal(f.q('.omnitime-wk__whobtn'), null);
      assert.equal(f.q('.omnitime-wk__who').hidden, true);
      assert.equal(f.q('.omnitime-wk__viewing').hidden, true);
    }
  });

  it('shows "You" at the start of the header with can_view_others', async () => {
    const f = await open();
    const btn = f.q('.omnitime-wk__whobtn');
    assert.equal(btn.textContent.replace(/\s+/g, ' ').trim(), 'You');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(f.q('.omnitime-wk__nav').firstElementChild, f.q('.omnitime-wk__who'));
  });
});

describe('person picker combobox', () => {
  it('lists "You" first, then recent people, and hints at typing', async () => {
    const f = await open();
    await f.openPicker();
    const input = f.q('.omnitime-wk__whoinput');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(f.q('.omnitime-wk__wholist').getAttribute('role'), 'listbox');
    assert.equal(document_activeIs(f, input), true);
    assert.deepEqual(f.options(), ['You (viewing)']);
    assert.match(f.q('.omnitime-wk__wholist').textContent, /2\+ letters/);
    assert.equal(f.calls('people').length, 0, 'nothing asked for an empty field');
  });

  it('debounces 150 ms and asks once for the final text, only from 2 characters', async () => {
    const f = await open();
    await f.openPicker();
    const input = f.q('.omnitime-wk__whoinput');
    f.typing(input, 'd');
    await settle(200);
    assert.equal(f.calls('people').length, 0, 'one character: no request');
    f.typing(input, 'da');
    await settle(50);
    f.typing(input, 'dan');
    await settle(100);
    assert.equal(f.calls('people').length, 0, 'still within the debounce');
    await settle(120);
    assert.deepEqual(f.calls('people'), [['people', 'dan']]);
    assert.deepEqual(f.options(), ['You (viewing)', 'Dana Example', 'Daniel Sample']);
  });

  it('ignores answers that arrive out of order', async () => {
    const pending = [];
    const api = fakeApi({ over: { people: (q) => new Promise((resolve) => pending.push({ q, resolve })) } });
    const f = await open({ api });
    await f.openPicker();
    const input = f.q('.omnitime-wk__whoinput');
    f.typing(input, 'da');
    await settle(200);
    f.typing(input, 'dan');
    await settle(200);
    assert.deepEqual(pending.map((p) => p.q), ['da', 'dan']);
    pending[1].resolve({ people: [DANIEL] });
    await settle();
    assert.deepEqual(f.options(), ['You (viewing)', 'Daniel Sample']);
    pending[0].resolve({ people: [DANA, DANIEL, DARIUS] }); // the older query answers last
    await settle();
    assert.deepEqual(f.options(), ['You (viewing)', 'Daniel Sample']);
  });

  it('drops an answer that arrives after the list was closed', async () => {
    const pending = [];
    const api = fakeApi({ over: { people: () => new Promise((resolve) => pending.push(resolve)) } });
    const f = await open({ api });
    await f.openPicker();
    f.typing(f.q('.omnitime-wk__whoinput'), 'da');
    await settle(200);
    key(f.window, f.q('.omnitime-wk__whoinput'), 'Escape');
    pending[0]({ people: [DANA] });
    await settle();
    assert.equal(f.q('.omnitime-wk__whopop').hidden, true);
    assert.equal(f.q('.omnitime-wk__wholist').children.length, 0);
  });

  it('works with the keyboard: arrows move (wrapping), Enter picks, Escape closes the list before the dialog', async () => {
    const f = await open();
    await f.openPicker();
    const input = f.q('.omnitime-wk__whoinput');
    f.typing(input, 'da');
    await settle(220);
    assert.deepEqual(f.options(), ['You (viewing)', 'Dana Example', 'Daniel Sample', 'Darius Demo']);
    assert.equal(key(f.window, input, 'ArrowDown'), false, 'default prevented');
    const active = () => f.qa('.omnitime-search__item--active').map((o) => o.textContent.replace(/\s+/g, ' ').trim());
    assert.deepEqual(active(), ['You (viewing)']);
    assert.equal(input.getAttribute('aria-activedescendant'), f.qa('.omnitime-wk__whoopt')[0].id);
    key(f.window, input, 'ArrowUp'); // wraps to the last
    assert.deepEqual(active(), ['Darius Demo']);
    key(f.window, input, 'ArrowUp');
    assert.deepEqual(active(), ['Daniel Sample']);
    key(f.window, input, 'Enter');
    await settle();
    assert.equal(f.q('.omnitime-wk__whopop').hidden, true);
    assert.deepEqual(f.calls('week').map((c) => c[2] && c[2].uid), [undefined, 102]);
    assert.match(f.q('.omnitime-wk__viewing').textContent, /Viewing Daniel Sample's week/);

    // Escape: the open list first, the dialog stays.
    await f.openPicker();
    key(f.window, f.q('.omnitime-wk__whoinput'), 'Escape');
    assert.equal(f.q('.omnitime-wk__whopop').hidden, true);
    assert.ok(f.q('.omnitime-modal'), 'dialog still open');
    assert.equal(f.root.activeElement, f.q('.omnitime-wk__whobtn'), 'focus back on the button');
    key(f.window, f.q('.omnitime-wk__whobtn'), 'Escape');
    assert.equal(f.document.querySelector('omnitime-root'), null, 'second Escape closes the dialog');
  });

  it('says so when the search fails or is not allowed', async () => {
    for (const [status, text] of [[500, 'Search unavailable'], [403, "can't view other people's weeks"]]) {
      const f = await open({ api: fakeApi({ over: { people: () => { throw Object.assign(new Error('x'), { status }); } } }) });
      await f.openPicker();
      f.typing(f.q('.omnitime-wk__whoinput'), 'da');
      await settle(220);
      assert.match(f.q('.omnitime-wk__wholist').textContent, new RegExp(text));
    }
  });

  it('closes when the focus leaves it', async () => {
    const f = await open();
    await f.openPicker();
    f.q('.omnitime-wk__nav [data-nav="next"]').focus();
    await settle(30);
    assert.equal(f.q('.omnitime-wk__whopop').hidden, true);
  });
});

describe('viewing a colleague', () => {
  it('loads their week with the uid, shows the bar, and is read-only', async () => {
    const f = await open();
    await f.pickByTyping('da', 'Dana Example');
    const monday = mondayOf(today());
    assert.deepEqual(plain(f.calls('week').pop().slice(1)), [monday, { uid: 101 }]);
    assert.equal(f.q('.omnitime-wk__whobtn').textContent.replace(/\s+/g, ' ').trim(), 'Dana Example');
    const bar = f.q('.omnitime-wk__viewing');
    assert.equal(bar.hidden, false);
    assert.equal(bar.textContent.replace(/\s+/g, ' ').trim(), "Viewing Dana Example's week");
    assert.equal(bar.querySelector('button').getAttribute('aria-label'), 'Back to your week');
    // Read-only: heads are not buttons and do nothing, no lock glyphs / booked style.
    const heads = f.qa('.omnitime-wk__head');
    assert.ok(heads.length >= 5);
    assert.equal(f.qa('button.omnitime-wk__head').length, 0);
    heads[0].click();
    assert.equal(f.q('.omnitime-tab--active').dataset.tab, 'week', 'no My day for others');
    assert.equal(f.qa('.omnitime-wk__entry--booked').length, 0);
    assert.equal(f.qa('.omnitime-wk__entry .ot-svg--lock').length, 0);
    assert.match(f.q('.omnitime-wk__entry').textContent, /Review/);
    // The half-day absence shows as the neutral chip, with their working hours as the target.
    const tuesday = f.q(`.omnitime-wk__day[data-date="${addDays(monday, 1)}"]`);
    assert.equal(tuesday.querySelector('.omnitime-absent').textContent.replace(/\s+/g, ' ').trim(), 'Absent ½(half day)');
    assert.match(f.q(`.omnitime-wk__day[data-date="${monday}"] .omnitime-wk__total`).textContent, /4:00\s*\/\s*6:00/);
    assert.match(tuesday.querySelector('.omnitime-wk__total').textContent, /0:00\s*\/\s*3:00/);
  });

  it('prev / next / This week keep the person', async () => {
    const f = await open();
    await f.pickByTyping('da', 'Dana Example');
    const monday = mondayOf(today());
    f.q('[data-nav="next"]').click();
    await settle();
    f.q('[data-nav="prev"]').click();
    await settle();
    f.q('[data-nav="prev"]').click();
    await settle();
    f.q('[data-nav="this"]').click();
    await settle();
    const uids = f.calls('week').map((c) => c[2] && c[2].uid);
    assert.deepEqual(uids, [undefined, 101, 101, 101]); // next, prev (cached), prev -> 3 requests
    assert.deepEqual(f.calls('week').map((c) => c[1]).slice(1), [monday, addDays(monday, 7), addDays(monday, -7)]);
    assert.match(f.q('.omnitime-wk__viewing').textContent, /Dana Example/);
    assert.equal(f.q('.omnitime-wk__grid').closest('.omnitime-wk--others') !== null, true);
  });

  it('× and picking "You" return to the own week (cached, editable heads again)', async () => {
    const f = await open();
    await f.pickByTyping('da', 'Dana Example');
    f.q('.omnitime-wk__viewing button').click();
    await settle();
    assert.equal(f.q('.omnitime-wk__viewing').hidden, true);
    assert.equal(f.q('.omnitime-wk__whobtn').textContent.replace(/\s+/g, ' ').trim(), 'You');
    assert.equal(f.calls('week').length, 2, 'the own week came from the cache');
    assert.ok(f.qa('button.omnitime-wk__head').length >= 5);
    assert.equal(f.root.activeElement, f.q('.omnitime-wk__whobtn'));

    await f.openPicker();
    f.qa('.omnitime-wk__whoopt').find((o) => o.textContent.includes('Dana')).click();
    await settle();
    assert.equal(f.calls('week').length, 2, 'the colleague week was cached too (keyed by uid)');
    f.q('.omnitime-wk__whobtn').click();
    await settle();
    f.qa('.omnitime-wk__whoopt')[0].click(); // "You"
    await settle();
    assert.equal(f.q('.omnitime-wk__viewing').hidden, true);
  });

  it('keeps recent people, newest first, filtered by the typed text, across modals', async () => {
    const f = await open();
    await f.pickByTyping('dana', 'Dana Example');
    await f.pickByTyping('darius', 'Darius Demo');
    await f.openPicker();
    assert.deepEqual(f.options(), ['You', 'Darius Demo (viewing)', 'Dana Example']);
    assert.match(f.q('.omnitime-wk__wholist').textContent, /Recently viewed/);
    f.typing(f.q('.omnitime-wk__whoinput'), 'dan');
    assert.deepEqual(f.options(), ['You', 'Dana Example'], 'filtered locally before the answer');
    await settle(220);
    assert.deepEqual(f.options(), ['You', 'Dana Example', 'Daniel Sample'], 'API result added, the recent one not repeated');
    // A new modal (same browser) still offers them.
    const g = await open({ store: f.store });
    await g.openPicker();
    assert.deepEqual(g.options(), ['You (viewing)', 'Darius Demo', 'Dana Example']);
    assert.deepEqual(f.store.omnitimeRecentPeople, [{ uid: 103, name: 'Darius Demo' }, { uid: 101, name: 'Dana Example' }]);
  });

  it('keeps at most 10 recent people', async () => {
    const store = { omnitimeRecentPeople: Array.from({ length: 12 }, (_, i) => ({ uid: 500 + i, name: `Person ${i}` })) };
    const f = await open({ store });
    await f.openPicker();
    assert.equal(f.options().length, 11, 'You + 10');
  });

  it('forgets recent people when the caller may no longer view others', async () => {
    const store = { omnitimeRecentPeople: [{ uid: 101, name: 'Dana Example' }] };
    await open({ api: fakeApi({ can: false }), store });
    assert.equal(store.omnitimeRecentPeople, undefined);
  });

  it('writes nothing about other people to chrome.storage but the recent list', async () => {
    const f = await open();
    await f.pickByTyping('da', 'Dana Example');
    f.q('[data-nav="next"]').click();
    await settle();
    f.q('.omnitime-wk__weekend')?.click();
    f.q('.omnitime-wk__viewing button').click();
    await settle();
    const blob = f.writes.filter((w) => !w.startsWith('{"omnitimeRecentPeople"')).join('|');
    assert.doesNotMatch(blob, /Dana|Daniel|101|uid|people|Review|theirs/i);
    assert.deepEqual(Object.keys(JSON.parse(f.writes.find((w) => w.includes('Dana')))), ['omnitimeRecentPeople']);
  });

  it('shows a clear state for an unknown user and a way back', async () => {
    const f = await open({ person: { uid: 999, name: 'Nobody Example' } });
    assert.match(f.q('.omnitime-wk__body').textContent, /wasn't found/);
    f.q('.omnitime-wk__back').click();
    await settle();
    assert.ok(f.q('.omnitime-wk__grid'));
    assert.equal(f.q('.omnitime-wk__viewing').hidden, true);
  });

  it('does not treat a 404 for a person as a missing endpoint', async () => {
    const f = await open({ person: { uid: 999, name: 'Nobody Example' } });
    f.q('.omnitime-wk__back').click();
    await settle();
    assert.ok(f.q('.omnitime-wk__grid'), 'the own week still loads');
  });

  it('has no picker and no uid request on a server without the people API (client without people)', async () => {
    const f = await open({ api: fakeApi({ over: { people: null } }) });
    await f.openPicker();
    f.typing(f.q('.omnitime-wk__whoinput'), 'da');
    await settle(220);
    assert.equal(f.calls('people').length, 0);
    assert.deepEqual(f.options(), ['You (viewing)']);
  });
});

describe('clickable names in "This issue"', () => {
  const rows = [
    { user: 'Fay Example', time_spent: 60, self: true, uid: 100 },
    { user: 'Dana Example', time_spent: 120, self: false, uid: 101 },
    { user: 'Others', time_spent: 30, self: false, others: true },
  ];
  const issue = (tracked) => ({ tracked_time: tracked, total_sum: 210, details: [], issue: { open: true } });

  it('turns rows with a uid (not you, not "Others") into buttons that open the Week tab on them', async () => {
    const f = await open({ activeTab: 'issue', api: fakeApi({ over: { issueTime: issue(rows) } }) });
    const links = f.qa('.omnitime-personlink');
    assert.deepEqual(links.map((b) => b.textContent), ['Dana Example']);
    assert.equal(links[0].getAttribute('aria-label'), "Open Dana Example's week");
    assert.match(f.q('.omnitime-table').textContent, /Fay Example \(you\)/);
    links[0].click();
    await settle();
    assert.equal(f.q('.omnitime-tab--active').dataset.tab, 'week');
    assert.deepEqual(plain(f.calls('week').pop().slice(1)), [mondayOf(today()), { uid: 101 }]);
    assert.match(f.q('.omnitime-wk__viewing').textContent, /Viewing Dana Example's week/);
    assert.equal(f.q('.omnitime-wk__whobtn').textContent.replace(/\s+/g, ' ').trim(), 'Dana Example');
  });

  it('opens on the current week even when My day shows another day', async () => {
    const f = await open({ activeTab: 'issue', api: fakeApi({ over: { issueTime: issue(rows) } }) });
    f.q('.omnitime-tab[data-tab="myday"]').click();
    await settle();
    f.q('.omnitime-tab[data-tab="issue"]').click();
    await settle();
    f.q('.omnitime-personlink').click();
    await settle();
    assert.equal(f.calls('week').pop()[1], mondayOf(today()));
  });

  it('leaves names alone for regular users (no uid in the rows)', async () => {
    const f = await open({ activeTab: 'issue', api: fakeApi({ over: { issueTime: issue([{ user: 'Fay Example', time_spent: 60, self: true }, { user: 'Others', time_spent: 30, others: true }]) } }) });
    assert.equal(f.qa('.omnitime-personlink').length, 0);
  });

  it('openModal({ person }) opens the Week tab on that person', async () => {
    const f = await open({ activeTab: 'issue', person: DANA });
    assert.equal(f.q('.omnitime-tab--active').dataset.tab, 'week');
    assert.deepEqual(plain(f.calls('week')[0].slice(1)), [mondayOf(today()), { uid: 101 }]);
    assert.match(f.q('.omnitime-wk__viewing').textContent, /Dana Example/);
    assert.equal(f.q('.omnitime-wk__whobtn').textContent.replace(/\s+/g, ' ').trim(), 'Dana Example');
  });
});

describe('clickable names in the sidebar widget', () => {
  async function widgetWith(tracked, { onOpenPerson = true } = {}) {
    const env = loadDom(['ical-parser.js', 'core.js', 'sidebar-widget.js'], { chrome: { runtime: { sendMessage: (m, cb) => cb && cb({ success: true }) } } });
    const target = env.document.createElement('div');
    env.document.body.appendChild(target);
    const opened = [];
    const api = {
      issueTime: async () => ({ total_sum: 300, own_sum: 60, tracked_time: tracked, details: [], issue: { open: true } }),
      myDay: async (date) => ({ date, entries: [], day_total_minutes: 0 }),
      create: async () => ({ id: 1 }), remove: async () => null,
    };
    const widget = env.window.OmniTimeSidebar.attach(target, {
      apiClient: api, context: { source: 'https://git.example.test', project_id: '3', issue_id: '14' },
      expanded: true, ...(onOpenPerson ? { onOpenPerson: (p) => opened.push(plain(p)) } : {}),
    });
    await settle();
    return { root: widget.host.shadowRoot, opened };
  }
  const tracked = [
    { user: 'Dana Example', time_spent: 120, self: false, uid: 101 },
    { user: 'Fay Example', time_spent: 60, self: true, uid: 100 },
    { user: 'Daniel Sample', time_spent: 90, self: false, uid: 102 },
    { user: 'Others', time_spent: 30, self: false, others: true },
  ];

  it('makes other people with a uid buttons that open their week; "You" and "Others" stay text', async () => {
    const { root, opened } = await widgetWith(tracked);
    const links = [...root.querySelectorAll('button.omnitime-sw__name')];
    assert.deepEqual(links.map((b) => b.textContent), ['Dana Example', 'Daniel Sample']);
    assert.equal(links[0].getAttribute('aria-label'), "Open Dana Example's week");
    links[1].click();
    assert.deepEqual(opened, [{ uid: 102, name: 'Daniel Sample' }]);
    assert.equal(root.querySelectorAll('span.omnitime-sw__name').length, 2); // You, Others
  });

  it('shows plain names without uids or without a handler', async () => {
    const noUid = await widgetWith(tracked.map(({ uid, ...r }) => r));
    assert.equal(noUid.root.querySelectorAll('button.omnitime-sw__name').length, 0);
    const noHandler = await widgetWith(tracked, { onOpenPerson: false });
    assert.equal(noHandler.root.querySelectorAll('button.omnitime-sw__name').length, 0);
  });
});

// jsdom: the focused element of the shadow root.
function document_activeIs(f, el) {
  return f.root.activeElement === el;
}
