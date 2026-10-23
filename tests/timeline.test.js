// "My day" timeline: keyboard access, entry blocks, day context (now line,
// empty hint, working hours), day nav + week strip, calendar status and the
// day-total callback (core.js renderMyDayTab / buildTimeline / buildWeekStrip).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, pointer, settle, icsStamp, ymd } = require('./helpers');

const ENTRY = {
  id: 7, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30',
  project: 'Internal', milestone: 'Ops', issue_label: 'Internal / Standup', issue_external_id: '12',
  issue_internal_id: 1200, issue_link: 'https://git.example.test/internal/-/issues/12',
  comment: 'Daily sync', status: 'unbooked', editable: true,
};
const BOOKED = {
  ...ENTRY, id: 8, start: '11:00', stop: '13:00', duration_minutes: 120, duration_label: '2:00',
  project: 'Project Alpha', issue_label: 'Search', issue_external_id: '3', comment: '', editable: false, status: 'booked',
};

// A floating-time .ics feed with [title, startH, startM, endH, endM, uid?, extraLines?]
// events on today's date.
function icsToday(events) {
  const today = new Date();
  return [
    'BEGIN:VCALENDAR',
    ...events.flatMap(([title, sh, sm, eh, em, uid, extra = []]) => [
      'BEGIN:VEVENT', ...(uid ? [`UID:${uid}`] : []), `SUMMARY:${title}`, `DTSTART:${icsStamp(today, sh, sm)}`, `DTEND:${icsStamp(today, eh, em)}`, ...extra, 'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

// Monday..Sunday of the current week, as the API's `week` array.
function currentWeek(active) {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return [...Array(7)].map((_, i) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return { label: 'X', date: ymd(day), total_minutes: 30, total_label: '0:30', active: ymd(day) === active };
  });
}

function fakeApi(entries, { dayTotal } = {}) {
  const calls = [];
  const rec = (name, ret) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret);
  };
  return {
    calls,
    issueTime: rec('issueTime', { tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    myDay: rec('myDay', (date) => ({
      date,
      week: currentWeek(date),
      week_total_label: '3:30',
      day_total_label: '0:30',
      ...(dayTotal == null ? {} : { day_total_minutes: dayTotal }),
      entries: date === ymd(new Date()) ? entries : [],
    })),
    frequent: rec('frequent', { issues: [] }),
    search: rec('search', { issues: [] }),
    create: rec('create', { id: 9 }),
    update: rec('update', {}),
    remove: rec('remove', null),
  };
}

async function openMyDay({ entries = [ENTRY], icalRaw = icsToday([]), local = {}, dayTotal = 30, onDayTotal } = {}) {
  const store = { icalRaw, ...local };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => { sent.push(msg.action); if (cb) cb({ success: true, notModified: true }); } },
  };
  const sent = [];
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  // Track interval timers (the "now" line) to check they are cleaned up.
  const live = new Set();
  const { setInterval: si, clearInterval: ci } = env.window;
  env.window.setInterval = (...a) => { const id = si(...a); live.add(id); return id; };
  env.window.clearInterval = (id) => { live.delete(id); ci(id); };
  const api = fakeApi(entries, { dayTotal });
  env.window.OmniTime.openModal({
    apiClient: api,
    context: { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Demo' },
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: 'myday',
    settings: { dayStart: 8, dayEnd: 17 },
    onDayTotal,
  });
  await settle();
  const root = uiRoot(env.document);
  return { ...env, root, api, store, live, sent, esc: () => key(env.window, root.activeElement || root.host, 'Escape') };
}

const items = (root) => [...root.querySelectorAll('.omnitime-tl__entry, .omnitime-tl__cal-event:not(.omnitime-tl__cal-event--covered)')];
const calBlock = (root, title) => [...root.querySelectorAll('.omnitime-tl__cal-event')].find((b) => b.querySelector('.omnitime-tl__cal-name').textContent === title);
const formOpen = (root) => root.querySelector('.omnitime-myday__cols').classList.contains('omnitime-myday__cols--form-open');
const isoAt = (daysAgo, h, m) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, h, m).toISOString();
};

describe('timeline keyboard access', () => {
  const FEED = icsToday([['Planning', 10, 0, 10, 45, 'plan-1'], ['Retro', 14, 0, 14, 30, 'retro-1'], ['Early', 7, 0, 7, 30, 'early-1']]);

  it('makes entries and placeholders focusable buttons in time order', async () => {
    const { root, errors } = await openMyDay({ entries: [ENTRY, BOOKED], icalRaw: FEED });
    const list = items(root);
    assert.deepEqual(list.map((el) => [el.tabIndex, el.getAttribute('role')]), list.map(() => [0, 'button']));
    const starts = list.map((el) => Number(el.dataset.start));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'DOM (Tab) order follows the time');
    assert.deepEqual(list.map((el) => el.dataset.key.split(':')[0]), ['cal', 'entry', 'cal', 'entry', 'cal']);
    assert.equal(list[1].getAttribute('aria-label'), '09:00\u201309:30, Internal / Standup #12, Daily sync');
    assert.equal(list[3].getAttribute('aria-label'), '11:00\u201313:00, Project Alpha / Search #3 (booked, read-only)');
    assert.equal(list[3].getAttribute('aria-disabled'), 'true');
    assert.match(list[2].getAttribute('aria-label'), /^10:00\u201310:45, calendar event: Planning, not tracked yet/);
    // The hide button is not a separate Tab stop (Delete hides instead).
    assert.equal(calBlock(root, 'Planning').querySelector('.omnitime-tl__cal-dismiss').tabIndex, -1);
    assert.deepEqual(errors, []);
  });

  it('opens the edit form with Enter, focuses it and returns focus on Escape', async () => {
    const { window, root, esc } = await openMyDay();
    const entry = root.querySelector('.omnitime-tl__entry');
    entry.focus();
    assert.equal(key(window, entry, 'Enter'), false, 'Enter is handled');
    assert.ok(root.querySelector('.omnitime-form--edit'));
    assert.ok(formOpen(root));
    assert.equal(root.activeElement, root.querySelector('.omnitime-f-dur'));
    esc();
    assert.equal(formOpen(root), false);
    assert.equal(root.activeElement, entry);
  });

  it('focuses the edited entry again after a keyboard save', async () => {
    const { window, root, api } = await openMyDay();
    const entry = root.querySelector('.omnitime-tl__entry');
    entry.focus();
    key(window, entry, 'Enter');
    root.querySelector('.omnitime-save').click();
    await settle();
    assert.equal(api.calls.filter(([n]) => n === 'update').length, 1);
    const fresh = root.querySelector('.omnitime-tl__entry');
    assert.notEqual(fresh, entry, 'the day re-rendered');
    assert.equal(root.activeElement, fresh);
  });

  it('does nothing on Enter for a booked entry', async () => {
    const { window, root } = await openMyDay({ entries: [BOOKED] });
    const entry = root.querySelector('.omnitime-tl__entry');
    entry.focus();
    key(window, entry, 'Enter');
    assert.equal(formOpen(root), false);
  });

  it('books a calendar event from the keyboard', async () => {
    const { window, root, api } = await openMyDay({ icalRaw: FEED });
    const block = calBlock(root, 'Retro');
    block.focus();
    assert.equal(key(window, block, ' '), false, 'Space is handled');
    assert.ok(formOpen(root));
    assert.equal(root.querySelector('.omnitime-f-comment').value, 'Retro');
    assert.equal(root.querySelector('.omnitime-f-start').value, '14:00');
    assert.equal(root.activeElement, root.querySelector('.omnitime-search__input'));
    root.querySelector('.omnitime-save').click();
    await settle();
    const [, payload] = api.calls.find(([n]) => n === 'create');
    assert.equal(payload.start_time, '14:00');
    assert.equal(payload.duration, 30);
  });

  it('hides a focused event with Delete and moves on to the next item', async () => {
    const { window, root } = await openMyDay({ icalRaw: FEED });
    const block = calBlock(root, 'Planning');
    block.focus();
    key(window, block, 'Delete');
    assert.equal(calBlock(root, 'Planning'), undefined);
    assert.equal(root.activeElement, calBlock(root, 'Retro'));
  });

  it('moves (Alt+Down) and resizes (Alt+Shift+Down) in 5-minute steps, saved once', async () => {
    const { window, root, api } = await openMyDay();
    let entry = root.querySelector('.omnitime-tl__entry');
    entry.focus();
    key(window, entry, 'ArrowDown', { altKey: true });
    key(window, entry, 'ArrowDown', { altKey: true });
    assert.equal(entry.querySelector('.omnitime-tl__time').textContent, '09:10\u201309:40');
    assert.match(entry.getAttribute('aria-label'), /^09:10\u201309:40/);
    key(window, entry, 'ArrowDown', { altKey: true, shiftKey: true });
    assert.equal(entry.querySelector('.omnitime-tl__time').textContent, '09:10\u201309:45');
    assert.deepEqual(api.calls.filter(([n]) => n === 'update'), [], 'not saved while keys are pressed');
    await settle(800);
    assert.deepEqual(api.calls.filter(([n]) => n === 'update').map(([, id, p]) => [id, p.start_time, p.duration]), [[7, '09:10', 35]]);
    // The day reloaded; the same entry has the focus again.
    entry = root.querySelector('.omnitime-tl__entry');
    assert.equal(root.activeElement, entry);
  });

  it('keeps Alt+Up within the free room before the entry', async () => {
    const before = { ...ENTRY, id: 6, start: '08:50', stop: '09:00', duration_minutes: 10, duration_label: '0:10' };
    const { window, root } = await openMyDay({ entries: [before, ENTRY] });
    const entry = [...root.querySelectorAll('.omnitime-tl__entry')].find((el) => el.dataset.key === 'entry:7');
    entry.focus();
    key(window, entry, 'ArrowUp', { altKey: true });
    assert.equal(entry.querySelector('.omnitime-tl__time').textContent, '09:00\u201309:30');
  });
});

describe('timeline entry blocks', () => {
  it('shows meta, then the issue with its muted #id, then the comment', async () => {
    const noComment = { ...ENTRY, id: 10, start: '13:00', stop: '13:30', comment: '' };
    const { root } = await openMyDay({ entries: [ENTRY, noComment] });
    const [withC, without] = root.querySelectorAll('.omnitime-tl__entry');
    const title = withC.querySelector('.omnitime-tl__entrytitle');
    assert.equal(title.textContent, 'Standup #12');
    assert.equal(title.querySelector('.omnitime-entryid').textContent, ' #12');
    assert.equal(withC.querySelector('.omnitime-tl__commenttext').textContent, 'Daily sync');
    assert.ok(withC.querySelector('.omnitime-tl__entrycomment .ot-svg--comment'), 'speech glyph before the comment');
    const order = ['.omnitime-tl__entrymeta', '.omnitime-tl__entrytitle', '.omnitime-tl__entrycomment'].map((sel) => [...withC.querySelectorAll('*')].indexOf(withC.querySelector(sel)));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'meta, title, comment');
    assert.match(withC.querySelector('.omnitime-tl__entrymeta').textContent, /^09:00\u201309:30/);
    assert.equal(withC.querySelector('.omnitime-tl__dur').textContent, '0:30');
    assert.match(withC.title, /^Internal \/ Standup #12\nDaily sync/);
    assert.equal(without.querySelector('.omnitime-tl__entrytitle').textContent, 'Standup #12');
    assert.equal(without.querySelector('.omnitime-tl__entrycomment'), null);
  });

  it('colours the stripe by a stable hash of the project', async () => {
    const other = { ...ENTRY, id: 11, start: '14:00', stop: '14:30', project: 'Project Alpha' };
    const same = { ...ENTRY, id: 12, start: '15:00', stop: '15:30' };
    const { root } = await openMyDay({ entries: [ENTRY, other, same] });
    const colour = (el) => [...el.classList].find((c) => /^omnitime-tl__entry--p\d$/.test(c));
    const [a, b, c] = [...root.querySelectorAll('.omnitime-tl__entry')].map(colour);
    // Pinned: changing the hash would recolour every user's projects.
    assert.equal(a, 'omnitime-tl__entry--p0');
    assert.equal(b, 'omnitime-tl__entry--p2');
    assert.equal(c, a);
  });

  it('links the issue in a new tab without starting an edit', async () => {
    const { window, root } = await openMyDay({ entries: [ENTRY, { ...BOOKED, issue_link: 'javascript:alert(1)' }] });
    const [entry, booked] = root.querySelectorAll('.omnitime-tl__entry');
    const link = entry.querySelector('a.omnitime-tl__link');
    assert.equal(link.getAttribute('href'), ENTRY.issue_link);
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(link.getAttribute('aria-label'), 'Open issue Standup #12 in a new tab');
    pointer(window, link, 'pointerdown', 100);
    pointer(window, link, 'pointerup', 100);
    assert.equal(formOpen(root), false);
    assert.equal(booked.querySelector('.omnitime-tl__link'), null, 'only http(s) links');
  });

  it('marks entries under 15 minutes as tiny and keeps their duration', async () => {
    const tiny = { ...ENTRY, id: 13, start: '10:00', stop: '10:05', duration_minutes: 5, duration_label: '0:05' };
    const { root } = await openMyDay({ entries: [ENTRY, tiny] });
    const [normal, small] = root.querySelectorAll('.omnitime-tl__entry');
    assert.ok(small.classList.contains('omnitime-tl__entry--tiny'));
    assert.ok(!normal.classList.contains('omnitime-tl__entry--tiny'));
    assert.match(small.querySelector('.omnitime-tl__dur').textContent, /0:05/);
  });

  it('shows "Project / Issue #id" on compact rows: the project stays, the issue title is cut', async () => {
    const short = { ...ENTRY, id: 14, start: '10:00', stop: '10:15', duration_minutes: 15, duration_label: '0:15', comment: '' };
    const noProject = { ...ENTRY, id: 15, start: '11:00', stop: '11:15', duration_minutes: 15, duration_label: '0:15', project: '' };
    const { root } = await openMyDay({ entries: [ENTRY, short, noProject] });
    const [thirty, fifteen, bare] = root.querySelectorAll('.omnitime-tl__entry');
    for (const row of [thirty, fifteen]) {
      assert.ok(row.classList.contains('omnitime-tl__entry--compact'));
      const kids = [...row.children].map((c) => c.className.split(' ')[0]);
      assert.deepEqual(kids.slice(0, 2), ['omnitime-tl__entrymeta', 'omnitime-tl__entrywho']);
      const who = row.querySelector('.omnitime-tl__entrywho');
      assert.deepEqual([...who.children].map((c) => c.className.split(' ')[0]), ['omnitime-tl__entryproj', 'omnitime-tl__entrysep', 'omnitime-tl__entrytitle']);
      assert.equal(who.querySelector('.omnitime-tl__entryproj').textContent, 'Internal');
      assert.equal(who.querySelector('.omnitime-tl__entrysep').textContent, '/');
      assert.equal(who.querySelector('.omnitime-tl__entrytitle').textContent, 'Standup #12');
      assert.match(row.title, /^Internal \/ Standup #12/, 'the tooltip has everything');
      assert.match(row.getAttribute('aria-label'), /^\d\d:\d\d.\d\d:\d\d, Internal \/ Standup #12/);
    }
    assert.equal(bare.querySelector('.omnitime-tl__entryproj'), null, 'nothing to show without a project');
    assert.equal(bare.querySelector('.omnitime-tl__entrysep'), null);
    // Taller blocks keep "time \u00b7 Project" on the meta line and the issue on the title line.
    const long = { ...ENTRY, id: 16, start: '13:00', stop: '14:00', duration_minutes: 60, duration_label: '1:00' };
    return openMyDay({ entries: [long] }).then(({ root: r }) => {
      const block = r.querySelector('.omnitime-tl__entry');
      assert.equal(block.querySelector('.omnitime-tl__entrywho'), null);
      assert.equal(block.querySelector('.omnitime-tl__entryctx').textContent, 'Internal');
      assert.equal(block.querySelector('.omnitime-tl__entrytitle').textContent, 'Standup #12');
    });
  });

  it('shows project and milestone on tall entries', async () => {
    const long = { ...ENTRY, start: '09:00', stop: '11:30', duration_minutes: 150, duration_label: '2:30' };
    const { root } = await openMyDay({ entries: [long] });
    const block = root.querySelector('.omnitime-tl__entry');
    assert.ok(block.classList.contains('omnitime-tl__entry--tall'));
    assert.equal(block.querySelector('.omnitime-tl__entryctx').textContent, 'Internal \u00b7 Ops');
    assert.ok(block.querySelector('.omnitime-tl__entrymeta').contains(block.querySelector('.omnitime-tl__entryctx')), 'in the meta line');
  });
});

describe('new-entry selection', () => {
  const px = (el, prop) => parseFloat(el.style[prop]);
  const PX_PER_MIN = 600 / 540; // the timeline's scale (modal, 9 hours in 600px)
  const yOf = (minutes) => minutes * PX_PER_MIN; // jsdom: the grid's top is 0, no entries above
  const selOf = (root) => root.querySelector('.omnitime-tl__sel');

  it('covers exactly the calendar placeholder it books, for 5 to 60 minutes', async () => {
    const events = [['E5', 14, 0, 14, 5, 'u5'], ['E10', 14, 30, 14, 40, 'u10'], ['E15', 15, 0, 15, 15, 'u15'], ['E30', 15, 30, 16, 0, 'u30'], ['E60', 16, 30, 17, 30, 'u60']];
    const { window, root } = await openMyDay({ entries: [], icalRaw: icsToday(events) });
    for (const [title] of events) {
      const block = calBlock(root, title);
      block.focus();
      key(window, block, 'Enter');
      const sel = selOf(root);
      assert.ok(sel, `${title}: a selection is shown`);
      assert.equal(sel.style.top, block.style.top, `${title}: same top`);
      assert.equal(sel.style.height, block.style.height, `${title}: same height`);
    }
  });

  it('follows its placeholder while it is dragged', async () => {
    const { window, root } = await openMyDay({ entries: [], icalRaw: icsToday([['E15', 15, 0, 15, 15, 'u15']]) });
    let block = calBlock(root, 'E15');
    block.focus();
    key(window, block, 'Enter');
    pointer(window, block, 'pointerdown', 100);
    pointer(window, block, 'pointermove', 160);
    assert.equal(selOf(root).style.top, block.style.top);
    assert.equal(selOf(root).style.height, block.style.height);
    assert.ok(px(block, 'top') > yOf(15 * 60), 'moved down');
  });

  it('is exactly as tall as the time it spans in free space (never over the next entry)', async () => {
    const next = { ...ENTRY, id: 20, start: '10:15', stop: '10:30', duration_minutes: 15, duration_label: '0:15' };
    const { window, root } = await openMyDay({ entries: [next] });
    const grid = root.querySelector('.omnitime-tl');
    pointer(window, grid, 'pointerdown', yOf(10 * 60));
    const sel = selOf(root);
    const entry = root.querySelector('.omnitime-tl__entry');
    assert.match(sel.textContent, /10:00.10:15/);
    assert.ok(Math.abs(px(sel, 'height') - 15 * PX_PER_MIN) < 0.01, '15 minutes = its share of the scale, not the entries\' minimum height');
    assert.ok(Math.abs(px(sel, 'top') + px(sel, 'height') - px(entry, 'top')) < 0.01, 'ends where the next entry starts');
    // 5 and 10 minutes, typed into the form.
    for (const [text, minutes] of [['0:05', 5], ['0:10', 10], ['0:20', 20]]) {
      const dur = root.querySelector('.omnitime-f-dur');
      dur.value = text;
      dur.dispatchEvent(new window.Event('input', { bubbles: true }));
      dur.dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.ok(Math.abs(px(selOf(root), 'height') - minutes * PX_PER_MIN) < 0.01, `${text}: ${minutes} min of the scale`);
    }
  });

  it('keeps matching the time while its edge is dragged', async () => {
    const { window, root } = await openMyDay({ entries: [] });
    const grid = root.querySelector('.omnitime-tl');
    pointer(window, grid, 'pointerdown', yOf(10 * 60));
    const handle = selOf(root).querySelector('[data-h="bottom"]');
    pointer(window, handle, 'pointerdown', yOf(10 * 60 + 15));
    for (const end of [10 * 60 + 5, 10 * 60 + 10, 10 * 60 + 40]) {
      pointer(window, window.document, 'pointermove', yOf(end));
      const sel = selOf(root);
      assert.ok(Math.abs(px(sel, 'height') - (end - 600) * PX_PER_MIN) < 0.01, `ends at ${end}`);
      assert.ok(Math.abs(px(sel, 'top') - yOf(600)) < 0.01, 'start stays put');
      assert.match(sel.textContent, new RegExp('10:00.' + String(Math.floor(end / 60)) + ':' + String(end % 60).padStart(2, '0')));
    }
    pointer(window, window.document, 'pointerup', 0);
  });

  it('floats its label when the box is lower than the text', async () => {
    const { window, root } = await openMyDay({ entries: [] });
    pointer(window, root.querySelector('.omnitime-tl'), 'pointerdown', yOf(10 * 60));
    const dur = root.querySelector('.omnitime-f-dur');
    dur.value = '0:05';
    dur.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.ok(selOf(root).classList.contains('omnitime-tl__sel--micro'));
    dur.value = '1:00';
    dur.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.ok(!selOf(root).classList.contains('omnitime-tl__sel--micro'));
  });
});

describe('timeline day context', () => {
  it('shows a hint on an empty day', async () => {
    const { root } = await openMyDay({ entries: [] });
    assert.equal(root.querySelector('.omnitime-tl__emptytext').textContent, 'Nothing tracked. Click the timeline or New entry.');
    const { root: busy } = await openMyDay();
    assert.equal(busy.querySelector('.omnitime-tl__empty'), null);
  });

  it('draws a "now" line on today only, and stops its timer on close', async () => {
    const { root, live } = await openMyDay();
    const line = root.querySelector('.omnitime-tl__now');
    assert.ok(line);
    // One entry 09:00-09:30 at its natural height: the axis is linear (600px per 9h).
    const now = new Date();
    const expected = (now.getHours() * 60 + now.getMinutes()) * 600 / 540;
    assert.ok(Math.abs(parseFloat(line.style.top) - expected) < 3, `${line.style.top} vs ${expected}`);
    assert.match(line.textContent, /^\d\d:\d\d$/);
    assert.equal(live.size, 1);

    root.querySelector('[data-nav="prev"]').click();
    await settle();
    assert.equal(root.querySelector('.omnitime-tl__now'), null);
    assert.equal(live.size, 0, 'the old timer is cleared on re-render');

    root.querySelector('[data-nav="next"]').click();
    await settle();
    assert.equal(live.size, 1);
    root.querySelector('.omnitime-modal-close').click();
    assert.equal(live.size, 0);
  });

  it('shades the working hours from the settings', async () => {
    const { root } = await openMyDay({ entries: [] });
    const band = root.querySelector('.omnitime-tl__work');
    // No entries: linear axis, 08:00-17:00 = 9h = 600px.
    assert.equal(Math.round(parseFloat(band.style.top)), Math.round(8 * 60 * 600 / 540));
    assert.equal(Math.round(parseFloat(band.style.height)), 600);
  });
});

describe('day nav and week strip', () => {
  it('groups the nav as Today, previous, next and disables "Today" on today', async () => {
    const { root } = await openMyDay();
    const group = root.querySelector('.omnitime-daynav__group');
    assert.deepEqual([...group.querySelectorAll('button')].map((b) => b.dataset.nav), ['today', 'prev', 'next']);
    const today = root.querySelector('[data-nav="today"]');
    assert.equal(today.disabled, true);
    assert.equal(today.hidden, false, 'disabled, not hidden: the layout never jumps');
    root.querySelector('[data-nav="prev"]').click();
    await settle();
    assert.equal(today.disabled, false);
    today.click();
    await settle();
    assert.equal(today.disabled, true);
  });

  it('labels days "Mo 19"-style, dims weekends and future days and marks today', async () => {
    const { root } = await openMyDay();
    const cells = [...root.querySelectorAll('.omnitime-week__day')];
    assert.equal(cells.length, 7);
    const todayIso = ymd(new Date());
    const week = currentWeek(todayIso);
    cells.forEach((cell, i) => {
      const d = new Date(week[i].date + 'T00:00:00');
      assert.equal(cell.querySelector('.omnitime-week__label').textContent, `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`);
      assert.equal(cell.querySelector('.omnitime-week__total').textContent, '0:30');
      assert.equal(cell.classList.contains('omnitime-week__day--weekend'), i >= 5, `weekend ${i}`);
      assert.equal(cell.classList.contains('omnitime-week__day--future'), week[i].date > todayIso, `future ${i}`);
      assert.equal(cell.classList.contains('omnitime-week__day--today'), week[i].date === todayIso);
      assert.equal(cell.getAttribute('aria-current'), week[i].date === todayIso ? 'date' : null);
      assert.equal(cell.getAttribute('aria-pressed'), week[i].date === todayIso ? 'true' : 'false');
    });
  });
});

describe('calendar status and memory', () => {
  const status = (root) => root.querySelector('.omnitime-cal-status').textContent.trim();

  it('shows the last sync time', async () => {
    assert.equal(status((await openMyDay({ local: { omnitimeCalSyncedAt: isoAt(0, 10, 42) } })).root), 'Synced 10:42');
    assert.equal(status((await openMyDay({ local: { omnitimeCalSyncedAt: isoAt(1, 8, 5) } })).root), 'Synced yesterday 08:05');
    assert.equal(status((await openMyDay({ local: { omnitimeCalSyncedAt: isoAt(3, 8, 5) } })).root), 'Synced 3 days ago');
    assert.equal(status((await openMyDay()).root), 'Synced');
  });

  it('updates the sync time when the background sync stores a new one', async () => {
    const { root, window } = await openMyDay({ local: { omnitimeCalSyncedAt: isoAt(1, 8, 5) } });
    window.chrome.storage.onChanged.fire({ omnitimeCalSyncedAt: { newValue: isoAt(0, 11, 7) } }, 'local');
    assert.equal(status(root), 'Synced 11:07');
  });

  it('shows the remembered issue on a placeholder', async () => {
    const long = 'A very long remembered issue title that keeps going';
    const { root } = await openMyDay({
      icalRaw: icsToday([['Weekly sync', 13, 0, 14, 0, 'weekly-1'], ['Other', 15, 0, 16, 0, 'other-1']]),
      local: { omnitimeCalIssues: { 'uid:weekly-1': { id: 55, label: 'Sync issue #5' }, 'uid:other-1': { id: 56, label: `${long} #6` } } },
    });
    const weekly = calBlock(root, 'Weekly sync');
    assert.equal(weekly.querySelector('.omnitime-tl__cal-issue').textContent, '\u2192 #5 Sync issue');
    assert.match(weekly.getAttribute('aria-label'), /books to #5 Sync issue/);
    const other = calBlock(root, 'Other').querySelector('.omnitime-tl__cal-issue').textContent;
    assert.ok(other.startsWith('\u2192 #6 A very long') && other.endsWith('\u2026') && other.length <= 34, other);
  });

  it('drops iCal events the signed-in user declined', async () => {
    const declined = ['ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.test'];
    const { root } = await openMyDay({
      icalRaw: icsToday([['Declined', 13, 0, 14, 0, 'd-1', declined], ['Kept', 15, 0, 16, 0, 'k-1']]),
      local: { googleUserInfo: { email: 'Me@Example.test' } },
    });
    assert.equal(calBlock(root, 'Declined'), undefined);
    assert.ok(calBlock(root, 'Kept'));
  });
});

describe('day total callback (badge sync)', () => {
  it('reports today\'s total after each load of today only', async () => {
    const calls = [];
    const { root } = await openMyDay({ dayTotal: 95, onDayTotal: (...a) => calls.push(a) });
    const today = ymd(new Date());
    assert.deepEqual(calls, [[today, 95]]);
    root.querySelector('[data-nav="prev"]').click();
    await settle();
    assert.equal(calls.length, 1, 'not for other days');
    root.querySelector('[data-nav="next"]').click();
    await settle();
    assert.deepEqual(calls, [[today, 95], [today, 95]]);
  });

  it('falls back to the sum of the entries and survives a throwing callback', async () => {
    const calls = [];
    await openMyDay({ dayTotal: null, entries: [ENTRY, BOOKED], onDayTotal: (...a) => calls.push(a) });
    assert.deepEqual(calls, [[ymd(new Date()), 150]]);
    const { root, errors } = await openMyDay({ onDayTotal: () => { throw new Error('boom'); } });
    assert.ok(root.querySelector('.omnitime-tl__entry'));
    assert.deepEqual(errors, []);
  });
});

describe('calendar auto-sync', () => {
  const syncs = (t) => t.sent.filter((a) => a === 'OMNI_FORCE_SYNC_ICAL').length;
  it('syncs at once when nothing is cached yet (e.g. right after signing in)', async () => {
    const t = await openMyDay({ icalRaw: undefined });
    assert.equal(syncs(t), 1);
  });
  it('syncs quietly when the cache is older than 30 minutes, keeping its status', async () => {
    const t = await openMyDay({ local: { omnitimeCalSyncedAt: isoAt(1, 8, 5) } });
    assert.equal(syncs(t), 1);
    assert.match(t.root.querySelector('.omnitime-cal-status').textContent, /Synced yesterday/);
  });
  it('does not sync a fresh cache, and syncs at most once per modal', async () => {
    const fresh = await openMyDay({ local: { omnitimeCalSyncedAt: new Date(Date.now() - 60000).toISOString() } });
    assert.equal(syncs(fresh), 0);
    const empty = await openMyDay({ icalRaw: undefined });
    empty.root.querySelector('.omnitime-daynav__btn[data-nav="prev"]').click();
    await settle();
    assert.equal(syncs(empty), 1);
  });
});
