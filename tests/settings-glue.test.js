// The gear and its settings panel as wired by the glue: content.js (GitLab)
// and overlay-dashboard.js (toolbar icon): the options URL, the Escape relay
// from the frame (OMNI_SETTINGS_CLOSE), refreshing the open view and the sidebar
// widget after the panel changed settings, and the not-configured notice.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { loadDom, uiRoot, read, makeEvent, settle } = require('./helpers');

// Windows stay open until the file is done: in-flight requests and timers of the
// glue would otherwise fire into a closed window.
const windows = [];
after(() => windows.splice(0).forEach((w) => w.close()));
// Let requests the last action started finish before the next test (or the end).
afterEach(() => settle(100));

const OPTIONS = 'chrome-extension://dynamic-session-id/options.html';
const API = 'https://times.example.test/api/v1/tracked-time';
const API2 = 'https://other.example.test/api/v1/tracked-time';
const EXT_SENDER = { id: 'omnitime-id', url: 'chrome-extension://omnitime-id/_generated_background_page.html' };

// A chrome stand-in with mutable storage areas, change events, the message
// bus the glue listens on, and an API that records the URLs it is asked for.
function makeChrome({ sync = {}, local = {} } = {}) {
  const stores = { sync: { ...sync }, local: { ...local } };
  const onChanged = makeEvent();
  const onMessage = makeEvent();
  const requests = [];
  const sent = [];
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in stores[name]) out[k] = stores[name][k]; });
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (obj, cb) => {
      const changes = {};
      Object.keys(obj).forEach((k) => { changes[k] = { oldValue: stores[name][k], newValue: obj[k] }; });
      Object.assign(stores[name], obj);
      onChanged.fire(changes, name);
      if (cb) cb();
      return Promise.resolve();
    },
  });
  return {
    stores, onChanged, onMessage, requests, sent,
    // What the options page does: change settings, optionally announcing it.
    change: (patch, { announce = true } = {}) => {
      const changes = {};
      Object.keys(patch).forEach((k) => { changes[k] = { oldValue: stores.sync[k], newValue: patch[k] }; });
      Object.assign(stores.sync, patch);
      if (announce) onChanged.fire(changes, 'sync');
    },
    chrome: {
      storage: { sync: area('sync'), local: area('local'), onChanged },
      runtime: {
        id: 'omnitime-id',
        lastError: undefined,
        getURL: (p) => `chrome-extension://dynamic-session-id/${p}`,
        onMessage,
        sendMessage: (msg, cb) => {
          sent.push(msg);
          let data = {};
          if (msg.action === 'OMNI_FETCH') {
            requests.push(msg.url);
            if (msg.url.includes('/my-tracked-time')) data = { date: 'x', week: [], entries: [], day_total_minutes: 0, target_minutes: 480 };
            else if (msg.url.includes('/my-tracked-week')) data = { week_entries: [], absences: [] };
            else if (msg.url.includes('/tracked-time')) data = { total_sum: 10, tracked_time: [], details: [], issue: { open: true } };
          }
          if (msg.action === 'OMNI_GET_STYLES') data = undefined;
          if (cb) setTimeout(() => cb(msg.action === 'OMNI_GET_STYLES' ? { success: true, css: read('style.css') } : { success: true, data }), 0);
        },
      },
    },
  };
}

// Polls instead of guessing a delay: the machine may be busy (tests run in parallel).
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await settle(20);
  }
  return pred();
}

const myDayRequests = (mock) => mock.requests.filter((u) => /\/my-tracked-time/.test(u));
const send = (mock, msg, sender = EXT_SENDER) => mock.onMessage.listeners.forEach((fn) => fn(msg, sender, () => {}));

describe('content.js (GitLab)', () => {
  const PAGE = 'https://gitlab.example.test/group/proj/-/issues/42';

  async function boot({ sync = {}, local = {} } = {}) {
    const mock = makeChrome({
      sync: { apiUrl: API, instances: [{ hostUrl: 'gitlab.example.test', systemType: 'gitlab' }], ...sync },
      local,
    });
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', (e) => errors.push(e));
    const dom = new JSDOM('<!DOCTYPE html><html class="gl-light"><head><title>Issue (#42) · GitLab</title></head><body data-project-id="7"><aside><div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div></aside></body></html>',
      { url: PAGE, runScripts: 'outside-only', virtualConsole: vc });
    const { window } = dom;
    windows.push(window);
    window.chrome = mock.chrome;
    window.Element.prototype.scrollIntoView = () => {};
    window.__omnitimeShadowMode = 'open';
    ['adapters/gitlab.js', 'ical-parser.js', 'core.js', 'sidebar-widget.js', 'content.js'].forEach((f) => window.eval(read(f)));
    window.OmniTime.setStyles(read('style.css'));
    await settle(60);
    const document = window.document;
    const openModal = async () => {
      document.querySelector('[data-testid="work-item-time-tracking"] h3').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle(60);
      return uiRoot(document);
    };
    const hosts = () => [...document.querySelectorAll('omnitime-inline')];
    return { mock, window, document, errors, openModal, hosts };
  }

  it('gives the modal a gear that embeds the options page (the URL comes from chrome.runtime.getURL)', async () => {
    const t = await boot();
    const root = await t.openModal();
    root.querySelector('.omnitime-modal-gear').click();
    assert.equal(root.querySelector('.omnitime-settings iframe').getAttribute('src'), `${OPTIONS}?embedded=1&theme=light`);
    assert.deepEqual(t.errors, []);
  });

  it('closes the panel on OMNI_SETTINGS_CLOSE from its own extension only', async () => {
    const t = await boot();
    const root = await t.openModal();
    root.querySelector('.omnitime-modal-gear').click();
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' }, { id: 'someone-else' });
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' }, null);
    send(t.mock, { action: 'SOMETHING_ELSE' });
    assert.ok(root.querySelector('.omnitime-settings'), 'ignored');
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' });
    assert.equal(root.querySelector('.omnitime-settings'), null);
    assert.ok(t.document.querySelector('omnitime-root'), 'the modal stays');
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' }); // nothing open any more: no error
    t.window.OmniTime.close();
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' });
    assert.deepEqual(t.errors, []);
  });

  it('shows changed settings when the panel closes: a new API URL is used by the reloaded view', async () => {
    const t = await boot();
    const root = await t.openModal();
    await until(() => root.querySelector('.omnitime-tab[data-tab="myday"]')); // tabs appear once the API answered
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle(60);
    assert.ok(myDayRequests(t.mock).every((u) => u.startsWith('https://times.example.test/')));
    const before = myDayRequests(t.mock).length;
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ apiUrl: API2, dailyTargetMinutes: 360 });
    root.querySelector('.omnitime-settings__back').click();
    await until(() => myDayRequests(t.mock).length > before && myDayRequests(t.mock).at(-1).startsWith('https://other.example.test/'));
    const after = myDayRequests(t.mock);
    assert.ok(after.length > before, 'My day reloaded');
    assert.ok(after.at(-1).startsWith('https://other.example.test/api/v1/my-tracked-time'), after.at(-1));
    assert.ok(root.querySelector('.omnitime-myday'), 'still on My day');
    assert.deepEqual(t.errors, []);
  });

  it('notices a change even when the storage event arrives after the panel closed (it compares)', async () => {
    const t = await boot();
    const root = await t.openModal();
    await until(() => root.querySelector('.omnitime-tab[data-tab="myday"]')); // tabs appear once the API answered
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle(60);
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ apiUrl: API2 }, { announce: false });
    root.querySelector('.omnitime-settings__back').click();
    await until(() => myDayRequests(t.mock).at(-1).startsWith('https://other.example.test/'));
    assert.ok(myDayRequests(t.mock).at(-1).startsWith('https://other.example.test/'));
  });

  it('does not reload when nothing relevant changed (e.g. only a legacy key or a site)', async () => {
    const t = await boot();
    const root = await t.openModal();
    await until(() => root.querySelector('.omnitime-tab[data-tab="myday"]')); // tabs appear once the API answered
    root.querySelector('.omnitime-tab[data-tab="myday"]').click();
    await settle(60);
    const before = t.mock.requests.length;
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ debug: true });
    root.querySelector('.omnitime-settings__back').click();
    await settle(200);
    assert.equal(t.mock.requests.length, before);
  });

  it('turning the sidebar widget off in the panel removes it, and on brings it back', async () => {
    const t = await boot();
    assert.ok(t.hosts().length > 0, 'widget is mounted');
    const root = await t.openModal();
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ showSidebarWidget: false });
    root.querySelector('.omnitime-settings__back').click();
    await until(() => t.hosts().length === 0);
    assert.equal(t.hosts().length, 0);
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ showSidebarWidget: true });
    root.querySelector('.omnitime-settings__back').click();
    await until(() => t.hosts().length > 0);
    assert.ok(t.hosts().length > 0);
    assert.deepEqual(t.errors, []);
  });

  it('closing the whole modal with the panel still open also lets the sidebar widget re-read', async () => {
    const t = await boot();
    const root = await t.openModal();
    root.querySelector('.omnitime-modal-gear').click();
    t.mock.change({ showSidebarWidget: false });
    t.window.OmniTime.close();
    await until(() => t.hosts().length === 0);
    assert.equal(t.hosts().length, 0);
  });

  it('stops listening for storage changes once the modal is closed', async () => {
    const t = await boot();
    await t.openModal();
    const open = t.mock.onChanged.listeners.size;
    t.window.OmniTime.close();
    assert.equal(t.mock.onChanged.listeners.size, open - 1);
  });
});

describe('overlay-dashboard.js (toolbar icon)', () => {
  function overlayEnv({ sync = {}, local = {} } = {}) {
    const mock = makeChrome({ sync, local });
    const env = loadDom(['ical-parser.js', 'core.js'], { chrome: mock.chrome, styles: false });
    const click = () => env.window.eval(read('overlay-dashboard.js'));
    const root = () => uiRoot(env.document);
    return { ...env, mock, click, root };
  }

  it('the not-configured notice has the gear and an "Open settings" button that opens the panel in the same dialog', async () => {
    const t = overlayEnv();
    t.click();
    await settle();
    const root = t.root();
    assert.ok(root.querySelector('.omnitime-modal-gear'));
    const btn = root.querySelector('.omnitime-notice__settings');
    assert.equal(btn.textContent, 'Open settings');
    assert.ok(!/Right-click the extension icon/.test(root.querySelector('.omnitime-modal-content--message').textContent));
    assert.match(root.querySelector('.omnitime-modal-content--message').textContent, /configure your API URL/);
    btn.click();
    assert.equal(t.document.querySelectorAll('omnitime-root').length, 1, 'same dialog');
    assert.equal(root.querySelector('.omnitime-settings iframe').getAttribute('src'), `${OPTIONS}?embedded=1&theme=light`);
    assert.deepEqual(t.errors, []);
  });

  it('names what is missing', async () => {
    const text = async (env) => { const t = overlayEnv(env); t.click(); await settle(); return t.root().querySelector('.omnitime-modal-content--message').textContent; };
    assert.match(await text({}), /API URL.*sign in with Google/);
    assert.match(await text({ local: { googleSignedIn: true } }), /configure your API URL/);
    assert.match(await text({ sync: { apiUrl: API } }), /sign in with Google/);
  });

  it('replaces the notice with My day once the panel closes and the setup is complete', async () => {
    const t = overlayEnv();
    t.click();
    await settle();
    t.root().querySelector('.omnitime-notice__settings').click();
    // The options page signs in and saves the API URL.
    t.mock.stores.local.googleSignedIn = true;
    t.mock.change({ apiUrl: API });
    t.root().querySelector('.omnitime-settings__back').click();
    await until(() => t.root() && t.root().querySelector('.omnitime-myday'));
    const root = t.root();
    assert.equal(t.document.querySelectorAll('omnitime-root').length, 1);
    assert.ok(root.querySelector('.omnitime-myday'), 'My day instead of the notice');
    assert.ok(root.querySelector('.omnitime-modal-gear'));
    assert.equal(root.querySelector('.omnitime-notice__settings'), null);
    assert.ok(myDayRequests(t.mock)[0].startsWith('https://times.example.test/'));
    assert.deepEqual(t.errors, []);
  });

  it('keeps the notice (and updates its text) when the panel closes with the setup still incomplete', async () => {
    const t = overlayEnv();
    t.click();
    await settle();
    t.root().querySelector('.omnitime-notice__settings').click();
    t.mock.change({ apiUrl: API });
    t.root().querySelector('.omnitime-settings__back').click();
    await until(() => /sign in with Google/.test(t.root().querySelector('.omnitime-modal-content--message').textContent) && !/API URL/.test(t.root().querySelector('.omnitime-modal-content--message').textContent));
    assert.match(t.root().querySelector('.omnitime-modal-content--message').textContent, /sign in with Google/);
    assert.ok(!/API URL/.test(t.root().querySelector('.omnitime-modal-content--message').textContent));
    // Nothing changed at all: the same dialog stays.
    const dialog = t.root().querySelector('.omnitime-modal');
    t.root().querySelector('.omnitime-notice__settings').click();
    t.root().querySelector('.omnitime-settings__back').click();
    await settle(40);
    assert.equal(t.root().querySelector('.omnitime-modal'), dialog);
  });

  const CONFIGURED = { sync: { apiUrl: API, apiKey: 'synthetic' } };

  it('gives the My day overlay the gear, and a changed API URL is used after the panel closes', async () => {
    const t = overlayEnv(CONFIGURED);
    t.click();
    await settle(60);
    const root = t.root();
    assert.ok(root.querySelector('.omnitime-myday'));
    root.querySelector('.omnitime-modal-gear').click();
    assert.equal(root.querySelector('.omnitime-settings iframe').getAttribute('src'), `${OPTIONS}?embedded=1&theme=light`);
    const before = myDayRequests(t.mock).length;
    t.mock.change({ apiUrl: API2 });
    root.querySelector('.omnitime-settings__back').click();
    await until(() => myDayRequests(t.mock).length > before && myDayRequests(t.mock).at(-1).startsWith('https://other.example.test/'));
    assert.ok(myDayRequests(t.mock).length > before);
    assert.ok(myDayRequests(t.mock).at(-1).startsWith('https://other.example.test/'));
    assert.deepEqual(t.errors, []);
  });

  it('registers the Escape relay once, however often the icon is clicked, and closes the panel on it', async () => {
    const t = overlayEnv(CONFIGURED);
    t.click();
    await settle(60);
    t.click(); // toggles the dialog closed
    t.click();
    await settle(60);
    assert.equal(t.mock.onMessage.listeners.size, 1);
    const root = t.root();
    root.querySelector('.omnitime-modal-gear').click();
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' }, { id: 'someone-else' });
    assert.ok(root.querySelector('.omnitime-settings'));
    send(t.mock, { action: 'OMNI_SETTINGS_CLOSE' });
    assert.equal(root.querySelector('.omnitime-settings'), null);
    assert.ok(t.document.querySelector('omnitime-root'));
  });
});

describe('source', () => {
  it('never uses window.postMessage to talk to the frame or the page', () => {
    ['core.js', 'content.js', 'overlay-dashboard.js', 'options.js', 'background.js'].forEach((file) => {
      assert.ok(!/postMessage\(/.test(read(file).replace(/\/\/.*$/gm, '')), `${file} uses postMessage`);
    });
  });

  it('the settings panel code in core.js has no chrome.* call (the glue hands over the URL)', () => {
    const core = read('core.js');
    const panel = core.slice(core.indexOf('// --- Settings panel'), core.indexOf('// --- Dialog shell ---')).replace(/\/\/.*$/gm, '');
    assert.ok(panel.length > 1000);
    assert.ok(!/\bchrome\b/.test(panel));
  });
});
