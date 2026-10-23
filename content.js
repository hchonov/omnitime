// content.js - Production glue for OmniTime. Reads settings, locates the host
// "Time tracking" element via the adapter, and opens the OmniTime modal
// (defined in core.js) wired to the chrome.runtime fetch proxy (background.js).

var omniDebugMode = false;

// Normalize legacy saved URLs without requiring users to re-save Options.
// Keep this compatible with the copies in options.js and background.js.
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

function log(...args) {
  if (omniDebugMode) console.log('OmniTime:', ...args);
}
function warn(...args) {
  if (omniDebugMode) console.warn('OmniTime:', ...args);
}

// Absences (my-tracked-week) are personal HR data: never in a debug log.
function redactPersonal(data) {
  return data && typeof data === 'object' && Array.isArray(data.absences)
    ? { ...data, absences: `[${data.absences.length} redacted]` }
    : data;
}

// Transport bound to the background service worker (avoids page CORS).
function makeTransport(apiKey) {
  return (method, url, body) => new Promise((resolve, reject) => {
    if (omniDebugMode) {
      console.log(`OmniTime: [API Request] ${method} ${url}`, body || '');
    }
    chrome.runtime.sendMessage({ action: 'OMNI_FETCH', method, url, body, apiKey }, (resp) => {
      if (chrome.runtime.lastError) {
        if (omniDebugMode) console.error('OmniTime: [Runtime Error]', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp && resp.success) {
        if (omniDebugMode) {
          console.log(`OmniTime: [API Response] ${method} ${url}:`, redactPersonal(resp.data));
        }
        resolve(resp.data);
      } else {
        if (omniDebugMode) {
          console.warn(`OmniTime: [API Error] ${method} ${url} | HTTP ${resp ? resp.status : '?'}:`, resp ? resp.error : 'Unknown', `(Auth: ${resp ? resp.authType : 'none'}${resp && resp.email ? ', Google User: ' + resp.email : ''})`);
        }
        const err = new Error((resp && resp.error) || 'Request failed');
        if (resp && resp.status) err.status = resp.status;
        reject(err);
      }
    });
  });
}

// Badge sync: My day reports today's total after each load; the service
// worker updates the toolbar badge. Best effort (e.g. a reloaded extension).
function reportDayTotal(date, totalMinutes) {
  try {
    chrome.runtime.sendMessage({ action: 'OMNI_DAY_TOTAL', date, totalMinutes }, () => void chrome.runtime.lastError);
  } catch (e) { /* extension context gone */ }
}

// The modal's stylesheet (style.css as text) for its shadow root, asked from
// the service worker once per page: the file isn't web-accessible, so the page
// side can't load it itself. A failure is retried on the next open.
let stylesReady = null;
function ensureStyles() {
  if (window.OmniTime.hasStyles()) return Promise.resolve();
  if (!stylesReady) {
    stylesReady = new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'OMNI_GET_STYLES' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.success) {
          warn('Could not load the stylesheet:', chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp && resp.error));
          stylesReady = null;
        } else {
          window.OmniTime.setStyles(resp.css);
        }
        resolve();
      });
    });
  }
  return stylesReady;
}

// Build the issue context (source/project/issue + label) for the modal.
function buildContext(adapter) {
  const context = { source: window.location.origin };
  try {
    const meta = adapter.getMetadata();
    context.project_id = meta.project_id;
    context.issue_id = meta.issue_id;
    // Best-effort human label from the page title, e.g. "Title (#689) · …".
    const title = (document.title || '').split(' · ')[0].trim();
    if (title) context.issue_label = title;
  } catch (e) {
    warn('Could not read issue metadata:', e.message);
  }
  return context;
}

const PRESENTATION_KEY = 'omnitimePresentationMode'; // chrome.storage.local, boolean

function readPresentationMode() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([PRESENTATION_KEY], (items) => {
        resolve(!!chrome.runtime.lastError || !!(items && items[PRESENTATION_KEY] === true));
      });
    } catch (e) {
      resolve(true);
    }
  });
}

const SETTINGS_KEYS = ['apiUrl', 'apiKey', 'instances', 'debug', 'endpoints', 'icalUrl', 'useGoogleCalendar', 'dayStart', 'dayEnd', 'dailyTargetMinutes', 'showSidebarWidget', 'sidebarStartExpanded'];

// The gear in the modal embeds the extension's own options page (a web-
// accessible resource under a dynamic URL, see core.js "Settings panel"); this
// file only supplies its URL.
function settingsUrl() {
  return chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('options.html') : '';
}

// Escape pressed inside the embedded settings frame reaches us through the
// service worker (never window.postMessage: the page could read or spoof it).
// Only our own extension can message a content script, but check anyway.
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.action === 'OMNI_SETTINGS_CLOSE' && sender && sender.id === chrome.runtime.id && window.OmniTime) {
      window.OmniTime.closeSettings();
    }
  });
}

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

// Endpoint URLs are pre-configured from the tracked-time base, but each can
// be overridden in the options page (keeps the extension generic).
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

async function init() {
  const settings = await chrome.storage.sync.get(SETTINGS_KEYS);
  omniDebugMode = !!settings.debug;
  // Never print the API key, even in debug mode (console output gets shared).
  log('Extension initialized', { ...settings, apiKey: settings.apiKey ? '(set)' : '' });

  if (!Array.isArray(settings.instances) || !settings.apiUrl) {
    warn('Missing configuration (instances or apiUrl)');
    return;
  }

  const config = settings.instances.find((inst) =>
    normalizeInstanceHost(inst && inst.hostUrl) === window.location.host);
  if (!config) return;

  const systemType = config.systemType || 'gitlab';
  let adapter;
  if (systemType === 'gitlab' && window.GitlabAdapter) {
    adapter = new window.GitlabAdapter();
    adapter.debugMode = omniDebugMode;
  } else {
    warn(`No adapter found for system type '${systemType}'.`);
    return;
  }
  log(`Using adapter '${adapter.name}'`);

  // The views hold on to `apiClient`; a changed API URL swaps what is behind it.
  const live = window.OmniTime.swappableClient(
    window.OmniTime.createApiClient(makeTransport(settings.apiKey), buildEndpoints(settings)));
  const apiClient = live.client;

  // After the settings panel (modal gear) changed something: re-read the
  // settings in place (everything holds the same object), point the client at
  // the new endpoints and let the sidebar widget re-attach with its settings.
  const reloadSettings = async () => {
    const fresh = await chrome.storage.sync.get(SETTINGS_KEYS);
    SETTINGS_KEYS.forEach((k) => { if (k in fresh) settings[k] = fresh[k]; else delete settings[k]; });
    omniDebugMode = !!settings.debug;
    live.swap(window.OmniTime.createApiClient(makeTransport(settings.apiKey), buildEndpoints(settings)));
    if (sidebarWidget) { sidebarWidget.destroy(); sidebarWidget = null; }
    scanForTarget();
  };

  // Presentation mode (per device): while on, the sidebar widget has no
  // chevron at all. Read before the first scan so nothing flashes; if storage
  // can't be read, stay hidden.
  let presenting = await readPresentationMode();

  // The quick-track widget (sidebar-widget.js) under the time-tracking
  // section. GitLab re-creates the sidebar on navigation, so it is re-attached
  // when its target, its own element or the issue changed (one at a time).
  // It starts collapsed (privacy): `expandState` remembers an expand for the
  // current issue across those re-attaches and resets on another issue.
  let sidebarWidget = null;
  let expandState = { key: null, expanded: false };
  const ensureSidebarWidget = (target) => {
    if (settings.showSidebarWidget === false || !window.OmniTimeSidebar) return;
    const context = buildContext(adapter);
    if (!context.project_id || !context.issue_id) return;
    const key = window.OmniTimeSidebar.issueKey(context);
    if (sidebarWidget && sidebarWidget.isValid(target, key)) return;
    if (sidebarWidget) sidebarWidget.destroy();
    if (expandState.key !== key) expandState = { key, expanded: settings.sidebarStartExpanded === true };
    sidebarWidget = window.OmniTimeSidebar.attach(target, {
      apiClient,
      context,
      ensureStyles,
      heading: () => (adapter.getHeading ? adapter.getHeading(target) : target),
      expanded: expandState.expanded,
      presentation: presenting,
      onToggle: (open) => { expandState.expanded = open; },
      theme: () => (adapter.getTheme ? adapter.getTheme() : 'auto'),
      onOpen: () => openOmniModal(adapter, apiClient, settings, () => sidebarWidget && sidebarWidget.refresh(), reloadSettings),
      // A colleague's name (PMs): the modal on the Week tab with them selected.
      onOpenPerson: (person) => openOmniModal(adapter, apiClient, settings, () => sidebarWidget && sidebarWidget.refresh(), reloadSettings, { activeTab: 'week', person }),
    });
  };

  // Turning presentation mode on collapses an open widget and drops the
  // chevron at once; turning it off brings the (collapsed) chevron back.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(PRESENTATION_KEY in changes)) return;
    presenting = changes[PRESENTATION_KEY].newValue === true;
    if (presenting) expandState.expanded = false;
    if (sidebarWidget) sidebarWidget.setPresentation(presenting);
  });

  const scanForTarget = () => {
    const target = adapter.scanForTarget();
    if (target) {
      if (!target.dataset.omniTimeInjected) {
        target.dataset.omniTimeInjected = 'true';
        attachClick(target, adapter, apiClient, settings, () => sidebarWidget && sidebarWidget.refresh(), reloadSettings);
      }
      ensureSidebarWidget(target);
      return true;
    }
    return false;
  };

  if (!scanForTarget()) log('Target not found immediately. Polling & observing.');

  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (scanForTarget() || attempts > 15) clearInterval(pollInterval);
  }, 1000);

  const observer = new MutationObserver(() => scanForTarget());
  observer.observe(document.body, { childList: true, subtree: true });
}

// Open the modal for the current issue (header click or the sidebar widget).
// `onClose` runs when it closes, so the widget can refresh its numbers;
// `reloadSettings` re-reads the settings after the gear's panel changed some.
// `view` ({ activeTab, person }) opens another tab, e.g. a colleague's week.
function openOmniModal(adapter, apiClient, settings, onClose, reloadSettings, view) {
  if (omniDebugMode) console.log('OmniTime: Opening modal with icalUrl:', settings.icalUrl);
  const context = buildContext(adapter);
  return ensureStyles().then(() => {
    // Set by chrome.storage.onChanged while the dialog is open; the comparison
    // in settingsChanged() catches a write that lands after the panel closed.
    let dirty = false;
    const onStorage = (changes, area) => {
      if (area === 'sync' && window.OmniTime.SETTINGS_WATCHED.some((k) => k in changes)) dirty = true;
    };
    const hasStorageEvents = !!(chrome.storage && chrome.storage.onChanged);
    if (hasStorageEvents) chrome.storage.onChanged.addListener(onStorage);
    const settingsChanged = async () => {
      if (dirty) return true;
      const fresh = await chrome.storage.sync.get(SETTINGS_KEYS);
      return window.OmniTime.settingsDiffer(fresh, settings);
    };
    let modal = null;
    modal = window.OmniTime.openModal({
      apiClient,
      context,
      icalUrl: settings.icalUrl || '',
      // Badge sync: today's total after every My-day load (errors ignored).
      onDayTotal: reportDayTotal,
      activeTab: (view && view.activeTab) || 'issue',
      person: view && view.person,
      // Follow the host app's theme (e.g. GitLab's gl-dark), else the OS.
      theme: () => (adapter.getTheme ? adapter.getTheme() : 'auto'),
      settings: modalSettings(settings),
      settingsUrl,
      // The panel closed: when it changed settings, show them (My day / Week
      // reload, the sidebar widget re-reads its settings).
      onSettingsClosed: async () => {
        if (!reloadSettings || !(await settingsChanged())) return;
        dirty = false;
        await reloadSettings();
        if (modal) modal.applySettings({ settings: modalSettings(settings), icalUrl: settings.icalUrl || '' });
      },
    });
    if (modal && modal.ui) {
      if (onClose) modal.ui.onClose(onClose);
      modal.ui.onClose(() => {
        if (hasStorageEvents) chrome.storage.onChanged.removeListener(onStorage);
        // Closed with the panel still open: the widget still re-reads.
        if (dirty && reloadSettings) reloadSettings();
      });
    }
    return modal;
  });
}

function attachClick(target, adapter, apiClient, settings, onClose, reloadSettings) {
  const trigger = adapter.styleTarget(target);
  trigger.addEventListener('click', (e) => {
    // The quick-track widget lives inside the target (legacy sidebars without
    // an h3 use the whole target as the trigger): its clicks are its own.
    if (e.target && e.target.closest && e.target.closest('omnitime-inline')) return;
    e.preventDefault();
    e.stopPropagation();
    openOmniModal(adapter, apiClient, settings, onClose, reloadSettings);
  });
}

init();
