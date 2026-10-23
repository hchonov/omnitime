// overlay-dashboard.js — Injected into the active tab by background.js when
// the extension icon is clicked.  Reuses the same openModal() UI from core.js
// on the "My day" tab, mounted in core.js's shadow root like on GitLab.
// Toggle: if an OmniTime dialog is already open, clicking the icon again
// closes it. The gear opens the extension's settings (core.js "Settings panel").

(function () {
  'use strict';

  // Toggle: if a dialog is already open, close it and bail out.
  if (window.OmniTime.isOpen()) {
    window.OmniTime.close();
    return;
  }

  // The stylesheet text for the shadow root, from the service worker (the
  // file isn't web-accessible). Opening without it still works, unstyled.
  function ensureStyles() {
    if (window.OmniTime.hasStyles()) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'OMNI_GET_STYLES' }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.success) window.OmniTime.setStyles(resp.css);
        resolve();
      });
    });
  }

  // Absences (my-tracked-week) are personal HR data: never in a debug log.
  function redactPersonal(data) {
    return data && typeof data === 'object' && Array.isArray(data.absences)
      ? { ...data, absences: `[${data.absences.length} redacted]` }
      : data;
  }

  // --- Transport bound to the background service worker (avoids page CORS) ---
  function makeTransport(apiKey) {
    return (method, url, body) => new Promise((resolve, reject) => {
      chrome.storage.sync.get(['debug'], (s) => {
        const debug = !!s.debug;
        if (debug) console.log(`OmniTime Dashboard: [API Request] ${method} ${url}`, body || '');
        chrome.runtime.sendMessage({ action: 'OMNI_FETCH', method, url, body, apiKey }, (resp) => {
          if (chrome.runtime.lastError) {
            if (debug) console.error('OmniTime Dashboard: [Runtime Error]', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp && resp.success) {
            if (debug) console.log(`OmniTime Dashboard: [API Response] ${method} ${url}:`, redactPersonal(resp.data));
            resolve(resp.data);
          } else {
            if (debug) {
              console.warn(`OmniTime Dashboard: [API Error] ${method} ${url} | HTTP ${resp ? resp.status : '?'}:`, resp ? resp.error : 'Unknown', `(Auth: ${resp ? resp.authType : 'none'}${resp && resp.email ? ', Google User: ' + resp.email : ''})`);
            }
            const err = new Error((resp && resp.error) || 'Request failed');
            if (resp && resp.status) err.status = resp.status;
            reject(err);
          }
        });
      });
    });
  }

  // Badge sync: My day reports today's total after each load (best effort).
  function reportDayTotal(date, totalMinutes) {
    try {
      chrome.runtime.sendMessage({ action: 'OMNI_DAY_TOTAL', date, totalMinutes }, () => void chrome.runtime.lastError);
    } catch (e) { /* extension context gone */ }
  }

  // The gear embeds the extension's own options page (a web-accessible
  // resource under a dynamic URL); this file only supplies its URL.
  const settingsUrl = () => (chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('options.html') : '');

  // Escape pressed inside the embedded settings frame arrives through the
  // service worker (never window.postMessage). This script is injected on every
  // icon click: register once per page.
  if (!window.__omnitimeSettingsRelay && chrome.runtime && chrome.runtime.onMessage) {
    window.__omnitimeSettingsRelay = true;
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.action === 'OMNI_SETTINGS_CLOSE' && sender && sender.id === chrome.runtime.id) {
        window.OmniTime.closeSettings();
      }
    });
  }

  const SYNC_KEYS = ['apiUrl', 'apiKey', 'endpoints', 'icalUrl', 'useGoogleCalendar', 'dayStart', 'dayEnd', 'dailyTargetMinutes'];

  // { settings (sync), signedIn (Google, local) } as stored now.
  function readConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(SYNC_KEYS, (settings) => {
        chrome.storage.local.get(['googleSignedIn'], (local) => {
          resolve({ settings: settings || {}, signedIn: !!(local && local.googleSignedIn) });
        });
      });
    });
  }

  const isConfigured = ({ settings, signedIn }) =>
    !!(settings.apiUrl && settings.apiUrl.trim()) && (!!(settings.apiKey && settings.apiKey.trim()) || signedIn);

  // The settings the modal gets (also used to refresh it after the settings panel).
  function modalSettings(settings) {
    return {
      useGoogleCalendar: settings.useGoogleCalendar || false,
      dayStart: settings.dayStart !== undefined ? settings.dayStart : 8,
      dayEnd: settings.dayEnd !== undefined ? settings.dayEnd : 17,
      // Fallback when the API has no target_minutes; 0 turns the target off.
      dailyTargetMinutes: settings.dailyTargetMinutes
    };
  }

  function buildEndpoints(settings) {
    const overrides = settings.endpoints || {};
    const cleanUrl = (url) => (url || '').trim().replace(/([^:])\/{2,}/g, '$1/');
    const rawApiUrl = cleanUrl(settings.apiUrl);
    const baseApi = rawApiUrl.replace(/\/tracked-time\/?$/, '');
    return {
      trackedTime: rawApiUrl,
      myDay: cleanUrl(overrides.myDay) || (baseApi + '/my-tracked-time'),
      frequent: cleanUrl(overrides.frequent) || (baseApi + '/frequent-issues'),
      search: cleanUrl(overrides.search) || (baseApi + '/issue-search'),
      week: cleanUrl(overrides.week) || (baseApi + '/my-tracked-week'),
      bookmarks: cleanUrl(overrides.bookmarks) || (baseApi + '/my-bookmarks'),
      bookmark: cleanUrl(overrides.bookmark) || (baseApi + '/bookmark'),
      bookingSuggestions: cleanUrl(overrides.bookingSuggestions) || (baseApi + '/booking-suggestions'),
      people: cleanUrl(overrides.people) || (baseApi + '/people'),
    };
  }

  // The "not configured" notice: what is missing, and a button that opens the
  // settings in this same dialog. When the panel closes with a different
  // configuration, start over (the real dialog if it is complete now).
  function showNotice(config) {
    const { settings, signedIn } = config;
    const hasUrl = !!(settings.apiUrl && settings.apiUrl.trim());
    const hasAuth = !!(settings.apiKey && settings.apiKey.trim()) || signedIn;
    let missingMsg = '';
    if (!hasUrl && !hasAuth) {
      missingMsg = 'Please configure your <strong>API URL</strong> and sign in with Google in the extension settings.';
    } else if (!hasUrl) {
      missingMsg = 'Please configure your <strong>API URL</strong> in the extension settings.';
    } else {
      missingMsg = 'Please sign in with Google in the extension settings.';
    }

    // Same shell as the real dialog: shadow root, focus handling,
    // Escape/backdrop/close button.
    window.OmniTime.openNotice({
      title: '1x TIMES — Time Tracking',
      dialogClass: 'omnitime-modal--dashboard',
      html: missingMsg,
      settingsUrl,
      onSettingsClosed: async () => {
        const now = await readConfig();
        const key = (c) => JSON.stringify([c.settings.apiUrl, c.settings.apiKey, c.signedIn]);
        if (key(now) !== key(config)) start();
      },
    });
  }

  function showModal(config) {
    const settings = config.settings;
    // The views hold on to the client; a changed API URL swaps what is behind it.
    const live = window.OmniTime.swappableClient(
      window.OmniTime.createApiClient(makeTransport(settings.apiKey), buildEndpoints(settings)));

    // Set by chrome.storage.onChanged while the dialog is open; the comparison
    // below catches a write that lands after the panel closed.
    let dirty = false;
    const onStorage = (changes, area) => {
      if (area === 'sync' && window.OmniTime.SETTINGS_WATCHED.some((k) => k in changes)) dirty = true;
    };
    const hasStorageEvents = !!(chrome.storage && chrome.storage.onChanged);
    if (hasStorageEvents) chrome.storage.onChanged.addListener(onStorage);

    let modal = null;
    modal = window.OmniTime.openModal({
      apiClient: live.client,
      context: {},
      icalUrl: settings.icalUrl || '',
      // Badge sync: today's total after every My-day load (errors ignored).
      onDayTotal: reportDayTotal,
      activeTab: 'myday',
      settings: modalSettings(settings),
      settingsUrl,
      // The panel closed: when it changed settings, show them (My day reloads).
      onSettingsClosed: async () => {
        const fresh = (await readConfig()).settings;
        if (!dirty && !window.OmniTime.settingsDiffer(fresh, settings)) return;
        dirty = false;
        SYNC_KEYS.forEach((k) => { if (k in fresh) settings[k] = fresh[k]; else delete settings[k]; });
        live.swap(window.OmniTime.createApiClient(makeTransport(settings.apiKey), buildEndpoints(settings)));
        if (modal) modal.applySettings({ settings: modalSettings(settings), icalUrl: settings.icalUrl || '' });
      },
    });
    if (hasStorageEvents && modal && modal.ui) {
      modal.ui.onClose(() => chrome.storage.onChanged.removeListener(onStorage));
    }
  }

  function start() {
    ensureStyles()
      .then(readConfig)
      .then((config) => { if (isConfigured(config)) showModal(config); else showNotice(config); });
  }

  start();
})();
