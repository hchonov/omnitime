// The My day entry form (core.js buildForm): duration/start parsing and
// validation, quick durations, end time, Enter to save, the date field, the
// issue-search combobox with its recent list, plus the ui.toast service.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, pointer, settle, read } = require('./helpers');

const ENTRY = {
  id: 7, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30',
  project: 'Internal', issue_label: 'Internal / Standup', issue_external_id: '12',
  issue_internal_id: 1200, comment: 'daily', status: 'unbooked', editable: true,
};
const CONTEXT = { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Current issue #14' };
const ISSUES = [
  { issue_internal_id: 55, issue_external_id: '5', label: 'Sync', project: 'P', milestone: 'M1' },
  { issue_internal_id: 56, issue_external_id: '6', label: 'Planning', project: 'P' },
  { issue_internal_id: 57, issue_external_id: '7', label: 'Review', project: 'Q' },
];
const FREQUENT = [
  { issue_internal_id: 1, issue_external_id: '1', label: 'Daily', project: 'P', suggested_minutes: 15, suggested_label: '0:15' },
  { issue_internal_id: 2, issue_external_id: '2', label: 'Retainer', project: 'R', suggested_minutes: 30, suggested_label: '0:30' },
];
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A fake API recording every call; `search` may be replaced to control timing.
function fakeApi({ entries = [ENTRY], search } = {}) {
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
      week: [{ label: 'M', date, total_minutes: 30, total_label: '0:30', active: true }],
      week_total_label: '0:30',
      day_total_label: '0:30',
      entries,
    })),
    frequent: rec('frequent', { issues: FREQUENT }),
    search: search ? (q) => { calls.push(['search', q]); return search(q); } : rec('search', { issues: ISSUES }),
    create: rec('create', { id: 9 }),
    update: rec('update', {}),
    remove: rec('remove', null),
  };
}

async function openForm({ entries, local = {}, search, context = CONTEXT, withChrome = true } = {}) {
  const store = { ...local };
  const chrome = withChrome ? {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  } : undefined;
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const api = fakeApi({ entries, search });
  const modal = env.window.OmniTime.openModal({ apiClient: api, context: { ...context }, activeTab: 'myday', settings: { dayStart: 8, dayEnd: 17 } });
  await settle();
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  const form = {
    ...env, root, api, store, modal, q,
    dur: q('.omnitime-f-dur'), start: q('.omnitime-f-start'), date: q('.omnitime-f-date'),
    comment: q('.omnitime-f-comment'), search: q('.omnitime-search__input'),
    // Type into a field and leave it (input + change, like a real edit + blur).
    type(el, value) {
      el.value = value;
      el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      el.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    },
    // Type without leaving the field (input only).
    typing(el, value) {
      el.value = value;
      el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    },
    press: (el, k, opts) => key(env.window, el, k, opts),
    calls: (name) => api.calls.filter(([n]) => n === name),
    openCreate: () => q('.omnitime-add-btn').click(),
    err: (name) => q(`#omnitime-f-${name}-err`),
  };
  return form;
}

// Open the create form with a known free slot: 11:30, 0:15 on today.
async function openCreate(opts) {
  const f = await openForm(opts);
  f.openCreate();
  f.type(f.start, '11:30');
  f.type(f.dur, '0:15');
  return f;
}

describe('calm form layout', () => {
  const visible = (el) => !el.hidden && !el.closest('[hidden]');

  it('shows the issue as one line and keeps the search out of sight until "Change"', async () => {
    const f = await openCreate();
    assert.equal(f.q('.omnitime-target__label').textContent, 'Current issue #14');
    assert.equal(f.q('.omnitime-target__label .omnitime-entryid').textContent, ' #14', 'the #id is muted');
    assert.equal(visible(f.q('.omnitime-search')), false, 'no search while the target is fine');
    assert.equal(visible(f.q('.omnitime-target__kicker')), false, 'no "Tracking for" kicker');
    assert.equal(f.q('.omnitime-form__hint'), null);
    assert.equal(f.q('.omnitime-freq'), null);
    f.q('.omnitime-target__change').click();
    assert.equal(visible(f.q('.omnitime-search')), true);
    assert.equal(f.root.activeElement, f.search, 'the search has the focus');
    assert.equal(visible(f.q('.omnitime-target__change')), false);
    // Leaving it empty goes back to the one-line target.
    f.search.dispatchEvent(new f.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    assert.equal(visible(f.q('.omnitime-search')), false);
    assert.equal(visible(f.q('.omnitime-target__change')), true);
  });

  it('shows "Project / Issue #id" with the project stripe for a picked issue', async () => {
    const f = await openCreate();
    f.q('.omnitime-target__change').click();
    f.typing(f.search, 'sync');
    await settle(250);
    f.root.querySelectorAll('.omnitime-search__results [role="option"]')[0].click();
    assert.equal(f.q('.omnitime-target__proj').textContent, 'P');
    assert.equal(visible(f.q('.omnitime-target__proj')), true);
    assert.equal(f.q('.omnitime-target__sep').textContent, '/');
    assert.equal(f.q('.omnitime-target__label').textContent, 'Sync #5');
    assert.match(f.q('.omnitime-target__stripe').className, /omnitime-target__stripe--p\d/);
    assert.equal(f.q('.omnitime-target__text').title, 'P / Sync #5');
    assert.equal(visible(f.q('.omnitime-search')), false, 'picked: the search is gone again');
    assert.equal(visible(f.q('.omnitime-target__reset')), true, 'back to the current issue');
  });

  it('locks the issue in edit mode: project line, no Change, Delete and Cancel', async () => {
    const f = await openForm();
    const entry = f.q('.omnitime-tl__entry');
    entry.focus();
    f.press(entry, 'Enter');
    assert.ok(f.q('.omnitime-form--edit'));
    assert.equal(f.q('.omnitime-form__title').textContent, 'Edit entry');
    assert.equal(f.q('.omnitime-target__proj').textContent, 'Internal');
    assert.equal(f.q('.omnitime-target__label').textContent, 'Standup #12');
    assert.equal(f.q('.omnitime-del').textContent.trim(), 'Delete');
    assert.equal(f.q('.omnitime-form__close').textContent, 'Cancel');
    assert.deepEqual([...f.q('.omnitime-form__actions').children].map((c) => c.className.split(' ')[0]),
      ['omnitime-save', 'omnitime-form__close', 'omnitime-form__msg', 'omnitime-del']);
    f.q('.omnitime-form__close').click();
    assert.equal(f.q('.omnitime-myday__cols--form-open'), null);
  });

  it('shows the date as a quiet text button that opens the date input', async () => {
    const f = await openCreate();
    const btn = f.q('.omnitime-f-datebtn');
    assert.equal(btn.textContent, 'Today');
    assert.equal(f.date.hidden, true);
    btn.click();
    assert.equal(f.date.hidden, false);
    assert.equal(btn.hidden, true);
    assert.equal(f.root.activeElement, f.date);
    const d = new Date();
    d.setDate(d.getDate() + 3);
    const other = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    f.type(f.date, other);
    f.date.dispatchEvent(new f.window.FocusEvent('focusout', { bubbles: true }));
    assert.equal(f.date.hidden, true);
    assert.match(btn.textContent, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/, 'e.g. "Mon 19 Oct"');
    // An invalid date keeps the field (and its message) in view.
    f.type(f.date, '');
    f.q('.omnitime-save').click();
    assert.equal(f.date.hidden, false);
    assert.equal(f.date.getAttribute('aria-invalid'), 'true');
  });

  it('shows validation messages only on error', async () => {
    const f = await openCreate();
    assert.equal(visible(f.q('.omnitime-form__errs')), false);
    f.type(f.dur, 'abc');
    assert.equal(visible(f.q('.omnitime-form__errs')), true);
    assert.equal(visible(f.err('dur')), true);
    f.type(f.dur, '0:30');
    assert.equal(visible(f.q('.omnitime-form__errs')), false);
  });

  it('puts time inputs in one row without visible labels, and the comment under it', async () => {
    const f = await openCreate();
    const row = f.q('.omnitime-form__time');
    assert.ok(row.contains(f.start) && row.contains(f.dur) && row.contains(f.q('.omnitime-f-end')) && row.contains(f.q('.omnitime-f-datebtn')));
    assert.equal(f.q('label'), null, 'no label clutter');
    assert.equal(f.start.getAttribute('aria-label'), 'Start time');
    assert.equal(f.dur.getAttribute('aria-label'), 'Duration');
    assert.equal(f.comment.getAttribute('placeholder'), 'Add a comment…');
    assert.equal(f.comment.rows, 1);
  });

  it('grows the comment with its text', async () => {
    const f = await openCreate();
    Object.defineProperty(f.comment, 'scrollHeight', { configurable: true, get: () => 88 });
    f.typing(f.comment, 'one\ntwo\nthree');
    assert.equal(f.comment.style.height, '88px');
  });

  it('offers the calendar suggestions only for calendar bookings', async () => {
    const f = await openCreate();
    assert.equal(visible(f.q('.omnitime-sugg')), false);
  });

  it('keeps a frequent issue\'s usual duration when picked from the empty search', async () => {
    const f = await openCreate();
    f.q('.omnitime-target__change').click();
    await settle();
    const first = f.root.querySelectorAll('.omnitime-search__results [role="option"]')[0];
    assert.match(first.textContent, /Daily/);
    assert.match(first.querySelector('.omnitime-search__dur').textContent, /0:15/);
  });
});

describe('parseDuration', () => {
  const P = loadDom(['core.js']).window.OmniTime.parseDuration;
  const table = [
    ['45', 45], ['0:45', 45], ['1:30', 90], ['1h', 60], ['1h30', 90], ['1h30m', 90], ['1.5h', 90], ['1,5h', 90],
    ['90m', 90], ['45min', 45], [' 45 ', 45], ['1 h 30', 90], ['0:05', 5], ['5', 5], ['4:00', 240], ['240', 240], ['4h', 240], ['1H', 60], ['0.25h', 15],
  ];
  for (const [input, minutes] of table) {
    it(`accepts "${input}" as ${minutes} minutes`, () => {
      const r = P(input);
      assert.equal(r.minutes, minutes);
      assert.equal(r.error, null);
    });
  }
  for (const input of ['', '   ', 'abc', '1.5', '-5', '1:2x', '1:30:00', 'h', '1h75', '0:75', '45x', null, undefined]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const r = P(input);
      assert.equal(r.minutes, null);
      assert.ok(r.error && r.error.length > 5, 'has a message');
    });
  }
  it('explains the limits', () => {
    assert.match(P('0').error, /minimum duration is 0:05/);
    assert.match(P('0:00').error, /minimum duration is 0:05/);
    assert.match(P('4').error, /minimum duration is 0:05/);
    assert.match(P('241').error, /maximum is 4:00 per entry/);
    assert.match(P('5h').error, /maximum is 4:00 per entry/);
  });
});

describe('parseStartTime', () => {
  const P = loadDom(['core.js']).window.OmniTime.parseStartTime;
  const table = [
    ['930', '09:30', 570], ['9:30', '09:30', 570], ['09:30', '09:30', 570], ['0930', '09:30', 570], ['1230', '12:30', 750],
    ['9', '09:00', 540], ['09', '09:00', 540], ['0:00', '00:00', 0], ['23:59', '23:59', 1439], [' 8:05 ', '08:05', 485],
  ];
  for (const [input, text, minutes] of table) {
    it(`accepts "${input}" as ${text}`, () => {
      const r = P(input);
      assert.equal(r.minutes, minutes);
      assert.equal(r.text, text);
      assert.equal(r.error, null);
    });
  }
  for (const input of ['', 'abc', '25:99', '24:00', '9:60', '9:5', '99', '060', '12345', '9.30', null]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const r = P(input);
      assert.equal(r.minutes, null);
      assert.ok(r.error, 'has a message');
    });
  }
});

describe('duration validation', () => {
  it('shows an inline error for an empty duration, keeps the text and blocks save', async () => {
    const f = await openCreate();
    const selBefore = f.q('.omnitime-tl__sel').outerHTML;
    f.type(f.dur, '');
    assert.equal(f.err('dur').hidden, false);
    assert.match(f.err('dur').textContent, /Enter a duration/);
    assert.equal(f.dur.getAttribute('aria-invalid'), 'true');
    assert.match(f.dur.getAttribute('aria-describedby'), /omnitime-f-dur-err/);
    assert.equal(f.dur.value, '');
    assert.equal(f.q('.omnitime-tl__sel').outerHTML, selBefore, 'timeline selection untouched');
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
    assert.equal(f.root.activeElement, f.dur, 'focus moves to the invalid field');
  });

  it('keeps "abc" as typed (no silent 0:05) and the selection unchanged', async () => {
    const f = await openCreate();
    const selBefore = f.q('.omnitime-tl__sel').outerHTML;
    f.type(f.dur, 'abc');
    assert.equal(f.dur.value, 'abc');
    assert.equal(f.dur.getAttribute('aria-invalid'), 'true');
    assert.equal(f.q('.omnitime-tl__sel').outerHTML, selBefore);
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
  });

  it('explains the minimum and maximum', async () => {
    const f = await openCreate();
    f.type(f.dur, '2');
    assert.match(f.err('dur').textContent, /minimum duration is 0:05/);
    f.type(f.dur, '5h');
    assert.match(f.err('dur').textContent, /maximum is 4:00/);
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
  });

  it('clears the error as soon as the text is valid and saves the parsed value', async () => {
    const f = await openCreate();
    f.type(f.dur, 'abc');
    f.typing(f.dur, '1h30'); // still typing: no blur yet
    assert.equal(f.err('dur').hidden, true);
    assert.equal(f.dur.hasAttribute('aria-invalid'), false);
    assert.equal(f.dur.getAttribute('aria-describedby'), 'omnitime-f-end');
    f.q('.omnitime-save').click();
    await settle();
    const [[, payload]] = f.calls('create');
    assert.equal(payload.duration, 90);
    assert.equal(payload.start_time, '11:30');
  });

  it('normalises valid input on blur', async () => {
    const f = await openCreate();
    for (const [typed, shown] of [['45', '0:45'], ['1.5h', '1:30'], ['90m', '1:30'], ['1h', '1:00']]) {
      f.type(f.dur, typed);
      assert.equal(f.dur.value, shown, typed);
      assert.equal(f.err('dur').hidden, true);
    }
  });

  it('is checked by the Save click itself: the mousedown must not blur the field (the error would shift the button)', async () => {
    const f = await openCreate();
    const save = f.q('.omnitime-save');
    assert.equal(save.dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })), false);
    f.dur.focus();
    f.typing(f.dur, 'abc');
    assert.equal(f.err('dur').hidden, true, 'no error while typing');
    save.click();
    await settle();
    assert.equal(f.err('dur').hidden, false);
    assert.deepEqual(f.calls('create'), []);
  });

  it('commits the focused field when Save is clicked (normalised and sent)', async () => {
    const f = await openCreate();
    f.dur.focus();
    f.typing(f.dur, '1h30');
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.calls('create')[0][1].duration, 90);
  });

  it('applies to edits too', async () => {
    const f = await openForm();
    const block = f.q('.omnitime-tl__entry--editable');
    pointer(f.window, block, 'pointerdown', 100);
    pointer(f.window, block, 'pointerup', 100);
    f.type(f.dur, 'nope');
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('update'), []);
    assert.equal(f.dur.getAttribute('aria-invalid'), 'true');
  });
});

describe('start time validation', () => {
  it('flags "25:99", keeps it as typed and blocks save', async () => {
    const f = await openCreate();
    f.type(f.start, '25:99');
    assert.equal(f.start.value, '25:99');
    assert.equal(f.start.getAttribute('aria-invalid'), 'true');
    assert.match(f.start.getAttribute('aria-describedby'), /omnitime-f-start-err/);
    assert.ok(f.err('start').textContent);
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
    assert.equal(f.root.activeElement, f.start);
  });

  it('does not move the timeline selection for an invalid start', async () => {
    const f = await openCreate();
    const selBefore = f.q('.omnitime-tl__sel').outerHTML;
    f.type(f.start, '99:99');
    assert.equal(f.q('.omnitime-tl__sel').outerHTML, selBefore);
  });

  it('requires a start time', async () => {
    const f = await openCreate();
    f.type(f.start, '');
    assert.match(f.err('start').textContent, /Enter a start time/);
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
  });

  it('normalises "930" to 09:30 on blur, moves the selection and sends the normalised time', async () => {
    const f = await openCreate();
    f.type(f.start, '930');
    assert.equal(f.start.value, '09:30');
    assert.equal(f.err('start').hidden, true);
    assert.match(f.q('.omnitime-tl__seltext').textContent, /09:30/);
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.calls('create')[0][1].start_time, '09:30');
  });
});

describe('quick durations and end time', () => {
  const pressed = (f) => [...f.root.querySelectorAll('.omnitime-qdur__chip')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

  it('offers 5m / 10m / 15m / 30m / 1h like the sidebar quick row and highlights the active one', async () => {
    const f = await openCreate();
    const chips = () => [...f.root.querySelectorAll('.omnitime-qdur__chip')];
    assert.deepEqual(chips().map((b) => b.textContent), ['5m', '10m', '15m', '30m', '1h']);
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    assert.deepEqual(chips().map((b) => [b.textContent, b.dataset.min, b.getAttribute('aria-label')]),
      JSON.parse(JSON.stringify(window.OmniTimeSidebar.BUTTONS)).map((b) => [b.label, String(b.minutes), b.name]), 'same set as the widget');
    assert.deepEqual(pressed(f), ['15m']);
    chips()[3].click();
    assert.equal(f.dur.value, '0:30');
    assert.deepEqual(pressed(f), ['30m']);
    assert.match(f.q('.omnitime-tl__seltext').textContent, /11:30.12:00/, 'timeline follows the chip');
    f.typing(f.dur, '1h');
    assert.deepEqual(pressed(f), ['1h'], 'live while typing');
    f.typing(f.dur, '47');
    assert.deepEqual(pressed(f), [], 'a different duration un-highlights');
    f.typing(f.dur, '5');
    assert.deepEqual(pressed(f), ['5m']);
  });

  it('uses the shared segmented control (the sidebar widget\'s quick row)', async () => {
    const f = await openCreate();
    const group = f.q('.omnitime-qdur');
    assert.ok(group.classList.contains('omnitime-seg'));
    assert.equal(group.getAttribute('role'), 'group');
    assert.ok([...group.children].every((b) => b.classList.contains('omnitime-seg__btn')));
    const w = loadDom(['core.js', 'sidebar-widget.js']);
    assert.match(w.window.OmniTimeSidebar.CSS, /omnitime-seg/, 'the widget points at the shared control');
    assert.match(read('style.css'), /\.omnitime-seg__btn\[aria-pressed="true"\]/);
  });

  it('clears a duration error when a chip is clicked', async () => {
    const f = await openCreate();
    f.type(f.dur, 'abc');
    f.root.querySelectorAll('.omnitime-qdur__chip')[4].click();
    assert.equal(f.dur.value, '1:00');
    assert.equal(f.dur.hasAttribute('aria-invalid'), false);
  });

  it('keeps the frequent issues working from the empty search (issue + suggested duration)', async () => {
    const f = await openCreate();
    assert.equal(f.q('.omnitime-freq'), null, 'no always-visible frequent list');
    f.search.focus();
    await settle();
    const frequent = [...f.root.querySelectorAll('.omnitime-search__results [role="option"]')];
    assert.match(frequent[1].textContent, /0:30/, 'shows the usual duration');
    frequent[1].click();
    assert.equal(f.q('.omnitime-target__label').textContent, 'Retainer #2');
    assert.equal(f.dur.value, '0:30');
    assert.deepEqual(pressed(f), ['30m']);
    f.q('.omnitime-save').click();
    await settle();
    const [[, payload]] = f.calls('create');
    assert.equal(payload.issue_internal_id, 2);
    assert.equal(payload.duration, 30);
  });

  it('shows the computed end live', async () => {
    const f = await openCreate();
    const end = () => f.q('.omnitime-f-end').textContent.replace(/^Ends at\s*/, '');
    assert.equal(end(), '→ 11:45');
    f.typing(f.dur, '1h30');
    assert.equal(end(), '→ 13:00');
    f.typing(f.start, '9:10');
    assert.equal(end(), '→ 10:40');
    f.typing(f.dur, 'abc');
    assert.equal(end(), '', 'no end for an invalid duration');
    f.typing(f.dur, '30');
    f.typing(f.start, '25:00');
    assert.equal(end(), '', 'no end for an invalid start');
  });

  it('is read out with the duration field', async () => {
    const f = await openCreate();
    assert.equal(f.dur.getAttribute('aria-describedby'), 'omnitime-f-end');
    assert.match(f.q('#omnitime-f-end').textContent, /Ends at/);
  });
});

describe('Enter to save', () => {
  it('saves from the start, duration and date fields', async () => {
    for (const field of ['start', 'dur', 'date']) {
      const f = await openCreate();
      assert.equal(f.press(f[field], 'Enter'), false, 'default prevented');
      await settle();
      assert.equal(f.calls('create').length, 1, field);
    }
  });

  it('commits what was typed before saving', async () => {
    const f = await openCreate();
    f.typing(f.dur, '1h'); // no blur/change yet, as when Enter is pressed right away
    f.press(f.dur, 'Enter');
    await settle();
    assert.equal(f.calls('create')[0][1].duration, 60);
  });

  it('does not save invalid input', async () => {
    const f = await openCreate();
    f.typing(f.dur, 'abc');
    f.press(f.dur, 'Enter');
    await settle();
    assert.deepEqual(f.calls('create'), []);
    assert.equal(f.dur.getAttribute('aria-invalid'), 'true');
  });

  it('keeps Enter a newline in the comment; Ctrl/Cmd+Enter saves', async () => {
    const f = await openCreate();
    assert.equal(f.press(f.comment, 'Enter'), true, 'not prevented');
    await settle();
    assert.deepEqual(f.calls('create'), []);
    f.comment.value = 'notes';
    f.press(f.comment, 'Enter', { ctrlKey: true });
    await settle();
    assert.equal(f.calls('create').length, 1);
    assert.equal(f.calls('create')[0][1].comment, 'notes');

    const g = await openCreate();
    g.press(g.comment, 'Enter', { metaKey: true });
    await settle();
    assert.equal(g.calls('create').length, 1);
  });

  it('leaves Enter on buttons alone', async () => {
    const f = await openCreate();
    assert.equal(f.press(f.root.querySelector('.omnitime-qdur__chip'), 'Enter'), true);
    await settle();
    assert.deepEqual(f.calls('create'), []);
  });

  it('saves an edit from the keyboard', async () => {
    const f = await openForm();
    const block = f.q('.omnitime-tl__entry--editable');
    pointer(f.window, block, 'pointerdown', 100);
    pointer(f.window, block, 'pointerup', 100);
    f.typing(f.dur, '1:15');
    f.press(f.dur, 'Enter');
    await settle();
    const [[, id, payload]] = f.calls('update');
    assert.equal(id, 7);
    assert.equal(payload.duration, 75);
    assert.equal(payload.start_time, '09:00');
  });
});

describe('date field', () => {
  it('defaults to the viewed day and is sent with a new entry', async () => {
    const f = await openCreate();
    assert.equal(f.date.value, today());
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.calls('create')[0][1].date, today());
    assert.equal(f.root.querySelector('.omnitime-toast'), null, 'no toast for the viewed day');
  });

  it('books on another day, stays on the viewed day and offers "Go to day"', async () => {
    const f = await openCreate();
    f.type(f.date, '2026-10-19');
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.calls('create')[0][1].date, '2026-10-19');
    const toast = f.q('.omnitime-toast');
    assert.ok(toast, 'toast shown');
    assert.equal(toast.querySelector('.omnitime-toast__msg').textContent, 'Saved on Mon 19 Oct');
    const days = f.calls('myDay').map(([, d]) => d);
    assert.equal(days[days.length - 1], today(), 'the viewed day was reloaded, not the other one');
    assert.equal(f.q('.omnitime-daynav__label').textContent.length > 0, true);

    toast.querySelector('.omnitime-toast__action').click();
    await settle();
    assert.equal(f.calls('myDay').pop()[1], '2026-10-19');
    assert.equal(f.q('.omnitime-toast'), null, 'toast dismissed by its action');
  });

  it('is sent with an edit (PATCH) and shows the toast', async () => {
    const f = await openForm();
    const block = f.q('.omnitime-tl__entry--editable');
    pointer(f.window, block, 'pointerdown', 100);
    pointer(f.window, block, 'pointerup', 100);
    assert.equal(f.date.value, today());
    f.type(f.date, '2026-10-19');
    f.q('.omnitime-save').click();
    await settle();
    const [[, id, payload]] = f.calls('update');
    assert.equal(id, 7);
    assert.equal(payload.date, '2026-10-19');
    assert.equal(f.q('.omnitime-toast__msg').textContent, 'Saved on Mon 19 Oct');
  });

  it('rejects an empty date', async () => {
    const f = await openCreate();
    f.type(f.date, '');
    assert.match(f.err('date').textContent, /valid date/);
    f.q('.omnitime-save').click();
    await settle();
    assert.deepEqual(f.calls('create'), []);
  });

  it('does not clamp start/duration against the viewed day when another day is picked', async () => {
    const f = await openCreate(); // 09:00-09:30 is taken today
    f.type(f.date, '2026-10-19');
    f.type(f.start, '09:00');
    f.type(f.dur, '1:00');
    assert.equal(f.start.value, '09:00');
    assert.equal(f.dur.value, '1:00');
  });
});

describe('ui.toast', () => {
  const openUi = async () => {
    const f = await openForm();
    return { ...f, ui: f.modal.ui, region: () => f.q('.omnitime-toast-region') };
  };

  it('lives in a polite live region at the bottom of the dialog', async () => {
    const { ui, region, root } = await openUi();
    ui.toast('Hello');
    assert.equal(region().getAttribute('aria-live'), 'polite');
    assert.ok(ui.dialog.contains(region()));
    assert.equal(region().textContent, 'Hello');
    assert.ok(root.querySelector('.omnitime-toast'));
  });

  it('shows one toast at a time: a new one replaces the old', async () => {
    const { ui, region } = await openUi();
    const first = ui.toast('One');
    const second = ui.toast('Two');
    assert.equal(region().querySelectorAll('.omnitime-toast').length, 1);
    assert.equal(region().textContent, 'Two');
    first(); // stale dismiss must not remove the newer toast
    assert.equal(region().textContent, 'Two');
    second();
    assert.equal(region().querySelectorAll('.omnitime-toast').length, 0);
    second(); // idempotent
  });

  it('runs the action after dismissing, and the button is a keyboard-reachable Tab stop', async () => {
    const { ui, region, window } = await openUi();
    let calls = 0;
    let visibleDuringAction = null;
    ui.toast('Deleted', { actionLabel: 'Undo', onAction: () => { calls++; visibleDuringAction = !!region().querySelector('.omnitime-toast'); } });
    const btn = region().querySelector('button');
    assert.equal(btn.textContent, 'Undo');
    assert.equal(btn.tabIndex, 0);
    assert.equal(btn.type, 'button');
    // Tab from the last control wraps through the toast action (it is inside the dialog's trap).
    const focusables = [...ui.dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea')];
    assert.equal(focusables[focusables.length - 1], btn);
    btn.focus();
    btn.click();
    assert.equal(calls, 1);
    assert.equal(visibleDuringAction, false, 'dismissed before onAction runs');
    assert.equal(region().querySelectorAll('.omnitime-toast').length, 0);
    assert.notEqual(ui.root.activeElement, btn);
    assert.ok(window);
  });

  it('lets onAction show a follow-up toast', async () => {
    const { ui, region } = await openUi();
    ui.toast('Deleted', { actionLabel: 'Undo', onAction: () => ui.toast('Restored') });
    region().querySelector('button').click();
    assert.equal(region().textContent, 'Restored');
  });

  it('closes itself after the timeout (default 5000ms), 0 keeps it', async () => {
    const { ui, region } = await openUi();
    ui.toast('Short', { timeout: 30 });
    assert.equal(region().textContent, 'Short');
    await settle(80);
    assert.equal(region().textContent, '');
    ui.toast('Sticky', { timeout: 0 });
    await settle(80);
    assert.equal(region().textContent, 'Sticky');
  });

  it('holds while hovered or focused and restarts when left', async () => {
    const { ui, region, window } = await openUi();
    ui.toast('Held', { timeout: 40 });
    const el = region().querySelector('.omnitime-toast');
    el.dispatchEvent(new window.Event('pointerenter'));
    await settle(100);
    assert.equal(region().textContent, 'Held');
    el.dispatchEvent(new window.Event('pointerleave'));
    await settle(100);
    assert.equal(region().textContent, '');
  });

  it('is gone when the dialog closes and never fires its timer afterwards', async () => {
    const { ui, document } = await openUi();
    ui.toast('Bye', { timeout: 20 });
    ui.close();
    await settle(50);
    assert.equal(document.querySelector('omnitime-root'), null);
  });

  it('is available in notice dialogs too', async () => {
    const { window, document } = loadDom(['core.js']);
    const shell = window.OmniTime.openNotice({ title: 'T', html: 'x' });
    assert.equal(typeof shell.toast, 'function');
    shell.toast('Hi');
    assert.equal(uiRoot(document).querySelector('.omnitime-toast').textContent, 'Hi');
  });
});

describe('issue search combobox', () => {
  const opts = (f) => [...f.root.querySelectorAll('.omnitime-search__results [role="option"]')];
  const search = async (f, text, wait = 200) => { f.search.focus(); f.typing(f.search, text); await settle(wait); };

  it('has the combobox roles and states', async () => {
    const f = await openCreate();
    const list = f.q('.omnitime-search__results');
    assert.equal(f.search.getAttribute('role'), 'combobox');
    assert.equal(f.search.getAttribute('aria-autocomplete'), 'list');
    assert.equal(f.search.getAttribute('aria-expanded'), 'false');
    assert.equal(f.search.getAttribute('aria-controls'), list.id);
    assert.equal(list.getAttribute('role'), 'listbox');
    await search(f, 'sync');
    assert.equal(f.search.getAttribute('aria-expanded'), 'true');
    assert.equal(opts(f).length, 3);
    assert.ok(opts(f).every((o) => o.getAttribute('aria-selected') === 'false' && o.id));
    assert.equal(f.search.hasAttribute('aria-activedescendant'), false);
  });

  it('moves the highlight with ArrowDown/ArrowUp (wrapping) via aria-activedescendant', async () => {
    const f = await openCreate();
    await search(f, 'sync');
    const active = () => opts(f).findIndex((o) => o.getAttribute('aria-selected') === 'true');
    assert.equal(f.press(f.search, 'ArrowDown'), false);
    assert.equal(active(), 0);
    assert.equal(f.search.getAttribute('aria-activedescendant'), opts(f)[0].id);
    f.press(f.search, 'ArrowDown');
    f.press(f.search, 'ArrowDown');
    assert.equal(active(), 2);
    f.press(f.search, 'ArrowDown');
    assert.equal(active(), 0, 'wraps to the first');
    f.press(f.search, 'ArrowUp');
    assert.equal(active(), 2, 'wraps to the last');
    assert.equal(f.search.getAttribute('aria-activedescendant'), opts(f)[2].id);
    assert.ok(opts(f)[2].classList.contains('omnitime-search__item--active'));
    assert.equal(f.root.activeElement, f.search, 'focus stays in the input');
  });

  it('Enter picks the highlighted result instead of saving', async () => {
    const f = await openCreate();
    await search(f, 'sync');
    f.press(f.search, 'ArrowDown');
    f.press(f.search, 'ArrowDown');
    assert.equal(f.press(f.search, 'Enter'), false);
    assert.equal(f.q('.omnitime-target__label').textContent, 'Planning #6');
    assert.equal(f.q('.omnitime-search__results').hidden, true);
    assert.equal(f.search.value, '');
    assert.equal(f.search.getAttribute('aria-expanded'), 'false');
    await settle();
    assert.deepEqual(f.calls('create'), [], 'not saved by that Enter');
    f.press(f.dur, 'Enter');
    await settle();
    assert.equal(f.calls('create')[0][1].issue_internal_id, 56);
  });

  it('Enter without a highlighted result does nothing (no save)', async () => {
    const f = await openCreate();
    await search(f, 'sync');
    f.press(f.search, 'Enter');
    await settle();
    assert.deepEqual(f.calls('create'), []);
    assert.equal(f.q('.omnitime-search__results').hidden, false);
  });

  it('still picks with the mouse', async () => {
    const f = await openCreate();
    await search(f, 'sync');
    opts(f)[1].click();
    assert.equal(f.q('.omnitime-target__label').textContent, 'Planning #6');
  });

  it('debounces by 150ms and sends one request for a burst of typing', async () => {
    const f = await openCreate();
    f.typing(f.search, 'sy');
    await settle(80);
    f.typing(f.search, 'syn');
    await settle(80);
    assert.deepEqual(f.calls('search'), [], 'nothing before 150ms of quiet');
    await settle(120);
    assert.deepEqual(f.calls('search'), [['search', 'syn']]);
  });

  it('ignores out-of-order responses', async () => {
    const pending = {};
    const f = await openCreate({
      search: (q) => new Promise((resolve) => { pending[q] = resolve; }),
    });
    f.typing(f.search, 'aa');
    await settle(200);
    f.typing(f.search, 'aab');
    await settle(200);
    assert.deepEqual(Object.keys(pending), ['aa', 'aab']);
    pending.aab({ issues: [ISSUES[1]] });
    await settle();
    pending.aa({ issues: [ISSUES[0], ISSUES[2]] }); // arrives late
    await settle();
    assert.deepEqual(opts(f).map((o) => o.dataset.label), ['Planning #6']);
  });

  it('drops a response that arrives after Escape closed the list or the query was cleared', async () => {
    const pending = {};
    const f = await openCreate({ search: (q) => new Promise((resolve) => { pending[q] = resolve; }) });
    f.search.focus();
    f.typing(f.search, 'aa');
    await settle(200);
    f.press(f.search, 'Escape'); // the dialog's Escape stack runs on the document
    f.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    pending.aa({ issues: ISSUES });
    await settle();
    assert.equal(f.q('.omnitime-search__results').hidden, true);

    f.typing(f.search, 'bb');
    await settle(200);
    f.typing(f.search, 'b'); // too short: closes and invalidates
    pending.bb({ issues: ISSUES });
    await settle();
    assert.equal(f.q('.omnitime-search__results').hidden, true);
  });

  it('shows "No matches" and "Search unavailable" without options', async () => {
    const f = await openCreate({ search: () => Promise.resolve({ issues: [] }) });
    await search(f, 'zz');
    assert.match(f.q('.omnitime-search__results').textContent, /No matches/);
    assert.equal(opts(f).filter((o) => o.dataset.idx !== undefined).length, 0);
    assert.equal(f.press(f.search, 'ArrowDown'), true, 'nothing to navigate');
    const g = await openCreate({ search: () => Promise.reject(new Error('x')) });
    await search(g, 'zz');
    assert.match(g.q('.omnitime-search__results').textContent, /Search unavailable/);
  });

  it('closes when focus leaves the search box', async () => {
    const f = await openCreate();
    await search(f, 'sync');
    f.dur.focus();
    f.q('.omnitime-search').dispatchEvent(new f.window.FocusEvent('focusout', { bubbles: true, relatedTarget: f.dur }));
    assert.equal(f.q('.omnitime-search__results').hidden, true);
  });
});

describe('recent issues', () => {
  const RECENT = [
    { issue_id: 56, label: 'Planning #6' },
    { source: 'https://git.example.test', project_id: '3', issue_id: '14', label: 'Current issue #14' },
    { issue_id: 1, label: 'Daily #1' },
  ];
  const groupTitles = (f) => [...f.root.querySelectorAll('.omnitime-search__group')].map((g) => g.textContent);
  const labels = (f) => [...f.root.querySelectorAll('.omnitime-search__results [role="option"]')].map((o) => o.dataset.label);

  it('lists recent issues, then the frequent ones, when the empty search box is focused', async () => {
    const f = await openCreate({ local: { omnitimeRecentIssues: RECENT } });
    f.search.focus();
    await settle();
    assert.equal(f.q('.omnitime-search__results').hidden, false);
    assert.deepEqual(groupTitles(f), ['Recent', 'Frequent']);
    // "Daily #1" is recent already, so frequent only adds the other one.
    assert.deepEqual(labels(f), ['Planning #6', 'Current issue #14', 'Daily #1', 'Retainer #2']);
    assert.equal(f.search.getAttribute('aria-expanded'), 'true');
  });

  it('shows only the frequent group without any recent issues, nothing without both', async () => {
    const f = await openCreate();
    f.search.focus();
    await settle();
    assert.deepEqual(groupTitles(f), ['Frequent']);
    const g = await openCreate({ withChrome: false });
    g.search.focus();
    await settle();
    assert.deepEqual(groupTitles(g), ['Frequent'], 'works without chrome.storage');
  });

  it('comes back when the query is cleared, and goes when typing', async () => {
    const f = await openCreate({ local: { omnitimeRecentIssues: RECENT } });
    f.search.focus();
    f.typing(f.search, 'sync');
    await settle(200);
    assert.deepEqual(groupTitles(f), [], 'search results replace it');
    f.typing(f.search, '');
    await settle();
    assert.deepEqual(groupTitles(f), ['Recent', 'Frequent']);
  });

  it('opens with ArrowDown after Escape and picks with the keyboard', async () => {
    const f = await openCreate({ local: { omnitimeRecentIssues: RECENT } });
    f.search.focus();
    await settle();
    f.press(f.search, 'Escape');
    f.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(f.q('.omnitime-search__results').hidden, true);
    f.press(f.search, 'ArrowDown');
    await settle();
    assert.equal(f.q('.omnitime-search__results').hidden, false);
    f.press(f.search, 'ArrowDown');
    f.press(f.search, 'Enter');
    assert.equal(f.q('.omnitime-target__label').textContent, 'Planning #6');
    f.press(f.dur, 'Enter');
    await settle();
    assert.equal(f.calls('create')[0][1].issue_internal_id, 56);
  });

  it('books a recent issue picked by its external id via source/project/issue', async () => {
    const f = await openCreate({ local: { omnitimeRecentIssues: RECENT }, context: {} });
    f.search.focus();
    await settle();
    f.root.querySelectorAll('.omnitime-search__results [role="option"]')[1].click();
    assert.equal(f.q('.omnitime-target__label').textContent, 'Current issue #14');
    f.q('.omnitime-save').click();
    await settle();
    const [[, payload]] = f.calls('create');
    assert.equal(payload.source, 'https://git.example.test');
    assert.equal(payload.project_id, '3');
    assert.equal(payload.issue_id, '14');
    assert.equal('issue_internal_id' in payload, false);
  });

  it('remembers booked issues: newest first, deduplicated, at most 8', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ issue_id: 100 + i, label: `Old ${i} #${i}` }));
    const f = await openCreate({ local: { omnitimeRecentIssues: many } });
    // Book "Planning" via search, then the current issue.
    await (async () => { f.search.focus(); f.typing(f.search, 'plan'); await settle(200); })();
    f.root.querySelectorAll('.omnitime-search__results [role="option"]')[1].click();
    f.q('.omnitime-save').click();
    await settle();
    let list = f.store.omnitimeRecentIssues;
    assert.equal(list.length, 8);
    assert.deepEqual(list[0], { issue_id: 56, label: 'Planning #6' });
    assert.deepEqual(list.slice(1).map((r) => r.issue_id), [100, 101, 102, 103, 104, 105, 106], 'oldest dropped');

    const g = await openCreate({ local: { omnitimeRecentIssues: list } });
    g.q('.omnitime-save').click(); // the current issue
    await settle();
    list = g.store.omnitimeRecentIssues;
    assert.deepEqual(list[0], { source: CONTEXT.source, project_id: '3', issue_id: '14', label: 'Current issue #14' });
    assert.equal(list.length, 8);

    // Booking Planning again moves it to the front without a duplicate.
    const h = await openCreate({ local: { omnitimeRecentIssues: list } });
    h.search.focus();
    h.typing(h.search, 'plan');
    await settle(200);
    h.root.querySelectorAll('.omnitime-search__results [role="option"]')[1].click();
    h.q('.omnitime-save').click();
    await settle();
    list = h.store.omnitimeRecentIssues;
    assert.equal(list.filter((r) => r.issue_id === 56).length, 1);
    assert.equal(list[0].issue_id, 56);
    assert.equal(list.length, 8);
  });

  it('does not record anything when the save fails validation', async () => {
    const f = await openCreate();
    f.type(f.dur, 'abc');
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.store.omnitimeRecentIssues, undefined);
  });

  it('does not break without chrome.storage', async () => {
    const f = await openCreate({ withChrome: false });
    f.q('.omnitime-save').click();
    await settle();
    assert.equal(f.calls('create').length, 1);
  });
});

describe('remembered meetings carry their title', () => {
  it('stores the event title next to the picked issue', async () => {
    const d = new Date();
    const stamp = (h, m) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w-1', 'SUMMARY:Weekly sync', `DTSTART:${stamp(13, 0)}`, `DTEND:${stamp(14, 0)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const store = { icalRaw: ics };
    const chrome = {
      storage: {
        local: {
          get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
          set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
        },
        onChanged: makeEvent(),
      },
      runtime: { sendMessage: (msg, cb) => cb && cb({ success: true }) },
    };
    const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
    const api = fakeApi();
    env.window.OmniTime.openModal({ apiClient: api, context: {}, icalUrl: 'https://calendar.example.test/x.ics', activeTab: 'myday', settings: { dayStart: 8, dayEnd: 17 } });
    await settle();
    const root = uiRoot(env.document);
    const block = root.querySelector('.omnitime-tl__cal-event');
    pointer(env.window, block, 'pointerdown', 100);
    pointer(env.window, block, 'pointerup', 100);
    await settle(250);
    root.querySelector('.omnitime-search__item').click();
    root.querySelector('.omnitime-save').click();
    await settle();
    const { history, at, ...remembered } = store.omnitimeCalIssues['uid:w-1'];
    assert.equal(at, history[0].at);
    assert.deepEqual(remembered, { id: 55, label: 'Sync #5', title: 'Weekly sync' });
    assert.equal(history.length, 1);
  });
});

describe('save errors', () => {
  const failing = (err) => async () => {
    const f = await openCreate();
    f.api.create = () => Promise.reject(err);
    f.q('.omnitime-save').click();
    await settle(20);
    return f;
  };

  it('never shows a server error page: a Drupal 500 HTML body becomes a friendly sentence', async () => {
    const html = '<!DOCTYPE html><html><body><h1>The website encountered an unexpected error.</h1><pre>Stack trace at /var/www/x.php</pre></body></html>';
    const f = await failing(Object.assign(new Error(html), { status: 500 }))();
    const banner = f.q('.omnitime-form__alert');
    assert.equal(banner.hidden, false);
    assert.equal(banner.textContent, "Couldn't save the entry. 1x TIMES had a problem. Try again in a moment.");
    assert.ok(!banner.textContent.includes('<'));
    assert.equal(f.q('.omnitime-save').disabled, false, 'Save is available again');
  });

  it("shows the server's own reason for a rejected entry (closed issue)", async () => {
    const f = await failing(Object.assign(new Error('The issue is closed.'), { status: 400 }))();
    assert.equal(f.q('.omnitime-form__alert').textContent, "Couldn't save the entry. The issue is closed.");
  });

  it('keeps the old-server hint', async () => {
    const f = await failing(Object.assign(new Error('Not Found'), { status: 404 }))();
    assert.equal(f.q('.omnitime-form__alert').textContent, 'Saving needs the updated API on the server.');
  });
});

describe('a time that does not fit the free gap', () => {
  const day = [
    { ...ENTRY, id: 1, start: '09:00', stop: '09:30', duration_minutes: 30 },
    { ...ENTRY, id: 2, start: '15:45', stop: '16:00', duration_minutes: 15 },
    { ...ENTRY, id: 3, start: '16:15', stop: '16:30', duration_minutes: 15 },
  ];

  it('says how much is free instead of silently clamping the duration', async () => {
    const f = await openForm({ entries: day });
    f.openCreate();
    f.type(f.start, '16:00');
    f.type(f.dur, '0:15');
    assert.equal(f.q('.omnitime-f-end').textContent.includes('free here'), false, 'no note while it fits');
    f.root.querySelectorAll('.omnitime-qdur__chip')[3].click(); // 0:30
    assert.equal(f.dur.value, '0:15', 'the duration stays at what fits');
    assert.equal(f.start.value, '16:00');
    assert.match(f.q('.omnitime-f-end').textContent, /only 0:15 free here/);
    assert.equal(f.q('.omnitime-f-end').getAttribute('aria-live'), 'polite');
    // The note goes away with the next edit.
    f.type(f.dur, '0:15');
    assert.equal(f.q('.omnitime-f-end').textContent.includes('free here'), false);
  });

  it('says when the start moved to make the time fit', async () => {
    const f = await openForm({ entries: day });
    f.openCreate();
    f.type(f.start, '15:30');
    f.type(f.dur, '0:15');
    f.root.querySelectorAll('.omnitime-qdur__chip')[4].click(); // 1:00 does not fit before 15:45: the start moves back
    assert.equal(f.dur.value, '1:00');
    assert.equal(f.start.value, '14:45');
    assert.match(f.q('.omnitime-f-end').textContent, /moved to 14:45 to fit/);
  });
});
