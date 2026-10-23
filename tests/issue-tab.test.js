// "This issue" tab, issue-less overlay and the shared friendly error state.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, settle } = require('./helpers');

const CTX = { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Fix login' };
const DETAILS = [
  { user: 'Alex', start_time: '2026-10-22 08:30', time_spent: 60, comment: '<p>Review</p>' },
  { user: 'Sam', start_time: '2026-10-22 13:00', time_spent: 30, comment: null },
  { user: 'Alex', start_time: '2026-10-21 09:15', time_spent: 45, comment: 'Earlier' },
];
const ISSUE_DATA = (extra = {}) => ({
  tracked_time: [{ user: 'Alex', time_spent: 105 }, { user: 'Sam', time_spent: 30 }],
  total_sum: 135,
  details: DETAILS,
  issue: { open: true },
  ...extra,
});

const err = (status, message) => Object.assign(new Error(message || 'boom'), status === undefined ? {} : { status });

function fakeApi({ issueTime, myDay } = {}) {
  const calls = [];
  return {
    calls,
    issueTime: issueTime || (() => Promise.resolve(ISSUE_DATA())),
    myDay: myDay || ((date) => Promise.resolve({
      date, week: [{ label: 'M', date, total_minutes: 0, total_label: '0:00', active: true }],
      day_total_label: '0:00', entries: [],
    })),
    frequent: () => Promise.resolve({ issues: [] }),
    search: () => Promise.resolve({ issues: [] }),
    create: () => Promise.resolve({ id: 1 }),
    update: () => Promise.resolve({}),
    remove: () => Promise.resolve(null),
  };
}

async function open({ api = fakeApi(), context = CTX, tab } = {}) {
  const env = loadDom(['ical-parser.js', 'core.js'], {
    chrome: {
      storage: {
        local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() },
        onChanged: { addListener() {}, removeListener() {} },
      },
      runtime: { sendMessage: (m, cb) => cb && cb({ success: true, notModified: true }) },
    },
  });
  env.window.OmniTime.openModal({ apiClient: api, context: { ...context }, activeTab: tab, settings: { dayStart: 8, dayEnd: 17 } });
  await settle();
  return { ...env, root: uiRoot(env.document), api };
}

describe('tab race', () => {
  it('a late "This issue" response does not overwrite My day', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    const { root } = await open({ api: fakeApi({ issueTime: () => late }) });
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle();
    assert.ok(root.querySelector('.omnitime-myday'));
    release(ISSUE_DATA());
    await settle();
    assert.ok(root.querySelector('.omnitime-myday'), 'My day is still shown');
    assert.equal(root.querySelector('.omnitime-issue'), null);
    assert.equal(root.querySelector('.omnitime-total-row'), null);
  });

  it('a late failure does not overwrite My day either', async () => {
    let fail;
    const late = new Promise((_, rej) => { fail = rej; });
    const { root } = await open({ api: fakeApi({ issueTime: () => late }) });
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle();
    fail(err(500));
    await settle();
    assert.ok(root.querySelector('.omnitime-myday'));
    assert.equal(root.querySelector('.omnitime-errbox'), null);
  });
});

describe('no issue context', () => {
  it('shows My day only, without tabs, titled "My day"', async () => {
    const { root } = await open({ context: {}, tab: 'issue' });
    assert.equal(root.querySelector('.omnitime-tabs'), null);
    assert.ok(root.querySelector('.omnitime-myday'));
    assert.equal(root.querySelector('.omnitime-title').textContent, 'My day');
  });

  it('never asks the API for issue time', async () => {
    let asked = 0;
    await open({ context: {}, api: fakeApi({ issueTime: () => { asked++; return Promise.resolve({}); } }) });
    assert.equal(asked, 0);
  });

  it('keeps both tabs when an issue is known', async () => {
    const { root } = await open();
    assert.equal(root.querySelectorAll('.omnitime-tab').length, 2);
  });
});

describe('issue header', () => {
  it('shows number and title, no closed badge for an open issue', async () => {
    const { root } = await open({ api: fakeApi({ issueTime: () => Promise.resolve(ISSUE_DATA({ issue: { open: true, external_id: '14', title: 'Fix login' } })) }) });
    assert.equal(root.querySelector('.omnitime-issuehead__title').textContent, '#14 Fix login');
    assert.equal(root.querySelector('.omnitime-issuehead__badge'), null);
  });

  it('falls back to the context label and does not double the number', async () => {
    const { root } = await open({ context: { ...CTX, issue_label: 'Fix login (#14)' } });
    assert.equal(root.querySelector('.omnitime-issuehead__title').textContent, 'Fix login (#14)');
  });

  it('flags a closed issue and hides the track button', async () => {
    const { root } = await open({ api: fakeApi({ issueTime: () => Promise.resolve(ISSUE_DATA({ issue: { open: false } })) }) });
    assert.equal(root.querySelector('.omnitime-issuehead__badge').textContent, 'Closed');
    assert.equal(root.querySelector('.omnitime-issuehead__track'), null);
  });
});

describe('detailed logs', () => {
  it('groups rows by local day (newest first) with day subtotals', async () => {
    const { root } = await open();
    const days = [...root.querySelectorAll('.omnitime-logday')];
    assert.equal(days.length, 2);
    const heads = days.map((d) => [...d.querySelectorAll('.omnitime-logday__head th')].map((t) => t.textContent));
    const label = (y, m, d) => new Date(y, m, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    assert.deepEqual(heads[0].slice(0, 3), [label(2026, 9, 22), '1:30', '']);
    assert.deepEqual(heads[1].slice(0, 3), [label(2026, 9, 21), '0:45', '']);
    // 13:00 (newer) before 08:30 within the day.
    assert.deepEqual([...days[0].querySelectorAll('tr:not(.omnitime-logday__head)')].map((r) => r.children[1].textContent), ['Sam', 'Alex']);
  });

  it('shows local, friendly times and keeps the per-user totals table', async () => {
    const { root } = await open();
    const first = root.querySelectorAll('.omnitime-logday')[0].querySelectorAll('tr:not(.omnitime-logday__head)')[1];
    const t = new Date(2026, 9, 22, 8, 30);
    assert.equal(first.children[0].textContent, '08:30');
    const dayLabel = t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    assert.equal(first.children[0].title, `${dayLabel} · 08:30`);
    assert.equal(first.children[3].textContent, 'Review');
    const summary = root.querySelector('.omnitime-table:not(.omnitime-details-table)');
    assert.match(summary.textContent, /Alex/);
    assert.match(summary.querySelector('.omnitime-total-row').textContent, /2:15/);
  });

  it('tolerates an unparsable start time', async () => {
    const api = fakeApi({ issueTime: () => Promise.resolve(ISSUE_DATA({ details: [{ user: 'X', start_time: 'n/a', time_spent: 5 }] })) });
    const { root, errors } = await open({ api });
    assert.match(root.querySelector('.omnitime-logday__head').textContent, /Unknown date/);
    assert.deepEqual(errors, []);
  });
});

describe('own row in the per-user table', () => {
  const rowsOf = (root) => [...root.querySelectorAll('.omnitime-table:not(.omnitime-details-table) tbody tr:not(.omnitime-total-row)')].map((r) => r.children[0].textContent);
  const api = (tracked) => fakeApi({ issueTime: () => Promise.resolve(ISSUE_DATA({ tracked_time: tracked })) });

  it('labels the caller\'s row "<Name> (you)" when self is true, and nothing else', async () => {
    const { root } = await open({ api: api([
      { user: 'Alex', time_spent: 105, self: true },
      { user: 'Sam', time_spent: 30, self: false },
      { user: 'Others', time_spent: 20, self: false, others: true },
    ]) });
    assert.deepEqual(rowsOf(root), ['Alex (you)', 'Sam', 'Others']);
  });

  it('adds no label on servers without the self flag, and escapes names', async () => {
    const { root } = await open({ api: api([{ user: 'Alex', time_spent: 105 }, { user: '<b>Sam</b>', time_spent: 30, self: true }]) });
    assert.deepEqual(rowsOf(root), ['Alex', '<b>Sam</b> (you)']);
    assert.equal(root.querySelector('.omnitime-table b'), null);
  });
});

describe('Track time on this issue', () => {
  it('switches to My day and opens the add form for the current issue', async () => {
    const { root } = await open();
    root.querySelector('.omnitime-issuehead__track').click();
    await settle(60);
    assert.equal(root.querySelector('.omnitime-tab--active').dataset.tab, 'myday');
    assert.ok(root.querySelector('.omnitime-myday__cols--form-open'));
    assert.match(root.querySelector('.omnitime-target__label').textContent, /Fix login/);
  });

  it('opens the form only once (not again on day changes)', async () => {
    const { root } = await open();
    root.querySelector('.omnitime-issuehead__track').click();
    await settle(60);
    root.querySelector('.omnitime-form__close').click();
    root.querySelector('[data-nav="prev"]').click();
    await settle(60);
    assert.equal(root.querySelector('.omnitime-myday__cols--form-open'), null);
  });

  it('is not offered on servers without the new API', async () => {
    const api = fakeApi({ myDay: () => Promise.reject(err(404)) });
    const { root } = await open({ api });
    assert.equal(root.querySelector('.omnitime-issuehead__track'), null);
  });
});

describe('renderError', () => {
  const render = (e, opts) => {
    const { window } = loadDom(['core.js']);
    const box = window.document.createElement('div');
    window.OmniTime.renderError(box, e, opts);
    return box;
  };
  const text = (box) => box.querySelector('.omnitime-errbox__msg').textContent;

  it('picks a human message by cause', () => {
    assert.match(text(render(err(undefined, 'Failed to fetch'))), /^Can't reach 1x TIMES\. Check your connection or the API URL in settings\.$/);
    assert.match(text(render(err(0))), /Can't reach 1x TIMES/);
    for (const s of [401, 403]) assert.match(text(render(err(s))), /not signed in, or this account isn't allowed\. Open the extension settings to sign in\./);
    for (const s of [404, 501]) assert.equal(text(render(err(s))), "This 1x TIMES server doesn't support this yet.");
    assert.equal(text(render(err(400))), 'The request was incomplete.');
    for (const s of [500, 502, 503]) assert.equal(text(render(err(s))), '1x TIMES had a problem. Try again in a moment.');
  });

  it('shows the title, status and collapsed technical details', () => {
    const box = render(err(500, 'Server said no'), { title: 'Could not load' });
    assert.equal(box.querySelector('.omnitime-errbox__title').textContent, 'Could not load');
    const details = box.querySelector('details');
    assert.equal(details.open, false);
    assert.equal(details.querySelector('summary').textContent, 'Technical details');
    assert.match(details.textContent, /Status: 500/);
    assert.match(details.textContent, /Server said no/);
    assert.equal(box.firstElementChild.getAttribute('role'), 'alert');
  });

  it('strips tags, cuts stack traces and caps the length', () => {
    const html = '<html><body><h1>Error</h1><script>evil()</script>The website <b>encountered</b> an error.\n#0 /var/www/core/lib/Foo.php(12): bar()\n#1 {main}</body></html>';
    const tech = render(err(500, html)).querySelector('.omnitime-errbox__tech').textContent;
    assert.match(tech, /Error The website encountered an error\.$/);
    assert.doesNotMatch(tech, /<|evil|Foo\.php|#0/);
    const long = render(err(500, 'x'.repeat(1000))).querySelector('.omnitime-errbox__tech').textContent;
    assert.ok(long.length < 330);
    const trace = render(err(500, 'Oops. Stack trace: at foo()')).querySelector('.omnitime-errbox__tech').textContent;
    assert.doesNotMatch(trace, /Stack|foo/);
  });

  it('escapes the message and renders Retry only when asked', () => {
    const box = render(err(400, '<img src=x onerror=1>&"'));
    assert.equal(box.querySelector('img'), null);
    assert.equal(box.querySelector('.omnitime-errbox__retry'), null);
    let n = 0;
    const withRetry = render(err(500), { retry: () => { n++; } });
    withRetry.querySelector('.omnitime-errbox__retry').click();
    assert.equal(n, 1);
  });
});

describe('error states in the tabs', () => {
  it('"This issue" shows the friendly error and Retry reloads', async () => {
    let n = 0;
    const api = fakeApi({ issueTime: () => (++n === 1 ? Promise.reject(err(500, 'x')) : Promise.resolve(ISSUE_DATA())) });
    const { root } = await open({ api });
    assert.match(root.querySelector('.omnitime-errbox__msg').textContent, /had a problem/);
    root.querySelector('.omnitime-errbox__retry').click();
    await settle();
    assert.equal(root.querySelector('.omnitime-errbox'), null);
    assert.ok(root.querySelector('.omnitime-total-row'));
  });

  it('My day shows the friendly error and Retry recovers; "unavailable" is unchanged', async () => {
    let n = 0;
    const base = fakeApi();
    const api = fakeApi({ myDay: (d) => (++n === 1 ? Promise.reject(err(503)) : base.myDay(d)) });
    // The first day load fails (no issue context, so no capability probe), then recovers.
    const { root } = await open({ api, context: {} });
    assert.match(root.querySelector('.omnitime-errbox__msg').textContent, /had a problem/);
    root.querySelector('.omnitime-errbox__retry').click();
    await settle();
    assert.ok(root.querySelector('.omnitime-tl'));

    const gone = await open({ api: fakeApi({ myDay: () => Promise.reject(err(404)) }), context: {} });
    assert.match(gone.root.querySelector('.omnitime-unavailable').textContent, /isn't available on this server yet/);
  });
});
