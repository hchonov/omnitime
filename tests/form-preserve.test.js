// Background changes must not throw away what the user is doing: an open
// entry form (and its draft) survives drags, failed requests, reconciles and
// a stopped timer; the staged data is drawn once the form closes. Also: the
// "Book meetings" dialog keeps the modal open while it books, a hidden
// calendar placeholder stays hidden after it was dragged, and calendar sync
// errors are shown as text.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, settle, icsStamp } = require('./helpers');

// Fixed clock: Wednesday 21 Oct 2026, 15:00 (TZ is pinned by the helpers).
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

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const minutes = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const plain = (o) => JSON.parse(JSON.stringify(o));
const entry = (id, start, stop, extra = {}) => {
  const dur = minutes(stop) - minutes(start);
  return {
    id, start, stop, duration_minutes: dur, duration_label: `${Math.floor(dur / 60)}:${pad2(dur % 60)}`,
    project: 'Internal', milestone: 'Ops', issue_label: 'Standup', issue_external_id: String(id), issue_internal_id: 1000 + id,
    issue_link: '', comment: `Work ${id}`, status: 'unbooked', editable: true, break_label: null, active: false, ...extra,
  };
};

// A small stateful server for one day. `hold` keeps mutating requests
// pending until release(); `fail.update` makes the next PATCH reject.
function fakeServer(initial) {
  const days = { [TODAY]: initial.map((e) => ({ ...e })) };
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
  server.release = async () => { while (held.length) { held.shift()(); await settle(5); } };
  server.api = {
    issueTime: () => Promise.resolve({ tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    frequent: () => Promise.resolve({ issues: [] }),
    search: () => Promise.resolve({ issues: [] }),
    bookingSuggestions: () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
    myDay: (date) => {
      calls.push(['myDay', date]);
      const list = days[date] || [];
      const total = list.reduce((s, e) => s + e.duration_minutes, 0);
      const week = [19, 20, 21, 22, 23, 24, 25].map((d) => ({ label: 'x', date: `2026-10-${d}`, total_minutes: 0, total_label: '0:00', active: `2026-10-${d}` === date }));
      return Promise.resolve({
        date, week, day_total_minutes: total, day_total_label: `${Math.floor(total / 60)}:${pad2(total % 60)}`,
        entries: list.map((e) => ({ ...e })), target_minutes: 480,
      });
    },
    create: (payload) => {
      calls.push(['create', plain(payload)]);
      return respond('create', () => {
        const id = nextId++;
        const start = payload.start_time || '09:00';
        (days[payload.date] = days[payload.date] || []).push(entry(id, start, clock(minutes(start) + payload.duration), { comment: payload.comment || '' }));
        return { id };
      });
    },
    update: (id, patch) => {
      calls.push(['update', id, plain(patch)]);
      return respond('update', () => {
        const list = days[patch.date || TODAY];
        const e = list.find((x) => x.id === id);
        if (patch.start_time) e.start = patch.start_time;
        if (patch.duration) e.duration_minutes = patch.duration;
        if (patch.comment !== undefined) e.comment = patch.comment;
        e.stop = clock(minutes(e.start) + e.duration_minutes);
        return {};
      });
    },
    remove: (id) => {
      calls.push(['remove', id]);
      return respond('remove', () => { days[TODAY] = days[TODAY].filter((e) => e.id !== id); return null; });
    },
  };
  return server;
}

const ics = (events) => ['BEGIN:VCALENDAR', ...events.flatMap(([title, sh, sm, eh, em, uid]) => {
  const d = new Date(2026, 9, 21);
  return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${icsStamp(d, sh, sm)}`, `DTEND:${icsStamp(d, eh, em)}`, 'END:VEVENT'];
}), 'END:VCALENDAR'].join('\r\n');

async function openMyDay({ entries = [entry(7, '09:00', '09:30'), entry(8, '11:00', '11:30')], local = {}, icalRaw = ics([]), sendMessage, extraFiles = [], store: provided, beforeOpen } = {}) {
  const store = provided || { icalRaw, ...local };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: sendMessage || ((msg, cb) => cb && cb({ success: true, notModified: true })) },
  };
  const env = loadDom(['ical-parser.js', ...extraFiles, 'core.js'], { chrome });
  fixClock(env.window);
  const server = fakeServer(entries);
  if (beforeOpen) beforeOpen(server);
  const modal = env.window.OmniTime.openModal({
    apiClient: server.api,
    context: {},
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: 'myday',
    settings: { dayStart: 8, dayEnd: 17 },
  });
  await settle(40);
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  return {
    ...env, root, q, server, store, modal,
    calls: (name) => server.calls.filter(([n]) => n === name),
    entry: (id) => q(`.omnitime-tl__entry[data-key="entry:${id}"]`),
    times: () => [...root.querySelectorAll('.omnitime-tl__entry .omnitime-tl__time')].map((el) => el.textContent),
    formOpen: () => !!q('.omnitime-myday__cols--form-open'),
    toastText: () => (q('.omnitime-toast__msg') || {}).textContent,
  };
}

// Pointer events (jsdom has no PointerEvent).
function drag(window, el, dy) {
  const fire = (type, y) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y }));
  fire('pointerdown', 100);
  fire('pointermove', 100 + dy / 2);
  fire('pointermove', 100 + dy);
  return () => fire('pointerup', 100 + dy);
}
function editEntry(t, id) {
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
const openAddForm = async (t, draft) => {
  t.q('.omnitime-add-btn').click();
  await settle(5);
  const comment = t.q('.omnitime-f-comment');
  comment.value = draft;
  comment.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  assert.ok(t.formOpen(), 'the form is open');
};
const cancelForm = async (t) => {
  t.q('.omnitime-form__close').click();
  await settle(40);
};

describe('an open create form survives background changes', () => {
  it('a drag of another entry sends the PATCH, keeps the form and the draft, and redraws after Cancel', async () => {
    const t = await openMyDay();
    await openAddForm(t, 'my unsaved draft');
    const block = t.entry(8);
    const comment = t.q('.omnitime-f-comment');
    drag(t.window, block, 60)();
    await settle(40);
    assert.equal(t.calls('update').length, 1, 'the PATCH was sent');
    assert.ok(t.formOpen(), 'the form stays open');
    assert.equal(t.q('.omnitime-f-comment'), comment, 'the form was not rebuilt');
    assert.equal(comment.value, 'my unsaved draft');
    assert.equal(t.entry(8), block, 'the timeline was not rebuilt under the form');
    assert.ok(t.toastText(), 'the toast shows');
    await cancelForm(t);
    assert.equal(t.formOpen(), false);
    assert.notEqual(t.entry(8), block, 'redrawn once the form is closed');
    const moved = t.server.days[TODAY].find((e) => e.id === 8);
    assert.notEqual(moved.start, '11:00');
    assert.equal(t.times()[1], `${moved.start}–${moved.stop}`, 'at its new time');
  });

  it('a failed PATCH reverts quietly: error toast, draft kept, the timeline reverts after the form closes', async () => {
    const t = await openMyDay();
    const original = t.times();
    t.server.hold = true;
    drag(t.window, t.entry(8), 60)();
    await settle(5);
    const moved = t.times();
    assert.notDeepEqual(moved, original, 'optimistic move shown');
    await openAddForm(t, 'draft kept');
    t.server.fail.update = Object.assign(new Error('boom'), { status: 500 });
    await t.server.release();
    await settle(20);
    assert.ok(t.q('.omnitime-toast--error'), 'an error toast says it failed');
    assert.match(t.toastText(), /^Couldn't move the entry/);
    assert.ok(t.formOpen(), 'the form stays open');
    assert.equal(t.q('.omnitime-f-comment').value, 'draft kept');
    assert.deepEqual(t.times(), moved, 'not rebuilt while the form is open');
    await cancelForm(t);
    assert.deepEqual(t.times(), original, 'reverted once the form is closed');
  });

  it('a server-side change found by the reconcile waits for the form to close', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    drag(t.window, t.entry(8), 60)();
    await settle(5);
    await openAddForm(t, 'still here');
    t.server.days[TODAY].push(entry(9, '13:00', '13:30')); // someone else added an entry
    await t.server.release();
    await settle(400); // the quiet reconcile (RECONCILE_DELAY) runs and finds the difference
    assert.ok(t.formOpen());
    assert.equal(t.q('.omnitime-f-comment').value, 'still here');
    assert.equal(t.times().length, 2, 'not drawn yet');
    await cancelForm(t);
    await settle(60);
    assert.equal(t.times().length, 3, 'drawn after the form closed');
  });
});

describe('forms that close themselves still draw at once', () => {
  it('saving an edit closes the form and shows the change before the PATCH answers', async () => {
    const t = await openMyDay();
    t.server.hold = true;
    editEntry(t, 7);
    assert.ok(t.formOpen());
    type(t, '.omnitime-f-dur', '1:00');
    t.q('.omnitime-save').click();
    assert.equal(t.formOpen(), false, 'closed');
    assert.equal(t.times()[0], '09:00–10:00', 'drawn at once');
    assert.equal(t.toastText(), 'Saved');
    await settle(0);
    assert.equal(t.calls('update').length, 1);
    await t.server.release();
  });

  it('deleting from the edit form removes the entry at once and Undo brings it back', async () => {
    const t = await openMyDay();
    editEntry(t, 7);
    t.q('.omnitime-del').click();
    assert.equal(t.formOpen(), false);
    assert.equal(t.entry(7), null, 'gone at once');
    await settle(20);
    assert.equal(t.toastText(), 'Entry deleted');
    [...t.root.querySelectorAll('.omnitime-toast__action')].find((b) => b.textContent === 'Undo').click();
    await settle(60);
    assert.equal(t.calls('create').length, 1);
    assert.equal(t.times().length, 2);
  });
});

describe('a stopped timer keeps an open form', () => {
  it('reloads the day quietly: the draft survives and the new entry is drawn after the form closes', async () => {
    const stored = { startedAt: new Date(FIXED - 45 * 60000).toISOString(), issue: { source: 'https://git.example.test', project_id: '3', issue_id: '14', label: '#14 Fix login' }, comment: '' };
    const t = await openMyDay({ extraFiles: ['timer.js'], local: { omnitimeTimer: stored } });
    const before = t.times().length;
    await openAddForm(t, 'timer draft');
    const stop = t.q('.omnitime-timerpill__stop');
    assert.ok(stop, 'the pill shows the running timer');
    stop.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await settle(80);
    assert.ok(t.calls('create').length >= 1, 'the timer booked an entry');
    assert.ok(t.formOpen(), 'the form stays open');
    assert.equal(t.q('.omnitime-f-comment').value, 'timer draft');
    await cancelForm(t);
    await settle(60);
    assert.ok(t.times().length > before, 'the booked entry is shown');
  });
});

describe('absence arrival while the form is open', () => {
  it('marks the strip and updates the progress without closing the form or rebuilding the timeline', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = await openMyDay({
      beforeOpen: (server) => {
        server.api.week = () => gate.then(() => ({
          date: TODAY, daily_working_hours: 8, week_entries: [], absences: [{ date: TODAY, half_day: false, label: 'Absent' }],
        }));
      },
    });
    const original = t.times();
    await openAddForm(t, 'abs draft');
    assert.equal(t.root.querySelectorAll('.omnitime-week__day--absent').length, 0);
    release();
    await settle(30);
    assert.ok(t.formOpen(), 'the form stays open');
    assert.equal(t.q('.omnitime-f-comment').value, 'abs draft');
    assert.equal(t.root.querySelectorAll('.omnitime-week__day--absent').length, 1, 'the strip shows the absence');
    assert.deepEqual(t.times(), original);
  });
});

describe('calendar placeholders', () => {
  const feed = ics([['Planning', 13, 0, 13, 30, 'plan-1'], ['Retro', 14, 0, 14, 30, 'retro-1']]);
  const bookCount = (t) => Number((t.q('.omnitime-bookall').textContent.match(/\d+/) || [0])[0]);
  const names = (t) => [...t.root.querySelectorAll('.omnitime-tl__cal-name')].map((n) => n.textContent);

  it('a dragged placeholder that is hidden stays hidden and leaves the Book meetings count', async () => {
    const t = await openMyDay({ icalRaw: feed, entries: [] });
    assert.equal(bookCount(t), 2);
    let block = [...t.root.querySelectorAll('.omnitime-tl__cal-event')].find((b) => b.textContent.includes('Planning'));
    drag(t.window, block, 40)();
    await settle(5);
    block = [...t.root.querySelectorAll('.omnitime-tl__cal-event')].find((b) => b.textContent.includes('Planning'));
    key(t.window, block, 'Delete');
    await settle(5);
    assert.ok(!names(t).includes('Planning'), 'hidden');
    assert.equal(bookCount(t), 1, 'no longer offered for booking');
    // A re-render (next day and back) must not bring it back.
    t.q('[data-nav="next"]').click();
    await settle(40);
    t.q('[data-nav="prev"]').click();
    await settle(40);
    assert.ok(!names(t).includes('Planning'), 'still hidden after a re-render');
    assert.ok(names(t).includes('Retro'));
    assert.equal(bookCount(t), 1);
  });
});

describe('Book meetings while a request runs', () => {
  it('backdrop clicks and OmniTime.close() leave the modal open until the booking is done', async () => {
    const feed = ics([['Planning', 13, 0, 13, 30, 'plan-1']]);
    const t = await openMyDay({
      icalRaw: feed,
      entries: [],
      local: { omnitimeCalIssues: { 'uid:plan-1': { id: 70, label: 'Planning issue', title: 'Planning', at: new Date(FIXED).toISOString(), history: [] } } },
    });
    t.server.hold = true;
    t.q('.omnitime-bookall').click();
    await settle(40);
    t.q('.omnitime-bk__ok').dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true }));
    await settle(10);
    assert.equal(t.calls('create').length, 1, 'the create request is running');
    t.q('.omnitime-modal-overlay').dispatchEvent(new t.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(t.window.OmniTime.isOpen(), true, 'backdrop click does not close the modal');
    t.window.OmniTime.close();
    assert.equal(t.window.OmniTime.isOpen(), true, 'a second toolbar click does not either');
    assert.ok(t.q('.omnitime-bk'), 'the dialog is still there');
    await t.server.release();
    await settle(40);
    const done = [...t.root.querySelectorAll('.omnitime-bk__ok')].find((b) => /Done/.test(b.textContent));
    assert.ok(done, 'the summary step is shown');
    done.click();
    assert.equal(t.q('.omnitime-bk'), null, 'Done closes the dialog');
    t.window.OmniTime.close();
    assert.equal(t.window.OmniTime.isOpen(), false, 'and the modal can be closed again');
  });

  it('opening another dialog still replaces a modal that is held open', async () => {
    const t = await openMyDay({ icalRaw: ics([['Planning', 13, 0, 13, 30, 'plan-1']]), entries: [] });
    const ui = t.modal.ui;
    ui.holdOpen(() => true);
    ui.close();
    assert.equal(ui.isOpen(), true);
    t.window.OmniTime.openNotice({ title: 'Replaced', html: 'x' });
    assert.equal(ui.isOpen(), false);
    assert.equal(t.document.querySelectorAll('omnitime-root').length, 1);
  });
});

describe('calendar sync status is plain text', () => {
  it('renders an error message from the service worker without interpreting markup', async () => {
    const evil = '<img src=x onerror="window.__pwned = 1">';
    const t = await openMyDay({ sendMessage: (msg, cb) => cb && cb({ success: false, error: evil }) });
    t.q('.omnitime-cal-refresh').click();
    await settle(10);
    const status = t.q('.omnitime-cal-status');
    assert.equal(status.querySelector('img'), null, 'no element was created from the message');
    assert.equal(status.textContent, 'Sync failed: ' + evil);
    assert.equal(t.root.querySelector('img'), null);
    assert.equal(t.window.__pwned, undefined);
  });

  it('still shows "Synced" with its calendar icon', async () => {
    const t = await openMyDay({ local: { omnitimeCalSyncedAt: new Date(FIXED - 60000).toISOString() } });
    const status = t.q('.omnitime-cal-status');
    assert.ok(status.querySelector('svg'), 'icon');
    assert.match(status.textContent, /Synced/);
  });
});
