// options.js - OmniTime settings.
//
// One page, two shells. As the extension's options page it opens in a tab.
// With ?embedded=1&theme=light|dark it is the Settings panel of the modal on
// web pages (core.js "Settings panel" embeds it in an iframe: an extension page
// the service worker trusts, cross-origin to the website). The sign-in and the
// API URL (which decides where the Google token is sent) are only ever changed
// from here, never from the page.
//
// Everything saves as you go: toggles and selects on change, text fields when
// you leave them (blur) or press Enter, after validation (an invalid value shows
// an inline error and is not saved). A small "Saved" status confirms it.

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const EMBEDDED = params.get('embedded') === '1';
  const THEME = params.get('theme');

  // Mode before anything renders: embedded layout, the modal's theme.
  const root = document.documentElement;
  if (EMBEDDED) root.setAttribute('data-embedded', '');
  if (THEME === 'light' || THEME === 'dark') root.setAttribute('data-theme', THEME);

  const $ = (id) => document.getElementById(id);

  // The API URL pre-filled on first run. The production URL isn't part of the
  // code (the dev harness takes it from a git-ignored .env), so: none.
  const DEFAULT_API_URL = '';

  const DEFAULT_TARGET_MINUTES = 480;
  const DEFAULT_REMINDER_TIME = '17:30';
  const PRESENTATION_KEY = 'omnitimePresentationMode'; // chrome.storage.local, per device

  // Keep this compatible with the copies in content.js and background.js for
  // previously saved hosts.
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

  // "h:mm" (or plain hours) -> minutes; null when invalid. 0 disables the target.
  function parseHmm(value) {
    const m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(String(value).trim());
    if (!m) return null;
    const minutes = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    return minutes <= 24 * 60 ? minutes : null;
  }

  function formatHmm(minutes) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function localYmd(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function parseHttpUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null;
    } catch (e) {
      return null;
    }
  }

  // Derive the default endpoint URLs from the tracked-time URL.
  function deriveEndpointDefaults(apiUrl) {
    const base = (apiUrl || '').trim().replace(/\/tracked-time\/?$/, '');
    if (!base) return { myDay: '', frequent: '', search: '', week: '', bookmarks: '', bookmark: '', bookingSuggestions: '', people: '' };
    return {
      myDay: base + '/my-tracked-time',
      frequent: base + '/frequent-issues',
      search: base + '/issue-search',
      week: base + '/my-tracked-week',
      bookmarks: base + '/my-bookmarks',
      bookmark: base + '/bookmark',
      bookingSuggestions: base + '/booking-suggestions',
      people: base + '/people',
    };
  }

  const ENDPOINT_FIELDS = {
    myDay: 'epMyDay', frequent: 'epFrequent', search: 'epSearch', week: 'epWeek',
    bookmarks: 'epBookmarks', bookmark: 'epBookmark', bookingSuggestions: 'epBookingSuggestions',
    people: 'epPeople',
  };

  // Show the value that will actually be used as the placeholder for each field.
  function updateEndpointPlaceholders() {
    const d = deriveEndpointDefaults($('apiUrl').value);
    Object.keys(ENDPOINT_FIELDS).forEach((key) => {
      $(ENDPOINT_FIELDS[key]).placeholder = d[key] || '(derived)';
    });
  }

  // ---- What is stored (the page's own copy, kept up to date by its saves) ----
  const stored = { sync: {}, local: {} };
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- "Saved" status ----
  let statusTimer = null;
  function setStatus(text, kind) {
    const el = $('saveStatus');
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function flashSaved() {
    setStatus('Saved', 'ok');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus('', ''), 2000);
  }
  function showSaveError(message) {
    clearTimeout(statusTimer);
    setStatus(message, 'error');
  }

  async function saveSync(patch) {
    try {
      await chrome.storage.sync.set(patch);
      Object.assign(stored.sync, patch);
      flashSaved();
      return true;
    } catch (e) {
      showSaveError('Not saved: ' + ((e && e.message) || 'storage error'));
      return false;
    }
  }

  // ---- Inline field errors ----
  // Fields with an error element in the HTML use it; the others get one.
  function errorElement(input) {
    const id = input.id ? `${input.id}Error` : '';
    let el = id ? $(id) : null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'field-error';
      el.setAttribute('role', 'alert');
      if (id) el.id = id;
      input.insertAdjacentElement('afterend', el);
      if (id) input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    }
    return el;
  }
  function setFieldError(input, message) {
    errorElement(input).textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  // A text field that saves when you leave it (blur / change) or press Enter.
  // parse(raw) -> { ok: true, patch, after? } | { ok: false, message };
  // `patch` goes to storage.sync. Nothing is written for an invalid value or
  // one that is already saved.
  const committed = new WeakMap(); // input -> JSON of the patch last saved/loaded
  function bindText(input, parse) {
    const commit = async () => {
      const r = parse(input.value);
      if (!r.ok) {
        setFieldError(input, r.message);
        return false;
      }
      setFieldError(input, '');
      const key = JSON.stringify(r.patch);
      const before = committed.get(input);
      if (key === before) return true; // also the second of change + blur
      committed.set(input, key);
      if (!(await saveSync(r.patch))) {
        if (before === undefined) committed.delete(input); else committed.set(input, before);
        return false;
      }
      if (r.after) r.after();
      return true;
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) commit(); });
    // What is shown at load counts as saved.
    const initial = parse(input.value);
    if (initial.ok) committed.set(input, JSON.stringify(initial.patch));
    return commit;
  }

  // A checkbox that saves on change.
  function bindToggle(id, key, save) {
    $(id).addEventListener('change', () => {
      const value = $(id).checked;
      if (save) save(value); else saveSync({ [key]: value });
    });
  }

  const urlParser = (key, example) => (raw) => {
    const v = raw.trim();
    if (v && !parseHttpUrl(v)) return { ok: false, message: `Enter a full URL, e.g. ${example}` };
    return { ok: true, patch: { [key]: v } };
  };

  // ---- Setup checklist ("Get started") ----
  const setup = { signedIn: false, wasIncomplete: false };
  function refreshSetup() {
    const steps = {
      stepSignIn: setup.signedIn,
      stepApi: !!(stored.sync.apiUrl && String(stored.sync.apiUrl).trim()),
      stepSite: Array.isArray(stored.sync.instances) && stored.sync.instances.some((i) => i && i.hostUrl),
    };
    Object.keys(steps).forEach((id) => {
      const li = $(id);
      li.classList.toggle('step--done', steps[id]);
      li.querySelector('.step__state').textContent = steps[id] ? '(done)' : '(to do)';
      li.querySelectorAll('.step__action').forEach((a) => { a.hidden = steps[id]; });
    });
    const all = Object.values(steps).every(Boolean);
    const section = $('getStarted');
    if (!all) {
      setup.wasIncomplete = true;
      section.hidden = false;
      $('setupSteps').hidden = false;
      $('setupDone').hidden = true;
    } else if (setup.wasIncomplete) {
      // Said once, right when the last step is done; gone on the next visit.
      section.hidden = false;
      $('setupSteps').hidden = true;
      $('setupDone').hidden = false;
    } else {
      section.hidden = true;
    }
  }

  // ---- Section navigation ----
  const SECTION_IDS = ['secConnection', 'secSites', 'secCalendar', 'secMyDay', 'secNotifications', 'secMeetings', 'secAdvanced', 'secAbout'];

  function setActiveSection(id) {
    document.querySelectorAll('#sectionNav a').forEach((a) => {
      if (a.dataset.section === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    if ($('sectionPicker').value !== id) $('sectionPicker').value = id;
  }

  function goToSection(id) {
    const section = $(id);
    if (!section) return;
    section.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    setActiveSection(id);
    const heading = section.querySelector('h2');
    if (heading) heading.focus({ preventScroll: true });
  }

  // The active section is the last one whose top has passed the sticky bar;
  // at the very bottom it is the last section (short ones never reach the bar).
  function updateActiveSection() {
    const offset = document.querySelector('.topbar').getBoundingClientRect().height + 24;
    let active = SECTION_IDS[0];
    SECTION_IDS.forEach((id) => {
      if ($(id).getBoundingClientRect().top <= offset) active = id;
    });
    const doc = document.documentElement;
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2 && doc.scrollHeight > window.innerHeight) {
      active = SECTION_IDS[SECTION_IDS.length - 1];
    }
    setActiveSection(active);
  }

  function setupNavigation() {
    document.querySelectorAll('#sectionNav a').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        goToSection(a.dataset.section);
      });
    });
    $('sectionPicker').addEventListener('change', () => goToSection($('sectionPicker').value));
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(() => { queued = false; updateActiveSection(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    updateActiveSection();
  }

  // ---- Sites ----
  function createInstanceRow(hostUrl = '', systemType = 'gitlab') {
    const container = $('instances');
    const div = document.createElement('div');
    div.className = 'instance';
    const inputHost = document.createElement('input');
    inputHost.type = 'text';
    inputHost.className = 'host-url';
    inputHost.placeholder = 'gitlab.company.com';
    inputHost.setAttribute('aria-label', 'Instance host');
    inputHost.setAttribute('autocomplete', 'off');
    inputHost.setAttribute('spellcheck', 'false');
    inputHost.value = hostUrl;
    // The valid host this row saved (or loaded with); '' = nothing to save.
    div.dataset.committed = normalizeInstanceHost(hostUrl) || '';

    const select = document.createElement('select');
    select.className = 'system-type';
    select.setAttribute('aria-label', 'System type');
    const optionGitlab = document.createElement('option');
    optionGitlab.value = 'gitlab';
    optionGitlab.textContent = 'GitLab';
    if (systemType === 'gitlab') optionGitlab.selected = true;
    select.appendChild(optionGitlab);

    const btnRemove = document.createElement('button');
    btnRemove.className = 'remove-instance';
    btnRemove.type = 'button';
    btnRemove.textContent = 'Remove';

    const msg = document.createElement('div');
    msg.className = 'instance__msg';
    msg.setAttribute('role', 'status');

    div.appendChild(inputHost);
    div.appendChild(select);
    div.appendChild(btnRemove);
    div.appendChild(msg);
    container.appendChild(div);

    const commitHost = async () => {
      const raw = inputHost.value.trim();
      if (!raw) {
        setFieldError(inputHost, '');
        if (div.dataset.committed) { div.dataset.committed = ''; await saveSites(); }
        return;
      }
      const host = normalizeInstanceHost(raw);
      if (!host) {
        setFieldError(inputHost, 'Enter a host such as gitlab.com, or a full http(s) URL.');
        return;
      }
      setFieldError(inputHost, '');
      inputHost.value = host;
      if (div.dataset.committed === host) return;
      div.dataset.committed = host;
      if (await saveSites()) await ensureAccess(div, host, false);
    };
    inputHost.addEventListener('change', commitHost);
    inputHost.addEventListener('blur', commitHost);
    inputHost.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) commitHost(); });
    select.addEventListener('change', () => { if (div.dataset.committed) saveSites(); });
    btnRemove.addEventListener('click', async () => {
      div.remove();
      if (!document.querySelector('.instance')) createInstanceRow();
      await saveSites();
    });
    return div;
  }

  // The content script is registered for exactly the saved hosts.
  async function registerContentScripts(origins) {
    // We unregister everything first to be clean, then register for the new list
    await chrome.scripting.unregisterContentScripts({ ids: ['omnitime-cs'] }).catch(() => { });
    if (origins.length > 0) {
      await chrome.scripting.registerContentScripts([{
        id: 'omnitime-cs',
        matches: origins,
        // No css: the modal's styles live in its shadow root (OMNI_GET_STYLES).
        js: ['adapters/gitlab.js', 'ical-parser.js', 'timer.js', 'core.js', 'sidebar-widget.js', 'content.js'],
        runAt: 'document_idle'
      }]);
    }
  }

  // Saves every row that holds a valid host, then registers the scripts.
  async function saveSites() {
    const instances = [];
    const origins = [];
    document.querySelectorAll('.instance').forEach((row) => {
      const hostUrl = row.dataset.committed;
      if (!hostUrl) return;
      instances.push({ hostUrl, systemType: row.querySelector('.system-type').value });
      origins.push(`*://${hostUrl}/*`);
    });
    if (!(await saveSync({ instances }))) return false;
    refreshSetup();
    try {
      await registerContentScripts(origins);
    } catch (err) {
      console.error('Script registration failed:', err);
      showSaveError('Saved, but the scripts could not be registered: ' + err.message);
      return false;
    }
    return true;
  }

  // ---- Host access ----
  // The manifest asks for all hosts up front, but a browser can withhold them
  // ("on click" site access). chrome.permissions.request needs a user gesture,
  // so the "Grant access" button calls it straight from its click handler.
  function hasAccess(pattern) {
    return new Promise((resolve) => {
      if (!chrome.permissions || !chrome.permissions.contains) { resolve(null); return; }
      try {
        chrome.permissions.contains({ origins: [pattern] }, (granted) => resolve(chrome.runtime.lastError ? null : !!granted));
      } catch (e) { resolve(null); }
    });
  }

  // 'granted' | 'denied' (the user said no) | 'refused' (the browser would not ask, e.g. here).
  function requestAccess(pattern) {
    return new Promise((resolve) => {
      try {
        chrome.permissions.request({ origins: [pattern] }, (granted) => {
          if (chrome.runtime.lastError) resolve('refused');
          else resolve(granted ? 'granted' : 'denied');
        });
      } catch (e) {
        resolve('refused');
      }
    });
  }

  function setRowMessage(row, text, kind, action) {
    const msg = row.querySelector('.instance__msg');
    msg.textContent = '';
    msg.className = 'instance__msg' + (kind ? ' ' + kind : '');
    if (text) msg.appendChild(document.createTextNode(text));
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      msg.appendChild(document.createTextNode(' '));
      msg.appendChild(btn);
    }
  }

  function showNeedsAccess(row, host, outcome) {
    const pattern = `*://${host}/*`;
    if (outcome === 'refused' && EMBEDDED) {
      setRowMessage(row, "Your browser can't ask for access from here.", 'error', {
        label: 'Open in a tab to grant access',
        onClick: () => chrome.runtime.openOptionsPage(),
      });
      return;
    }
    const text = outcome === 'denied'
      ? "Access was not granted: OmniTime can't run on this site."
      : 'OmniTime needs your permission to run on this site.';
    setRowMessage(row, text, 'error', {
      label: 'Grant access',
      // The request is the first thing the click does (user gesture).
      onClick: () => {
        const pending = requestAccess(pattern);
        pending.then((result) => {
          if (result === 'granted') setRowMessage(row, 'Access granted.', 'ok');
          else showNeedsAccess(row, host, result);
        });
      },
    });
  }

  // After a host was saved (tryRequest) or at load: show what is missing only.
  async function ensureAccess(row, host, atLoad) {
    const pattern = `*://${host}/*`;
    const has = await hasAccess(pattern);
    if (has === true) { setRowMessage(row, '', ''); return; }
    if (has === null && atLoad) return; // can't tell: say nothing
    if (atLoad) { showNeedsAccess(row, host, null); return; }
    const result = await requestAccess(pattern);
    if (result === 'granted') setRowMessage(row, 'Access granted.', 'ok');
    else showNeedsAccess(row, host, result);
  }

  // ---- Google account ----
  function renderGoogleAccount(userInfo, signedIn) {
    const loggedInWrap = $('googleLoggedInWrap');
    const loggedOutWrap = $('googleLoggedOutWrap');
    const nameEl = $('googleUserName');
    const emailEl = $('googleUserEmail');
    const avatarEl = $('googleUserAvatar');
    const fallbackEl = $('googleAvatarFallback');
    setup.signedIn = !!signedIn;
    refreshSetup();

    if (signedIn) {
      loggedInWrap.style.display = 'block';
      loggedOutWrap.style.display = 'none';
      if (userInfo && userInfo.email) {
        nameEl.textContent = userInfo.name || userInfo.email.split('@')[0];
        emailEl.textContent = userInfo.email;
        if (userInfo.picture) {
          avatarEl.src = userInfo.picture;
          avatarEl.style.display = 'block';
          fallbackEl.style.display = 'none';
        } else {
          avatarEl.style.display = 'none';
          fallbackEl.style.display = 'flex';
          fallbackEl.textContent = (userInfo.name || userInfo.email)[0].toUpperCase();
        }
      } else {
        nameEl.textContent = 'Google Account Connected';
        emailEl.textContent = 'Fetching account details...';
        avatarEl.style.display = 'none';
        fallbackEl.style.display = 'flex';
      }
    } else {
      loggedInWrap.style.display = 'none';
      loggedOutWrap.style.display = 'block';
      const statusEl = $('googleAuthStatus');
      statusEl.textContent = 'Not signed in';
      statusEl.className = '';
    }
  }

  function googleLogin() {
    const statusEl = $('googleAuthStatus');
    statusEl.textContent = 'Signing in...';
    statusEl.className = '';
    chrome.runtime.sendMessage({ action: 'OMNI_GOOGLE_LOGIN' }, (res) => {
      if (res && res.success) {
        renderGoogleAccount(res.userInfo, true);
      } else {
        statusEl.textContent = 'Failed: ' + (res ? res.error : 'Unknown error');
        statusEl.className = 'error';
      }
    });
  }

  // Signing out asks for confirmation in place: browsers block the built-in
  // dialogs (alert, confirm) in a frame embedded in another origin's page.
  function setLogoutConfirm(open) {
    $('logoutConfirm').hidden = !open;
    $('googleLogoutBtn').hidden = open;
    (open ? $('logoutYes') : $('googleLogoutBtn')).focus();
  }

  // ---- Test connection ----
  function describeTestResult(res) {
    if (!res) return { ok: false, text: 'Network error: no response from the extension.' };
    if (res.success) {
      const d = res.data || {};
      const email = d.email || (d.user && (d.user.email || d.user.mail)) || '';
      return { ok: true, text: email ? `OK. Signed in as ${email}.` : 'OK. Connected to the API.' };
    }
    if (res.status === 403) return { ok: false, text: "Not signed in, or this account isn't allowed (HTTP 403)." };
    if (res.status) return { ok: false, text: `The server answered HTTP ${res.status}.` };
    return { ok: false, text: 'Network error: ' + (res.error || 'could not reach the server.') };
  }

  function testConnectionUrl() {
    const cleanUrl = (url) => (url || '').trim().replace(/([^:])\/{2,}/g, '$1/');
    const base = cleanUrl($('apiUrl').value).replace(/\/tracked-time\/?$/, '');
    const override = cleanUrl($('epMyDay').value);
    const endpoint = override || (base ? base + '/my-tracked-time' : '');
    if (!endpoint) return '';
    return endpoint + (endpoint.includes('?') ? '&' : '?') + '_format=json&date=' + localYmd();
  }

  // ---- Remembered meetings ----
  async function loadMeetings() {
    const local = await chrome.storage.local.get(['omnitimeCalIssues']);
    renderMeetings(local.omnitimeCalIssues);
  }

  function meetingTitle(key, entry) {
    if (entry && entry.title) return entry.title;
    if (key.startsWith('title:')) return key.slice('title:'.length);
    return 'Calendar event';
  }

  function renderMeetings(map) {
    const list = $('meetingList');
    const keys = Object.keys(map || {});
    list.textContent = '';
    $('meetingEmpty').style.display = keys.length ? 'none' : '';
    $('forgetAll').style.display = keys.length ? '' : 'none';
    keys.forEach((key) => {
      const entry = map[key] || {};
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'meeting-info';
      const title = document.createElement('div');
      title.className = 'meeting-title';
      title.textContent = meetingTitle(key, entry);
      const issue = document.createElement('div');
      issue.className = 'meeting-issue';
      issue.textContent = entry.label || (entry.id !== undefined ? `Issue ${entry.id}` : '');
      info.appendChild(title);
      info.appendChild(issue);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'forget';
      btn.textContent = 'Forget';
      btn.setAttribute('aria-label', 'Forget ' + title.textContent);
      btn.addEventListener('click', () => forgetMeeting(key));
      li.appendChild(info);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // Only the series -> issue memory is touched; omnitimeCalLinks is left alone.
  async function forgetMeeting(key) {
    const local = await chrome.storage.local.get(['omnitimeCalIssues']);
    const map = Object.assign({}, local.omnitimeCalIssues);
    delete map[key];
    await chrome.storage.local.set({ omnitimeCalIssues: map });
    renderMeetings(map);
  }

  // Presentation mode is per device (chrome.storage.local) and takes effect at
  // once, like every other setting here: a privacy switch must not wait.
  function renderPresentation(on) {
    $('presentationMode').checked = on;
    $('presentationNote').hidden = !on;
  }

  // ---- Wiring (once the DOM is there) ----
  document.addEventListener('DOMContentLoaded', async () => {
    const settings = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'instances', 'debug', 'icalUrl', 'dayStart', 'dayEnd', 'useGoogleCalendar', 'endpoints', 'dailyTargetMinutes', 'showBadge', 'showSidebarWidget', 'sidebarStartExpanded', 'reminderEnabled', 'reminderTime']);
    Object.assign(stored.sync, settings);

    if (settings.debug) $('debugMode').checked = settings.debug;
    if (settings.icalUrl) $('icalUrl').value = settings.icalUrl;
    if (settings.dayStart !== undefined) $('dayStart').value = settings.dayStart;
    if (settings.dayEnd !== undefined) $('dayEnd').value = settings.dayEnd;
    if (settings.useGoogleCalendar) $('useGoogleCalendar').checked = settings.useGoogleCalendar;
    $('dailyTarget').value = formatHmm(
      Number.isFinite(settings.dailyTargetMinutes) ? settings.dailyTargetMinutes : DEFAULT_TARGET_MINUTES);
    $('showBadge').checked = settings.showBadge !== false;
    $('showSidebarWidget').checked = settings.showSidebarWidget !== false;
    $('sidebarStartExpanded').checked = settings.sidebarStartExpanded === true;
    $('reminderEnabled').checked = settings.reminderEnabled === true;
    $('reminderTime').value = /^\d{2}:\d{2}$/.test(settings.reminderTime || '')
      ? settings.reminderTime : DEFAULT_REMINDER_TIME;
    $('aboutVersion').textContent = chrome.runtime.getManifest().version;

    // The access token itself is never visible here: only the sign-in state.
    const local = await chrome.storage.local.get(['googleSignedIn', 'googleUserInfo', PRESENTATION_KEY]);
    renderPresentation(local[PRESENTATION_KEY] === true);
    renderGoogleAccount(local.googleUserInfo, !!local.googleSignedIn);
    if (local.googleSignedIn) {
      chrome.runtime.sendMessage({ action: 'OMNI_GET_GOOGLE_USER' }, (res) => {
        if (res && res.success && res.userInfo) {
          renderGoogleAccount(res.userInfo, true);
        }
      });
    }

    // Migration or Loading
    const url = settings.apiUrl || '';
    if (url) {
      $('apiUrl').value = url;
    } else if (settings.apiUrl === undefined && DEFAULT_API_URL) {
      $('apiUrl').value = DEFAULT_API_URL;
      stored.sync.apiUrl = DEFAULT_API_URL;
      chrome.storage.sync.set({ apiUrl: DEFAULT_API_URL });
    }

    if (settings.apiKey) $('apiKey').value = settings.apiKey;

    if (settings.instances && settings.instances.length > 0) {
      settings.instances.forEach((inst) => {
        const row = createInstanceRow(inst.hostUrl, inst.systemType);
        if (row.dataset.committed) ensureAccess(row, row.dataset.committed, true);
      });
    } else {
      createInstanceRow(); // Add one empty row by default
    }

    // Endpoint overrides (blank = derive from the tracked-time URL).
    const eps = settings.endpoints || {};
    Object.keys(ENDPOINT_FIELDS).forEach((key) => { if (eps[key]) $(ENDPOINT_FIELDS[key]).value = eps[key]; });
    updateEndpointPlaceholders();
    $('apiUrl').addEventListener('input', updateEndpointPlaceholders);

    // An API key is only relevant for legacy setups: open Advanced when one is set.
    if (settings.apiKey) $('advLegacy').open = true;

    // --- Autosave: text fields (blur / Enter, validated) ---
    bindText($('apiUrl'), (raw) => {
      const r = urlParser('apiUrl', 'https://example.com/api/v1/tracked-time')(raw);
      if (r.ok) r.after = () => { updateEndpointPlaceholders(); refreshSetup(); };
      return r;
    });
    bindText($('icalUrl'), urlParser('icalUrl', 'https://calendar.example.com/ical/basic.ics'));
    bindText($('apiKey'), (raw) => ({ ok: true, patch: { apiKey: raw.trim() } }));

    // Day block: whole hours; the end has to come after the start.
    const hour = (key, fallback, min, max) => (raw) => {
      const v = raw.trim();
      if (v === '') return { ok: true, patch: { [key]: fallback } };
      const n = /^\d{1,2}$/.test(v) ? parseInt(v, 10) : NaN;
      if (!(n >= min && n <= max)) return { ok: false, message: `Enter an hour from ${min} to ${max}.` };
      // Against the other hour as saved (an invalid draft in its field is not a value).
      const o = key === 'dayStart' ? (stored.sync.dayEnd !== undefined ? stored.sync.dayEnd : 17) : (stored.sync.dayStart !== undefined ? stored.sync.dayStart : 8);
      if (key === 'dayStart' && n >= o) return { ok: false, message: 'The start has to be before the end hour.' };
      if (key === 'dayEnd' && n <= o) return { ok: false, message: 'The end has to be after the start hour.' };
      return { ok: true, patch: { [key]: n } };
    };
    bindText($('dayStart'), hour('dayStart', 8, 0, 23));
    bindText($('dayEnd'), hour('dayEnd', 17, 1, 24));
    bindText($('dailyTarget'), (raw) => {
      const minutes = parseHmm(raw);
      if (minutes === null) return { ok: false, message: 'Enter the target as h:mm, e.g. 8:00 (0:00 disables it).' };
      return { ok: true, patch: { dailyTargetMinutes: minutes } };
    });
    bindText($('reminderTime'), (raw) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) return { ok: false, message: 'Enter a time as HH:MM.' };
      return { ok: true, patch: { reminderTime: raw } };
    });
    Object.keys(ENDPOINT_FIELDS).forEach((key) => {
      bindText($(ENDPOINT_FIELDS[key]), (raw) => {
        const v = raw.trim();
        if (v && !parseHttpUrl(v)) return { ok: false, message: 'Enter a full URL, or leave it blank to derive it.' };
        const endpoints = Object.assign({}, stored.sync.endpoints);
        if (v) endpoints[key] = v; else delete endpoints[key];
        return { ok: true, patch: { endpoints } };
      });
    });

    // --- Autosave: toggles ---
    bindToggle('useGoogleCalendar', 'useGoogleCalendar');
    bindToggle('showSidebarWidget', 'showSidebarWidget');
    bindToggle('sidebarStartExpanded', 'sidebarStartExpanded');
    bindToggle('showBadge', 'showBadge');
    bindToggle('reminderEnabled', 'reminderEnabled');
    bindToggle('debugMode', 'debug');
    bindToggle('presentationMode', null, (on) => {
      renderPresentation(on);
      chrome.storage.local.set({ [PRESENTATION_KEY]: on });
      flashSaved();
    });

    // --- Sites, account, connection ---
    $('addInstance').addEventListener('click', () => createInstanceRow().querySelector('.host-url').focus());
    $('googleLoginBtn').addEventListener('click', googleLogin);
    $('googleLogoutBtn').addEventListener('click', () => setLogoutConfirm(true));
    $('logoutNo').addEventListener('click', () => setLogoutConfirm(false));
    $('logoutYes').addEventListener('click', () => {
      const yes = $('logoutYes');
      yes.disabled = true;
      yes.textContent = 'Signing out...';
      chrome.runtime.sendMessage({ action: 'OMNI_GOOGLE_LOGOUT' }, () => {
        yes.disabled = false;
        yes.textContent = 'Yes, sign out';
        $('logoutConfirm').hidden = true;
        $('googleLogoutBtn').hidden = false;
        renderGoogleAccount(null, false);
      });
    });

    // The checklist's actions take you to the field.
    const focusField = (id) => {
      const el = typeof id === 'string' ? $(id) : id;
      el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    };
    // One sign-in button only (in Connection); step 1 takes you to it.
    $('setupSignIn').addEventListener('click', () => focusField('googleLoginBtn'));
    $('setupApi').addEventListener('click', () => focusField('apiUrl'));
    $('setupSite').addEventListener('click', () => {
      const empty = [...document.querySelectorAll('.host-url')].find((i) => !i.value.trim());
      focusField(empty || createInstanceRow().querySelector('.host-url'));
    });

    $('testConnection').addEventListener('click', () => {
      const resultEl = $('testResult');
      const btn = $('testConnection');
      const testUrl = testConnectionUrl();
      if (!testUrl) {
        resultEl.textContent = 'Enter the API URL first.';
        resultEl.className = 'error';
        return;
      }
      btn.disabled = true;
      resultEl.textContent = 'Testing...';
      resultEl.className = '';
      const apiKey = $('apiKey').value.trim();
      chrome.runtime.sendMessage({ action: 'OMNI_FETCH', method: 'GET', url: testUrl, apiKey }, (res) => {
        btn.disabled = false;
        const r = describeTestResult(chrome.runtime.lastError ? null : res);
        resultEl.textContent = r.text;
        resultEl.className = r.ok ? 'ok' : 'error';
      });
    });

    $('forgetAll').addEventListener('click', async () => {
      await chrome.storage.local.set({ omnitimeCalIssues: {} });
      renderMeetings({});
    });

    await loadMeetings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.omnitimeCalIssues) renderMeetings(changes.omnitimeCalIssues.newValue);
      // The toolbar menu can flip it while this page is open.
      if (changes[PRESENTATION_KEY]) renderPresentation(changes[PRESENTATION_KEY].newValue === true);
      // Signed in or out elsewhere (another page; the token expired for good).
      if (changes.googleSignedIn) {
        chrome.storage.local.get(['googleSignedIn', 'googleUserInfo'], (l) => renderGoogleAccount(l && l.googleUserInfo, !!(l && l.googleSignedIn)));
      }
    });

    // --- Navigation, checklist, embedded extras ---
    setupNavigation();
    refreshSetup();

    if (EMBEDDED) {
      $('openInTab').hidden = false;
      $('openInTab').addEventListener('click', () => chrome.runtime.openOptionsPage());
      // The privacy policy is not web-accessible under the frame's dynamic URL:
      // let the browser open the real one.
      $('privacyLink').addEventListener('click', (e) => {
        if (!(chrome.tabs && chrome.tabs.create)) return;
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL('privacy_policy.md') });
      });
      // Lets Tab start at the top, and the dialog's Escape layer be asked below.
      $('content').focus({ preventScroll: true });
    }
  });

  // Escape: cancels an open "Sign out of Google?" first; in the embedded panel anything
  // else closes the panel - the page's keys never reach the frame, so the
  // dialog hears of it through the service worker (OMNI_SETTINGS_CLOSE), never
  // window.postMessage.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    const confirm = $('logoutConfirm');
    if (confirm && !confirm.hidden) {
      e.preventDefault();
      setLogoutConfirm(false);
      return;
    }
    if (EMBEDDED) chrome.runtime.sendMessage({ action: 'OMNI_SETTINGS_CLOSE' }, () => void chrome.runtime.lastError);
  });
})();
