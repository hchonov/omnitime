// Service worker hardening (background.js): content scripts are attacker-
// controlled, so the worker only fetches the configured API for them, never
// returns the Google token and keeps it in session storage.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers');

const API = 'https://times.example.test/api/v1/tracked-time';
const DAY = 'https://times.example.test/api/v1/my-tracked-time?date=2026-07-14';
const SECRET = 'SECRET-TOKEN-123';
const PAGE = { id: 'omnitime-id', url: 'https://evil.example/page', tab: { id: 1 } };
const EXT = { id: 'omnitime-id', url: 'chrome-extension://omnitime-id/options.html' };

function makeChrome({ sync = {}, local = {}, session = {}, authToken, interactiveToken } = {}) {
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
    authCalls: [],
    uncached: [],
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: event() },
    optionsOpened: 0,
    tabMessages: [],
    runtime: { id: 'omnitime-id', onMessage: event(), onInstalled: event(), onStartup: event(), lastError: undefined, getURL: (p) => `chrome-extension://omnitime-id/${p}`, openOptionsPage: () => { chrome.optionsOpened++; } },
    tabs: { sendMessage: (id, msg, opts) => { chrome.tabMessages.push({ id, msg, opts }); return Promise.resolve(); } },
    alarms: { onAlarm: event(), create() {} },
    action: { onClicked: event() },
    scripting: {},
    identity: {
      getAuthToken: (opts, cb) => {
        chrome.authCalls.push(opts);
        const token = opts.interactive ? (interactiveToken || authToken) : authToken;
        // Answer asynchronously, like the real API.
        Promise.resolve().then(() => {
          if (token) { cb(token); return; }
          chrome.runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
          cb(undefined);
          chrome.runtime.lastError = undefined;
        });
      },
      removeCachedAuthToken: (opts, cb) => { chrome.uncached.push(opts.token); cb(); },
    },
  };
  return chrome;
}

// fetch stand-in: `handler(url, init)` returns [status, body]; every call is recorded.
function makeFetch(handler = () => [200, {}]) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const [status, body = ''] = await handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
      headers: { get: () => '' },
    };
  };
  fetch.calls = calls;
  return fetch;
}

// Deliver a message to the worker's listener; resolves with the reply, or
// undefined when the worker neither answers nor keeps the channel open.
const send = (chrome, msg, sender = PAGE) => new Promise((resolve) => {
  let answered = false;
  const reply = (r) => { answered = true; resolve(r); };
  const keepOpen = chrome.runtime.onMessage.listeners.some((fn) => fn(msg, sender, reply) === true);
  if (!keepOpen && !answered) resolve(undefined);
});

const boot = (opts = {}, handler) => {
  const chrome = makeChrome({ sync: { apiUrl: API }, ...opts });
  const fetch = makeFetch(handler);
  const bg = loadBackground({ chrome, fetch });
  return { chrome, fetch, bg };
};
const signedIn = { local: { googleSignedIn: true, googleUserInfo: { email: 'a@example.test' } }, session: { googleAuthToken: SECRET } };
const hasSecret = (value) => JSON.stringify(value === undefined ? null : value).includes(SECRET);

describe('OMNI_FETCH origin allow-list', () => {
  it('refuses a content script asking for a foreign origin, without fetching', async () => {
    const { chrome, fetch } = boot(signedIn);
    const res = await send(chrome, { action: 'OMNI_FETCH', method: 'GET', url: 'https://attacker.example/steal' });
    assert.deepEqual([res.success, res.status], [false, 0]);
    assert.match(res.error, /Blocked/);
    assert.deepEqual(fetch.calls, []);
    assert.equal(hasSecret(res), false);
  });

  it('also refuses the legacy FETCH_TIME_DATA action and non-http(s) URLs', async () => {
    const { chrome, fetch } = boot(signedIn);
    for (const msg of [
      { action: 'FETCH_TIME_DATA', url: 'https://attacker.example/x' },
      { action: 'OMNI_FETCH', url: 'file:///etc/passwd' },
      { action: 'OMNI_FETCH', url: 'chrome-extension://omnitime-id/style.css' },
      { action: 'OMNI_FETCH', url: 'javascript:alert(1)' },
      { action: 'OMNI_FETCH', url: 'not a url' },
      { action: 'OMNI_FETCH' },
    ]) {
      const res = await send(chrome, msg);
      assert.equal(res.success, false, JSON.stringify(msg));
    }
    assert.deepEqual(fetch.calls, []);
  });

  it('refuses a look-alike host and another port of the configured one', async () => {
    const { chrome, fetch } = boot(signedIn);
    for (const url of ['https://times.example.test.evil.example/api', 'https://times.example.test:8443/api', 'http://times.example.test/api']) {
      assert.equal((await send(chrome, { action: 'OMNI_FETCH', url })).success, false, url);
    }
    assert.deepEqual(fetch.calls, []);
  });

  it('serves the configured API origin with the Bearer token', async () => {
    const { chrome, fetch } = boot(signedIn, () => [200, { entries: [] }]);
    const res = await send(chrome, { action: 'OMNI_FETCH', method: 'GET', url: DAY });
    assert.equal(res.success, true);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer ' + SECRET);
    assert.equal(hasSecret(res), false, 'the reply never contains the token');
  });

  it('serves an endpoint override on another origin, and the api-key path (e2e)', async () => {
    const { chrome, fetch } = boot({
      sync: { apiUrl: API, endpoints: { week: 'https://week.example.test/w' } },
    }, () => [200, {}]);
    const week = await send(chrome, { action: 'OMNI_FETCH', url: 'https://week.example.test/w?date=x', apiKey: 'KEY' });
    assert.equal(week.success, true);
    assert.equal(fetch.calls[0].init.headers['api-key'], 'KEY');
    assert.equal(fetch.calls[0].init.headers.Authorization, undefined);
  });

  it('lets an extension page (Options "Test connection") fetch any http(s) URL, but still not other schemes', async () => {
    const { chrome, fetch } = boot({}, () => [200, { ok: 1 }]);
    const ok = await send(chrome, { action: 'OMNI_FETCH', url: 'https://other.example.test/api/my-tracked-time', apiKey: 'K' }, EXT);
    assert.equal(ok.success, true);
    assert.equal(fetch.calls.length, 1);
    const bad = await send(chrome, { action: 'OMNI_FETCH', url: 'file:///etc/hosts' }, EXT);
    assert.equal(bad.success, false);
    assert.equal(fetch.calls.length, 1);
  });

  it('does not treat a page that merely mentions the extension URL as an extension page', async () => {
    const { chrome, fetch } = boot({});
    const forged = { id: 'omnitime-id', url: 'https://evil.example/chrome-extension://omnitime-id/options.html' };
    const res = await send(chrome, { action: 'OMNI_FETCH', url: 'https://attacker.example/' }, forged);
    assert.equal(res.success, false);
    const otherExt = { id: 'someone-else', url: 'chrome-extension://omnitime-id/options.html' };
    assert.equal((await send(chrome, { action: 'OMNI_FETCH', url: 'https://attacker.example/' }, otherExt)).success, false);
    assert.deepEqual(fetch.calls, []);
  });

  it('has no iCal fetch proxy any more', async () => {
    const { chrome, fetch } = boot(signedIn);
    const res = await send(chrome, { action: 'OMNI_FETCH_ICAL', url: 'https://intranet.example/secret.ics' });
    assert.equal(res, undefined);
    assert.deepEqual(fetch.calls, []);
  });
});

// The options page is embedded in the dialog on web pages under a dynamic URL
// (use_dynamic_url: another host each session), so "is this an extension page"
// is: our extension id AND an extension-scheme document URL.
describe('who counts as an extension page (embedded settings frame)', () => {
  const DYNAMIC = { id: 'omnitime-id', url: 'chrome-extension://8f1c2d3e-dynamic-session-id/options.html?embedded=1&theme=dark', tab: { id: 7 }, frameId: 3 };
  const FIREFOX = { id: 'omnitime-id', url: 'moz-extension://9b2e-random-uuid/options.html?embedded=1&theme=light', tab: { id: 7 }, frameId: 3 };
  const ACTIONS = ['OMNI_GET_GOOGLE_USER', 'OMNI_GOOGLE_LOGOUT'];

  it('accepts the dynamic-URL iframe of Chrome and the moz-extension frame of Firefox for the account actions', async () => {
    for (const sender of [DYNAMIC, FIREFOX]) {
      const { chrome } = boot(signedIn);
      const res = await send(chrome, { action: 'OMNI_GET_GOOGLE_USER' }, sender);
      assert.equal(res.success, true, sender.url);
    }
  });

  it('accepts it for OMNI_FETCH of any http(s) URL (Test connection from the panel)', async () => {
    const { chrome, fetch } = boot({}, () => [200, { ok: 1 }]);
    const res = await send(chrome, { action: 'OMNI_FETCH', url: 'https://other.example.test/x', apiKey: 'K' }, DYNAMIC);
    assert.equal(res.success, true);
    assert.equal(fetch.calls.length, 1);
  });

  it('rejects a content script (the web page\'s https URL) even inside the same extension', async () => {
    const { chrome, fetch } = boot(signedIn);
    const page = { id: 'omnitime-id', url: 'https://gitlab.example.test/a/b/-/issues/1', tab: { id: 7 }, frameId: 0 };
    for (const action of ACTIONS) {
      assert.deepEqual((({ success, error }) => [success, error])(await send(chrome, { action }, page)), [false, 'Not allowed'], action);
    }
    const fetched = await send(chrome, { action: 'OMNI_FETCH', url: 'https://attacker.example/' }, page);
    assert.equal(fetched.success, false);
    assert.deepEqual(fetch.calls, []);
  });

  it('rejects another extension, even with an extension-scheme URL', async () => {
    const { chrome } = boot(signedIn);
    const other = { id: 'someone-else', url: DYNAMIC.url };
    for (const action of ACTIONS) {
      assert.equal((await send(chrome, { action }, other)).error, 'Not allowed', action);
    }
    // No id at all (e.g. an external message) never counts.
    assert.equal((await send(chrome, { action: 'OMNI_GOOGLE_LOGOUT' }, { url: DYNAMIC.url })).error, 'Not allowed');
  });

  it('rejects look-alike URLs that merely contain an extension scheme', async () => {
    const { chrome } = boot(signedIn);
    for (const url of ['https://evil.example/chrome-extension://x/options.html', 'chrome-extension:/x', 'data:text/html,chrome-extension://x/', '', undefined]) {
      const res = await send(chrome, { action: 'OMNI_GET_GOOGLE_USER' }, { id: 'omnitime-id', url });
      assert.equal(res.error, 'Not allowed', String(url));
    }
  });
});

describe('OMNI_SETTINGS_CLOSE relay (Escape inside the settings frame)', () => {
  const FRAME = { id: 'omnitime-id', url: 'chrome-extension://dynamic-id/options.html?embedded=1', tab: { id: 7 }, frameId: 3 };

  it('forwards it to the top frame of the sender\'s tab only', async () => {
    const { chrome } = boot();
    const res = await send(chrome, { action: 'OMNI_SETTINGS_CLOSE' }, FRAME);
    assert.equal(res.success, true);
    assert.equal(chrome.tabMessages.length, 1);
    assert.equal(chrome.tabMessages[0].id, 7);
    assert.equal(chrome.tabMessages[0].msg.action, 'OMNI_SETTINGS_CLOSE');
    assert.equal(chrome.tabMessages[0].opts.frameId, 0);
  });

  it('is refused for a content script: a page must not be able to close or spoof it', async () => {
    const { chrome } = boot();
    const page = { id: 'omnitime-id', url: 'https://evil.example/', tab: { id: 7 }, frameId: 0 };
    const res = await send(chrome, { action: 'OMNI_SETTINGS_CLOSE' }, page);
    assert.deepEqual([res.success, res.error], [false, 'Not allowed']);
    assert.deepEqual(chrome.tabMessages, []);
  });

  it('does nothing without a tab (the options tab itself, the worker) and survives a closed tab', async () => {
    const { chrome } = boot();
    await send(chrome, { action: 'OMNI_SETTINGS_CLOSE' }, { id: 'omnitime-id', url: 'chrome-extension://dynamic-id/options.html' });
    assert.deepEqual(chrome.tabMessages, []);
    chrome.tabs.sendMessage = () => Promise.reject(new Error('Could not establish connection.'));
    const res = await send(chrome, { action: 'OMNI_SETTINGS_CLOSE' }, FRAME);
    assert.equal(res.success, true);
    chrome.tabs.sendMessage = () => { throw new Error('tab gone'); };
    assert.equal((await send(chrome, { action: 'OMNI_SETTINGS_CLOSE' }, FRAME)).success, true);
  });
});

describe('first install', () => {
  const fire = (chrome, details) => chrome.runtime.onInstalled.listeners.forEach((fn) => fn(details));

  it('opens the options page on install only (not on update, browser update or without details)', async () => {
    const { chrome } = boot();
    // The other install work (badge, reminder, scripts) needs these stubs.
    chrome.alarms.clear = () => Promise.resolve(true);
    chrome.action.setBadgeText = () => Promise.resolve();
    chrome.action.setBadgeBackgroundColor = () => Promise.resolve();
    chrome.notifications = { onClicked: { addListener() {} }, create() {}, clear() {} };
    chrome.scripting = { unregisterContentScripts: () => Promise.resolve(), registerContentScripts: () => Promise.resolve() };
    fire(chrome, { reason: 'install' });
    assert.equal(chrome.optionsOpened, 1);
    fire(chrome, { reason: 'update', previousVersion: '2.0.3' });
    fire(chrome, { reason: 'chrome_update' });
    fire(chrome, undefined);
    assert.equal(chrome.optionsOpened, 1);
  });
});

describe('account actions', () => {
  it('refuse GET_USER, LOGIN and LOGOUT from a page, and never leak the token', async () => {
    const { chrome, fetch } = boot({ ...signedIn, authToken: SECRET });
    for (const action of ['OMNI_GET_GOOGLE_USER', 'OMNI_GOOGLE_LOGIN', 'OMNI_GOOGLE_LOGOUT']) {
      const res = await send(chrome, { action }, PAGE);
      assert.deepEqual([res.success, res.error], [false, 'Not allowed'], action);
    }
    assert.deepEqual(fetch.calls, []);
    assert.deepEqual(chrome.authCalls, []);
    assert.equal(chrome.store.session.googleAuthToken, SECRET, 'not logged out');
  });

  it('GET_USER from the options page returns the profile and no token', async () => {
    const { chrome } = boot(signedIn);
    const res = await send(chrome, { action: 'OMNI_GET_GOOGLE_USER' }, EXT);
    assert.equal(res.success, true);
    assert.equal(res.signedIn, true);
    assert.equal(res.userInfo.email, 'a@example.test');
    assert.equal(res.token, undefined);
    assert.equal(hasSecret(res), false);
  });

  it('GET_USER reports "Not logged in" when signed out', async () => {
    const { chrome } = boot({});
    const res = await send(chrome, { action: 'OMNI_GET_GOOGLE_USER' }, EXT);
    assert.deepEqual([res.success, res.error], [false, 'Not logged in']);
  });

  it('LOGIN keeps the token in session storage only and returns no token', async () => {
    const { chrome } = boot({ authToken: SECRET }, () => [200, { email: 'a@example.test', name: 'A' }]);
    const res = await send(chrome, { action: 'OMNI_GOOGLE_LOGIN' }, EXT);
    assert.equal(res.success, true);
    assert.equal(res.signedIn, true);
    assert.equal(hasSecret(res), false);
    assert.equal(chrome.store.session.googleAuthToken, SECRET);
    assert.equal(chrome.store.local.googleAuthToken, undefined);
    assert.equal(hasSecret(chrome.store.local), false, 'nothing in local storage holds the token');
    assert.equal(hasSecret(chrome.store.sync), false);
    assert.equal(chrome.store.local.googleSignedIn, true);
    assert.equal(chrome.store.local.googleUserInfo.email, 'a@example.test');
  });

  it('LOGOUT revokes with a POST body (not a URL), clears everything and returns no token', async () => {
    const { chrome, fetch } = boot({
      ...signedIn,
      local: { ...signedIn.local, googleCalJson: { items: [] }, omnitimeRecentPeople: [{ uid: 7, name: 'Dana Example' }] },
    });
    const res = await send(chrome, { action: 'OMNI_GOOGLE_LOGOUT' }, EXT);
    assert.equal(res.success, true);
    assert.equal(hasSecret(res), false);
    const revoke = fetch.calls.find(({ url }) => url.includes('revoke'));
    assert.ok(revoke, 'revoke call made');
    assert.equal(revoke.url, 'https://oauth2.googleapis.com/revoke');
    assert.equal(revoke.init.method, 'POST');
    assert.equal(revoke.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(revoke.init.body, 'token=' + SECRET);
    assert.ok(!revoke.url.includes(SECRET), 'token not in the URL');
    assert.deepEqual(chrome.uncached, [SECRET]);
    assert.equal(chrome.store.session.googleAuthToken, undefined);
    ['googleSignedIn', 'googleUserInfo', 'googleCalJson', 'omnitimeRecentPeople'].forEach((k) => assert.equal(chrome.store.local[k], undefined, k));
  });

  it('an API error answer does not carry the token either', async () => {
    const { chrome } = boot({ ...signedIn, authToken: null }, () => [500, 'Server error']);
    const res = await send(chrome, { action: 'OMNI_FETCH', url: DAY });
    assert.equal(res.success, false);
    assert.equal(hasSecret(res), false);
  });
});

describe('token storage', () => {
  it('moves a token left in local storage by an older version to session storage', async () => {
    const { chrome, bg } = boot({ local: { googleAuthToken: SECRET, googleUserInfo: { email: 'a@example.test' } } });
    await bg.whenReady();
    assert.equal(chrome.store.local.googleAuthToken, undefined);
    assert.equal(chrome.store.local.googleSignedIn, true);
    assert.equal(chrome.store.session.googleAuthToken, SECRET);
  });

  it('uses the migrated token for the first request', async () => {
    const { chrome, fetch } = boot({ local: { googleAuthToken: SECRET } }, () => [200, {}]);
    await send(chrome, { action: 'OMNI_FETCH', url: DAY });
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer ' + SECRET);
  });

  it('signs in silently after a browser restart (session storage empty)', async () => {
    const { chrome, fetch } = boot({ local: { googleSignedIn: true }, authToken: 'NEW-TOKEN' }, () => [200, {}]);
    await send(chrome, { action: 'OMNI_FETCH', url: DAY });
    assert.deepEqual(chrome.authCalls.map((o) => o.interactive), [false]);
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer NEW-TOKEN');
    assert.equal(chrome.store.session.googleAuthToken, 'NEW-TOKEN');
    assert.equal(chrome.store.local.googleAuthToken, undefined);
  });

  it('does not sign in silently when the user never signed in', async () => {
    const { chrome, fetch } = boot({ authToken: 'NEW-TOKEN' }, () => [200, {}]);
    await send(chrome, { action: 'OMNI_FETCH', url: DAY, apiKey: 'KEY' });
    assert.deepEqual(chrome.authCalls, []);
    assert.equal(fetch.calls[0].init.headers['api-key'], 'KEY');
  });

  it('never sets the session storage access level (content scripts must not read it)', () => {
    const source = require('./helpers').read('background.js');
    assert.ok(!/setAccessLevel\s*\(/.test(source.replace(/\/\/.*$/gm, '')));
  });
});

describe('token refresh', () => {
  it('two parallel 403s cause one silent sign-in, and both retry with the new token', async () => {
    const seen = [];
    const { chrome, fetch } = boot({ ...signedIn, authToken: 'FRESH' }, (url, init) => {
      seen.push(init.headers.Authorization);
      return init.headers.Authorization === 'Bearer FRESH' ? [200, { ok: true }] : [403, { message: 'expired' }];
    });
    const results = await Promise.all([1, 2, 3, 4].map((i) =>
      send(chrome, { action: 'OMNI_FETCH', url: DAY + '&n=' + i })));
    assert.ok(results.every((r) => r.success === true), JSON.stringify(results));
    assert.equal(chrome.authCalls.length, 1, 'one silent authentication');
    assert.deepEqual(chrome.uncached, [SECRET]);
    assert.equal(chrome.store.session.googleAuthToken, 'FRESH');
    assert.equal(fetch.calls.filter(({ init }) => init.headers.Authorization === 'Bearer FRESH').length, 4);
  });

  it('a refresh that fails does not delete a newer token another call stored', async () => {
    const { chrome, bg } = boot({ ...signedIn, authToken: null }, (url) => {
      if (url.includes('tokeninfo')) {
        // While Google is asked, a parallel refresh stored a fresh token.
        chrome.store.session.googleAuthToken = 'NEWER';
        return [400, { error: 'invalid_token' }];
      }
      return [200, {}];
    });
    const result = await bg.refreshGoogleToken(SECRET);
    assert.equal(result, 'NEWER');
    assert.equal(chrome.store.session.googleAuthToken, 'NEWER');
    assert.equal(chrome.store.local.googleSignedIn, true);
  });

  it('a request sent with an already replaced token does not refresh again', async () => {
    const { chrome, bg } = boot({ local: { googleSignedIn: true }, session: { googleAuthToken: 'NEWER' }, authToken: 'X' });
    assert.equal(await bg.refreshGoogleToken('OLD'), 'NEWER');
    assert.deepEqual(chrome.authCalls, []);
  });

  it('signs the user out when silent sign-in fails and Google rejects the token', async () => {
    const { chrome, bg } = boot({ ...signedIn, authToken: null }, () => [400, { error: 'invalid_token' }]);
    assert.equal(await bg.refreshGoogleToken(SECRET), null);
    assert.equal(chrome.store.session.googleAuthToken, undefined);
    assert.equal(chrome.store.local.googleSignedIn, undefined);
    assert.equal(chrome.store.local.googleUserInfo, undefined);
  });
});

describe('overlay and Options wiring', () => {
  const { read } = require('./helpers');
  it('read no token from storage', () => {
    ['overlay-dashboard.js', 'options.js', 'content.js'].forEach((file) => {
      assert.ok(!/googleAuthToken/.test(read(file)), `${file} mentions the token`);
      assert.ok(!/OMNI_FETCH_ICAL|makeIcalTransport|icalTransport/.test(read(file)), `${file} has an iCal transport`);
    });
  });
});
