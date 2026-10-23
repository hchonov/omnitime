// background.js - Service worker. Performs API calls so content scripts are
// not subject to page CORS (host_permissions grant cross-origin access here).

// The iCal parser (calendar filters) is shared with the UI. Chrome's service
// worker pulls it in here; Firefox lists it before background.js in the manifest.
if (typeof importScripts === 'function') {
  try { importScripts('ical-parser.js'); } catch (e) { console.warn('ical-parser.js not loaded:', e); }
}

// ---- Who is asking? ----
// Content scripts (and the overlay) run inside web pages: treat their messages
// as attacker-controlled. Only extension pages (options) may use the
// privileged actions or fetch arbitrary URLs. The options page is also embedded
// in the dialog on web pages (the settings panel) under a dynamic URL
// (use_dynamic_url: a per-session host), so the sender's own URL can't be
// compared with getURL(''): it must be OUR extension (sender.id) running in an
// extension-scheme document. A content script reports the web page's http(s)
// URL, so it stays excluded; another extension has another id.
const EXTENSION_SCHEME = /^(chrome-extension|moz-extension):\/\//;
const isExtensionPage = (s) => !!s && !!chrome.runtime.id && s.id === chrome.runtime.id &&
  typeof s.url === 'string' && EXTENSION_SCHEME.test(s.url);
const NOT_ALLOWED = { success: false, error: 'Not allowed' };

// ---- Google access token ----
// The token lives in chrome.storage.session only. Its default access level is
// "trusted contexts" (service worker, options): content scripts cannot read it
// and page scripts never see it; do NOT call setAccessLevel. It is cleared when
// the browser closes; getToken() then re-authenticates silently. chrome.storage.local
// keeps only UI state: googleSignedIn (bool) and googleUserInfo.
const memorySession = (() => {
  const data = {};
  return {
    get: async (keys) => { const out = {}; [].concat(keys).forEach((k) => { if (k in data) out[k] = data[k]; }); return out; },
    set: async (obj) => { Object.assign(data, obj); },
    remove: async (keys) => { [].concat(keys).forEach((k) => { delete data[k]; }); },
  };
})();
const sessionArea = () => (chrome.storage && chrome.storage.session) || memorySession;
const TOKEN_KEY = 'googleAuthToken';

const isFirefoxBrowser = () => typeof browser !== 'undefined' && browser.runtime && navigator.userAgent.includes('Firefox');

// Versions before the session-only token kept it in chrome.storage.local, where
// content scripts can read it: move it over once at worker start.
async function migrateLegacyToken() {
  const local = await chrome.storage.local.get([TOKEN_KEY]);
  if (!local[TOKEN_KEY]) return;
  await sessionArea().set({ [TOKEN_KEY]: local[TOKEN_KEY] });
  await chrome.storage.local.set({ googleSignedIn: true });
  await chrome.storage.local.remove([TOKEN_KEY]);
}
const tokenMigration = migrateLegacyToken().catch((err) => console.warn('Token migration failed:', err));
function whenReady() { return tokenMigration; }

async function sessionToken() {
  const s = await sessionArea().get([TOKEN_KEY]);
  return s[TOKEN_KEY] || null;
}

// A silent (non-interactive) sign-in, shared by concurrent callers.
let silentAuth = null;
function silentToken() {
  if (!silentAuth) {
    silentAuth = (async () => {
      try {
        const token = await getGoogleAuthToken(false);
        if (token) {
          await sessionArea().set({ [TOKEN_KEY]: token });
          return token;
        }
      } catch (err) {
        console.warn('Silent sign-in failed:', err);
      }
      return null;
    })().finally(() => { silentAuth = null; });
  }
  return silentAuth;
}

// The current access token, or null when signed out: the session token, else a
// silent sign-in when the user is signed in (e.g. after a browser restart).
async function getToken() {
  await whenReady();
  const token = await sessionToken();
  if (token) return token;
  const local = await chrome.storage.local.get(['googleSignedIn']);
  return local.googleSignedIn ? silentToken() : null;
}

async function fetchGoogleUserInfo(token) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

// Absolute http(s) URL, else null.
function parseHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (e) {
    return null;
  }
}

// Origins of the configured API (apiUrl and every endpoint override).
async function configuredApiOrigins() {
  const settings = await chrome.storage.sync.get(['apiUrl', 'endpoints']);
  const origins = new Set();
  const add = (value) => {
    const url = typeof value === 'string' ? parseHttpUrl(value.trim()) : null;
    if (url) origins.add(url.origin);
  };
  add(settings.apiUrl);
  Object.values(settings.endpoints || {}).forEach(add);
  return origins;
}

// null when the request may proceed, else the response to send. Extension pages
// (Options "Test connection") may fetch any http(s) URL; content scripts only
// the configured API, so a compromised page can't aim the token elsewhere.
async function checkFetchAllowed(request, sender) {
  const url = parseHttpUrl(request && request.url);
  if (!url) return { success: false, status: 0, error: 'Blocked: not an http(s) URL.' };
  if (isExtensionPage(sender)) return null;
  const origins = await configuredApiOrigins();
  if (origins.has(url.origin)) return null;
  return { success: false, status: 0, error: 'Blocked: not the configured 1x TIMES API.' };
}

function doFetch(request, sendResponse) {
  const method = (request.method || 'GET').toUpperCase();
  const headers = {
    'Accept': 'application/json',
  };
  const init = { method, headers, credentials: 'omit', cache: 'no-store' };
  if (request.body !== undefined && request.body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }

  (async () => {
    const settings = await chrome.storage.sync.get(['debug']);
    const debug = !!settings.debug;
    const local = await chrome.storage.local.get(['googleUserInfo']);
    const token = await getToken();

    let authType = 'none';
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
      authType = 'Bearer token';
    } else if (request.apiKey) {
      headers['api-key'] = request.apiKey;
      authType = 'api-key';
    }

    if (debug) {
      console.log(`[OmniTime API Request] ${method} ${request.url}`);
      const userEmail = local.googleUserInfo ? local.googleUserInfo.email : 'unknown';
      if (token) {
        console.log(`[OmniTime API Request] Auth: Authorization: Bearer (len: ${token.length}, user: ${userEmail})`);
      } else if (request.apiKey) {
        console.log(`[OmniTime API Request] Auth: api-key header present (len: ${request.apiKey.length})`);
      } else {
        console.warn(`[OmniTime API Request] Auth: NONE (no Google token and no API key configured!)`);
      }
      if (request.body) console.log(`[OmniTime API Request] Body:`, request.body);
    }

    try {
      const response = await fetch(request.url, init);
      let data = null;
      const text = await response.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = text;
      }

      if (debug) {
        // Absences (my-tracked-week) are personal HR data: never logged.
        const logged = data && typeof data === 'object' && Array.isArray(data.absences)
          ? { ...data, absences: `[${data.absences.length} redacted]` }
          : data;
        console.log(`[OmniTime API Response] HTTP ${response.status} ${response.statusText} from ${request.url}:`, logged);
      }

      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && token && !request.isRetry) {
          if (debug) console.log(`[OmniTime API] Attempting token refresh after HTTP ${response.status}...`);
          const freshToken = await refreshGoogleToken(token);
          if (freshToken) {
            doFetch({ ...request, isRetry: true }, sendResponse); // retry once with new token
            return;
          }
        }
        const message = data && data.message ? data.message : (typeof data === 'string' && data ? data : `HTTP error! status: ${response.status}`);
        if (debug) {
          console.warn(`[OmniTime API Error] ${method} ${request.url} failed with HTTP ${response.status}:`, message);
        }
        sendResponse({
          success: false,
          error: message,
          status: response.status,
          url: request.url,
          authType: authType,
          email: local.googleUserInfo ? local.googleUserInfo.email : null
        });
        return;
      }
      sendResponse({ success: true, data });
    } catch (error) {
      if (debug) {
        console.error(`[OmniTime API Fetch Failed] ${method} ${request.url}:`, error);
      }
      sendResponse({ success: false, error: error.message });
    }
  })().catch((error) => sendResponse({ success: false, error: error.message }));
}

// style.css as text, for the shadow root the page scripts mount the UI in.
// The file is deliberately not web-accessible (pages can't probe for the
// extension), so content scripts can't fetch it; the worker can read its own
// package. Cached for the worker's lifetime; a failure is retried next time.
let styleTextPromise = null;
function getStyleText() {
  if (!styleTextPromise) {
    styleTextPromise = fetch(chrome.runtime.getURL('style.css'))
      .then((res) => {
        if (!res.ok) throw new Error(`style.css: HTTP ${res.status}`);
        return res.text();
      })
      .catch((err) => {
        styleTextPromise = null;
        throw err;
      });
  }
  return styleTextPromise;
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;
  // Generic request used by the new UI, plus the legacy GET action.
  if (request.action === 'OMNI_FETCH' || request.action === 'FETCH_TIME_DATA') {
    checkFetchAllowed(request, sender).then((blocked) => {
      if (blocked) sendResponse(blocked);
      else doFetch(request, sendResponse);
    }).catch((err) => sendResponse({ success: false, status: 0, error: err.message }));
    return true; // Respond asynchronously.
  }
  if (request.action === 'OMNI_GET_STYLES') {
    getStyleText()
      .then((css) => sendResponse({ success: true, css }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  // The UI reports the day total after every change, so the badge needs no fetch.
  if (request.action === 'OMNI_DAY_TOTAL') {
    handleDayTotalMessage(request).then(() => sendResponse({ success: true }));
    return true;
  }
  // Escape pressed inside the embedded settings frame: tell the dialog in the
  // top frame of that tab to close its panel (the page can't be messaged with
  // postMessage: it could read and spoof that). Extension pages only.
  if (request.action === 'OMNI_SETTINGS_CLOSE') {
    if (!isExtensionPage(sender)) {
      sendResponse(NOT_ALLOWED);
      return false;
    }
    if (sender.tab && typeof sender.tab.id === 'number') {
      try {
        const sent = chrome.tabs.sendMessage(sender.tab.id, { action: 'OMNI_SETTINGS_CLOSE' }, { frameId: 0 });
        // No dialog (or no content script) in that tab: nothing to close.
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch (e) { /* tab gone */ }
    }
    sendResponse({ success: true });
    return false;
  }
  if (request.action === 'OMNI_FORCE_SYNC_ICAL') {
    syncCalendarNow().then(sendResponse);
    return true;
  }
  // Account actions: extension pages only, and no response carries the token.
  if (request.action === 'OMNI_GOOGLE_LOGIN' ||
      request.action === 'OMNI_GOOGLE_LOGOUT' ||
      request.action === 'OMNI_GET_GOOGLE_USER') {
    if (!isExtensionPage(sender)) {
      sendResponse(NOT_ALLOWED);
      return false;
    }
  }
  if (request.action === 'OMNI_GOOGLE_LOGIN') {
    getGoogleAuthToken(true).then(async token => {
      if (token) {
        const userInfo = await fetchGoogleUserInfo(token);
        const info = (userInfo && !userInfo.error) ? userInfo : null;
        await sessionArea().set({ [TOKEN_KEY]: token });
        await chrome.storage.local.set({ googleSignedIn: true, googleUserInfo: info });
        sendResponse({ success: true, signedIn: true, userInfo: info });
        syncCalendarNow(); // the calendar right away, not at the next alarm
      } else {
        sendResponse({ success: false, error: 'Failed to get token' });
      }
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  if (request.action === 'OMNI_GOOGLE_LOGOUT') {
    (async () => {
      try {
        const token = await getToken();
        if (token) {
          if (!isFirefoxBrowser() && chrome.identity && chrome.identity.removeCachedAuthToken) {
            await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
          }
          try {
            // POST with the token in the body: a GET would put it in the URL.
            await fetch('https://oauth2.googleapis.com/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'token=' + encodeURIComponent(token),
            });
          } catch (e) {}
        }
        await sessionArea().remove([TOKEN_KEY]);
        await chrome.storage.local.remove(['googleSignedIn', 'googleUserInfo', 'googleCalJson', 'omnitimeRecentPeople']);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (request.action === 'OMNI_GET_GOOGLE_USER') {
    (async () => {
      try {
        await whenReady();
        const local = await chrome.storage.local.get(['googleSignedIn', 'googleUserInfo']);
        if (!local.googleSignedIn) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }
        let info = local.googleUserInfo;
        if (!info || info.error) {
          const token = await getToken();
          info = token ? await fetchGoogleUserInfo(token) : null;
          if (info && !info.error) {
            await chrome.storage.local.set({ googleUserInfo: info });
          }
        }
        sendResponse({ success: true, signedIn: true, userInfo: (info && !info.error) ? info : null });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncCalendar') {
    syncCalendarNow();
  } else if (alarm.name === BADGE_ALARM) {
    refreshBadge();
  } else if (alarm.name === TIMER_ALARM) {
    refreshTimerBadge();
  } else if (alarm.name === ROLLOVER_ALARM) {
    scheduleDayRollover();
    refreshBadge();
  } else if (alarm.name === REMINDER_ALARM) {
    scheduleReminder(); // Re-arm for the next weekday first.
    runReminder();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.icalUrl || changes.useGoogleCalendar)) {
    syncCalendarNow();
  }
  if (area === 'sync' && BADGE_KEYS.some((k) => k in changes)) refreshBadge();
  if (area === 'sync' && ('reminderEnabled' in changes || 'reminderTime' in changes)) scheduleReminder();
  // Signing in or out changes whether the badge can be fetched at all.
  if (area === 'local' && 'googleSignedIn' in changes) refreshBadge();
  // The running timer (timer.js) started, stopped or changed in some tab.
  if (area === 'local' && TIMER_KEY in changes) refreshTimerBadge();
  // Presentation mode flipped (menu, options, another window): hide or restore
  // the badge at once (refreshTimerBadge also re-arms the running-timer tick)
  // and keep the toolbar menu's check mark in step.
  if (area === 'local' && PRESENTATION_KEY in changes) {
    refreshTimerBadge();
    updatePresentationMenu(changes[PRESENTATION_KEY].newValue === true);
  }
});

// ---- Toolbar badge: today's tracked total ----
const BADGE_ALARM = 'refreshBadge';
const ROLLOVER_ALARM = 'dayRollover';
const REMINDER_ALARM = 'endOfDayReminder';
const BADGE_GREY = '#6b7280';
const BADGE_GREEN = '#16a34a';
const BADGE_NEUTRAL = '#2563eb'; // No daily target configured.
const BADGE_TIMER = '#c62828';   // A timer is running: elapsed time in red.
const TIMER_KEY = 'omnitimeTimer'; // chrome.storage.local, written by timer.js
const TIMER_ALARM = 'timerBadge';
const DEFAULT_TARGET_MINUTES = 480;
// Presentation mode (per device): while on, nothing about tracked time is
// shown outside OmniTime itself: no badge, no reminder, no sidebar toggle.
const PRESENTATION_KEY = 'omnitimePresentationMode'; // chrome.storage.local, boolean
const PRESENTATION_MENU_ID = 'omnitimePresentationMode';

const pad2 = (n) => String(n).padStart(2, '0');
const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => localDateStr(new Date());

// 150 -> "2:30"; anything that is not a non-negative number -> '' (no badge).
function formatBadgeText(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0) return '';
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}

// Grey below the target, green once reached; neutral when there is no target.
function badgeColor(minutes, target) {
  if (!(target > 0)) return BADGE_NEUTRAL;
  return minutes >= target ? BADGE_GREEN : BADGE_GREY;
}

function dailyTarget(settings) {
  const t = settings && settings.dailyTargetMinutes;
  return typeof t === 'number' && t >= 0 ? t : DEFAULT_TARGET_MINUTES;
}

// The minutes to work on `date`, as the UI counts them (core.js baseTarget +
// dayTarget): none when the setting is 0 (off) or on Saturday/Sunday, else the
// API's target_minutes, else the setting (default 8 h). Absences are applied by
// the reminder only (see todaysAbsence).
function dayTargetFor(settings, data, date) {
  const setting = settings && settings.dailyTargetMinutes;
  if (setting === 0 || setting === '0') return 0;
  const dow = new Date((date || todayStr()) + 'T00:00:00').getDay();
  if (dow === 0 || dow === 6) return 0;
  const api = data && data.target_minutes != null ? Number(data.target_minutes) : NaN;
  return Number.isFinite(api) && api >= 0 ? api : dailyTarget(settings);
}

// Today's target as of the last my-tracked-time response (memory only), so the
// UI-reported totals (OMNI_DAY_TOTAL) are coloured against the real target.
let lastTarget = null; // { date, minutes }
let lastTargetFetch = 0;

// <base>/<name> (or the endpoints override) for a date; mirrors
// resolveEndpoints/withParams in core.js. Null when no API URL is configured.
function siblingUrl(settings, name, override, date) {
  const tracked = String((settings && settings.apiUrl) || '').trim().replace(/([^:])\/{2,}/g, '$1/');
  if (!tracked && !override) return null;
  const base = tracked.replace(/\/tracked-time\/?(\?.*)?$/, '');
  const url = (override || base + '/' + name).replace(/([^:])\/{2,}/g, '$1/');
  return `${url}${url.includes('?') ? '&' : '?'}_format=json&date=${encodeURIComponent(date)}`;
}
function myDayUrl(settings, date) {
  return siblingUrl(settings, 'my-tracked-time', settings && settings.endpoints && settings.endpoints.myDay, date);
}
function weekUrl(settings, date) {
  return siblingUrl(settings, 'my-tracked-week', settings && settings.endpoints && settings.endpoints.week, date);
}

// Same auth path as every other API call; resolves { success, data }.
async function fetchApi(url, settings) {
  if (!url) return { success: false, error: 'Not configured' };
  return new Promise((resolve) => {
    doFetch({ method: 'GET', url, apiKey: settings.apiKey }, resolve);
  });
}
const fetchMyDay = (settings, date) => fetchApi(myDayUrl(settings, date), settings);

// Whether there is any credential to call the API with.
async function hasCredentials(settings) {
  await whenReady();
  const local = await chrome.storage.local.get(['googleSignedIn']);
  return !!(local.googleSignedIn || settings.apiKey);
}

function dayTotalFromResponse(data) {
  const m = data && data.day_total_minutes;
  return typeof m === 'number' && isFinite(m) ? m : null;
}

async function isPresenting() {
  const local = await chrome.storage.local.get([PRESENTATION_KEY]);
  return local[PRESENTATION_KEY] === true;
}

function clearBadge() {
  return chrome.action.setBadgeText({ text: '' });
}

async function applyBadge(minutes, settings, target) {
  const text = formatBadgeText(minutes);
  if (!text) return clearBadge();
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor(minutes, target === undefined ? dailyTarget(settings) : target) });
  await chrome.action.setBadgeText({ text });
}

const BADGE_KEYS = ['apiUrl', 'apiKey', 'endpoints', 'showBadge', 'dailyTargetMinutes'];

// While a timer runs the badge shows its elapsed time (red) instead of the day
// total. Resolves true when it did (the caller leaves the badge alone). The
// stored value is { startedAt: ISO, ... } (see timer.js).
async function applyTimerBadge(settings) {
  const local = await chrome.storage.local.get([TIMER_KEY, PRESENTATION_KEY]);
  const startedAt = Date.parse(local[TIMER_KEY] && local[TIMER_KEY].startedAt);
  if (local[PRESENTATION_KEY] === true || isNaN(startedAt) || (settings && settings.showBadge === false)) return false;
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_TIMER });
  await chrome.action.setBadgeText({ text: formatBadgeText(minutes) });
  return true;
}

// Keep the once-a-minute tick alive exactly while a timer runs; the day total
// comes back when it stops.
async function refreshTimerBadge() {
  try {
    const settings = await chrome.storage.sync.get(BADGE_KEYS);
    if (await applyTimerBadge(settings)) {
      chrome.alarms.create(TIMER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
      return;
    }
    await chrome.alarms.clear(TIMER_ALARM);
    await refreshBadge();
  } catch (err) {
    console.warn('OmniTime timer badge failed:', err);
  }
}

async function refreshBadge() {
  try {
    const settings = await chrome.storage.sync.get(BADGE_KEYS);
    if (await applyTimerBadge(settings)) return;
    if (settings.showBadge === false || await isPresenting() || !(await hasCredentials(settings))) return await clearBadge();
    const date = todayStr();
    const res = await fetchMyDay(settings, date);
    const total = res.success ? dayTotalFromResponse(res.data) : null;
    if (total === null) return await clearBadge();
    const target = dayTargetFor(settings, res.data, date);
    lastTarget = { date, minutes: target };
    await applyBadge(total, settings, target);
  } catch (err) {
    console.warn('OmniTime badge refresh failed:', err);
    try { await clearBadge(); } catch (e) {}
  }
}

async function handleDayTotalMessage(request) {
  if (request.date !== todayStr() || typeof request.totalMinutes !== 'number') return;
  const settings = await chrome.storage.sync.get(BADGE_KEYS);
  if (settings.showBadge === false || await isPresenting()) return clearBadge();
  if (await applyTimerBadge(settings)) return; // the running timer owns the badge
  if (lastTarget && lastTarget.date === request.date) {
    return applyBadge(request.totalMinutes, settings, lastTarget.minutes);
  }
  // No API target known yet: the weekend/setting rule for now, and one refresh
  // (at most every 5 minutes) to learn the real target.
  await applyBadge(request.totalMinutes, settings, dayTargetFor(settings, null, request.date));
  if (dayTargetFor(settings, null, request.date) > 0 && Date.now() - lastTargetFetch > 5 * 60 * 1000 &&
      await hasCredentials(settings)) {
    lastTargetFetch = Date.now();
    refreshBadge();
  }
}

// One-shot alarm shortly after the next local midnight, so yesterday's total
// never lingers on the badge.
function scheduleDayRollover() {
  const next = new Date();
  next.setHours(24, 0, 30, 0);
  chrome.alarms.create(ROLLOVER_ALARM, { when: next.getTime() });
}

function scheduleBadgeAlarms() {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 15 });
  scheduleDayRollover();
  // Alarms may not survive a browser restart: re-arm the timer tick if needed.
  chrome.storage.local.get([TIMER_KEY]).then((local) => {
    if (local[TIMER_KEY]) chrome.alarms.create(TIMER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }).catch(() => {});
}

// ---- End-of-day reminder ----
const isWeekday = (d) => d.getDay() >= 1 && d.getDay() <= 5;

// The next weekday occurrence of "HH:MM" strictly after `now`; null if invalid.
function nextReminderTime(now, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const at = new Date(now);
  at.setHours(+m[1], +m[2], 0, 0);
  while (at <= now || !isWeekday(at)) {
    at.setDate(at.getDate() + 1);
    at.setHours(+m[1], +m[2], 0, 0);
  }
  return at;
}

async function scheduleReminder() {
  const settings = await chrome.storage.sync.get(['reminderEnabled', 'reminderTime']);
  await chrome.alarms.clear(REMINDER_ALARM);
  if (!settings.reminderEnabled) return;
  const at = nextReminderTime(new Date(), settings.reminderTime || '17:30');
  if (at) chrome.alarms.create(REMINDER_ALARM, { when: at.getTime() });
}

const clockMinutes = (s) => {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? +m[1] * 60 + +m[2] : null;
};

// Same keys core.js writes to omnitimeCalLinks.
function calSeriesKey(ev) {
  return ev.uid ? 'uid:' + ev.uid : 'title:' + String(ev.title || '').trim().toLowerCase();
}
function calOccurrenceKey(ev, date) {
  return `${calSeriesKey(ev)}@${date}T${pad2(Math.floor(ev.startMinutes / 60) % 24)}:${pad2(ev.startMinutes % 60)}`;
}

// Today's calendar events that nothing was booked for. Like the Book meetings
// dialog (bookableMeetings in core.js), only events of 5-240 minutes that have
// started count, and one is handled when its linked entry still exists today or
// when a tracked entry overlaps it. `nowMinutes` defaults to the current time.
const MEETING_MIN = 5;
const MEETING_MAX = 240;
function countUnbookedEvents(events, links, entries, date, nowMinutes) {
  if (nowMinutes === undefined) { const n = new Date(); nowMinutes = n.getHours() * 60 + n.getMinutes(); }
  const ids = new Set((entries || []).map((e) => e.id));
  const spans = (entries || []).map((e) => {
    const start = clockMinutes(e.start);
    const dur = e.duration_minutes > 0 ? e.duration_minutes : 15;
    return start === null ? null : [start, start + dur];
  }).filter(Boolean);
  return (events || []).filter((ev) => {
    if (ev.date !== date) return false;
    const dur = ev.endMinutes - ev.startMinutes;
    if (!(dur >= MEETING_MIN && dur <= MEETING_MAX) || ev.startMinutes > nowMinutes) return false;
    const link = (links || {})[calOccurrenceKey(ev, date)];
    if (link && ids.has(link.entryId)) return false;
    return !spans.some(([a, b]) => Math.max(a, ev.startMinutes) < Math.min(b, ev.endMinutes));
  }).length;
}

// Notification text, or null when nothing is outstanding.
function buildReminderMessage(totalMinutes, target, unbooked) {
  const parts = [];
  if (target > 0 && totalMinutes < target) parts.push(`${formatBadgeText(target - totalMinutes)} untracked`);
  if (unbooked > 0) parts.push(`${unbooked} ${unbooked === 1 ? 'meeting' : 'meetings'} unbooked`);
  return parts.length ? parts.join(' \u00b7 ') : null;
}

// Today's events from the cached calendar (Google JSON or raw iCal).
async function todaysCalendarEvents(date) {
  const Cal = (typeof OmniTimeCal !== 'undefined') ? OmniTimeCal : null;
  if (!Cal) return [];
  const local = await chrome.storage.local.get(['googleCalJson', 'icalRaw', 'googleUserInfo']);
  const weekStart = Cal.weekMonday(date);
  let events = [];
  if (local.googleCalJson) {
    events = Cal.parseGoogleCalJsonForWeek(local.googleCalJson, weekStart);
  } else if (local.icalRaw) {
    const selfEmail = local.googleUserInfo && local.googleUserInfo.email;
    events = Cal.parseICalForWeek(local.icalRaw, weekStart, { selfEmail });
  }
  return events.filter((e) => e.date === date);
}

// Today's absence from my-tracked-week: 'full', 'half' or null (also when the
// request fails). Personal HR data: kept in a local variable by the caller,
// never stored or logged.
async function todaysAbsence(settings, date) {
  const res = await fetchApi(weekUrl(settings, date), settings);
  const list = res.success && res.data && Array.isArray(res.data.absences) ? res.data.absences : [];
  const today = list.filter((a) => a && a.date === date);
  if (!today.length) return null;
  return today.length === 1 && today[0].half_day ? 'half' : 'full';
}

async function runReminder() {
  try {
    const now = new Date();
    if (!isWeekday(now)) return;
    const date = localDateStr(now);
    const settings = await chrome.storage.sync.get(BADGE_KEYS.concat(['reminderEnabled']));
    // The alarm still fires in presentation mode; nothing is fetched or shown.
    if (!settings.reminderEnabled || await isPresenting() || !(await hasCredentials(settings))) return;
    const res = await fetchMyDay(settings, date);
    const total = res.success ? dayTotalFromResponse(res.data) : null;
    if (total === null) return;
    let target = dayTargetFor(settings, res.data, date);
    const absence = target > 0 ? await todaysAbsence(settings, date) : null;
    if (absence === 'full') target = 0;
    else if (absence === 'half') target = Math.round(target / 2);
    const { omnitimeCalLinks } = await chrome.storage.local.get(['omnitimeCalLinks']);
    const events = await todaysCalendarEvents(date);
    const unbooked = countUnbookedEvents(events, omnitimeCalLinks, res.data.entries, date);
    const message = buildReminderMessage(total, target, unbooked);
    if (!message || !chrome.notifications) return;
    chrome.notifications.create(REMINDER_ALARM, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'OmniTime',
      message,
    });
  } catch (err) {
    console.warn('OmniTime reminder failed:', err);
  }
}

// Clicking the notification opens the overlay on the active tab, or the
// options page where scripts can't be injected (browser pages, new tab).
async function onReminderClicked(id) {
  if (id !== REMINDER_ALARM) return;
  chrome.notifications.clear(id);
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && /^https?:/i.test(tab.url || '')) {
      await openOverlay(tab);
      return;
    }
  } catch (err) {
    console.warn('OmniTime could not open the overlay:', err);
  }
  chrome.runtime.openOptionsPage();
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(onReminderClicked);
}

// Remember when the calendar last synced successfully (the UI shows it).
function markCalendarSynced() {
  return chrome.storage.local.set({ omnitimeCalSyncedAt: new Date().toISOString() });
}

// Partial response for events.list: what parseGoogleCalJsonForWeek reads.
const GOOGLE_EVENT_FIELDS = 'items(id,iCalUID,recurringEventId,summary,description,location,start,end,status,transparency,eventType,attendees(self,responseStatus)),nextPageToken';

// Google's reason for a failed call (e.g. "insufficientPermissions: Request
// had insufficient authentication scopes."), as ": <reason>" or "".
async function googleErrorReason(response) {
  try {
    const err = ((await response.json()) || {}).error || {};
    const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || '';
    const text = [reason, err.message].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200);
    return text ? `: ${text}` : '';
  } catch (e) {
    return '';
  }
}

// The calendar syncs on sign-in, at browser start, when its settings change,
// and every CAL_SYNC_MINUTES in the background. Triggers during a run don't
// start a parallel one: they share a single follow-up run, which reads the
// settings afresh (a run may have started before they changed).
const CAL_SYNC_MINUTES = 30;
function ensureCalendarAlarm() {
  chrome.alarms.create('syncCalendar', { delayInMinutes: 1, periodInMinutes: CAL_SYNC_MINUTES });
}
let calendarSync = null;
let calendarSyncNext = null;
function syncCalendarNow() {
  if (!calendarSync) {
    calendarSync = syncCalendarOnce().finally(() => { calendarSync = null; });
    return calendarSync;
  }
  if (!calendarSyncNext) {
    calendarSyncNext = calendarSync.catch(() => {}).then(() => {
      calendarSyncNext = null;
      return syncCalendarNow();
    });
  }
  return calendarSyncNext;
}

async function syncCalendarOnce() {
  const settings = await chrome.storage.sync.get(['icalUrl', 'useGoogleCalendar']);
  const local = await chrome.storage.local.get(['icalEtag']);
  const googleToken = settings.useGoogleCalendar ? await getToken() : null;

  if (googleToken) {
    try {
      // Fetch 3 months back and 3 months forward
      const timeMin = new Date();
      timeMin.setMonth(timeMin.getMonth() - 3);
      const timeMax = new Date();
      timeMax.setMonth(timeMax.getMonth() + 3);

      // Only default events (no out-of-office, focus time, working location,
      // Gmail items) and only the fields the parser reads: no attendee list,
      // organiser, conference links or attachments end up in the local cache.
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=2500&eventTypes=default&fields=${encodeURIComponent(GOOGLE_EVENT_FIELDS)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + googleToken }
      });

      if (!response.ok) {
        if (response.status === 401) {
          const freshToken = await refreshGoogleToken(googleToken);
          if (freshToken) {
            // retry once
            const retryResponse = await fetch(url, {
              method: 'GET',
              headers: { 'Authorization': 'Bearer ' + freshToken }
            });
            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              await chrome.storage.local.set({ googleCalJson: retryData });
              await markCalendarSynced();
              return { success: true, updated: true };
            }
          }
          // refreshGoogleToken() already cleared the login if the token is dead.
        }
        return { success: false, error: `Google API HTTP ${response.status}${await googleErrorReason(response)}` };
      }

      const data = await response.json();
      await chrome.storage.local.set({ googleCalJson: data });
      await markCalendarSynced();
      return { success: true, updated: true };
    } catch (err) {
      console.error('OmniTime Google Calendar sync failed:', err);
      return { success: false, error: err.message };
    }
  }

  // Fallback to old iCal URL
  const icalUrl = settings.icalUrl;
  if (!icalUrl) return { success: false, error: 'No calendar configured' };

  const headers = { 'Accept': 'text/calendar, text/plain' };
  if (local.icalEtag) headers['If-None-Match'] = local.icalEtag;

  try {
    const response = await fetch(icalUrl, { method: 'GET', headers });
    if (response.status === 304) {
      await markCalendarSynced();
      return { success: true, notModified: true };
    }
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.text();
    const etag = response.headers.get('ETag') || '';
    await chrome.storage.local.set({ icalRaw: data, icalEtag: etag, googleCalJson: null });
    await markCalendarSynced();
    return { success: true, updated: true };
  } catch (err) {
    console.error('OmniTime background sync failed:', err);
    return { success: false, error: err.message };
  }
}

// Inject the OmniTime overlay into the given tab (toolbar icon click; named so
// the e2e tests can trigger it, as they can't click the browser toolbar). No
// page CSS: overlay-dashboard.js asks for the stylesheet text (OMNI_GET_STYLES)
// and core.js mounts it inside the overlay's shadow root.
async function openOverlay(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['ical-parser.js', 'timer.js', 'core.js', 'overlay-dashboard.js'],
  });
}
chrome.action.onClicked.addListener(openOverlay);

// Normalize legacy saved URLs without requiring users to re-save Options.
// Keep this compatible with the copies in content.js and options.js.
function normalizeInstanceHost(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const hasPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(input);
  if (!hasScheme && /^[a-z][a-z\d+.-]*:/i.test(input) && !hasPort) return null;
  if (/^https?:\/\/\//i.test(input)) return null;

  try {
    const url = new URL(hasScheme ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.hostname.includes('*')) return null;
    return url.host;
  } catch (e) {
    return null;
  }
}

async function registerContentScriptsFromSettings() {
  const settings = await chrome.storage.sync.get(['instances']);
  if (!settings.instances || settings.instances.length === 0) return;

  // Skip hosts that don't normalize: one invalid match pattern would fail the
  // whole registration below, after the old scripts were already unregistered.
  const origins = [];
  settings.instances.forEach(inst => {
    const host = normalizeInstanceHost(inst && inst.hostUrl);
    if (host && !origins.includes(`*://${host}/*`)) origins.push(`*://${host}/*`);
  });

  if (origins.length > 0) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: ['omnitime-cs'] }).catch(() => { });
      await chrome.scripting.registerContentScripts([{
        id: 'omnitime-cs',
        matches: origins,
        // No css: the modal's styles live in its shadow root (OMNI_GET_STYLES).
        js: ['adapters/gitlab.js', 'ical-parser.js', 'timer.js', 'core.js', 'sidebar-widget.js', 'content.js'],
        runAt: 'document_idle'
      }]);
    } catch (err) {
      console.error('Script re-registration failed:', err);
    }
  }
}

// ---- Presentation mode: checkbox item in the toolbar icon's right-click menu ----
// Rebuilt from storage on install and on every browser start (the menu may be
// gone after a restart); runs one at a time so overlapping calls can't create
// the same id twice.
let presentationMenuQueue = Promise.resolve();
function syncPresentationMenu() {
  if (!chrome.contextMenus) return presentationMenuQueue;
  presentationMenuQueue = presentationMenuQueue.then(async () => {
    try {
      const checked = await isPresenting();
      await new Promise((resolve) => {
        chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; resolve(); });
      });
      chrome.contextMenus.create({
        id: PRESENTATION_MENU_ID,
        type: 'checkbox',
        title: 'Presentation mode (hide tracking)',
        checked,
        contexts: ['action'],
      }, () => { void chrome.runtime.lastError; });
    } catch (err) {
      console.warn('OmniTime menu failed:', err);
    }
  });
  return presentationMenuQueue;
}

// Only the check mark changed: update in place, rebuild if the item is missing.
function updatePresentationMenu(checked) {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.update(PRESENTATION_MENU_ID, { checked }, () => {
    if (chrome.runtime.lastError) syncPresentationMenu();
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId !== PRESENTATION_MENU_ID) return;
    // `checked` is the new state; fall back to flipping the stored one.
    const on = typeof info.checked === 'boolean' ? info.checked : !(await isPresenting());
    await chrome.storage.local.set({ [PRESENTATION_KEY]: on });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  // First install (not an update or a browser update): the settings are the
  // first thing to see - sign in, API URL, GitLab site ("Get started").
  if (details && details.reason === 'install') {
    try { chrome.runtime.openOptionsPage(); } catch (e) { console.warn('OmniTime could not open the settings:', e); }
  }
  syncPresentationMenu();
  registerContentScriptsFromSettings();
  ensureCalendarAlarm();
  syncCalendarNow();
  scheduleBadgeAlarms();
  refreshBadge();
  scheduleReminder();
});
chrome.runtime.onStartup.addListener(() => {
  syncPresentationMenu();
  registerContentScriptsFromSettings();
  ensureCalendarAlarm();
  syncCalendarNow();
  scheduleBadgeAlarms();
  refreshBadge();
  scheduleReminder();
});

function getGoogleAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    const isFirefox = isFirefoxBrowser();
    if (!isFirefox && chrome.identity && chrome.identity.getAuthToken) {
      chrome.identity.getAuthToken({ interactive: interactive }, function(token) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(token);
        }
      });
    } else {
      // Firefox flow
      const clientId = '865706468431-foj6le1dpkfqdfvdfuoalcg31jqqfcko.apps.googleusercontent.com';
      const redirectUri = 'https://e4035efc-4910-4ae2-bf1e-9d6ae4f772bc.extensions.allizom.org';
      const scopes = encodeURIComponent('email https://www.googleapis.com/auth/calendar.readonly');
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${redirectUri}&scope=${scopes}`;
      
      // Promise form: Firefox's browser.* APIs don't take callbacks.
      const identityApi = typeof browser !== 'undefined' ? browser.identity : chrome.identity;
      identityApi.launchWebAuthFlow({ url: authUrl, interactive: interactive }).then((redirectUrl) => {
        if (!redirectUrl) throw new Error('Auth failed');
        // Extract token from redirectUrl (hash fragment)
        const params = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
        const token = params.get('access_token');
        if (!token) throw new Error('No token found in response');
        resolve(token);
      }).catch(reject);
    }
  });
}

// Drops the cached token and silently gets a new one. Never revokes: revoking
// also withdraws the user's consent, and the API answers 403 for ordinary
// "not allowed" cases (e.g. a booked entry) too, so a refresh must be harmless.
// Single-flight: a modal open sends several requests at once, and they all get
// the same answer. Resolves the new token, or null.
let refreshing = null;
function refreshGoogleToken(oldToken) {
  if (!refreshing) {
    refreshing = doRefreshGoogleToken(oldToken).finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function doRefreshGoogleToken(oldToken) {
  // Another refresh already replaced the token this request was sent with.
  const current = await sessionToken();
  if (current && current !== oldToken) return current;
  if (!isFirefoxBrowser() && chrome.identity && chrome.identity.removeCachedAuthToken) {
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token: oldToken }, resolve));
  }
  const newToken = await silentToken();
  if (newToken) return newToken;
  // No new token: keep the old one only while Google still accepts it, so a
  // dead token doesn't stay in storage failing every request. Compare before
  // removing: a newer token stored meanwhile must survive.
  if (!(await isGoogleTokenValid(oldToken))) {
    const now = await sessionToken();
    if (now && now !== oldToken) return now;
    await sessionArea().remove([TOKEN_KEY]);
    await chrome.storage.local.remove(['googleSignedIn', 'googleUserInfo']);
  }
  return null;
}

async function isGoogleTokenValid(token) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
    return res.ok;
  } catch (e) {
    return true; // A network error says nothing about the token; keep it.
  }
}
