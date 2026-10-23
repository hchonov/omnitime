const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers');

// chrome.* stand-in for the service worker. Storage areas support both the
// callback and the promise style, as background.js uses both.
function makeChrome({ sync = {}, local = {}, session = {}, authToken } = {}) {
  const store = { sync: { ...sync }, local: { ...local }, session: { ...session } };
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      [].concat(keys).forEach((k) => { if (k in store[name]) out[k] = store[name][k]; });
      if (cb) cb(out);
      return Promise.resolve(out);
    },
    set: (obj, cb) => { Object.assign(store[name], obj); if (cb) cb(); return Promise.resolve(); },
    remove: (keys, cb) => { [].concat(keys).forEach((k) => delete store[name][k]); if (cb) cb(); return Promise.resolve(); },
  });
  const event = () => {
    const listeners = [];
    return { listeners, addListener: (fn) => listeners.push(fn) };
  };
  const chrome = {
    store,
    registered: [],
    uncached: [],
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: event() },
    runtime: { id: 'omnitime-id', onMessage: event(), onInstalled: event(), onStartup: event(), lastError: undefined, getURL: (p) => `chrome-extension://omnitime-id/${p}` },
    alarms: { onAlarm: event(), create() {} },
    action: { onClicked: event() },
    injected: [],
    scripting: {
      insertCSS: (details) => { chrome.injected.push(['css', details]); return Promise.resolve(); },
      executeScript: (details) => { chrome.injected.push(['js', details]); return Promise.resolve([]); },
      unregisterContentScripts: () => Promise.resolve(),
      registerContentScripts: (scripts) => { chrome.registered.push(...scripts); return Promise.resolve(); },
    },
    identity: {
      // authToken: a string to hand out, or null to fail like a revoked grant.
      getAuthToken: (opts, cb) => {
        if (authToken) { cb(authToken); return; }
        chrome.runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      },
      removeCachedAuthToken: (opts, cb) => { chrome.uncached.push(opts.token); cb(); },
    },
  };
  return chrome;
}

// fetch stand-in answering each call from `responses` in order.
function makeFetch(responses) {
  const calls = [];
  const fetch = (url, init = {}) => {
    calls.push({ url, init });
    const [status, body = ''] = responses.shift() || [599];
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
      headers: { get: () => '' },
    });
  };
  fetch.calls = calls;
  return fetch;
}

const revokeCalls = (fetch) => fetch.calls.filter(({ url }) => url.includes('revoke'));
// Deliver a runtime message to the worker's listener, resolving with its reply.
const sendMessage = (chrome, msg) => new Promise((resolve) => {
  const keepOpen = chrome.runtime.onMessage.listeners.some((fn) => fn(msg, { id: 'omnitime-id' }, resolve) === true);
  if (!keepOpen) resolve(undefined);
});
const apiFetch = (bg, request) => new Promise((resolve) => bg.doFetch(request, resolve));

describe('registerContentScriptsFromSettings', () => {
  it('normalizes legacy hosts, drops invalid ones and dedupes', async () => {
    const chrome = makeChrome({
      sync: {
        instances: [
          { hostUrl: 'https://gitlab.example.com/' },
          { hostUrl: 'gitlab.example.com/' },
          { hostUrl: 'git.example.org:8443' },
          { hostUrl: 'not a host*' },
          { hostUrl: '' },
        ],
      },
    });
    const bg = loadBackground({ chrome, fetch: makeFetch([]) });
    await bg.registerContentScriptsFromSettings();
    assert.equal(chrome.registered.length, 1);
    assert.deepEqual([...chrome.registered[0].matches], ['*://gitlab.example.com/*', '*://git.example.org:8443/*']);
    assert.deepEqual([...chrome.registered[0].js], ['adapters/gitlab.js', 'ical-parser.js', 'timer.js', 'core.js', 'sidebar-widget.js', 'content.js']);
    assert.equal(chrome.registered[0].css, undefined, 'no page-level CSS: styles live in the shadow root');
  });
});

describe('stylesheet hand-over (shadow DOM)', () => {
  it('answers OMNI_GET_STYLES with its own style.css, fetched once', async () => {
    const chrome = makeChrome();
    const fetch = makeFetch([[200, ':host { all: initial !important; }']]);
    const bg = loadBackground({ chrome, fetch });
    const first = await sendMessage(chrome, { action: 'OMNI_GET_STYLES' });
    const second = await sendMessage(chrome, { action: 'OMNI_GET_STYLES' });
    assert.deepEqual([first.success, first.css], [true, ':host { all: initial !important; }']);
    assert.equal(second.css, first.css);
    assert.deepEqual(fetch.calls.map(({ url }) => url), ['chrome-extension://omnitime-id/style.css']);
    assert.ok(bg);
  });

  it('reports a failed read and retries on the next request', async () => {
    const chrome = makeChrome();
    const fetch = makeFetch([[404], [200, '.x{}']]);
    loadBackground({ chrome, fetch });
    const failed = await sendMessage(chrome, { action: 'OMNI_GET_STYLES' });
    assert.equal(failed.success, false);
    const ok = await sendMessage(chrome, { action: 'OMNI_GET_STYLES' });
    assert.deepEqual([ok.success, ok.css], [true, '.x{}']);
  });

  it('injects the toolbar overlay without page CSS', async () => {
    const chrome = makeChrome();
    const bg = loadBackground({ chrome, fetch: makeFetch([]) });
    await bg.openOverlay({ id: 42 });
    assert.deepEqual(chrome.injected.map(([kind]) => kind), ['js']);
    assert.deepEqual([...chrome.injected[0][1].files], ['ical-parser.js', 'timer.js', 'core.js', 'overlay-dashboard.js']);
  });
});

describe('refreshGoogleToken', () => {
  it('swaps in a silently minted token without revoking the old one', async () => {
    const chrome = makeChrome({ local: { googleSignedIn: true }, session: { googleAuthToken: 'old' }, authToken: 'fresh' });
    const fetch = makeFetch([]);
    const bg = loadBackground({ chrome, fetch });
    assert.equal(await bg.refreshGoogleToken('old'), 'fresh');
    assert.equal(chrome.store.session.googleAuthToken, 'fresh');
    assert.equal(chrome.store.local.googleAuthToken, undefined, 'the token never goes to local storage');
    assert.deepEqual(chrome.uncached, ['old']);
    assert.deepEqual(fetch.calls, []);
  });

  it('clears the login when no new token is available and Google rejects the old one', async () => {
    const chrome = makeChrome({ local: { googleSignedIn: true, googleUserInfo: { email: 'a@example.test' } }, session: { googleAuthToken: 'old' }, authToken: null });
    const fetch = makeFetch([[400, { error: 'invalid_token' }]]);
    const bg = loadBackground({ chrome, fetch });
    assert.equal(await bg.refreshGoogleToken('old'), null);
    assert.ok(fetch.calls[0].url.startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=old'));
    assert.equal(chrome.store.session.googleAuthToken, undefined);
    assert.equal(chrome.store.local.googleSignedIn, undefined);
    assert.equal(chrome.store.local.googleUserInfo, undefined);
  });

  it('keeps a still-valid token when only the silent refresh fails', async () => {
    const chrome = makeChrome({ local: { googleSignedIn: true }, session: { googleAuthToken: 'old' }, authToken: null });
    const bg = loadBackground({ chrome, fetch: makeFetch([[200, { aud: 'x' }]]) });
    assert.equal(await bg.refreshGoogleToken('old'), null);
    assert.equal(chrome.store.session.googleAuthToken, 'old');
    assert.equal(chrome.store.local.googleSignedIn, true);
  });
});

describe('doFetch', () => {
  const request = { method: 'GET', url: 'https://times.example.test/api/v1/my-tracked-time?date=2026-07-14' };

  it('retries once with a fresh token after the API rejects the old one', async () => {
    const chrome = makeChrome({ local: { googleSignedIn: true }, session: { googleAuthToken: 'expired' }, authToken: 'fresh' });
    const fetch = makeFetch([[403, { message: 'denied' }], [200, { entries: [] }]]);
    const bg = loadBackground({ chrome, fetch });
    const resp = await apiFetch(bg, { ...request });
    assert.equal(resp.success, true);
    assert.equal(JSON.stringify(resp.data), '{"entries":[]}'); // parsed in the vm realm
    assert.deepEqual(fetch.calls.map(({ init }) => init.headers.Authorization), ['Bearer expired', 'Bearer fresh']);
    assert.equal(fetch.calls[0].init.credentials, 'omit');
    assert.deepEqual(revokeCalls(fetch), []);
  });

  it('reports a genuine 403 without logging the user out', async () => {
    const chrome = makeChrome({ local: { googleSignedIn: true }, session: { googleAuthToken: 'valid' }, authToken: 'valid' });
    const fetch = makeFetch([[403, { message: 'This entry is booked.' }], [403, { message: 'This entry is booked.' }]]);
    const bg = loadBackground({ chrome, fetch });
    const resp = await apiFetch(bg, { method: 'PATCH', url: 'https://times.example.test/api/v1/time-entry/5', body: { duration: 30 } });
    assert.deepEqual([resp.success, resp.status, resp.error], [false, 403, 'This entry is booked.']);
    assert.equal(fetch.calls.length, 2);
    assert.equal(chrome.store.session.googleAuthToken, 'valid');
    assert.equal(chrome.store.local.googleSignedIn, true);
    assert.deepEqual(revokeCalls(fetch), []);
  });

  it('falls back to the api-key header when there is no Google login', async () => {
    const chrome = makeChrome();
    const fetch = makeFetch([[200, {}]]);
    const bg = loadBackground({ chrome, fetch });
    await apiFetch(bg, { ...request, apiKey: 'KEY' });
    assert.equal(fetch.calls[0].init.headers['api-key'], 'KEY');
    assert.equal(fetch.calls[0].init.headers.Authorization, undefined);
  });
});

describe('getGoogleAuthToken on Firefox', () => {
  it('uses the promise form of launchWebAuthFlow', async () => {
    const chrome = makeChrome();
    const flows = [];
    const browser = {
      runtime: {},
      identity: {
        launchWebAuthFlow: (details) => {
          flows.push(details);
          return Promise.resolve('https://e4035efc.extensions.allizom.org#access_token=ff-token&expires_in=3599');
        },
      },
    };
    const bg = loadBackground({ chrome, fetch: makeFetch([]), browser, userAgent: 'Mozilla/5.0 Firefox/142.0' });
    assert.equal(await bg.getGoogleAuthToken(false), 'ff-token');
    assert.equal(flows[0].interactive, false);
    assert.match(flows[0].url, /response_type=token/);
  });
});

describe('calendar background sync triggers', () => {
  const googleCalls = (fetch) => fetch.calls.filter(({ url }) => url.startsWith('https://www.googleapis.com/calendar/')).length;
  const signedIn = { sync: { useGoogleCalendar: true }, local: { googleSignedIn: true }, session: { googleAuthToken: 'tok' }, authToken: 'tok' };
  it('syncs right after signing in', async () => {
    const chrome = makeChrome({ sync: { useGoogleCalendar: true }, authToken: 'tok' });
    const fetch = makeFetch([[200, { email: 'user@example.test' }], [200, { items: [] }]]);
    loadBackground({ chrome, fetch });
    const res = await new Promise((resolve) => chrome.runtime.onMessage.listeners.some((fn) => fn({ action: 'OMNI_GOOGLE_LOGIN' }, { id: 'omnitime-id', url: 'chrome-extension://omnitime-id/options.html' }, resolve) === true));
    assert.equal(res.success, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(googleCalls(fetch), 1);
    assert.deepEqual(chrome.store.local.googleCalJson, { items: [] });
  });
  it('triggers during a run share one follow-up run (never parallel, never lost)', async () => {
    const chrome = makeChrome(signedIn);
    const fetch = makeFetch([[200, { items: [] }], [200, { items: [] }], [200, { items: [] }]]);
    const bg = loadBackground({ chrome, fetch });
    await Promise.all([bg.syncCalendarNow(), bg.syncCalendarNow(), bg.syncCalendarNow()]);
    assert.equal(googleCalls(fetch), 2);
  });
  it('syncs at browser start and keeps a 30-minute alarm', async () => {
    const chrome = makeChrome(signedIn);
    const alarms = [];
    chrome.alarms.create = (name, info) => alarms.push({ name, ...info });
    chrome.alarms.clear = (name, cb) => { if (cb) cb(true); return Promise.resolve(true); };
    chrome.alarms.get = (name, cb) => { if (cb) cb(undefined); return Promise.resolve(undefined); };
    const fetch = makeFetch([[200, { items: [] }], [599], [599], [599]]);
    loadBackground({ chrome, fetch });
    chrome.runtime.onStartup.listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(googleCalls(fetch), 1);
    assert.deepEqual(alarms.find((a) => a.name === 'syncCalendar'), { name: 'syncCalendar', delayInMinutes: 1, periodInMinutes: 30 });
  });
});
