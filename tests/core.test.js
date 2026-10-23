const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, pointer, settle, icsStamp } = require('./helpers');

const ENTRY = {
  id: 7, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30',
  project: 'Internal', issue_label: 'Internal / Standup', issue_external_id: '12',
  issue_internal_id: 1200, comment: '', status: 'unbooked', editable: true,
};

// A floating-time .ics feed with the given [title, startH, startM, endH, endM, uid?]
// events on today's date (the modal always opens on today).
function icsToday(events) {
  const today = new Date();
  return [
    'BEGIN:VCALENDAR',
    ...events.flatMap(([title, sh, sm, eh, em, uid]) => [
      'BEGIN:VEVENT', ...(uid ? [`UID:${uid}`] : []), `SUMMARY:${title}`, `DTSTART:${icsStamp(today, sh, sm)}`, `DTEND:${icsStamp(today, eh, em)}`, 'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

function fakeApi(entries, { searchIssues = [] } = {}) {
  const calls = [];
  const rec = (name, ret) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret);
  };
  return {
    calls,
    issueTime: rec('issueTime', { tracked_time: [{ user: 'Alex', time_spent: 90 }], total_sum: 90, details: [], issue: { open: true } }),
    myDay: rec('myDay', (date) => ({
      date,
      week: [{ label: 'M', date, total_minutes: 30, total_label: '0:30', active: true }],
      week_total_label: '0:30',
      day_total_label: '0:30',
      entries,
    })),
    frequent: rec('frequent', { issues: [] }),
    search: rec('search', { issues: searchIssues }),
    create: rec('create', { id: 9 }),
    update: rec('update', {}),
    remove: rec('remove', null),
  };
}

async function openMyDay({ icalRaw, entries = [ENTRY], local = {}, searchIssues, context = {} } = {}) {
  const onChanged = makeEvent();
  // chrome.storage.local backed by `store` (calendar feed + calendar memory).
  const store = { icalRaw, ...local };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged,
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const api = fakeApi(entries, { searchIssues });
  env.window.OmniTime.openModal({
    apiClient: api,
    context,
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: 'myday',
    settings: { dayStart: 8, dayEnd: 17 },
  });
  await settle();
  return { ...env, root: uiRoot(env.document), api, onChanged, store };
}

const calBlocks = (root) => [...root.querySelectorAll('.omnitime-tl__cal-event')];
const calTitle = (block) => block.querySelector('.omnitime-tl__cal-title span').textContent;
const calBlock = (root, title) => calBlocks(root).find((b) => calTitle(b) === title);

// Drag an element vertically by `dy` pixels.
function drag(window, el, dy) {
  pointer(window, el, 'pointerdown', 100);
  pointer(window, el, 'pointermove', 100 + dy / 2);
  pointer(window, el, 'pointermove', 100 + dy);
  pointer(window, el, 'pointerup', 100 + dy);
}

describe('createApiClient', () => {
  function client(urls) {
    const { window } = loadDom(['core.js']);
    const calls = [];
    const api = window.OmniTime.createApiClient((method, url, body) => {
      calls.push([method, url, body]);
      return Promise.resolve({});
    }, urls);
    return { api, calls };
  }

  it('asks booking-suggestions with the meeting title, start and day (overridable)', async () => {
    const { api, calls } = client('https://times.example.test/api/v1/tracked-time');
    await api.bookingSuggestions({ title: 'Team Daily & more', start: '09:15', date: '2026-10-22' });
    await api.bookingSuggestions({ title: 'x', start: '10:00' });
    assert.deepEqual(calls.map(([m, u]) => `${m} ${u}`), [
      'GET https://times.example.test/api/v1/booking-suggestions?_format=json&title=Team%20Daily%20%26%20more&start=09%3A15&date=2026-10-22',
      'GET https://times.example.test/api/v1/booking-suggestions?_format=json&title=x&start=10%3A00',
    ]);
    const custom = client({ trackedTime: 'https://times.example.test/api/v1/tracked-time', bookingSuggestions: 'https://b.test/suggest' });
    await custom.api.bookingSuggestions({ title: 'x', start: '10:00' });
    assert.equal(custom.calls[0][1], 'https://b.test/suggest?_format=json&title=x&start=10%3A00');
  });

  it('derives every endpoint from the tracked-time URL without cache-busters', async () => {
    const { api, calls } = client('https://times.example.test//api/v1/tracked-time');
    await api.issueTime({ source: 'https://git.example.test', project_id: 3, issue_id: 14 });
    await api.myDay('2026-07-14');
    await api.frequent();
    await api.search('daily standup');
    await api.create({ duration: 15 });
    await api.update(5, { duration: 30 });
    await api.remove(5);
    assert.deepEqual(calls.map(([m, u]) => `${m} ${u}`), [
      'GET https://times.example.test/api/v1/tracked-time?_format=json&source=https%3A%2F%2Fgit.example.test&project_id=3&issue_id=14',
      'GET https://times.example.test/api/v1/my-tracked-time?_format=json&date=2026-07-14',
      'GET https://times.example.test/api/v1/frequent-issues?_format=json',
      'GET https://times.example.test/api/v1/issue-search?_format=json&q=daily%20standup',
      'POST https://times.example.test/api/v1/tracked-time?_format=json',
      'PATCH https://times.example.test/api/v1/time-entry/5?_format=json',
      'DELETE https://times.example.test/api/v1/time-entry/5?_format=json',
    ]);
  });

  it('honours per-endpoint overrides', async () => {
    const { api, calls } = client({ trackedTime: 'https://a.test/api/v1/tracked-time', myDay: 'https://b.test/day' });
    await api.myDay('2026-07-14');
    assert.equal(calls[0][1], 'https://b.test/day?_format=json&date=2026-07-14');
  });
});

describe('My day calendar placeholders', () => {
  const FEED = icsToday([
    ['Covered', 9, 0, 9, 30],
    ['Alpha', 10, 0, 11, 0],
    ['Beta', 10, 30, 11, 30],
    ['Solo', 14, 0, 14, 30],
  ]);

  it('marks tracked events as covered and lays overlapping ones side by side', async () => {
    const { root, errors } = await openMyDay({ icalRaw: FEED });
    assert.deepEqual(calBlocks(root).map(calTitle).sort(), ['Alpha', 'Beta', 'Covered', 'Solo']);
    assert.ok(calBlock(root, 'Covered').classList.contains('omnitime-tl__cal-event--covered'));
    assert.ok(!calBlock(root, 'Solo').classList.contains('omnitime-tl__cal-event--covered'));
    const alpha = calBlock(root, 'Alpha').style;
    const beta = calBlock(root, 'Beta').style;
    assert.equal(alpha.width, 'calc(50% - 8px)');
    assert.equal(beta.width, 'calc(50% - 8px)');
    assert.notEqual(alpha.left, beta.left);
    assert.deepEqual(errors, []);
  });

  it('moves a placeholder when dragged (regression: TypeError on drop)', async () => {
    const { window, root, errors } = await openMyDay({ icalRaw: FEED });
    const before = parseFloat(calBlock(root, 'Solo').style.top);
    drag(window, calBlock(root, 'Solo'), 67); // ~1h at ~1.1px/min
    assert.deepEqual(errors, []);
    const moved = calBlock(root, 'Solo');
    assert.ok(parseFloat(moved.style.top) > before);
    assert.match(moved.querySelector('.omnitime-tl__cal-meta').textContent, /^15:00/);
  });

  it('keeps synced events when dragging after a background calendar update', async () => {
    const { window, root, errors, onChanged } = await openMyDay({ icalRaw: FEED });
    onChanged.fire({ icalRaw: { newValue: icsToday([['Fresh', 16, 0, 16, 30], ['Other', 11, 30, 12, 0]]) } }, 'local');
    assert.deepEqual(calBlocks(root).map(calTitle).sort(), ['Fresh', 'Other']);
    drag(window, calBlock(root, 'Fresh'), 67);
    assert.deepEqual(calBlocks(root).map(calTitle).sort(), ['Fresh', 'Other']);
    assert.deepEqual(errors, []);
  });

  it('gives the remaining event the full width after hiding its overlap', async () => {
    const { window, root, errors } = await openMyDay({ icalRaw: FEED });
    pointer(window, calBlock(root, 'Alpha').querySelector('.omnitime-tl__cal-dismiss'), 'pointerdown', 100);
    assert.equal(calBlock(root, 'Alpha'), undefined);
    assert.equal(calBlock(root, 'Beta').style.width, 'auto');
    assert.equal(calBlock(root, 'Beta').style.left, '6px');
    assert.deepEqual(errors, []);
  });

  it('opens a prefilled entry form and searches the cleaned title on click', async () => {
    const { window, root, api, errors } = await openMyDay({ icalRaw: icsToday([['[ACME] Sprint review!', 13, 0, 14, 0]]) });
    const block = calBlocks(root)[0];
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointerup', 100);
    assert.equal(root.querySelector('.omnitime-f-comment').value, '[ACME] Sprint review!');
    assert.equal(root.querySelector('.omnitime-f-start').value, '13:00');
    await settle(300); // search input is debounced by 250ms
    assert.deepEqual(api.calls.filter(([n]) => n === 'search'), [['search', 'ACME Sprint review']]);
    assert.deepEqual(errors, []);
  });
});

describe('My day entries', () => {
  it('PATCHes start_time and duration when an editable entry is dragged', async () => {
    const { window, root, api, errors } = await openMyDay();
    drag(window, root.querySelector('.omnitime-tl__entry--editable'), 67);
    await settle(300); // the quiet reconcile follows shortly after the PATCH
    const [, id, payload] = api.calls.find(([n]) => n === 'update');
    assert.equal(id, 7);
    assert.equal(payload.duration, 30);
    assert.ok(payload.start_time > '09:00', `start_time ${payload.start_time} should be later than 09:00`);
    assert.equal(api.calls.filter(([n]) => n === 'myDay').length >= 2, true, 'reloads the day after saving');
    assert.deepEqual(errors, []);
  });
});

describe('calendar memory', () => {
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const WEEKLY = icsToday([['Weekly sync', 13, 0, 14, 0, 'weekly-1']]);
  const WEEKLY_KEY = () => `uid:weekly-1@${today()}T13:00`;
  const ISSUE = { issue_internal_id: 55, issue_external_id: '5', label: 'Sync issue', project: 'P', milestone: '' };

  it('hides an event booked at another time and frees its slot', async () => {
    const { root, errors } = await openMyDay({
      icalRaw: icsToday([['Weekly sync', 13, 0, 14, 0, 'weekly-1'], ['Other', 13, 30, 14, 30, 'other-1']]),
      local: { omnitimeCalLinks: { [WEEKLY_KEY()]: { entryId: 7, date: today() } } },
    });
    assert.equal(calBlock(root, 'Weekly sync'), undefined);
    // Its former overlap partner takes the full width again.
    assert.equal(calBlock(root, 'Other').style.width, 'auto');
    assert.deepEqual(errors, []);
  });

  it('hides overlapping events that were both booked elsewhere', async () => {
    const other = { ...ENTRY, id: 8, start: '11:00', stop: '12:00', duration_minutes: 60, duration_label: '1:00' };
    const { root } = await openMyDay({
      entries: [ENTRY, other],
      icalRaw: icsToday([['Alpha', 15, 0, 16, 0, 'a'], ['Beta', 15, 30, 16, 30, 'b']]),
      local: { omnitimeCalLinks: {
        [`uid:a@${today()}T15:00`]: { entryId: 7, date: today() },
        [`uid:b@${today()}T15:30`]: { entryId: 8, date: today() },
      } },
    });
    assert.deepEqual(calBlocks(root), []);
  });

  it('shows the event again once its booking is gone', async () => {
    const { root } = await openMyDay({
      icalRaw: WEEKLY,
      local: { omnitimeCalLinks: { [WEEKLY_KEY()]: { entryId: 999, date: today() } } },
    });
    assert.ok(!calBlock(root, 'Weekly sync').classList.contains('omnitime-tl__cal-event--covered'));
  });

  it('links the booking and remembers the issue picked for the event', async () => {
    const { window, root, api, store } = await openMyDay({ icalRaw: WEEKLY, searchIssues: [ISSUE] });
    const block = calBlock(root, 'Weekly sync');
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointerup', 100);
    await settle(300); // auto-search on the cleaned title (debounced)
    root.querySelector('.omnitime-search__item').click();
    root.querySelector('.omnitime-save').click();
    await settle();
    const [, payload] = api.calls.find(([n]) => n === 'create');
    assert.equal(payload.issue_internal_id, 55);
    assert.deepEqual(store.omnitimeCalLinks, { [WEEKLY_KEY()]: { entryId: 9, date: today() } });
    const { history, at, ...remembered } = store.omnitimeCalIssues['uid:weekly-1'];
    assert.equal(at, history[0].at); // last booking (drives the 180-day expiry)
    assert.deepEqual(remembered, { id: 55, label: 'Sync issue #5', title: 'Weekly sync' });
    // Every calendar booking is also kept in the series' local history.
    assert.equal(history.length, 1);
    assert.deepEqual({ id: history[0].id, label: history[0].label }, { id: 55, label: 'Sync issue #5' });
    assert.ok(!Number.isNaN(Date.parse(history[0].at)));
  });

  it('shows the server suggestions under the target and swaps them (single booking form)', async () => {
    const rec = (id, ext, label, reason) => ({ issue_internal_id: id, issue_external_id: ext, label, project: 'P', milestone: null, link: '', ...(reason ? { reason } : {}) });
    const env = await openMyDay({ icalRaw: WEEKLY });
    env.api.bookingSuggestions = (params) => {
      env.api.calls.push(['bookingSuggestions', { ...params }]);
      return Promise.resolve({ preselected: rec(55, '5', 'Sync issue'), suggestions: [rec(61, '61', 'Menu & header', 'history'), rec(9, '9', 'Team rituals', 'time')], history_count: 4 });
    };
    const { window, root, api } = env;
    const block = calBlock(root, 'Weekly sync');
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointerup', 100);
    await settle(40);
    assert.deepEqual(api.calls.filter(([n]) => n === 'bookingSuggestions').map(([, p]) => p), [{ title: 'Weekly sync', start: '13:00', date: today() }]);
    assert.equal(root.querySelector('.omnitime-target__kicker').textContent, 'Suggested for this meeting');
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Sync issue #5');
    const chips = () => [...root.querySelectorAll('.omnitime-sugg .omnitime-bk__sugg')];
    assert.deepEqual(chips().map((c) => c.getAttribute('aria-label')), ['Use #61 Menu & header instead', 'Use #9 Team rituals instead']);
    assert.ok(chips()[1].querySelector('.ot-svg--clock'));
    chips()[0].click();
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Menu & header #61');
    assert.deepEqual(chips().map((c) => c.getAttribute('aria-label')), ['Use #5 Sync issue instead', 'Use #9 Team rituals instead'], 'the previous issue takes the chip\'s place');
    root.querySelector('.omnitime-save').click();
    await settle();
    assert.equal(api.calls.find(([n]) => n === 'create')[1].issue_internal_id, 61);
  });

  it('keeps the remembered issue when the server has none and leaves a user choice alone', async () => {
    const rec = (id, ext, label) => ({ issue_internal_id: id, issue_external_id: ext, label, project: 'P', milestone: null, link: '', reason: 'time' });
    let answer;
    const env = await openMyDay({
      icalRaw: WEEKLY, searchIssues: [ISSUE],
      local: { omnitimeCalIssues: { 'uid:weekly-1': { id: 55, label: 'Sync issue #5' } } },
    });
    env.api.bookingSuggestions = () => new Promise((resolve) => { answer = resolve; });
    const { window, root } = env;
    pointer(window, calBlock(root, 'Weekly sync'), 'pointerdown', 100);
    pointer(window, calBlock(root, 'Weekly sync'), 'pointerup', 100);
    // Local memory at once.
    assert.equal(root.querySelector('.omnitime-target__kicker').textContent, 'Remembered for this meeting');
    answer({ preselected: null, suggestions: [rec(9, '9', 'Team rituals')], history_count: 0 });
    await settle(30);
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Sync issue #5');
    assert.equal(root.querySelector('.omnitime-target__kicker').textContent, 'Remembered for this meeting');
    assert.equal(root.querySelectorAll('.omnitime-sugg .omnitime-bk__sugg').length, 1);
  });

  it('does not let a late server answer replace what the user picked', async () => {
    let answer;
    const env = await openMyDay({ icalRaw: WEEKLY, searchIssues: [ISSUE], local: { omnitimeCalIssues: { 'uid:weekly-1': { id: 55, label: 'Sync issue #5' } } } });
    env.api.bookingSuggestions = () => new Promise((resolve) => { answer = resolve; });
    const { window, root } = env;
    pointer(window, calBlock(root, 'Weekly sync'), 'pointerdown', 100);
    pointer(window, calBlock(root, 'Weekly sync'), 'pointerup', 100);
    const input = root.querySelector('.omnitime-search__input');
    input.value = 'sync';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(250);
    root.querySelector('.omnitime-search__item').click();
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Sync issue #5');
    answer({ preselected: { issue_internal_id: 77, issue_external_id: '7', label: 'Server pick', project: 'P' }, suggestions: [] });
    await settle(30);
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Sync issue #5');
  });

  it('preselects the remembered issue the next time the event is clicked', async () => {
    const { window, root, api } = await openMyDay({
      icalRaw: WEEKLY,
      local: { omnitimeCalIssues: { 'uid:weekly-1': { id: 55, label: 'Sync issue #5' } } },
    });
    const block = calBlock(root, 'Weekly sync');
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointerup', 100);
    assert.equal(root.querySelector('.omnitime-target__label').textContent, 'Sync issue #5');
    assert.equal(root.querySelector('.omnitime-target__kicker').textContent, 'Remembered for this meeting');
    await settle(300);
    assert.deepEqual(api.calls.filter(([n]) => n === 'search'), [], 'no auto-search when an issue is remembered');
    root.querySelector('.omnitime-save').click();
    await settle();
    assert.equal(api.calls.find(([n]) => n === 'create')[1].issue_internal_id, 55);
  });

  it('does not remember the current issue when none was picked explicitly', async () => {
    const { window, root, store } = await openMyDay({ icalRaw: WEEKLY });
    const block = calBlock(root, 'Weekly sync');
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointerup', 100);
    // The overlay has no current issue, so pick nothing and expect no memory.
    assert.equal(store.omnitimeCalIssues, undefined);
  });
});

describe('My day entry resizing', () => {
  // Drag one of an editable entry's resize handles to grid y = `toY`.
  function resize(window, root, edge, toY) {
    const handle = root.querySelector(`.omnitime-tl__entry--editable [data-h="${edge}"]`);
    assert.ok(handle, `no ${edge} handle on the editable entry`);
    pointer(window, handle, 'pointerdown', 0);
    pointer(window, handle, 'pointermove', toY);
    pointer(window, handle, 'pointerup', toY);
  }

  it('extends an entry from its bottom edge and PATCHes the new duration', async () => {
    const { window, root, api, errors } = await openMyDay();
    resize(window, root, 'bottom', 667); // ~10:00 on the ~1.1px/min axis
    await settle();
    assert.deepEqual(api.calls.filter(([n]) => n === 'update').map(([, id, p]) => [id, p.start_time, p.duration]), [[7, '09:00', 60]]);
    assert.deepEqual(errors, []);
  });

  it('moves the start from the top edge and keeps the end', async () => {
    const { window, root, api } = await openMyDay();
    resize(window, root, 'top', 567); // ~08:30
    await settle();
    const [[, , payload]] = api.calls.filter(([n]) => n === 'update');
    assert.equal(payload.start_time, '08:30');
    assert.equal(payload.duration, 60);
  });

  it('does not save when the edge is released where it started', async () => {
    const { window, root, api } = await openMyDay();
    const handle = root.querySelector('.omnitime-tl__entry--editable [data-h="bottom"]');
    pointer(window, handle, 'pointerdown', 0);
    pointer(window, handle, 'pointerup', 0);
    await settle();
    assert.deepEqual(api.calls.filter(([n]) => n === 'update'), []);
    assert.equal(root.querySelector('.omnitime-form--edit'), null, 'a handle press must not open the edit form');
  });
});

describe('storage listener lifecycle', () => {
  it('keeps one calendar listener across tab switches and removes it on close', async () => {
    const { root, onChanged } = await openMyDay({ icalRaw: icsToday([]), context: { source: 'https://git.example.test', project_id: '3', issue_id: '14' } });
    assert.equal(onChanged.listeners.size, 1);
    root.querySelector('.omnitime-tab[data-tab="issue"]').click();
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    root.querySelector('.omnitime-tab[data-tab="issue"]').click();
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle();
    assert.equal(onChanged.listeners.size, 1);
    root.querySelector('.omnitime-modal-close').click();
    assert.equal(onChanged.listeners.size, 0);
  });
});
