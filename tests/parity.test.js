// Visual-parity conventions (SPEC-parity): ISO week numbers, the day meters in
// the strip and the Week tab, entry anatomy (meta -> title + muted #id ->
// comment), booked entries, "New entry" copy, breaks that never cover an
// entry or a calendar placeholder, the collapsed weekend, "target off".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, makeEvent, settle, icsStamp } = require('./helpers');

// Fixed clock: Wednesday 21 Oct 2026 (ISO week 43), 15:00.
const FIXED = new Date(2026, 9, 21, 15, 0).getTime();
function fixClock(window) {
  const Real = window.Date;
  class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  window.Date = FakeDate;
}
const TODAY = '2026-10-21';
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

const entry = (id, start, stop, extra = {}) => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = stop.split(':').map(Number);
  const dur = eh * 60 + em - (sh * 60 + sm);
  return {
    id, start, stop, duration_minutes: dur, duration_label: `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`,
    project: 'Internal', milestone: 'Ops', issue_label: 'Internal / Standup', issue_external_id: String(id), issue_internal_id: 1000 + id,
    issue_link: '', comment: `Work ${id}`, status: 'unbooked', editable: true, break_label: null, active: false, ...extra,
  };
};

async function open({ entries = [], totals = {}, week, absences = [], settings = {}, tab = 'myday', feed } = {}) {
  const store = feed ? { icalRaw: feed } : {};
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  fixClock(env.window);
  const api = {
    issueTime: async () => ({ tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    frequent: async () => ({ issues: [] }),
    search: async () => ({ issues: [] }),
    create: async () => ({ id: 9 }),
    update: async () => ({}),
    remove: async () => null,
    myDay: async (date) => ({
      date,
      week: WEEK.map((d) => ({ label: 'x', date: d, total_minutes: totals[d] || 0, total_label: `${Math.floor((totals[d] || 0) / 60)}:${String((totals[d] || 0) % 60).padStart(2, '0')}`, active: d === date })),
      week_total_label: '0:00',
      day_total_label: '0:00',
      day_total_minutes: 0,
      target_minutes: 480,
      entries: date === TODAY ? entries : [],
    }),
    week: async () => week || { date: TODAY, daily_working_hours: 8, week_entries: [], absences },
  };
  env.window.OmniTime.openModal({ apiClient: api, context: {}, activeTab: tab, icalUrl: feed ? 'https://calendar.example.test/basic.ics' : '', settings: { dayStart: 8, dayEnd: 17, ...settings } });
  await settle();
  return { ...env, root: uiRoot(env.document), q: (sel) => uiRoot(env.document).querySelector(sel) };
}

const cell = (f, date) => f.root.querySelector(`.omnitime-week__day[data-date="${date}"]`);
const meterOf = (el) => el.querySelector('.omnitime-meter');

describe('isoWeek', () => {
  const { window } = loadDom(['core.js']);
  const wk = (d) => window.OmniTime.isoWeek(d);
  it('numbers the weeks of ISO 8601', () => {
    assert.equal(wk('2026-10-22'), 43);
    assert.equal(wk('2026-10-19'), 43);
    assert.equal(wk('2026-10-25'), 43);
  });
  it('handles the year boundaries', () => {
    assert.equal(wk('2026-12-31'), 53);
    assert.equal(wk('2027-01-03'), 53);
    assert.equal(wk('2027-01-04'), 1);
    assert.equal(wk('2024-12-30'), 1);
    assert.equal(wk('2021-01-03'), 53);
  });
});

describe('header and copy', () => {
  it('orders Today, previous, next, then the date and "Week 43"; Today is disabled on today', async () => {
    const f = await open();
    const nav = f.q('.omnitime-daynav');
    assert.deepEqual([...nav.children].map((c) => c.className.split(' ')[0]), ['omnitime-daynav__group', 'omnitime-daynav__label', 'omnitime-daynav__week', 'omnitime-daynav__btn']);
    assert.equal(f.q('.omnitime-daynav__week').textContent, 'Week 43');
    const today = f.q('[data-nav="today"]');
    assert.equal(today.disabled, true);
    f.q('[data-nav="next"]').click();
    await settle();
    assert.equal(today.disabled, false);
    assert.equal(f.q('.omnitime-daynav__week').textContent, 'Week 43');
  });

  it('calls the primary button and the empty hint "New entry"', async () => {
    const f = await open();
    assert.equal(f.q('.omnitime-add-btn').textContent.trim(), 'New entry');
    assert.match(f.q('.omnitime-tl__emptytext').textContent, /Click the timeline or New entry\.$/);
  });

  it('shows "19–25 Oct · Week 43" and the total in the Week tab', async () => {
    const f = await open({ tab: 'week' });
    assert.equal(f.q('.omnitime-wk__range').textContent.replace(/\s+/g, ' '), '19–25 Oct · Week 43');
    assert.equal(f.q('[data-nav="this"]').disabled, true);
    assert.match(f.q('.omnitime-wk__sum').textContent, /^Total 0:00/);
  });
});

describe('day meters in the week strip', () => {
  const totals = { '2026-10-19': 480, '2026-10-20': 330, [TODAY]: 120, '2026-10-22': 60, '2026-10-24': 90 };

  it('shows met, under and today bars, none for future days and weekends', async () => {
    const f = await open({ totals });
    const state = (d) => { const m = meterOf(cell(f, d)); return m && [...m.classList].find((c) => /--(met|under|today)$/.test(c)).split('--')[1]; };
    assert.equal(state('2026-10-19'), 'met');
    assert.equal(state('2026-10-20'), 'under');
    assert.equal(state(TODAY), 'today');
    assert.equal(state('2026-10-22'), null, 'future: no bar');
    assert.equal(state('2026-10-24'), null, 'Saturday: no target');
    assert.equal(meterOf(cell(f, '2026-10-20')).firstChild.style.width, '69%');
    assert.ok(cell(f, '2026-10-20').classList.contains('omnitime-week__day--under'));
  });

  it('describes each day for screen readers', async () => {
    const f = await open({ totals });
    assert.equal(cell(f, '2026-10-19').getAttribute('aria-label'), 'Mon 19 Oct: 8:00 of 8:00 (target met)');
    assert.equal(cell(f, '2026-10-20').getAttribute('aria-label'), 'Tue 20 Oct: 5:30 of 8:00 (2:30 under target)');
    assert.equal(cell(f, TODAY).getAttribute('aria-label'), 'Wed 21 Oct: 2:00 of 8:00 (in progress) (today)');
  });

  it('drops the bar of a day that turns out to be fully absent', async () => {
    const f = await open({ totals, absences: [{ date: '2026-10-20', half_day: false }] });
    await settle();
    assert.equal(meterOf(cell(f, '2026-10-20')), null);
    assert.match(cell(f, '2026-10-20').getAttribute('aria-label'), /absent$/);
  });

  it('has no bars when the daily target is off', async () => {
    const f = await open({ totals, settings: { dailyTargetMinutes: 0 } });
    assert.equal(f.root.querySelectorAll('.omnitime-week .omnitime-meter').length, 0);
  });
});

describe('entry anatomy', () => {
  const tall = entry(5, '09:00', '11:30', { comment: 'Search API wired up' });

  it('orders meta, title with a muted #id, then the comment; no pills', async () => {
    const f = await open({ entries: [tall] });
    const block = f.q('.omnitime-tl__entry');
    const kids = [...block.children].filter((c) => !c.classList.contains('omnitime-tl__handle')).map((c) => c.className.split(' ')[0]);
    assert.deepEqual(kids, ['omnitime-tl__entry-top', 'omnitime-tl__entrytitle', 'omnitime-tl__entrycomment']);
    assert.equal(block.querySelector('.omnitime-tl__entrytitle').textContent, 'Standup #5');
    assert.equal(block.querySelector('.omnitime-entryid').textContent.trim(), '#5');
    assert.equal(block.querySelector('.omnitime-tl__time').textContent, '09:00–11:30');
    assert.equal(block.querySelector('.omnitime-tl__dur').textContent, '2:30');
    assert.ok(!block.querySelector('.omnitime-tl__lock, .omnitime-tl__entryissue'), 'no chips');
  });

  it('marks booked entries with a lock glyph and the booked surface', async () => {
    const booked = entry(6, '13:00', '15:00', { editable: false, status: 'booked' });
    const f = await open({ entries: [tall, booked] });
    const [a, b] = f.root.querySelectorAll('.omnitime-tl__entry');
    assert.equal(a.querySelector('.ot-svg--lock'), null, 'editable: no glyph');
    assert.ok(!a.classList.contains('omnitime-tl__entry--booked'));
    assert.ok(b.classList.contains('omnitime-tl__entry--booked'));
    assert.ok(b.querySelector('.omnitime-tl__dur .ot-svg--lock'));
    assert.match(b.getAttribute('aria-label'), /\(booked, read-only\)$/);
  });

  it('shows time + project (right), the issue, the comment and the duration (bottom right) on Week cards', async () => {
    const week = { date: TODAY, daily_working_hours: 8, absences: [], week_entries: [
      { ...entry(1, '09:30', '11:45'), date: TODAY },
      { ...entry(2, '13:00', '15:00', { editable: false, status: 'booked', break_label: '1:15', comment: '' }), date: TODAY },
    ] };
    const f = await open({ tab: 'week', week });
    const [a, b] = f.root.querySelectorAll('.omnitime-wk__entry');
    assert.deepEqual([...a.children].map((c) => c.className), ['omnitime-wk__meta', 'omnitime-wk__issue', 'omnitime-wk__comment', 'omnitime-wk__dur']);
    assert.deepEqual([...a.firstElementChild.children].map((c) => c.className), ['omnitime-wk__time', 'omnitime-wk__project']);
    assert.equal(a.querySelector('.omnitime-wk__time').textContent, '09:30–11:45');
    assert.equal(a.querySelector('.omnitime-wk__project').textContent, 'Internal');
    assert.equal(a.querySelector('.omnitime-wk__issue').textContent, 'Standup #1');
    assert.equal(a.querySelector('.omnitime-wk__dur').textContent, '2:15');
    assert.match(a.title, /^Internal\nStandup #1\n/, 'the tooltip has everything');
    assert.ok(b.classList.contains('omnitime-wk__entry--booked'));
    assert.ok(b.querySelector('.omnitime-wk__dur .ot-svg--lock'), 'lock glyph before the duration');
    assert.equal(b.querySelector('.omnitime-wk__project').textContent, 'Internal');
    assert.equal(b.querySelector('.omnitime-wk__comment'), null);
    // The break sits between the cards as a rule with centred text.
    const brk = f.q('.omnitime-wk__break');
    assert.equal(brk.textContent, 'Break 1:15');
    assert.equal(brk.previousElementSibling, a);
    assert.equal(brk.nextElementSibling, b);
  });
});

describe('Week tab layout', () => {
  const week = { date: TODAY, daily_working_hours: 8, absences: [], week_entries: [
    { ...entry(1, '09:00', '10:00'), date: TODAY },
    { ...entry(2, '10:00', '11:00'), date: '2026-10-24' },
  ] };

  it('collapses an empty weekend day, not one with entries', async () => {
    const f = await open({ tab: 'week', week });
    const day = (d) => f.q(`.omnitime-wk__day[data-date="${d}"]`);
    assert.ok(!day('2026-10-20').classList.contains('omnitime-wk__day--collapsed'));
    assert.ok(!day('2026-10-24').classList.contains('omnitime-wk__day--collapsed'));
    assert.ok(day('2026-10-25').classList.contains('omnitime-wk__day--collapsed'));
    // A weekend with time always shows, so there is nothing to toggle.
    assert.equal(f.q('.omnitime-wk__weekend').hidden, true);
  });

  it('gives every head the meter and flag rows, with the bar only where there is a target', async () => {
    const f = await open({ tab: 'week', week });
    const heads = [...f.root.querySelectorAll('.omnitime-wk__head')];
    assert.ok(heads.every((h) => h.querySelector('.omnitime-wk__meter') && h.querySelector('.omnitime-wk__flags')));
    const bar = (d) => f.q(`.omnitime-wk__day[data-date="${d}"] .omnitime-meter`);
    assert.ok(bar('2026-10-19').classList.contains('omnitime-meter--under'));
    assert.ok(bar(TODAY).classList.contains('omnitime-meter--today'));
    assert.equal(bar('2026-10-22'), null, 'future');
    assert.equal(bar('2026-10-24'), null, 'weekend');
    assert.match(f.q(`.omnitime-wk__head[aria-current]`).getAttribute('aria-label'), /^Wed 21 Oct: 1:00 of 8:00 \(in progress\) \(today\)/);
  });

  it('shows no targets, states or meters when the daily target is off', async () => {
    const f = await open({ tab: 'week', week, settings: { dailyTargetMinutes: 0 } });
    assert.equal(f.root.querySelectorAll('.omnitime-wk .omnitime-meter').length, 0);
    assert.equal(f.root.querySelectorAll('.omnitime-wk__of').length, 0);
    assert.equal(f.root.querySelectorAll('.omnitime-wk__day--met, .omnitime-wk__day--under').length, 0);
  });
});

describe('breaks and calendar placeholders', () => {
  const feed = (events) => ['BEGIN:VCALENDAR', ...events.flatMap(([title, sh, sm, eh, em, uid]) => {
    const d = new Date(2026, 9, 21);
    return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${icsStamp(d, sh, sm)}`, `DTEND:${icsStamp(d, eh, em)}`, 'END:VEVENT'];
  }), 'END:VCALENDAR'].join('\r\n');
  const day = [entry(1, '09:00', '10:00'), entry(2, '12:00', '13:00', { break_label: '2:00' })];

  const top = (el) => parseFloat(el.style.top);
  const bottom = (el) => parseFloat(el.style.top) + parseFloat(el.style.height);

  it('draws the rule with centred text, in a free stretch away from a placeholder', async () => {
    const f = await open({ entries: day, feed: feed([['Design sync', 10, 15, 10, 45, 'ds']]) });
    const brk = f.q('.omnitime-tl__break');
    assert.equal(brk.querySelector('.omnitime-tl__breaktext').textContent, 'Break 2:00');
    const cal = f.q('.omnitime-tl__cal-event');
    const band = [top(brk) - 9, top(brk) + 9];
    assert.ok(band[1] <= top(cal) || band[0] >= bottom(cal), `band ${band} overlaps the placeholder ${top(cal)}-${bottom(cal)}`);
    // ...and never over an entry.
    f.root.querySelectorAll('.omnitime-tl__entry').forEach((e) => assert.ok(band[1] <= top(e) || band[0] >= bottom(e)));
  });

  it('merges the text into the gap row when the free stretches are too small for the band', async () => {
    const f = await open({ entries: day, feed: feed([['Design sync', 10, 15, 11, 45, 'ds']]) });
    assert.equal(f.root.querySelectorAll('.omnitime-tl__break').length, 0);
    const row = f.q('.omnitime-tl__gap--break');
    assert.match(row.textContent, /^Break 2:00 · 0:15 untracked/);
    assert.ok(row.querySelector('.omnitime-tl__gapfill'));
  });

  it('omits the label when a placeholder fills the pause', async () => {
    const f = await open({ entries: day, feed: feed([['All day block', 10, 0, 12, 0, 'blk']]) });
    assert.equal(f.root.querySelectorAll('.omnitime-tl__break, .omnitime-tl__gap--break').length, 0);
  });
});
