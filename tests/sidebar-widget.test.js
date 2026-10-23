// The GitLab sidebar quick-track widget (sidebar-widget.js) and its wiring in
// content.js: start/duration math, create payload, totals, undo, closed issues,
// old API, and surviving the SPA re-renders without injecting twice.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { loadDom, read, settle, makeEvent } = require('./helpers');

const CONTEXT = { source: 'https://gitlab.example.test', project_id: '7', issue_id: '42' };
const TODAY_NOON = () => new Date(2026, 9, 22, 14, 7); // 14:07 local

const entry = (id, issueId, minutes) => ({
  id, start: '09:00', stop: '09:30', duration_minutes: minutes, duration_label: '', project: 'P',
  issue_external_id: String(issueId), issue_internal_id: 1000 + Number(issueId), editable: true,
});

// A stateful fake of the API client: create/remove change what the readers return.
// `issueExtra({ mine, entries })` adds fields to the tracked-time response (own_sum, rows).
function fakeApi({ issueOpen = true, entries = [], others = 80, newApi = true, fail = {}, issueExtra } = {}) {
  const calls = [];
  let nextId = 500;
  const api = {
    calls, entries, delay: 0,
    wait: () => new Promise((r) => setTimeout(r, api.delay)),
    issueTime: async (ctx) => {
      calls.push(['issueTime', ctx]);
      if (fail.issueTime) throw Object.assign(new Error('Stack trace at Drupal\\Core\\Foo.php:12'), { status: 500 });
      const mine = entries.filter((e) => e.issue_external_id === CONTEXT.issue_id).reduce((s, e) => s + e.duration_minutes, 0);
      return { tracked_time: [], total_sum: others + mine, details: [], ...(newApi ? { issue: { open: issueOpen } } : {}), ...(issueExtra ? issueExtra({ mine, entries }) : {}) };
    },
    myDay: async (date) => {
      calls.push(['myDay', date]);
      if (!newApi) throw Object.assign(new Error('Not found'), { status: 404 });
      return { date, entries: entries.slice(), day_total_minutes: entries.reduce((s, e) => s + e.duration_minutes, 0) };
    },
    create: async (payload) => {
      calls.push(['create', payload]);
      await api.wait();
      if (fail.create) throw Object.assign(new Error('boom'), { status: 403 });
      const e = entry(nextId++, payload.issue_id, payload.duration);
      entries.push(e);
      return { id: e.id };
    },
    remove: async (id) => {
      calls.push(['remove', id]);
      if (fail.remove) throw new Error('boom');
      entries.splice(entries.findIndex((e) => e.id === id), 1);
      return null;
    },
  };
  return api;
}

function setup(apiOpts, widgetOpts = {}) {
  const sent = [];
  const chrome = { runtime: { sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb({ success: true }); } } };
  const env = loadDom(['ical-parser.js', 'core.js', 'sidebar-widget.js'], { chrome });
  const target = env.document.createElement('div');
  env.document.body.appendChild(target);
  const api = fakeApi(apiOpts);
  let opened = 0;
  const widget = env.window.OmniTimeSidebar.attach(target, {
    apiClient: api, context: { ...CONTEXT }, now: TODAY_NOON, undoMs: 80,
    onOpen: () => { opened++; }, expanded: true, ...widgetOpts,
  });
  const root = () => (widget.host ? widget.host.shadowRoot : null);
  const q = (sel) => root().querySelector(sel);
  const chevron = () => (widget.chevron ? widget.chevron.shadowRoot.querySelector('.omnitime-sw__chev') : null);
  return { ...env, target, api, widget, sent, root, q, chevron, opened: () => opened };
}
const visible = (el) => !el.hidden;
const buttons = (t) => [...t.root().querySelectorAll('.omnitime-sw__btn')];
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

describe('quickEntry (start/duration math)', () => {
  const { window } = loadDom(['core.js', 'sidebar-widget.js']);
  const qe = (h, m, minutes) => window.OmniTimeSidebar.quickEntry(new window.Date(2026, 9, 22, h, m), minutes);

  it('starts now - duration, snapped DOWN to 5 minutes, so it ends at or just before now', () => {
    assert.deepEqual({ ...qe(14, 7, 15) }, { date: '2026-10-22', start_time: '13:50', duration: 15, clamped: false });
    assert.equal(qe(14, 10, 30).start_time, '13:40'); // already on the grid: ends exactly now
    assert.equal(qe(14, 14, 60).start_time, '13:10');
    assert.equal(qe(14, 14, 60).duration, 60);
  });

  it('fits exactly when the day has just enough minutes', () => {
    assert.deepEqual({ ...qe(0, 30, 30) }, { date: '2026-10-22', start_time: '00:00', duration: 30, clamped: false });
    assert.equal(qe(0, 34, 30).start_time, '00:00'); // 00:04 snaps down to 00:00
    assert.equal(qe(0, 35, 30).start_time, '00:05');
  });

  it('clamps to 00:00 and shortens the duration shortly after midnight', () => {
    assert.deepEqual({ ...qe(0, 10, 30) }, { date: '2026-10-22', start_time: '00:00', duration: 10, clamped: true });
    assert.equal(qe(0, 12, 30).duration, 10); // elapsed time rounded down to 5
    assert.equal(qe(0, 20, 60).duration, 20);
    assert.equal(qe(0, 5, 15).duration, 5);
  });

  it('books nothing in the first 5 minutes of the day', () => {
    assert.equal(qe(0, 0, 15), null);
    assert.equal(qe(0, 4, 60), null);
  });

  it('never ends in the future and never starts before today', () => {
    for (let min = 0; min < 24 * 60; min += 7) {
      for (const d of [5, 10, 15, 30, 60]) {
        const e = qe(Math.floor(min / 60), min % 60, d);
        if (!e) { assert.ok(min < 5); continue; }
        const start = Number(e.start_time.slice(0, 2)) * 60 + Number(e.start_time.slice(3));
        assert.ok(start >= 0 && start % 5 === 0);
        assert.ok(start + e.duration <= min, `${min} +${d}`);
        assert.ok(e.duration >= 5 && e.duration <= d);
      }
    }
  });
});

describe('create payload', () => {
  it('has the fields of the form\'s "current issue" create, without a comment', () => {
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    const S = window.OmniTimeSidebar;
    const payload = S.quickPayload(CONTEXT, S.quickEntry(TODAY_NOON(), 30));
    assert.deepEqual({ ...payload }, {
      source: 'https://gitlab.example.test', project_id: '7', issue_id: '42',
      date: '2026-10-22', start_time: '13:35', duration: 30,
    });
  });
});

describe('sidebar widget', () => {
  it('shows the issue total and only your own entries for this issue today', async () => {
    const t = setup({ entries: [entry(1, 42, 25), entry(2, 42, 20), entry(3, 99, 60)], others: 100 });
    assert.equal(t.root(), null, 'mounts only after the styles promise');
    await settle();
    assert.equal(t.q('[data-el="issue"]').textContent, '2:25'); // 100 + 45
    assert.equal(t.q('[data-el="own"]').textContent, '0:45');
    assert.equal(visible(t.q('[data-el="actions"]')), true);
    assert.deepEqual(buttons(t).map((b) => b.textContent), ['5m', '10m', '15m', '30m', '1h']);
    assert.equal(t.api.calls.find((c) => c[0] === 'myDay')[1], '2026-10-22');
  });

  it('opens the modal when the totals are clicked', async () => {
    const t = setup();
    await settle();
    click(t.q('[data-el="totals"]'));
    assert.equal(t.opened(), 1);
  });

  it('uses the shared tokens and follows the theme', async () => {
    const t = setup({}, { theme: () => 'dark' });
    await settle();
    assert.equal(t.widget.host.getAttribute('data-theme'), 'dark');
    assert.match(t.root().innerHTML, /omnitime-sw/);
  });

  it('is one segmented group: decorative plus cell, five labelled segments, no Start without the timer', async () => {
    const t = setup();
    await settle();
    const group = t.q('[data-el="actions"]');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'Add time ending now');
    const plus = group.querySelector('.omnitime-sw__plus');
    assert.equal(plus.getAttribute('aria-hidden'), 'true');
    assert.equal(plus.closest('button'), null);
    assert.deepEqual(buttons(t).map((b) => b.getAttribute('aria-label')), [
      'Add 5 minutes, ending now', 'Add 10 minutes, ending now', 'Add 15 minutes, ending now',
      'Add 30 minutes, ending now', 'Add 1 hour, ending now',
    ]);
    assert.ok(buttons(t).every((b) => b.closest('[data-el="actions"]')));
  });

  it('every segment books its own duration (5/10/15/30/60), ending now', async () => {
    const t = setup();
    await settle();
    for (const b of buttons(t)) { click(b); await settle(); }
    const created = t.api.calls.filter((c) => c[0] === 'create').map((c) => c[1].duration);
    assert.deepEqual(created, [5, 10, 15, 30, 60]);
  });

  it('a 5m booking just after midnight follows the same clamp / too-early rule', async () => {
    const t = setup({}, { now: () => new Date(2026, 9, 22, 0, 7) });
    await settle();
    click(buttons(t)[0]);
    await settle();
    const create = t.api.calls.find((c) => c[0] === 'create')[1];
    assert.equal(create.start_time, '00:00');
    assert.equal(create.duration, 5);
    const early = setup({}, { now: () => new Date(2026, 9, 22, 0, 4) });
    await settle();
    click(buttons(early)[0]);
    await settle();
    assert.equal(early.api.calls.filter((c) => c[0] === 'create').length, 0);
    assert.match(early.q('[data-el="msg"]').textContent, /Too early/);
  });

  it('15m books an entry ending now, refreshes the totals, reports the day total', async () => {
    const t = setup({ entries: [entry(1, 42, 30)] });
    await settle();
    click(buttons(t)[2]);
    await settle();
    const create = t.api.calls.find((c) => c[0] === 'create')[1];
    assert.deepEqual({ ...create }, {
      source: CONTEXT.source, project_id: '7', issue_id: '42', date: '2026-10-22', start_time: '13:50', duration: 15,
    });
    assert.equal(t.q('[data-el="own"]').textContent, '0:45');
    assert.equal(t.q('[data-el="issue"]').textContent, '2:05'); // 80 others + 45
    assert.match(t.q('[data-el="msg"]').textContent, /^Added 0:15 · Undo$/);
    assert.deepEqual(JSON.parse(JSON.stringify(t.sent)), [{ action: 'OMNI_DAY_TOTAL', date: '2026-10-22', totalMinutes: 45 }]);
  });

  it('disables the buttons while a request runs, so a double click books once', async () => {
    const t = setup();
    t.api.delay = 30;
    await settle();
    const [, , b15, b30] = buttons(t);
    click(b15);
    assert.ok(buttons(t).every((b) => b.disabled));
    click(b15);
    click(b30);
    await settle(120);
    assert.equal(t.api.calls.filter((c) => c[0] === 'create').length, 1);
    assert.ok(buttons(t).every((b) => !b.disabled));
  });

  it('Undo removes the new entry, refreshes and reports the day total', async () => {
    const t = setup({ entries: [entry(1, 42, 30)] });
    await settle();
    click(buttons(t)[3]);
    await settle();
    assert.equal(t.q('[data-el="own"]').textContent, '1:00');
    click(t.q('[data-el="msg"] button'));
    await settle();
    assert.deepEqual(t.api.calls.filter((c) => c[0] === 'remove'), [['remove', 500]]);
    assert.equal(t.q('[data-el="own"]').textContent, '0:30');
    assert.equal(t.sent.at(-1).totalMinutes, 30);
    assert.equal(t.q('[data-el="msg"] button'), null, 'no second undo');
  });

  it('drops the Undo after the timeout', async () => {
    const t = setup();
    await settle();
    click(buttons(t)[0]);
    await settle();
    assert.ok(t.q('[data-el="msg"] button'));
    await settle(120);
    assert.equal(t.q('[data-el="msg"]').hidden, true);
  });

  it('shows a one-line error (no server text) when booking fails, and books nothing', async () => {
    const t = setup({ fail: { create: true } });
    await settle();
    click(buttons(t)[0]);
    await settle();
    assert.equal(t.q('[data-el="msg"]').textContent, 'Couldn\'t add time (HTTP 403).');
    assert.equal(t.sent.length, 0);
    assert.ok(buttons(t).every((b) => !b.disabled));
  });

  it('shortens a button\'s entry right after midnight, and refuses before 00:05', async () => {
    const t = setup({}, { now: () => new Date(2026, 9, 22, 0, 10) });
    await settle();
    click(buttons(t)[3]);
    await settle();
    const create = t.api.calls.find((c) => c[0] === 'create')[1];
    assert.equal(create.start_time, '00:00');
    assert.equal(create.duration, 10);
    assert.match(t.q('[data-el="msg"]').textContent, /^Added 0:10/);

    const early = setup({}, { now: () => new Date(2026, 9, 22, 0, 3) });
    await settle();
    click(buttons(early)[0]);
    await settle();
    assert.equal(early.api.calls.filter((c) => c[0] === 'create').length, 0);
    assert.match(early.q('[data-el="msg"]').textContent, /Too early/);
  });

  it('hides the buttons for a closed issue but keeps the totals', async () => {
    const t = setup({ issueOpen: false, entries: [entry(1, 42, 15)] });
    await settle();
    assert.equal(t.q('[data-el="actions"]').hidden, true);
    assert.equal(t.q('[data-el="issue"]').textContent, '1:35');
    assert.equal(t.q('[data-el="closed"]').hidden, false);
  });

  it('shows totals only on the old API (no day endpoint)', async () => {
    const t = setup({ newApi: false });
    await settle();
    assert.equal(t.q('[data-el="actions"]').hidden, true);
    assert.equal(t.q('[data-el="ownWrap"]').hidden, true);
    assert.equal(t.q('[data-el="issue"]').textContent, '1:20');
    assert.equal(t.q('[data-el="closed"]').hidden, true);
  });

  it('shows a compact error line with Retry when the totals fail to load', async () => {
    const t = setup({ fail: { issueTime: true } });
    await settle();
    assert.equal(t.q('[data-el="summary"]').hidden, true);
    const line = t.q('[data-el="line"]');
    assert.equal(line.textContent, 'OmniTime: couldn\'t load time data.Retry');
    assert.doesNotMatch(t.root().textContent, /Drupal|Stack/);
  });

  it('destroy unmounts and ignores late responses', async () => {
    const t = setup();
    t.api.delay = 30;
    await settle();
    const host = t.widget.host;
    click(buttons(t)[0]);
    t.widget.destroy();
    assert.equal(host.isConnected, false);
    await settle(80);
    assert.equal(t.sent.length, 0);
    assert.equal(t.document.querySelectorAll('omnitime-inline').length, 0);
  });
});

// Privacy: collapsed by default, a chevron next to the heading, presentation mode.
describe('sidebar widget: collapsed by default and the chevron', () => {
  // A heading the chevron goes into, with a listener standing in for the
  // "open the modal" click that content.js puts on GitLab's heading.
  function withHeading(apiOpts, widgetOpts = {}) {
    const state = { headingClicks: 0 };
    let heading;
    const t = setup(apiOpts, {
      expanded: false,
      heading: () => heading,
      ...widgetOpts,
    });
    heading = t.document.createElement('h3');
    heading.textContent = 'Time tracking';
    heading.addEventListener('click', () => { state.headingClicks++; });
    t.target.appendChild(heading);
    t.state = state;
    t.heading = heading;
    return t;
  }
  const names = (t) => [...t.target.querySelectorAll('omnitime-inline')];

  it('renders only the chevron and makes no API request until expanded', async () => {
    const t = withHeading();
    await settle();
    assert.equal(t.widget.host, null, 'no details host');
    assert.equal(names(t).length, 1);
    assert.equal(t.heading.contains(names(t)[0]), true, 'the chevron sits in the heading');
    assert.equal(t.widget.chevron.shadowRoot.querySelector('.omnitime-sw'), null);
    assert.equal(t.widget.chevron.shadowRoot.textContent.includes('Issue'), false);
    assert.deepEqual(t.api.calls, []);
    assert.equal(t.sent.length, 0);
    // A refresh (the modal closed) or a tab coming back must not fetch either.
    await t.widget.refresh();
    t.document.dispatchEvent(new t.window.Event('visibilitychange'));
    await settle();
    assert.deepEqual(t.api.calls, []);
  });

  it('expanding fetches and renders; collapsing removes the details again', async () => {
    const t = withHeading({ entries: [entry(1, 42, 25)], others: 100 });
    await settle();
    click(t.chevron());
    await settle();
    assert.equal(t.api.calls.filter((c) => c[0] === 'issueTime').length, 1);
    assert.equal(t.q('[data-el="issue"]').textContent, '2:05');
    assert.deepEqual(buttons(t).map((b) => b.textContent), ['5m', '10m', '15m', '30m', '1h']);
    click(t.chevron());
    await settle();
    assert.equal(t.widget.host, null);
    assert.equal(t.target.querySelectorAll('.omnitime-sw').length, 0);
    const before = t.api.calls.length;
    await t.widget.refresh();
    assert.equal(t.api.calls.length, before, 'collapsed: no more requests');
  });

  it('is a real button with aria-expanded, aria-controls and a toggling name', async () => {
    const t = withHeading();
    await settle();
    const b = t.chevron();
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.type, 'button');
    assert.equal(b.getAttribute('aria-expanded'), 'false');
    assert.equal(b.getAttribute('aria-label'), 'Show time tracking');
    assert.ok(b.querySelector('svg'));
    click(b);
    await settle();
    assert.equal(b.getAttribute('aria-expanded'), 'true');
    assert.equal(b.getAttribute('aria-label'), 'Hide time tracking');
    assert.equal(b.getAttribute('aria-controls'), t.q('.omnitime-sw').id);
    click(b);
    assert.equal(b.getAttribute('aria-expanded'), 'false');
    assert.equal(b.getAttribute('aria-label'), 'Show time tracking');
  });

  it('the chevron click does not reach the heading (which opens the modal)', async () => {
    const t = withHeading();
    await settle();
    t.chevron().dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    assert.equal(t.state.headingClicks, 0);
    t.heading.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(t.state.headingClicks, 1);
  });

  it('starts expanded when told to, and reports every toggle', async () => {
    const seen = [];
    const t = withHeading({}, { expanded: true, onToggle: (v) => seen.push(v) });
    await settle();
    assert.equal(t.q('[data-el="issue"]').textContent, '1:20');
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'true');
    click(t.chevron());
    click(t.chevron());
    assert.deepEqual(seen, [false, true]);
  });

  it('ignores a late response after it was collapsed again, without errors', async () => {
    const t = withHeading();
    t.api.issueTime = async () => { await new Promise((r) => setTimeout(r, 40)); return { total_sum: 5, tracked_time: [] }; };
    await settle();
    click(t.chevron());
    await settle(5);
    click(t.chevron());
    await settle(80);
    assert.equal(t.widget.host, null);
    assert.deepEqual(t.errors, []);
  });

  it('presentation mode: no chevron at all, nothing fetched, even if expanded was asked for', async () => {
    const t = withHeading({}, { presentation: true, expanded: true });
    await settle();
    assert.equal(names(t).length, 0);
    assert.equal(t.widget.chevron, null);
    assert.equal(t.widget.host, null);
    assert.deepEqual(t.api.calls, []);
  });

  it('setPresentation(true) collapses an open widget and drops the chevron; off restores it collapsed', async () => {
    const seen = [];
    const t = withHeading({}, { expanded: true, onToggle: (v) => seen.push(v) });
    await settle();
    assert.equal(names(t).length, 2);
    t.widget.setPresentation(true);
    assert.equal(names(t).length, 0);
    assert.equal(t.target.querySelectorAll('.omnitime-sw').length, 0);
    assert.deepEqual(seen, [false]);
    const calls = t.api.calls.length;
    t.widget.setPresentation(false);
    await settle();
    assert.equal(names(t).length, 1);
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'false');
    assert.equal(t.api.calls.length, calls, 'restoring the chevron fetches nothing');
  });

  it('the chevron styles use defined tokens only, and honour reduced motion', () => {
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    const css = window.OmniTimeSidebar.CHEV_CSS;
    const tokens = new Set(read('style.css').match(/--ot-[\w-]+(?=:)/g));
    const used = [...new Set(css.match(/var\((--ot-[\w-]+)\)/g).map((v) => v.slice(4, -1)))];
    assert.deepEqual(used.filter((u) => !tokens.has(u)), []);
    assert.deepEqual(css.match(/#[0-9a-f]{3,6}\b|rgba?\(/gi) || [], []);
    assert.match(css, /transition: transform 150ms/);
    assert.match(css, /rotate\(180deg\)/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.omnitime-sw__chev svg \{ transition: none; \}/);
  });
});

// "You" (the whole time on the issue) and the per-person list.
describe('sidebar widget: You and the people list', () => {
  const row = (user, time_spent, extra = {}) => ({ user, time_spent, self: false, ...extra });
  // A PM's response: eight named people, the caller (Fay) in the middle.
  const PEOPLE = [row('Dana Example', 120), row('Fay Example', 75, { self: true }), row('Eli Example', 60),
    row('Gus Example', 45), row('Hal Example', 30), row('Ida Example', 25), row('Joy Example', 20), row('Kim Example', 5)];
  const api = (tracked, ownSum, extra = {}) => ({
    others: 0,
    issueExtra: () => ({ tracked_time: tracked, ...(ownSum === undefined ? {} : { own_sum: ownSum }), ...extra }),
  });
  const people = (t) => [...t.root().querySelectorAll('.omnitime-sw__person')];
  const text = (el) => [...el.children].map((c) => c.textContent);
  const list = (t) => t.q('[data-el="people"]');
  // The visible summary text (the hidden "Closed" note is left out).
  const summary = (t) => [...t.q('[data-el="totals"]').children].filter((c) => !c.hidden).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();

  it('the summary line shows the whole own_sum as "You", not today\'s time', async () => {
    const t = setup({ ...api([row('Me', 75, { self: true })], 75), entries: [entry(1, 42, 25)] });
    await settle();
    assert.equal(t.q('[data-el="ownLabel"]').textContent, 'You');
    assert.equal(t.q('[data-el="own"]').textContent, '1:15'); // not today's 0:25
    assert.equal(summary(t), 'Issue 0:25 · You 1:15');
  });

  it('own_sum 0 is a real value: "You 0:00", not "You today"', async () => {
    const t = setup({ ...api([], 0), entries: [entry(1, 42, 25)] });
    await settle();
    assert.equal(t.q('[data-el="ownLabel"]').textContent, 'You');
    assert.equal(t.q('[data-el="own"]').textContent, '0:00');
  });

  it('falls back to the self row without own_sum, then to "You today"', async () => {
    const viaRow = setup({ ...api([row('Me', 50, { self: true }), row('Others', 30, { others: true })]), entries: [entry(1, 42, 25)] });
    await settle();
    assert.equal(viaRow.q('[data-el="ownLabel"]').textContent, 'You');
    assert.equal(viaRow.q('[data-el="own"]').textContent, '0:50');

    const neither = setup({ entries: [entry(1, 42, 25)] });
    await settle();
    assert.equal(neither.q('[data-el="ownLabel"]').textContent, 'You today');
    assert.equal(neither.q('[data-el="own"]').textContent, '0:25');
    assert.equal(summary(neither), 'Issue 1:45 · You today 0:25');
  });

  it('keeps You on a server with own_sum but no day API; the buttons stay away', async () => {
    const t = setup({ ...api([], 40), newApi: false });
    await settle();
    assert.equal(t.q('[data-el="own"]').textContent, '0:40');
    assert.equal(t.q('[data-el="ownWrap"]').hidden, false);
    assert.equal(t.q('[data-el="actions"]').hidden, true);
  });

  it('still fetches the day for the buttons and reports the day total after a booking', async () => {
    const t = setup({ ...api([], 40), entries: [entry(1, 42, 25)] });
    await settle();
    assert.ok(t.api.calls.some((c) => c[0] === 'myDay'));
    assert.equal(visible(t.q('[data-el="actions"]')), true);
    click(buttons(t)[2]);
    await settle();
    assert.deepEqual(t.sent.map((m) => [m.action, m.totalMinutes]), [['OMNI_DAY_TOTAL', 40]]);
  });

  it('hides the list for "only me" and for "me + Others" (a regular user)', async () => {
    const onlyMe = setup(api([row('Me', 75, { self: true })], 75));
    await settle();
    assert.equal(list(onlyMe).hidden, true);
    assert.equal(people(onlyMe).length, 0);

    const regular = setup(api([row('Me', 75, { self: true }), row('Others', 40, { others: true })], 75));
    await settle();
    assert.equal(list(regular).hidden, true);
    assert.equal(people(regular).length, 0);
    assert.equal(regular.q('[data-el="totals"]').hidden, false);
  });

  it('hides the list when the server lacks the self/others flags (old rows are indistinguishable)', async () => {
    const t = setup(api([{ user: 'Dana Example', time_spent: 60 }, { user: 'Others', time_spent: 20 }]));
    await settle();
    assert.equal(list(t).hidden, true);
    assert.equal(t.q('[data-el="ownLabel"]').textContent, 'You today');
  });

  it('shows the list as soon as one other named person is there, even without own time', async () => {
    const t = setup(api([row('Dana Example', 60), row('Others', 20, { others: true })], 0));
    await settle();
    assert.equal(list(t).hidden, false);
    assert.deepEqual(people(t).map((li) => text(li)), [['Dana Example', '1:00'], ['Others', '0:20']]);
  });

  it('lists the API\'s rows in order: "You" bold in place, names and times, Others last', async () => {
    const rows = [row('Dana Example', 120), row('Fay Example', 75, { self: true }), row('Eli Example', 60), row('Others', 30, { others: true })];
    const t = setup(api(rows, 75));
    await settle();
    assert.equal(list(t).hidden, false);
    assert.equal(list(t).tagName, 'UL');
    assert.deepEqual(people(t).map((li) => text(li)), [
      ['Dana Example', '2:00'], ['You', '1:15'], ['Eli Example', '1:00'], ['Others', '0:30'],
    ]);
    const bold = people(t).filter((li) => li.classList.contains('omnitime-sw__person--self'));
    assert.equal(bold.length, 1);
    assert.equal(bold[0], people(t)[1], 'You keeps its position');
    assert.equal(t.root().querySelector('.omnitime-sw__more'), null, 'four rows: no "more" line');
    assert.match(t.widget.host.shadowRoot.textContent, /Time per person|Dana/);
    // The summary and the rows come from the same response.
    assert.equal(t.q('[data-el="own"]').textContent, '1:15');
  });

  it('shows at most five rows, then "+N more · Show all", which opens the modal', async () => {
    const t = setup(api(PEOPLE, 75));
    await settle();
    assert.equal(people(t).length, 5);
    assert.deepEqual(people(t).map((li) => li.firstChild.textContent), ['Dana Example', 'You', 'Eli Example', 'Gus Example', 'Hal Example']);
    const more = t.root().querySelector('.omnitime-sw__more');
    assert.equal(more.tagName, 'BUTTON');
    assert.equal(more.textContent, '+3 more · Show all');
    assert.equal(more.parentElement, list(t).lastElementChild);
    assert.equal(t.opened(), 0);
    click(more);
    assert.equal(t.opened(), 1);
  });

  it('exactly five rows have no "more" line', async () => {
    const t = setup(api(PEOPLE.slice(0, 5), 75));
    await settle();
    assert.equal(people(t).length, 5);
    assert.equal(t.root().querySelector('.omnitime-sw__more'), null);
  });

  it('truncates long names with an ellipsis and a title tooltip', async () => {
    const long = 'Bartholomew Maximilian Featherstonehaugh-Cholmondeley Example';
    const t = setup(api([row(long, 60), row('Me', 10, { self: true })], 10));
    await settle();
    const name = people(t)[0].firstChild;
    assert.equal(name.textContent, long);
    assert.equal(name.title, long);
    const css = t.window.OmniTimeSidebar.CSS;
    assert.match(css, /\.omnitime-sw__name \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    assert.match(css, /\.omnitime-sw__time \{[^}]*font-variant-numeric: tabular-nums/);
  });

  it('refreshes the summary and the rows together after a booking and after Undo', async () => {
    // The caller's row follows the booked entries; a colleague stays at 1:00.
    const issueExtra = ({ mine }) => ({
      own_sum: 30 + mine,
      tracked_time: [row('Dana Example', 60), row('Me', 30 + mine, { self: true })].sort((a, b) => b.time_spent - a.time_spent),
    });
    const t = setup({ others: 0, issueExtra });
    await settle();
    const own = () => t.q('[data-el="own"]').textContent;
    const rows = () => people(t).map((li) => text(li).join(' '));
    assert.equal(own(), '0:30');
    assert.deepEqual(rows(), ['Dana Example 1:00', 'You 0:30']);

    click(buttons(t)[4]); // 1h
    await settle();
    assert.equal(own(), '1:30');
    assert.deepEqual(rows(), ['You 1:30', 'Dana Example 1:00']);

    click(t.q('[data-el="msg"] button')); // Undo
    await settle();
    assert.equal(own(), '0:30');
    assert.deepEqual(rows(), ['Dana Example 1:00', 'You 0:30']);
  });

  it('collapsing removes the rows from the DOM; expanding builds them again', async () => {
    const t = setup(api(PEOPLE, 75), { expanded: false, heading: () => t.target });
    await settle();
    assert.equal(t.widget.host, null);
    click(t.chevron());
    await settle();
    assert.equal(people(t).length, 5);
    click(t.chevron());
    await settle();
    assert.equal(t.widget.host, null);
    assert.equal(t.target.querySelectorAll('.omnitime-sw__person, .omnitime-sw__people').length, 0);
    click(t.chevron());
    await settle();
    assert.equal(people(t).length, 5);
  });

  it('presentation mode shows neither the rows nor the summary', async () => {
    const t = setup(api(PEOPLE, 75), { presentation: true });
    await settle();
    assert.equal(t.widget.host, null);
    assert.equal(t.target.querySelectorAll('.omnitime-sw__person').length, 0);
    assert.deepEqual(t.api.calls, []);
  });

  it('the list styles use defined tokens only', () => {
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    const css = window.OmniTimeSidebar.CSS;
    const tokens = new Set(read('style.css').match(/--ot-[\w-]+(?=:)/g));
    const used = [...new Set(css.match(/var\((--ot-[\w-]+)\)/g).map((v) => v.slice(4, -1)))];
    assert.deepEqual(used.filter((u) => !tokens.has(u)), []);
    assert.deepEqual(css.match(/#[0-9a-f]{3,6}\b|rgba?\(/gi) || [], []);
  });

  it('summarize() reads the flags defensively', () => {
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    const sum = (x) => JSON.parse(JSON.stringify(window.OmniTimeSidebar.summarize(x)));
    assert.deepEqual(sum(undefined), { own: null, people: [], showPeople: false });
    assert.deepEqual(sum({ tracked_time: 'nope', own_sum: '5' }), { own: null, people: [], showPeople: false });
    assert.equal(sum({ own_sum: 12, tracked_time: [null, { user: 'A', time_spent: 3 }] }).people.length, 1);
    assert.equal(sum({ tracked_time: [{ user: 'A', time_spent: 3, self: true }] }).own, 3);
  });
});

// content.js wiring on a synthetic GitLab page.
describe('content.js wiring', () => {
  const URL_ = 'https://gitlab.example.test/group/proj/-/issues/42';

  async function boot({ settings = {}, sidebar, local = {}, expand = true, issueData } = {}) {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', (e) => errors.push(e));
    const dom = new JSDOM('<!DOCTYPE html><html class="gl-light"><head><title>Issue (#42) · GitLab</title></head><body data-project-id="7">' +
      (sidebar || '<aside><div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div></aside>') + '</body></html>',
      { url: URL_, runScripts: 'outside-only', virtualConsole: vc });
    const { window } = dom;
    const calls = [];
    const entries = [];
    const onChanged = makeEvent();
    window.chrome = {
      storage: { sync: { get: async () => ({
        apiUrl: 'https://times.example.test/api/v1/tracked-time',
        instances: [{ hostUrl: 'gitlab.example.test', systemType: 'gitlab' }],
        ...settings,
      }) }, local: { get: (k, cb) => cb && cb({ ...local }), set: (o, cb) => cb && cb() }, onChanged },
      runtime: {
        sendMessage: (msg, cb) => {
          calls.push(msg);
          let data = {};
          if (msg.action === 'OMNI_FETCH') {
            if (msg.url.includes('/my-tracked-time')) data = { date: 'x', entries, day_total_minutes: 0 };
            else if (msg.url.includes('/tracked-time')) data = issueData || { total_sum: 10, tracked_time: [], details: [], issue: { open: true } };
          }
          if (cb) setTimeout(() => cb({ success: true, data }), 0);
        },
      },
    };
    window.Element.prototype.scrollIntoView = () => {};
    window.__omnitimeShadowMode = 'open'; // production shadow roots are closed; the tests look inside
    ['adapters/gitlab.js', 'ical-parser.js', 'core.js', 'sidebar-widget.js', 'content.js'].forEach((f) => window.eval(read(f)));
    window.OmniTime.setStyles(read('style.css'));
    await settle(60);
    // The widget is collapsed by default: the sidebar tests expand it first
    // (the chevron lives in the heading, in its own shadow root).
    const hosts = () => [...window.document.querySelectorAll('omnitime-inline')];
    const chevron = () => {
      const host = window.document.querySelector('h3 omnitime-inline, .block.time-tracking > omnitime-inline');
      return host ? host.shadowRoot.querySelector('.omnitime-sw__chev') : null;
    };
    const details = () => hosts().find((h) => h.shadowRoot.querySelector('.omnitime-sw'));
    const t = { window, document: window.document, calls, errors, hosts, chevron, details, onChanged };
    if (expand) { t.chevron().click(); await settle(60); }
    return t;
  }

  it('injects exactly one widget under the Time tracking section, once the sidebar re-renders and again', async () => {
    const t = await boot();
    const target = () => t.document.querySelector('[data-testid="work-item-time-tracking"]');
    // The chevron sits in the heading, the details under it: one host each.
    assert.equal(t.hosts().length, 2);
    assert.equal(t.details().parentElement, target());
    // Unrelated DOM churn must not re-inject.
    t.document.body.appendChild(t.document.createElement('div'));
    await settle(30);
    assert.equal(t.hosts().length, 2);
    const first = t.details();
    // GitLab re-creates the whole sidebar.
    t.document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>';
    await settle(60);
    assert.equal(t.hosts().length, 2);
    assert.notEqual(t.details(), first);
    assert.equal(t.details().parentElement, target());
    // The target stays but its children are replaced (our element is dropped).
    target().innerHTML = '<h3>Time tracking</h3>';
    await settle(60);
    assert.equal(t.hosts().length, 2);
    assert.deepEqual(t.errors, []);
    t.window.close();
  });

  it('shows the totals, and the header still opens the modal', async () => {
    const t = await boot();
    const root = t.details().shadowRoot;
    assert.equal(root.querySelector('[data-el="issue"]').textContent, '0:10');
    t.document.querySelector('[data-testid="work-item-time-tracking"] h3').dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(30);
    assert.ok(t.document.querySelector('omnitime-root'));
    // Closing the modal refreshes the widget's numbers.
    const before = t.calls.filter((c) => c.action === 'OMNI_FETCH' && /\/tracked-time\?/.test(c.url) && c.method === 'GET').length;
    t.window.OmniTime.close();
    await settle(30);
    const after = t.calls.filter((c) => c.action === 'OMNI_FETCH' && /\/tracked-time\?/.test(c.url) && c.method === 'GET').length;
    assert.ok(after > before);
    t.window.close();
  });

  it('"Show all" in the people list opens the modal on the "This issue" tab', async () => {
    const tracked = ['Dana', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida', 'Joy'].map((n, i) => ({ user: `${n} Example`, time_spent: 70 - i * 5, self: i === 1 }));
    const t = await boot({ issueData: { total_sum: 400, own_sum: 65, tracked_time: tracked, details: [], issue: { open: true } } });
    const root = t.details().shadowRoot;
    assert.equal(root.querySelectorAll('.omnitime-sw__person').length, 5);
    const more = root.querySelector('.omnitime-sw__more');
    assert.equal(more.textContent, '+2 more · Show all');
    more.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    await settle(60);
    assert.ok(modalOpen(t), 'the modal opened');
    const modal = t.document.querySelector('omnitime-root').shadowRoot;
    assert.equal(modal.querySelector('.omnitime-tab--active').dataset.tab, 'issue');
    assert.match(modal.querySelector('.omnitime-issue').textContent, /Eli Example \(you\)/);
    t.window.close();
  });

  it('a colleague\'s name in the people list (PMs) opens the modal on their week', async () => {
    const tracked = [
      { user: 'Dana Example', time_spent: 70, self: false, uid: 101 },
      { user: 'Eli Example', time_spent: 60, self: true, uid: 100 },
      { user: 'Others', time_spent: 20, self: false, others: true },
    ];
    const t = await boot({ issueData: { total_sum: 150, own_sum: 60, tracked_time: tracked, details: [], issue: { open: true } } });
    const root = t.details().shadowRoot;
    const link = root.querySelector('button.omnitime-sw__name');
    assert.equal(link.getAttribute('aria-label'), "Open Dana Example's week");
    link.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    await settle(80);
    assert.ok(modalOpen(t), 'the modal opened');
    const modal = t.document.querySelector('omnitime-root').shadowRoot;
    assert.equal(modal.querySelector('.omnitime-tab--active').dataset.tab, 'week');
    assert.match(modal.querySelector('.omnitime-wk__viewing').textContent, /Viewing Dana Example's week/);
    assert.ok(t.calls.some((c) => c.action === 'OMNI_FETCH' && /\/my-tracked-week\?.*uid=101/.test(c.url)), 'asked for their week');
    t.window.close();
  });

  it('clicking a segment on a legacy sidebar without an h3 books an entry but does not open the modal', async () => {
    // No h3: the adapter makes the whole time-tracking block the trigger, and
    // the widget is mounted inside it, so its clicks bubble to the trigger.
    const t = await boot({ sidebar: '<aside><div class="block time-tracking">Time tracking</div></aside>' });
    assert.equal(t.hosts().length, 2);
    const trigger = t.document.querySelector('.block.time-tracking');
    assert.equal(trigger.title, 'Click to view OmniTime report');
    const btn = t.details().shadowRoot.querySelector('.omnitime-sw__btn');
    btn.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    await settle(60);
    assert.equal(t.document.querySelector('omnitime-root'), null, 'the modal stays closed');
    assert.ok(t.calls.some((c) => c.action === 'OMNI_FETCH' && c.method === 'POST'), 'the entry was booked');
    // A click on the block itself still opens it.
    trigger.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(30);
    assert.ok(t.document.querySelector('omnitime-root'));
    await settle(60); // the modal's requests finish before the window goes
    t.window.close();
  });

  const fetchesOf = (t) => t.calls.filter((c) => c.action === 'OMNI_FETCH');
  const modalOpen = (t) => !!t.document.querySelector('omnitime-root');

  it('is collapsed on page load: only the chevron, no totals and no widget request', async () => {
    const t = await boot({ expand: false });
    assert.equal(t.hosts().length, 1);
    assert.equal(t.details(), undefined);
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'false');
    assert.equal(t.chevron().getAttribute('aria-label'), 'Show time tracking');
    assert.equal(t.document.querySelector('h3 omnitime-inline') !== null, true, 'chevron in the heading');
    assert.deepEqual(fetchesOf(t), []);
    t.window.close();
  });

  it('the heading still opens the modal; the chevron click expands without opening it', async () => {
    const t = await boot({ expand: false });
    t.chevron().dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    await settle(60);
    assert.equal(modalOpen(t), false, 'chevron click: no modal');
    assert.ok(fetchesOf(t).length > 0, 'expanding fetched the numbers');
    assert.equal(t.details().shadowRoot.querySelector('[data-el="issue"]').textContent, '0:10');
    t.document.querySelector('h3').dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(30);
    assert.equal(modalOpen(t), true);
    await settle(60); // the modal's requests finish before the window goes
    t.window.close();
  });

  it('keeps the expanded state when GitLab re-renders the sidebar, and a collapse too', async () => {
    const t = await boot();
    const render = () => { t.document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>'; };
    render();
    await settle(80);
    assert.ok(t.details(), 'still expanded after a re-render');
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'true');
    t.chevron().click();
    await settle(30);
    assert.equal(t.details(), undefined);
    render();
    await settle(80);
    assert.equal(t.details(), undefined, 'still collapsed after a re-render');
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'false');
    t.window.close();
  });

  it('resets to collapsed when the page moves to another issue', async () => {
    const t = await boot();
    assert.ok(t.details());
    t.window.history.pushState({}, '', '/group/proj/-/issues/43');
    t.document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>';
    await settle(80);
    assert.equal(t.details(), undefined);
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'false');
    t.window.close();
  });

  it('sidebarStartExpanded opens the details on every issue; it is off by default', async () => {
    const t = await boot({ settings: { sidebarStartExpanded: true }, expand: false });
    assert.ok(t.details());
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'true');
    t.window.history.pushState({}, '', '/group/proj/-/issues/43');
    t.document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>';
    await settle(80);
    assert.ok(t.details(), 'the next issue opens too');
    t.window.close();
  });

  it('presentation mode renders no chevron at all, but the heading still opens the modal', async () => {
    const t = await boot({ local: { omnitimePresentationMode: true }, settings: { sidebarStartExpanded: true }, expand: false });
    assert.equal(t.hosts().length, 0);
    assert.equal(t.document.querySelector('h3').children.length, 0, 'the GitLab heading is untouched');
    assert.deepEqual(fetchesOf(t), []);
    t.document.querySelector('h3').dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(30);
    assert.equal(modalOpen(t), true);
    // A re-render does not bring it back.
    t.window.OmniTime.close();
    t.document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>';
    await settle(80);
    assert.equal(t.hosts().length, 0);
    t.window.close();
  });

  it('presentation mode turned on live collapses the open widget; off restores a collapsed chevron', async () => {
    const t = await boot();
    assert.equal(t.hosts().length, 2);
    t.onChanged.fire({ omnitimePresentationMode: { newValue: true } }, 'local');
    assert.equal(t.hosts().length, 0);
    const before = fetchesOf(t).length;
    t.onChanged.fire({ omnitimePresentationMode: { newValue: false } }, 'local');
    await settle(40);
    assert.equal(t.hosts().length, 1);
    assert.equal(t.chevron().getAttribute('aria-expanded'), 'false');
    assert.equal(fetchesOf(t).length, before);
    // Other areas and keys are ignored.
    t.onChanged.fire({ omnitimePresentationMode: { newValue: true } }, 'sync');
    assert.equal(t.hosts().length, 1);
    t.window.close();
  });

  it('injects nothing when showSidebarWidget is off, but keeps the header trigger', async () => {
    const t = await boot({ settings: { showSidebarWidget: false }, expand: false });
    assert.equal(t.hosts().length, 0);
    assert.equal(t.document.querySelector('h3').title, 'Click to view OmniTime report');
    t.window.close();
  });
});

describe('widget styles', () => {
  it('use only defined --ot-* tokens and no hard-coded colors', () => {
    const { window } = loadDom(['core.js', 'sidebar-widget.js']);
    const css = window.OmniTimeSidebar.CSS;
    const tokens = new Set(read('style.css').match(/--ot-[\w-]+(?=:)/g));
    const used = [...new Set(css.match(/var\((--ot-[\w-]+)\)/g).map((v) => v.slice(4, -1)))];
    assert.deepEqual(used.filter((u) => !tokens.has(u)), []);
    assert.deepEqual(css.match(/#[0-9a-f]{3,6}\b|rgba?\(/gi) || [], []);
    assert.ok(!/!important/.test(css));
    // style.css's [hidden] rule is scoped to the modal, so the widget carries its own.
    assert.match(css, /\.omnitime-sw \[hidden\] \{ display: none; \}/);
  });
});
