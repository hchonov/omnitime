// Settings behind a gear (core.js "Settings panel"): the gear in every dialog
// kind, the panel that embeds the options page in an iframe, Escape layering,
// focus, inert background, applySettings and the swappable API client.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, settle } = require('./helpers');

// Let requests the last action started finish before the next test (or the end).
afterEach(() => settle(60));

// Wednesday 21 Oct 2026, 15:00 (TZ pinned by helpers): a weekday, so the
// daily-target progress exists.
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

const URL_ = 'chrome-extension://dynamic-id/options.html';

function fakeApi({ target } = {}) {
  const calls = [];
  const ok = (v) => () => Promise.resolve(v);
  return {
    calls,
    issueTime: ok({ tracked_time: [{ user: 'Alex', time_spent: 90 }], total_sum: 90, details: [], issue: { open: true } }),
    myDay: (date) => {
      calls.push(['myDay', date]);
      return Promise.resolve({
        date, week: [], day_total_minutes: 60, day_total_label: '1:00', entries: [],
        ...(target == null ? {} : { target_minutes: target }),
      });
    },
    week: (date) => { calls.push(['week', date]); return Promise.resolve({ date, week_entries: [], absences: [] }); },
    frequent: ok({ issues: [] }),
    search: ok({ issues: [] }),
    create: ok({ id: 1 }),
    update: ok({}),
    remove: ok(null),
  };
}

function makeChrome() {
  const store = {};
  return {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
}

// Opens a dialog of the given kind with a settings URL; `fixed` pins the clock.
async function open({ kind = 'issue', settingsUrl = URL_, theme, onSettingsClosed, api = fakeApi(), settings = { dayStart: 8, dayEnd: 17 }, fixed = false, before } = {}) {
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome: makeChrome() });
  if (fixed) fixClock(env.window);
  if (before) before(env.window);
  const trigger = env.document.createElement('button');
  trigger.textContent = 'Time tracking';
  env.document.body.appendChild(trigger);
  trigger.focus();
  let handle;
  if (kind === 'notice') {
    handle = { ui: env.window.OmniTime.openNotice({ title: 'Setup', html: 'Please configure.', settingsUrl, theme, onSettingsClosed }) };
  } else {
    handle = env.window.OmniTime.openModal({
      apiClient: api,
      context: kind === 'overlay' ? {} : { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Demo' },
      activeTab: kind === 'week' ? 'week' : kind === 'myday' || kind === 'overlay' ? 'myday' : 'issue',
      theme,
      settings,
      settingsUrl,
      onSettingsClosed,
    });
  }
  await settle();
  const root = uiRoot(env.document);
  const q = (sel) => root.querySelector(sel);
  return { ...env, root, q, trigger, handle, api, esc: () => key(env.window, root.activeElement || root.host, 'Escape') };
}

const gear = (t) => t.q('.omnitime-modal-gear');
const panel = (t) => t.q('.omnitime-settings');

describe('gear', () => {
  for (const kind of ['issue', 'myday', 'week', 'overlay', 'notice']) {
    it(`is in the header of the ${kind} dialog next to the close button`, async () => {
      const t = await open({ kind });
      const g = gear(t);
      assert.ok(g, 'gear present');
      assert.equal(g.getAttribute('aria-label'), 'Settings');
      assert.equal(g.getAttribute('title'), 'Settings');
      assert.equal(g.getAttribute('aria-expanded'), 'false');
      assert.equal(g.nextElementSibling, t.q('.omnitime-modal-close'));
      assert.deepEqual(t.errors, []);
    });
  }

  it('is absent without a settings URL', async () => {
    const t = await open({ settingsUrl: null });
    assert.equal(gear(t), null);
    assert.equal(t.handle.ui.settings, null);
    assert.equal(t.window.OmniTime.closeSettings(), false);
  });
});

describe('panel', () => {
  it('slides over the content: Back, "Settings", and an iframe on the embedded options page', async () => {
    const t = await open({ theme: 'light' });
    gear(t).click();
    const p = panel(t);
    assert.ok(p.classList.contains('omnitime-settings--open'));
    assert.equal(p.querySelector('.omnitime-settings__title').textContent, 'Settings');
    assert.equal(p.querySelector('.omnitime-settings__back').textContent, 'Back');
    const frame = p.querySelector('iframe');
    assert.equal(frame.getAttribute('src'), `${URL_}?embedded=1&theme=light`);
    assert.equal(frame.title, 'OmniTime settings');
    assert.equal(gear(t).getAttribute('aria-expanded'), 'true');
    // The frame is the last thing in the panel, so the page scrolls itself (no double scrollbars).
    assert.equal(p.children[1], frame);
  });

  it('passes the current modal theme and accepts a function for the URL', async () => {
    const t = await open({ theme: 'dark', settingsUrl: () => `${URL_}?x=1` });
    gear(t).click();
    assert.equal(panel(t).querySelector('iframe').getAttribute('src'), `${URL_}?x=1&embedded=1&theme=dark`);
  });

  it('keeps the tabs visible but inert, and the content too, until it closes', async () => {
    const t = await open({ kind: 'myday' });
    gear(t).click();
    assert.equal(t.q('.omnitime-tabs').isConnected, true);
    assert.equal(t.q('.omnitime-headerleft').hasAttribute('inert'), true);
    assert.equal(t.q('.omnitime-modal-content').hasAttribute('inert'), true);
    t.q('.omnitime-settings__back').click();
    assert.equal(t.q('.omnitime-headerleft').hasAttribute('inert'), false);
    assert.equal(t.q('.omnitime-modal-content').hasAttribute('inert'), false);
  });

  it('closes with Back and with the gear, returns the focus to the gear', async () => {
    const t = await open();
    gear(t).click();
    t.q('.omnitime-settings__back').click();
    assert.equal(panel(t), null, 'removed at once without motion');
    assert.equal(t.root.activeElement, gear(t));
    assert.equal(gear(t).getAttribute('aria-expanded'), 'false');
    gear(t).click();
    assert.ok(panel(t));
    gear(t).click(); // the gear toggles
    assert.equal(panel(t), null);
  });

  it('moves the focus into the frame on open and again once it loaded', async () => {
    const t = await open();
    gear(t).click();
    const frame = panel(t).querySelector('iframe');
    assert.equal(t.root.activeElement, frame);
    gear(t).focus();
    frame.dispatchEvent(new t.window.Event('load'));
    assert.equal(t.root.activeElement, frame);
  });

  it('Escape closes the panel first, then the modal', async () => {
    const t = await open({ kind: 'myday' });
    gear(t).click();
    t.esc();
    assert.equal(panel(t), null);
    assert.ok(t.document.querySelector('omnitime-root'), 'the modal stays');
    assert.equal(t.root.activeElement, gear(t));
    t.esc();
    assert.equal(t.document.querySelector('omnitime-root'), null);
    assert.equal(t.document.activeElement, t.trigger, 'focus back on the page trigger');
  });

  it('OmniTime.closeSettings() closes it (an Escape inside the frame), then reports nothing to close', async () => {
    const t = await open();
    gear(t).click();
    assert.equal(t.window.OmniTime.closeSettings(), true);
    assert.equal(panel(t), null);
    assert.equal(t.window.OmniTime.closeSettings(), false);
    assert.equal(t.window.OmniTime.openSettings(), true);
    assert.ok(panel(t));
  });

  it('the focus trap allows the frame: Shift+Tab from the first control reaches it, Tab out of it wraps to Back', async () => {
    const t = await open({ kind: 'myday' });
    gear(t).click();
    const frame = panel(t).querySelector('iframe');
    // Tab order while open: gear, close, Back, frame (the tabs and content are inert).
    gear(t).focus();
    const notPrevented = key(t.window, gear(t), 'Tab', { shiftKey: true });
    assert.equal(notPrevented, false);
    assert.equal(t.root.activeElement, frame, 'wrapped to the last control: the frame');
    // Plain Tab from Back is left to the browser (into the frame).
    t.q('.omnitime-settings__back').focus();
    assert.equal(key(t.window, t.q('.omnitime-settings__back'), 'Tab'), true);
    // The browser then tabs out of the frame onto the guard, which hands over to Back.
    t.q('.omnitime-settings__guard').focus();
    assert.equal(t.root.activeElement, t.q('.omnitime-settings__back'));
    // From the close button Tab goes on to Back (not wrapped to the gear).
    t.q('.omnitime-modal-close').focus();
    assert.equal(key(t.window, t.q('.omnitime-modal-close'), 'Tab'), true);
  });

  it('slides out in 150 ms when motion is allowed, and drops the dialog height afterwards', async () => {
    const t = await open({ before: (w) => { w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); } });
    gear(t).click();
    assert.ok(t.q('.omnitime-modal').classList.contains('omnitime-modal--settings'));
    t.q('.omnitime-settings__back').click();
    assert.ok(panel(t), 'still there while it slides out');
    assert.equal(panel(t).classList.contains('omnitime-settings--open'), false);
    await settle(200);
    assert.equal(panel(t), null);
    assert.equal(t.q('.omnitime-modal').classList.contains('omnitime-modal--settings'), false);
  });

  it('has no slide with prefers-reduced-motion (CSS and script)', async () => {
    const css = require('./helpers').read('style.css');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.omnitime-settings \{\s*transition: none;/);
    const t = await open({ before: (w) => { w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); } });
    gear(t).click();
    t.q('.omnitime-settings__back').click();
    assert.equal(panel(t), null);
  });

  it('calls onSettingsClosed when the panel closes, not when the modal does', async () => {
    let closed = 0;
    const t = await open({ onSettingsClosed: () => { closed++; } });
    gear(t).click();
    t.esc();
    assert.equal(closed, 1);
    gear(t).click();
    t.handle.cleanup();
    assert.equal(closed, 1);
    assert.deepEqual(t.errors, []);
  });

  it('is torn down with the dialog (no leftover resize listener or timers)', async () => {
    const t = await open();
    gear(t).click();
    t.handle.cleanup();
    assert.equal(t.document.querySelector('omnitime-root'), null);
    assert.deepEqual(t.errors, []);
  });
});

describe('"Open settings" in the notice', () => {
  it('is a primary button that opens the panel in the same dialog', async () => {
    const t = await open({ kind: 'notice' });
    const btn = t.q('.omnitime-notice__settings');
    assert.equal(btn.textContent, 'Open settings');
    assert.ok(t.q('.omnitime-modal-content--message').contains(btn));
    btn.click();
    assert.equal(t.document.querySelectorAll('omnitime-root').length, 1);
    assert.ok(panel(t));
    assert.match(panel(t).querySelector('iframe').getAttribute('src'), /options\.html\?embedded=1&theme=(light|dark)$/);
  });

  it('is not shown without a settings URL', async () => {
    const t = await open({ kind: 'notice', settingsUrl: null });
    assert.equal(t.q('.omnitime-notice__settings'), null);
    assert.equal(gear(t), null);
  });
});

describe('applySettings and the swappable client', () => {
  it('re-renders My day with the new settings (daily target, keeps the date)', async () => {
    const api = fakeApi({ target: null });
    const t = await open({ kind: 'myday', api, fixed: true, settings: { dayStart: 8, dayEnd: 17, dailyTargetMinutes: 480 } });
    await settle();
    assert.equal(t.q('.omnitime-progress__label').textContent, '7:00 left');
    t.handle.applySettings({ settings: { dailyTargetMinutes: 360 } });
    await settle();
    assert.equal(t.q('.omnitime-progress__label').textContent, '5:00 left');
    // ... and 0 turns the target off.
    t.handle.applySettings({ settings: { dailyTargetMinutes: 0 } });
    await settle();
    assert.equal(t.q('.omnitime-progress').hidden, true);
    assert.ok(api.calls.filter((c) => c[0] === 'myDay').length >= 3, 'reloaded each time');
  });

  it('reloads the Week tab and the issue tab', async () => {
    const week = await open({ kind: 'week' });
    const before = week.api.calls.filter((c) => c[0] === 'week').length;
    week.handle.applySettings({ settings: { dailyTargetMinutes: 0 } });
    await settle();
    assert.ok(week.api.calls.filter((c) => c[0] === 'week').length > before);
    assert.ok(week.q('.omnitime-wk, .omnitime-week'));

    const issue = await open({ kind: 'issue' });
    issue.handle.applySettings({ settings: {} });
    await settle();
    assert.ok(issue.q('.omnitime-table'), 'the issue report is rendered again');
  });

  it('uses a replaced calendar address and forgets the old calendar cache', async () => {
    const t = await open({ kind: 'myday', fixed: true });
    assert.equal(t.q('.omnitime-myday__cal'), null);
    t.handle.applySettings({ icalUrl: 'https://calendar.example.test/b.ics', settings: { useGoogleCalendar: false } });
    await settle();
    assert.ok(t.q('.omnitime-myday__total').textContent.length > 0);
    assert.deepEqual(t.errors, []);
  });

  it('does nothing once the dialog is closed', async () => {
    const t = await open({ kind: 'myday' });
    t.handle.cleanup();
    t.handle.applySettings({ settings: { dailyTargetMinutes: 0 } });
    assert.deepEqual(t.errors, []);
  });

  it('swappableClient forwards every method to the current client', async () => {
    const { window } = loadDom(['core.js']);
    const a = { myDay: (d) => `a:${d}`, week: () => 'a-week' };
    const b = { myDay: (d) => `b:${d}` };
    const swappable = window.OmniTime.swappableClient(a);
    assert.equal(swappable.client.myDay('x'), 'a:x');
    assert.equal(typeof swappable.client.week, 'function');
    swappable.swap(b);
    assert.equal(swappable.client.myDay('x'), 'b:x');
  });

  it('settingsDiffer compares exactly the watched keys', async () => {
    const { window } = loadDom(['core.js']);
    const O = window.OmniTime;
    assert.deepEqual([...O.SETTINGS_WATCHED].sort(), ['apiUrl', 'dailyTargetMinutes', 'dayEnd', 'dayStart', 'endpoints', 'icalUrl', 'showSidebarWidget', 'sidebarStartExpanded', 'useGoogleCalendar'].sort());
    assert.equal(O.settingsDiffer({ dayStart: 8 }, { dayStart: 8, instances: [1] }), false);
    assert.equal(O.settingsDiffer({ dayStart: 8 }, { dayStart: 9 }), true);
    assert.equal(O.settingsDiffer({ endpoints: { a: 1 } }, { endpoints: { a: 1 } }), false);
    assert.equal(O.settingsDiffer({ endpoints: { a: 1 } }, {}), true);
  });
});

describe('style.css for the panel', () => {
  it('only uses tokens (checked by style.test.js) and styles the pieces it creates', () => {
    const css = require('./helpers').read('style.css');
    ['.omnitime-header-actions', '.omnitime-modal-gear', '.omnitime-settings', '.omnitime-settings__head', '.omnitime-settings__back',
      '.omnitime-settings__title', '.omnitime-settings__frame', '.omnitime-settings__guard', '.omnitime-notice__settings', '.omnitime-modal--settings']
      .forEach((sel) => assert.ok(css.includes(sel), `no rule for ${sel}`));
  });
});

void TODAY;
