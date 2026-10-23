// Modal foundation: shadow-DOM mounting, dialog accessibility, Escape
// layering and theming (core.js openShell / openModal / openNotice).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, pointer, settle, icsStamp } = require('./helpers');

const ENTRY = {
  id: 7, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30',
  project: 'Internal', issue_label: 'Internal / Standup', issue_external_id: '12',
  issue_internal_id: 1200, comment: '', status: 'unbooked', editable: true,
};
const BOOKED = {
  ...ENTRY, id: 8, start: '11:00', stop: '13:00', duration_minutes: 120, duration_label: '2:00', editable: false, status: 'booked',
};
const SHORT = {
  ...ENTRY, id: 9, start: '13:30', stop: '14:30', duration_minutes: 60, duration_label: '1:00',
};

function fakeApi({ entries = [ENTRY], searchIssues = [{ issue_internal_id: 55, issue_external_id: '5', label: 'Sync', project: 'P' }] } = {}) {
  const ok = (v) => () => Promise.resolve(v);
  return {
    issueTime: ok({ tracked_time: [{ user: 'Alex', time_spent: 90 }], total_sum: 90, details: [], issue: { open: true } }),
    myDay: (date) => Promise.resolve({
      date,
      week: [{ label: 'M', date, total_minutes: 30, total_label: '0:30', active: true }],
      week_total_label: '0:30',
      day_total_label: '0:30',
      entries,
    }),
    frequent: ok({ issues: [{ issue_internal_id: 1, issue_external_id: '1', label: 'Daily', project: 'P', suggested_minutes: 15, suggested_label: '0:15' }] }),
    search: ok({ issues: searchIssues }),
    create: ok({ id: 1 }),
    update: ok({}),
    remove: ok(null),
  };
}

// One calendar event today 15:00-16:00 so popovers can be exercised.
function icsToday() {
  const d = new Date();
  return ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:ev-1', 'SUMMARY:Planning', `DTSTART:${icsStamp(d, 15, 0)}`, `DTEND:${icsStamp(d, 16, 0)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function makeChrome() {
  const store = { icalRaw: icsToday() };
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

// Open the modal from a focused page button (the trigger focus must come back).
async function open({ tab = 'issue', entries, theme, styles = true, before } = {}) {
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome: makeChrome(), styles });
  if (before) before(env.window);
  const trigger = env.document.createElement('button');
  trigger.textContent = 'Time tracking';
  env.document.body.appendChild(trigger);
  trigger.focus();
  const handle = env.window.OmniTime.openModal({
    apiClient: fakeApi({ entries }),
    context: { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Demo' },
    icalUrl: 'https://calendar.example.test/basic.ics',
    activeTab: tab,
    theme,
    settings: { dayStart: 8, dayEnd: 17 },
  });
  await settle();
  const root = uiRoot(env.document);
  return { ...env, root, trigger, handle, esc: () => key(env.window, root.activeElement || root.host, 'Escape') };
}

const formOpen = (root) => root.querySelector('.omnitime-myday__cols').classList.contains('omnitime-myday__cols--form-open');

describe('mounting', () => {
  it('renders inside a shadow root on a single <omnitime-root> host (open when the dev flag is set)', async () => {
    const { document, root, errors } = await open();
    const hosts = document.querySelectorAll('omnitime-root');
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].parentNode, document.body);
    assert.equal(hosts[0].shadowRoot.mode, 'open');
    assert.ok(root.querySelector('.omnitime-root > .omnitime-modal-overlay > .omnitime-modal'));
    // Nothing of ours in the page's own DOM.
    assert.equal(document.querySelector('[class*="omnitime"]'), null);
    assert.deepEqual(errors, []);
  });

  it('carries the stylesheet inside the shadow root', async () => {
    const { root } = await open();
    const css = (root.adoptedStyleSheets || []).map((s) => [...s.cssRules].map((r) => r.cssText).join('\n')).join('\n')
      + [...root.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    assert.match(css, /:host/);
    assert.match(css, /\.omnitime-modal/);
  });

  it('falls back to a <style> element where constructable sheets fail', async () => {
    const { root } = await open({ before: (w) => { w.CSSStyleSheet = function () { throw new Error('not here'); }; } });
    assert.match(root.querySelector('style').textContent, /\.omnitime-modal-overlay/);
  });

  it('replaces the open dialog on re-open and removes the host on close', async () => {
    const { window, document, root } = await open();
    window.OmniTime.openModal({ apiClient: fakeApi(), context: {} });
    assert.equal(document.querySelectorAll('omnitime-root').length, 1);
    assert.notEqual(uiRoot(document), root);
    assert.equal(window.OmniTime.getRoot(), uiRoot(document));
    window.OmniTime.close();
    assert.equal(document.querySelectorAll('omnitime-root').length, 0);
    assert.equal(window.OmniTime.isOpen(), false);
  });

  it('opens a notice in the same shell (overlay "not configured" message)', async () => {
    const { window, document } = loadDom(['core.js']);
    window.OmniTime.openNotice({ title: 'Setup needed', html: 'Please configure your <strong>API URL</strong>.' });
    const root = uiRoot(document);
    assert.equal(root.querySelector('[role="dialog"] .omnitime-title').textContent, 'Setup needed');
    assert.equal(root.querySelector('.omnitime-modal-content--message strong').textContent, 'API URL');
    key(window, root.activeElement, 'Escape');
    assert.equal(document.querySelector('omnitime-root'), null);
  });
});

describe('dialog accessibility', () => {
  it('is a labelled modal dialog that takes focus and gives it back', async () => {
    const { document, root, trigger, handle } = await open();
    const dialog = root.querySelector('.omnitime-modal');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(root.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Time tracking');
    assert.equal(root.activeElement, dialog);
    handle.cleanup();
    assert.equal(document.activeElement, trigger);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const { window, root } = await open();
    const focusables = [...root.querySelectorAll('.omnitime-modal button, .omnitime-modal summary')].filter((el) => el.tabIndex >= 0);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    assert.equal(key(window, last, 'Tab'), false, 'Tab on the last element is handled');
    assert.equal(root.activeElement, first);
    assert.equal(key(window, first, 'Tab', { shiftKey: true }), false);
    assert.equal(root.activeElement, last);
    // In the middle the browser moves focus normally.
    first.focus();
    assert.equal(key(window, first, 'Tab'), true);
  });

  it('exposes the views as tabs with arrow-key navigation', async () => {
    const { window, root } = await open();
    const tablist = root.querySelector('[role="tablist"]');
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabs.map((t) => [t.dataset.tab, t.getAttribute('aria-selected'), t.tabIndex]), [['issue', 'true', 0], ['myday', 'false', -1]]);
    const panel = root.querySelector('[role="tabpanel"]');
    assert.equal(panel.getAttribute('aria-labelledby'), 'omnitime-tab-issue');
    assert.equal(tabs[0].getAttribute('aria-controls'), panel.id);
    // The title stays as the dialog's (visually hidden) name.
    assert.ok(root.querySelector('.omnitime-title').classList.contains('ot-visually-hidden'));

    tabs[0].focus();
    key(window, tabs[0], 'ArrowRight');
    await settle();
    assert.equal(root.activeElement, tabs[1]);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(panel.getAttribute('aria-labelledby'), 'omnitime-tab-myday');
    assert.ok(root.querySelector('.omnitime-tl'), 'My day rendered');
    key(window, tabs[1], 'ArrowRight'); // wraps around
    await settle();
    assert.equal(root.activeElement, tabs[0]);
    assert.ok(root.querySelector('.omnitime-table'));
  });

  it('gives every button an accessible name', async () => {
    const { root } = await open({ tab: 'myday' });
    root.querySelector('.omnitime-add-btn').click();
    const unnamed = [...root.querySelectorAll('button')]
      .filter((b) => !b.textContent.trim() && !(b.getAttribute('aria-label') || '').trim())
      .map((b) => b.className);
    assert.deepEqual(unnamed, []);
    ['.omnitime-search__input', '.omnitime-f-comment'].forEach((sel) => assert.ok(root.querySelector(sel).getAttribute('aria-label'), sel));
  });
});

describe('Escape layering', () => {
  it('closes an open form first, then the modal', async () => {
    const { document, root, esc } = await open({ tab: 'myday' });
    root.querySelector('.omnitime-add-btn').click();
    assert.ok(formOpen(root));
    esc();
    assert.equal(formOpen(root), false, 'form closed');
    assert.ok(document.querySelector('omnitime-root'), 'modal still open');
    assert.equal(root.querySelector('.omnitime-tl__sel'), null, 'selection cleared');
    esc();
    assert.equal(document.querySelector('omnitime-root'), null);
  });

  it('closes search results before the form', async () => {
    const { window, root, esc } = await open({ tab: 'myday' });
    root.querySelector('.omnitime-add-btn').click();
    const input = root.querySelector('.omnitime-search__input');
    input.value = 'sync';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(300); // debounced search
    const results = root.querySelector('.omnitime-search__results');
    assert.equal(results.hidden, false);
    input.focus();
    esc();
    assert.equal(results.hidden, true);
    assert.ok(formOpen(root), 'form stays open');
  });

  it('closes a calendar popover before anything else', async () => {
    const { window, root, esc } = await open({ tab: 'myday' });
    root.querySelector('.omnitime-add-btn').click();
    const block = root.querySelector('.omnitime-tl__cal-event');
    // The popover only shows without an active selection.
    root.querySelector('.omnitime-form__close').click();
    block.dispatchEvent(new window.MouseEvent('mouseenter'));
    const popover = root.querySelector('.omnitime-root > .omnitime-tl__cal-popover');
    assert.ok(popover, 'popover mounted in the shadow root');
    esc();
    assert.equal(root.querySelector('.omnitime-tl__cal-popover'), null);
    assert.ok(root.host.isConnected, 'modal still open');
  });

  it('drops the layer of a form that a re-render replaced', async () => {
    const { document, root, esc } = await open({ tab: 'myday' });
    root.querySelector('.omnitime-add-btn').click();
    root.querySelector('[data-nav="next"]').click(); // reloads the day, form gone
    await settle();
    assert.equal(formOpen(root), false);
    esc();
    assert.equal(document.querySelector('omnitime-root'), null, 'one Escape closes the modal');
  });

  it('keeps Escape away from the page while the modal is open', async () => {
    const { document, esc } = await open();
    let pageSaw = 0;
    document.addEventListener('keydown', () => { pageSaw++; });
    esc();
    assert.equal(pageSaw, 0);
  });
});

describe('theme', () => {
  const theme = (document) => document.querySelector('omnitime-root').getAttribute('data-theme');

  it('defaults to light and honours an explicit theme', async () => {
    assert.equal(theme((await open()).document), 'light');
    assert.equal(theme((await open({ theme: 'dark' })).document), 'dark');
  });

  it('follows prefers-color-scheme in auto mode', async () => {
    const { document } = await open({
      before: (w) => { w.matchMedia = (q) => ({ media: q, matches: q.includes('dark'), addEventListener() {}, removeEventListener() {} }); },
    });
    assert.equal(theme(document), 'dark');
  });

  it('re-evaluates a theme function when the page switches theme', async () => {
    let gl = 'light';
    const { document } = await open({ theme: () => gl });
    assert.equal(theme(document), 'light');
    gl = 'dark';
    document.documentElement.className = 'gl-dark';
    await settle();
    assert.equal(theme(document), 'dark');
  });
});

describe('presentational styles', () => {
  // Only dynamic geometry may be set inline; everything else is in style.css.
  const GEOMETRY = new Set(['top', 'height', 'left', 'right', 'width']);

  it('keeps only geometry inline across entries, events, selection and form', async () => {
    const { window, root } = await open({ tab: 'myday', entries: [ENTRY, BOOKED, SHORT] });
    root.querySelector('.omnitime-add-btn').click();
    const ghostTarget = root.querySelector('.omnitime-tl');
    pointer(window, ghostTarget, 'pointermove', 900);
    const offenders = [...root.querySelectorAll('[style]')].flatMap((el) => [...Array(el.style.length)].map((_, i) => el.style[i])
      .filter((prop) => !GEOMETRY.has(prop))
      .map((prop) => `${el.className}: ${prop}`));
    assert.deepEqual(offenders, []);
    assert.ok(root.querySelector('.omnitime-tl__entry--short'));
    assert.ok(root.querySelector('.omnitime-tl__entry--compact'));
  });
});

describe('toolbar overlay (overlay-dashboard.js)', () => {
  // overlay-dashboard.js is re-injected on every toolbar click.
  function overlayEnv(sync) {
    const messages = [];
    const chrome = {
      runtime: {
        sendMessage: (msg, cb) => { messages.push(msg.action); cb(msg.action === 'OMNI_GET_STYLES' ? { success: true, css: ':host { --ot-bg: #fff; }' } : { success: true, data: {} }); },
      },
      storage: {
        sync: { get: (keys, cb) => cb(sync) },
        local: { get: (keys, cb) => cb({}) },
        onChanged: makeEvent(),
      },
    };
    const env = loadDom(['ical-parser.js', 'core.js'], { chrome, styles: false });
    const click = () => env.window.eval(require('./helpers').read('overlay-dashboard.js'));
    return { ...env, messages, click };
  }

  it('shows the "not configured" notice in the shadow root, styled via the worker', async () => {
    const { document, messages, click, window } = overlayEnv({});
    click();
    await settle();
    const root = uiRoot(document);
    assert.match(root.querySelector('.omnitime-modal-content--message').textContent, /configure your API URL/);
    assert.ok(root.querySelector('.omnitime-modal--dashboard[role="dialog"]'));
    assert.deepEqual(messages, ['OMNI_GET_STYLES']);
    assert.equal(window.OmniTime.hasStyles(), true);
  });

  it('toggles: a second click closes the open dialog', async () => {
    const { document, click } = overlayEnv({ apiUrl: 'https://times.example.test/api/v1/tracked-time', apiKey: 'KEY' });
    click();
    await settle();
    assert.ok(uiRoot(document).querySelector('.omnitime-myday'), 'opens on My day');
    click();
    assert.equal(document.querySelector('omnitime-root'), null);
  });
});
