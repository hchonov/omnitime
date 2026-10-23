// "My day" productivity features: daily target + progress, untracked gaps,
// break cards, "Book my meetings" and "Copy from <previous working day>"
// (core.js dayTarget / targetProgress / findGaps / bookableMeetings and their
// use in renderMyDayTab / buildTimeline).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, makeEvent, settle, icsStamp, key } = require('./helpers');

// The tests run on a fixed clock: Wednesday 21 Oct 2026, 15:00 (TZ pinned by
// helpers), so weekdays and "the future part of today" are stable.
const TODAY = '2026-10-21';
const FIXED = new Date(2026, 9, 21, 15, 0).getTime();
function fixClock(window) {
  const Real = window.Date;
  class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  window.Date = FakeDate;
}

const entry = (id, start, stop, extra = {}) => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = stop.split(':').map(Number);
  const dur = eh * 60 + em - (sh * 60 + sm);
  return {
    id, start, stop, duration_minutes: dur, duration_label: `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`,
    project: 'Internal', milestone: 'Ops', issue_label: 'Standup', issue_external_id: String(id), issue_internal_id: 1000 + id,
    issue_link: '', comment: `Work ${id}`, status: 'unbooked', editable: true, break_label: null, active: false, ...extra,
  };
};

// Calendar feed on TODAY (or `dayOffset` days from it): [title, sh, sm, eh, em, uid, dayOffset].
function ics(events) {
  return ['BEGIN:VCALENDAR', ...events.flatMap(([title, sh, sm, eh, em, uid, dayOffset]) => {
    const d = new Date(2026, 9, 21 + (dayOffset || 0));
    return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${icsStamp(d, sh, sm)}`, `DTEND:${icsStamp(d, eh, em)}`, 'END:VEVENT'];
  }), 'END:VCALENDAR'].join('\r\n');
}

// A fake API over per-date entry lists: create adds to the day (ids from
// 500), remove deletes; createError(payload, n) can reject the n-th create.
// suggest(params) answers GET booking-suggestions (default: 404, i.e. an old
// server); searchIssues answers issue-search.
function fakeApi(days, { target = 480, createError, suggest, searchIssues = [] } = {}) {
  const calls = [];
  let next = 500;
  let n = 0;
  const api = {
    calls,
    days,
    myDay: (date) => {
      calls.push(['myDay', date]);
      const entries = days[date] || [];
      const total = entries.reduce((s, e) => s + e.duration_minutes, 0);
      return Promise.resolve({
        date, week: [], day_total_minutes: total, day_total_label: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`,
        entries, ...(target == null ? {} : { target_minutes: target }),
      });
    },
    frequent: () => Promise.resolve({ issues: [] }),
    search: (q) => { calls.push(['search', q]); return Promise.resolve({ issues: searchIssues }); },
    bookingSuggestions: (params) => {
      calls.push(['bookingSuggestions', { ...params }]);
      return suggest ? Promise.resolve(suggest(params)) : Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    },
    issueTime: () => Promise.resolve({ issue: { open: true } }),
    create: (payload) => {
      calls.push(['create', payload]);
      const err = createError && createError(payload, ++n);
      if (err) return Promise.reject(err);
      const id = next++;
      const [h, m] = (payload.start_time || '09:00').split(':').map(Number);
      const stop = h * 60 + m + payload.duration;
      (days[payload.date] = days[payload.date] || []).push(entry(id, payload.start_time || '09:00',
        `${String(Math.floor(stop / 60)).padStart(2, '0')}:${String(stop % 60).padStart(2, '0')}`, { comment: payload.comment || '' }));
      return Promise.resolve({ id });
    },
    update: () => Promise.resolve({}),
    remove: (id) => {
      calls.push(['remove', id]);
      Object.keys(days).forEach((d) => { days[d] = days[d].filter((e) => e.id !== id); });
      return Promise.resolve(null);
    },
  };
  return api;
}

async function openDay({ days = {}, feed = ics([]), local = {}, settings = {}, target, createError, suggest, searchIssues, onDayTotal } = {}) {
  const store = { icalRaw: feed, ...local };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(JSON.parse(JSON.stringify(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  fixClock(env.window);
  const api = fakeApi(days, { target, createError, suggest, searchIssues });
  env.window.OmniTime.openModal({
    apiClient: api,
    context: {},
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: 'myday',
    settings: { dayStart: 8, dayEnd: 17, ...settings },
    onDayTotal,
  });
  await settle(40);
  const root = uiRoot(env.document);
  return { ...env, root, api, store };
}

const texts = (root, sel) => [...root.querySelectorAll(sel)].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
const pop = (root) => root.querySelector('.omnitime-daypop');
const toastText = (root) => (root.querySelector('.omnitime-toast__msg') || {}).textContent;

describe('dayTarget / baseTarget / targetProgress / prevWorkingDay', () => {
  const { window } = loadDom(['core.js'], { styles: false });
  const O = window.OmniTime;

  it('gives the target on weekdays only, lowered by absences', () => {
    assert.equal(O.dayTarget('2026-10-21', 480), 480); // Wednesday
    assert.equal(O.dayTarget('2026-10-24', 480), 0); // Saturday
    assert.equal(O.dayTarget('2026-10-25', 480), 0); // Sunday
    assert.equal(O.dayTarget('2026-10-21', 480, { half_day: false }), 0);
    assert.equal(O.dayTarget('2026-10-21', 480, { half_day: true }), 240);
    assert.equal(O.dayTarget('2026-10-21', 450, { half_day: true }), 225);
    assert.equal(O.dayTarget('2026-10-21', 0), 0);
    assert.equal(O.dayTarget('2026-10-21', undefined), 0);
  });

  it('takes the API target, else the setting (0 = off), else 8 h', () => {
    assert.equal(O.baseTarget({ target_minutes: 420 }, { dailyTargetMinutes: 480 }), 420);
    assert.equal(O.baseTarget({}, { dailyTargetMinutes: 360 }), 360);
    assert.equal(O.baseTarget({}, {}), 480);
    assert.equal(O.baseTarget({ target_minutes: 480 }, { dailyTargetMinutes: 0 }), 0);
  });

  it('labels the progress: left, reached, over', () => {
    assert.deepEqual({ ...O.targetProgress(385, 480) }, { label: '1:35 left', pct: 80, state: 'left' });
    assert.deepEqual({ ...O.targetProgress(480, 480) }, { label: 'Target reached', pct: 100, state: 'reached' });
    assert.deepEqual({ ...O.targetProgress(500, 480) }, { label: '+0:20 over', pct: 100, state: 'over' });
    assert.equal(O.targetProgress(100, 0), null);
  });

  it('finds the previous working day (Monday → Friday)', () => {
    assert.equal(O.prevWorkingDay('2026-10-19'), '2026-10-16'); // Mon → Fri
    assert.equal(O.prevWorkingDay('2026-10-21'), '2026-10-20'); // Wed → Tue
    assert.equal(O.prevWorkingDay('2026-10-25'), '2026-10-23'); // Sun → Fri
    assert.equal(O.prevWorkingDay('2026-10-24'), '2026-10-23'); // Sat → Fri
  });
});

describe('findGaps', () => {
  const { window } = loadDom(['core.js'], { styles: false });
  const gaps = (opts) => JSON.parse(JSON.stringify(window.OmniTime.findGaps(opts).map((g) => [g.start, g.stop])));

  it('reports stretches of 15+ min inside working hours only', () => {
    const busy = [{ start: 420, stop: 540 }, { start: 600, stop: 610 }, { start: 620, stop: 700 }, { start: 1000, stop: 1100 }];
    // 08:00-17:00; 07:00-09:00 busy; 10:00-10:10; 10:20-11:40; 16:40-18:20
    assert.deepEqual(gaps({ busy, workStart: 480, workEnd: 1020 }), [[540, 600], [700, 1000]]);
  });

  it('keeps out of the busy spans (placeholders) and stops at the limit (now)', () => {
    const busy = [{ start: 540, stop: 600 }, { start: 780, stop: 810 }];
    assert.deepEqual(gaps({ busy, workStart: 480, workEnd: 1020, limit: 900 }), [[480, 540], [600, 780], [810, 900]]);
    assert.deepEqual(gaps({ busy, workStart: 480, workEnd: 1020, limit: 490 }), []);
    // A remainder under 15 minutes before "now" is no gap.
    assert.deepEqual(gaps({ busy, workStart: 480, workEnd: 1020, limit: 610 }), [[480, 540]]);
  });
});

describe('bookableMeetings', () => {
  const { window } = loadDom(['core.js'], { styles: false });
  const ev = (title, start, end, uid) => ({ title, startMinutes: start, endMinutes: end, durationMinutes: end - start, uid });
  const memory = {
    links: { 'uid:b@2026-10-21T10:00': { entryId: 5, date: '2026-10-21' }, 'uid:e@2026-10-21T15:00': { entryId: 99, date: '2026-10-21' } },
    issues: { 'uid:a': { id: 1, label: 'A #1' }, 'uid:b': { id: 2, label: 'B #2' }, 'uid:c': { id: 3, label: 'C #3' }, 'uid:d': { id: 4, label: 'D #4' }, 'uid:e': { id: 5, label: 'E #5' } },
  };
  const events = [
    ev('A', 540, 570, 'a'), // remembered, free → bookable
    ev('B', 600, 630, 'b'), // booked (its entry exists)
    ev('C', 720, 750, 'c'), // covered by an entry
    ev('D', 780, 810, 'd'), // hidden
    ev('E', 900, 960, 'e'), // linked entry gone → bookable again
    ev('F', 1000, 1030, 'f'), // no remembered issue
  ];
  const entries = [{ id: 5, start: '16:00', duration_minutes: 30 }, { id: 6, start: '12:15', duration_minutes: 30 }];

  it('picks unbooked, visible, uncovered events (a remembered issue is optional)', () => {
    const list = window.OmniTime.bookableMeetings(events, entries, '2026-10-21', memory, new Set(['uid:d@2026-10-21T13:00']));
    assert.deepEqual(JSON.parse(JSON.stringify(list.map((m) => [m.title, m.start, m.dur, m.issue && m.issue.id, m.cal.key]))), [
      ['A', 540, 30, 1, 'uid:a@2026-10-21T09:00'],
      ['E', 900, 60, 5, 'uid:e@2026-10-21T15:00'],
      ['F', 1000, 30, null, 'uid:f@2026-10-21T16:40'],
    ]);
  });

  it('only takes meetings of 5 to 240 minutes', () => {
    const list = window.OmniTime.bookableMeetings([ev('Short', 600, 603, 's'), ev('Long', 600, 850, 'l'), ev('Fine', 600, 605, 'f')], [], '2026-10-21', { links: {}, issues: {} }, new Set());
    assert.deepEqual(JSON.parse(JSON.stringify(list.map((m) => m.title))), ['Fine']);
  });
});

describe('footer progress', () => {
  it('shows the time left, reached and over beside the total', async () => {
    const { root } = await openDay({ days: { [TODAY]: [entry(1, '09:00', '14:30')] } });
    const progress = root.querySelector('.omnitime-progress');
    assert.equal(progress.hidden, false);
    assert.equal(progress.querySelector('.omnitime-progress__label').textContent, '2:30 left');
    assert.equal(progress.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '69');
    assert.equal(progress.querySelector('.omnitime-progress__fill').style.width, '69%');

    const { root: done } = await openDay({ days: { [TODAY]: [entry(1, '08:00', '12:00'), entry(2, '12:00', '16:00')] } });
    assert.equal(done.querySelector('.omnitime-progress__label').textContent, 'Target reached');
    const { root: over } = await openDay({ days: { [TODAY]: [entry(1, '08:00', '12:00'), entry(2, '12:00', '16:20')] } });
    assert.equal(over.querySelector('.omnitime-progress__label').textContent, '+0:20 over');
    assert.ok(over.querySelector('.omnitime-progress--over'));
  });

  it('falls back to the setting, and the setting 0 hides it', async () => {
    const { root } = await openDay({ days: { [TODAY]: [entry(1, '09:00', '10:00')] }, target: null, settings: { dailyTargetMinutes: 300 } });
    assert.equal(root.querySelector('.omnitime-progress__label').textContent, '4:00 left');
    const { root: off } = await openDay({ days: { [TODAY]: [entry(1, '09:00', '10:00')] }, settings: { dailyTargetMinutes: 0 } });
    assert.equal(off.querySelector('.omnitime-progress').hidden, true);
    assert.equal(off.querySelectorAll('.omnitime-tl__gap').length, 0);
  });
});

describe('untracked gaps', () => {
  const DAY = [entry(1, '09:00', '10:00'), entry(2, '10:30', '10:40'), entry(3, '11:00', '12:00')];

  it('marks gaps of 15+ min in working hours, not under placeholders, not after now', async () => {
    const { root, errors } = await openDay({ days: { [TODAY]: DAY.slice() }, feed: ics([['Planning', 13, 0, 13, 30, 'plan-1']]) });
    // 08:00-09:00, 10:00-10:30, (10:40-11:00 = 20), 12:00-13:00, Planning, 13:30-15:00 (now).
    assert.deepEqual(texts(root, '.omnitime-tl__gaptext'), ['1:00 untracked', '0:30 untracked', '0:20 untracked', '1:00 untracked', '1:30 untracked']);
    assert.deepEqual([...root.querySelectorAll('.omnitime-tl__gap')].map((g) => Number(g.dataset.start)), [480, 600, 640, 720, 810]);
    // Tab order = time order: each gap sits before the next later item.
    const order = [...root.querySelectorAll('.omnitime-tl__entry, .omnitime-tl__gap, .omnitime-tl__cal-event')].map((el) => Number(el.dataset.start));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.deepEqual(errors, []);
  });

  it('Fill opens the add form preselected to the gap', async () => {
    const { root } = await openDay({ days: { [TODAY]: DAY.slice() } });
    const fill = root.querySelectorAll('.omnitime-tl__gapfill')[1];
    assert.equal(fill.getAttribute('aria-label'), 'Fill 10:00–10:30, 0:30 untracked');
    fill.click();
    await settle();
    assert.ok(root.querySelector('.omnitime-myday__cols--form-open'));
    assert.equal(root.querySelector('.omnitime-f-start').value, '10:00');
    assert.equal(root.querySelector('.omnitime-f-dur').value, '0:30');
    assert.equal(root.querySelector('.omnitime-form__title').textContent, 'New entry');
  });

  it('shows no gaps on days without a target or without entries', async () => {
    const { root } = await openDay({ days: { [TODAY]: DAY.slice() }, target: 0 });
    assert.equal(root.querySelectorAll('.omnitime-tl__gap').length, 0);
    const { root: empty } = await openDay({ days: {} });
    assert.equal(empty.querySelectorAll('.omnitime-tl__gap').length, 0);
  });
});

describe('break cards', () => {
  it('renders break_label as a dotted rule with "Break H:MM" between the entries', async () => {
    const days = { [TODAY]: [entry(1, '09:00', '10:00'), entry(2, '10:20', '11:00', { break_label: '0:20' }), entry(3, '11:10', '12:00', { break_label: '0:10' })] };
    const { root } = await openDay({ days });
    const cards = [...root.querySelectorAll('.omnitime-tl__break')];
    // The 10-minute pause (11 px) has no room for the 18 px label band without
    // covering an entry, so its label is omitted.
    assert.deepEqual(cards.map((c) => c.querySelector('.omnitime-tl__breaktext').textContent), ['Break 0:20']);
    // A fillable pause carries its Fill on the rule (no separate gap slot).
    assert.ok(cards[0].querySelector('.omnitime-tl__gapfill'));
    assert.ok(!texts(root, '.omnitime-tl__gaptext').some((t) => t === '0:20 untracked'));
    // Between the two entries, in time order.
    const order = [...root.querySelectorAll('.omnitime-tl__entry, .omnitime-tl__break')].map((el) => el.className.split(' ')[0]);
    assert.deepEqual(order, ['omnitime-tl__entry', 'omnitime-tl__break', 'omnitime-tl__entry', 'omnitime-tl__entry']);
  });

  it('renders no card without break_label', async () => {
    const { root } = await openDay({ days: { [TODAY]: [entry(1, '09:00', '10:00'), entry(2, '10:20', '11:00')] } });
    assert.equal(root.querySelectorAll('.omnitime-tl__break').length, 0);
  });
});

// --- Book meetings: the step dialog ---
// Meetings on TODAY (the clock is 15:00): three have started, "Review" is later.
const FEED = ics([
  ['Lunch talk', 12, 15, 12, 45, 'talk-1'], ['Planning', 13, 0, 13, 30, 'plan-1'],
  ['Retro', 14, 0, 14, 45, 'retro-1'], ['Review', 16, 0, 16, 30, 'rev-1'],
]);
const rec = (id, ext, label, project, reason) => ({ issue_internal_id: id, issue_external_id: ext, label, project, milestone: null, link: `https://gitlab.example.test/-/issues/${ext}`, ...(reason ? { reason } : {}) });
const PLAN = { pre: rec(71, '7', 'Planning issue', 'Alpha'), h1: rec(81, '8', 'Menu & header', 'Alpha', 'history'), h2: rec(82, '9', 'Search meetings', 'Beta', 'history'), t1: rec(83, '10', 'Team rituals', 'Internal', 'time') };
// Planning: full history + a "time" suggestion; Retro: only "time" ones; the rest: nothing.
const suggestFor = ({ title }) => {
  if (title === 'Planning') return { preselected: PLAN.pre, suggestions: [PLAN.h1, PLAN.h2, PLAN.t1], history_count: 23 };
  if (title === 'Retro') return { preselected: null, suggestions: [rec(91, '11', 'Retainer daily', 'Beta', 'time')], history_count: 0 };
  return { preselected: null, suggestions: [], history_count: 0 };
};
// Every meeting preselected (ids 71..), no suggestions: for the booking runs.
const suggestAll = ({ title }) => ({ preselected: rec({ 'Lunch talk': 70, Planning: 71, Retro: 72, Review: 73 }[title], '1', `${title} issue`, 'Alpha'), suggestions: [], history_count: 1 });

const bk = (root) => root.querySelector('.omnitime-bk');
const bkRows = (root) => [...root.querySelectorAll('.omnitime-bk__row')];
const rowOf = (root, title) => bkRows(root).find((r) => r.querySelector('.omnitime-bk__name-title').textContent === title);
const bookOn = (row) => { const c = row.querySelector('.omnitime-bk__on .omnitime-bk__chiptext'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : null; };
const suggs = (row) => [...row.querySelectorAll('.omnitime-bk__sugg')].map((b) => b.querySelector('.omnitime-bk__chiptext').textContent.replace(/\s+/g, ' ').trim());
const openBook = async (opts) => {
  const f = await openDay(opts);
  f.btn = f.root.querySelector('.omnitime-bookall');
  f.btn.click();
  await settle(40);
  return f;
};
const clickEl = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, composed: true }));

describe('Book meetings: entry point', () => {
  it('shows "Book meetings <count>" only when meetings can be booked (acceptance 1)', async () => {
    const { root } = await openDay({ days: { [TODAY]: [entry(1, '09:00', '10:00')] }, feed: FEED });
    const btn = root.querySelector('.omnitime-bookall');
    assert.equal(btn.hidden, false);
    assert.equal(btn.textContent.replace(/\s+/g, ' ').trim(), 'Book meetings 4');
    // A meeting already covered by an entry doesn't count.
    const covered = await openDay({ days: { [TODAY]: [entry(1, '13:00', '13:30')] }, feed: FEED });
    assert.equal(covered.root.querySelector('.omnitime-bookall').textContent.replace(/\s+/g, ' ').trim(), 'Book meetings 3');
    // Nothing to book: no button.
    const none = await openDay({ days: { [TODAY]: [] }, feed: ics([]) });
    assert.equal(none.root.querySelector('.omnitime-bookall').hidden, true);
  });

  it('is shown on past days, hidden on future days', async () => {
    const feed = ics([['Yesterday talk', 10, 0, 10, 30, 'y-1', -1], ['Tomorrow talk', 10, 0, 10, 30, 't-1', 1]]);
    const { root } = await openDay({ days: {}, feed });
    const btn = root.querySelector('.omnitime-bookall');
    assert.equal(btn.hidden, true, 'no meetings today');
    root.querySelector('.omnitime-daynav [data-nav="prev"]').click();
    await settle(60);
    assert.equal(btn.hidden, false);
    assert.equal(btn.textContent.replace(/\s+/g, ' ').trim(), 'Book meetings 1');
    root.querySelector('.omnitime-daynav [data-nav="today"]').click();
    await settle(60);
    root.querySelector('.omnitime-daynav [data-nav="next"]').click();
    await settle(60);
    assert.equal(root.querySelectorAll('.omnitime-tl__cal-event').length, 1, 'tomorrow has its event on the timeline');
    assert.equal(btn.hidden, true);
  });

  it('checks the meetings that started, leaves later ones unchecked with a "later" tag', async () => {
    const { root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    assert.deepEqual(bkRows(root).map((r) => r.querySelector('.omnitime-bk__name-title').textContent), ['Lunch talk', 'Planning', 'Retro', 'Review']);
    assert.deepEqual(bkRows(root).map((r) => r.querySelector('.omnitime-bk__check').checked), [true, true, true, false]);
    assert.deepEqual(bkRows(root).map((r) => !!r.querySelector('.omnitime-bk__tag:not(.omnitime-bk__tag--warn)')), [false, false, false, true]);
    // On a past day every meeting has started.
    const past = await openDay({ days: {}, feed: ics([['Early', 10, 0, 10, 30, 'e-1', -1], ['Late', 23, 0, 23, 30, 'l-1', -1]]), suggest: suggestFor });
    past.root.querySelector('.omnitime-daynav [data-nav="prev"]').click();
    await settle(60);
    past.root.querySelector('.omnitime-bookall').click();
    await settle(40);
    assert.deepEqual(bkRows(past.root).map((r) => r.querySelector('.omnitime-bk__check').checked), [true, true]);
  });
});

describe('Book meetings: review step', () => {
  it('layers a labelled dialog over My day with the steps indicator and the date', async () => {
    const { root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const panel = root.querySelector('.omnitime-bk__panel');
    assert.ok(root.querySelector('.omnitime-modal').contains(panel), 'inside the shell dialog');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(panel.querySelector('#omnitime-bk-title').textContent, 'Book meetings · Wed 21 Oct');
    assert.equal(panel.getAttribute('aria-labelledby'), 'omnitime-bk-title');
    assert.deepEqual(texts(panel, '.omnitime-bk__step'), ['Review', 'Booking', 'Done']);
    assert.deepEqual([...panel.querySelectorAll('.omnitime-bk__step')].map((el) => el.getAttribute('aria-current')), ['step', null, null]);
  });

  it('preselects the most recent issue, lists the suggestions in order and marks "time" ones with a clock (acceptance 2)', async () => {
    const { root, api } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const plan = rowOf(root, 'Planning');
    assert.equal(bookOn(plan), '#7 Planning issue');
    assert.deepEqual(suggs(plan), ['#8 Menu & header', '#9 Search meetings', '#10 Team rituals']);
    const chips = [...plan.querySelectorAll('.omnitime-bk__sugg')];
    assert.deepEqual(chips.map((c) => !!c.querySelector('.ot-svg--clock')), [false, false, true]);
    assert.match(chips[2].title, /^Often booked around this time\n/);
    assert.match(chips[0].title, /^Booked for this meeting before\nAlpha . Menu & header #8$/);
    assert.equal(plan.querySelector('.omnitime-bk__on').title, 'Alpha – Planning issue #7');
    // The project colour stripe uses the timeline's hash.
    assert.match(plan.querySelector('.omnitime-bk__on .omnitime-bk__stripe').className, /omnitime-bk__stripe--p\d/);
    // Retro: only "time" suggestions, nothing preselected -> a prompt.
    const retro = rowOf(root, 'Retro');
    assert.equal(bookOn(retro), null);
    assert.equal(retro.querySelector('.omnitime-bk__ph').textContent, 'Choose an issue');
    assert.deepEqual(suggs(retro), ['#11 Retainer daily']);
    // The request carries the title, start and day.
    assert.deepEqual(api.calls.filter(([n]) => n === 'bookingSuggestions').map(([, p]) => p).find((p) => p.title === 'Planning'), { title: 'Planning', start: '13:00', date: TODAY });
  });

  it('shows placeholders while the suggestions load, then fills the rows', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { root } = await openBook({ days: {}, feed: FEED, suggest: (p) => gate.then(() => suggestFor(p)) });
    assert.equal(root.querySelectorAll('.omnitime-bk__skel').length, 4 * 4, 'a Book on + 3 chips per row');
    assert.equal(root.querySelector('.omnitime-bk__ok').disabled, true);
    assert.equal(root.querySelector('.omnitime-bk__hint').textContent, 'Loading suggestions…');
    release();
    await settle(40);
    assert.equal(root.querySelectorAll('.omnitime-bk__skel').length, 0);
    assert.equal(bookOn(rowOf(root, 'Planning')), '#7 Planning issue');
  });

  it('asks the server once per title|start|date while the modal is open', async () => {
    const f = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const count = () => f.api.calls.filter(([n]) => n === 'bookingSuggestions').length;
    assert.equal(count(), 4);
    clickEl(f.root.querySelector('.omnitime-bk__cancel'));
    f.btn.click();
    await settle(40);
    assert.equal(count(), 4, 'cached');
  });

  it('swaps a clicked suggestion with the Book on issue, exactly (acceptance 3)', async () => {
    const { root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const plan = rowOf(root, 'Planning');
    const second = plan.querySelectorAll('.omnitime-bk__sugg')[1];
    assert.equal(second.tagName, 'BUTTON', 'a real button: Enter and Space activate it');
    assert.equal(second.getAttribute('aria-label'), 'Use #9 Search meetings instead');
    clickEl(second);
    const after = rowOf(root, 'Planning');
    assert.equal(bookOn(after), '#9 Search meetings');
    assert.deepEqual(suggs(after), ['#8 Menu & header', '#7 Planning issue', '#10 Team rituals'], 'the previous issue takes the clicked chip\'s place');
    // The swapped chips animate (150 ms) and the focus stays at that position.
    assert.ok(after.querySelector('.omnitime-bk__on').classList.contains('omnitime-bk__chip--in'));
    assert.equal(root.activeElement, after.querySelectorAll('.omnitime-bk__sugg')[1]);
    assert.equal(root.querySelector('.omnitime-bk__live').textContent, 'Booking Planning on #9 Search meetings');
    // Swapping back restores the original order.
    clickEl(after.querySelectorAll('.omnitime-bk__sugg')[1]);
    assert.equal(bookOn(rowOf(root, 'Planning')), '#7 Planning issue');
    assert.deepEqual(suggs(rowOf(root, 'Planning')), ['#8 Menu & header', '#9 Search meetings', '#10 Team rituals']);
  });

  it('× moves the issue into the Suggestions and the row then needs an issue', async () => {
    const { root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    clickEl(rowOf(root, 'Planning').querySelector('.omnitime-bk__clear'));
    const plan = rowOf(root, 'Planning');
    assert.equal(bookOn(plan), null);
    assert.deepEqual(suggs(plan), ['#7 Planning issue', '#8 Menu & header', '#9 Search meetings']);
    assert.ok(plan.querySelector('.omnitime-bk__tag--warn'));
    assert.equal(root.querySelector('.omnitime-bk__ok').disabled, true);
  });

  it('blocks booking while a selected row has no issue, with a matching hint (acceptance 4)', async () => {
    const { root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const ok = root.querySelector('.omnitime-bk__ok');
    const hint = root.querySelector('.omnitime-bk__hint');
    // Lunch talk and Retro have no issue.
    assert.equal(ok.disabled, true);
    assert.equal(hint.textContent, '2 selected meetings need an issue');
    assert.equal(ok.getAttribute('aria-describedby'), hint.id);
    assert.ok(rowOf(root, 'Lunch talk').classList.contains('omnitime-bk__row--needs'));
    assert.equal(rowOf(root, 'Lunch talk').querySelector('.omnitime-bk__tag--warn').textContent, 'needs an issue');
    // Unchecking a row removes it from the count.
    const box = rowOf(root, 'Lunch talk').querySelector('.omnitime-bk__check');
    box.checked = false;
    box.dispatchEvent(new box.ownerDocument.defaultView.Event('change', { bubbles: true }));
    assert.equal(root.querySelector('.omnitime-bk__hint').textContent, '1 selected meeting needs an issue');
    assert.equal(root.querySelector('.omnitime-bk__summary').textContent, '2 of 4 selected · 1:15');
    // Choosing a suggestion fixes the other.
    clickEl(rowOf(root, 'Retro').querySelector('.omnitime-bk__sugg'));
    assert.equal(root.querySelector('.omnitime-bk__hint').textContent, '');
    assert.equal(root.querySelector('.omnitime-bk__ok').disabled, false);
    assert.equal(root.querySelector('.omnitime-bk__ok').textContent, 'Book 2 meetings');
    // Nothing selected: the button stays off.
    root.querySelectorAll('.omnitime-bk__check').forEach((b) => { if (b.checked) { b.checked = false; b.dispatchEvent(new b.ownerDocument.defaultView.Event('change', { bubbles: true })); } });
    assert.equal(root.querySelector('.omnitime-bk__ok').disabled, true);
    assert.equal(root.querySelector('.omnitime-bk__ok').textContent, 'Book meetings');
  });

  it('picks any issue with Search..., the previous one joins the Suggestions, max 3 (acceptance 5)', async () => {
    const found = rec(500, '50', 'Roadmap review', 'Gamma');
    const { window, root, api } = await openBook({ days: {}, feed: FEED, suggest: suggestFor, searchIssues: [found] });
    const plan = rowOf(root, 'Planning');
    clickEl(plan.querySelector('.omnitime-bk__find-btn'));
    const input = root.querySelector('.omnitime-bk__finder-input');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(root.activeElement, input);
    input.value = 'road';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(220);
    assert.deepEqual(api.calls.filter(([n]) => n === 'search'), [['search', 'road']]);
    const option = root.querySelector('.omnitime-bk__results .omnitime-search__item');
    assert.match(option.textContent, /Roadmap review/);
    clickEl(option);
    const after = rowOf(root, 'Planning');
    assert.equal(bookOn(after), '#50 Roadmap review');
    assert.deepEqual(suggs(after), ['#7 Planning issue', '#8 Menu & header', '#9 Search meetings'], 'previous first; the last one is dropped');
    assert.equal(root.querySelector('.omnitime-bk__finder-input'), null, 'the search closed');
    assert.equal(root.activeElement, after.querySelector('.omnitime-bk__find-btn'));
    // Picking the issue that is already booked on just closes the search.
    clickEl(after.querySelector('.omnitime-bk__find-btn'));
    root.querySelector('.omnitime-bk__finder-input').value = 'road';
    root.querySelector('.omnitime-bk__finder-input').dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(220);
    clickEl(root.querySelector('.omnitime-bk__results .omnitime-search__item'));
    assert.deepEqual(suggs(rowOf(root, 'Planning')), ['#7 Planning issue', '#8 Menu & header', '#9 Search meetings']);
  });

  it('offers Starred / Recent / Frequent on an empty query and Escape closes only the search', async () => {
    const { window, root } = await openBook({
      days: {}, feed: FEED, suggest: suggestFor,
      local: { omnitimeRecentIssues: [{ issue_id: 600, label: 'Recent thing #60' }] },
    });
    clickEl(rowOf(root, 'Retro').querySelector('.omnitime-bk__find-btn'));
    await settle(40);
    assert.deepEqual(texts(root, '.omnitime-search__group'), ['Recent']);
    assert.match(root.querySelector('.omnitime-bk__results').textContent, /Recent thing/);
    key(window, root.querySelector('.omnitime-bk__finder-input'), 'Escape');
    assert.equal(root.querySelector('.omnitime-bk__finder-input'), null);
    assert.ok(bk(root), 'the dialog is still open');
    key(window, root.querySelector('.omnitime-bk__panel'), 'Escape');
    assert.equal(bk(root), null);
  });

  it('moves between the checkboxes with Up / Down', async () => {
    const { window, root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    const boxes = [...root.querySelectorAll('.omnitime-bk__check')];
    boxes[0].focus();
    key(window, boxes[0], 'ArrowDown');
    assert.equal(root.activeElement, boxes[1]);
    key(window, boxes[1], 'ArrowUp');
    assert.equal(root.activeElement, boxes[0]);
    key(window, boxes[0], 'ArrowUp');
    assert.equal(root.activeElement, boxes[0], 'stops at the first row');
  });

  it('keeps My day shortcuts from acting behind the dialog and traps Tab', async () => {
    const { window, root } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    key(window, root.querySelector('.omnitime-bk__check'), 'n');
    assert.equal(root.querySelector('.omnitime-myday__cols--form-open'), null, 'N did not open the new entry form');
    const panel = root.querySelector('.omnitime-bk__panel');
    const focusable = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled])')];
    const last = focusable[focusable.length - 1];
    last.focus();
    key(window, last, 'Tab');
    assert.equal(root.activeElement, focusable[0], 'wraps to the first control inside the dialog');
    key(window, focusable[0], 'Tab', { shiftKey: true });
    assert.equal(root.activeElement, last);
  });

  it('Escape and Cancel close it without asking, and the focus returns to the button', async () => {
    const { window, root, btn, api } = await openBook({ days: {}, feed: FEED, suggest: suggestFor });
    key(window, root.querySelector('.omnitime-bk__panel'), 'Escape');
    assert.equal(bk(root), null);
    assert.equal(root.activeElement, btn);
    btn.click();
    await settle(20);
    clickEl(root.querySelector('.omnitime-bk__cancel'));
    assert.equal(bk(root), null);
    assert.equal(api.calls.filter(([n]) => n === 'create').length, 0);
  });
});

describe('Book meetings: local history fallback (acceptance 8)', () => {
  const hist = (...ids) => ids.map((id, i) => ({ id, label: `Issue ${id} #${id}`, at: `2026-10-${String(20 - i).padStart(2, '0')}T10:00:00.000Z` }));

  it('applies the same 5/10/30 windows to the local history', () => {
    const { window } = loadDom(['core.js'], { styles: false });
    const local = (entry) => JSON.parse(JSON.stringify(window.OmniTime.localBookingSuggestions(entry)));
    // Newest first: window 1 = [1,1,2,1,1], window 2 = [3,1,4,3,3]: pre 1, then 2 (window 1), 3, 4 (window 2).
    const r = local({ id: 9, label: 'Old #9', history: hist(1, 1, 2, 1, 1, 3, 1, 4, 3, 3, 5, 6) });
    assert.equal(r.preselected.id, 1);
    assert.deepEqual(r.suggestions.map((s) => s.id), [2, 3, 4]);
    assert.ok(r.suggestions.every((s) => s.reason === 'history'));
    assert.equal(r.from, 'local');
    // An issue only in H[12] comes after one in H[6]; distinct, max 3.
    const h = hist(...Array(12).fill(1), 7, 8);
    h.splice(6, 1, { id: 2, label: 'Issue 2 #2', at: 'x' });
    h.splice(12, 0, { id: 3, label: 'Issue 3 #3', at: 'x' });
    assert.deepEqual(local({ history: h }).suggestions.map((s) => s.id), [2, 3, 7]);
    // No history: the remembered issue is the preselection, no suggestions.
    const only = local({ id: 55, label: 'Sync issue #5' });
    assert.equal(only.preselected.id, 55);
    assert.equal(only.preselected.ext, '5');
    assert.deepEqual(only.suggestions, []);
    assert.deepEqual(local(undefined), { preselected: null, suggestions: [], from: null });
  });

  it('server result wins; the remembered issue stands in when it has no preselection', () => {
    const { window } = loadDom(['core.js'], { styles: false });
    const resolve = (server, entry) => JSON.parse(JSON.stringify(window.OmniTime.resolveBookingSuggestions(server, entry)));
    const server = { preselected: PLAN.pre, suggestions: [PLAN.pre, PLAN.h1, PLAN.h1, PLAN.h2, PLAN.t1, rec(84, '12', 'Fifth', 'X', 'time')] };
    const r = resolve(server, { id: 1, label: 'Local #1', history: hist(1, 2, 3) });
    assert.equal(r.preselected.id, 71);
    assert.equal(r.from, 'server');
    assert.deepEqual(r.suggestions.map((s) => s.id), [81, 82, 83], 'never the preselected one, distinct, max 3');
    assert.deepEqual(r.suggestions.map((s) => s.reason), ['history', 'history', 'time']);
    const fallback = resolve({ preselected: null, suggestions: [PLAN.t1] }, { id: 55, label: 'Sync issue #5' });
    assert.equal(fallback.preselected.id, 55);
    assert.equal(fallback.from, 'local');
    assert.deepEqual(fallback.suggestions.map((s) => s.id), [83]);
    assert.equal(resolve({ preselected: null, suggestions: [] }, undefined).preselected, null);
    assert.deepEqual(resolve(null, { id: 55, label: 'Sync issue #5' }).preselected.id, 55, 'no server answer: local');
  });

  it('swap and pick keep the previous issue in the list', () => {
    const { window } = loadDom(['core.js'], { styles: false });
    const O = window.OmniTime;
    const i = (id) => ({ id, ext: String(id), name: `I${id}` });
    const swapped = O.swapSuggestion(i(1), [i(2), i(3), i(4)], 1);
    assert.deepEqual([swapped.current.id, swapped.suggestions.map((s) => s.id)], [3, [2, 1, 4]]);
    assert.deepEqual(O.swapSuggestion(null, [i(2), i(3)], 0).suggestions.map((s) => s.id), [3]);
    const picked = O.pickSuggestion(i(1), [i(2), i(3), i(4)], i(9));
    assert.deepEqual([picked.current.id, picked.suggestions.map((s) => s.id)], [9, [1, 2, 3]]);
    assert.deepEqual(O.pickSuggestion(i(1), [i(2), i(3)], i(3)).suggestions.map((s) => s.id), [1, 2], 'a picked suggestion is no longer suggested');
  });

  it('falls back to the local history when the endpoint is missing', async () => {
    const local = { omnitimeCalIssues: { 'uid:plan-1': { id: 71, label: 'Planning issue #7', title: 'Planning', history: hist(71, 72, 71, 73, 74, 75) } } };
    const { root, api } = await openBook({ days: {}, feed: FEED, local });
    assert.ok(api.calls.some(([n]) => n === 'bookingSuggestions'), 'asked first');
    const plan = rowOf(root, 'Planning');
    assert.equal(bookOn(plan), '#71 Issue 71');
    assert.deepEqual(suggs(plan), ['#72 Issue 72', '#73 Issue 73', '#74 Issue 74']);
    assert.equal(plan.querySelectorAll('.ot-svg--clock').length, 0, 'local suggestions are history, no clock');
    assert.equal(bookOn(rowOf(root, 'Retro')), null);
  });

  it('also falls back when the request fails (e.g. a 500)', async () => {
    const local = { omnitimeCalIssues: { 'uid:plan-1': { id: 71, label: 'Planning issue #7' } } };
    const { root } = await openBook({ days: {}, feed: FEED, local, suggest: () => { throw Object.assign(new Error('boom'), { status: 500 }); } });
    assert.equal(bookOn(rowOf(root, 'Planning')), '#7 Planning issue');
  });

  it('uses the remembered issue when the server has no history for the meeting', async () => {
    const local = { omnitimeCalIssues: { 'uid:retro-1': { id: 55, label: 'Retro issue #5' } } };
    const { root } = await openBook({ days: {}, feed: FEED, local, suggest: suggestFor });
    const retro = rowOf(root, 'Retro');
    assert.equal(bookOn(retro), '#5 Retro issue');
    assert.deepEqual(suggs(retro), ['#11 Retainer daily']);
  });
});

describe('Book meetings: booking, done, undo (acceptances 6, 7)', () => {
  const chosenIssues = (api) => api.calls.filter(([n]) => n === 'create').map(([, b]) => ({ ...b }));
  const progressTexts = (root) => texts(root, '.omnitime-bk__prow');

  it('books the checked rows one at a time, in order, with per-row status, then hides them', async () => {
    let total = null;
    const f = await openBook({
      days: { [TODAY]: [entry(1, '09:00', '10:00')] }, feed: FEED, suggest: suggestAll,
      onDayTotal: (date, minutes) => { total = [date, minutes]; },
    });
    let inflight = 0;
    let max = 0;
    const create = f.api.create;
    f.api.create = async (p) => { inflight++; max = Math.max(max, inflight); await settle(8); inflight--; return create(p); };
    const { root, api, store } = f;
    // Leave the "Retro" row out.
    const box = rowOf(root, 'Retro').querySelector('.omnitime-bk__check');
    box.checked = false;
    box.dispatchEvent(new box.ownerDocument.defaultView.Event('change', { bubbles: true }));
    clickEl(root.querySelector('.omnitime-bk__ok'));
    // Booking step: spinner on the running row, the close controls are off.
    assert.deepEqual([...root.querySelectorAll('.omnitime-bk__step')].map((el) => el.getAttribute('aria-current')), [null, 'step', null]);
    assert.equal(root.querySelector('.omnitime-bk__x').disabled, true);
    await settle(120);
    assert.equal(max, 1, 'one request at a time');
    assert.deepEqual(chosenIssues(api), [
      { date: TODAY, start_time: '12:15', duration: 30, comment: 'Lunch talk', issue_internal_id: 70 },
      { date: TODAY, start_time: '13:00', duration: 30, comment: 'Planning', issue_internal_id: 71 },
    ]);
    // Done: summary, per-row ✓, Undo + Done.
    assert.deepEqual([...root.querySelectorAll('.omnitime-bk__step')].map((el) => el.getAttribute('aria-current')), [null, null, 'step']);
    assert.equal(root.querySelector('.omnitime-bk__result').textContent.replace(/\s+/g, ' ').trim(), 'Booked 2 meetings · 1:00');
    assert.equal(root.querySelectorAll('.omnitime-bk__prow--ok').length, 2);
    assert.equal(root.querySelector('.omnitime-bk__cancel').textContent, 'Undo');
    assert.equal(root.querySelector('.omnitime-bk__ok').textContent, 'Done');
    assert.equal(root.activeElement, root.querySelector('.omnitime-bk__ok'));
    // Remembered as the single form does: links, issue + history, recent issues.
    assert.deepEqual(store.omnitimeCalLinks, {
      'uid:talk-1@2026-10-21T12:15': { entryId: 500, date: TODAY },
      'uid:plan-1@2026-10-21T13:00': { entryId: 501, date: TODAY },
    });
    const plan = store.omnitimeCalIssues['uid:plan-1'];
    assert.deepEqual([plan.id, plan.label, plan.title, plan.project], [71, 'Planning issue #1', 'Planning', 'Alpha']);
    assert.deepEqual(plan.history.map((h) => [h.id, h.label]), [[71, 'Planning issue #1']]);
    assert.deepEqual(store.omnitimeRecentIssues.map((r) => r.issue_id), [71, 70]);

    // Done closes, reloads quietly and reports today's total.
    clickEl(root.querySelector('.omnitime-bk__ok'));
    await settle(60);
    assert.equal(bk(root), null);
    assert.equal(root.activeElement, f.btn);
    assert.deepEqual(total, [TODAY, 60 + 60]);
    const names = texts(root, '.omnitime-tl__cal-name');
    assert.ok(!names.includes('Lunch talk') && !names.includes('Planning'), 'booked events disappear');
    assert.ok(names.includes('Retro') && names.includes('Review'));
    assert.equal(f.btn.textContent.replace(/\s+/g, ' ').trim(), 'Book meetings 2');
  });

  it('continues after a failure, shows the friendly error, retries and undoes exactly what was created', async () => {
    const closed = Object.assign(new Error('The issue is closed.'), { status: 400 });
    const f = await openBook({ days: {}, feed: FEED, suggest: suggestAll, createError: (p, n) => (n === 2 ? closed : null) });
    const { root, api, store } = f;
    clickEl(root.querySelector('.omnitime-bk__ok'));
    await settle(80);
    // Lunch talk ok, Planning failed, Retro still booked.
    assert.equal(chosenIssues(api).length, 3, 'the run did not stop at the failure');
    assert.deepEqual(chosenIssues(api).map((b) => b.comment), ['Lunch talk', 'Planning', 'Retro']);
    const rows = [...root.querySelectorAll('.omnitime-bk__prow')];
    assert.deepEqual(rows.map((r) => r.className.match(/prow--(\w+)/)[1]), ['ok', 'fail', 'ok']);
    assert.match(rows[1].textContent, /The issue is closed\./);
    assert.equal(rows[1].querySelector('[data-act="retry"]').textContent, 'Retry');
    const failedText = root.querySelector('.omnitime-bk__result').textContent.replace(/\s+/g, ' ').trim();
    assert.equal(failedText, 'Booked 2 meetings · 1:15 1 failed · Retry failed');
    assert.deepEqual(Object.keys(store.omnitimeCalLinks).sort(), ['uid:retro-1@2026-10-21T14:00', 'uid:talk-1@2026-10-21T12:15']);

    // Retry books it (the next create works).
    clickEl(rows[1].querySelector('[data-act="retry"]'));
    await settle(80);
    assert.equal(chosenIssues(api).length, 4);
    assert.equal(root.querySelectorAll('.omnitime-bk__prow--ok').length, 3);
    assert.equal(root.querySelector('.omnitime-bk__result').textContent.replace(/\s+/g, ' ').trim(), 'Booked 3 meetings · 1:45');
    assert.equal(root.querySelector('[data-act="retry-all"]'), null);
    assert.equal(Object.keys(store.omnitimeCalLinks).length, 3);

    // Undo deletes exactly the created entries and their links, then closes.
    clickEl(root.querySelector('.omnitime-bk__cancel'));
    await settle(80);
    assert.deepEqual(api.calls.filter(([n]) => n === 'remove').map(([, id]) => id).sort(), [500, 501, 502]);
    assert.deepEqual(store.omnitimeCalLinks, {});
    assert.deepEqual(api.days[TODAY], []);
    assert.equal(bk(root), null);
    assert.equal(toastText(root), 'Booking undone');
    assert.equal(f.btn.textContent.replace(/\s+/g, ' ').trim(), 'Book meetings 4');
    // The local history is not rolled back ("restores nothing else").
    assert.equal(store.omnitimeCalIssues['uid:plan-1'].history.length, 1);
  });

  it('"Retry failed" retries every failed row', async () => {
    const bad = Object.assign(new Error('Server error'), { status: 500 });
    const f = await openBook({ days: {}, feed: FEED, suggest: suggestAll, createError: (p, n) => (n <= 3 ? bad : null) });
    const { root, api } = f;
    clickEl(root.querySelector('.omnitime-bk__ok'));
    await settle(80);
    assert.equal(root.querySelectorAll('.omnitime-bk__prow--fail').length, 3);
    assert.match(root.querySelector('.omnitime-bk__prow--fail').textContent, /1x TIMES had a problem/);
    assert.equal(root.querySelector('.omnitime-bk__result strong').textContent, 'No meetings booked');
    assert.equal(root.querySelector('.omnitime-bk__cancel').hidden, true, 'nothing to undo');
    clickEl(root.querySelector('[data-act="retry-all"]'));
    await settle(100);
    assert.equal(chosenIssues(api).length, 6);
    assert.equal(root.querySelectorAll('.omnitime-bk__prow--ok').length, 3);
  });

  it('cannot be closed while a request runs', async () => {
    let finish;
    const f = await openBook({ days: {}, feed: FEED, suggest: suggestAll });
    f.api.create = () => new Promise((resolve) => { finish = () => resolve({ id: 900 }); });
    clickEl(f.root.querySelector('.omnitime-bk__ok'));
    await settle(20);
    key(f.window, f.root.querySelector('.omnitime-bk__panel'), 'Escape');
    assert.ok(bk(f.root), 'Escape is ignored while booking');
    clickEl(f.root.querySelector('.omnitime-bk__x'));
    assert.ok(bk(f.root));
    assert.ok(f.root.querySelector('.omnitime-bk__spinner'));
    finish();
    await settle(20);
  });

  it('books a searched issue through its tracker ids when only those are known (Recent)', async () => {
    const f = await openBook({
      days: {}, feed: ics([['Solo', 13, 0, 13, 30, 'solo-1']]),
      local: { omnitimeRecentIssues: [{ source: 'gitlab', project_id: '5', issue_id: '12', label: 'Tracker issue #12' }] },
    });
    clickEl(f.root.querySelector('.omnitime-bk__find-btn'));
    await settle(40);
    clickEl(f.root.querySelector('.omnitime-bk__results .omnitime-search__item'));
    assert.equal(bookOn(rowOf(f.root, 'Solo')), '#12 Tracker issue');
    clickEl(f.root.querySelector('.omnitime-bk__ok'));
    await settle(60);
    assert.deepEqual(chosenIssues(f.api), [{ date: TODAY, start_time: '13:00', duration: 30, comment: 'Solo', source: 'gitlab', project_id: '5', issue_id: '12' }]);
    assert.equal(f.store.omnitimeRecentIssues[0].source, 'gitlab');
  });
});

describe('Copy from the previous working day', () => {
  const PREV = '2026-10-20';

  it('offers the previous working day on an empty day and copies the picked entries', async () => {
    const closed = Object.assign(new Error('The issue is closed.'), { status: 400 });
    const { root, api } = await openDay({
      days: { [PREV]: [entry(2, '10:00', '10:30', { status: 'booked', editable: false }), entry(1, '09:00', '09:45'), entry(3, '11:00', '11:15', { issue_internal_id: 99 })] },
      createError: (payload) => (payload.issue_internal_id === 99 ? closed : null),
    });
    const btn = root.querySelector('.omnitime-tl__copy');
    assert.equal(btn.textContent, 'Copy from Tue 20 Oct');
    btn.click();
    await settle();
    const p = pop(root);
    assert.equal(p.querySelector('.omnitime-daypop__head').textContent, 'Copy from Tue 20 Oct');
    // Time order, with issue, time, duration and comment.
    assert.deepEqual(texts(p, '.omnitime-daypop__meta'), ['09:00–09:45 · 0:45 · Work 1', '10:00–10:30 · 0:30 · Work 2', '11:00–11:15 · 0:15 · Work 3']);
    assert.equal(p.querySelector('.omnitime-daypop__ok').textContent, 'Copy 3 entries');
    p.querySelector('.omnitime-daypop__ok').click();
    await settle(60);

    assert.deepEqual(api.calls.filter(([n]) => n === 'create').map(([, b]) => ({ ...b })), [
      { date: TODAY, start_time: '09:00', duration: 45, comment: 'Work 1', issue_internal_id: 1001 },
      { date: TODAY, start_time: '10:00', duration: 30, comment: 'Work 2', issue_internal_id: 1002 },
      { date: TODAY, start_time: '11:00', duration: 15, comment: 'Work 3', issue_internal_id: 99 },
    ]);
    // The rejected (closed) one is skipped and reported; the rest went in.
    assert.match(pop(root).textContent, /Copied 2 entries; 1 skipped/);
    assert.match(pop(root).querySelector('.omnitime-daypop__skipped').textContent, /The issue is closed\./);
    assert.equal(toastText(root), 'Copied 2 entries');
    assert.equal(root.querySelectorAll('.omnitime-tl__entry').length, 2);

    root.querySelector('.omnitime-toast__action').click();
    await settle(60);
    assert.deepEqual(api.calls.filter(([n]) => n === 'remove').map(([, id]) => id), [500, 501]);
    assert.equal(root.querySelectorAll('.omnitime-tl__entry').length, 0);
  });

  it('is not offered on future days', async () => {
    const { root } = await openDay({ days: {} });
    assert.ok(root.querySelector('.omnitime-tl__copy'));
    root.querySelector('.omnitime-daynav [data-nav="next"]').click();
    await settle(40);
    assert.equal(root.querySelector('.omnitime-tl__copy'), null);
  });
});
