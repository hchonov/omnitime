const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { read, makeEvent, settle } = require('./helpers');

// Mock chrome with in-memory storage (promise and callback styles).
function makeChrome({ sync = {}, local = {}, respond, granted = true, permissionError, contains } = {}) {
  const stores = { sync: { ...sync }, local: { ...local } };
  const onChanged = makeEvent();
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in stores[name]) out[k] = stores[name][k]; });
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (items, cb) => {
      const changes = {};
      Object.keys(items).forEach((k) => { changes[k] = { oldValue: stores[name][k], newValue: items[k] }; });
      Object.assign(stores[name], items);
      onChanged.fire(changes, name);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
  });
  const messages = [];
  const registered = [];
  const permissionRequests = [];
  const calls = { openOptionsPage: 0, tabs: [] };
  const runtime = {
    lastError: undefined,
    getManifest: () => ({ version: '9.9.9' }),
    getURL: (p) => `chrome-extension://omnitime-id/${p}`,
    openOptionsPage: () => { calls.openOptionsPage++; },
    sendMessage: (msg, cb) => { messages.push(msg); if (cb) cb(respond ? respond(msg) : undefined); },
  };
  return {
    stores, onChanged, messages, registered, permissionRequests, calls,
    chrome: {
      storage: { sync: area('sync'), local: area('local'), onChanged },
      runtime,
      tabs: { create: (o) => calls.tabs.push(o) },
      permissions: {
        contains: (o, cb) => cb(contains === undefined ? true : contains),
        request: (o, cb) => {
          permissionRequests.push(o);
          if (permissionError) runtime.lastError = { message: permissionError };
          cb(granted);
          runtime.lastError = undefined;
        },
      },
      scripting: {
        unregisterContentScripts: () => Promise.resolve(),
        registerContentScripts: (list) => { registered.push(list); return Promise.resolve(); },
      },
    },
  };
}

async function load(opts) {
  const mock = makeChrome(opts);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e));
  const html = read('options.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    virtualConsole: vc,
    url: (opts && opts.url) || 'chrome-extension://omnitime-id/options.html',
  });
  const { window } = dom;
  window.chrome = mock.chrome;
  window.alert = () => {};
  // The page's own DOMContentLoaded fires once, after this returns: wait for it
  // (dispatching one by hand as well would run the page's init twice).
  const ready = new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  window.eval(read('options.js'));
  if (window.document.readyState !== 'loading') window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  else await ready;
  await settle();
  return { ...mock, window, document: window.document, errors };
}

const $ = (ctx, id) => ctx.document.getElementById(id);
// Values built inside the jsdom window have that window's prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Type into a text field and leave it (what a user does: change + blur).
async function edit(ctx, id, value, how = 'change') {
  const el = $(ctx, id);
  el.value = value;
  if (how === 'enter') el.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  else el.dispatchEvent(new ctx.window.Event(how, { bubbles: how === 'change' }));
  await settle();
}
// Toggle a checkbox like a click does.
async function toggle(ctx, id, on) {
  const el = $(ctx, id);
  el.checked = on;
  el.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  await settle();
}

test('has charset and viewport meta, and every input is labelled', () => {
  const dom = new JSDOM(read('options.html'));
  const d = dom.window.document;
  assert.ok(d.querySelector('meta[charset]'));
  assert.ok(d.querySelector('meta[name=viewport]'));
  d.querySelectorAll('input, select').forEach((el) => {
    const labelled = el.getAttribute('aria-label') || (el.id && d.querySelector(`label[for="${el.id}"]`));
    assert.ok(labelled, `unlabelled: ${el.id || el.outerHTML}`);
  });
  assert.ok(d.querySelector('details #apiKey'), 'api key lives in Advanced');
});

test('new settings load their defaults and the version is shown', async () => {
  const ctx = await load();
  assert.equal($(ctx, 'dailyTarget').value, '8:00');
  assert.equal($(ctx, 'showBadge').checked, true);
  assert.equal($(ctx, 'reminderEnabled').checked, false);
  assert.equal($(ctx, 'reminderTime').value, '17:30');
  assert.equal($(ctx, 'aboutVersion').textContent, '9.9.9');
  assert.deepEqual(ctx.errors, []);
});

test('saved values are loaded and every change is saved at once (contract keys)', async () => {
  const ctx = await load({ sync: { dailyTargetMinutes: 450, showBadge: false } });
  assert.equal($(ctx, 'dailyTarget').value, '7:30');
  assert.equal($(ctx, 'showBadge').checked, false);
  assert.equal(ctx.document.getElementById('save'), null, 'no "Save all settings"');

  await edit(ctx, 'dailyTarget', '6:15');
  assert.equal(ctx.stores.sync.dailyTargetMinutes, 375);
  await toggle(ctx, 'reminderEnabled', true);
  assert.equal(ctx.stores.sync.reminderEnabled, true);
  await edit(ctx, 'reminderTime', '16:45');
  assert.equal(ctx.stores.sync.reminderTime, '16:45');
  await toggle(ctx, 'showBadge', true);
  assert.equal(ctx.stores.sync.showBadge, true);
  await toggle(ctx, 'debugMode', true);
  assert.equal(ctx.stores.sync.debug, true);
  await toggle(ctx, 'useGoogleCalendar', true);
  assert.equal(ctx.stores.sync.useGoogleCalendar, true);
  assert.equal($(ctx, 'saveStatus').textContent, 'Saved');
});

test('text fields save on blur and on Enter, and not twice for change + blur', async () => {
  const ctx = await load();
  let writes = 0;
  ctx.onChanged.listeners.add(() => { writes++; });
  await edit(ctx, 'dailyTarget', '6:00', 'blur');
  assert.equal(ctx.stores.sync.dailyTargetMinutes, 360);
  await edit(ctx, 'icalUrl', 'https://calendar.example.test/a.ics', 'enter');
  assert.equal(ctx.stores.sync.icalUrl, 'https://calendar.example.test/a.ics');
  const before = writes;
  $(ctx, 'dailyTarget').dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  $(ctx, 'dailyTarget').dispatchEvent(new ctx.window.Event('blur'));
  await settle();
  assert.equal(writes, before, 'an unchanged value is not written again');
  // Change + blur of a NEW value in the same tick: one write.
  $(ctx, 'dailyTarget').value = '5:30';
  $(ctx, 'dailyTarget').dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  $(ctx, 'dailyTarget').dispatchEvent(new ctx.window.Event('blur'));
  await settle();
  assert.equal(writes, before + 1);
  assert.equal(ctx.stores.sync.dailyTargetMinutes, 330);
});

test('"Saved" appears in a polite live region', async () => {
  const ctx = await load();
  const status = $(ctx, 'saveStatus');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, '');
  await toggle(ctx, 'showSidebarWidget', false);
  assert.equal(status.textContent, 'Saved');
  assert.ok(status.classList.contains('ok'));
});

test('target 0:00 disables the target (0 minutes)', async () => {
  const ctx = await load();
  await edit(ctx, 'dailyTarget', '0:00');
  assert.equal(ctx.stores.sync.dailyTargetMinutes, 0);
});

test('an invalid value shows an inline error, aria-invalid and is not saved; a valid one clears it', async () => {
  const ctx = await load();
  await edit(ctx, 'dailyTarget', '8:75');
  assert.ok($(ctx, 'dailyTargetError').textContent.length > 0);
  assert.equal($(ctx, 'dailyTarget').getAttribute('aria-invalid'), 'true');
  assert.equal('dailyTargetMinutes' in ctx.stores.sync, false);
  assert.equal($(ctx, 'saveStatus').textContent, '');
  await edit(ctx, 'dailyTarget', '7:45');
  assert.equal($(ctx, 'dailyTargetError').textContent, '');
  assert.equal($(ctx, 'dailyTarget').hasAttribute('aria-invalid'), false);
  assert.equal(ctx.stores.sync.dailyTargetMinutes, 465);
});

test('invalid URLs, hours and reminder time are rejected per field', async () => {
  const ctx = await load();
  await edit(ctx, 'apiUrl', 'not a url');
  assert.equal($(ctx, 'apiUrl').getAttribute('aria-invalid'), 'true');
  assert.match($(ctx, 'apiUrlError').textContent, /full URL/);
  assert.equal('apiUrl' in ctx.stores.sync, false);
  await edit(ctx, 'icalUrl', 'ftp://x.test/a.ics');
  assert.equal('icalUrl' in ctx.stores.sync, false);
  await edit(ctx, 'epSearch', 'nope');
  assert.equal('endpoints' in ctx.stores.sync, false);
  await edit(ctx, 'dayStart', '30');
  assert.equal($(ctx, 'dayStart').getAttribute('aria-invalid'), 'true');
  await edit(ctx, 'dayEnd', '0');
  assert.equal('dayEnd' in ctx.stores.sync, false);
  await edit(ctx, 'reminderTime', '');
  assert.equal($(ctx, 'reminderTime').getAttribute('aria-invalid'), 'true');
  assert.equal('reminderTime' in ctx.stores.sync, false);
  // The hours have to be in order.
  await edit(ctx, 'dayEnd', '12');
  await edit(ctx, 'dayStart', '13');
  assert.equal($(ctx, 'dayStart').getAttribute('aria-invalid'), 'true');
  assert.equal(ctx.stores.sync.dayStart, undefined);
  await edit(ctx, 'dayStart', '9');
  assert.deepEqual([ctx.stores.sync.dayStart, ctx.stores.sync.dayEnd], [9, 12]);
});

test('API URL, iCal URL, endpoints and the legacy key save with the contract shapes', async () => {
  const ctx = await load();
  await edit(ctx, 'apiUrl', ' https://times.example.test/api/v1/tracked-time ');
  assert.equal(ctx.stores.sync.apiUrl, 'https://times.example.test/api/v1/tracked-time');
  assert.equal($(ctx, 'epMyDay').placeholder, 'https://times.example.test/api/v1/my-tracked-time');
  assert.equal($(ctx, 'epPeople').placeholder, 'https://times.example.test/api/v1/people');
  await edit(ctx, 'epPeople', 'https://other.example.test/who');
  assert.equal(plain(ctx.stores.sync.endpoints).people, 'https://other.example.test/who');
  await edit(ctx, 'epPeople', '');
  assert.equal('people' in plain(ctx.stores.sync.endpoints || {}), false);
  await edit(ctx, 'epMyDay', 'https://other.example.test/my');
  await edit(ctx, 'epSearch', 'https://other.example.test/search');
  assert.deepEqual(plain(ctx.stores.sync.endpoints), { myDay: 'https://other.example.test/my', search: 'https://other.example.test/search' });
  await edit(ctx, 'epMyDay', '');
  assert.deepEqual(plain(ctx.stores.sync.endpoints), { search: 'https://other.example.test/search' });
  await edit(ctx, 'apiKey', ' KEY ');
  assert.equal(ctx.stores.sync.apiKey, 'KEY');
  await edit(ctx, 'dayStart', '7');
  await edit(ctx, 'dayEnd', '18');
  await edit(ctx, 'dayEnd', '');
  assert.deepEqual([ctx.stores.sync.dayStart, ctx.stores.sync.dayEnd], [7, 17], 'blank falls back to the default');
});

const meetings = {
  'uid:abc123': { id: 7, label: '#7 Daily standup', title: 'Daily standup' },
  'title:weekly sync': { id: 9, label: '#9 Planning' },
  'uid:zzz': { id: 3, label: '#3 Misc' },
};

test('remembered meetings render, forget one keeps links, forget all', async () => {
  const links = { 'occ1': { bookingId: 1 } };
  const ctx = await load({ local: { omnitimeCalIssues: meetings, omnitimeCalLinks: links } });
  const items = () => [...ctx.document.querySelectorAll('#meetingList li')];
  assert.equal(items().length, 3);
  const text = items().map((li) => li.textContent);
  assert.ok(text[0].includes('Daily standup') && text[0].includes('#7 Daily standup'));
  assert.ok(text[1].includes('weekly sync'));
  assert.ok(text[2].includes('Calendar event'));

  items()[0].querySelector('button').click();
  await settle();
  assert.deepEqual(Object.keys(ctx.stores.local.omnitimeCalIssues), ['title:weekly sync', 'uid:zzz']);
  assert.equal(items().length, 2);
  assert.deepEqual(ctx.stores.local.omnitimeCalLinks, links);

  $(ctx, 'forgetAll').click();
  await settle();
  assert.equal(JSON.stringify(ctx.stores.local.omnitimeCalIssues), "{}");
  assert.equal(items().length, 0);
  assert.deepEqual(ctx.stores.local.omnitimeCalLinks, links);
});

test('remembered meetings update live via storage.onChanged', async () => {
  const ctx = await load();
  assert.equal(ctx.document.querySelectorAll('#meetingList li').length, 0);
  ctx.onChanged.fire({ omnitimeCalIssues: { newValue: meetings } }, 'local');
  assert.equal(ctx.document.querySelectorAll('#meetingList li').length, 3);
});

async function runTest(res) {
  const ctx = await load({ sync: { apiUrl: 'https://x.test/api/v1/tracked-time', apiKey: 'SECRET-KEY' }, respond: () => res });
  $(ctx, 'testConnection').click();
  await settle();
  return { ctx, text: $(ctx, 'testResult').textContent };
}

test('test connection: request shape and success message', async () => {
  const { ctx, text } = await runTest({ success: true, data: { email: 'me@example.com' } });
  const msg = ctx.messages.find((m) => m.action === 'OMNI_FETCH');
  assert.equal(msg.method, 'GET');
  assert.match(msg.url, /^https:\/\/x\.test\/api\/v1\/my-tracked-time\?_format=json&date=\d{4}-\d{2}-\d{2}$/);
  assert.ok(text.startsWith('OK') && text.includes('me@example.com'));
  assert.ok(!ctx.document.body.textContent.includes('SECRET-KEY'));
});

test('test connection: 403, other status and network error', async () => {
  assert.match((await runTest({ success: false, status: 403 })).text, /Not signed in, or this account isn't allowed/);
  assert.match((await runTest({ success: false, status: 500 })).text, /HTTP 500/);
  assert.match((await runTest({ success: false, error: 'Failed to fetch' })).text, /Network error: Failed to fetch/);
});

test('test connection honours the myDay endpoint override', async () => {
  const ctx = await load({ sync: { apiUrl: 'https://x.test/api/v1/tracked-time', endpoints: { myDay: 'https://y.test/my' } } });
  $(ctx, 'testConnection').click();
  await settle();
  assert.match(ctx.messages.find((m) => m.action === 'OMNI_FETCH').url, /^https:\/\/y\.test\/my\?_format=json&date=/);
});

test('Google account: rendered from the sign-in flag, never needing the token', async () => {
  let ctx = await load();
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'none');
  assert.ok(!ctx.messages.some((m) => m.action === 'OMNI_GET_GOOGLE_USER'));
  ctx = await load({ local: { googleSignedIn: true, googleUserInfo: { email: 'me@example.test', name: 'Me' } } });
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'block');
  assert.equal($(ctx, 'googleUserEmail').textContent, 'me@example.test');
  assert.ok(ctx.messages.some((m) => m.action === 'OMNI_GET_GOOGLE_USER'));
  // A leftover token (older version) alone does not show a signed-in state.
  ctx = await load({ local: { googleAuthToken: 'x' } });
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'none');
});

test('Google login: the reply carries no token, the page shows the profile', async () => {
  const ctx = await load({ respond: (m) => (m.action === 'OMNI_GOOGLE_LOGIN' ? { success: true, signedIn: true, userInfo: { email: 'me@example.test' } } : undefined) });
  $(ctx, 'googleLoginBtn').click();
  await settle();
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'block');
  assert.equal($(ctx, 'googleUserEmail').textContent, 'me@example.test');
});

test('showSidebarWidget defaults to on, loads off, and is saved', async () => {
  let ctx = await load();
  assert.equal($(ctx, 'showSidebarWidget').checked, true);
  ctx = await load({ sync: { showSidebarWidget: false } });
  assert.equal($(ctx, 'showSidebarWidget').checked, false);
  await toggle(ctx, 'showSidebarWidget', true);
  assert.equal(ctx.stores.sync.showSidebarWidget, true);
});

test('sidebarStartExpanded defaults to off, loads on, and is saved; the hint says why', async () => {
  let ctx = await load();
  assert.equal($(ctx, 'sidebarStartExpanded').checked, false);
  assert.match(ctx.document.querySelector('label[for="sidebarStartExpanded"]').textContent, /Open the GitLab time tracking details automatically/);
  assert.match($(ctx, 'secMyDay').textContent, /Off is safer when you share your screen\./);
  ctx = await load({ sync: { sidebarStartExpanded: true } });
  assert.equal($(ctx, 'sidebarStartExpanded').checked, true);
  await toggle(ctx, 'sidebarStartExpanded', false);
  assert.equal(ctx.stores.sync.sidebarStartExpanded, false);
  await toggle(ctx, 'sidebarStartExpanded', true);
  assert.equal(ctx.stores.sync.sidebarStartExpanded, true);
});

test('presentation mode: off by default, loads from storage.local, saved at once (per device)', async () => {
  let ctx = await load();
  assert.equal($(ctx, 'presentationMode').checked, false);
  assert.equal($(ctx, 'presentationNote').hidden, true);
  assert.ok($(ctx, 'secNotifications').contains($(ctx, 'presentationMode')), 'lives in Notifications');
  $(ctx, 'presentationMode').click();
  await settle();
  assert.equal(ctx.stores.local.omnitimePresentationMode, true, 'no "Save all settings" needed');
  assert.equal('omnitimePresentationMode' in ctx.stores.sync, false, 'never synced across devices');
  assert.equal($(ctx, 'presentationNote').hidden, false);
  assert.match($(ctx, 'presentationNote').textContent, /Presentation mode is on/);
  $(ctx, 'presentationMode').click();
  await settle();
  assert.equal(ctx.stores.local.omnitimePresentationMode, false);
  assert.equal($(ctx, 'presentationNote').hidden, true);

  ctx = await load({ local: { omnitimePresentationMode: true } });
  assert.equal($(ctx, 'presentationMode').checked, true);
  assert.equal($(ctx, 'presentationNote').hidden, false);
});

test('presentation mode follows the toolbar menu while the page is open', async () => {
  const ctx = await load();
  ctx.onChanged.fire({ omnitimePresentationMode: { newValue: true } }, 'local');
  assert.equal($(ctx, 'presentationMode').checked, true);
  assert.equal($(ctx, 'presentationNote').hidden, false);
  ctx.onChanged.fire({ omnitimePresentationMode: { newValue: false } }, 'local');
  assert.equal($(ctx, 'presentationMode').checked, false);
  assert.equal($(ctx, 'presentationNote').hidden, true);
});

// ---- Embedded mode (the settings panel in the modal) ----
const EMBED_URL = 'chrome-extension://dynamic-session-id/options.html?embedded=1&theme=dark';
const pressEscape = (ctx) => ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const closeMessages = (ctx) => ctx.messages.filter((m) => m.action === 'OMNI_SETTINGS_CLOSE');

test('embedded mode: marks the page, takes the modal theme and offers "Open in a tab"', async () => {
  const ctx = await load({ url: EMBED_URL });
  const root = ctx.document.documentElement;
  assert.equal(root.hasAttribute('data-embedded'), true);
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal($(ctx, 'openInTab').hidden, false);
  $(ctx, 'openInTab').click();
  assert.equal(ctx.calls.openOptionsPage, 1);
  const light = await load({ url: 'chrome-extension://x/options.html?embedded=1&theme=light' });
  assert.equal(light.document.documentElement.getAttribute('data-theme'), 'light');
  // Any other theme value is ignored (the page then follows prefers-color-scheme).
  const odd = await load({ url: 'chrome-extension://x/options.html?embedded=1&theme=pink' });
  assert.equal(odd.document.documentElement.hasAttribute('data-theme'), false);
});

test('tab mode: no embedded mark, no theme override, no "Open in a tab"; Escape does nothing', async () => {
  const ctx = await load();
  const root = ctx.document.documentElement;
  assert.equal(root.hasAttribute('data-embedded'), false);
  assert.equal(root.hasAttribute('data-theme'), false);
  assert.equal($(ctx, 'openInTab').hidden, true);
  pressEscape(ctx);
  assert.deepEqual(closeMessages(ctx), []);
});

test('embedded mode: the stylesheet drops the title and outer padding and has a wide and a narrow layout', () => {
  const css = read('options.css');
  assert.match(css, /:root\[data-embedded\] \.page-title \{[^}]*clip: rect/);
  assert.match(css, /:root\[data-embedded\] \.shell \{[^}]*margin: 0;[^}]*border: 0;/);
  assert.match(css, /@media \(max-width: 719px\)/);
  assert.match(css, /grid-template-columns: 188px/);
  assert.match(css, /\.picker \{ display: none;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('embedded mode: Escape asks the dialog to close the panel (service worker relay, no postMessage)', async () => {
  const ctx = await load({ url: EMBED_URL });
  pressEscape(ctx);
  assert.equal(closeMessages(ctx).length, 1);
  // Not when something already handled the key.
  const e = new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  ctx.document.addEventListener('keydown', (ev) => ev.preventDefault(), { once: true, capture: true });
  ctx.document.dispatchEvent(e);
  assert.equal(closeMessages(ctx).length, 1);
  ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  assert.equal(closeMessages(ctx).length, 1);
  assert.ok(!/postMessage/.test(read('options.js').replace(/\/\/.*$/gm, '')), 'no window.postMessage');
});

test('embedded mode: the privacy policy opens through the browser (not the frame\'s dynamic URL)', async () => {
  const ctx = await load({ url: EMBED_URL });
  $(ctx, 'privacyLink').click();
  assert.deepEqual(plain(ctx.calls.tabs), [{ url: 'chrome-extension://omnitime-id/privacy_policy.md' }]);
  const tab = await load();
  tab.document.getElementById('privacyLink').click();
  assert.deepEqual(plain(tab.calls.tabs), [], 'a plain link in the tab');
});

// ---- Section navigation ----
const SECTIONS = ['secConnection', 'secSites', 'secCalendar', 'secMyDay', 'secNotifications', 'secMeetings', 'secAdvanced', 'secAbout'];
const NAMES = ['Connection', 'Sites', 'Calendar', 'My day', 'Notifications', 'Remembered meetings', 'Advanced', 'About'];

test('section navigation: a list of links and a compact picker for the same eight sections', async () => {
  const ctx = await load();
  const links = [...ctx.document.querySelectorAll('#sectionNav a')];
  assert.deepEqual(links.map((a) => a.textContent), NAMES);
  assert.deepEqual(links.map((a) => a.dataset.section), SECTIONS);
  assert.deepEqual([...$(ctx, 'sectionPicker').options].map((o) => [o.value, o.textContent]), SECTIONS.map((id, i) => [id, NAMES[i]]));
  assert.equal($(ctx, 'sectionNav').getAttribute('aria-label'), 'Settings sections');
  SECTIONS.forEach((id) => assert.ok($(ctx, id), id));
  assert.equal($(ctx, 'secConnection').querySelector('h2').textContent, 'Connection');
});

test('section navigation: links and picker scroll to the section, highlight it and focus its heading', async () => {
  const ctx = await load();
  const scrolled = [];
  ctx.window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.id); };
  ctx.document.querySelector('#sectionNav a[data-section="secCalendar"]').click();
  assert.deepEqual(scrolled, ['secCalendar']);
  const current = () => [...ctx.document.querySelectorAll('#sectionNav a[aria-current]')].map((a) => a.dataset.section);
  assert.deepEqual(current(), ['secCalendar']);
  assert.equal($(ctx, 'sectionPicker').value, 'secCalendar');
  assert.equal(ctx.document.activeElement, $(ctx, 'secCalendar').querySelector('h2'));
  $(ctx, 'sectionPicker').value = 'secAdvanced';
  $(ctx, 'sectionPicker').dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.deepEqual(scrolled, ['secCalendar', 'secAdvanced']);
  assert.deepEqual(current(), ['secAdvanced']);
});

test('section navigation: the active section follows the scroll position', async () => {
  const ctx = await load();
  let scroll = 0;
  const tops = { secConnection: 0, secSites: 400, secCalendar: 800, secMyDay: 1200, secNotifications: 1600, secMeetings: 2000, secAdvanced: 2400, secAbout: 2800 };
  ctx.window.Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList && this.classList.contains('topbar')) return { top: 0, height: 44 };
    return { top: (tops[this.id] ?? 0) - scroll, height: 300 };
  };
  const current = () => ctx.document.querySelector('#sectionNav a[aria-current]').dataset.section;
  for (const [y, expected] of [[0, 'secConnection'], [500, 'secSites'], [1150, 'secMyDay'], [1600, 'secNotifications']]) {
    scroll = y;
    ctx.window.dispatchEvent(new ctx.window.Event('scroll'));
    await settle(40);
    assert.equal(current(), expected, `at ${y}`);
    assert.equal($(ctx, 'sectionPicker').value, expected);
  }
  // At the very bottom the last (short) section is the active one.
  scroll = 2300;
  Object.defineProperty(ctx.document.documentElement, 'scrollHeight', { value: 3100, configurable: true });
  ctx.window.innerHeight = 800;
  ctx.window.scrollY = 2300;
  ctx.window.dispatchEvent(new ctx.window.Event('scroll'));
  await settle(40);
  assert.equal(current(), 'secAbout');
});

// ---- Get started checklist ----
const stepState = (ctx) => ['stepSignIn', 'stepApi', 'stepSite'].map((id) => $(ctx, id).classList.contains('step--done'));

test('Get started: all three steps open on a fresh install, each with its action inline', async () => {
  const ctx = await load();
  assert.equal($(ctx, 'getStarted').hidden, false);
  assert.deepEqual(stepState(ctx), [false, false, false]);
  ['setupSignIn', 'setupApi', 'setupSite'].forEach((id) => assert.equal($(ctx, id).closest('.step__action').hidden, false, id));
  assert.equal($(ctx, 'apiUrl').value, '', 'there is no default API URL in the code to pre-fill');
  assert.equal($(ctx, 'setupDone').hidden, true);
  assert.match($(ctx, 'stepApi').textContent, /\(to do\)/);
});

test('Get started: done steps follow sign-in, the saved API URL and a saved site', async () => {
  let ctx = await load({ local: { googleSignedIn: true } });
  assert.deepEqual(stepState(ctx), [true, false, false]);
  assert.equal($(ctx, 'setupSignIn').closest('.step__action').hidden, true);
  assert.match($(ctx, 'stepSignIn').textContent, /\(done\)/);
  ctx = await load({ sync: { apiUrl: 'https://times.example.test/api/v1/tracked-time' } });
  assert.deepEqual(stepState(ctx), [false, true, false]);
  ctx = await load({ sync: { instances: [{ hostUrl: 'gitlab.example.test', systemType: 'gitlab' }] } });
  assert.deepEqual(stepState(ctx), [false, false, true]);
  assert.equal($(ctx, 'getStarted').hidden, false);
});

test('Get started: gone when everything is set up (an existing user never sees it)', async () => {
  const ctx = await load({
    local: { googleSignedIn: true },
    sync: { apiUrl: 'https://times.example.test/api/v1/tracked-time', instances: [{ hostUrl: 'gitlab.example.test', systemType: 'gitlab' }] },
  });
  assert.equal($(ctx, 'getStarted').hidden, true);
});

// The host inputs of the Sites section have no id: address them by row.
const rows = (ctx) => [...ctx.document.querySelectorAll('.instance')];
const hostInput = (ctx, n = 0) => rows(ctx)[n].querySelector('.host-url');
async function editHost(ctx, value, n = 0, how = 'change') {
  const el = hostInput(ctx, n);
  el.value = value;
  if (how === 'enter') el.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  else el.dispatchEvent(new ctx.window.Event(how, { bubbles: how === 'change' }));
  await settle();
}
const savedHosts = (ctx) => plain((ctx.stores.sync.instances || []).map((i) => [i.hostUrl, i.systemType]));

test('Get started: completing the last step says "You\'re all set" once, and not on the next visit', async () => {
  const sync = { apiUrl: 'https://times.example.test/api/v1/tracked-time' };
  const local = { googleSignedIn: true };
  const ctx = await load({ sync, local });
  assert.equal($(ctx, 'setupDone').hidden, true);
  await editHost(ctx, 'gitlab.example.test');
  assert.deepEqual(stepState(ctx), [true, true, true]);
  assert.equal($(ctx, 'getStarted').hidden, false);
  assert.equal($(ctx, 'setupSteps').hidden, true);
  assert.equal($(ctx, 'setupDone').hidden, false);
  assert.match($(ctx, 'setupDone').textContent, /You're all set/);
  assert.equal($(ctx, 'setupDone').getAttribute('role'), 'status');
  // A later visit (the settings are complete now) does not show it again.
  const again = await load({ sync: { ...ctx.stores.sync }, local });
  assert.equal(again.document.getElementById('getStarted').hidden, true);
});

test('Get started: saving the API URL and a site turns the steps over as you go', async () => {
  const ctx = await load({ local: { googleSignedIn: true } });
  assert.deepEqual(stepState(ctx), [true, false, false]);
  await edit(ctx, 'apiUrl', 'https://times.example.test/api/v1/tracked-time');
  assert.deepEqual(stepState(ctx), [true, true, false]);
  await edit(ctx, 'apiUrl', 'nope'); // invalid: not saved, the step stays done
  assert.deepEqual(stepState(ctx), [true, true, false]);
  await edit(ctx, 'apiUrl', '');
  assert.deepEqual(stepState(ctx), [true, false, false], 'clearing it opens the step again');
});

test('Get started: step 1 takes you to the one Sign in with Google button; signing in ticks it', async () => {
  const ctx = await load({ respond: (m) => (m.action === 'OMNI_GOOGLE_LOGIN' ? { success: true, signedIn: true, userInfo: { email: 'me@example.test' } } : undefined) });
  ctx.window.Element.prototype.scrollIntoView = () => {};
  // One sign-in button on the page, not two.
  const signInButtons = [...ctx.document.querySelectorAll('button')].filter((b) => /sign in with google/i.test(b.textContent));
  assert.deepEqual(signInButtons.map((b) => b.id), ['googleLoginBtn']);
  $(ctx, 'setupSignIn').click();
  assert.equal(ctx.document.activeElement, $(ctx, 'googleLoginBtn'));
  assert.ok(!ctx.messages.some((m) => m.action === 'OMNI_GOOGLE_LOGIN'), 'only goes there');
  $(ctx, 'googleLoginBtn').click();
  await settle();
  assert.ok(ctx.messages.some((m) => m.action === 'OMNI_GOOGLE_LOGIN'));
  assert.equal(stepState(ctx)[0], true);
  assert.equal($(ctx, 'googleUserEmail').textContent, 'me@example.test');
  const failing = await load({ respond: (m) => (m.action === 'OMNI_GOOGLE_LOGIN' ? { success: false, error: 'cancelled' } : undefined) });
  failing.document.getElementById('googleLoginBtn').click();
  await settle();
  assert.equal(stepState(failing)[0], false);
  assert.match(failing.document.getElementById('googleAuthStatus').textContent, /Failed: cancelled/);
});

const OLD_WORDING = /\blog[ -]?(in|out)\b|\blogged[ -](in|out)\b|\blogging (in|out)\b/i;

test('sign-in wording is sentence case everywhere: "Sign in with Google", "Sign out", never "Log In"', async () => {
  const ctx = await load({ local: { googleSignedIn: true, googleUserInfo: { email: 'me@example.test' } } });
  const text = ctx.document.body.textContent;
  assert.match(text, /Sign in with Google/);
  assert.match($(ctx, 'googleLogoutBtn').textContent, /^Sign out$/);
  assert.match($(ctx, 'logoutConfirm').textContent, /Sign out of Google\?[\s\S]*Yes, sign out/);
  assert.ok(!OLD_WORDING.test(text), 'no "Log in"/"Log out" wording');
  const signedOut = await load();
  assert.equal(signedOut.document.getElementById('googleAuthStatus').textContent, 'Not signed in');
  assert.ok(!OLD_WORDING.test(read('options.html').replace(/<[^>]+>/g, ' ')));
});

test('Get started: the actions take you to the API URL field and to a site field', async () => {
  const ctx = await load();
  ctx.window.Element.prototype.scrollIntoView = () => {};
  $(ctx, 'setupApi').click();
  assert.equal(ctx.document.activeElement, $(ctx, 'apiUrl'));
  $(ctx, 'setupSite').click();
  assert.equal(ctx.document.activeElement, hostInput(ctx, 0));
  await editHost(ctx, 'a.example.test');
  $(ctx, 'setupSite').click(); // the first row is taken: a new one
  assert.equal(rows(ctx).length, 2);
  assert.equal(ctx.document.activeElement, hostInput(ctx, 1));
});

// ---- Sites (saved as you go, host access on the user's click) ----
test('sites: a host saves when you leave the field, normalised, and registers the content script', async () => {
  const ctx = await load();
  await editHost(ctx, ' https://GitLab.Example.test/some/path ');
  assert.deepEqual(savedHosts(ctx), [['gitlab.example.test', 'gitlab']]);
  assert.equal(hostInput(ctx).value, 'gitlab.example.test', 'the field shows the normalised host');
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0][0].id, 'omnitime-cs');
  assert.deepEqual(plain(ctx.registered[0][0].matches), ['*://gitlab.example.test/*']);
  assert.ok(ctx.registered[0][0].js.includes('content.js'));
  assert.equal($(ctx, 'saveStatus').textContent, 'Saved');
  // Unchanged: not saved again.
  await editHost(ctx, 'gitlab.example.test');
  assert.equal(ctx.registered.length, 1);
});

test('sites: Enter saves too; an invalid host shows an inline error and is not saved', async () => {
  const ctx = await load();
  await editHost(ctx, 'git lab:://x', 0, 'blur');
  assert.equal(hostInput(ctx).getAttribute('aria-invalid'), 'true');
  assert.match(rows(ctx)[0].querySelector('.field-error').textContent, /host such as gitlab\.com/);
  assert.equal('instances' in ctx.stores.sync, false);
  await editHost(ctx, 'gitlab.example.test', 0, 'enter');
  assert.equal(hostInput(ctx).hasAttribute('aria-invalid'), false);
  assert.deepEqual(savedHosts(ctx), [['gitlab.example.test', 'gitlab']]);
});

test('sites: several rows, remove one, remove the last (an empty row stays, nothing is registered)', async () => {
  const ctx = await load({ sync: { instances: [{ hostUrl: 'a.example.test', systemType: 'gitlab' }, { hostUrl: 'b.example.test', systemType: 'gitlab' }] } });
  assert.equal(rows(ctx).length, 2);
  rows(ctx)[0].querySelector('.remove-instance').click();
  await settle();
  assert.deepEqual(savedHosts(ctx), [['b.example.test', 'gitlab']]);
  assert.deepEqual(plain(ctx.registered.at(-1)[0].matches), ['*://b.example.test/*']);
  rows(ctx)[0].querySelector('.remove-instance').click();
  await settle();
  assert.deepEqual(savedHosts(ctx), []);
  assert.equal(rows(ctx).length, 1);
  assert.equal(hostInput(ctx).value, '');
  assert.equal(ctx.registered.length, 1, 'no registration without a host');
  // An empty row is no site.
  await editHost(ctx, '   ');
  assert.deepEqual(savedHosts(ctx), []);
});

test('sites: access that is already granted shows nothing; missing access offers "Grant access" from the click', async () => {
  const granted = await load();
  await editHost(granted, 'gitlab.example.test');
  assert.equal(rows(granted)[0].querySelector('.instance__msg').textContent, '');
  assert.deepEqual(granted.permissionRequests, [], 'no request when the browser already allows it');

  const ctx = await load({ contains: false, granted: false });
  await editHost(ctx, 'gitlab.example.test');
  assert.equal(ctx.permissionRequests.length, 1, 'tried once after saving');
  assert.deepEqual(plain(ctx.permissionRequests[0]), { origins: ['*://gitlab.example.test/*'] });
  const msg = rows(ctx)[0].querySelector('.instance__msg');
  assert.match(msg.textContent, /Access was not granted/);
  assert.ok(msg.classList.contains('error'));
  assert.deepEqual(savedHosts(ctx), [['gitlab.example.test', 'gitlab']], 'the site is saved regardless');
  // The button's click is the user gesture: it asks again, straight from the handler.
  ctx.chrome.permissions.request = (o, cb) => { ctx.permissionRequests.push(o); cb(true); };
  msg.querySelector('button').click();
  assert.equal(ctx.permissionRequests.length, 2, 'asked synchronously in the click');
  await settle();
  assert.equal(rows(ctx)[0].querySelector('.instance__msg').textContent, 'Access granted.');
});

test('sites: saved hosts without access are flagged on load (a browser can withhold access)', async () => {
  const ctx = await load({ contains: false, sync: { instances: [{ hostUrl: 'gitlab.example.test', systemType: 'gitlab' }] } });
  assert.match(rows(ctx)[0].querySelector('.instance__msg').textContent, /needs your permission/);
  assert.deepEqual(ctx.permissionRequests, [], 'never asks without a click at load');
});

test('sites: when the browser refuses to ask in the embedded frame, "Open in a tab to grant access"', async () => {
  const ctx = await load({ url: EMBED_URL, contains: false, permissionError: 'This function must be called during a user gesture' });
  await editHost(ctx, 'gitlab.example.test');
  const btn = rows(ctx)[0].querySelector('.instance__msg button');
  assert.equal(btn.textContent, 'Open in a tab to grant access');
  btn.click();
  assert.equal(ctx.calls.openOptionsPage, 1);
  // In the tab the same refusal is just "Grant access" again.
  const tab = await load({ contains: false, permissionError: 'nope' });
  await editHost(tab, 'gitlab.example.test');
  assert.equal(rows(tab)[0].querySelector('.instance__msg button').textContent, 'Grant access');
});

test('sites: the system type saves with the row', async () => {
  const ctx = await load({ sync: { instances: [{ hostUrl: 'a.example.test', systemType: 'gitlab' }] } });
  const select = rows(ctx)[0].querySelector('.system-type');
  select.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(savedHosts(ctx), [['a.example.test', 'gitlab']]);
});

// ---- Google account ----
test('log out asks inline (the built-in confirm dialog is blocked in the frame), Cancel and Escape keep you signed in', async () => {
  const ctx = await load({ url: EMBED_URL, local: { googleSignedIn: true, googleUserInfo: { email: 'me@example.test' } }, respond: () => ({ success: true }) });
  ctx.window.confirm = () => { throw new Error('confirm must not be used'); };
  $(ctx, 'googleLogoutBtn').click();
  assert.equal($(ctx, 'logoutConfirm').hidden, false);
  assert.equal($(ctx, 'googleLogoutBtn').hidden, true);
  assert.ok(!ctx.messages.some((m) => m.action === 'OMNI_GOOGLE_LOGOUT'));
  $(ctx, 'logoutNo').click();
  assert.equal($(ctx, 'logoutConfirm').hidden, true);
  assert.equal($(ctx, 'googleLogoutBtn').hidden, false);
  $(ctx, 'googleLogoutBtn').click();
  pressEscape(ctx);
  assert.equal($(ctx, 'logoutConfirm').hidden, true, 'Escape cancels the question first');
  assert.deepEqual(closeMessages(ctx), [], 'and does not close the panel');
  assert.ok(!ctx.messages.some((m) => m.action === 'OMNI_GOOGLE_LOGOUT'));
  pressEscape(ctx);
  assert.equal(closeMessages(ctx).length, 1, 'the next Escape closes the panel');
});

test('log out: confirming signs out and the checklist reopens step 1', async () => {
  const ctx = await load({ local: { googleSignedIn: true, googleUserInfo: { email: 'me@example.test' } }, respond: () => ({ success: true }) });
  assert.equal(stepState(ctx)[0], true);
  $(ctx, 'googleLogoutBtn').click();
  $(ctx, 'logoutYes').click();
  await settle();
  assert.ok(ctx.messages.some((m) => m.action === 'OMNI_GOOGLE_LOGOUT'));
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'none');
  assert.equal(stepState(ctx)[0], false);
  assert.equal($(ctx, 'getStarted').hidden, false);
});

test('signing out elsewhere updates the page (the token expired for good)', async () => {
  const ctx = await load({ local: { googleSignedIn: true, googleUserInfo: { email: 'me@example.test' } } });
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'block');
  delete ctx.stores.local.googleSignedIn;
  ctx.onChanged.fire({ googleSignedIn: { oldValue: true } }, 'local');
  await settle();
  assert.equal($(ctx, 'googleLoggedInWrap').style.display, 'none');
});

test('no alert() or confirm() anywhere (blocked in an embedded cross-origin frame), no "Save all settings"', () => {
  const src = read('options.js');
  assert.ok(!/(^|[^.\w])(window\.)?(alert|confirm)\(/m.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!/Save all settings/.test(read('options.html')));
});
