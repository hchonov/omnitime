// Faster, safer editing in My day (core.js createDayOps + timeline/form):
// optimistic updates with rollback, Undo for delete/move/resize/edit,
// per-entry request order, duplicate (Alt/Ctrl-drag, Ctrl/Cmd+D) and the
// keyboard shortcuts with their help popover.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, settle, ymd, icsStamp } = require('./helpers');

const ENTRY = {
  id: 7, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30',
  project: 'Internal', milestone: 'Ops', issue_label: 'Internal / Standup', issue_external_id: '12',
  issue_internal_id: 1200, comment: 'Daily sync', status: 'unbooked', editable: true,
};
const today = () => ymd(new Date());
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const minutes = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// Monday..Sunday of the current week.
function weekDates() {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return [...Array(7)].map((_, i) => ymd(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
}

// Requests are built in the jsdom realm: compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

// A small stateful server: create/update/remove change what myDay returns.
// `hold` keeps mutating requests pending until release(); `fail` makes the
// next request of a kind reject.
function fakeServer(initial) {
  const days = { [today()]: initial.map((e) => ({ ...e })) };
  const calls = [];
  const held = [];
  const fail = {};
  let nextId = 50;
  const server = { calls, hold: false, fail, days };
  const respond = (name, fn) => {
    const run = () => {
      if (fail[name]) { const err = fail[name]; delete fail[name]; throw err; }
      return fn();
    };
    if (!server.hold) return Promise.resolve().then(run);
    return new Promise((resolve, reject) => held.push(() => { try { resolve(run()); } catch (e) { reject(e); } }));
  };
  const findDay = (id) => Object.keys(days).find((d) => days[d].some((e) => e.id === id));
  server.release = async () => { while (held.length) { held.shift()(); await settle(5); } };
  server.pending = () => held.length;
  server.api = {
    issueTime: () => Promise.resolve({ tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    frequent: () => Promise.resolve({ issues: [] }),
    search: () => Promise.resolve({ issues: [] }),
    myDay: (date) => {
      calls.push(['myDay', date]);
      const total = (d) => (days[d] || []).reduce((s, e) => s + e.duration_minutes, 0);
      const week = weekDates().map((d) => ({ label: 'X', date: d, total_minutes: total(d), total_label: clock(total(d)).replace(/^0/, ''), active: d === date }));
      const weekTotal = week.reduce((s, c) => s + c.total_minutes, 0);
      return Promise.resolve({
        date,
        week,
        week_total_minutes: weekTotal,
        week_total_label: clock(weekTotal).replace(/^0/, ''),
        day_total_minutes: total(date),
        day_total_label: clock(total(date)).replace(/^0/, ''),
        entries: (days[date] || []).map((e) => ({ ...e })),
      });
    },
    create: (payload) => {
      calls.push(['create', plain(payload)]);
      return respond('create', () => {
        const id = nextId++;
        const entry = {
          ...ENTRY, id, start: payload.start_time, duration_minutes: payload.duration, duration_label: clock(payload.duration).replace(/^0/, ''),
          stop: clock(minutes(payload.start_time) + payload.duration), comment: payload.comment || '', issue_internal_id: payload.issue_internal_id,
        };
        (days[payload.date] = days[payload.date] || []).push(entry);
        return { id };
      });
    },
    update: (id, patch) => {
      calls.push(['update', id, plain(patch)]);
      return respond('update', () => {
        const from = findDay(id);
        const i = days[from].findIndex((e) => e.id === id);
        const e = { ...days[from][i] };
        if (patch.start_time) e.start = patch.start_time;
        if (patch.duration) e.duration_minutes = patch.duration;
        if (patch.comment !== undefined) e.comment = patch.comment;
        e.stop = clock(minutes(e.start) + e.duration_minutes);
        days[from].splice(i, 1);
        (days[patch.date || from] = days[patch.date || from] || []).push(e);
        return {};
      });
    },
    remove: (id) => {
      calls.push(['remove', id]);
      return respond('remove', () => {
        const from = findDay(id);
        days[from] = days[from].filter((e) => e.id !== id);
        return null;
      });
    },
  };
  return server;
}

const ics = (events) => {
  const d = new Date();
  return ['BEGIN:VCALENDAR', ...events.flatMap(([title, sh, sm, eh, em, uid]) => [
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${icsStamp(d, sh, sm)}`, `DTEND:${icsStamp(d, eh, em)}`, 'END:VEVENT',
  ]), 'END:VCALENDAR'].join('\r\n');
};

async function openMyDay({ entries = [ENTRY], local = {}, icalRaw = ics([]), onDayTotal, context = {} } = {}) {
  const store = { icalRaw, ...local };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const server = fakeServer(entries);
  const modal = env.window.OmniTime.openModal({
    apiClient: server.api,
    context,
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: 'myday',
    settings: { dayStart: 8, dayEnd: 17 },
    onDayTotal,
  });
  await settle();
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  return {
    ...env, root, q, server, store, modal,
    calls: (name) => server.calls.filter(([n]) => n === name),
    entry: (id) => q(`.omnitime-tl__entry[data-key="entry:${id}"]`),
    entries: () => [...root.querySelectorAll('.omnitime-tl__entry')],
    times: () => [...root.querySelectorAll('.omnitime-tl__entry .omnitime-tl__time')].map((el) => el.textContent),
    toast: () => q('.omnitime-toast'),
    toastText: () => (q('.omnitime-toast__msg') || {}).textContent,
    toastAction: (label) => [...root.querySelectorAll('.omnitime-toast__action')].find((b) => b.textContent === label),
    press: (el, k, opts) => key(env.window, el, k, opts),
    total: () => q('.omnitime-myday__total strong').textContent,
    todayCell: () => [...root.querySelectorAll('.omnitime-week__day')].find((c) => c.classList.contains('omnitime-week__day--today')).querySelector('.omnitime-week__total').textContent,
    weekSum: () => q('.omnitime-week__sum .omnitime-week__total').textContent,
  };
}

// Pointer events with modifier keys (jsdom has no PointerEvent).
function drag(window, el, dy, mods = {}) {
  const fire = (type, y) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, ...mods }));
  fire('pointerdown', 100);
  fire('pointermove', 100 + dy / 2);
  fire('pointermove', 100 + dy);
  return () => fire('pointerup', 100 + dy);
}

// Open the edit form by clicking the entry.
function edit(t, id = 7) {
  const block = t.entry(id);
  block.dispatchEvent(new t.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 100 }));
  block.dispatchEvent(new t.window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientY: 100 }));
}
function type(t, sel, value) {
  const el = t.q(sel);
  el.value = value;
  el.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  el.dispatchEvent(new t.window.Event('change', { bubbles: true }));
}

describe('delete with Undo', () => {
  it('deletes at once (no confirm step) and offers Undo', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    edit(t);
    const del = t.q('.omnitime-del');
    assert.equal(del.textContent.trim(), 'Delete');
    del.click();
    assert.equal(t.entry(7), null, 'gone before the API answered');
    await settle(0);
    assert.deepEqual(t.calls('remove'), [['remove', 7]]);
    assert.equal(t.toastText(), 'Entry deleted');
    assert.ok(t.toastAction('Undo'));
    assert.ok(!t.root.innerHTML.includes('Confirm delete?'));
    await t.server.release();
  });

  it('re-creates the entry on Undo with the same date/start/duration/comment/issue', async () => {
    const t = await openMyDay();
    edit(t);
    t.q('.omnitime-del').click();
    await settle();
    t.toastAction('Undo').click();
    assert.ok(t.entry(7), 'shown again at once (under its old id until the POST answers)');
    await settle();
    assert.deepEqual(t.calls('create').map(([, p]) => p), [{
      issue_internal_id: 1200, date: today(), start_time: '09:00', duration: 30, comment: 'Daily sync',
    }]);
    assert.equal(t.entry(7), null);
    assert.ok(t.entry(50), 'renamed to the new server id');
    await settle(300);
    assert.deepEqual(t.server.days[today()].map((e) => [e.id, e.start, e.duration_minutes]), [[50, '09:00', 30]]);
  });

  it('moves the calendar link of the deleted entry to the re-created one', async () => {
    const key = `uid:weekly-1@${today()}T13:00`;
    const t = await openMyDay({
      icalRaw: ics([['Weekly sync', 13, 0, 14, 0, 'weekly-1']]),
      local: { omnitimeCalLinks: { [key]: { entryId: 7, date: today() }, other: { entryId: 99, date: today() } } },
    });
    const calTitles = () => [...t.root.querySelectorAll('.omnitime-tl__cal-name')].map((el) => el.textContent);
    assert.deepEqual(calTitles(), [], 'booked from the calendar: hidden');
    edit(t);
    t.q('.omnitime-del').click();
    await settle();
    assert.deepEqual(calTitles(), ['Weekly sync'], 'the booking is gone: the event shows again');
    t.toastAction('Undo').click();
    assert.deepEqual(calTitles(), [], 'hidden again right away');
    await settle(300);
    assert.deepEqual(t.store.omnitimeCalLinks[key], { entryId: 50, date: today() });
    assert.deepEqual(t.store.omnitimeCalLinks.other, { entryId: 99, date: today() });
    assert.deepEqual(calTitles(), []);
  });

  it('only re-creates after the delete went through (requests per entry run in order)', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    edit(t);
    t.q('.omnitime-del').click();
    t.toastAction('Undo').click();
    await settle();
    assert.equal(t.calls('create').length, 0, 'waits for the DELETE');
    assert.equal(t.entry(7).classList.contains('omnitime-tl__entry--pending'), true);
    await t.server.release();
    await settle();
    assert.equal(t.calls('create').length, 1);
    assert.ok(t.entry(50));
    assert.equal(t.entry(50).classList.contains('omnitime-tl__entry--pending'), false);
  });

  it('does not re-create when the delete failed', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    t.server.fail.remove = Object.assign(new Error('Nope'), { status: 500 });
    edit(t);
    t.q('.omnitime-del').click();
    t.toastAction('Undo').click();
    await t.server.release();
    await settle(300);
    assert.equal(t.calls('create').length, 0);
    assert.ok(t.entry(7), 'still there');
  });
});

describe('optimistic updates', () => {
  it('moves at once, then reconciles quietly (no busy state, focus kept)', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    const block = t.entry(7);
    block.focus();
    t.press(block, 'ArrowDown', { altKey: true });
    t.press(block, 'ArrowDown', { altKey: true });
    await settle(750);
    assert.deepEqual(t.calls('update').map(([, id, p]) => [id, p.start_time, p.duration]), [[7, '09:10', 30]]);
    assert.deepEqual(t.times(), ['09:10–09:40'], 'rendered from local state');
    assert.equal(t.q('.omnitime-myday--busy'), null);
    assert.equal(t.root.activeElement, t.entry(7), 'focus stays on the entry');
    const loads = t.calls('myDay').length;
    await t.server.release();
    await settle(300);
    assert.equal(t.calls('myDay').length, loads + 1, 'one background reload');
    assert.equal(t.q('.omnitime-myday--busy'), null);
    assert.equal(t.root.activeElement, t.entry(7));
    assert.deepEqual(t.times(), ['09:10–09:40']);
  });

  it('sends a second change of the same entry only after the first one answered', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    t.entry(7).focus();
    t.press(t.entry(7), 'ArrowDown', { altKey: true });
    await settle(750);
    t.press(t.entry(7), 'ArrowDown', { altKey: true });
    await settle(750);
    assert.deepEqual(t.times(), ['09:10–09:40'], 'both shown');
    assert.equal(t.calls('update').length, 1, 'the second waits');
    assert.ok(t.entry(7).classList.contains('omnitime-tl__entry--pending'));
    assert.equal(t.entry(7).getAttribute('aria-busy'), 'true');
    await t.server.release();
    await settle();
    await t.server.release();
    assert.deepEqual(t.calls('update').map(([, , p]) => p.start_time), ['09:05', '09:10']);
    await settle(300);
    assert.equal(t.entry(7).classList.contains('omnitime-tl__entry--pending'), false);
    assert.deepEqual(t.server.days[today()].map((e) => e.start), ['09:10']);
  });

  it('rolls back and explains a failure, with Retry', async () => {
    const t = await openMyDay();
    t.server.fail.update = Object.assign(new Error('The issue is closed.'), { status: 400 });
    const block = t.entry(7);
    block.focus();
    t.press(block, 'ArrowDown', { altKey: true });
    await settle(750);
    assert.deepEqual(t.times(), ['09:00–09:30'], 'rolled back');
    assert.ok(t.toast().classList.contains('omnitime-toast--error'));
    assert.equal(t.toastText(), "Couldn't move the entry. The issue is closed.");
    t.toastAction('Retry').click();
    assert.deepEqual(t.times(), ['09:05–09:35']);
    await settle(300);
    assert.equal(t.calls('update').length, 2);
    assert.deepEqual(t.server.days[today()].map((e) => e.start), ['09:05']);
  });

  it('keeps the day total, the week strip and the badge in step', async () => {
    const reports = [];
    const other = { ...ENTRY, id: 8, start: '11:00', stop: '12:00', duration_minutes: 60, duration_label: '1:00' };
    const t = await openMyDay({ entries: [ENTRY, other], onDayTotal: (...a) => reports.push(a) });
    assert.equal(t.total(), '1:30');
    t.server.hold = true;
    edit(t, 8);
    t.q('.omnitime-del').click();
    assert.equal(t.total(), '0:30');
    assert.equal(t.todayCell(), '0:30');
    assert.equal(t.weekSum(), '0:30');
    assert.deepEqual(reports.pop(), [today(), 30], 'reported before the API answered');
    // Resize the remaining entry by 5 minutes.
    const block = t.entry(7);
    block.focus();
    t.press(block, 'ArrowDown', { altKey: true, shiftKey: true });
    await settle(750);
    assert.equal(t.total(), '0:35');
    assert.deepEqual(reports.pop(), [today(), 35]);
    await t.server.release();
    await settle(300);
    assert.equal(t.total(), '0:35');
  });

  it('moves the minutes to the other day when an edit changes the date', async () => {
    const week = weekDates();
    const otherDay = week.find((d) => d !== today());
    const t = await openMyDay();
    t.server.hold = true;
    edit(t);
    type(t, '.omnitime-f-date', otherDay);
    t.q('.omnitime-save').click();
    assert.equal(t.entry(7), null, 'left the viewed day');
    assert.equal(t.total(), '0:00');
    const cell = [...t.root.querySelectorAll('.omnitime-week__day')][week.indexOf(otherDay)];
    assert.equal(cell.querySelector('.omnitime-week__total').textContent, '0:30');
    assert.equal(t.weekSum(), '0:30');
    assert.match(t.toastText(), /^Saved on /);
    assert.ok(t.toastAction('Undo'));
    assert.ok(t.toastAction('Go to day'));
    await t.server.release();
  });
});

describe('Undo of move, resize and edit', () => {
  it('PATCHes the previous start back after a move', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    block.focus();
    t.press(block, 'ArrowDown', { altKey: true });
    await settle(750);
    assert.equal(t.toastText(), 'Moved to 09:05');
    t.toastAction('Undo').click();
    assert.deepEqual(t.times(), ['09:00–09:30'], 'shown at once');
    await settle();
    assert.deepEqual(t.calls('update').map(([, id, p]) => [id, p]), [
      [7, { start_time: '09:05', duration: 30 }],
      [7, { start_time: '09:00', duration: 30 }],
    ]);
  });

  it('PATCHes the previous duration back after a resize', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    block.focus();
    t.press(block, 'ArrowDown', { altKey: true, shiftKey: true });
    await settle(750);
    assert.equal(t.toastText(), 'Resized to 09:00–09:35');
    t.toastAction('Undo').click();
    await settle();
    assert.deepEqual(t.calls('update').pop(), ['update', 7, { start_time: '09:00', duration: 30 }]);
  });

  it('PATCHes every previous value (date included) after a form edit', async () => {
    const otherDay = weekDates().find((d) => d !== today());
    const t = await openMyDay();
    edit(t);
    type(t, '.omnitime-f-dur', '1:15');
    type(t, '.omnitime-f-start', '10:00');
    type(t, '.omnitime-f-date', otherDay);
    t.q('.omnitime-f-comment').value = 'Changed';
    t.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(t.calls('update')[0], ['update', 7, { date: otherDay, start_time: '10:00', duration: 75, comment: 'Changed' }]);
    t.toastAction('Undo').click();
    assert.deepEqual(t.times(), ['09:00–09:30'], 'back on the viewed day at once');
    await settle();
    assert.deepEqual(t.calls('update')[1], ['update', 7, { date: today(), start_time: '09:00', duration: 30, comment: 'Daily sync' }]);
    await settle(300);
    assert.deepEqual(t.server.days[today()].map((e) => [e.start, e.duration_minutes, e.comment]), [['09:00', 30, 'Daily sync']]);
  });

  it('says "Saved" with Undo for an edit on the same day and closes the form', async () => {
    const t = await openMyDay();
    edit(t);
    type(t, '.omnitime-f-dur', '0:45');
    t.q('.omnitime-save').click();
    assert.equal(t.toastText(), 'Saved');
    assert.deepEqual(t.times(), ['09:00–09:45']);
    assert.equal(t.q('.omnitime-myday__cols--form-open'), null);
  });

  it('leaves booked entries read-only (no drag, no duplicate)', async () => {
    const booked = { ...ENTRY, id: 8, start: '11:00', stop: '12:00', editable: false, status: 'booked' };
    const t = await openMyDay({ entries: [booked] });
    const block = t.entry(8);
    drag(t.window, block, 60, { altKey: true })();
    block.focus();
    t.press(block, 'd', { ctrlKey: true });
    await settle(300);
    assert.deepEqual([t.calls('create'), t.calls('update')], [[], []]);
  });
});

describe('duplicate', () => {
  for (const mod of ['altKey', 'ctrlKey']) {
    it(`copies on ${mod === 'altKey' ? 'Alt' : 'Ctrl'}-drag, with a ghost while dragging`, async () => {
      const t = await openMyDay();
      const block = t.entry(7);
      const drop = drag(t.window, block, 120, { [mod]: true });
      const ghost = t.q('.omnitime-tl__entry--dupghost');
      assert.ok(ghost, 'copy ghost follows the pointer');
      assert.ok(block.classList.contains('omnitime-tl__entry--copying'));
      assert.match(ghost.textContent, /Copy/);
      assert.equal(block.querySelector('.omnitime-tl__time').textContent, '09:00–09:30', 'the original stays');
      t.server.hold = true;
      drop();
      assert.equal(t.q('.omnitime-tl__entry--dupghost'), null);
      assert.equal(t.entries().length, 2, 'both shown before the API answered');
      await settle(0);
      const [[, payload]] = t.calls('create');
      assert.equal(payload.issue_internal_id, 1200);
      assert.equal(payload.duration, 30);
      assert.equal(payload.comment, 'Daily sync');
      assert.ok(payload.start_time > '09:00', payload.start_time);
      assert.equal(t.calls('update').length, 0, 'the original is not moved');
      assert.match(t.toastText(), /^Copied to /);
      await t.server.release();
      await settle(300);
      assert.equal(t.server.days[today()].length, 2);
    });
  }

  it('moves instead when the modifier is released mid-drag', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    const fire = (type, y, mods = {}) => block.dispatchEvent(new t.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, ...mods }));
    fire('pointerdown', 100, { altKey: true });
    fire('pointermove', 160, { altKey: true });
    fire('pointermove', 220);
    assert.equal(t.q('.omnitime-tl__entry--dupghost'), null);
    fire('pointerup', 220);
    await settle();
    assert.equal(t.calls('create').length, 0);
    assert.equal(t.calls('update').length, 1);
  });

  it('duplicates a focused entry right after itself with Ctrl+D, focus on the copy; Undo deletes it', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    block.focus();
    assert.equal(t.press(block, 'd', { ctrlKey: true }), false, 'Ctrl+D is handled (no browser bookmark)');
    assert.deepEqual(t.times(), ['09:00–09:30', '09:30–10:00']);
    await settle();
    assert.deepEqual(t.calls('create')[0][1], { issue_internal_id: 1200, date: today(), start_time: '09:30', duration: 30, comment: 'Daily sync' });
    assert.equal(t.root.activeElement, t.entry(50), 'focus on the copy (server id)');
    t.toastAction('Undo').click();
    await settle();
    assert.deepEqual(t.calls('remove'), [['remove', 50]]);
    assert.equal(t.entries().length, 1);
  });

  it('accepts Cmd+D too', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    block.focus();
    t.press(block, 'D', { metaKey: true });
    await settle();
    assert.equal(t.calls('create').length, 1);
  });
});

describe('keyboard shortcuts', () => {
  it('N opens the add form at the next free slot with the focus in it', async () => {
    const t = await openMyDay();
    assert.equal(t.press(t.q('.omnitime-modal'), 'n'), false);
    assert.ok(t.q('.omnitime-myday__cols--form-open'));
    assert.equal(t.q('.omnitime-form--edit'), null);
    assert.equal(t.root.activeElement, t.q('.omnitime-f-dur'));
  });

  it('←/→ change the day and T goes back to today', async () => {
    const t = await openMyDay();
    const dialog = t.q('.omnitime-modal');
    const d = new Date();
    const yesterday = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
    t.press(dialog, 'ArrowLeft');
    await settle();
    assert.equal(t.calls('myDay').pop()[1], yesterday);
    t.press(dialog, 'ArrowRight');
    await settle();
    assert.equal(t.calls('myDay').pop()[1], today());
    t.press(dialog, 'ArrowLeft');
    await settle();
    t.press(dialog, 't');
    await settle();
    assert.equal(t.calls('myDay').pop()[1], today());
  });

  it('ignores keys in text fields, with modifiers and on the tab bar', async () => {
    const t = await openMyDay({ context: { source: 'https://git.example.test', project_id: '3', issue_id: '14' } });
    t.q('.omnitime-add-btn').click();
    const loads = t.calls('myDay').length;
    for (const sel of ['.omnitime-f-comment', '.omnitime-f-dur', '.omnitime-search__input']) {
      assert.equal(t.press(t.q(sel), 'ArrowLeft'), true, sel);
      assert.equal(t.press(t.q(sel), 't'), true, sel);
    }
    assert.equal(t.press(t.q('.omnitime-modal'), 'n', { ctrlKey: true }), true);
    await settle();
    assert.equal(t.calls('myDay').length, loads);
  });

  it('never takes keys from the host page, nor when the modal is closed', async () => {
    const t = await openMyDay();
    const input = t.document.createElement('button');
    t.document.body.appendChild(input);
    assert.equal(t.press(input, 'n'), true, 'page element while open');
    assert.equal(t.press(t.document.body, 'ArrowLeft'), true);
    t.modal.cleanup();
    assert.equal(t.press(t.document.body, 'n'), true, 'closed');
    assert.equal(t.press(t.document.body, '?'), true, 'closed');
    await settle();
    assert.equal(t.calls('myDay').length, 1);
  });

  it('? shows a help popover listing all shortcuts; Escape closes it and returns the focus', async () => {
    const t = await openMyDay();
    const block = t.entry(7);
    block.focus();
    t.press(block, '?', { shiftKey: true });
    const pop = t.root.querySelector('.omnitime-root > .omnitime-keys');
    assert.ok(pop, 'in ui.layer');
    assert.equal(pop.getAttribute('role'), 'dialog');
    assert.equal(t.root.activeElement, pop);
    const rows = [...pop.querySelectorAll('.omnitime-keys__row')].map((r) => [...r.querySelectorAll('kbd')].map((k) => k.textContent).join('+') + ' ' + r.querySelector('dd').textContent);
    for (const expected of ['N New entry', '←/→ Previous / next day', 'T Today', '? Show', 'Enter Edit', 'Alt+↑/↓ Move', 'Alt+Shift+↑/↓ Change the end',
      'Ctrl+D Duplicate', 'Alt-drag Copy', 'Delete Hide a calendar event', 'Enter Save', 'Ctrl+Enter Save from the comment']) {
      assert.ok(rows.some((r) => r.startsWith(expected)), `${expected} in ${JSON.stringify(rows)}`);
    }
    t.press(pop, 'Escape');
    assert.equal(t.root.querySelector('.omnitime-keys'), null);
    assert.equal(t.root.activeElement, block);
    assert.ok(t.q('.omnitime-modal'), 'the modal stays open');
  });

  it('opens from the "?" button in the day nav; the button toggles it', async () => {
    const t = await openMyDay();
    const btn = t.q('.omnitime-daynav__keys');
    assert.equal(btn.getAttribute('aria-label'), 'Keyboard shortcuts');
    btn.click();
    assert.ok(t.root.querySelector('.omnitime-keys'));
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    btn.click();
    assert.equal(t.root.querySelector('.omnitime-keys'), null);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    btn.click();
    t.root.querySelector('.omnitime-keys__close').click();
    assert.equal(t.root.querySelector('.omnitime-keys'), null);
  });
});
