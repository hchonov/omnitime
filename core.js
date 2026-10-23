// core.js - Transport-agnostic OmniTime UI (modal, tabs, My day timeline,
// new-entry form, frequent chips). No direct chrome.* calls for transport or
// mounting: the production glue (content.js, overlay-dashboard.js) and the dev
// harness inject a `transport` function and the stylesheet text (setStyles).
// The UI is mounted in a shadow root, closed in production (see "Mounting" below); the only
// chrome.* use here is chrome.storage for the calendar cache/memory.

(function () {
  if (window.OmniTime) {
    return;
  }

  // --- Timeline constants ---
  const PX_PER_MIN = 1.2;          // base scale for empty time
  const MIN_ENTRY_H = 36;          // min height so an entry's 2 lines are readable
  const DAY_START_DEFAULT = 7 * 60;
  const DAY_END_DEFAULT = 20 * 60;
  const SNAP = 5;
  const MIN_DUR = 5;
  const MAX_DUR = 240;
  const DEFAULT_DUR = 15;
  // The quick durations of the form: the same five as the GitLab sidebar
  // widget's quick row (sidebar-widget.js BUTTONS; a test keeps them in step).
  const QUICK_DURATIONS = [
    { minutes: 5, label: '5m', name: '5 minutes' },
    { minutes: 10, label: '10m', name: '10 minutes' },
    { minutes: 15, label: '15m', name: '15 minutes' },
    { minutes: 30, label: '30m', name: '30 minutes' },
    { minutes: 60, label: '1h', name: '1 hour' },
  ];

  // Status codes that mean "the new API is not (yet) available on the server".
  const UNAVAILABLE = [404, 501];

  // --- Helpers ---
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDur = (m) => `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  const fmtClock = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  const parseClock = (s) => {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/(?:^|\s|T)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const snap = (m) => Math.round(m / SNAP) * SNAP;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const prettyDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  };
  const elem = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  // --- Inline outline icons (no webfont dependency on the host page) ---
  const ICON_PATHS = {
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 9.5h18"/><circle cx="16" cy="14" r="1.4" fill="currentColor" stroke="none"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    play: '<path d="M6 4l13 8-13 8V4z" fill="currentColor" stroke="none"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    resize: '<path d="M8 8l4-4 4 4M8 16l4 4 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
    chevronRight: '<path d="M9 18l6-6-6-6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    week: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 9.5v11M13 9.5v11M18 9.5v11"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  };
  const icon = (name) => `<svg class="ot-svg ot-svg--${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

  // --- API client ---
  // `urls` may be a string (the tracked-time endpoint, siblings derived) or an
  // object { trackedTime, myDay, frequent, search, week, bookmarks, bookmark,
  // bookingSuggestions, people } with any subset overridden.
  function resolveEndpoints(urls) {
    const cfg = typeof urls === 'string' ? { trackedTime: urls } : (urls || {});
    let tracked = (cfg.trackedTime || cfg.apiUrl || '').trim();
    tracked = tracked.replace(/([^:])\/{2,}/g, '$1/');
    const base = tracked.replace(/\/tracked-time\/?(\?.*)?$/, '');
    const clean = (url) => url.replace(/([^:])\/{2,}/g, '$1/');
    return {
      trackedTime: tracked,
      myDay: clean(cfg.myDay || base + '/my-tracked-time'),
      frequent: clean(cfg.frequent || base + '/frequent-issues'),
      search: clean(cfg.search || base + '/issue-search'),
      week: clean(cfg.week || base + '/my-tracked-week'),
      bookmarks: clean(cfg.bookmarks || base + '/my-bookmarks'),
      bookmark: clean(cfg.bookmark || base + '/bookmark').replace(/\/+$/, ''),
      bookingSuggestions: clean(cfg.bookingSuggestions || base + '/booking-suggestions'),
      people: clean(cfg.people || base + '/people'),
    };
  }

  function withParams(url, params) {
    const parts = ['_format=json'];
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    });
    return url + (url.includes('?') ? '&' : '?') + parts.join('&');
  }

  function createApiClient(transport, urls) {
    const e = resolveEndpoints(urls);
    const base = (e.trackedTime || '').replace(/\/tracked-time\/?(\?.*)?$/, '');
    const timeEntry = e.timeEntry || base + '/time-entry';
    return {
      issueTime: (ctx) => transport('GET', withParams(e.trackedTime, { source: ctx.source, project_id: ctx.project_id, issue_id: ctx.issue_id })),
      myDay: (date) => transport('GET', withParams(e.myDay, { date })),
      frequent: () => transport('GET', withParams(e.frequent)),
      search: (q) => transport('GET', withParams(e.search, { q })),
      create: (payload) => transport('POST', withParams(e.trackedTime), payload),
      update: (id, payload) => transport('PATCH', withParams(timeEntry + '/' + id), payload),
      remove: (id) => transport('DELETE', withParams(timeEntry + '/' + id)),
      // Monday-Sunday week around `date` incl. the caller's absences (personal
      // data: keep in memory only). opts.ifNoneMatch is passed to the transport
      // as a request header for transports that support it (the extension's
      // OMNI_FETCH doesn't; the UI caches per week in memory instead).
      // opts.uid: another person's week (needs the "view all time trackings"
      // permission; the server answers 403 / 404 otherwise).
      week: (date, opts) => {
        const tag = opts && opts.ifNoneMatch;
        const url = withParams(e.week, { date, uid: opts && opts.uid });
        return tag ? transport('GET', url, undefined, { headers: { 'If-None-Match': tag } }) : transport('GET', url);
      },
      // Colleagues to pick in the Week tab: { people: [{ uid, name }] } for >= 2
      // typed characters (permission as above).
      people: (q) => transport('GET', withParams(e.people, { q })),
      bookmarks: () => transport('GET', withParams(e.bookmarks)),
      bookmark: (issueInternalId) => transport('POST', withParams(e.bookmark), { issue_internal_id: Number(issueInternalId) }),
      unbookmark: (issueInternalId) => transport('DELETE', withParams(e.bookmark + '/' + encodeURIComponent(issueInternalId))),
      // Issues the caller booked a meeting on before: { preselected, suggestions,
      // history_count } for a calendar event's title + start (HH:MM) on `date`.
      bookingSuggestions: ({ title, start, date }) => transport('GET', withParams(e.bookingSuggestions, { title, start, date })),
    };
  }

  // chrome.storage.sync keys that change what an open dialog or the sidebar
  // widget shows (dayStart ... endpoints), and a deep comparison over them.
  const SETTINGS_WATCHED = ['dayStart', 'dayEnd', 'dailyTargetMinutes', 'useGoogleCalendar', 'icalUrl',
    'showSidebarWidget', 'sidebarStartExpanded', 'apiUrl', 'endpoints'];
  const settingsDiffer = (a, b) => SETTINGS_WATCHED.some((k) => JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k]));

  function createSwappableClient(initial) {
    let target = initial;
    const client = {};
    Object.keys(initial).forEach((name) => { client[name] = (...args) => target[name](...args); });
    return { client, swap: (next) => { target = next; } };
  }

  const isUnavailable = (err) => err && UNAVAILABLE.includes(err.status);

  // Detect (once per page) whether the server has the new API. A definitive
  // answer (success, or an "unavailable" status) is cached; transient/network
  // errors are not cached so the next open re-probes.
  let apiCapable;
  let capabilityProbe;
  function detectCapability(apiClient) {
    if (apiCapable !== undefined) return Promise.resolve(apiCapable);
    if (!capabilityProbe) {
      capabilityProbe = apiClient.myDay(todayStr())
        .then(() => { apiCapable = true; return true; })
        .catch((err) => {
          if (isUnavailable(err)) { apiCapable = false; return false; }
          capabilityProbe = null;
          return false;
        });
    }
    return capabilityProbe;
  }

  // --- Calendar memory (chrome.storage.local: this browser only) ---
  // links:  occurrence key -> { entryId, date } - the booking made from a
  //         calendar event, so the event is hidden wherever the booking went.
  // issues: series key -> { id, label, title, project?, history } - the issue
  //         last picked for a (recurring) event, preselected the next time it
  //         is clicked. `history` ([{ id, label, project?, at }], newest first,
  //         max CAL_HISTORY_MAX) lists every issue the event was booked on:
  //         the offline source of the booking suggestions. It is local-only
  //         and capped (privacy policy: "remembered meeting issues, max 30 per
  //         meeting, stored in this browser only"). Meeting titles can name
  //         people, so a series nobody booked for CAL_ISSUE_DAYS (180) is
  //         forgotten on the next write (`at` = last booking; legacy entries
  //         get stamped), and at most CAL_ISSUES_MAX (300) series are kept.
  const CAL_LINK_DAYS = 60;
  const CAL_HISTORY_MAX = 30;
  const CAL_ISSUE_DAYS = 180;
  const CAL_ISSUES_MAX = 300;
  const hasLocalStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  function loadCalMemory() {
    if (!hasLocalStorage()) return Promise.resolve({ links: {}, issues: {} });
    return new Promise((resolve) => {
      chrome.storage.local.get(['omnitimeCalLinks', 'omnitimeCalIssues'], (r) => resolve({
        links: (r && r.omnitimeCalLinks) || {},
        issues: (r && r.omnitimeCalIssues) || {},
      }));
    });
  }
  // Writes are a read-modify-write: they run one after the other, or two
  // callers in the same page (e.g. an id adoption and a booking) could
  // overwrite each other's change.
  let calWrites = Promise.resolve();
  function updateCalMemory(change) {
    const run = calWrites.then(() => doUpdateCalMemory(change));
    calWrites = run.catch(() => {});
    return run;
  }
  function doUpdateCalMemory(change) {
    if (!hasLocalStorage()) return Promise.resolve();
    return loadCalMemory().then((mem) => {
      change(mem);
      // Links only matter while the day is still being looked at.
      const now = Date.now();
      const cutoff = new Date(now - CAL_LINK_DAYS * 864e5).toISOString().slice(0, 10);
      Object.keys(mem.links).forEach((k) => { if (mem.links[k].date < cutoff) delete mem.links[k]; });
      // Remembered issues expire (see above).
      const nowIso = new Date(now).toISOString();
      const issueCutoff = new Date(now - CAL_ISSUE_DAYS * 864e5).toISOString();
      Object.keys(mem.issues).forEach((k) => {
        const entry = mem.issues[k];
        if (!entry || typeof entry !== 'object') { delete mem.issues[k]; return; }
        if (!entry.at) entry.at = (entry.history && entry.history[0] && entry.history[0].at) || nowIso;
        if (entry.at < issueCutoff) delete mem.issues[k];
      });
      const keys = Object.keys(mem.issues);
      if (keys.length > CAL_ISSUES_MAX) {
        keys.sort((a, b) => String(mem.issues[b].at).localeCompare(String(mem.issues[a].at)));
        keys.slice(CAL_ISSUES_MAX).forEach((k) => { delete mem.issues[k]; });
      }
      return new Promise((resolve) => chrome.storage.local.set({ omnitimeCalLinks: mem.links, omnitimeCalIssues: mem.issues }, resolve));
    });
  }
  // All occurrences of a recurring event share the series key; events without
  // a UID fall back to their title.
  const calSeriesKey = (ce) => (ce.uid ? 'uid:' + ce.uid : 'title:' + String(ce.title || '').trim().toLowerCase());
  const calOccurrenceKey = (ce, date) => `${calSeriesKey(ce)}@${date}T${fmtClock(ce.originalStart)}`;

  // --- Mounting (shadow DOM isolation) ---
  // Every open dialog lives in a shadow root on a single <omnitime-root>
  // host appended to <body>; the host is removed again on close. Page CSS
  // can't reach inside (and :host resets everything the page could set on the
  // host itself, see style.css), and our CSS can't leak out. The root is
  // CLOSED in production (host.shadowRoot is null), so page scripts - session
  // replay tools included - can neither read the user's day nor click Save /
  // Delete; dev builds and tests open it (see SHADOW_MODE_DEFAULT).
  //
  // The stylesheet is style.css, but as TEXT: it is deliberately not web-
  // accessible (only the options page the settings panel embeds is, under a
  // dynamic URL: no page fingerprinting), so a page can't load the file and a
  // content script can't fetch it either. The service worker reads
  // its own copy and hands the text over (OMNI_GET_STYLES); the glue passes it
  // to OmniTime.setStyles(css) before the first open. The dev harness and the
  // tests read style.css directly.
  //
  // Shadow tree:  #shadow-root > .omnitime-root > .omnitime-modal-overlay > .omnitime-modal
  //                                            > .omnitime-tl__cal-popover (hover popovers)
  // Query inside with OmniTime.getRoot() (the shadow root) - document.querySelector
  // can't see into it.
  const HOST_TAG = 'omnitime-root';
  // Closed in production: page scripts (incl. session-replay tools) can't
  // read or drive the UI. Dev/test builds open it: build_extension.sh --dev
  // rewrites SHADOW_MODE_DEFAULT, jsdom tests and dev/preview.html set
  // window.__omnitimeShadowMode = 'open' before core.js. Strict string
  // check: pages can't set isolated-world globals, and DOM clobbering
  // (<a id="__omnitimeShadowMode">) yields an element, never the string.
  const SHADOW_MODE_DEFAULT = 'closed';
  const shadowMode = () => (window.__omnitimeShadowMode === 'open' ? 'open' : SHADOW_MODE_DEFAULT);
  const shadowRoots = new WeakMap(); // host -> its shadow root (also when closed)
  function attachRoot(host) {
    const root = host.attachShadow({ mode: shadowMode() });
    shadowRoots.set(host, root);
    return root;
  }
  let styleText = '';
  let current = null; // the open shell (see openShell), if any

  function setStyles(css) {
    styleText = String(css || '');
  }

  // Constructable stylesheets where they work; a <style> element otherwise
  // (e.g. Firefox content scripts, where adopting a sheet created in the
  // sandbox throws, and jsdom).
  function adoptStyles(root) {
    if (!styleText) {
      if (window.omniDebugMode) console.warn('OmniTime: no stylesheet set (OmniTime.setStyles) - the UI renders unstyled.');
      return;
    }
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styleText);
      root.adoptedStyleSheets = [sheet];
      if (root.adoptedStyleSheets.length === 1) return;
    } catch (e) { /* fall back below */ }
    const style = document.createElement('style');
    style.textContent = styleText;
    root.appendChild(style);
  }

  // Theme: 'light' | 'dark' | 'auto' (follow prefers-color-scheme), or a
  // function returning one of those (re-evaluated when the OS scheme or the
  // class of <html>/<body> changes, e.g. GitLab's gl-dark). Resolved to
  // data-theme="light" | "dark" on the host; style.css keys its tokens on it.
  function bindTheme(host, theme) {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const apply = () => {
      let t = typeof theme === 'function' ? theme() : theme;
      if (t !== 'light' && t !== 'dark') t = mq && mq.matches ? 'dark' : 'light';
      if (host.getAttribute('data-theme') !== t) host.setAttribute('data-theme', t);
    };
    apply();
    const unbind = [];
    if (mq) {
      if (mq.addEventListener) {
        mq.addEventListener('change', apply);
        unbind.push(() => mq.removeEventListener('change', apply));
      } else if (mq.addListener) {
        mq.addListener(apply);
        unbind.push(() => mq.removeListener(apply));
      }
    }
    if (typeof theme === 'function' && window.MutationObserver) {
      const mo = new MutationObserver(apply);
      [document.documentElement, document.body].forEach((el) => {
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
      unbind.push(() => mo.disconnect());
    }
    return () => unbind.forEach((fn) => fn());
  }

  // --- Escape layers ---
  // Escape closes the topmost open layer first - an open popover or search
  // results, then an open form, and only then the modal itself (the implicit
  // bottom layer). Anything that can be dismissed registers while it is open:
  //
  //   const pop = ctx.ui.pushEscape(() => closeThing(), thingEl);
  //   ...
  //   pop();   // when it closes some other way (click, save, re-render)
  //
  // - fn runs when Escape reaches this layer; the layer is then removed.
  //   Return false from fn to keep the layer (the key is still consumed).
  // - el (optional) is the layer's element: once it has left the DOM (e.g. a
  //   re-render replaced it) the layer is dropped silently, so re-renders
  //   don't have to pop explicitly.
  // - pop() is idempotent and never runs fn.
  // ctx.ui is the shell (see openShell), reachable from every renderer.
  function createEscapeStack() {
    const layers = [];
    const remove = (layer) => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
    return {
      push(fn, el) {
        const layer = { fn, el };
        layers.push(layer);
        return () => remove(layer);
      },
      // Run the topmost live layer. False when none is open.
      escape() {
        while (layers.length) {
          const layer = layers[layers.length - 1];
          if (layer.el && !layer.el.isConnected) {
            layers.pop();
            continue;
          }
          if (layer.fn() !== false) remove(layer);
          return true;
        }
        return false;
      },
      get size() { return layers.length; },
    };
  }

  // --- Focus helpers (focus inside the dialog lives in the shadow root) ---
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex="-1"]):not([data-focus-guard])';
  const isShown = (el) => {
    // `inert`: the content behind the settings panel (ui.settings).
    if (el.tabIndex < 0 || el.closest('[hidden], [inert]')) return false;
    // checkVisibility: display:none ancestors, closed <details>, ... (jsdom lacks it).
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
  };
  // The focused element, looking through shadow roots (ours may be closed,
  // hence the shadowRoots lookup).
  const deepActiveElement = () => {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 10; depth++) {
      const r = el.shadowRoot || shadowRoots.get(el);
      if (!r || !r.activeElement) break;
      el = r.activeElement;
    }
    return el;
  };

  // --- Toasts (ui.toast, see openShell) ---
  function createToaster(dialog) {
    // The live region exists (empty) from the start so screen readers pick
    // up the first toast too.
    const region = elem('div', 'omnitime-toast-region');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    dialog.appendChild(region);
    let active = null; // { el, timer }

    function clear() {
      if (!active) return;
      const t = active;
      active = null;
      clearTimeout(t.timer);
      // Focus inside a toast that goes away would fall to <body>: park it on the dialog.
      if (t.el.contains(deepActiveElement())) dialog.focus({ preventScroll: true });
      t.el.remove();
    }

    function toast(message, opts) {
      opts = opts || {};
      const timeout = opts.timeout === undefined ? 5000 : opts.timeout;
      clear();
      const el = elem('div', 'omnitime-toast' + (opts.tone === 'error' ? ' omnitime-toast--error' : ''));
      if (opts.tone === 'error') el.insertAdjacentHTML('beforeend', icon('alert'));
      const text = elem('span', 'omnitime-toast__msg');
      text.textContent = message;
      el.appendChild(text);
      const t = { el, timer: null };
      const dismiss = () => { if (active === t) clear(); };
      // actionLabel/onAction is the first button; opts.actions adds more.
      const actions = (opts.actions || []).slice();
      if (opts.actionLabel) actions.unshift({ label: opts.actionLabel, onAction: opts.onAction });
      actions.forEach((a) => {
        const btn = elem('button', 'omnitime-toast__action');
        btn.type = 'button';
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          dismiss();
          if (typeof a.onAction === 'function') a.onAction();
        });
        el.appendChild(btn);
      });
      const arm = () => {
        clearTimeout(t.timer);
        if (timeout > 0) t.timer = setTimeout(dismiss, timeout);
      };
      const hold = () => clearTimeout(t.timer);
      el.addEventListener('pointerenter', hold);
      el.addEventListener('pointerleave', arm);
      el.addEventListener('focusin', hold);
      el.addEventListener('focusout', arm);
      active = t;
      region.appendChild(el);
      arm();
      return dismiss;
    }
    return { toast, dispose: clear };
  }

  // --- Settings panel (the gear in the dialog header) ---
  // The settings are NOT re-implemented here: the dialog runs inside arbitrary
  // web pages, and signing in/out and the API URL (which decides where the
  // Google token is sent) may only be changed from extension pages. So the
  // panel embeds the extension's own options page (opts.url, a string or a
  // function returning it - the glue passes the web-accessible
  // chrome.runtime.getURL('options.html')) in an iframe: an extension page the
  // service worker trusts and a cross-origin one the website can't read.
  //
  // The panel slides over the content (150 ms, none with prefers-reduced-
  // motion); the tabs, timer and content behind it are `inert`. Escape closes it
  // first (an Escape pressed INSIDE the frame arrives as OMNI_SETTINGS_CLOSE via
  // the service worker -> OmniTime.closeSettings(); never window.postMessage).
  // Focus moves into the frame on open and back to the gear on close.
  //
  //   ui.settings = { open(), close(), isOpen(), dispose }   (only with a url)
  const SETTINGS_SLIDE_MS = 150;
  function createSettingsPanel(ui, cfg) {
    const { dialog, content, header, headerLeft } = ui;
    const gear = header.querySelector('.omnitime-modal-gear');
    const inertEls = [content, headerLeft, header.querySelector('.omnitime-header-timer')];
    let panel = null;
    let frame = null;
    let popEscape = null;
    let isOpen = false;
    let removeTimer = null;

    const reducedMotion = () => !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The panel covers the content area only: below the header (and the timer bar).
    const place = () => { if (panel) panel.style.top = content.offsetTop + 'px'; };
    const frameUrl = () => {
      const base = String(typeof cfg.url === 'function' ? cfg.url() : cfg.url || '');
      if (!base) return '';
      const theme = ui.host.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      return base + (base.includes('?') ? '&' : '?') + 'embedded=1&theme=' + theme;
    };
    const focusFrame = () => { if (isOpen && frame) frame.focus({ preventScroll: true }); };

    function finish() {
      clearTimeout(removeTimer);
      if (panel) panel.remove();
      panel = null;
      frame = null;
      dialog.classList.remove('omnitime-modal--settings');
    }

    function open() {
      if (isOpen) return false;
      const src = frameUrl();
      if (!src) return false;
      finish(); // a panel still sliding out
      isOpen = true;
      panel = elem('div', 'omnitime-settings');
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-labelledby', 'omnitime-settings-title');
      panel.innerHTML = `
        <div class="omnitime-settings__head">
          <button class="omnitime-settings__back" type="button">${icon('arrowLeft')}<span>Back</span></button>
          <h3 class="omnitime-settings__title" id="omnitime-settings-title">Settings</h3>
        </div>`;
      frame = document.createElement('iframe');
      frame.className = 'omnitime-settings__frame';
      frame.title = 'OmniTime settings';
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.addEventListener('load', focusFrame);
      frame.src = src;
      // Tabbing out of the frame's last control lands here and wraps to "Back"
      // (key events inside the frame never reach this document).
      const guard = elem('span', 'omnitime-settings__guard');
      guard.tabIndex = 0;
      guard.setAttribute('data-focus-guard', '');
      guard.addEventListener('focus', () => panel && panel.querySelector('.omnitime-settings__back').focus({ preventScroll: true }));
      panel.appendChild(frame);
      panel.appendChild(guard);
      panel.querySelector('.omnitime-settings__back').addEventListener('click', () => close());

      dialog.classList.add('omnitime-modal--settings');
      dialog.appendChild(panel);
      place();
      window.addEventListener('resize', place);
      inertEls.forEach((el) => { if (el) el.setAttribute('inert', ''); });
      gear.setAttribute('aria-expanded', 'true');
      popEscape = ui.pushEscape(() => { close(); return true; }, panel);
      void panel.offsetWidth; // commit the start position so the slide runs
      panel.classList.add('omnitime-settings--open');
      focusFrame();
      return true;
    }

    // `o.focus === false`: leave the focus where it is (the dialog is closing).
    function close(o) {
      if (!isOpen) return false;
      isOpen = false;
      if (popEscape) popEscape();
      popEscape = null;
      window.removeEventListener('resize', place);
      inertEls.forEach((el) => { if (el) el.removeAttribute('inert'); });
      gear.setAttribute('aria-expanded', 'false');
      panel.classList.remove('omnitime-settings--open');
      if (reducedMotion()) finish();
      else removeTimer = setTimeout(finish, SETTINGS_SLIDE_MS);
      if (!o || o.focus !== false) gear.focus({ preventScroll: true });
      if (typeof cfg.onClosed === 'function') {
        try { cfg.onClosed(); } catch (e) { /* the panel is closed regardless */ }
      }
      return true;
    }

    gear.addEventListener('click', () => { if (isOpen) close(); else open(); });
    const dispose = () => {
      window.removeEventListener('resize', place);
      clearTimeout(removeTimer);
      isOpen = false;
    };
    return { open, close, isOpen: () => isOpen, dispose };
  }

  // --- Dialog shell ---
  // The mounted, accessible dialog every view renders into: host + shadow
  // root, role=dialog/aria-modal labelled by the title, focus moved in on open
  // and restored on close, Tab/Shift+Tab trapped, Escape layers, backdrop
  // click and the close button. Only one shell is open at a time; opening a
  // new one replaces the old.
  //
  // Returns the `ui` object renderers receive (ctx.ui):
  //   { host, root (ShadowRoot), layer (.omnitime-root, for popovers),
  //     overlay, dialog, header, headerLeft, title, content,
  //     pushEscape(fn, el) -> pop, pushTrap(el) -> pop, onClose(fn), close(), isOpen(),
  //     holdOpen(fn) -> release,
  //     toast(message, { actionLabel, onAction, actions, tone, timeout = 5000 }) -> dismiss }
  //
  // ui.holdOpen(fn) keeps the shell open while fn() is truthy: close() (backdrop
  // click, OmniTime.close(), the X) then does nothing. A request that must not
  // be abandoned registers it (the "Book meetings" dialog while it is busy);
  // call the returned release() when done. Replacing the shell by opening
  // another one is not vetoed.
  //
  // ui.pushTrap(el) confines Tab / Shift+Tab to `el` (a dialog layered over the
  // content, e.g. "Book meetings") until pop() is called or `el` leaves the DOM.
  //
  // ui.toast shows one transient message at the bottom of the dialog (a polite
  // live region; a new toast replaces the one showing). With actionLabel it
  // also has a button (a normal Tab stop) that dismisses the toast and then
  // calls onAction() - e.g. an "Undo"; `actions: [{ label, onAction }]` adds
  // further buttons, `tone: 'error'` marks a failure. The toast survives re-renders of the
  // content; it closes after `timeout` ms (0 = stays until dismissed; hovering
  // or focusing it pauses the timer) and returns dismiss() (idempotent, never
  // calls onAction), e.g. for an undo that is no longer possible.
  function openShell(opts) {
    opts = opts || {};
    // A replaced shell hands over the focus to restore, not its own.
    const prevFocus = current ? current.prevFocus : deepActiveElement();
    if (current) current.close({ restoreFocus: false, force: true });

    const host = document.createElement(HOST_TAG);
    const root = attachRoot(host);
    adoptStyles(root);
    const unbindTheme = bindTheme(host, opts.theme);

    const layer = elem('div', 'omnitime-root');
    const overlay = elem('div', 'omnitime-modal-overlay');
    overlay.innerHTML = `
      <div class="omnitime-modal" role="dialog" aria-modal="true" aria-labelledby="omnitime-dialog-title" tabindex="-1">
        <div class="omnitime-modal-header">
          <div class="omnitime-headerleft"><h2 class="omnitime-title" id="omnitime-dialog-title"></h2></div>
          <div class="omnitime-header-timer"></div>
          <div class="omnitime-header-actions">
            ${opts.settingsUrl ? `<button class="omnitime-modal-gear" type="button" aria-label="Settings" title="Settings" aria-expanded="false">${icon('gear')}</button>` : ''}
            <button class="omnitime-modal-close" type="button" aria-label="Close">${icon('close')}</button>
          </div>
        </div>
        <div class="omnitime-modal-content"></div>
      </div>`;
    layer.appendChild(overlay);
    root.appendChild(layer);
    document.body.appendChild(host);

    const dialog = overlay.querySelector('.omnitime-modal');
    if (opts.dialogClass) dialog.classList.add(opts.dialogClass);
    const title = overlay.querySelector('.omnitime-title');
    title.textContent = opts.title || 'Time tracking';

    const escapes = createEscapeStack();
    const traps = [];
    const toaster = createToaster(dialog);
    const closers = [];
    const holds = new Set();
    let open = true;

    const ui = {
      host,
      root,
      layer,
      overlay,
      dialog,
      header: overlay.querySelector('.omnitime-modal-header'),
      headerLeft: overlay.querySelector('.omnitime-headerleft'),
      title,
      content: overlay.querySelector('.omnitime-modal-content'),
      prevFocus,
      pushEscape: (fn, el) => escapes.push(fn, el),
      pushTrap: (el) => {
        traps.push(el);
        return () => { const i = traps.indexOf(el); if (i >= 0) traps.splice(i, 1); };
      },
      toast: toaster.toast,
      onClose: (fn) => { closers.push(fn); },
      settings: null,
      holdOpen: (fn) => { holds.add(fn); return () => holds.delete(fn); },
      isOpen: () => open,
      close,
    };

    if (opts.settingsUrl) {
      ui.settings = createSettingsPanel(ui, {
        url: opts.settingsUrl,
        onClosed: opts.onSettingsClosed,
      });
      closers.push(ui.settings.dispose);
    }

    function close(closeOpts) {
      if (!open) return;
      // A hold (ui.holdOpen) vetoes every close but a replacement by a new shell.
      if (!(closeOpts && closeOpts.force) && [...holds].some((fn) => { try { return !!fn(); } catch (e) { return false; } })) return;
      open = false;
      document.removeEventListener('keydown', onKeyDown, true);
      unbindTheme();
      toaster.dispose();
      closers.forEach((fn) => { try { fn(); } catch (e) { /* keep closing */ } });
      host.remove();
      if (current === ui) current = null;
      const restore = !closeOpts || closeOpts.restoreFocus !== false;
      if (restore && prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
      }
    }

    function trapTab(e) {
      // The topmost layered dialog (pushTrap) that is still mounted, else the dialog.
      const scope = [...traps].reverse().find((el) => el.isConnected) || dialog;
      const items = [...scope.querySelectorAll(FOCUSABLE)].filter(isShown);
      const active = root.activeElement;
      if (!items.length) {
        e.preventDefault();
        scope.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = active && scope.contains(active);
      if (e.shiftKey && (!inside || active === first || active === scope)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    }

    // Capture phase on the document: runs before the page's own (bubbling)
    // handlers, so e.g. GitLab doesn't also close its drawer on our Escape.
    function onKeyDown(e) {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        if (!escapes.escape()) close();
      } else if (e.key === 'Tab') {
        trapTab(e);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    ui.header.querySelector('.omnitime-modal-close').addEventListener('click', () => close());
    const moveResize = attachMoveResize(window, { dialog, overlay, header: ui.header, closers });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && !moveResize.wasGesture()) close();
    });

    current = ui;
    dialog.focus({ preventScroll: true });
    return ui;
  }

  // --- Movable, resizable dialog (openShell) ---
  // The large dialog (My day / Week) remembers position and size in
  // chrome.storage.local `omnitimeModalRect` {x, y, w, h} (px); the small one
  // ("This issue", notices) only its position, `omnitimeModalPos` {x, y}.
  // Until the user moves it, the CSS centres it; afterwards it is positioned
  // absolutely inside the (fixed, viewport-sized) overlay.
  const MODAL_MIN_W = 560;
  const MODAL_MIN_H = 420;
  const MODAL_KEEP = 48; // header px that must stay inside the viewport
  const MODAL_STEP = 20; // Alt+Arrow
  const MODAL_RECT_KEY = 'omnitimeModalRect';
  const MODAL_POS_KEY = 'omnitimeModalPos';
  const RESIZE_DIRS = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  function attachMoveResize(win, { dialog, overlay, header, closers }) {
    const vw = () => win.innerWidth;
    const vh = () => win.innerHeight;
    const isLarge = () => dialog.classList.contains('omnitime-modal--large');
    // null until the user moves/resizes (or a remembered one is restored).
    let rect = null; // large: {x, y, w, h}
    let pos = null; // small: {x, y}
    let gesture = null;
    let ended = false; // a drag just ended: its pointerup must not count as a backdrop click

    // Size within [min(560, viewport), viewport]; the position keeps the whole
    // dialog inside (`strict`) or at least MODAL_KEEP px of its header (drag).
    function clampRect(r, strict) {
      const w = Math.round(Math.max(Math.min(MODAL_MIN_W, vw()), Math.min(r.w, vw())));
      const h = Math.round(Math.max(Math.min(MODAL_MIN_H, vh()), Math.min(r.h, vh())));
      const loX = strict ? 0 : MODAL_KEEP - w;
      const hiX = strict ? vw() - w : vw() - MODAL_KEEP;
      const hiY = strict ? vh() - h : vh() - MODAL_KEEP;
      return {
        x: Math.round(Math.min(Math.max(r.x, loX), Math.max(hiX, loX))),
        y: Math.round(Math.min(Math.max(r.y, 0), Math.max(hiY, 0))),
        w,
        h,
      };
    }

    function layout() {
      const s = dialog.style;
      const large = isLarge();
      const r = large ? rect : pos;
      for (const p of ['position', 'left', 'top', 'width', 'height', 'maxWidth', 'maxHeight', 'margin']) s[p] = '';
      if (!r) return;
      s.position = 'absolute';
      s.margin = '0';
      s.left = r.x + 'px';
      s.top = r.y + 'px';
      if (large) {
        s.width = r.w + 'px';
        s.height = r.h + 'px';
        s.maxWidth = 'none';
        s.maxHeight = 'none';
      }
    }

    // The current on-screen box (what the CSS gave it, until the user moves it).
    function current() {
      if (isLarge() && rect) return { ...rect };
      if (!isLarge() && pos) {
        const b = dialog.getBoundingClientRect();
        return { x: pos.x, y: pos.y, w: b.width, h: b.height };
      }
      const b = dialog.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }

    function set(r, { persist = true, strict = false } = {}) {
      const c = clampRect(r, strict);
      if (isLarge()) rect = c; else pos = { x: c.x, y: c.y };
      layout();
      if (persist) save();
    }

    function storage() {
      return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    }
    function save() {
      const st = storage();
      if (!st) return;
      try {
        if (isLarge()) st.set({ [MODAL_RECT_KEY]: rect ? { ...rect } : null });
        else st.set({ [MODAL_POS_KEY]: pos ? { ...pos } : null });
      } catch (e) { /* storage unavailable */ }
    }

    function reset() {
      if (isLarge()) rect = null; else pos = null;
      layout();
      save();
    }

    const cleanRect = (r) => (r && num(r.x) != null && num(r.y) != null && num(r.w) != null && num(r.h) != null
      ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
    const cleanPos = (r) => (r && num(r.x) != null && num(r.y) != null ? { x: r.x, y: r.y } : null);

    // Restore the remembered box (unless the user already moved it).
    const st = storage();
    if (st) {
      let touched = false;
      const mark = () => { touched = true; };
      overlay.addEventListener('pointerdown', mark, { once: true });
      try {
        st.get([MODAL_RECT_KEY, MODAL_POS_KEY], (r) => {
          if (touched || !dialog.isConnected) return;
          const saved = cleanRect(r && r[MODAL_RECT_KEY]);
          const savedPos = cleanPos(r && r[MODAL_POS_KEY]);
          if (saved) rect = clampRect(saved, true);
          if (savedPos) {
            const b = dialog.getBoundingClientRect();
            pos = clampRect({ x: savedPos.x, y: savedPos.y, w: b.width || MODAL_MIN_W, h: b.height || MODAL_MIN_H }, true);
            pos = { x: pos.x, y: pos.y };
          }
          layout();
        });
      } catch (e) { /* storage unavailable */ }
    }

    // The tab switch (small <-> large) changes which box applies.
    const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(layout) : null;
    if (observer) observer.observe(dialog, { attributes: true, attributeFilter: ['class'] });
    const onWindowResize = () => {
      const r = isLarge() ? rect : pos;
      if (r) set(current(), { persist: false, strict: true });
    };
    win.addEventListener('resize', onWindowResize);
    closers.push(() => {
      win.removeEventListener('resize', onWindowResize);
      if (observer) observer.disconnect();
    });

    // --- Gestures (pointer capture) ---
    function begin(e, target, kind, dir) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      try { target.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      gesture = { target, kind, dir, id: e.pointerId, sx: e.clientX, sy: e.clientY, start: current() };
      overlay.classList.add(kind === 'move' ? 'omnitime-modal-overlay--moving' : 'omnitime-modal-overlay--resizing');
      overlay.dataset.dir = dir || '';
    }
    function update(e) {
      if (!gesture) return;
      const dx = e.clientX - gesture.sx;
      const dy = e.clientY - gesture.sy;
      const s = gesture.start;
      if (gesture.kind === 'move') {
        set({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }, { persist: false });
        return;
      }
      const minW = Math.min(MODAL_MIN_W, vw());
      const minH = Math.min(MODAL_MIN_H, vh());
      let left = s.x;
      let top = s.y;
      let right = s.x + s.w;
      let bottom = s.y + s.h;
      const d = gesture.dir;
      if (d.includes('w')) left = Math.min(Math.max(s.x + dx, 0), right - minW);
      if (d.includes('e')) right = Math.max(Math.min(right + dx, vw()), left + minW);
      if (d.includes('n')) top = Math.min(Math.max(s.y + dy, 0), bottom - minH);
      if (d.includes('s')) bottom = Math.max(Math.min(bottom + dy, vh()), top + minH);
      set({ x: left, y: top, w: right - left, h: bottom - top }, { persist: false });
    }
    function finish(e) {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      try { g.target.releasePointerCapture(g.id); } catch (err) { /* already released */ }
      overlay.classList.remove('omnitime-modal-overlay--moving', 'omnitime-modal-overlay--resizing');
      delete overlay.dataset.dir;
      if (isLarge() ? rect : pos) save();
      ended = true;
      win.setTimeout(() => { ended = false; }, 0);
    }
    const INTERACTIVE = 'button, a, input, select, textarea, [role="tab"], [role="tablist"]';
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest(INTERACTIVE)) return;
      begin(e, header, 'move');
    });
    header.addEventListener('pointermove', update);
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest(INTERACTIVE)) return;
      reset();
    });

    // Alt+Arrow moves by 20 px, Alt+Shift+Arrow resizes (large dialog only).
    header.tabIndex = -1;
    header.addEventListener('keydown', (e) => {
      if (!e.altKey || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      e.preventDefault();
      const c = current();
      if (e.shiftKey) {
        if (!isLarge()) return;
        set({ x: c.x, y: c.y, w: c.w + dir[0] * MODAL_STEP, h: c.h + dir[1] * MODAL_STEP }, { strict: true });
      } else {
        set({ x: c.x + dir[0] * MODAL_STEP, y: c.y + dir[1] * MODAL_STEP, w: c.w, h: c.h });
      }
    });

    for (const dir of RESIZE_DIRS) {
      const h = elem('div', `omnitime-resize omnitime-resize--${dir}`);
      h.setAttribute('aria-hidden', 'true');
      h.addEventListener('pointerdown', (e) => begin(e, h, 'resize', dir));
      h.addEventListener('pointermove', update);
      h.addEventListener('pointerup', finish);
      h.addEventListener('pointercancel', finish);
      dialog.appendChild(h);
    }

    return { wasGesture: () => !!gesture || ended };
  }

  // A simple dialog with a message (e.g. "not configured"). `html` is trusted
  // markup from the caller. With `settingsUrl` it gets the settings gear, and
  // a primary "Open settings" button (unless `settingsButton === false`) that
  // opens the same panel in this dialog; `onSettingsClosed` runs when it closes.
  function openNotice(opts) {
    opts = opts || {};
    const ui = openShell({
      title: opts.title,
      theme: opts.theme,
      dialogClass: opts.dialogClass,
      settingsUrl: opts.settingsUrl,
      onSettingsClosed: opts.onSettingsClosed,
    });
    ui.content.classList.add('omnitime-modal-content--message');
    ui.content.innerHTML = opts.html || '';
    if (ui.settings && opts.settingsButton !== false) {
      const actions = elem('div', 'omnitime-notice__actions');
      const btn = elem('button', 'omnitime-notice__settings', 'Open settings');
      btn.type = 'button';
      btn.addEventListener('click', () => ui.settings.open());
      actions.appendChild(btn);
      ui.content.appendChild(actions);
    }
    return ui;
  }

  // { uid, name } of a colleague (uid a positive integer), else null.
  function cleanPerson(p) {
    const uid = p && Number(p.uid);
    if (!Number.isInteger(uid) || uid <= 0) return null;
    return { uid, name: String(p.name == null ? '' : p.name).trim() };
  }

  // --- Modal: "This issue" + "My day" tabs ---
  function openModal(opts) {
    opts = opts || {};
    const apiClient = opts.apiClient;
    const context = opts.context || {};
    const settings = opts.settings || {};
    context.settings = settings;

    const ui = openShell({
      title: 'Time tracking',
      theme: opts.theme,
      settingsUrl: opts.settingsUrl,
      // The glue (content.js / overlay) decides whether anything changed and
      // calls handle.applySettings(); see there.
      onSettingsClosed: opts.onSettingsClosed,
    });
    const { content, headerLeft, dialog } = ui;
    content.id = 'omnitime-panel';

    const myDayState = { date: todayStr(), frequent: null, calCache: null, dismissedCalEvents: new Set() };
    // opts.onDayTotal(date, totalMinutes): called after every successful load
    // of TODAY (badge sync); read by renderMyDayTab from its state.
    myDayState.onDayTotal = typeof opts.onDayTotal === 'function' ? opts.onDayTotal : null;
    // Per-modal caches (memory only): starred issues, and my-tracked-week for
    // the Week tab + the absences in My day's week strip.
    myDayState.bookmarks = createBookmarkStore(apiClient);
    myDayState.weekStore = createWeekStore(apiClient);
    // Week tab, PMs only: whose week it shows (null = the caller's own) and the
    // recently viewed people (loadRecentPeople). opts.person
    // ({ uid, name }) opens the Week tab on that person (clickable names).
    myDayState.weekPerson = null;
    myDayState.recentPeople = [];
    loadRecentPeople(myDayState);
    myDayState.pendingPerson = cleanPerson(opts.person);
    // Absence on a weekday ({ half_day }) once its week is loaded, else null.
    myDayState.absenceFor = (date) => myDayState.weekStore.absenceFor(date);
    ui.onClose(() => {
      if (myDayState.calListener && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.removeListener(myDayState.calListener);
      }
    });

    let icalUrl = opts.icalUrl || '';
    const icalTransport = opts.icalTransport || null;
    // Without an issue (toolbar overlay on any page) there is nothing to show
    // on "This issue" - My day only, no tab bar.
    const hasIssue = !!(context.source && context.project_id && context.issue_id);
    let activateTab = null;
    let shownTab = null;

    // Running timer (timer.js, optional): the pill in the header and the stop /
    // start flows. A booking or an undo changes the day, so the open view is
    // reloaded (My day in place, so the form keeps its state).
    const Timer = window.OmniTimeTimer;
    let timerKit = null;
    if (Timer && hasLocalStorage()) {
      const controller = Timer.shared();
      const stopper = Timer.createStopper({
        controller,
        apiClient,
        notify: (message, o) => ui.toast(message, o),
        onDayTotal: myDayState.onDayTotal,
        pushEscape: ui.pushEscape,
        focusFallback: () => dialog.focus({ preventScroll: true }),
        onChange: () => {
          if (!ui.isOpen()) return;
          if (shownTab === 'myday') {
            if (myDayState.refresh) myDayState.refresh(); else if (myDayState.reload) myDayState.reload();
          } else if (shownTab === 'issue') showIssue();
        },
      });
      const startControls = new Set(); // the issue tab's Start buttons, torn down on close
      timerKit = { controller, stopper, track: (c) => startControls.add(c) };
      ui.onClose(() => startControls.forEach((c) => c.destroy()));
      // The stop confirm opens in a row under the header (not a popover: the
      // dialog clips overflow, and the issue tab can be short).
      const panelHost = elem('div', 'omnitime-timerpanel-host omnitime-timerpanel-host--bar');
      ui.header.after(panelHost);
      const pill = Timer.mountPill(ui.header.querySelector('.omnitime-header-timer'), {
        controller,
        stopper,
        panelHost,
        focusFallback: () => dialog.focus({ preventScroll: true }),
      });
      ui.onClose(() => pill.destroy());
    }

    const showIssue = () => {
      shownTab = 'issue';
      content.classList.remove('omnitime-modal-content--myday', 'omnitime-modal-content--week');
      dialog.classList.remove('omnitime-modal--large');
      renderIssueTab(content, apiClient, context, {
        capable: detectCapability(apiClient),
        timer: timerKit,
        onTrack: () => {
          myDayState.pendingAdd = true;
          if (activateTab) activateTab('myday');
        },
        // A name in the per-user table: that person's current week.
        onOpenPerson: typeof apiClient.week === 'function' ? (person) => {
          myDayState.pendingPerson = cleanPerson(person);
          if (activateTab) activateTab('week', { focus: true });
        } : null,
      });
    };
    const showMyDay = () => {
      content.classList.remove('omnitime-modal-content--week');
      shownTab = 'myday';
      content.classList.add('omnitime-modal-content--myday');
      dialog.classList.add('omnitime-modal--large');
      renderMyDayTab(content, apiClient, context, myDayState, icalUrl, icalTransport, false, settings.useGoogleCalendar, ui);
    };
    // Week tab: clicking a day opens it in My day.
    const showWeek = () => {
      content.classList.remove('omnitime-modal-content--myday');
      content.classList.add('omnitime-modal-content--week');
      dialog.classList.add('omnitime-modal--large');
      renderWeekTab(content, myDayState, {
        ui,
        apiClient,
        // "Daily target 0:00 (off)": the Week tab shows no targets or meters.
        targetOff: settings.dailyTargetMinutes === 0 || settings.dailyTargetMinutes === '0',
        onPickDay: (date) => {
          myDayState.date = date;
          if (activateTab) activateTab('myday', { focus: true }); else showMyDay();
        },
      });
    };

    // Without an issue: My day, plus Week when the client has it.
    const hasWeek = typeof apiClient.week === 'function';
    const initialTab = (opts.activeTab === 'week' || myDayState.pendingPerson) && hasWeek ? 'week' : hasIssue ? (opts.activeTab || 'issue') : 'myday';

    // Settings changed while the panel was open (the glue has already swapped
    // the API client behind apiClient and wants the new values shown):
    // `next.settings` is merged into the live settings object, `next.icalUrl`
    // replaces the calendar address, per-modal caches are dropped and the open
    // view is rendered again (My day keeps its date).
    let revealTabs = null; // set below, once the tab bar is a possibility
    function applySettings(next) {
      next = next || {};
      if (!ui.isOpen()) return;
      Object.assign(settings, next.settings || {});
      if (next.icalUrl !== undefined) icalUrl = next.icalUrl || '';
      myDayState.calCache = null;
      myDayState.frequent = null;
      myDayState.bookmarks = createBookmarkStore(apiClient);
      myDayState.weekStore = createWeekStore(apiClient);
      apiCapable = undefined;
      capabilityProbe = null;
      const tab = shownTab;
      content.innerHTML = '';
      if (tab === 'issue') showIssue(); else if (tab === 'week') showWeek(); else showMyDay();
      if (revealTabs) revealTabs();
    }

    if (initialTab === 'myday') {
      showMyDay();
    } else if (initialTab === 'week') {
      showWeek();
    } else {
      showIssue();
    }
    if (!hasIssue) ui.title.textContent = 'My day';
    if (!hasIssue && !hasWeek) {
      return { overlay: ui.overlay, cleanup: () => ui.close(), ui, applySettings };
    }

    // Reveal the tab bar only once the new API is detected. The title stays
    // (visually hidden) as the dialog's accessible name. Idempotent: it runs
    // again after the settings changed (a corrected API URL).
    revealTabs = () => detectCapability(apiClient).then((capable) => {
      if (!capable || !ui.isOpen() || headerLeft.querySelector('.omnitime-tabs')) return;

      ui.title.classList.add('ot-visually-hidden');
      headerLeft.insertAdjacentHTML('beforeend', `
        <div class="omnitime-tabs" role="tablist" aria-label="Views">
          ${hasIssue ? `<button class="omnitime-tab" type="button" role="tab" id="omnitime-tab-issue" data-tab="issue" aria-controls="omnitime-panel">${icon('users')}<span>This issue</span></button>` : ''}
          <button class="omnitime-tab" type="button" role="tab" id="omnitime-tab-myday" data-tab="myday" aria-controls="omnitime-panel">${icon('calendar')}<span>My day</span></button>
          ${hasWeek ? `<button class="omnitime-tab" type="button" role="tab" id="omnitime-tab-week" data-tab="week" aria-controls="omnitime-panel">${icon('week')}<span>Week</span></button>` : ''}
        </div>`);
      const tablist = headerLeft.querySelector('.omnitime-tabs');
      const tabs = [...tablist.querySelectorAll('.omnitime-tab')];
      content.setAttribute('role', 'tabpanel');
      // Roving tabindex: only the selected tab is in the Tab order.
      const select = (name) => {
        tabs.forEach((t) => {
          const on = t.dataset.tab === name;
          t.classList.toggle('omnitime-tab--active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
          t.tabIndex = on ? 0 : -1;
        });
        content.setAttribute('aria-labelledby', 'omnitime-tab-' + name);
      };
      const activate = (name, how) => {
        select(name);
        content.innerHTML = '';
        if (name === 'issue') showIssue(); else if (name === 'week') showWeek(); else showMyDay();
        // E.g. a day picked in the Week tab: keep the focus on the tab bar.
        if (how && how.focus) tabs.find((t) => t.dataset.tab === name)?.focus();
      };
      activateTab = activate;
      tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));
      // Left/Right (wrapping), Home/End move between tabs and activate them.
      tablist.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(e.target.closest('.omnitime-tab'));
        if (i < 0) return;
        let next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        next.focus();
        if (next.getAttribute('aria-selected') !== 'true') activate(next.dataset.tab);
      });

      // Mark the initial tab without re-rendering the content.
      select(initialTab);
    });
    revealTabs();

    return { overlay: ui.overlay, cleanup: () => ui.close(), ui, applySettings };
  }

  // --- Friendly errors ---
  // Strip markup and cut server backtraces so the technical details stay short
  // and safe to show (the raw Drupal error body can be a full HTML page).
  function sanitizeMessage(msg) {
    let t = String(msg == null ? '' : msg)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]*>/g, ' ');
    t = t.split(/Stack trace|Backtrace|\bTrace:|\n\s*at\s|#0\s+\//i)[0];
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > 300 ? t.slice(0, 299) + '…' : t;
  }

  function friendlyErrorText(err) {
    const status = err && err.status;
    const text = String((err && err.message) || '');
    if (!status) return "Can't reach 1x TIMES. Check your connection or the API URL in settings.";
    if (status === 401 || status === 403 || /permission is required/i.test(text)) {
      return "You're not signed in, or this account isn't allowed. Open the extension settings to sign in.";
    }
    if (UNAVAILABLE.includes(status)) return "This 1x TIMES server doesn't support this yet.";
    if (status === 400) return 'The request was incomplete.';
    if (status >= 500) return '1x TIMES had a problem. Try again in a moment.';
    return 'Something went wrong.';
  }

  // Shared error state: short human message by cause, collapsed technical
  // details, optional Retry. Replaces the container's content.
  function renderError(container, err, opts) {
    opts = opts || {};
    const status = err && err.status;
    const detail = sanitizeMessage(err && (err.message || err));
    const box = elem('div', 'omnitime-error omnitime-errbox');
    box.setAttribute('role', 'alert');
    box.innerHTML = `
      <div class="omnitime-errbox__icon">${icon('alert')}</div>
      ${opts.title ? `<strong class="omnitime-errbox__title">${esc(opts.title)}</strong>` : ''}
      <p class="omnitime-errbox__msg">${esc(friendlyErrorText(err))}</p>
      <details class="omnitime-errbox__details">
        <summary>Technical details</summary>
        <div class="omnitime-errbox__tech">${status ? 'Status: ' + esc(status) : 'No response'}${detail ? '<br>' + esc(detail) : ''}</div>
      </details>`;
    if (typeof opts.retry === 'function') {
      const btn = elem('button', 'omnitime-errbox__retry', 'Retry');
      btn.type = 'button';
      btn.addEventListener('click', opts.retry);
      box.appendChild(btn);
    }
    container.innerHTML = '';
    container.appendChild(box);
    return box;
  }

  // --- "This issue" tab (read-only aggregate; works with the old API) ---
  // API times are local "YYYY-MM-DD HH:MM"; parse by hand (no timezone shift).
  function parseLogTime(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(str || ''));
    if (!m) return null;
    return { key: `${m[1]}-${m[2]}-${m[3]}`, date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) };
  }
  const fmtLogDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  // 24 h like everywhere else in the UI (not the browser's 12 h locale).
  const fmtLogClock = (d) => fmtClock(d.getHours() * 60 + d.getMinutes());

  // Group detail rows by local day (newest first) with a subtotal per day.
  function groupLogs(details) {
    const days = new Map();
    details.forEach((d) => {
      const t = parseLogTime(d.start_time);
      const key = t ? t.key : '';
      if (!days.has(key)) days.set(key, { key, label: t ? fmtLogDay(t.date) : 'Unknown date', total: 0, rows: [] });
      const day = days.get(key);
      day.total += Number(d.time_spent) || 0;
      day.rows.push({ d, t });
    });
    const out = [...days.values()].sort((x, y) => (x.key < y.key ? 1 : x.key > y.key ? -1 : 0));
    out.forEach((day) => day.rows.sort((x, y) => (y.t ? y.t.date : 0) - (x.t ? x.t.date : 0)));
    return out;
  }

  // opts.onTrack: switches to My day with the add form open (only offered when
  // opts.capable resolves true, i.e. the My day tab exists).
  // opts.onOpenPerson({ uid, name }): rows with a `uid` (only sent to callers
  // who may view colleagues' time; never the caller's own row) become buttons
  // that open that person's week.
  function renderIssueTab(root, apiClient, context, opts) {
    opts = opts || {};
    // Own container: a late response is dropped once the panel was swapped
    // (tab switch) instead of overwriting whatever reused `root`.
    const panel = elem('div', 'omnitime-issue');
    root.innerHTML = '';
    root.appendChild(panel);
    const live = () => root.contains(panel);

    function load() {
      panel.innerHTML = `<div class="omnitime-loading">${icon('users')} Loading time data&hellip;</div>`;
      apiClient.issueTime(context).then((data) => {
        if (!live()) return;
        const issue = (data && data.issue) || {};
        // Remember whether the current issue is open so the My-day form doesn't
        // pre-select a closed issue (old API omits `issue` → stays undefined).
        if (data && data.issue) context.issueOpen = data.issue.open;
        const closed = issue.open === false;
        const entries = (data && data.tracked_time) || [];
        const totalSum = (data && data.total_sum) || 0;
        const details = (data && data.details) || [];

        const num = issue.external_id || issue.issue_external_id || context.issue_id;
        const title = issue.title || issue.label || context.issue_label || '';
        const heading = title && num && title.includes('#' + num) ? title : [num ? '#' + num : '', title].filter(Boolean).join(' ');
        let html = '';
        if (heading || (opts.onTrack && !closed)) {
          html += `<div class="omnitime-issuehead">
            <div class="omnitime-issuehead__main">
              <span class="omnitime-issuehead__title" title="${esc(heading)}">${esc(heading)}</span>
              ${closed ? '<span class="omnitime-issuehead__badge">Closed</span>' : ''}
            </div>
          </div>`;
        }

        if (!entries.length && !totalSum) {
          html += '<div class="omnitime-empty">No time tracking data found for this issue.</div>';
        } else {
          const linkable = (u) => !!opts.onOpenPerson && u.uid != null && u.self !== true && u.others !== true;
          const rows = entries.map((u, i) => `<tr><td>${linkable(u)
            ? `<button type="button" class="omnitime-personlink" data-person="${i}" aria-label="Open ${esc(u.user)}'s week" title="Open ${esc(u.user)}'s week">${esc(u.user)}</button>`
            : esc(u.user)}${u.self === true ? ' (you)' : ''}</td><td>${fmtDur(u.time_spent)}</td></tr>`).join('');
          html += `
            <table class="omnitime-table">
              <thead><tr><th>User</th><th>Total time</th></tr></thead>
              <tbody>${rows}<tr class="omnitime-total-row"><td>Total</td><td>${fmtDur(totalSum)}</td></tr></tbody>
            </table>`;
          if (details.length) {
            const body = groupLogs(details).map((day) => `
              <tbody class="omnitime-logday">
                <tr class="omnitime-logday__head"><th colspan="2" scope="colgroup">${esc(day.label)}</th><th>${fmtDur(day.total)}</th><th></th></tr>
                ${day.rows.map(({ d, t }) => `
                <tr>
                  <td title="${esc(t ? fmtLogDay(t.date) + ' · ' + fmtLogClock(t.date) : d.start_time)}">${esc(t ? fmtLogClock(t.date) : d.start_time)}</td>
                  <td>${esc(d.user)}</td>
                  <td>${fmtDur(d.time_spent)}</td>
                  <td class="omnitime-comment" title="${esc(stripTags(d.comment))}">${esc(stripTags(d.comment))}</td>
                </tr>`).join('')}
              </tbody>`).join('');
            html += `
              <div class="omnitime-details-container">
                <details class="omnitime-details-collapsible">
                  <summary>View detailed logs</summary>
                  <div class="omnitime-details-scroll">
                    <table class="omnitime-table omnitime-details-table">
                      <thead><tr><th>Time</th><th>User</th><th>Spent</th><th>Comment</th></tr></thead>
                      ${body}
                    </table>
                  </div>
                </details>
              </div>`;
          }
        }
        panel.innerHTML = html;
        panel.querySelectorAll('[data-person]').forEach((btn) => {
          const u = entries[Number(btn.dataset.person)];
          btn.addEventListener('click', () => opts.onOpenPerson({ uid: u.uid, name: String(u.user) }));
        });

        // Primary action; needs the My day tab (new API) and an open issue.
        if (opts.onTrack && !closed) {
          Promise.resolve(opts.capable).then((ok) => {
            if (!ok || !live()) return;
            const head = panel.querySelector('.omnitime-issuehead') || panel.insertBefore(elem('div', 'omnitime-issuehead'), panel.firstChild);
            const btn = elem('button', 'omnitime-add-btn omnitime-issuehead__track', `${icon('plus')}<span>Track time on this issue</span>`);
            btn.type = 'button';
            btn.addEventListener('click', opts.onTrack);
            // "Start timer" (timer.js) sits before it; the pill and the label
            // use "#14 Fix login".
            if (opts.timer && window.OmniTimeTimer) {
              const startCtl = window.OmniTimeTimer.mountStartButton(head, {
                controller: opts.timer.controller,
                stopper: opts.timer.stopper,
                issue: {
                  source: context.source,
                  project_id: context.project_id,
                  issue_id: context.issue_id,
                  label: window.OmniTimeTimer.issueLabel(num, title),
                },
              });
              opts.timer.track(startCtl);
            }
            head.appendChild(btn);
          });
        }
      }).catch((err) => {
        if (!live()) return;
        renderError(panel, err, { title: "Couldn't load this issue", retry: load });
      });
    }
    load();
  }

  // --- "My day" helpers ---
  // "Synced 10:42" today, "Synced yesterday 10:42", else "Synced 3 days ago";
  // plain "Synced" when the sync time is unknown.
  function fmtSynced(iso, now) {
    const at = iso ? new Date(iso) : null;
    if (!at || isNaN(at)) return 'Synced';
    now = now || new Date();
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(now) - midnight(at)) / 864e5);
    const clock = fmtClock(at.getHours() * 60 + at.getMinutes());
    if (days <= 0) return `Synced ${clock}`;
    if (days === 1) return `Synced yesterday ${clock}`;
    return `Synced ${days} days ago`;
  }

  // Project colour: a stable hash of the project name picks one of the
  // PROJECT_COLORS --ot-project-N tokens (left stripe on timeline entries).
  const PROJECT_COLORS = 8;
  function projectColorIndex(name) {
    const s = String(name || '').trim().toLowerCase();
    let h = 2166136261; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % PROJECT_COLORS;
  }

  // The issue part of an entry ("Standup #12"): the API's issue_label may be
  // prefixed with "Project / ".
  function entryIssueText(raw) {
    let label = String(raw.issue_label || '');
    const project = String(raw.project || '');
    if (project && label.startsWith(project + ' / ')) label = label.slice(project.length + 3);
    else if (project && label.startsWith(project)) label = label.slice(project.length).trim().replace(/^\/+/, '').trim();
    return (label + (raw.issue_external_id ? ' #' + raw.issue_external_id : '')).trim();
  }

  // Only real web links become "open issue" anchors.
  const safeHttpUrl = (url) => (/^https?:\/\//i.test(String(url || '').trim()) ? String(url).trim() : '');

  // Remembered calendar issue as "#5 Sync issue" (stored as "Sync issue #5").
  function rememberedIssueText(mem) {
    if (!mem || !mem.label) return '';
    const label = String(mem.label).trim();
    const m = label.match(/^(.*?)\s*#(\S+)$/);
    const text = m ? `#${m[2]} ${m[1]}`.trim() : label;
    return text.length > 32 ? text.slice(0, 31).trimEnd() + '…' : text;
  }

  // --- Day productivity: target, gaps, bulk booking (pure helpers) ---
  // Exposed on OmniTime for the tests and for other views (e.g. a week view
  // feeding absences into dayTarget).
  const DEFAULT_TARGET = 480;
  const MIN_GAP = 15;
  const weekday = (dateStr) => new Date(dateStr + 'T00:00:00').getDay();

  // The minutes to work on `dateStr`, as the web app counts them: no target on
  // Saturday/Sunday; an absence ({ half_day }) credits the full target for a
  // full day, half of it for a half day. 0 = no target.
  function dayTarget(dateStr, targetMinutes, absence) {
    const target = Math.max(0, Math.round(Number(targetMinutes) || 0));
    const dow = weekday(dateStr);
    if (!target || dow === 0 || dow === 6) return 0;
    if (absence) return absence.half_day ? Math.round(target / 2) : 0;
    return target;
  }

  // The daily target before weekends/absences: the API's target_minutes, else
  // the dailyTargetMinutes setting (default 8 h). The setting 0 turns the
  // target (progress + gaps) off, whatever the API says.
  function baseTarget(data, settings) {
    const setting = settings && settings.dailyTargetMinutes;
    if (setting === 0 || setting === '0') return 0;
    const api = data && Number(data.target_minutes);
    if (data && data.target_minutes != null && Number.isFinite(api)) return api;
    const s = Number(setting);
    return setting != null && setting !== '' && Number.isFinite(s) ? s : DEFAULT_TARGET;
  }

  // Footer progress: { label, pct, state } ("1:35 left" / "Target reached" /
  // "+0:20 over"), or null without a target.
  function targetProgress(totalMinutes, target) {
    if (!(target > 0)) return null;
    const total = Math.max(0, Math.round(Number(totalMinutes) || 0));
    const pct = Math.min(100, Math.round((total / target) * 100));
    if (total < target) return { label: `${fmtDur(target - total)} left`, pct, state: 'left' };
    if (total === target) return { label: 'Target reached', pct, state: 'reached' };
    return { label: `+${fmtDur(total - target)} over`, pct, state: 'over' };
  }

  // Monday → Friday; otherwise the day before (weekends → Friday).
  function prevWorkingDay(dateStr) {
    const dow = weekday(dateStr);
    return addDays(dateStr, dow === 1 ? -3 : dow === 0 ? -2 : -1);
  }

  // Untracked stretches of at least `minGap` minutes inside working hours
  // [workStart, workEnd), cut off at `limit` (now, on today) and around the
  // `busy` intervals (entries and unbooked calendar placeholders):
  // [{ start, stop }] in minutes.
  function findGaps({ busy, workStart, workEnd, limit = 24 * 60, minGap = MIN_GAP }) {
    const end = Math.min(workEnd, limit);
    const spans = (busy || []).filter((b) => b.stop > b.start).sort((a, b) => a.start - b.start);
    const gaps = [];
    let cursor = workStart;
    const push = (to) => { if (Math.min(to, end) - cursor >= minGap) gaps.push({ start: cursor, stop: Math.min(to, end) }); };
    for (const b of spans) {
      if (cursor >= end) break;
      if (b.start > cursor) push(b.start);
      cursor = Math.max(cursor, b.stop);
    }
    if (cursor < end) push(end);
    return gaps;
  }

  // The viewed day's calendar events "Book my meetings" can book in one go:
  // not booked from the calendar, not hidden, not already covered by an entry,
  // 5-240 minutes long. `issue` is the one remembered for the series, or null
  // (the dialog then asks the server for suggestions). `events` as the
  // calendar parser returns them (startMinutes/endMinutes/durationMinutes/
  // title/uid); `dismissed` holds the timeline's hidden occurrence keys (see
  // calOccurrenceKey: series + date + the ORIGINAL start, so a dragged
  // placeholder stays hidden).
  function bookableMeetings(events, entries, date, memory, dismissed) {
    const links = (memory && memory.links) || {};
    const issues = (memory && memory.issues) || {};
    const spans = (entries || []).map((e) => {
      const start = parseClock(e.start);
      return start == null ? null : { start, stop: start + (Number(e.duration_minutes) || 0), id: e.id };
    }).filter(Boolean);
    const seen = new Set();
    const out = [];
    (events || []).forEach((ce) => {
      const cal = { uid: ce.uid || '', title: ce.title, originalStart: ce.startMinutes };
      const start = ce.startMinutes;
      const stop = ce.endMinutes;
      const dur = stop - start;
      const key = calOccurrenceKey(cal, date);
      cal.key = key;
      if (seen.has(key)) return;
      seen.add(key);
      const link = links[key];
      if (link && (entries || []).some((e) => e.id === link.entryId)) return;
      if (dismissed && dismissed.has(key)) return;
      if (spans.some((s) => Math.max(s.start, start) < Math.min(s.stop, stop))) return;
      if (!(dur >= MIN_DUR && dur <= MAX_DUR)) return;
      const issue = issues[calSeriesKey(cal)];
      out.push({ key, cal, title: ce.title, start, stop, dur, issue: issue && issue.id != null ? issue : null });
    });
    return out.sort((a, b) => a.start - b.start);
  }

  // A new entry's payload (POST tracked-time) without its issue fields.
  const entryPayload = (date, startText, duration, comment) => ({
    date,
    start_time: startText || undefined,
    duration,
    comment: String(comment || '').trim() || undefined,
  });

  // Links a calendar event to the entry booked from it (so the event hides),
  // and with `issue` ({ id, label, project? }) remembers that issue for the
  // series and adds it to the series' (capped) booking history.
  function recordCalBooking(cal, entryId, date, issue) {
    return updateCalMemory((mem) => {
      if (entryId != null) mem.links[cal.key] = { entryId, date };
      if (issue && issue.id) {
        const key = calSeriesKey(cal);
        const prev = mem.issues[key] || {};
        const item = { id: issue.id, label: issue.label, at: new Date().toISOString() };
        if (issue.project) item.project = issue.project;
        const next = { id: issue.id, label: issue.label, title: cal.title, at: item.at, history: [item].concat(prev.history || []).slice(0, CAL_HISTORY_MAX) };
        if (issue.project) next.project = issue.project;
        mem.issues[key] = next;
      }
    });
  }
  const forgetCalBookings = (keys) => updateCalMemory((mem) => { keys.forEach((k) => { delete mem.links[k]; }); });

  // POSTs `items` one after the other: { created: [{ item, id }], skipped:
  // [{ item, err }], failed: { item, err } | null }. An error stops the run
  // unless skip(err, item) says to carry on (the item is then skipped);
  // payload(item) null skips it without a request.
  async function createSequentially(apiClient, items, payload, skip) {
    const res = { created: [], skipped: [], failed: null };
    for (const item of items) {
      const body = payload(item);
      if (!body) { res.skipped.push({ item, err: null }); continue; }
      try {
        const created = await apiClient.create(body);
        res.created.push({ item, id: created && created.id != null ? created.id : null });
      } catch (err) {
        if (skip && skip(err, item)) { res.skipped.push({ item, err }); continue; }
        res.failed = { item, err };
        break;
      }
    }
    return res;
  }

  // Deletes the given entry ids (Undo); resolves to the number that failed.
  async function removeAll(apiClient, ids) {
    let failed = 0;
    for (const id of ids) {
      if (id == null) continue;
      try { await apiClient.remove(id); } catch (e) { failed++; }
    }
    return failed;
  }

  // --- Booking suggestions: which issue a calendar meeting goes on ---
  // The issue model shared by the "Book meetings" dialog and the form's
  // Suggestions chips: { id (internal, may be null), ref? ({ source,
  // project_id, issue_id } when only the tracker's own id is known), ext,
  // name, project, milestone, link, reason ('history' | 'time' | '') }.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const BOOK_MAX_SUGGESTIONS = 3;
  // Windows into the newest-first booking history, in the order they fill the
  // Suggestions (as on the server: the 5 latest, the next 5, then up to 30).
  const BOOK_WINDOWS = [[0, 5], [5, 10], [10, 30]];
  const BOOK_REASON_TEXT = { history: 'Booked for this meeting before', time: 'Often booked around this time' };

  // "Name #12" -> { name: 'Name', ext: '12' }
  function splitIssueLabel(label) {
    const text = String(label || '').trim();
    const m = text.match(/^(.*?)\s*#(\S+)$/);
    return m ? { name: m[1], ext: m[2] } : { name: text, ext: '' };
  }
  const bookIssueFromApi = (i, reason) => ({
    id: i.issue_internal_id == null ? null : i.issue_internal_id,
    ext: i.issue_external_id == null ? '' : String(i.issue_external_id),
    name: String(i.label || ''),
    project: i.project || '',
    milestone: i.milestone || '',
    link: safeHttpUrl(i.link),
    reason: reason || '',
  });
  // From the local memory ({ id, label: "Name #12", project? }).
  function bookIssueFromMemory(mem, reason) {
    const { name, ext } = splitIssueLabel(mem.label);
    return { id: mem.id, ext, name, project: mem.project || '', milestone: '', link: '', reason: reason || '' };
  }
  // From a search option (searchOption / recentOption / frequentOption shape).
  function bookIssueFromOption(o) {
    if (o.raw && 'issue_external_id' in o.raw) return bookIssueFromApi(o.raw);
    const { name, ext } = splitIssueLabel(o.label);
    const issue = { id: o.id == null ? null : o.id, ext, name, project: '', milestone: '', link: '', reason: '' };
    if (o.ext) { issue.ref = o.ext; issue.ext = ext || String(o.ext.issue_id); }
    return issue;
  }
  // Back to an API-shaped record (what the star store and search options use).
  const bookIssueRaw = (i) => ({ issue_internal_id: i.id, issue_external_id: i.ext, label: i.name, project: i.project, milestone: i.milestone, link: i.link });
  const bookIssueText = (i) => `${i.ext ? '#' + i.ext + ' ' : ''}${i.name}`.trim();            // "#58 Retainer meeting/daily"
  const bookIssueLabel = (i) => `${i.name}${i.ext ? ' #' + i.ext : ''}`;                         // "Retainer meeting/daily #58"
  const bookIssueFull = (i) => `${i.project ? i.project + ' – ' : ''}${bookIssueLabel(i)}`; // tooltip
  const bookIssueKey = (i) => (i.id != null ? 'id:' + i.id : 'ref:' + JSON.stringify(i.ref || bookIssueLabel(i)));
  const bookIssueMemory = (i) => ({ id: i.id, label: bookIssueLabel(i), project: i.project });
  // The issue fields of a POST tracked-time payload.
  const bookIssueFields = (i) => (i.id != null ? { issue_internal_id: i.id } : { source: i.ref.source, project_id: i.ref.project_id, issue_id: i.ref.issue_id });

  // Offline suggestions from the series' local memory entry (see the calendar
  // memory above): the latest booking is preselected (else the remembered
  // issue), the others fill the Suggestions through the same windows the server
  // uses. Never more than BOOK_MAX_SUGGESTIONS, never the preselected issue.
  function localBookingSuggestions(entry) {
    const history = ((entry && entry.history) || []).filter((h) => h && h.id != null);
    let pre = null;
    if (history.length) pre = bookIssueFromMemory(history[0], 'history');
    else if (entry && entry.id != null) pre = bookIssueFromMemory(entry, 'history');
    const seen = new Set(pre ? [bookIssueKey(pre)] : []);
    const suggestions = [];
    BOOK_WINDOWS.forEach(([from, to]) => {
      history.slice(from, to).forEach((h) => {
        const issue = bookIssueFromMemory(h, 'history');
        if (suggestions.length >= BOOK_MAX_SUGGESTIONS || seen.has(bookIssueKey(issue))) return;
        seen.add(bookIssueKey(issue));
        suggestions.push(issue);
      });
    });
    return { preselected: pre, suggestions, from: pre ? 'local' : null };
  }

  // The server's answer (null when it is unavailable) over the local memory:
  // the server wins; with no server preselection the locally remembered issue
  // is used. from: 'server' | 'local' | null (where the preselection is from).
  function resolveBookingSuggestions(server, entry) {
    if (!server) return localBookingSuggestions(entry);
    let pre = server.preselected && server.preselected.issue_internal_id != null ? bookIssueFromApi(server.preselected, 'history') : null;
    let from = pre ? 'server' : null;
    if (!pre && entry && entry.id != null) { pre = bookIssueFromMemory(entry, 'history'); from = 'local'; }
    const seen = new Set(pre ? [bookIssueKey(pre)] : []);
    const suggestions = [];
    (Array.isArray(server.suggestions) ? server.suggestions : []).forEach((s) => {
      if (!s || s.issue_internal_id == null) return;
      const issue = bookIssueFromApi(s, s.reason === 'time' ? 'time' : 'history');
      if (suggestions.length >= BOOK_MAX_SUGGESTIONS || seen.has(bookIssueKey(issue))) return;
      seen.add(bookIssueKey(issue));
      suggestions.push(issue);
    });
    return { preselected: pre, suggestions, from };
  }

  // The server's suggestions for one meeting, cached per modal open by
  // title|start|date (`cache` is a Map). Resolves to the response, or null
  // when the endpoint is unavailable (404/501) or failed: callers then use the
  // local history (resolveBookingSuggestions).
  function loadBookingSuggestions(apiClient, cache, title, startText, date) {
    const key = `${title}|${startText}|${date}`;
    if (!cache.has(key)) {
      let call;
      try {
        call = typeof apiClient.bookingSuggestions === 'function'
          ? Promise.resolve(apiClient.bookingSuggestions({ title, start: startText, date }))
          : Promise.resolve(null);
      } catch (e) { call = Promise.resolve(null); }
      cache.set(key, call.then((res) => (res && typeof res === 'object' && Array.isArray(res.suggestions) ? res : null), () => null));
    }
    return cache.get(key);
  }

  // One clickable Suggestions chip (the dialog's rows and the form): swaps in
  // place of the issue it is booked on. Chip markup helpers: projects share
  // the timeline's colour hash.
  const bookStripe = (i) => `<span class="omnitime-bk__stripe${i.project ? ' omnitime-bk__stripe--p' + projectColorIndex(i.project) : ''}" aria-hidden="true"></span>`;
  const bookChipText = (i) => `<span class="omnitime-bk__chiptext">${i.ext ? `<span class="omnitime-bk__id">#${esc(i.ext)}</span> ` : ''}<span class="omnitime-bk__name">${esc(i.name)}</span></span>`;
  function suggestionChipHtml(issue, k, extraClass) {
    const title = [BOOK_REASON_TEXT[issue.reason], bookIssueFull(issue)].filter(Boolean).join('\n');
    return `<button type="button" class="omnitime-bk__chip omnitime-bk__sugg${extraClass ? ' ' + extraClass : ''}" data-act="sugg" data-k="${k}" aria-label="Use ${esc(bookIssueText(issue))} instead" title="${esc(title)}">${bookStripe(issue)}${issue.reason === 'time' ? icon('clock') : ''}${bookChipText(issue)}</button>`;
  }
  // The result of putting suggestions[k] in place of `current` (the issue it
  // is booked on, or null): the previous one takes the clicked chip's position.
  function swapSuggestion(current, suggestions, k) {
    const clicked = suggestions[k];
    const list = suggestions.slice();
    if (current) list[k] = current; else list.splice(k, 1);
    return { current: clicked, suggestions: list };
  }
  // Picking `picked` from the search: the previous issue joins the front of
  // the Suggestions (the picked one is no longer suggested), max 3.
  function pickSuggestion(current, suggestions, picked) {
    const list = suggestions.filter((s) => bookIssueKey(s) !== bookIssueKey(picked));
    if (current && bookIssueKey(current) !== bookIssueKey(picked)) list.unshift(current);
    return { current: picked, suggestions: list.slice(0, BOOK_MAX_SUGGESTIONS) };
  }

  // --- Compact issue search (the "Book meetings" rows) ---
  // The form's search, in a row: an ARIA combobox over apiClient.search, with
  // Starred / Recent / Frequent on an empty query (same options and grouping
  // as the form, see emptyQueryGroups). deps: { apiClient, state, ui, label,
  // onPick(option), onClose() }. Returns { focus, destroy }.
  let finderSeq = 0;
  function mountIssueFinder(container, deps) {
    const { apiClient, state, ui } = deps;
    const uid = 'omnitime-bkf' + (++finderSeq);
    container.innerHTML = `
      <div class="omnitime-bk__finder">
        <span class="omnitime-bk__finder-icon">${icon('search')}</span>
        <input type="text" class="omnitime-bk__finder-input" placeholder="Search issue&hellip;" aria-label="${esc(deps.label)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-list">
        <button type="button" class="omnitime-bk__finder-x" aria-label="Close search">${icon('close')}</button>
      </div>
      <div class="omnitime-bk__results" id="${uid}-list" role="listbox" aria-label="Issues" hidden></div>`;
    const input = container.querySelector('.omnitime-bk__finder-input');
    const list = container.querySelector('.omnitime-bk__results');
    const bookmarks = state.bookmarks || null;
    let options = [];
    let activeIdx = -1;
    let seq = 0;
    let timer = null;

    const setActive = (idx) => {
      activeIdx = idx;
      const items = [...list.querySelectorAll('[role="option"][data-idx]')];
      items.forEach((el, i) => {
        el.classList.toggle('omnitime-search__item--active', i === idx);
        el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      });
      if (items[idx]) {
        input.setAttribute('aria-activedescendant', items[idx].id);
        items[idx].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    };
    const show = (html) => {
      options = [];
      list.innerHTML = html;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      setActive(-1);
    };
    const hide = () => {
      clearTimeout(timer);
      seq++;
      options = [];
      list.hidden = true;
      list.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      setActive(-1);
    };
    const showMessage = (text) => show(`<div class="omnitime-search__empty" role="option" aria-disabled="true" aria-selected="false">${esc(text)}</div>`);
    const showGroups = (groups) => {
      const flat = [];
      const html = groups.map((g, gi) => {
        const items = g.items.map((o) => {
          const idx = flat.push(o) - 1;
          return `<button class="omnitime-search__item" type="button" role="option" tabindex="-1" id="${uid}-opt-${idx}" aria-selected="false" data-idx="${idx}">
            ${o.kicker ? `<span class="omnitime-search__kicker">${esc(o.kicker)}</span>` : ''}
            <span class="omnitime-search__label">${esc(o.name)}${o.idText ? ` <span class="omnitime-search__id">${esc(o.idText)}</span>` : ''}</span>
          </button>`;
        }).join('');
        return g.title
          ? `<div role="group" aria-labelledby="${uid}-grp-${gi}"><div class="omnitime-search__group" id="${uid}-grp-${gi}">${esc(g.title)}</div>${items}</div>`
          : items;
      }).join('');
      show(html);
      options = flat;
      list.querySelectorAll('.omnitime-search__item').forEach((b) => {
        b.addEventListener('click', () => deps.onPick(options[parseInt(b.dataset.idx, 10)]));
      });
    };
    const showRecent = () => {
      clearTimeout(timer);
      const mine = ++seq;
      const frequent = state.frequent
        ? Promise.resolve(state.frequent)
        : Promise.resolve(apiClient.frequent ? apiClient.frequent() : null).then((res) => { state.frequent = (res && res.issues) || []; return state.frequent; }, () => []);
      Promise.all([loadRecentIssues(), bookmarks ? Promise.resolve(bookmarks.load()).catch(() => []) : [], frequent]).then(([recent, , freq]) => {
        if (mine !== seq || input.value.trim()) return;
        const groups = emptyQueryGroups(bookmarks && bookmarks.isReady() ? bookmarks.items() : [], recent, freq);
        if (!groups.length) { hide(); return; }
        showGroups(groups);
      });
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { showRecent(); return; }
      if (q.length < 2) { hide(); return; }
      const mine = ++seq;
      timer = setTimeout(() => {
        apiClient.search(q).then((res) => {
          if (mine !== seq) return;
          const issues = (res && res.issues) || [];
          if (!issues.length) { showMessage('No matches'); return; }
          showGroups([{ items: issues.map(searchOption) }]);
        }).catch(() => { if (mine === seq) showMessage('Search unavailable'); });
      }, 150);
    });
    input.addEventListener('focus', () => { if (!input.value.trim() && list.hidden) showRecent(); });
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    input.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      const open = !list.hidden && options.length > 0;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!open) {
          if (ev.key === 'ArrowDown' && !input.value.trim()) { ev.preventDefault(); showRecent(); }
          return;
        }
        ev.preventDefault();
        const n = options.length;
        setActive(ev.key === 'ArrowDown' ? (activeIdx + 1) % n : (activeIdx <= 0 ? n - 1 : activeIdx - 1));
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (open && activeIdx >= 0) deps.onPick(options[activeIdx]);
      }
    });
    container.querySelector('.omnitime-bk__finder-x').addEventListener('click', () => deps.onClose());

    // Escape closes the search first, then the dialog.
    const popEscape = ui && ui.pushEscape ? ui.pushEscape(() => { deps.onClose(); return true; }, container) : null;
    input.focus({ preventScroll: true });
    return {
      focus: () => input.focus({ preventScroll: true }),
      destroy: () => { clearTimeout(timer); seq++; if (popEscape) popEscape(); },
    };
  }

  // --- "Book meetings": review -> booking -> done ---
  // A dialog layered over My day (inside ui.dialog; Tab is trapped in it via
  // ui.pushTrap, Escape is a layer). Review: one row per bookable meeting with
  // the issue it will be booked on (preselected from the user's own history,
  // see resolveBookingSuggestions), up to three one-click Suggestions that swap
  // with it, and a Search. Booking: the checked rows are created one after the
  // other (a failure doesn't stop the run; failed rows can be retried). Done:
  // the summary with Undo.
  // env: { apiClient, state, date, meetings (bookableMeetings), onClose({ changed }) }
  const BOOK_STEPS = ['Review', 'Booking', 'Done'];
  function openBookDialog(ui, opener, env) {
    const { apiClient, state, date, meetings } = env;
    const host = (ui && ui.dialog) || document.body;
    const memoryOf = (m) => ((state.calMemory && state.calMemory.issues) || {})[calSeriesKey(m.cal)];
    const cache = state.bookingCache || (state.bookingCache = new Map());
    const now = new Date();
    // Meetings that have started (any on a past day) are checked, later ones aren't.
    const nowMin = date === todayStr() ? now.getHours() * 60 + now.getMinutes() : Infinity;
    const rows = meetings.map((m, idx) => ({
      m, idx, checked: m.start <= nowMin, later: m.start > nowMin,
      issue: null, suggestions: [], loading: true, finder: null, status: 'idle', err: null, entryId: null,
    }));

    const scrim = elem('div', 'omnitime-bk');
    scrim.innerHTML = `
      <div class="omnitime-bk__panel" role="dialog" aria-modal="true" aria-labelledby="omnitime-bk-title" tabindex="-1">
        <div class="omnitime-bk__head">
          <h3 class="omnitime-bk__title" id="omnitime-bk-title">Book meetings &middot; ${esc(shortDate(date))}</h3>
          <ol class="omnitime-bk__steps" aria-label="Steps">${BOOK_STEPS.map((s, i) => `<li class="omnitime-bk__step" data-step="${i}"><span class="omnitime-bk__stepname">${s}</span></li>`).join('')}</ol>
          <button class="omnitime-bk__x" type="button" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="omnitime-bk__body"></div>
        <div class="omnitime-bk__foot">
          <div class="omnitime-bk__info"><span class="omnitime-bk__summary"></span><span class="omnitime-bk__hint" id="omnitime-bk-hint"></span></div>
          <div class="omnitime-bk__btns">
            <button class="omnitime-bk__cancel" type="button">Cancel</button>
            <button class="omnitime-bk__ok" type="button" aria-describedby="omnitime-bk-hint"></button>
          </div>
        </div>
        <div class="ot-visually-hidden omnitime-bk__live" role="status" aria-live="polite"></div>
      </div>`;
    const panel = scrim.querySelector('.omnitime-bk__panel');
    const body = scrim.querySelector('.omnitime-bk__body');
    const steps = [...scrim.querySelectorAll('.omnitime-bk__step')];
    const closeX = scrim.querySelector('.omnitime-bk__x');
    const summary = scrim.querySelector('.omnitime-bk__summary');
    const hint = scrim.querySelector('.omnitime-bk__hint');
    const cancelBtn = scrim.querySelector('.omnitime-bk__cancel');
    const okBtn = scrim.querySelector('.omnitime-bk__ok');
    const live = scrim.querySelector('.omnitime-bk__live');

    let step = 0;
    let busy = false;      // a booking request is running: no closing
    let closed = false;
    let changed = false;   // entries were created or removed: the day must reload
    let popEscape = null;
    let popTrap = null;
    const queue = [];
    const announce = (text) => { live.textContent = ''; live.textContent = text; };

    // --- Step 1: review ---
    const rowEl = (row) => body.querySelector(`.omnitime-bk__row[data-idx="${row.idx}"]`);
    function bookOnHtml(row, flash) {
      if (row.loading) return '<span class="omnitime-bk__skel omnitime-bk__skel--on" aria-hidden="true"></span><span class="ot-visually-hidden">Loading suggestions</span>';
      const i = row.issue;
      if (!i) return '<button type="button" class="omnitime-bk__ph" data-act="find">Choose an issue</button>';
      return `<span class="omnitime-bk__chip omnitime-bk__on${flash ? ' omnitime-bk__chip--in' : ''}" title="${esc(bookIssueFull(i))}">${bookStripe(i)}${bookChipText(i)}<button type="button" class="omnitime-bk__clear" data-act="clear" aria-label="Clear ${esc(bookIssueText(i))}">${icon('close')}</button></span>`;
    }
    function rowHtml(row, flashK) {
      const m = row.m;
      const time = `${fmtClock(m.start)}–${fmtClock(m.stop)}`;
      const needs = row.checked && !row.loading && !row.issue;
      const chips = row.loading
        ? '<span class="omnitime-bk__skel" aria-hidden="true"></span><span class="omnitime-bk__skel" aria-hidden="true"></span><span class="omnitime-bk__skel" aria-hidden="true"></span>'
        : row.suggestions.map((s, k) => suggestionChipHtml(s, k, k === flashK ? 'omnitime-bk__chip--in' : '')).join('');
      return `
        <div class="omnitime-bk__top">
          <input type="checkbox" class="omnitime-bk__check" id="omnitime-bk-c${row.idx}"${row.checked ? ' checked' : ''}>
          <label class="omnitime-bk__when" for="omnitime-bk-c${row.idx}"><span class="omnitime-bk__time">${time}</span><span class="omnitime-bk__dur">${fmtDur(m.dur)}</span><span class="omnitime-bk__name-title">${esc(m.title)}</span></label>
          ${row.later ? '<span class="omnitime-bk__tag">later</span>' : ''}
          ${needs ? '<span class="omnitime-bk__tag omnitime-bk__tag--warn">needs an issue</span>' : ''}
        </div>
        <div class="omnitime-bk__main">
          <div class="omnitime-bk__field omnitime-bk__field--on"><span class="omnitime-bk__lbl">Book on</span><div class="omnitime-bk__chips">${bookOnHtml(row, flashK != null)}</div></div>
          <div class="omnitime-bk__field omnitime-bk__field--sugg"><span class="omnitime-bk__lbl">Suggestions</span><div class="omnitime-bk__chips">${chips}<button type="button" class="omnitime-bk__find-btn" data-act="find"${row.loading ? ' disabled' : ''}>${icon('search')}<span>Search&hellip;</span></button></div></div>
        </div>
        <div class="omnitime-bk__find" hidden></div>`;
    }
    // focus: a selector to focus after the row was redrawn; flashK: index of
    // the Suggestions chip that just swapped (animated, with the Book on chip).
    function renderRow(row, o) {
      o = o || {};
      const li = rowEl(row);
      if (!li) return;
      if (row.finder) { row.finder.destroy(); row.finder = null; }
      li.className = 'omnitime-bk__row' + (row.checked ? '' : ' omnitime-bk__row--off') + (row.checked && !row.loading && !row.issue ? ' omnitime-bk__row--needs' : '');
      li.innerHTML = rowHtml(row, o.flashK);
      if (o.focus) { const el = li.querySelector(o.focus); if (el) el.focus({ preventScroll: true }); }
      updateFooter();
    }
    function showReview() {
      body.innerHTML = '<ul class="omnitime-bk__rows"></ul>';
      const ul = body.firstChild;
      rows.forEach((row) => {
        const li = elem('li', 'omnitime-bk__row');
        li.dataset.idx = row.idx;
        ul.appendChild(li);
      });
      rows.forEach((row) => renderRow(row));
    }

    function updateFooter() {
      if (step !== 0) return;
      const chosen = rows.filter((r) => r.checked);
      const total = chosen.reduce((s, r) => s + r.m.dur, 0);
      const missing = chosen.filter((r) => !r.loading && !r.issue).length;
      const loading = chosen.some((r) => r.loading);
      summary.textContent = `${chosen.length} of ${rows.length} selected · ${fmtDur(total)}`;
      hint.textContent = missing ? (missing === 1 ? '1 selected meeting needs an issue' : `${missing} selected meetings need an issue`) : (loading ? 'Loading suggestions…' : '');
      hint.classList.toggle('omnitime-bk__hint--warn', missing > 0);
      okBtn.textContent = chosen.length ? `Book ${plural(chosen.length, 'meeting')}` : 'Book meetings';
      okBtn.disabled = !chosen.length || missing > 0 || loading;
    }

    // The issue of a row changed: redraw it, tell screen readers, keep focus.
    function setIssue(row, next, o) {
      row.issue = next.current;
      row.suggestions = next.suggestions;
      announce(row.issue ? `Booking ${row.m.title} on ${bookIssueText(row.issue)}` : `${row.m.title} has no issue`);
      renderRow(row, o);
    }
    function swap(row, k) {
      if (!row.suggestions[k]) return;
      const hadIssue = !!row.issue;
      setIssue(row, swapSuggestion(row.issue, row.suggestions, k), {
        flashK: k,
        focus: hadIssue ? `.omnitime-bk__sugg[data-k="${k}"]` : '.omnitime-bk__clear',
      });
    }
    function clearIssue(row) {
      const prev = row.issue;
      if (!prev) return;
      // Not lost: it moves to the front of the Suggestions.
      setIssue(row, { current: null, suggestions: [prev].concat(row.suggestions).slice(0, BOOK_MAX_SUGGESTIONS) }, { focus: '.omnitime-bk__ph' });
    }
    function openFinder(row) {
      const li = rowEl(row);
      const slot = li && li.querySelector('.omnitime-bk__find');
      if (!slot) return;
      if (row.finder) { row.finder.focus(); return; }
      slot.hidden = false;
      li.querySelector('.omnitime-bk__find-btn').setAttribute('aria-expanded', 'true');
      const closeFinder = (refocus) => {
        if (!row.finder) return;
        row.finder.destroy();
        row.finder = null;
        slot.hidden = true;
        slot.innerHTML = '';
        const btn = li.querySelector('.omnitime-bk__find-btn');
        if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus({ preventScroll: true }); }
      };
      row.finder = mountIssueFinder(slot, {
        apiClient, state, ui,
        label: `Search an issue for ${row.m.title}`,
        onClose: () => closeFinder(true),
        onPick: (opt) => {
          if (!opt) return;
          const picked = bookIssueFromOption(opt);
          if (picked.id == null && !picked.ref) return;
          if (row.issue && bookIssueKey(row.issue) === bookIssueKey(picked)) { closeFinder(true); return; }
          setIssue(row, pickSuggestion(row.issue, row.suggestions, picked), { focus: '.omnitime-bk__find-btn' });
        },
      });
    }

    // Suggestions come from the server (cached per modal open) or, without it,
    // from the local history; either way the row stays editable meanwhile.
    rows.forEach((row) => {
      const m = row.m;
      loadBookingSuggestions(apiClient, cache, m.title, fmtClock(m.start), date).then((server) => {
        if (closed) return;
        const r = resolveBookingSuggestions(server, memoryOf(m));
        row.issue = r.preselected;
        row.suggestions = r.suggestions;
        row.loading = false;
        if (step === 0) renderRow(row); else updateFooter();
      });
    });

    // --- Steps 2 and 3: booking, done ---
    const issueArrow = (row) => esc(bookIssueText(row.issue));
    const ROW_STATUS = { busy: 'Booking', wait: 'Waiting', ok: 'Booked', fail: 'Failed' };
    function progressRowHtml(row) {
      const state_ = row.status;
      const mark = state_ === 'ok' ? icon('check') : state_ === 'fail' ? icon('close') : state_ === 'busy' ? '<span class="omnitime-bk__spinner"></span>' : '<span class="omnitime-bk__dot"></span>';
      return `<li class="omnitime-bk__prow omnitime-bk__prow--${state_}" data-idx="${row.idx}">
        <span class="omnitime-bk__mark" aria-hidden="true">${mark}</span>
        <span class="ot-visually-hidden">${ROW_STATUS[state_]}: </span>
        <span class="omnitime-bk__ptext"><span class="omnitime-bk__time">${fmtClock(row.m.start)}–${fmtClock(row.m.stop)}</span> <strong>${esc(row.m.title)}</strong> <span class="omnitime-bk__parrow">&rarr; ${issueArrow(row)}</span></span>
        ${state_ === 'fail' ? `<span class="omnitime-bk__pfail"><span class="omnitime-bk__perr">${esc(errorReason(row.err))}</span> <button type="button" class="omnitime-bk__link" data-act="retry">Retry</button></span>` : ''}
      </li>`;
    }
    const bookedRows = () => rows.filter((r) => r.status === 'ok');
    function renderProgress() {
      const active = rows.filter((r) => r.checked);
      const failed = active.filter((r) => r.status === 'fail');
      let head = '';
      if (step === 2) {
        const ok = bookedRows();
        const total = ok.reduce((s, r) => s + r.m.dur, 0);
        head = `<div class="omnitime-bk__result" role="status"><strong>${ok.length ? `Booked ${plural(ok.length, 'meeting')} · ${fmtDur(total)}` : 'No meetings booked'}</strong> ${failed.length ? `<span class="omnitime-bk__failed">${failed.length} failed &middot; <button type="button" class="omnitime-bk__link" data-act="retry-all">Retry failed</button></span>` : ''}</div>`;
      }
      body.innerHTML = `${head}<ul class="omnitime-bk__progress">${active.map(progressRowHtml).join('')}</ul>`;
      if (step === 1) {
        const done = active.filter((r) => r.status === 'ok' || r.status === 'fail').length;
        summary.textContent = `Booking ${Math.min(done + 1, active.length)} of ${active.length}…`;
      }
    }

    // POSTs the queued rows one after the other; a failed row doesn't stop the
    // run. Retry queues a row again (also while the run is still going).
    async function pump() {
      if (busy) return;
      busy = true;
      closeX.disabled = true;
      while (queue.length) {
        const row = queue.shift();
        row.status = 'busy';
        renderProgress();
        const res = await createSequentially(apiClient, [row], (r) => ({
          ...entryPayload(date, fmtClock(r.m.start), r.m.dur, r.m.title),
          ...bookIssueFields(r.issue),
        }));
        if (closed) return;
        const made = res.created[0];
        if (made) {
          row.status = 'ok';
          row.err = null;
          row.entryId = made.id;
          changed = true;
          await rememberBooking(row, made.id);
        } else {
          row.status = 'fail';
          row.err = res.failed && res.failed.err;
        }
        renderProgress();
      }
      busy = false;
      closeX.disabled = false;
      if (!closed) setStep(2);
    }
    // As the single form does after a booking: link the event to its entry (it
    // hides), remember the issue (+ history) for the series, and the recent list.
    function rememberBooking(row, id) {
      const issue = row.issue;
      const mem = issue.id != null ? bookIssueMemory(issue) : null;
      const recent = issue.id != null
        ? { issue_id: issue.id, label: bookIssueLabel(issue) }
        : { source: issue.ref.source, project_id: issue.ref.project_id, issue_id: issue.ref.issue_id, label: bookIssueLabel(issue) };
      return recordCalBooking(row.m.cal, id, date, mem).catch(() => {})
        .then(() => rememberRecentIssue(recent)).catch(() => {});
    }
    function retry(list) {
      list.forEach((row) => { row.status = 'wait'; row.err = null; queue.push(row); });
      if (step === 2) setStep(1);
      renderProgress();
      panel.focus({ preventScroll: true });
      pump();
    }
    function startBooking() {
      const chosen = rows.filter((r) => r.checked && r.issue);
      rows.forEach((r) => { if (r.finder) { r.finder.destroy(); r.finder = null; } });
      chosen.forEach((r) => { r.status = 'wait'; queue.push(r); });
      setStep(1);
      pump();
    }

    async function undo() {
      const ok = bookedRows();
      if (!ok.length || busy) return;
      busy = true;
      closeX.disabled = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      summary.textContent = 'Undoing…';
      const failed = await removeAll(apiClient, ok.map((r) => r.entryId));
      await forgetCalBookings(ok.map((r) => r.m.key)).catch(() => {});
      busy = false;
      changed = true;
      if (failed && ui && ui.toast) ui.toast(`Couldn't undo ${failed} of ${ok.length} entries.`);
      else if (ui && ui.toast) ui.toast('Booking undone');
      close();
    }

    // --- Shell: steps, buttons, closing ---
    function setStep(n) {
      step = n;
      steps.forEach((el, i) => {
        el.classList.toggle('omnitime-bk__step--current', i === n);
        el.classList.toggle('omnitime-bk__step--past', i < n);
        if (i === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
      });
      hint.textContent = '';
      hint.classList.remove('omnitime-bk__hint--warn');
      cancelBtn.disabled = false;
      closeX.disabled = busy;
      if (n === 0) {
        cancelBtn.hidden = false;
        cancelBtn.textContent = 'Cancel';
        okBtn.hidden = false;
        showReview();
      } else if (n === 1) {
        cancelBtn.hidden = true;
        okBtn.hidden = true;
        renderProgress();
        panel.focus({ preventScroll: true });
      } else {
        const ok = bookedRows();
        cancelBtn.hidden = !ok.length;
        cancelBtn.textContent = 'Undo';
        okBtn.hidden = false;
        okBtn.disabled = false;
        okBtn.textContent = 'Done';
        renderProgress();
        summary.textContent = '';
        okBtn.focus({ preventScroll: true });
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      if (releaseHold) releaseHold();
      rows.forEach((r) => { if (r.finder) r.finder.destroy(); });
      if (popEscape) { popEscape(); popEscape = null; }
      if (popTrap) { popTrap(); popTrap = null; }
      scrim.remove();
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      else if (ui && ui.dialog) ui.dialog.focus({ preventScroll: true });
      if (env.onClose) env.onClose({ changed });
    }
    const tryClose = () => { if (!busy) close(); return !busy; };

    closeX.addEventListener('click', tryClose);
    cancelBtn.addEventListener('click', () => { if (step === 2) undo(); else tryClose(); });
    okBtn.addEventListener('click', () => {
      if (step === 0) { if (!okBtn.disabled) startBooking(); } else if (step === 2) close();
    });
    scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) tryClose(); });

    body.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn || busy && btn.dataset.act !== 'retry') return;
      const li = btn.closest('[data-idx]');
      const row = li ? rows[Number(li.dataset.idx)] : null;
      switch (btn.dataset.act) {
        case 'sugg': if (row) swap(row, Number(btn.dataset.k)); break;
        case 'clear': if (row) clearIssue(row); break;
        case 'find': if (row) openFinder(row); break;
        case 'retry': if (row) retry([row]); break;
        case 'retry-all': retry(rows.filter((r) => r.status === 'fail')); break;
        default: break;
      }
    });
    body.addEventListener('change', (ev) => {
      if (!ev.target.classList.contains('omnitime-bk__check')) return;
      const row = rows[Number(ev.target.closest('[data-idx]').dataset.idx)];
      row.checked = ev.target.checked;
      renderRow(row, { focus: '.omnitime-bk__check' });
    });
    // Up / Down on a row's checkbox move between the rows.
    body.addEventListener('keydown', (ev) => {
      if (ev.target.classList && ev.target.classList.contains('omnitime-bk__check') && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        const boxes = [...body.querySelectorAll('.omnitime-bk__check')];
        const next = boxes[boxes.indexOf(ev.target) + (ev.key === 'ArrowDown' ? 1 : -1)];
        ev.preventDefault();
        if (next) next.focus();
      }
    });
    // Plain keys belong to the dialog: My day's shortcuts (N, T, arrows) must
    // not act on the day behind it.
    scrim.addEventListener('keydown', (ev) => { if (ev.key !== 'Tab' && ev.key !== 'Escape') ev.stopPropagation(); });

    host.appendChild(scrim);
    // While a booking request runs the whole modal stays open too (backdrop
    // click, a second toolbar click): Undo and the summary live here.
    const releaseHold = ui && ui.holdOpen ? ui.holdOpen(() => busy) : null;
    popEscape = ui && ui.pushEscape ? ui.pushEscape(tryClose, scrim) : null;
    popTrap = ui && ui.pushTrap ? ui.pushTrap(panel) : null;
    setStep(0);
    const first = body.querySelector('.omnitime-bk__check');
    (first || panel).focus({ preventScroll: true });
    return { el: scrim, close };
  }

  // A small confirm popover anchored above `anchor`, inside the dialog (so
  // Tab stays trapped in it): a title, a checkbox list (all on) and a confirm
  // button. Escape / Cancel / a click outside close it. onConfirm(picked,
  // pop) gets the checked rows; pop.busy(text), pop.result(html),
  // pop.error(err, title) and pop.close() drive it while it works.
  //   rows: [{ html, label }]  (html: trusted markup, label: accessible name)
  function openChecklistPopover(ui, anchor, opts) {
    const host = (ui && ui.dialog) || document.body;
    host.querySelectorAll('.omnitime-daypop').forEach((el) => el._close && el._close());
    const pop = elem('div', 'omnitime-daypop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'omnitime-daypop-title');
    pop.innerHTML = `
      <div class="omnitime-daypop__head" id="omnitime-daypop-title">${esc(opts.title)}</div>
      <div class="omnitime-daypop__body"></div>
      <div class="omnitime-daypop__actions">
        <span class="omnitime-daypop__status" aria-live="polite"></span>
        <button class="omnitime-daypop__cancel" type="button">Cancel</button>
        <button class="omnitime-daypop__ok" type="button"></button>
      </div>`;
    const body = pop.querySelector('.omnitime-daypop__body');
    const status = pop.querySelector('.omnitime-daypop__status');
    const okBtn = pop.querySelector('.omnitime-daypop__ok');
    const cancelBtn = pop.querySelector('.omnitime-daypop__cancel');
    let boxes = [];
    let working = false;

    const refresh = () => {
      const n = boxes.filter((b) => b.checked).length;
      okBtn.textContent = opts.confirmLabel(n);
      okBtn.disabled = working || !n;
    };
    const setRows = (rows, empty) => {
      body.innerHTML = '';
      if (!rows.length) {
        body.appendChild(elem('p', 'omnitime-daypop__empty', esc(empty || 'Nothing to do.')));
      } else {
        const list = elem('ul', 'omnitime-daypop__list');
        rows.forEach((row, i) => {
          const li = elem('li', 'omnitime-daypop__row');
          li.innerHTML = `<label class="omnitime-daypop__item"><input type="checkbox" checked data-idx="${i}" aria-label="${esc(row.label)}"><span class="omnitime-daypop__text">${row.html}</span></label>`;
          list.appendChild(li);
        });
        body.appendChild(list);
      }
      boxes = [...body.querySelectorAll('input[type="checkbox"]')];
      boxes.forEach((b) => b.addEventListener('change', refresh));
      refresh();
    };

    // On the shadow root, not the document: with a closed root the document
    // only sees the retargeted host, so composedPath() would hide the popover.
    const evRoot = (ui && ui.root) || document;
    const onOutside = (ev) => {
      const path = ev.composedPath ? ev.composedPath() : [];
      if (path.includes(pop) || path.includes(anchor) || pop.contains(ev.target)) return;
      if (!working) close();
    };
    let popEscape = null;
    function close() {
      // Always unregister: a modal that closed underneath us already detached pop.
      evRoot.removeEventListener('pointerdown', onOutside, true);
      if (!pop.isConnected) return;
      pop.remove();
      if (popEscape) { popEscape(); popEscape = null; }
      if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
      else if (ui && ui.dialog) ui.dialog.focus({ preventScroll: true });
      if (opts.onClose) opts.onClose();
    }
    pop._close = close;
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', () => {
      const picked = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.idx));
      if (!picked.length || working) return;
      opts.onConfirm(picked, api);
    });

    const api = {
      el: pop,
      setRows,
      busy: (text) => {
        working = !!text;
        status.textContent = text || '';
        boxes.forEach((b) => { b.disabled = working; });
        cancelBtn.disabled = working;
        refresh();
      },
      // Replace the list with an outcome (trusted html) + a Close button.
      result: (html) => {
        working = false;
        status.textContent = '';
        body.innerHTML = html;
        boxes = [];
        okBtn.hidden = true;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Close';
        cancelBtn.focus();
      },
      error: (err, title) => {
        api.result('');
        renderError(body, err, { title });
        cancelBtn.focus();
      },
      close,
    };

    setRows(opts.rows || [], opts.empty);
    if (opts.loading) {
      body.innerHTML = `<p class="omnitime-daypop__empty">${esc(opts.loading)}</p>`;
      okBtn.disabled = true;
    }
    host.appendChild(pop);
    // Above the anchor, left-aligned with it (clamped into the dialog).
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    if (hr.height) {
      const below = ar.top - hr.top < hr.height / 2;
      if (below) pop.style.top = Math.round(ar.bottom - hr.top + 6) + 'px';
      else pop.style.bottom = Math.round(hr.bottom - ar.top + 6) + 'px';
      const width = pop.offsetWidth || 360;
      pop.style.left = Math.round(clamp(ar.left - hr.left, 12, Math.max(12, hr.width - width - 12))) + 'px';
    }
    popEscape = ui && ui.pushEscape ? ui.pushEscape(() => { if (working) return false; popEscape = null; close(); return true; }, pop) : null;
    evRoot.addEventListener('pointerdown', onOutside, true);
    (boxes[0] || cancelBtn).focus({ preventScroll: true });
    return api;
  }

  // --- Week math + data (Week tab, absences in the My day strip) ---
  // Local calendar dates only ("YYYY-MM-DD" + addDays, which steps by
  // calendar day), so DST changes never shift a day.
  const isWeekendDate = (dateStr) => {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    return dow === 0 || dow === 6;
  };
  function weekMonday(dateStr) {
    const dow = (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7; // 0 = Monday
    return addDays(dateStr, -dow);
  }
  const weekDates = (dateStr) => {
    const monday = weekMonday(dateStr);
    return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
  };
  // ISO 8601 week number ("Week 43"): the week belongs to the year that holds
  // its Thursday, week 1 is the one with January 4th. UTC arithmetic, so DST
  // never shifts a day.
  function isoWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const thursday = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - dow + 3);
    const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
    return Math.floor((thursday - jan1) / (7 * 86400000)) + 1;
  }

  // Day status for the week strip and the Week tab: { state, pct, text } or
  // null when there is nothing to measure (no target: weekend, full-day
  // absence, target off; or a day still ahead). "met" / "under" for past days,
  // "today" while the day is in progress.
  function dayMeter(date, total, target, today) {
    target = Math.round(Number(target) || 0);
    if (!(target > 0) || date > (today || todayStr())) return null;
    total = Math.max(0, Math.round(Number(total) || 0));
    const state = date === (today || todayStr()) ? 'today' : total >= target ? 'met' : 'under';
    const d = new Date(date + 'T00:00:00');
    const name = `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
    const verdict = state === 'met' ? 'target met' : state === 'under' ? `${fmtDur(target - total)} under target` : 'in progress';
    return { state, pct: Math.min(100, Math.round((total / target) * 100)), text: `${name}: ${fmtDur(total)} of ${fmtDur(target)} (${verdict})` };
  }
  // The thin meter bar (3 px); only its width is inline.
  function meterBar(m) {
    const bar = elem('span', 'omnitime-meter omnitime-meter--' + m.state);
    bar.setAttribute('aria-hidden', 'true');
    const fill = elem('span', 'omnitime-meter__fill');
    fill.style.width = m.pct + '%';
    bar.appendChild(fill);
    return bar;
  }

  // Entry anatomy shared by the timeline and the Week cards: the label and the
  // issue number apart (the number is shown muted after the label), a speech
  // glyph for the comment line.
  function entryIssueParts(raw) {
    const text = entryIssueText({ ...raw, issue_external_id: '' });
    return { label: text, id: raw.issue_external_id ? String(raw.issue_external_id) : '' };
  }
  const idHtml = (id) => (id ? `<span class="omnitime-entryid"> #${esc(id)}</span>` : '');
  const commentGlyph = () => '<svg class="ot-svg ot-svg--comment" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 20.5l1.5-5.2A8 8 0 1 1 21 12z"/></svg>';
  // my-tracked-week absences -> { date: { half_day } }, weekdays only (the web
  // app ignores the Saturday/Sunday of an absence that spans a weekend). Two
  // items on one date add up to a full day.
  function absenceMap(list) {
    const out = {};
    (Array.isArray(list) ? list : []).forEach((a) => {
      if (!a || !a.date || isWeekendDate(a.date)) return;
      out[a.date] = out[a.date] ? { half_day: false } : { half_day: !!a.half_day };
    });
    return out;
  }
  // my-tracked-week response -> { monday, target, days: [7 x { date, weekend,
  // entries (by start), total, target, absence }], total, targetTotal,
  // canViewOthers (the caller may view colleagues' weeks), user ({ uid, name }
  // of another person's week, else null) }.
  function groupWeek(data, dateStr) {
    data = data || {};
    const anchor = data.date || dateStr || todayStr();
    const hours = Number(data.daily_working_hours);
    const target = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : DEFAULT_TARGET;
    const absences = absenceMap(data.absences);
    const byDate = {};
    (data.week_entries || []).forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
    const days = weekDates(anchor).map((date) => {
      const entries = (byDate[date] || []).slice().sort((a, b) => (parseClock(a.start) ?? 1e4) - (parseClock(b.start) ?? 1e4));
      const absence = absences[date] || null;
      return {
        date,
        weekend: isWeekendDate(date),
        entries,
        total: entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0),
        target: dayTarget(date, target, absence),
        absence,
      };
    });
    const who = data.user && typeof data.user === 'object' && data.user.uid != null ? data.user : null;
    return {
      monday: days[0].date,
      target,
      days,
      total: days.reduce((s, d) => s + d.total, 0),
      targetTotal: days.reduce((s, d) => s + d.target, 0),
      canViewOthers: data.can_view_others === true,
      user: who ? { uid: who.uid, name: String(who.name == null ? '' : who.name) } : null,
    };
  }

  // Per-modal cache of my-tracked-week, one request per week (every call
  // reaches Personio live). Absences are personal (HR) data: they live only
  // here, in memory, for the modal's lifetime - never chrome.storage, logs or
  // the badge. A week goes stale when My day's totals for it no longer match
  // (an entry was added/changed), and is refetched the next time it is shown.
  function createWeekStore(apiClient) {
    // Own weeks under "monday", another person's under "uid|monday" (read-only
    // data about a colleague: memory only, like the absences).
    const cache = new Map(); // key -> { promise, data, week, stale }
    let unavailable = typeof apiClient.week !== 'function';
    const keyOf = (monday, uid) => (uid == null ? monday : `${uid}|${monday}`);
    const store = {
      available: () => !unavailable,
      // Promise of the grouped week (see groupWeek) around `date`; opts.uid
      // asks for that person's week, opts.force refetches.
      get(date, opts) {
        const uid = opts && opts.uid != null ? opts.uid : null;
        const monday = weekMonday(date);
        const key = keyOf(monday, uid);
        const hit = cache.get(key);
        if (hit && !hit.stale && !(opts && opts.force)) return hit.promise;
        if (unavailable) return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        const slot = { stale: false, week: hit ? hit.week : null };
        slot.promise = (uid == null ? apiClient.week(monday) : apiClient.week(monday, { uid })).then((data) => {
          slot.week = groupWeek(data, monday);
          return slot.week;
        }, (err) => {
          // A 404 for another person is "no such user", not a missing endpoint.
          if (uid == null && isUnavailable(err)) unavailable = true;
          if (cache.get(key) === slot) {
            if (hit && hit.week) cache.set(key, hit); else cache.delete(key);
          }
          throw err;
        });
        cache.set(key, slot);
        return slot.promise;
      },
      // The already loaded week around `date` (null if not loaded yet).
      peek: (date, uid) => {
        const hit = cache.get(keyOf(weekMonday(date), uid == null ? null : uid));
        return (hit && hit.week) || null;
      },
      // { half_day } for an absence on that (week)day, else null (own weeks).
      absenceFor(date) {
        const week = store.peek(date);
        const day = week && week.days.find((d) => d.date === date);
        return (day && day.absence) ? { half_day: !!day.absence.half_day } : null;
      },
      invalidate(date) {
        const hit = cache.get(weekMonday(date));
        if (hit) hit.stale = true;
      },
      // My day's week strip totals (data.week[]) vs the cached entries.
      reconcile(myDayData) {
        const days = (myDayData && myDayData.week) || [];
        days.forEach((d) => {
          const week = d && d.date && store.peek(d.date);
          const day = week && week.days.find((x) => x.date === d.date);
          if (day && Number(d.total_minutes) !== day.total) store.invalidate(d.date);
        });
      },
    };
    return store;
  }

  // Per-modal cache of my-bookmarks ("starred" issues). toggle() flips a star
  // at once and calls the API; a failure restores the previous state and
  // rejects. subscribe(fn) runs fn(id, starred) on every change.
  function createBookmarkStore(apiClient) {
    const supported = typeof apiClient.bookmarks === 'function' && typeof apiClient.bookmark === 'function' && typeof apiClient.unbookmark === 'function';
    let items = [];
    let ready = false;
    let loading = null;
    const listeners = new Set();
    const key = (id) => String(id);
    const notify = (id, on) => listeners.forEach((fn) => { try { fn(id, on); } catch (e) { /* keep going */ } });
    const store = {
      // True once my-bookmarks loaded (stars are offered only then).
      isReady: () => ready,
      load() {
        if (!supported) return Promise.resolve([]);
        if (!loading) {
          loading = apiClient.bookmarks().then((res) => {
            items = ((res && res.issues) || []).filter((i) => i && i.issue_internal_id != null);
            ready = true;
            return items.slice();
          }, (err) => {
            // A transient failure is retried on the next open of the list.
            if (!isUnavailable(err)) loading = null;
            return [];
          });
        }
        return loading;
      },
      items: () => items.slice(),
      has: (id) => id != null && items.some((i) => key(i.issue_internal_id) === key(id)),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // issue: { issue_internal_id, issue_external_id?, label, project?, milestone? }
      toggle(issue) {
        const id = issue && issue.issue_internal_id;
        if (id == null) return Promise.reject(new Error('No issue id'));
        const before = items.slice();
        const on = !store.has(id);
        items = on ? [{ ...issue, bookmarked: true }].concat(items) : items.filter((i) => key(i.issue_internal_id) !== key(id));
        notify(id, on);
        return (on ? apiClient.bookmark(id) : apiClient.unbookmark(id)).then(() => on, (err) => {
          items = before;
          notify(id, !on);
          throw err;
        });
      },
    };
    return store;
  }

  // --- "My day" tab ---
  // The scaffold (week strip + day nav + timeline/form columns + footer) is
  // built once; switching days fetches in the background and swaps only the
  // changed pieces in place, so transitions are seamless (no full re-render).
  function renderMyDayTab(root, apiClient, context, state, icalUrl, icalTransport, dashboardMode, useGoogleCalendar, ui) {
    if (window.omniDebugMode) console.log('OmniTime: renderMyDayTab called with icalUrl:', icalUrl, 'useGoogleCalendar:', useGoogleCalendar);
    root.innerHTML = '';
    const layout = elem('div', 'omnitime-myday');
    const weekWrap = elem('div', 'omnitime-week-wrap');

    // Day nav: [Today][<][>] as one segmented control, then the date and a
    // muted "Week 43". "Today" is disabled (not hidden) on today, so the
    // layout never jumps; the label keeps a minimum width for the same reason.
    const nav = elem('div', 'omnitime-daynav');
    nav.innerHTML = `
      <div class="omnitime-daynav__group" role="group" aria-label="Change day">
        <button class="omnitime-daynav__btn omnitime-daynav__today" type="button" data-nav="today" aria-label="Go to today">Today</button>
        <button class="omnitime-daynav__btn" type="button" data-nav="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <button class="omnitime-daynav__btn" type="button" data-nav="next" aria-label="Next day">${icon('chevronRight')}</button>
      </div>
      <span class="omnitime-daynav__label" aria-live="polite"></span>
      <span class="omnitime-daynav__week"></span>`;
    const navLabel = nav.querySelector('.omnitime-daynav__label');
    const navWeek = nav.querySelector('.omnitime-daynav__week');
    const navToday = nav.querySelector('[data-nav="today"]');
    const setNavDate = (date) => {
      navLabel.textContent = prettyDate(date);
      navWeek.textContent = 'Week ' + isoWeek(date);
      navToday.disabled = date === todayStr();
    };
    nav.querySelector('[data-nav="prev"]').addEventListener('click', () => loadDay(addDays(state.date, -1)));
    nav.querySelector('[data-nav="next"]').addEventListener('click', () => loadDay(addDays(state.date, 1)));
    navToday.addEventListener('click', () => {
      loadDay(todayStr());
      // The button disables itself; keep the focus in the nav.
      nav.querySelector('[data-nav="next"]').focus();
    });
    // "?" (right end of the nav): the keyboard shortcuts popover.
    const keysBtn = ui ? elem('button', 'omnitime-daynav__btn omnitime-daynav__keys', '?') : null;
    if (keysBtn) {
      keysBtn.type = 'button';
      keysBtn.title = 'Keyboard shortcuts (?)';
      keysBtn.setAttribute('aria-label', 'Keyboard shortcuts');
      keysBtn.setAttribute('aria-keyshortcuts', '?');
      keysBtn.setAttribute('aria-haspopup', 'dialog');
      keysBtn.addEventListener('click', () => toggleShortcutHelp(ui, keysBtn));
      nav.appendChild(keysBtn);
    }

    const cols = elem('div', 'omnitime-myday__cols');
    const timelineWrap = elem('div', 'omnitime-myday__timeline');
    const formWrap = elem('div', 'omnitime-myday__form');
    cols.appendChild(timelineWrap);
    cols.appendChild(formWrap); const footer = elem('div', 'omnitime-myday__total', '<span class="omnitime-myday__total-group">Total <strong>0:00</strong></span>');
    const footerTotal = footer.querySelector('strong');

    // Daily target progress beside the total (hidden without a target), and
    // "Book N meetings" (hidden when there is nothing to book). The add
    // button is inserted before both by buildTimeline.
    const progress = elem('span', 'omnitime-progress', `
      <span class="omnitime-progress__bar" role="progressbar" aria-label="Daily target" aria-valuemin="0" aria-valuemax="100"><span class="omnitime-progress__fill"></span></span>
      <span class="omnitime-progress__label"></span>`);
    progress.hidden = true;
    footer.appendChild(progress);
    const bookBtn = elem('button', 'omnitime-bookall', 'Book meetings');
    bookBtn.type = 'button';
    bookBtn.hidden = true;
    footer.insertBefore(bookBtn, footer.firstChild);
    let dayData = null;
    let dayCalEvents = [];

    // Calendar sync status indicator + refresh button (appended to footer).
    const calStatus = elem('span', 'omnitime-cal-status');
    const calRefresh = elem('button', 'omnitime-cal-refresh', `${icon('repeat')}`);
    calRefresh.title = 'Refresh calendar';
    calRefresh.setAttribute('aria-label', 'Refresh calendar');
    calRefresh.type = 'button';
    const calWrap = elem('span', 'omnitime-cal-status-wrap');
    calWrap.appendChild(calStatus);
    calWrap.appendChild(calRefresh);
    // Only show calendar controls when an iCal URL or Google Calendar is configured.
    if (icalUrl || useGoogleCalendar) footer.appendChild(calWrap);

    // `text` is plain text (it can carry a service-worker error message): only
    // the optional icon is markup.
    function setCalStatus(text, cls, iconName) {
      calStatus.textContent = '';
      if (iconName) calStatus.insertAdjacentHTML('beforeend', icon(iconName));
      calStatus.appendChild(document.createTextNode(iconName ? ' ' + text : text));
      calStatus.className = 'omnitime-cal-status omnitime-cal-status--' + cls;
      calStatus.title = '';
    }
    // "Synced 10:42" from the last background sync (omnitimeCalSyncedAt).
    function showSynced() {
      const at = state.calSyncedAt ? new Date(state.calSyncedAt) : null;
      setCalStatus(fmtSynced(state.calSyncedAt) + (useGoogleCalendar ? ' (Google)' : ''), 'ok', 'calendar');
      if (at && !isNaN(at)) calStatus.title = 'Last calendar sync: ' + at.toLocaleString();
    }

    layout.appendChild(weekWrap);
    layout.appendChild(nav);
    layout.appendChild(cols);
    layout.appendChild(footer);

    let loaded = false;
    let reqId = 0;

    // --- Calendar event cache ---
    // Cache lives across day switches within a single modal session.
    let calWeekCache = state.calCache;

    function getCalEventsForDate(date) {
      if (!calWeekCache || !calWeekCache.events) return [];
      const Cal = window.OmniTimeCal;
      return Cal ? Cal.filterEventsForDate(calWeekCache.events, date) : [];
    }

    // Fetch calendar events from local cache for immediate display.
    function loadCalendarEvents(date) {
      const Cal = window.OmniTimeCal;
      if (!Cal || (!icalUrl && !useGoogleCalendar)) {
        if (icalUrl || useGoogleCalendar) setCalStatus('Parser unavailable', 'err');
        return Promise.resolve([]);
      }

      const weekStart = Cal.weekMonday(date);

      // Use in-memory cache if valid.
      if (calWeekCache && calWeekCache.weekStart === weekStart) {
        showSynced();
        return Promise.resolve(getCalEventsForDate(date));
      }

      setCalStatus('Loading\u2026', 'busy');

      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(['icalRaw', 'googleCalJson', 'googleUserInfo', 'omnitimeCalSyncedAt'], (result) => {
            // The signed-in email drops events this user declined (iCal only;
            // Google items carry their own `self` attendee flag).
            state.calSelfEmail = (result && result.googleUserInfo && result.googleUserInfo.email) || '';
            state.calSyncedAt = (result && result.omnitimeCalSyncedAt) || null;
            if (result && result.googleCalJson) {
              const events = Cal.parseGoogleCalJsonForWeek(result.googleCalJson, weekStart);
              calWeekCache = { weekStart, events };
              state.calCache = calWeekCache;
              showSynced();
              resolve(getCalEventsForDate(date));
            } else if (result && result.icalRaw) {
              const events = Cal.parseICalForWeek(result.icalRaw, weekStart, { selfEmail: state.calSelfEmail });
              calWeekCache = { weekStart, events };
              state.calCache = calWeekCache;
              showSynced();
              resolve(getCalEventsForDate(date));
            } else {
              resolve([]);
            }
            autoSyncCalendar(!(result && (result.googleCalJson || result.icalRaw)), state.calSyncedAt);
          });
        } else {
          resolve([]);
        }
      });
    }

    function updateFromCalData(googleCalJson, icalRaw) {
      if (!googleCalJson && !icalRaw) return;
      const Cal = window.OmniTimeCal;
      if (!Cal) return;
      const weekStart = Cal.weekMonday(state.date);

      let events;
      if (googleCalJson) {
        events = Cal.parseGoogleCalJsonForWeek(googleCalJson, weekStart);
      } else {
        events = Cal.parseICalForWeek(icalRaw, weekStart, { selfEmail: state.calSelfEmail || '' });
      }
      showSynced();

      calWeekCache = { weekStart, events };
      state.calCache = calWeekCache;

      dayCalEvents = getCalEventsForDate(state.date);
      const grid = layout.querySelector('.omnitime-tl');
      if (grid) {
        grid.dispatchEvent(new CustomEvent('omnitime-cal-update', { detail: dayCalEvents }));
      }
    }

    // One storage listener per modal: replace the one from a previous render
    // (tab/day switches re-render) instead of stacking them; openModal's
    // cleanup removes the last one.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      if (state.calListener) chrome.storage.onChanged.removeListener(state.calListener);
      state.calListener = (changes, area) => {
        if (area !== 'local' || !layout.isConnected) return;
        if (changes.googleUserInfo) state.calSelfEmail = (changes.googleUserInfo.newValue && changes.googleUserInfo.newValue.email) || '';
        if (changes.omnitimeCalSyncedAt) {
          state.calSyncedAt = changes.omnitimeCalSyncedAt.newValue || null;
          if (calWeekCache) showSynced();
        }
        if (changes.googleCalJson && changes.googleCalJson.newValue) {
          updateFromCalData(changes.googleCalJson.newValue, null);
        } else if (changes.icalRaw && changes.icalRaw.newValue) {
          updateFromCalData(null, changes.icalRaw.newValue);
        }
      };
      chrome.storage.onChanged.addListener(state.calListener);
    }

    // Nothing cached yet (e.g. just signed in) or older than the background
    // sync interval: sync now, once per modal. The storage listener above
    // re-renders when the new data arrives.
    function autoSyncCalendar(empty, syncedAt) {
      if (state.calAutoSynced) return;
      const age = syncedAt ? Date.now() - new Date(syncedAt).getTime() : Infinity;
      if (!empty && age < 30 * 60 * 1000) return;
      state.calAutoSynced = true;
      refreshCalendar({ quiet: !empty });
    }

    // Force-refresh: trigger background sync manually.
    // opts.quiet: cached events are shown; keep their status while syncing.
    function refreshCalendar(opts) {
      if (!(opts && opts.quiet)) setCalStatus('Syncing\u2026', 'busy');
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: 'OMNI_FORCE_SYNC_ICAL' }, (res) => {
          if (!res || !res.success) {
            setCalStatus('Sync failed: ' + (res ? res.error : 'Unknown error'), 'err');
          } else if (res.notModified) {
            // The feed is unchanged (no storage event for it); the sync time
            // may still have moved on.
            showSynced();
          }
        });
      }
    }
    calRefresh.addEventListener('click', refreshCalendar);

    // The date the timeline currently shows: a reload of the same day keeps
    // the scroll position instead of jumping back to the start/now.
    let renderedDate = null;
    // The day as last rendered (server data or an optimistic local change of
    // it) and its calendar events: the base for the next local change.
    let shown = null;
    let shownCal = [];
    function applyData(data, calEvents) {
      loaded = true;
      shown = data;
      shownCal = calEvents || [];
      setNavDate(state.date);
      weekWrap.innerHTML = '';
      const strip = buildWeekStrip(data, loadDay, state.absenceFor, { baseTarget: baseTarget(data, context.settings) });
      weekWrap.appendChild(strip);
      loadStripAbsences(strip);
      footerTotal.textContent = data.day_total_label || '0:00';
      dayData = data;
      dayCalEvents = calEvents || [];
      const target = currentTarget(data);
      renderProgress(data, target);
      cols.classList.remove('omnitime-myday__cols--form-open');
      const keepScroll = renderedDate === state.date ? timelineWrap.scrollTop : null;
      renderedDate = state.date;
      timelineWrap.innerHTML = '';
      formWrap.innerHTML = '';
      const viewed = state.date;
      const copyDate = prevWorkingDay(viewed);
      buildTimeline(timelineWrap, formWrap, data, {
        apiClient,
        context,
        state,
        reload: () => loadDay(state.date),
        ops,
        // Quiet reload (no busy state; keeps scroll and focus), e.g. after a create.
        refresh: (opts) => ops.refresh(opts),
        onFormClosed: () => ops.idle(),
        calendarEvents: calEvents || [],
        dashboardMode,
        ui,
        keepScroll,
        // Gaps only show on days with a target.
        dayTarget: target,
        // Empty (past/today) day: "Copy from <previous working day>".
        copyFrom: viewed <= todayStr() ? { date: copyDate, label: shortDate(copyDate), open: (anchor) => openCopyPopover(anchor, copyDate, viewed) } : null,
        // The timeline's placeholders changed (sync, hide): recount the bookable meetings.
        onCalendarChange: refreshBookButton,
      });
      refreshBookButton();
      // "Track time on this issue" asked for the add form once the day is in.
      if (state.pendingAdd) { state.pendingAdd = false; layout.querySelector('.omnitime-add-btn')?.click(); }
    }

    // Absences for the strip: the week is fetched lazily after the day is in,
    // once per week per modal (state.weekStore caches it in memory), and the
    // strip is marked in place when it arrives.
    function loadStripAbsences(strip) {
      const store = state.weekStore;
      if (!store || !store.available() || !state.date) return;
      if (store.peek(state.date)) return; // already marked by buildWeekStrip
      const date = state.date;
      store.get(date).then(() => {
        if (!strip.isConnected) return;
        // An absence on the viewed day lowers its target (progress + gaps).
        // A re-render would close an open entry form (and lose its draft):
        // then only the strip and the progress are updated; the timeline's
        // gaps follow with the next render.
        if (date === state.date && dayData && state.absenceFor(date)) {
          if (cols.classList.contains('omnitime-myday__cols--form-open')) {
            markStripAbsences(strip, state.absenceFor);
            renderProgress(dayData, currentTarget(dayData));
          } else {
            applyData(dayData, dayCalEvents);
          }
        } else {
          markStripAbsences(strip, state.absenceFor);
        }
      }).catch(() => { /* absences are optional */ });
    }

    // Badge sync: report today's total after every successful load of today.
    function reportDayTotal(date, data) {
      if (!state.onDayTotal || date !== todayStr()) return;
      let total = Number(data.day_total_minutes);
      if (!Number.isFinite(total)) total = (data.entries || []).reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
      try { state.onDayTotal(date, total); } catch (e) { /* the badge is best effort */ }
    }

    // --- Daily target ---
    // An absence (state.absenceFor, from the week store) lowers the target.
    function currentTarget(data) {
      const absence = state.absenceFor ? state.absenceFor(state.date) : null;
      return dayTarget(state.date, baseTarget(data, context.settings), absence);
    }
    function dayMinutes(data) {
      const total = Number(data.day_total_minutes);
      return Number.isFinite(total) ? total : (data.entries || []).reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
    }
    function renderProgress(data, target) {
      const p = targetProgress(dayMinutes(data), target);
      progress.hidden = !p;
      if (!p) return;
      progress.className = 'omnitime-progress omnitime-progress--' + p.state;
      progress.querySelector('.omnitime-progress__fill').style.width = p.pct + '%';
      const bar = progress.querySelector('.omnitime-progress__bar');
      bar.setAttribute('aria-valuenow', String(p.pct));
      bar.setAttribute('aria-valuetext', `${p.label} (target ${fmtDur(target)})`);
      progress.querySelector('.omnitime-progress__label').textContent = p.label;
      progress.title = `Daily target ${fmtDur(target)}`;
    }

    // --- Book meetings (the step dialog, see openBookDialog) ---
    function currentMeetings() {
      // Today or a past day only: a future day's meetings aren't over yet.
      if (!dayData || state.date > todayStr()) return [];
      return bookableMeetings(dayCalEvents, dayData.entries || [], state.date, state.calMemory, state.dismissedCalEvents);
    }
    function refreshBookButton() {
      const list = currentMeetings();
      bookBtn.hidden = !list.length;
      if (!list.length) return;
      bookBtn.innerHTML = `${icon('calendar')}<span>Book meetings</span> <span class="omnitime-bookall__count">${list.length}</span>`;
      bookBtn.title = 'Review and book the meetings of this day';
    }
    bookBtn.addEventListener('click', () => {
      const popover = ui && ui.dialog && ui.dialog.querySelector('.omnitime-daypop');
      if (popover) popover._close();
      openBookPopover();
    });

    function openBookPopover() {
      const list = currentMeetings();
      if (!list.length || (ui && ui.dialog && ui.dialog.querySelector('.omnitime-bk'))) return;
      openBookDialog(ui, bookBtn, {
        apiClient,
        state,
        date: state.date,
        meetings: list,
        // Closing after bookings (or an undo): quiet reload, which also reports
        // today's total. The memory is re-read first (new links + history).
        onClose: ({ changed }) => {
          if (!changed) return;
          loadCalMemory().then((mem) => { state.calMemory = mem; return ops.refresh({ force: true }); });
        },
      });
    }

    // Undo for the bulk actions: delete the created entries (and their
    // calendar links), then reload.
    async function undoCreated(ids, calKeys) {
      const failed = await removeAll(apiClient, ids);
      if (calKeys && calKeys.length) await forgetCalBookings(calKeys).catch(() => {});
      if (failed && ui && ui.toast) ui.toast(`Couldn't undo ${failed} of ${ids.length} entries.`);
      loadDay(state.date);
    }

    // --- Copy from the previous working day ---
    function openCopyPopover(anchor, fromDate, toDate) {
      const pop = openChecklistPopover(ui, anchor, {
        title: `Copy from ${shortDate(fromDate)}`,
        rows: [],
        loading: 'Loading…',
        empty: `Nothing tracked on ${shortDate(fromDate)}.`,
        confirmLabel: (n) => (n ? `Copy ${plural(n, 'entry', 'entries')}` : 'Copy'),
        onConfirm: async (picked, p) => {
          const chosen = picked.map((i) => source[i]);
          let n = 0;
          p.busy(`Copying 1 of ${chosen.length}…`);
          // An issue that was closed since is rejected (400): skip it, go on.
          const res = await createSequentially(apiClient, chosen, (e) => {
            p.busy(`Copying ${++n} of ${chosen.length}…`);
            if (e.issue_internal_id == null) return null;
            return { ...entryPayload(toDate, e.start || '', Number(e.duration_minutes) || MIN_DUR, e.comment), issue_internal_id: e.issue_internal_id };
          }, (err) => err && err.status === 400);
          const ids = res.created.map((c) => c.id);
          const copied = plural(res.created.length, 'entry', 'entries');
          if (res.failed) {
            p.error(res.failed.err, `Copied ${res.created.length} of ${chosen.length}. "${entryIssueText(res.failed.item)}" failed, the rest were not copied.`);
          } else if (res.skipped.length) {
            p.result(`<p class="omnitime-daypop__summary">Copied ${esc(copied)}; ${res.skipped.length} skipped:</p>
              <ul class="omnitime-daypop__skipped">${res.skipped.map((s) => `<li><strong>${esc(entryIssueText(s.item))}</strong> &ndash; ${esc(s.err ? sanitizeMessage(s.err.message) || 'rejected' : 'no issue')}</li>`).join('')}</ul>`);
          } else {
            p.close();
          }
          if (res.created.length && ui && ui.toast) {
            ui.toast(`Copied ${copied}`, { actionLabel: 'Undo', onAction: () => undoCreated(ids, null) });
          }
          loadDay(state.date);
        },
      });
      let source = [];
      apiClient.myDay(fromDate).then((d) => {
        if (!pop.el.isConnected) return;
        source = ((d && d.entries) || []).slice().sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
        pop.setRows(source.map((e) => {
          const start = parseClock(e.start);
          const dur = Number(e.duration_minutes) || 0;
          const time = start == null ? '' : `${fmtClock(start)}–${fmtClock(start + dur)}`;
          const comment = stripTags(e.comment);
          return {
            label: [time, entryIssueText(e), comment, fmtDur(dur)].filter(Boolean).join(', '),
            html: `<span class="omnitime-daypop__main">${esc(entryIssueText(e))}</span>
              <span class="omnitime-daypop__meta">${esc(time || 'No start')} &middot; ${fmtDur(dur)}${comment ? ` &middot; ${esc(comment)}` : ''}</span>`,
          };
        }), `Nothing tracked on ${shortDate(fromDate)}.`);
        const first = pop.el.querySelector('input[type="checkbox"]');
        if (first) first.focus({ preventScroll: true });
      }).catch((err) => {
        if (pop.el.isConnected) pop.error(err, `Couldn't load ${shortDate(fromDate)}`);
      });
    }

    // Optimistic entry changes (move/resize/edit/delete/duplicate + Undo):
    // re-render from local data at once, reconcile with a quiet reload.
    const ops = createDayOps({
      apiClient,
      state,
      ui,
      shown: () => shown,
      alive: () => root.contains(layout),
      // A local re-render keeps the scroll position (same day) and the
      // focused timeline item.
      render: (data) => {
        if (!root.contains(layout)) return;
        const active = ui && ui.root ? ui.root.activeElement : null;
        const item = active && active.closest ? active.closest('.omnitime-tl [data-key]') : null;
        if (item && !state.refocus) state.refocus = item.dataset.key;
        if (state.refocus) state.refocus = ops.mapKey(state.refocus);
        applyData(data, shownCal);
        // The focused control went away with the old render (e.g. the form's
        // Delete): keep the focus in the dialog (Escape, shortcuts).
        if (active && !ui.root.activeElement && ui.dialog) ui.dialog.focus({ preventScroll: true });
      },
      reportDayTotal,
      reload: () => loadDay(state.date),
      // Changed while busy: the totals follow, the timeline and form stay.
      stage: (data) => {
        shown = data;
        dayData = data;
        footerTotal.textContent = data.day_total_label || fmtDur(dayMinutes(data));
        renderProgress(data, currentTarget(data));
      },
      // Not now: the form is open or something is being dragged.
      isBusy: () => cols.classList.contains('omnitime-myday__cols--form-open')
        || !!layout.querySelector('.omnitime-tl__entry--lifted, .omnitime-tl__cal-event--lifted'),
    });

    function loadDay(date) {
      state.date = date;
      setNavDate(date);
      const myReq = ++reqId;
      layout.classList.add('omnitime-myday--busy');

      Promise.all([
        apiClient.myDay(date),
        loadCalendarEvents(date).catch((err) => {
          if (window.omniDebugMode) console.warn('OmniTime: Calendar load failed:', err);
          return [];
        }),
        loadCalMemory(),
      ]).then(([data, calEvents, calMemory]) => {
        if (myReq !== reqId || !root.contains(layout)) return;
        layout.classList.remove('omnitime-myday--busy');
        state.calMemory = calMemory;
        // A cached week whose totals no longer match is refetched when shown.
        if (state.weekStore) state.weekStore.reconcile(data);
        applyData(data, calEvents);
        reportDayTotal(date, data);
      }).catch((err) => {
        if (window.omniDebugMode) console.warn('OmniTime: loadDay failed:', err);
        if (myReq !== reqId || !root.contains(layout)) return;
        layout.classList.remove('omnitime-myday--busy');
        if (isUnavailable(err)) {
          root.innerHTML = `
            <div class="omnitime-empty omnitime-unavailable">
              ${icon('calendar')}
              <div>
                <strong>"My day" isn't available on this server yet.</strong>
                <span class="omnitime-empty__sub">It needs the updated OmniTime time-tracking API. The "This issue" tab works with the current API.</span>
              </div>
            </div>`;
        } else {
          const retry = loaded
            ? () => loadDay(state.date)
            : () => renderMyDayTab(root, apiClient, context, state, icalUrl, icalTransport, dashboardMode, useGoogleCalendar, ui);
          renderError(loaded ? timelineWrap : root, err, { title: "Couldn't load your day", retry });
        }
      });
    }

    // Keyboard shortcuts while My day is shown (one handler per modal: a
    // re-render replaces the previous one; it dies with the shadow root).
    if (ui && ui.root) {
      if (state.shortcutsOff) state.shortcutsOff();
      state.shortcutsOff = bindMyDayShortcuts(ui, layout, {
        newEntry: () => { if (state.addNew) state.addNew(true); },
        prev: () => nav.querySelector('[data-nav="prev"]').click(),
        next: () => nav.querySelector('[data-nav="next"]').click(),
        today: () => { if (!navToday.disabled) navToday.click(); },
        help: () => toggleShortcutHelp(ui, keysBtn),
      });
    }

    timelineWrap.innerHTML = `<div class="omnitime-loading">${icon('calendar')} Loading your day&hellip;</div>`;
    root.appendChild(layout);
    // For callers outside the tab (e.g. a booked timer): reload the shown day.
    // refresh is the quiet, busy-aware variant (keeps an open form).
    state.refresh = (o) => ops.refresh(o);
    state.reload = () => loadDay(state.date);
    loadDay(state.date);
  }

  // Absence chip ("Absent" / "Absent ½") for the week strip and the Week tab.
  function absenceChip(absence) {
    const chip = elem('span', 'omnitime-absent' + (absence.half_day ? ' omnitime-absent--half' : ''));
    chip.innerHTML = absence.half_day ? 'Absent <span aria-hidden="true">½</span><span class="ot-visually-hidden">(half day)</span>' : 'Absent';
    return chip;
  }
  // Mark the strip's absent days (dimmed + chip) and (re)draw each day's meter
  // from the totals stored on the cells (data-minutes, data-target); safe to
  // call again once the absences arrive.
  function markStripAbsences(strip, absenceFor) {
    const today = todayStr();
    strip.querySelectorAll('.omnitime-week__day[data-date]').forEach((cell) => {
      const absence = typeof absenceFor === 'function' ? absenceFor(cell.dataset.date) : null;
      cell.classList.toggle('omnitime-week__day--absent', !!absence);
      const old = cell.querySelector('.omnitime-absent');
      if (old) old.remove();
      const oldMeter = cell.querySelector('.omnitime-meter');
      if (oldMeter) oldMeter.remove();
      ['met', 'under'].forEach((st) => cell.classList.remove('omnitime-week__day--' + st));
      const base = cell.dataset.label || cell.getAttribute('aria-label');
      cell.dataset.label = base;
      const meter = dayMeter(cell.dataset.date, Number(cell.dataset.minutes), dayTarget(cell.dataset.date, Number(cell.dataset.target), absence), today);
      let label = meter ? meter.text + (cell.dataset.date === today ? ' (today)' : '') : base;
      if (meter) {
        if (meter.state !== 'today') cell.classList.add('omnitime-week__day--' + meter.state);
        cell.appendChild(meterBar(meter));
      }
      if (absence) {
        cell.appendChild(absenceChip(absence));
        label += `, absent${absence.half_day ? ' (half day)' : ''}`;
      }
      cell.setAttribute('aria-label', label);
    });
  }

  // Week strip: "Mon 19"-style labels with the day total and a thin meter
  // (total / day target: met, under, today in progress; none for future days,
  // weekends and absent days); weekends and future days dimmed, today marked,
  // absences (from absenceFor(date), see createWeekStore) with an "Absent"
  // chip. opts.baseTarget: the daily target before weekends/absences.
  function buildWeekStrip(data, onPick, absenceFor, opts) {
    const base = opts && opts.baseTarget != null ? opts.baseTarget : DEFAULT_TARGET;
    const strip = elem('div', 'omnitime-week');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'Week');
    const today = todayStr();
    (data.week || []).forEach((d) => {
      const day = d.date ? new Date(d.date + 'T00:00:00') : null;
      const valid = day && !isNaN(day);
      const label = valid ? `${day.toLocaleDateString(undefined, { weekday: 'short' })} ${day.getDate()}` : (d.label || '');
      const weekend = valid && (day.getDay() === 0 || day.getDay() === 6);
      const isToday = d.date === today;
      const future = !!d.date && d.date > today;
      const cls = ['omnitime-week__day'];
      if (d.active) cls.push('omnitime-week__day--active');
      if (isToday) cls.push('omnitime-week__day--today');
      if (weekend) cls.push('omnitime-week__day--weekend');
      if (future) cls.push('omnitime-week__day--future');
      const cell = elem('button', cls.join(' '));
      cell.type = 'button';
      if (d.date) cell.dataset.date = d.date;
      const minutes = Number.isFinite(Number(d.total_minutes)) ? Number(d.total_minutes) : 0;
      cell.dataset.minutes = String(minutes);
      cell.dataset.target = String(base);
      cell.innerHTML = `<span class="omnitime-week__label">${esc(label)}</span><span class="omnitime-week__total">${esc(d.total_label)}</span>`;
      const long = valid ? day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : label;
      cell.setAttribute('aria-label', `${long}${isToday ? ' (today)' : ''}: ${d.total_label || '0:00'} tracked`);
      cell.setAttribute('aria-pressed', d.active ? 'true' : 'false');
      if (isToday) cell.setAttribute('aria-current', 'date');
      cell.addEventListener('click', () => onPick(d.date));
      strip.appendChild(cell);
    });
    const total = elem('div', 'omnitime-week__sum');
    total.innerHTML = `<span class="omnitime-week__label">Total</span><span class="omnitime-week__total">${esc(data.week_total_label)}</span>`;
    strip.appendChild(total);
    markStripAbsences(strip, absenceFor);
    return strip;
  }

  // --- "Week" tab (read-only) ---
  // Monday-Sunday columns (rows on narrow widths) with each day's entries as
  // compact cards, day totals vs target (none on weekends, absences
  // credited), the week total, and prev / next / this week. Clicking a day
  // opens it in My day (opts.onPickDay). Data: state.weekStore (one
  // my-tracked-week request per week, cached in memory per modal open).
  // PMs ("view all time trackings", the response says can_view_others) get a
  // person picker at the start of the header and can view a colleague's week:
  // state.weekPerson ({ uid, name }), read-only (no My day link, no editing),
  // with a "Viewing ...'s week" bar; prev / next keep the person. The only
  // thing stored about other people is the recently viewed list ({ uid, name }).
  const fmtDayHead = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return `${SHORT_DAYS[d.getDay()]} ${d.getDate()}`;
  };
  // "19–25 Oct" / "28 Sep–4 Oct"; the year only for a week outside this year.
  const fmtWeekRange = (monday) => {
    const a = new Date(monday + 'T00:00:00');
    const b = new Date(addDays(monday, 6) + 'T00:00:00');
    const thisYear = new Date().getFullYear();
    const spans = a.getFullYear() !== b.getFullYear();
    const left = a.getMonth() === b.getMonth() && !spans ? `${a.getDate()}` : `${a.getDate()} ${SHORT_MONTHS[a.getMonth()]}${spans ? ' ' + a.getFullYear() : ''}`;
    const showYear = spans || b.getFullYear() !== thisYear;
    return `${left}\u2013${b.getDate()} ${SHORT_MONTHS[b.getMonth()]}${showYear ? ' ' + b.getFullYear() : ''}`;
  };

  // --- Week tab: person picker (PMs) ---
  // Recently viewed people (state.recentPeople, newest first): chrome.storage.local
  // `omnitimeRecentPeople` [{ uid, name }], max 10, this device only. Removed on
  // sign-out and when the server says the caller can't view others any more.
  const RECENT_PEOPLE_KEY = 'omnitimeRecentPeople';
  const RECENT_PEOPLE_MAX = 10;
  function localArea() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
  }
  function loadRecentPeople(state) {
    const st = localArea();
    if (!st) return;
    try {
      st.get([RECENT_PEOPLE_KEY], (r) => {
        const saved = Array.isArray(r && r[RECENT_PEOPLE_KEY]) ? r[RECENT_PEOPLE_KEY].map(cleanPerson).filter(Boolean) : [];
        // People viewed before the load finished stay first.
        const list = state.recentPeople || (state.recentPeople = []);
        saved.forEach((p) => { if (!list.some((x) => x.uid === p.uid)) list.push(p); });
        list.length = Math.min(list.length, RECENT_PEOPLE_MAX);
      });
    } catch (e) { /* storage unavailable */ }
  }
  function saveRecentPeople(list) {
    const st = localArea();
    if (!st) return;
    try {
      if (list.length) st.set({ [RECENT_PEOPLE_KEY]: list.map((p) => ({ uid: p.uid, name: p.name })) });
      else st.remove(RECENT_PEOPLE_KEY);
    } catch (e) { /* storage unavailable */ }
  }
  function rememberPerson(state, person) {
    const p = cleanPerson(person);
    if (!p) return;
    const list = state.recentPeople || (state.recentPeople = []);
    const at = list.findIndex((x) => x.uid === p.uid);
    if (at >= 0) list.splice(at, 1);
    list.unshift(p);
    list.length = Math.min(list.length, RECENT_PEOPLE_MAX);
    saveRecentPeople(list);
  }

  // A button ("You" / the person's name + chevron) that opens an inline
  // combobox: "You" first, the people viewed in this modal, then colleagues from
  // apiClient.people for >= 2 typed characters (150 ms debounce, only the newest
  // answer counts). Same markup and keys as the issue search; Escape closes the
  // list first (ui.pushEscape), then the dialog. deps: { apiClient, state, ui,
  // onPick(person | null) }. Returns { sync, focus, close, destroy }.
  let pickerSeq = 0;
  function mountPersonPicker(host, deps) {
    const { apiClient, state, ui } = deps;
    const uid = 'omnitime-who' + (++pickerSeq);
    host.innerHTML = `
      <button type="button" class="omnitime-wk__whobtn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${uid}-pop">
        <span class="omnitime-wk__whoicon">${icon('user')}</span>
        <span class="omnitime-wk__whoname"></span>
        <span class="omnitime-wk__whochev">${icon('chevronDown')}</span>
      </button>
      <div class="omnitime-wk__whopop" id="${uid}-pop" hidden>
        <div class="omnitime-search omnitime-wk__whosearch">
          <span class="omnitime-search__icon">${icon('search')}</span>
          <input type="text" class="omnitime-search__input omnitime-wk__whoinput" placeholder="Find a colleague&hellip;" aria-label="Find a colleague" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-list">
        </div>
        <div class="omnitime-wk__wholist" id="${uid}-list" role="listbox" aria-label="People"></div>
      </div>`;
    const btn = host.querySelector('.omnitime-wk__whobtn');
    const nameEl = host.querySelector('.omnitime-wk__whoname');
    const pop = host.querySelector('.omnitime-wk__whopop');
    const input = host.querySelector('.omnitime-wk__whoinput');
    const list = host.querySelector('.omnitime-wk__wholist');
    const canSearch = typeof apiClient.people === 'function';
    let isOpen = false;
    let options = [];     // [{ key, person | null, label }] in list order
    let activeIdx = -1;
    let seq = 0;
    let timer = null;
    let popEscape = null;
    // API state for the typed text: null (nothing asked), 'loading', 'error',
    // 'forbidden' or the people array.
    let results = null;

    const current = () => state.weekPerson || null;
    const sync = () => {
      const person = current();
      nameEl.textContent = person ? (person.name || 'Colleague') : 'You';
      nameEl.title = person && person.name ? person.name : '';
      btn.setAttribute('aria-label', `Whose week: ${person ? (person.name || 'a colleague') : 'You'}`);
      btn.classList.toggle('omnitime-wk__whobtn--other', !!person);
    };

    const setActive = (idx) => {
      activeIdx = idx;
      const items = [...list.querySelectorAll('[role="option"][data-idx]')];
      items.forEach((el, i) => {
        el.classList.toggle('omnitime-search__item--active', i === idx);
        el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      });
      if (items[idx]) {
        input.setAttribute('aria-activedescendant', items[idx].id);
        items[idx].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    };

    // The list for the typed text: You, matching recent people, API results.
    const render = () => {
      const q = input.value.trim();
      const needle = q.toLowerCase();
      const me = current();
      const keep = activeIdx >= 0 && options[activeIdx] ? options[activeIdx].key : null;
      const recent = (state.recentPeople || []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
      const seen = new Set(recent.map((p) => p.uid));
      const found = Array.isArray(results) ? results.map(cleanPerson).filter((p) => p && !seen.has(p.uid)) : [];
      options = [{ key: 'me', person: null, label: 'You', current: !me }]
        .concat(recent.map((p) => ({ key: p.uid, person: p, label: p.name, current: !!me && me.uid === p.uid })))
        .concat(found.map((p) => ({ key: p.uid, person: p, label: p.name, current: !!me && me.uid === p.uid })));
      let idx = 0;
      const optHtml = (o) => {
        const i = idx++;
        return `<button class="omnitime-search__item omnitime-wk__whoopt${o.current ? ' omnitime-wk__whoopt--current' : ''}" type="button" role="option" tabindex="-1" id="${uid}-opt-${i}" aria-selected="false" data-idx="${i}">
          <span class="omnitime-search__label">${esc(o.label)}</span>${o.current ? `<span class="omnitime-wk__whocheck">${icon('check')}<span class="ot-visually-hidden"> (viewing)</span></span>` : ''}
        </button>`;
      };
      const group = (title, items, gid) => items.length
        ? `<div role="group" aria-labelledby="${uid}-grp-${gid}"><div class="omnitime-search__group" id="${uid}-grp-${gid}">${title}</div>${items.map(optHtml).join('')}</div>`
        : '';
      let html = optHtml(options[0]);
      html += group('Recently viewed', options.filter((o) => o.person && recent.some((p) => p.uid === o.key)), 'recent');
      html += group('Colleagues', options.slice(1).filter((o) => found.some((p) => p.uid === o.key)), 'found');
      const note = (text) => `<div class="omnitime-search__empty" role="option" aria-disabled="true" aria-selected="false">${esc(text)}</div>`;
      if (canSearch) {
        if (q.length < 2) html += note(q ? 'Type one more letter' : 'Type 2+ letters to search');
        else if (results === 'loading') html += note('Searching…');
        else if (results === 'error') html += note('Search unavailable');
        else if (results === 'forbidden') html += note("You can't view other people's weeks");
        else if (!found.length && !recent.length) html += note('No matches');
      }
      list.innerHTML = html;
      list.querySelectorAll('.omnitime-wk__whoopt').forEach((b) => {
        b.addEventListener('click', () => pick(options[parseInt(b.dataset.idx, 10)]));
      });
      const at = keep == null ? -1 : options.findIndex((o) => o.key === keep);
      setActive(at);
    };

    function pick(o) {
      if (!o) return;
      close(true);
      const me = current();
      if ((o.person ? o.person.uid : null) === (me ? me.uid : null)) return; // already showing
      deps.onPick(o.person ? { uid: o.person.uid, name: o.person.name } : null);
    }

    const search = () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const mine = ++seq;
      if (!canSearch || q.length < 2) { results = null; render(); return; }
      results = 'loading';
      render();
      timer = setTimeout(() => {
        Promise.resolve(apiClient.people(q)).then((res) => {
          if (mine !== seq || !isOpen) return;
          results = Array.isArray(res && res.people) ? res.people : [];
          render();
        }, (err) => {
          if (mine !== seq || !isOpen) return;
          results = err && err.status === 403 ? 'forbidden' : 'error';
          render();
        });
      }, 150);
    };

    function open() {
      if (isOpen) return;
      isOpen = true;
      input.value = '';
      results = null;
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-expanded', 'true');
      render();
      popEscape = ui && ui.pushEscape ? ui.pushEscape(() => { close(true); return true; }, pop) : null;
      input.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (!isOpen) return;
      isOpen = false;
      clearTimeout(timer);
      seq++;
      if (popEscape) { popEscape(); popEscape = null; }
      pop.hidden = true;
      list.innerHTML = '';
      options = [];
      setActive(-1);
      btn.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', () => { if (isOpen) close(true); else open(); });
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' && !isOpen) { ev.preventDefault(); open(); }
    });
    input.addEventListener('input', search);
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    input.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      const n = options.length;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!n) return;
        setActive(ev.key === 'ArrowDown' ? (activeIdx + 1) % n : (activeIdx <= 0 ? n - 1 : activeIdx - 1));
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (activeIdx >= 0) pick(options[activeIdx]);
      }
    });
    // Focus left the picker (Tab, a click elsewhere): close without stealing it.
    host.addEventListener('focusout', () => {
      setTimeout(() => {
        const rootNode = host.getRootNode();
        if (isOpen && !host.contains(rootNode && rootNode.activeElement)) close(false);
      }, 0);
    });

    sync();
    return {
      sync,
      focus: () => btn.focus({ preventScroll: true }),
      close,
      destroy: () => { clearTimeout(timer); seq++; if (popEscape) popEscape(); },
    };
  }

  function renderWeekTab(root, state, opts) {
    opts = opts || {};
    const store = state.weekStore;
    // Opens on the week of the day My day shows; a clicked name (pendingPerson,
    // one-shot) opens that person's current week.
    state.weekDate = state.date || todayStr();
    if (state.pendingPerson) {
      state.weekPerson = state.pendingPerson;
      state.pendingPerson = null;
      state.weekDate = todayStr();
    }
    root.innerHTML = '';
    const layout = elem('div', 'omnitime-wk');
    const nav = elem('div', 'omnitime-wk__nav');
    nav.innerHTML = `
      <div class="omnitime-wk__who" hidden></div>
      <div class="omnitime-daynav__group" role="group" aria-label="Change week">
        <button class="omnitime-daynav__btn omnitime-daynav__today" type="button" data-nav="this" aria-label="Go to this week">This week</button>
        <button class="omnitime-daynav__btn" type="button" data-nav="prev" aria-label="Previous week">${icon('chevronLeft')}</button>
        <button class="omnitime-daynav__btn" type="button" data-nav="next" aria-label="Next week">${icon('chevronRight')}</button>
      </div>
      <span class="omnitime-daynav__label omnitime-wk__range" aria-live="polite"></span>
      <span class="omnitime-wk__sum"></span>
      <button class="omnitime-daynav__btn omnitime-wk__weekend" type="button" aria-pressed="false" hidden>Show weekend</button>`;
    const rangeEl = nav.querySelector('.omnitime-wk__range');
    // Saturday/Sunday show when they have entries; empty ones only on request
    // (remembered in this browser, a per-viewer convenience).
    const weekendBtn = nav.querySelector('.omnitime-wk__weekend');
    let showWeekend = false;
    let shownWeek = null;
    let shownOthers = false;
    if (hasLocalStorage()) {
      chrome.storage.local.get(['omnitimeWeekShowWeekend'], (r) => {
        showWeekend = !!(r && r.omnitimeWeekShowWeekend);
        if (shownWeek && layout.isConnected) renderWeek(shownWeek, shownOthers);
      });
    }
    weekendBtn.addEventListener('click', () => {
      showWeekend = !showWeekend;
      if (hasLocalStorage()) chrome.storage.local.set({ omnitimeWeekShowWeekend: showWeekend });
      if (shownWeek) renderWeek(shownWeek, shownOthers);
      weekendBtn.focus();
    });
    const thisBtn = nav.querySelector('[data-nav="this"]');
    const sumEl = nav.querySelector('.omnitime-wk__sum');
    const body = elem('div', 'omnitime-wk__body');
    // "Viewing Dana Example's week · ×" while another person's week is shown.
    const viewing = elem('div', 'omnitime-wk__viewing');
    viewing.hidden = true;
    viewing.setAttribute('role', 'status');
    layout.appendChild(nav);
    layout.appendChild(viewing);
    layout.appendChild(body);
    root.appendChild(layout);

    const whoEl = nav.querySelector('.omnitime-wk__who');
    let picker = null;
    // The picker (and the bar) follow state.weekPerson; the picker exists once
    // a response says the caller may view colleagues.
    const syncPerson = () => {
      const person = state.weekPerson;
      layout.classList.toggle('omnitime-wk--others', !!person);
      viewing.hidden = !person;
      viewing.textContent = '';
      if (person) {
        const text = elem('span', 'omnitime-wk__viewing-text');
        text.innerHTML = person.name ? `Viewing <strong>${esc(person.name)}</strong>'s week` : 'Viewing a colleague\'s week';
        const x = elem('button', 'omnitime-wk__viewing-x', icon('close'));
        x.type = 'button';
        x.setAttribute('aria-label', 'Back to your week');
        x.title = 'Back to your week';
        x.addEventListener('click', () => { setPerson(null); if (picker) picker.focus(); });
        viewing.append(text, x);
      }
      if (picker) picker.sync();
    };
    const setPerson = (person) => {
      state.weekPerson = person;
      syncPerson();
      show(state.weekDate);
    };
    const offerPicker = () => {
      if (picker || !state.canViewOthers) return;
      whoEl.hidden = false;
      picker = mountPersonPicker(whoEl, {
        apiClient: opts.apiClient,
        state,
        ui: opts.ui,
        onPick: setPerson,
      });
    };
    if (state.canViewOthers) offerPicker();
    syncPerson();

    let reqId = 0;
    const show = (date) => {
      state.weekDate = date;
      const monday = weekMonday(date);
      rangeEl.innerHTML = `${esc(fmtWeekRange(monday))} <span class="omnitime-daynav__week">&middot; Week ${isoWeek(monday)}</span>`;
      thisBtn.disabled = monday === weekMonday(todayStr());
      const myReq = ++reqId;
      const person = state.weekPerson;
      const uid = person ? person.uid : null;
      const cached = store.peek(date, uid);
      if (cached) renderWeek(cached, !!person); else body.innerHTML = `<div class="omnitime-loading">${icon('week')} ${person ? (person.name ? `Loading ${esc(person.name)}'s week` : 'Loading the week') : 'Loading your week'}&hellip;</div>`;
      layout.classList.add('omnitime-wk--busy');
      store.get(date, { uid }).then((week) => {
        if (myReq !== reqId || !layout.isConnected) return;
        layout.classList.remove('omnitime-wk--busy');
        state.canViewOthers = week.canViewOthers;
        if (week.canViewOthers === false && state.recentPeople && state.recentPeople.length) {
          state.recentPeople.length = 0;
          saveRecentPeople(state.recentPeople);
        }
        offerPicker();
        if (person && week.user) {
          // The server's spelling of the name; remembered for the picker.
          if (week.user.name && week.user.name !== person.name) { person.name = week.user.name; syncPerson(); }
          rememberPerson(state, person);
        }
        renderWeek(week, !!person);
      }).catch((err) => {
        if (myReq !== reqId || !layout.isConnected) return;
        layout.classList.remove('omnitime-wk--busy');
        sumEl.textContent = '';
        shownWeek = null;
        if (person && (err.status === 403 || err.status === 404)) {
          const msg = err.status === 403 ? "You don't have permission to view other people's weeks." : "That person wasn't found.";
          body.innerHTML = `
            <div class="omnitime-empty omnitime-unavailable">
              ${icon('user')}
              <div>
                <strong>${msg}</strong>
                <span class="omnitime-empty__sub"><button type="button" class="omnitime-wk__back">Back to your week</button></span>
              </div>
            </div>`;
          body.querySelector('.omnitime-wk__back').addEventListener('click', () => { setPerson(null); if (picker) picker.focus(); });
        } else if (isUnavailable(err)) {
          body.innerHTML = `
            <div class="omnitime-empty omnitime-unavailable">
              ${icon('week')}
              <div>
                <strong>The week view isn't available on this server yet.</strong>
                <span class="omnitime-empty__sub">It needs the updated OmniTime time-tracking API.</span>
              </div>
            </div>`;
        } else {
          renderError(body, err, { title: person ? "Couldn't load this week" : "Couldn't load your week", retry: () => show(state.weekDate) });
        }
      });
    };
    nav.querySelector('[data-nav="prev"]').addEventListener('click', () => show(addDays(weekMonday(state.weekDate), -7)));
    nav.querySelector('[data-nav="next"]').addEventListener('click', () => show(addDays(weekMonday(state.weekDate), 7)));
    thisBtn.addEventListener('click', () => {
      show(todayStr());
      nav.querySelector('[data-nav="next"]').focus();
    });

    // others: a colleague's week - read-only (no My day link, no lock glyphs).
    function renderWeek(week, others) {
      shownWeek = week;
      shownOthers = !!others;
      const today = todayStr();
      const weekendHasTime = week.days.some((d) => d.weekend && d.entries.length);
      weekendBtn.hidden = weekendHasTime;
      weekendBtn.textContent = showWeekend ? 'Hide weekend' : 'Show weekend';
      weekendBtn.setAttribute('aria-pressed', String(showWeekend));
      const withWeekend = weekendHasTime || showWeekend;
      // "Daily target 0:00 (off)": no targets, no met/under state, no meters.
      const off = !!opts.targetOff;
      sumEl.innerHTML = `Total <strong>${fmtDur(week.total)}</strong>${week.targetTotal && !off ? ` <span class="omnitime-wk__of">/ ${fmtDur(week.targetTotal)}</span>` : ''}`;
      const grid = elem('div', 'omnitime-wk__grid');
      grid.setAttribute('role', 'list');
      week.days.forEach((day) => {
        if (day.weekend && !withWeekend) return;
        const target = off ? 0 : day.target;
        const meter = dayMeter(day.date, day.total, target, today);
        const cls = ['omnitime-wk__day'];
        if (day.weekend) cls.push('omnitime-wk__day--weekend');
        // Saturday/Sunday without entries shrink to a label + total.
        if (day.weekend && !day.entries.length) cls.push('omnitime-wk__day--collapsed');
        if (day.date === today) cls.push('omnitime-wk__day--today');
        if (day.date > today) cls.push('omnitime-wk__day--future');
        if (day.absence) cls.push('omnitime-wk__day--absent');
        if (meter && meter.state !== 'today') cls.push('omnitime-wk__day--' + meter.state);
        const col = elem('section', cls.join(' '));
        col.setAttribute('role', 'listitem');
        col.dataset.date = day.date;

        const head = elem(others ? 'div' : 'button', 'omnitime-wk__head' + (others ? ' omnitime-wk__head--static' : ''));
        if (others) head.setAttribute('role', 'group'); else head.type = 'button';
        const long = new Date(day.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
        const absentText = day.absence ? (day.absence.half_day ? ', absent half day' : ', absent') : '';
        const state = meter ? `${meter.text}${day.date === today ? ' (today)' : ''}` : `${long}${day.date === today ? ' (today)' : ''}: ${fmtDur(day.total)} tracked${target ? ' of ' + fmtDur(target) : ''}`;
        head.setAttribute('aria-label', others ? `${state}${absentText}` : `${state}${absentText}. Open in My day`);
        if (day.date === today) head.setAttribute('aria-current', 'date');
        head.innerHTML = `
          <span class="omnitime-wk__name">${esc(fmtDayHead(day.date))}</span>
          <span class="omnitime-wk__total">${fmtDur(day.total)}${target ? `<span class="omnitime-wk__of"> / ${fmtDur(target)}</span>` : ''}</span>`;
        // The meter and the flag row are always reserved, so every head has the
        // same height whether or not it has a bar or an "Absent" chip.
        const bar = elem('span', 'omnitime-wk__meter');
        if (meter) bar.appendChild(meterBar(meter));
        head.appendChild(bar);
        const flags = elem('span', 'omnitime-wk__flags');
        if (day.absence) flags.appendChild(absenceChip(day.absence));
        head.appendChild(flags);
        if (!others) head.addEventListener('click', () => { if (opts.onPickDay) opts.onPickDay(day.date); });
        col.appendChild(head);

        const list = elem('ul', 'omnitime-wk__entries');
        list.setAttribute('aria-label', `Entries ${fmtDayHead(day.date)}`);
        let latestStop = null;
        day.entries.forEach((e) => {
          const { label, id } = entryIssueParts(e);
          const comment = stripTags(e.comment);
          const start = parseClock(e.start);
          const stop = parseClock(e.stop);
          const dur = Number(e.duration_minutes) || 0;
          const time = start != null ? `${fmtClock(start)}${stop != null ? '\u2013' + fmtClock(stop) : ''}` : '';
          // A pause the web app reports as a break sits between the cards.
          if (e.break_label && latestStop != null && start != null && start > latestStop) {
            list.appendChild(elem('li', 'omnitime-wk__break', `<span class="omnitime-wk__breaktext">Break ${esc(String(e.break_label))}</span>`));
          }
          if (stop != null) latestStop = latestStop == null ? stop : Math.max(latestStop, stop);
          const booked = !others && (e.editable === false || (e.editable === undefined && e.status === 'booked'));
          const card = elem('li', `omnitime-wk__entry omnitime-wk__entry--p${projectColorIndex(e.project)}${booked ? ' omnitime-wk__entry--booked' : ''}`);
          card.title = [e.project, entryIssueText(e), comment, booked ? 'Booked (read-only)' : ''].filter(Boolean).join('\n');
          const durText = e.duration_label ? esc(e.duration_label) : fmtDur(dur);
          // time range + project (right, muted) -> issue title + #id -> comment -> duration
          card.innerHTML = `
            <span class="omnitime-wk__meta"><span class="omnitime-wk__time">${esc(time)}</span>${e.project ? `<span class="omnitime-wk__project">${esc(e.project)}</span>` : ''}</span>
            <span class="omnitime-wk__issue">${esc(label || (!id ? e.project || '' : ''))}${idHtml(id)}</span>
            ${comment ? `<span class="omnitime-wk__comment">${commentGlyph()}<span class="omnitime-wk__commenttext">${esc(comment)}</span></span>` : ''}
            <span class="omnitime-wk__dur">${booked ? icon('lock') : ''}${durText}</span>`;
          list.appendChild(card);
        });
        if (!day.entries.length) list.hidden = true;
        col.appendChild(list);
        grid.appendChild(col);
      });
      body.innerHTML = '';
      body.appendChild(grid);
    }

    show(state.weekDate);
  }

  // Build the vertical timeline with read-only entries + drag-to-create.
  function buildTimeline(wrap, formWrap, data, ctx) {
    const dayStartSettings = (ctx.context && ctx.context.settings && ctx.context.settings.dayStart !== undefined) ? ctx.context.settings.dayStart : 8;
    const dayEndSettings = (ctx.context && ctx.context.settings && ctx.context.settings.dayEnd !== undefined) ? ctx.context.settings.dayEnd : 17;

    const minEntryH = 26;

    let lastStop = 9 * 60;
    const entries = (data.entries || []).map((e) => {
      let start = parseClock(e.start);
      const stopClock = parseClock(e.stop);
      let dur = e.duration_minutes || (stopClock != null && start != null ? stopClock - start : 15);
      if (dur <= 0) dur = 15;
      if (start == null) {
        start = lastStop;
      }
      const stop = start + dur;
      lastStop = Math.max(lastStop, stop);
      return { start, stop, dur, raw: e };
    }).sort((a, b) => a.start - b.start);

    // Merge calendar events into the timeline layout so they influence the
    // visible window, but don't occupy segments (they render as overlays).
    // An event booked from the calendar stays hidden while its booking exists
    // (see calendar memory), even when the booking was moved to another time.
    const calLinks = (ctx.state && ctx.state.calMemory && ctx.state.calMemory.links) || {};
    const toCalEvent = (ce) => {
      const ev = {
        start: ce.startMinutes,
        stop: ce.endMinutes,
        originalStart: ce.startMinutes,
        originalStop: ce.endMinutes,
        dur: ce.durationMinutes,
        title: ce.title,
        description: ce.description || '',
        location: ce.location || '',
        uid: ce.uid || '',
        isCal: true,
      };
      ev.key = calOccurrenceKey(ev, ctx.state ? ctx.state.date : '');
      ev.id = ev.key;
      const link = calLinks[ev.key];
      ev.booked = link ? entries.find((e) => e.raw.id === link.entryId) || null : null;
      return ev;
    };
    const calEvents = (ctx.calendarEvents || []).map(toCalEvent);

    const focusStart = dayStartSettings * 60;
    const focusEnd = dayEndSettings * 60;
    
    let winStart = 0;
    let winEnd = 24 * 60;

    // Dynamically calculate pxPerMin based on the available height
    // We strictly fit exactly 9 hours (9 * 60 minutes) into the viewport baseline height.
    const containerHeight = ctx.dashboardMode ? 750 : 600;
    const maxFittingMinutes = 9 * 60;
    const pxPerMin = Math.max(1.1, containerHeight / maxFittingMinutes);

    // Elastic (piecewise) axis for tracked entries
    const segments = [];
    let cursor = winStart;
    let yAcc = 0;
    entries.forEach((e, i) => {
      const startClamped = Math.max(e.start, cursor);
      if (startClamped > cursor) {
        const gh = (startClamped - cursor) * pxPerMin;
        segments.push({ startMin: cursor, endMin: startClamped, yTop: yAcc, yBottom: yAcc + gh });
        yAcc += gh;
      }
      const effStop = i + 1 < entries.length ? Math.min(e.stop, entries[i + 1].start) : e.stop;
      const segEnd = Math.max(effStop, startClamped);
      const h = Math.max((segEnd - startClamped) * pxPerMin, minEntryH);
      e._top = yAcc;
      e._height = h;
      segments.push({ startMin: startClamped, endMin: segEnd, yTop: yAcc, yBottom: yAcc + h });
      yAcc += h;
      cursor = Math.max(cursor, segEnd);
    });
    if (cursor < winEnd) {
      const gh = (winEnd - cursor) * pxPerMin;
      segments.push({ startMin: cursor, endMin: winEnd, yTop: yAcc, yBottom: yAcc + gh });
      yAcc += gh;
    }
    const height = yAcc;
    const interp = (v, a0, a1, b0, b1) => (a1 === a0 ? b0 : b0 + ((v - a0) / (a1 - a0)) * (b1 - b0));
    // One height rule for everything drawn over the axis (calendar blocks and
    // the new-entry selection), so the selection covers exactly the block it
    // stands for: the time scale, but never under `floor` px. (Tracked entries
    // reserve their minimum in the axis itself, see minEntryH.)
    const MIN_CAL_H = 14;
    const MIN_SEL_H = 4;
    const minToY = (t) => {
      if (t <= winStart) return 0;
      if (t >= winEnd) return height;
      for (const s of segments) if (t >= s.startMin && t <= s.endMin) return interp(t, s.startMin, s.endMin, s.yTop, s.yBottom);
      return height;
    };
    const yToMin = (py) => {
      if (py <= 0) return winStart;
      if (py >= height) return winEnd;
      for (const s of segments) if (py >= s.yTop && py <= s.yBottom) return interp(py, s.yTop, s.yBottom, s.startMin, s.endMin);
      return winEnd;
    };
    const boxHeight = (start, stop, floor) => Math.max(minToY(stop) - minToY(start), floor);

    const grid = elem('div', 'omnitime-tl');
    grid.style.height = height + 'px';

    const isToday = !!ctx.state && ctx.state.date === todayStr();
    const nowMinute = () => {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    };

    // Working hours (settings dayStart-dayEnd): a subtle band behind the grid.
    if (focusEnd > focusStart) {
      const work = elem('div', 'omnitime-tl__work');
      work.setAttribute('aria-hidden', 'true');
      work.style.top = minToY(focusStart) + 'px';
      work.style.height = (minToY(focusEnd) - minToY(focusStart)) + 'px';
      grid.appendChild(work);
    }

    for (let m = winStart; m <= winEnd; m += 60) {
      const line = elem('div', 'omnitime-tl__hour');
      line.style.top = minToY(m) + 'px';
      line.innerHTML = `<span class="omnitime-tl__hourlabel">${pad2(m / 60)}:00</span>`;
      grid.appendChild(line);
    }

    const timeRange = (a, b) => `${fmtClock(a)}–${fmtClock(b)}`;
    // Keyboard actions that reload the day re-focus the same item afterwards
    // (see the end of buildTimeline); items carry a stable data-key.
    const refocusAfterReload = (key) => { if (ctx.state) ctx.state.refocus = key; };

    // Entries are focusable in time order (DOM order = start order; calendar
    // placeholders are inserted between them, see renderCalendarEvents).
    // Keyboard: Enter/Space edits; Alt+Up/Down moves by 5 min, Alt+Shift+Up/Down
    // moves the end (resize) by 5 min, saved after a short pause.
    entries.forEach((e) => {
      const raw = e.raw;
      const editable = !!raw.editable;
      // compact (< 58px): one row "09:00-09:15 Title #id 0:15"; short (< 75px):
      // meta, title and comment on one line each; tall (>= 100px): the title
      // and the comment take two lines.
      const compact = e._height < 58;
      const short = !compact && e._height < 75;
      const tall = e._height >= 100;
      // Under 15 minutes the block is drawn taller than its time (min
      // height): a lighter style keeps it from reading as a longer entry.
      const tiny = e.dur < 15;
      const comment = stripTags(raw.comment);
      const issue = entryIssueText(raw);
      const parts = entryIssueParts(raw);
      // The title is the issue; the comment only stands in when there is none.
      const titleText = parts.label || (parts.id ? '' : raw.project || comment || '');
      const ctxLine = [raw.project, tall ? raw.milestone : ''].filter(Boolean).join(' \u00b7 ');
      const cls = ['omnitime-tl__entry', 'omnitime-tl__entry--p' + projectColorIndex(raw.project)];
      if (editable) cls.push('omnitime-tl__entry--editable'); else cls.push('omnitime-tl__entry--booked');
      if (compact) cls.push('omnitime-tl__entry--compact');
      if (short) cls.push('omnitime-tl__entry--short');
      if (tall) cls.push('omnitime-tl__entry--tall');
      if (tiny) cls.push('omnitime-tl__entry--tiny');
      const block = elem('div', cls.join(' '));
      block.style.top = e._top + 'px';
      block.style.height = e._height + 'px';
      block.dataset.start = e.start;
      block.dataset.key = 'entry:' + raw.id;
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      if (!editable) block.setAttribute('aria-disabled', 'true');
      // Legacy "half-open" entries (old Drupal forms) have no duration yet.
      const incomplete = !!raw.active;
      const ariaLabel = (start, stop) => [incomplete ? timeRange(start, stop) + ' (incomplete: no duration yet)' : timeRange(start, stop), (raw.project ? raw.project + ' / ' : '') + issue, comment]
        .filter(Boolean).join(', ') + (editable ? '' : ' (booked, read-only)');
      block.setAttribute('aria-label', ariaLabel(e.start, e.stop));
      if (editable) block.setAttribute('aria-keyshortcuts', 'Enter Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown Control+D Meta+D');
      block.title = [(raw.project ? raw.project + ' / ' : '') + issue, comment,
        editable ? 'Click or Enter to edit, drag to move, Alt-drag to copy, drag an edge to resize (Alt+↑/↓ moves, Alt+Shift+↑/↓ resizes, Ctrl+D duplicates)' : 'Booked (read-only)']
        .filter(Boolean).join('\n');
      // A change of this entry is still on its way to the server.
      if (ctx.ops && ctx.ops.isPending(raw.id)) {
        block.classList.add('omnitime-tl__entry--pending');
        block.setAttribute('aria-busy', 'true');
      }

      const link = safeHttpUrl(raw.issue_link);
      const linkHtml = link
        ? `<a class="omnitime-tl__link" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open issue in a new tab" aria-label="Open issue ${esc(issue)} in a new tab">${icon('external')}</a>`
        : '';
      // Duration, right-aligned; booked (read-only) entries carry a lock glyph
      // before it, editable ones no glyph.
      const durHtml = `<span class="omnitime-tl__dur">${editable ? '' : icon('lock')}${incomplete ? 'incomplete' : esc(raw.duration_label || fmtDur(e.dur))}</span>`;
      const timeHtml = `<span class="omnitime-tl__time">${timeRange(e.start, e.stop)}</span>`;
      const titleHtml = `<span class="omnitime-tl__entrytitle">${esc(titleText)}${idHtml(parts.id)}</span>`;
      const commentHtml = comment ? `<span class="omnitime-tl__entrycomment">${commentGlyph()}<span class="omnitime-tl__commenttext">${esc(comment)}</span></span>` : '';

      if (compact) {
        // One row "09:00-09:15  Project / Issue title #id  0:15": the project
        // (muted) always stays, the issue title is cut with an ellipsis.
        const showProj = !!raw.project && titleText !== raw.project;
        const whoHtml = showProj
          ? `<span class="omnitime-tl__entrywho"><span class="omnitime-tl__entryproj">${esc(raw.project)}</span><span class="omnitime-tl__entrysep" aria-hidden="true">/</span>${titleHtml}</span>`
          : titleHtml;
        block.innerHTML = `
          <span class="omnitime-tl__entrymeta">${timeHtml}</span>
          ${whoHtml}
          ${commentHtml}
          <span class="omnitime-tl__spacer"></span>
          ${durHtml}${linkHtml}`;
      } else {
        // meta (time, project, duration) -> title (issue, #id) -> comment
        block.innerHTML = `
          <div class="omnitime-tl__entry-top">
            <span class="omnitime-tl__entrymeta">${timeHtml}${ctxLine ? `<span class="omnitime-tl__entryctx">${esc(ctxLine)}</span>` : ''}</span>
            <span class="omnitime-tl__badges">${durHtml}${linkHtml}</span>
          </div>
          ${titleHtml}
          ${commentHtml}`;
      }

      // The issue link opens in a new tab; it must not start a drag or edit.
      const linkEl = block.querySelector('.omnitime-tl__link');
      if (linkEl) {
        linkEl.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        linkEl.addEventListener('click', (ev) => ev.stopPropagation());
      }

      if (editable) {
        const setMeta = (start, stop) => {
          const time = block.querySelector('.omnitime-tl__time');
          if (time) time.textContent = timeRange(start, stop);
          block.setAttribute('aria-label', ariaLabel(start, stop));
        };
        // Optimistic: the timeline shows the change at once ("Moved to 10:30
        // · Undo"); see createDayOps.
        const save = (start, dur) => {
          const what = dur === e.dur ? `Moved to ${fmtClock(start)}` : `Resized to ${timeRange(start, start + dur)}`;
          ctx.ops.update(raw, { start_time: fmtClock(start), duration: dur }, { toast: what, what: dur === e.dur ? 'move the entry' : 'resize the entry' });
        };
        // Free room between the neighbouring entries.
        const room = () => {
          let lo = winStart;
          let hi = winEnd;
          entries.forEach((o) => {
            if (o === e) return;
            if (o.stop <= e.start && o.stop > lo) lo = o.stop;
            if (o.start >= e.stop && o.start < hi) hi = o.start;
          });
          return { lo, hi };
        };

        // Resize from either edge (handles show on hover), within the free
        // room left by the neighbouring entries; saved like a move.
        block.insertAdjacentHTML('beforeend', `
          <div class="omnitime-tl__handle omnitime-tl__handle--top" data-h="top" title="Drag to change the start"></div>
          <div class="omnitime-tl__handle omnitime-tl__handle--bottom" data-h="bottom" title="Drag to change the end"></div>`);
        block.querySelectorAll('[data-h]').forEach((handle) => {
          handle.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const top = handle.dataset.h === 'top';
            const rect = grid.getBoundingClientRect();
            const { lo, hi } = room();
            let start = e.start;
            let stop = e.stop;
            block.classList.add('omnitime-tl__entry--resizing', 'omnitime-tl__entry--lifted');
            handle.setPointerCapture(ev.pointerId);
            const onMove = (mv) => {
              const minute = snap(yToMin(mv.clientY - rect.top));
              if (top) start = clamp(minute, Math.max(lo, stop - MAX_DUR), stop - MIN_DUR);
              else stop = clamp(minute, start + MIN_DUR, Math.min(hi, start + MAX_DUR));
              block.style.top = minToY(start) + 'px';
              block.style.height = Math.max(minToY(stop) - minToY(start), minEntryH) + 'px';
              setMeta(start, stop);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', (up) => {
              up.stopPropagation();
              handle.removeEventListener('pointermove', onMove);
              handle.releasePointerCapture(up.pointerId);
              block.classList.remove('omnitime-tl__entry--resizing', 'omnitime-tl__entry--lifted');
              if (start !== e.start || stop !== e.stop) save(start, stop - start);
            }, { once: true });
          });
        });

        // Drag to move. Alt (Option) or Ctrl held - at the start or toggled
        // mid-drag - copies instead: the entry stays put and a "copy" ghost
        // follows the pointer; the drop creates the copy there.
        let dragInfo = null;
        let dupGhost = null;
        const dropGhost = () => { if (dupGhost) { dupGhost.remove(); dupGhost = null; } };
        const showCopy = (on, start) => {
          block.classList.toggle('omnitime-tl__entry--copying', on);
          if (!on) { dropGhost(); return; }
          if (!dupGhost) {
            dupGhost = block.cloneNode(true);
            dupGhost.className = cls.concat('omnitime-tl__entry--dupghost').join(' ');
            ['tabindex', 'role', 'aria-label', 'aria-keyshortcuts', 'title', 'data-key', 'aria-busy'].forEach((a) => dupGhost.removeAttribute(a));
            dupGhost.setAttribute('aria-hidden', 'true');
            dupGhost.querySelectorAll('.omnitime-tl__handle, .omnitime-tl__link').forEach((el) => el.remove());
            dupGhost.insertAdjacentHTML('beforeend', `<span class="omnitime-tl__dupbadge">${icon('plus')}Copy</span>`);
            grid.appendChild(dupGhost);
            // The original stays where it is.
            block.style.top = e._top + 'px';
            setMeta(e.start, e.stop);
          }
          dupGhost.style.top = minToY(start) + 'px';
          const time = dupGhost.querySelector('.omnitime-tl__time');
          if (time) time.textContent = timeRange(start, start + e.dur);
        };
        block.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dragInfo = {
            startY: ev.clientY,
            startMin: e.start,
            moved: false,
            initialTop: e._top,
            copy: ev.altKey || ev.ctrlKey,
          };
          block.classList.add('omnitime-tl__entry--lifted');
          block.setPointerCapture(ev.pointerId);
        });
        block.addEventListener('pointermove', (ev) => {
          if (!dragInfo) return;
          const deltaY = ev.clientY - dragInfo.startY;
          if (Math.abs(deltaY) > 3) dragInfo.moved = true;
          if (!dragInfo.moved) return;

          let newStart = snap(yToMin(dragInfo.initialTop + deltaY));
          newStart = clamp(newStart, winStart, winEnd - e.dur);
          dragInfo.copy = ev.altKey || ev.ctrlKey;
          dragInfo.currentStart = newStart;

          showCopy(dragInfo.copy, newStart);
          if (dragInfo.copy) return;
          block.style.top = minToY(newStart) + 'px';
          setMeta(newStart, newStart + e.dur);
        });
        block.addEventListener('pointerup', (ev) => {
          if (!dragInfo) return;
          ev.stopPropagation();
          block.releasePointerCapture(ev.pointerId);
          block.classList.remove('omnitime-tl__entry--lifted');
          const moved = dragInfo.moved && dragInfo.currentStart != null && dragInfo.currentStart !== e.start;
          const newStart = dragInfo.currentStart;
          const copy = dragInfo.copy;
          dragInfo = null;
          showCopy(false);

          if (!moved) {
            if (copy && newStart != null) return; // a copy dropped onto itself
            form.editEntry(raw);
            return;
          }
          if (copy) ctx.ops.duplicate(raw, newStart);
          else save(newStart, e.dur);
        });
        // Ctrl+click is a right click on macOS: no context menu mid-drag.
        block.addEventListener('contextmenu', (ev) => { if (dragInfo) ev.preventDefault(); });
        block.addEventListener('click', (ev) => { ev.stopPropagation(); });

        // Keyboard: Enter/Space edit; Alt(+Shift)+Up/Down nudge in 5-minute
        // steps (shown at once, saved once the keys rest).
        let kb = null;
        block.addEventListener('keydown', (ev) => {
          if (ev.target !== block) return;
          if ((ev.key === 'Enter' || ev.key === ' ') && !ev.altKey) {
            ev.preventDefault();
            form.editEntry(raw);
            focusForm(['.omnitime-f-dur', '.omnitime-save'], block.dataset.key);
            return;
          }
          // Ctrl/Cmd+D: a copy right after this entry (focus moves to it).
          if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'd' || ev.key === 'D')) {
            ev.preventDefault();
            ctx.ops.duplicate(raw, e.stop, { focus: true });
            return;
          }
          if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
          ev.preventDefault();
          const step = ev.key === 'ArrowDown' ? SNAP : -SNAP;
          if (!kb) kb = { start: e.start, stop: e.stop, timer: null };
          const { lo, hi } = room();
          if (ev.shiftKey) {
            kb.stop = clamp(kb.stop + step, kb.start + MIN_DUR, Math.min(hi, kb.start + MAX_DUR));
          } else {
            const dur = kb.stop - kb.start;
            kb.start = clamp(kb.start + step, lo, hi - dur);
            kb.stop = kb.start + dur;
          }
          block.style.top = minToY(kb.start) + 'px';
          block.style.height = Math.max(minToY(kb.stop) - minToY(kb.start), minEntryH) + 'px';
          setMeta(kb.start, kb.stop);
          clearTimeout(kb.timer);
          kb.timer = setTimeout(() => {
            const { start, stop } = kb;
            kb = null;
            if (start === e.start && stop === e.stop) return;
            refocusAfterReload(block.dataset.key);
            save(start, stop - start);
          }, 700);
        });
      }
      grid.appendChild(block);
    });

    // Empty day: a one-line hint inside the grid (hidden while the form is open).
    // Placed at now (today) or the day start, then moved below any calendar
    // placeholder it would sit under (see placeEmptyHint), so it stays clickable.
    let emptyHint = null;
    function placeEmptyHint() {
      if (!emptyHint || !emptyHint.isConnected) return;
      let y = parseFloat(emptyHint.dataset.baseTop) || 0;
      const h = emptyHint.offsetHeight || 32;
      const blocks = [...grid.querySelectorAll('.omnitime-tl__cal-event')]
        .map((b) => ({ top: b.offsetTop, bottom: b.offsetTop + b.offsetHeight }))
        .filter((b) => b.bottom > b.top)
        .sort((a, b) => a.top - b.top);
      blocks.forEach((b) => { if (y < b.bottom && y + h > b.top) y = b.bottom + 6; });
      emptyHint.style.top = y + 'px';
    }
    if (!entries.length) {
      const hint = elem('div', 'omnitime-tl__empty');
      hint.innerHTML = '<span class="omnitime-tl__emptytext">Nothing tracked. Click the timeline or New entry.</span>';
      hint.dataset.baseTop = String(isToday ? minToY(nowMinute()) + 10 : minToY(focusStart) + 10);
      hint.style.top = hint.dataset.baseTop + 'px';
      // "Copy from <previous working day>" (not on future days, see renderMyDayTab).
      if (ctx.copyFrom) {
        const copyBtn = elem('button', 'omnitime-tl__copy', `${icon('repeat')}<span>Copy from ${esc(ctx.copyFrom.label)}</span>`);
        copyBtn.type = 'button';
        copyBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        copyBtn.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.copyFrom.open(copyBtn); });
        hint.appendChild(copyBtn);
      }
      grid.appendChild(hint);
      emptyHint = hint;
    }

    // --- Breaks and untracked gaps ---
    // break_label (my-tracked-time, web app #898) sits on the entry AFTER a
    // pause: the time since the latest earlier stop, "H:MM", only for users
    // who turned breaks on in their profile and only for pauses of 5+ min.
    // Shown as a dotted rule with the label between the entries.
    const BREAK_BAND = 18;
    const breaks = [];
    let latestStop = null;
    entries.forEach((e) => {
      if (e.raw.break_label && latestStop != null && e.start > latestStop) breaks.push({ start: latestStop, stop: e.start, label: String(e.raw.break_label) });
      latestStop = latestStop == null ? e.stop : Math.max(latestStop, e.stop);
    });
    const viewedDate = ctx.state ? ctx.state.date : todayStr();
    // Gaps: untracked stretches of 15+ min within working hours, on days with
    // a target, never in the future (today: up to now), never under an
    // unbooked calendar placeholder (that is "book the meeting" instead). A
    // gap inside a break is offered on the break card instead.
    function renderGaps(placeholders) {
      grid.querySelectorAll('.omnitime-tl__gap, .omnitime-tl__break').forEach((el) => el.remove());
      const show = ctx.dayTarget > 0 && entries.length > 0 && viewedDate <= todayStr();
      const gaps = show ? findGaps({
        busy: entries.map((e) => ({ start: e.start, stop: e.stop })).concat((placeholders || []).map((ce) => ({ start: ce.start, stop: ce.stop }))),
        workStart: focusStart,
        workEnd: focusEnd,
        limit: isToday ? nowMinute() : 24 * 60,
      }) : [];
      const insert = (el, start) => {
        const later = [...grid.querySelectorAll('.omnitime-tl__entry, .omnitime-tl__cal-event')].find((x) => Number(x.dataset.start) > start);
        grid.insertBefore(el, later || null);
      };
      const fillButton = (g) => {
        const btn = elem('button', 'omnitime-tl__gapfill', 'Fill');
        btn.type = 'button';
        btn.setAttribute('aria-label', `Fill ${fmtClock(g.start)}–${fmtClock(g.stop)}, ${fmtDur(g.stop - g.start)} untracked`);
        // Not a click on the grid (that opens the form at the pointer).
        btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        btn.addEventListener('pointermove', (ev) => { ev.stopPropagation(); hideGhost(); });
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hideGhost();
          setSelection(g.start, Math.min(g.stop - g.start, MAX_DUR));
          form.reveal();
          if (ev.detail === 0) focusForm(['.omnitime-search__input', '.omnitime-save'], null);
        });
        return btn;
      };
      const inside = (g, b) => g.start >= b.start && g.stop <= b.stop;
      gaps.filter((g) => !breaks.some((b) => inside(g, b))).forEach((g) => {
        const el = elem('div', 'omnitime-tl__gap', `<span class="omnitime-tl__gaptext">${fmtDur(g.stop - g.start)} untracked</span>`);
        const top = minToY(g.start);
        el.style.top = (top + 1) + 'px';
        el.style.height = Math.max(minToY(g.stop) - top - 2, 14) + 'px';
        el.dataset.start = g.start;
        el.appendChild(fillButton(g));
        insert(el, g.start);
      });
      // A break is a dotted rule with centred "Break 0:30" (never a filled
      // bar). Its label band is BREAK_BAND px tall and must not cover an entry
      // or a shown calendar placeholder, so: centre it on the pause's largest
      // fillable gap that has room for it; else, when such a gap exists but is
      // too small, merge the text into that gap's row ("Break 1:00 · 0:15
      // untracked · Fill"); else centre it on the largest free stretch of the
      // pause; else omit it (the entries around it still show the pause).
      const blocked = (placeholders || []).map((ce) => {
        const top = minToY(ce.start);
        return [top, top + Math.max(minToY(ce.stop) - top, 14)]; // placeholders are 14 px at least
      });
      const freeBand = (loY, hiY) => {
        let spans = [[loY, hiY]];
        blocked.forEach(([a, z]) => {
          spans = spans.flatMap(([lo, hi]) => (z <= lo || a >= hi ? [[lo, hi]] : [[lo, Math.min(hi, a)], [Math.max(lo, z), hi]]));
        });
        return spans.filter(([lo, hi]) => hi - lo >= BREAK_BAND).sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0] || null;
      };
      breaks.forEach((b) => {
        const fills = gaps.filter((g) => inside(g, b)).sort((x, y) => (y.stop - y.start) - (x.stop - x.start));
        let at = null;
        let fill = null;
        for (const g of fills) {
          const band = freeBand(minToY(g.start), minToY(g.stop));
          if (band) { at = band; fill = g; break; }
        }
        if (!at && fills.length) {
          // Too small for a band: the gap row carries the break text.
          const g = fills[0];
          const row = elem('div', 'omnitime-tl__gap omnitime-tl__gap--break', `<span class="omnitime-tl__gaptext">Break ${esc(b.label)} &middot; ${fmtDur(g.stop - g.start)} untracked</span>`);
          const top = minToY(g.start);
          row.style.top = (top + 1) + 'px';
          row.style.height = Math.max(minToY(g.stop) - top - 2, 14) + 'px';
          row.dataset.start = b.start;
          row.appendChild(fillButton(g));
          insert(row, b.start);
          return;
        }
        if (!at) at = freeBand(minToY(b.start), minToY(b.stop));
        if (!at) return;
        const el = elem('div', 'omnitime-tl__break', `<span class="omnitime-tl__breaktext">Break ${esc(b.label)}</span>`);
        el.style.top = ((at[0] + at[1]) / 2) + 'px';
        el.dataset.start = b.start;
        if (fill) el.appendChild(fillButton(fill));
        insert(el, b.start);
      });
    }

    // Today: a "now" line, moved every minute. The timer belongs to the
    // latest render (a re-render replaces it) and stops when the modal closes.
    if (ctx.state) {
      clearInterval(ctx.state.nowTimer);
      ctx.state.nowTimer = null;
    }
    if (isToday) {
      const nowLine = elem('div', 'omnitime-tl__now', '<span class="omnitime-tl__nowlabel"></span>');
      nowLine.setAttribute('aria-hidden', 'true');
      const placeNow = () => {
        const m = nowMinute();
        nowLine.style.top = minToY(m) + 'px';
        nowLine.firstElementChild.textContent = fmtClock(m);
      };
      placeNow();
      grid.appendChild(nowLine);
      const timer = setInterval(() => {
        if (!grid.isConnected || ctx.state.date !== todayStr()) {
          clearInterval(timer);
          if (ctx.state.date !== todayStr()) nowLine.remove();
          return;
        }
        placeNow();
      }, 60 * 1000);
      ctx.state.nowTimer = timer;
      if (ctx.ui && ctx.ui.onClose && ctx.state.nowTimerUi !== ctx.ui) {
        ctx.state.nowTimerUi = ctx.ui;
        ctx.ui.onClose(() => clearInterval(ctx.state.nowTimer));
      }
    }

    wrap.appendChild(grid);
    // Initial scroll: today around "now", other days the working-day start; a
    // reload of the same day keeps the position (at once too, so a local
    // re-render doesn't flash the top of the day).
    if (ctx.keepScroll != null) wrap.scrollTop = ctx.keepScroll;
    setTimeout(() => {
      if (ctx.keepScroll != null) wrap.scrollTop = ctx.keepScroll;
      else if (isToday) wrap.scrollTop = Math.max(0, minToY(nowMinute()) - wrap.clientHeight / 3);
      else wrap.scrollTop = minToY(focusStart) - 20;
    }, 10);

    const cols = wrap.parentElement;
    const pushEscape = (ctx.ui && ctx.ui.pushEscape) || (() => () => {});
    // An open form is an Escape layer (closes it like Cancel); the layer is
    // bound to this form's element, so a day re-render drops it.
    let popFormLayer = null;
    // The timeline item (data-key) a keyboard user opened the form from; focus
    // goes back to it when the form closes (Cancel / Escape).
    let returnKey = null;
    const findItem = (key) => [...grid.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key) || null;
    const setFormOpen = (open) => {
      if (cols) cols.classList.toggle('omnitime-myday__cols--form-open', open);
      if (open && !popFormLayer) {
        popFormLayer = pushEscape(() => { popFormLayer = null; form.cancel(); }, form.el);
      } else if (!open && popFormLayer) {
        popFormLayer();
        popFormLayer = null;
      }
      // A background reconcile held back while the form was open may run now.
      if (!open && ctx.onFormClosed) setTimeout(ctx.onFormClosed, 0);
      if (!open && returnKey) {
        const item = findItem(returnKey);
        if (ctx.state && ctx.state.refocus === returnKey) ctx.state.refocus = null;
        returnKey = null;
        const active = ctx.ui && ctx.ui.root ? ctx.ui.root.activeElement : null;
        if (item && (!active || form.el.contains(active))) item.focus();
      }
    };
    // Keyboard opening: move the focus into the form (first match of
    // `selectors` that is shown) and remember where to come back to - on
    // Cancel/Escape, and after a save reloads the day (if the item is still
    // there, e.g. an edited entry).
    function focusForm(selectors, fromKey) {
      returnKey = fromKey || null;
      refocusAfterReload(returnKey);
      const target = selectors.map((s) => form.el.querySelector(s))
        .find((el) => el && !el.disabled && !el.closest('[hidden]'));
      if (target) target.focus();
    }

    const sel = { start: null, dur: DEFAULT_DUR, block: null, fromCal: false, calEvent: null };
    function clearSelection() { sel.start = null; sel.calEvent = null; renderSelection(); }
    const form = buildForm(formWrap, data, ctx, sel, { setFormOpen, clearSelection });

    function gapAround(minute, ignoreCalEvents = false) {
      let lo = 0;
      let hi = 24 * 60;
      entries.forEach((e) => {
        if (e.stop <= minute && e.stop > lo) lo = e.stop;
        if (e.start >= minute && e.start < hi) hi = e.start;
      });
      if (!ignoreCalEvents) {
        calEvents.forEach((ce) => {
          if (ce.booked) return; // already booked elsewhere; its slot is free
          if (ce.stop <= minute && ce.stop > lo) lo = ce.stop;
          if (ce.start >= minute && ce.start < hi) hi = ce.start;
        });
      }
      return { lo, hi };
    }

    function renderSelection() {
      if (sel.start == null) {
        if (sel.block) { sel.block.remove(); sel.block = null; }
        return;
      }
      if (!sel.block) {
        sel.block = elem('div', 'omnitime-tl__sel');
        sel.block.innerHTML = `
          <div class="omnitime-tl__handle omnitime-tl__handle--top" data-h="top"></div>
          <span class="omnitime-tl__seltext"></span>
          <div class="omnitime-tl__handle omnitime-tl__handle--bottom" data-h="bottom"></div>`;
        grid.appendChild(sel.block);
        sel.block.querySelector('[data-h="top"]').addEventListener('pointerdown', (ev) => startResize(ev, 'top'));
        sel.block.querySelector('[data-h="bottom"]').addEventListener('pointerdown', (ev) => startResize(ev, 'bottom'));
      }
      sel.block.style.top = minToY(sel.start) + 'px';
      // A calendar booking covers its placeholder block; a free slot exactly
      // the time it spans (the label then floats when the box is too low).
      const sh = boxHeight(sel.start, sel.start + sel.dur, sel.calEvent ? MIN_CAL_H : MIN_SEL_H);
      sel.block.style.height = sh + 'px';

      if (sel.calEvent && sel.calEvent.totalCols > 1) {
        const colWidthPct = 100 / sel.calEvent.totalCols;
        const leftPct = sel.calEvent.col * colWidthPct;
        sel.block.style.left = `calc(${leftPct}% + 4px)`;
        sel.block.style.width = `calc(${colWidthPct}% - 8px)`;
        sel.block.style.right = 'auto';
      } else {
        sel.block.style.left = '6px';
        sel.block.style.right = '4px';
        sel.block.style.width = 'auto';
      }

      sel.block.classList.toggle('omnitime-tl__sel--tiny', sh < 34);
      sel.block.classList.toggle('omnitime-tl__sel--micro', sh < 16);
      sel.block.querySelector('.omnitime-tl__seltext').innerHTML =
        `${icon('resize')} ${fmtClock(sel.start)}&ndash;${fmtClock(sel.start + sel.dur)} &middot; ${fmtDur(sel.dur)}`;
    }

    function applySelToForm() {
      if (sel.start == null) return;
      form.setTime(fmtClock(sel.start), sel.dur);
    }

    // Place a [start, start+dur] window inside its free gap, preferring to keep
    // the full requested duration by moving the start back. So a default 15-min
    // window stops 15 min before the next entry (the last hover start before an
    // entry at 13:00 is 12:45, never 12:50/12:55).
    function clampPlacement(start, dur, autoFillGap = false) {
      start = snap(start);
      dur = snap(dur);
      const gap = gapAround(start);
      if (autoFillGap && (gap.hi - gap.lo) <= 60) {
        dur = gap.hi - gap.lo;
        start = gap.lo;
      }
      dur = clamp(dur, MIN_DUR, Math.min(MAX_DUR, Math.max(MIN_DUR, gap.hi - gap.lo)));
      start = clamp(start, gap.lo, gap.hi - dur);
      return { start, dur };
    }

    function setSelection(start, dur, fromCal = false, calEvent = null, autoFillGap = false) {
      let p;
      if (fromCal) {
        p = { start: snap(start), dur: snap(dur) };
      } else {
        p = clampPlacement(start, dur, autoFillGap);
      }
      sel.start = p.start;
      sel.dur = p.dur;
      sel.fromCal = fromCal;
      sel.calEvent = calEvent;
      renderSelection();
      applySelToForm();
    }

    grid.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.omnitime-tl__entry') || ev.target.closest('.omnitime-tl__sel')) return;
      const rect = grid.getBoundingClientRect();
      const minute = snap(yToMin(ev.clientY - rect.top));
      hideGhost();
      setSelection(minute, DEFAULT_DUR, false, null, true);
      // If the create form is already open, just move the time and keep the
      // chosen issue; only reveal() (which resets the target) when opening
      // fresh or coming from edit mode.
      const inCreate = cols.classList.contains('omnitime-myday__cols--form-open') && !form.isEditing();
      if (!inCreate) form.reveal();
    });

    let resize = null;
    function startResize(ev, edge) {
      ev.preventDefault();
      ev.stopPropagation();
      const rect = grid.getBoundingClientRect();
      const gap = gapAround(sel.start + 1, !!sel.calEvent);
      resize = { edge, rect, gap };
      document.addEventListener('pointermove', onResize);
      document.addEventListener('pointerup', endResize, { once: true });
    }
    function onResize(ev) {
      if (!resize) return;
      sel.fromCal = false;
      const minute = snap(yToMin(ev.clientY - resize.rect.top));
      if (resize.edge === 'bottom') {
        const end = clamp(minute, sel.start + MIN_DUR, Math.min(resize.gap.hi, sel.start + MAX_DUR));
        sel.dur = end - sel.start;
      } else {
        const top = clamp(minute, Math.max(resize.gap.lo, (sel.start + sel.dur) - MAX_DUR), (sel.start + sel.dur) - MIN_DUR);
        sel.dur = (sel.start + sel.dur) - top;
        sel.start = top;
      }
      if (sel.calEvent) {
        sel.calEvent.start = sel.start;
        sel.calEvent.dur = sel.dur;
        sel.calEvent.stop = sel.start + sel.dur;
        renderCalendarEvents(calEvents);
      }
      renderSelection();
      applySelToForm();
    }
    function endResize() {
      resize = null;
      document.removeEventListener('pointermove', onResize);
    }

    form.onTimeEdit((startStr, dur) => {
      const start = parseClock(startStr);
      if (start == null) return;
      setSelection(start, dur);
      // The typed time didn't fit the free gap: say so instead of silently clamping.
      if (sel.dur < dur || sel.start !== start) form.noteClamp(sel.start, sel.dur, dur);
    });

    // --- Discoverability: hover ghost over free space + "+ New entry" button ---
    let ghost;
    function hideGhost() { if (ghost) ghost.classList.remove('omnitime-tl__ghost--visible'); }
    function showGhost(minute) {
      if (!ghost) {
        ghost = elem('div', 'omnitime-tl__ghost', '<span class="omnitime-tl__ghosttext"></span>');
        grid.appendChild(ghost);
      }
      const p = clampPlacement(minute, DEFAULT_DUR, true);
      const top = minToY(p.start);
      ghost.style.top = top + 'px';
      ghost.style.height = Math.max(minToY(p.start + p.dur) - top, 18) + 'px';
      const h = Math.floor(p.dur / 60);
      const m = p.dur % 60;
      const fDur = h + ':' + m.toString().padStart(2, '0');
      ghost.querySelector('.omnitime-tl__ghosttext').innerHTML = `${icon('plus')} Add time ${fmtClock(p.start)}&ndash;${fmtClock(p.start + p.dur)} &middot; ${fDur}`;
      ghost.classList.add('omnitime-tl__ghost--visible');
    }
    grid.addEventListener('pointermove', (ev) => {
      // Only hint in the empty state (no active selection / form closed).
      if (resize || sel.start != null || ev.target.closest('.omnitime-tl__entry') || ev.target.closest('.omnitime-tl__cal-event')) { hideGhost(); return; }
      const rect = grid.getBoundingClientRect();
      const minute = snap(yToMin(ev.clientY - rect.top));
      if (entries.some((e) => minute >= e.start && minute < e.stop)) { hideGhost(); return; }
      showGhost(minute);
    });
    grid.addEventListener('pointerleave', hideGhost);

    function pickDefaultStart() {
      const isToday = ctx.state.date === todayStr();
      const now = new Date();
      let pref = isToday ? snap(now.getHours() * 60 + now.getMinutes()) : 9 * 60;
      pref = clamp(pref, winStart, winEnd - DEFAULT_DUR);
      const occupied = entries.some((e) => pref >= e.start && pref < e.stop);
      if (!occupied) return pref;
      if (entries.length) return clamp(entries[entries.length - 1].stop, winStart, winEnd - DEFAULT_DUR);
      return winStart;
    }
    function openAt(minute) {
      hideGhost();
      setSelection(minute, DEFAULT_DUR, false, null, true);
      form.reveal();
      if (sel.block) sel.block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    // The "N" shortcut: the add form at the next free slot (keyboard: focus
    // in the duration field).
    if (ctx.state) {
      ctx.state.addNew = (fromKeyboard) => {
        openAt(pickDefaultStart());
        if (fromKeyboard) focusForm(['.omnitime-f-dur', '.omnitime-save']);
      };
    }

    // --- Calendar event blocks (tentative placeholders) ---
    // Hover popovers go into the shadow root's .omnitime-root (outside the
    // modal's overflow clipping), or <body> when rendered without a shell.
    const popoverHost = (ctx.ui && ctx.ui.layer) || document.body;
    function renderCalendarEvents(calEventsList) {
      try {
        grid.querySelectorAll('.omnitime-tl__cal-event').forEach(el => el.remove());
        grid.querySelectorAll('.omnitime-tl__debug').forEach(el => el.remove()); // clear debug
        popoverHost.querySelectorAll('.omnitime-tl__cal-popover').forEach(el => el.remove());

        // Deduplicate events by ID to prevent stacked identical events
        const uniqueEvents = [];
        const seen = new Set();
        calEventsList.forEach(ce => {
          const eventId = ce.id || `${ce.originalStart}-${ce.originalStop}-${ce.title}`;
          if (!seen.has(eventId)) {
            seen.add(eventId);
            uniqueEvents.push(ce);
          }
        });

        // Filter out dismissed events and evaluate coverage against entries
        const activeEvents = uniqueEvents.filter(ce => {
          // Hidden by occurrence key: stable when the placeholder was dragged.
          const dismissKey = ce.key || `${ce.start}-${ce.stop}-${ce.title}`;
          if (ctx.state && ctx.state.dismissedCalEvents && ctx.state.dismissedCalEvents.has(dismissKey)) return false;
          // Booked from the calendar (at any time): hidden until that booking is gone.
          if (ce.booked) return false;
          ce.covered = entries.some(e => Math.max(e.start, ce.start) < Math.min(e.stop, ce.stop));
          return true;
        });

        // Sort events: start time ascending, then duration descending (stop time descending)
        activeEvents.sort((a, b) => a.start - b.start || b.stop - a.stop);

        // Group into clusters of overlapping events (strictly overlapping in time)
        const visibleEvents = activeEvents.filter(ce => !ce.covered);
        const clusters = [];
        let currentCluster = [];
        let clusterEnd = -1;

        visibleEvents.forEach(ce => {
          if (currentCluster.length === 0) {
            currentCluster.push(ce);
            clusterEnd = ce.stop;
          } else if (ce.start < clusterEnd) {
            currentCluster.push(ce);
            clusterEnd = Math.max(clusterEnd, ce.stop);
          } else {
            clusters.push(currentCluster);
            currentCluster = [ce];
            clusterEnd = ce.stop;
          }
        });
        if (currentCluster.length > 0) {
          clusters.push(currentCluster);
        }

        // Assign columns and totalCols for side-by-side layout
        clusters.forEach(cluster => {
          const columns = [];
          cluster.forEach(ce => {
            let placed = false;
            for (let c = 0; c < columns.length; c++) {
              const lastEv = columns[c][columns[c].length - 1];
              if (lastEv.stop <= ce.start) {
                columns[c].push(ce);
                ce.col = c;
                placed = true;
                break;
              }
            }
            if (!placed) {
              ce.col = columns.length;
              columns.push([ce]);
            }
          });
          const totalCols = columns.length;
          cluster.forEach(ce => {
            ce.totalCols = totalCols;
            ce.clusterColumns = columns; // Pass columns array so we can compute span later
          });
        });

        // Ensure covered events have default layout properties so rendering doesn't crash
        const coveredEvents = activeEvents.filter(ce => ce.covered);
        coveredEvents.forEach(ce => {
          ce.col = 0;
          ce.totalCols = 1;
          ce.clusterColumns = [[ce]];
        });

        activeEvents.forEach((ce) => {
          const eventId = `${ce.start}-${ce.stop}-${ce.title}`;
          const top = minToY(ce.start);
          const h = boxHeight(ce.start, ce.stop, MIN_CAL_H);
          const compact = h < 55;

          const block = elem('div', 'omnitime-tl__cal-event' + (ce.covered ? ' omnitime-tl__cal-event--covered' : '') + (compact ? ' omnitime-tl__cal-event--compact' : ''));
          block.style.top = top + 'px';
          block.style.height = h + 'px';

          // Side-by-side column positioning with spanning
          if (ce.totalCols > 1) {
            let spanRight = 0;
            let spanLeft = 0;
            if (ce.clusterColumns) {
              for (let c = ce.col + 1; c < ce.totalCols; c++) {
                const overlaps = ce.clusterColumns[c].some(other => Math.max(ce.start, other.start) < Math.min(ce.stop, other.stop));
                if (overlaps) break;
                spanRight++;
              }
              for (let c = ce.col - 1; c >= 0; c--) {
                const overlaps = ce.clusterColumns[c].some(other => Math.max(ce.start, other.start) < Math.min(ce.stop, other.stop));
                if (overlaps) break;
                spanLeft++;
              }
            }
            const span = 1 + spanRight + spanLeft;
            const effectiveCol = ce.col - spanLeft;
            const colWidthPct = 100 / ce.totalCols;
            const leftPct = effectiveCol * colWidthPct;
            block.style.left = `calc(${leftPct}% + 4px)`;
            block.style.width = `calc(${colWidthPct * span}% - 8px)`;
            block.style.right = 'auto';
          } else {
            block.style.left = '6px';
            block.style.right = '4px';
            block.style.width = 'auto';
          }

          block.title = ce.covered ? `${ce.title} (already tracked)` : `${ce.title} — click or Enter to track, Delete to hide`;
          const inlineTime = (start) => `&middot; ${fmtClock(start)}&ndash;${fmtClock(start + ce.dur)} (${fmtDur(ce.dur)})`;
          // The issue remembered for this (recurring) event, shown up front.
          const memIssues = (ctx.state && ctx.state.calMemory && ctx.state.calMemory.issues) || {};
          const remembered = rememberedIssueText(memIssues[calSeriesKey(ce)]);
          block.innerHTML = `
            <div class="omnitime-tl__cal-top">
              <div class="omnitime-tl__cal-title">
                <div class="omnitime-tl__cal-icon">${icon('calendar')}</div>
                <span class="omnitime-tl__cal-name">${esc(ce.title)}</span>
                <span class="omnitime-tl__cal-meta-inline">${inlineTime(ce.start)}</span>
                ${remembered ? `<span class="omnitime-tl__cal-issue">→ ${esc(remembered)}</span>` : ''}
              </div>
              <button class="omnitime-tl__cal-dismiss" title="Hide this event (Delete)" aria-label="Hide event: ${esc(ce.title)}" type="button" tabindex="-1">${icon('close')}</button>
            </div>
            <span class="omnitime-tl__cal-meta">${fmtClock(ce.start)}–${fmtClock(ce.stop)} · ${fmtDur(ce.dur)}</span>`;
          block.dataset.start = ce.start;
          block.dataset.key = 'cal:' + (ce.key || eventId);
          if (!ce.covered) {
            // Focusable placeholder: Enter/Space tracks it, Delete/Backspace
            // hides it (the hide button itself stays out of the Tab order).
            block.tabIndex = 0;
            block.setAttribute('role', 'button');
            block.setAttribute('aria-keyshortcuts', 'Enter Delete');
            block.setAttribute('aria-label', `${fmtClock(ce.start)}–${fmtClock(ce.stop)}, calendar event: ${ce.title}, not tracked yet`
              + (remembered ? `, books to ${remembered}` : '') + '. Press Enter to track, Delete to hide.');
          }

          // Hover popover for detailed meeting name & text (an Escape layer
          // while shown).
          let popover = null;
          let popPopoverLayer = null;
          const removePopover = () => {
            if (popover) { popover.remove(); popover = null; }
            if (popPopoverLayer) { popPopoverLayer(); popPopoverLayer = null; }
          };
          const showPopover = () => {
            if (sel.calEvent === ce || sel.start != null) return;
            block.title = ''; // remove native tooltip while hovering
            removePopover();
            popover = elem('div', 'omnitime-tl__cal-popover');
            let descHtml = ce.description ? `<div class="omnitime-tl__cal-popover-desc">${esc(ce.description)}</div>` : '';
            let locHtml = ce.location ? `<div class="omnitime-tl__cal-popover-loc">${icon('location') || ''} ${esc(ce.location)}</div>` : '';
            let actionHint = ce.covered
              ? '<div class="omnitime-tl__cal-popover-hint omnitime-tl__cal-popover-hint--covered">Already tracked</div>'
              : '<div class="omnitime-tl__cal-popover-hint">Click (or Enter) to expand into a regular booking</div>';
            if (remembered && !ce.covered) actionHint = `<div class="omnitime-tl__cal-popover-time">Books to ${esc(remembered)}</div>` + actionHint;

            popover.innerHTML = `
              <div class="omnitime-tl__cal-popover-head">
                <span class="omnitime-tl__cal-popover-title">${esc(ce.title)}</span>
              </div>
              <div class="omnitime-tl__cal-popover-time">${fmtClock(ce.start)} &ndash; ${fmtClock(ce.stop)} (${fmtDur(ce.dur)})</div>
              ${locHtml}
              ${descHtml}
              ${actionHint}
            `;
            popoverHost.appendChild(popover);
            popPopoverLayer = pushEscape(removePopover, popover);

            const rect = block.getBoundingClientRect();
            const popRect = popover.getBoundingClientRect();
            let pTop = rect.top;
            let pLeft = rect.right + 8;
            if (pLeft + popRect.width > window.innerWidth - 10) {
              pLeft = rect.left - popRect.width - 8;
            }
            if (pLeft < 10) {
              pLeft = Math.max(10, rect.left);
              pTop = rect.bottom + 6;
            }
            if (pTop + popRect.height > window.innerHeight - 10) {
              pTop = window.innerHeight - popRect.height - 10;
            }
            if (pTop < 10) pTop = 10;

            popover.style.top = pTop + 'px';
            popover.style.left = pLeft + 'px';
          };
          block.addEventListener('mouseenter', showPopover);
          block.addEventListener('mouseleave', removePopover);
          // Keyboard focus shows the same details (not a click's focus).
          block.addEventListener('focus', () => {
            let keyboard = false;
            try { keyboard = block.matches(':focus-visible'); } catch (e) { /* unsupported */ }
            if (keyboard) showPopover();
          });
          block.addEventListener('blur', removePopover);

          if (!ce.covered) {
            let dragInfo = null;
            block.title = `${ce.title} — click or Enter to track, drag to move, Delete to hide`;
            // Hide: re-layout so events that shared columns with it widen
            // again; keyboard users land on the next item in time.
            const dismiss = (refocus) => {
              removePopover();
              if (ctx.state && ctx.state.dismissedCalEvents) ctx.state.dismissedCalEvents.add(ce.key || eventId);
              renderCalendarEvents(calEvents);
              if (!refocus) return;
              const items = [...grid.querySelectorAll('.omnitime-tl__entry, .omnitime-tl__cal-event[tabindex="0"]')];
              const next = items.find((el) => Number(el.dataset.start) >= ce.start) || items[items.length - 1];
              if (next) next.focus();
            };
            // Turn the placeholder into a booking form (prefilled from it).
            const book = (fromKeyboard) => {
              removePopover();
              if (sel.calEvent !== ce) {
                setSelection(ce.start, ce.dur, true, ce);
                // reveal() resets the form; the event's prefill goes on top.
                form.reveal();
                form.calendarPrefill(ce);
                if (sel.block) sel.block.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
              if (fromKeyboard) {
                focusForm(remembered ? ['.omnitime-save'] : ['.omnitime-search__input', '.omnitime-save'], block.dataset.key);
              }
            };
            block.addEventListener('keydown', (ev) => {
              if (ev.target !== block) return;
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                book(true);
              } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                ev.preventDefault();
                dismiss(true);
              }
            });
            block.addEventListener('pointerdown', (ev) => {
              if (ev.target.closest('.omnitime-tl__cal-dismiss')) {
                ev.stopPropagation();
                dismiss(false);
                return;
              }
              ev.preventDefault();
              ev.stopPropagation();
              removePopover();

              dragInfo = {
                startY: ev.clientY,
                startMin: ce.start,
                moved: false,
                initialTop: minToY(ce.start)
              };
              block.classList.add('omnitime-tl__cal-event--lifted');
              block.setPointerCapture(ev.pointerId);
            });

            block.addEventListener('pointermove', (ev) => {
              if (!dragInfo) return;
              const deltaY = ev.clientY - dragInfo.startY;
              if (Math.abs(deltaY) > 3) dragInfo.moved = true;
              if (!dragInfo.moved) return;

              let newStart = snap(yToMin(dragInfo.initialTop + deltaY));
              newStart = clamp(newStart, winStart, winEnd - ce.dur);
              
              block.style.top = minToY(newStart) + 'px';
              // The time scale differs from place to place (tracked entries
              // take more room): the block, like its selection, follows it.
              block.style.height = boxHeight(newStart, newStart + ce.dur, MIN_CAL_H) + 'px';
              const meta = block.querySelector('.omnitime-tl__cal-meta');
              if (meta) meta.textContent = `${fmtClock(newStart)}\u2013${fmtClock(newStart + ce.dur)} \u00b7 ${fmtDur(ce.dur)}`;
              const metaInline = block.querySelector('.omnitime-tl__cal-meta-inline');
              if (metaInline) metaInline.innerHTML = inlineTime(newStart);

              dragInfo.currentStart = newStart;
              
              if (sel.calEvent === ce) {
                sel.start = newStart;
                renderSelection();
                applySelToForm();
              }
            });

            block.addEventListener('pointerup', (ev) => {
              if (!dragInfo) return;
              ev.stopPropagation();
              block.releasePointerCapture(ev.pointerId);
              block.classList.remove('omnitime-tl__cal-event--lifted');
              const moved = dragInfo.moved && dragInfo.currentStart != null && dragInfo.currentStart !== ce.start;
              const newStart = dragInfo.currentStart;
              const oldStart = dragInfo.startMin;
              dragInfo = null;

              if (moved) {
                ce.start = newStart;
                ce.stop = newStart + ce.dur;
                
                let overlapFound = true;
                let iterations = 0;
                let revertDrag = false;
                const backup = calEvents.map(c => ({...c}));
                
                while (overlapFound && iterations < 10) {
                  overlapFound = false;
                  for (let other of calEvents) {
                    if (other === ce) continue;
                    if (other.start < ce.stop && other.stop > ce.start) {
                      let canFitBelow = true;
                      let newStartBelow = ce.stop;
                      let newStopBelow = newStartBelow + other.dur;
                      for (let e of entries) { if (e.start < newStopBelow && e.stop > newStartBelow) canFitBelow = false; }
                      for (let c of calEvents) { if (c !== other && c !== ce && c.start < newStopBelow && c.stop > newStartBelow) canFitBelow = false; }
                      
                      let canFitAbove = true;
                      let newStartAbove = ce.start - other.dur;
                      let newStopAbove = ce.start;
                      for (let e of entries) { if (e.start < newStopAbove && e.stop > newStartAbove) canFitAbove = false; }
                      for (let c of calEvents) { if (c !== other && c !== ce && c.start < newStopAbove && c.stop > newStartAbove) canFitAbove = false; }

                      if (canFitBelow && (!canFitAbove || other.start >= ce.start)) {
                        other.start = newStartBelow;
                        other.stop = newStopBelow;
                        overlapFound = true;
                        break;
                      } else if (canFitAbove) {
                        other.start = newStartAbove;
                        other.stop = newStopAbove;
                        overlapFound = true;
                        break;
                      } else {
                        revertDrag = true;
                        overlapFound = false;
                        break;
                      }
                    }
                  }
                  iterations++;
                }

                if (revertDrag) {
                  calEvents.forEach((c, i) => {
                    c.start = backup[i].start;
                    c.stop = backup[i].stop;
                  });
                  ce.start = oldStart;
                  ce.stop = oldStart + ce.dur;
                }

                renderCalendarEvents(calEvents);
                if (sel.calEvent === ce) {
                  renderSelection();
                }
              } else {
                book(false);
              }
            });

            block.addEventListener('click', (ev) => {
              ev.stopPropagation();
            });
          }
          // Tab order = time order: insert before the first entry that starts
          // later (entries never move, so a focused entry keeps its focus).
          const ref = (sel.block && sel.block.parentElement === grid) ? sel.block : ((ghost && ghost.parentElement === grid) ? ghost : null);
          const later = [...grid.querySelectorAll('.omnitime-tl__entry')].find((el) => Number(el.dataset.start) > ce.start);
          grid.insertBefore(block, later || ref);
        });
        // Gaps leave the shown placeholders alone; the footer recounts the
        // meetings it can book.
        renderGaps(visibleEvents);
        placeEmptyHint();
        if (ctx.onCalendarChange) ctx.onCalendarChange();
      } catch (err) {
        grid.appendChild(elem('div', 'omnitime-tl__debug', 'Render error: ' + esc(err.message)));
      }
    }

    renderCalendarEvents(calEvents);
    grid.addEventListener('omnitime-cal-update', (ev) => {
      try {
        const mapped = (ev.detail || []).map(toCalEvent);
        // Swap in place: drag collision handling and gapAround() read
        // calEvents, so a re-render from a stale copy would undo the sync.
        calEvents.splice(0, calEvents.length, ...mapped);
        renderCalendarEvents(calEvents);
      } catch (err) {
        grid.appendChild(elem('div', 'omnitime-tl__debug omnitime-tl__debug--map', 'Map error: ' + esc(err.message)));
      }
    });

    // "+ New entry" lives in the footer row (bottom-left), beside the total.
    // The footer persists across day switches, so drop any prior button first
    // to avoid accumulating duplicates on re-render.
    const myday = wrap.closest('.omnitime-myday');
    const footer = myday && myday.querySelector('.omnitime-myday__total');
    if (footer) {
      footer.querySelector('.omnitime-add-btn')?.remove();
      const addBtn = elem('button', 'omnitime-add-btn', `${icon('plus')}<span>New entry</span>`);
      addBtn.addEventListener('click', () => openAt(pickDefaultStart()));
      footer.insertBefore(addBtn, footer.firstChild);
    }

    // A keyboard move/resize reloaded the day: focus the same item again so
    // the next Alt+arrow keeps working.
    if (ctx.state && ctx.state.refocus) {
      const item = findItem(ctx.state.refocus);
      ctx.state.refocus = null;
      if (item) item.focus();
    }
  }

  // --- Form input parsing (pure; exposed on OmniTime for the tests) ---
  // Each parser returns { ..., error } where `error` is the message shown
  // inline next to the field (null when the input is valid).
  const DUR_FORMATS = 'e.g. 45, 1:30, 1h30 or 1.5h';
  // Accepts minutes ("45", "90m"), "h:mm" ("0:45", "1:30") and hours ("1h",
  // "1h30", "1h30m", "1.5h"), within MIN_DUR..MAX_DUR.
  function parseDuration(input) {
    const v = String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, '');
    const fail = (error) => ({ minutes: null, error });
    if (!v) return fail(`Enter a duration, ${DUR_FORMATS}.`);
    let min = null;
    let m;
    if ((m = v.match(/^(\d+)$/)) || (m = v.match(/^(\d+)m(?:in)?$/))) {
      min = parseInt(m[1], 10);
    } else if ((m = v.match(/^(\d+):(\d{1,2})$/)) || (m = v.match(/^(\d+)h(\d{1,2})m?$/))) {
      if (parseInt(m[2], 10) > 59) return fail(`Minutes must be 0-59, ${DUR_FORMATS}.`);
      min = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    } else if ((m = v.match(/^(\d+(?:[.,]\d+)?)h$/))) {
      min = Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    }
    if (min == null) return fail(`Not a duration, ${DUR_FORMATS}.`);
    if (min < MIN_DUR) return fail(`The minimum duration is ${fmtDur(MIN_DUR)}.`);
    if (min > MAX_DUR) return fail(`The maximum is ${fmtDur(MAX_DUR)} per entry. Split longer work into several entries.`);
    return { minutes: min, error: null };
  }
  // Accepts "930", "0930", "9:30", "09:30" and a bare hour ("9"); `text` is
  // the normalised "HH:MM".
  function parseStartTime(input) {
    const v = String(input == null ? '' : input).trim();
    const fail = (error) => ({ minutes: null, text: '', error });
    if (!v) return fail('Enter a start time, e.g. 9:30.');
    const m = v.match(/^(\d{1,2}):(\d{2})$/) || v.match(/^(\d{1,2})(\d{2})$/) || v.match(/^(\d{1,2})()$/);
    if (!m) return fail('Not a time, e.g. 9:30 or 0930.');
    const h = parseInt(m[1], 10);
    const mi = m[2] === '' ? 0 : parseInt(m[2], 10);
    if (h > 23 || mi > 59) return fail('Not a valid time (00:00-23:59).');
    return { minutes: h * 60 + mi, text: `${pad2(h)}:${pad2(mi)}`, error: null };
  }
  // The value of an <input type="date"> ("YYYY-MM-DD", real calendar date).
  function parseDateValue(input) {
    const v = String(input == null ? '' : input).trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m ? new Date(`${v}T00:00:00`) : null;
    if (!d || isNaN(d.getTime()) || d.getMonth() + 1 !== parseInt(m[2], 10)) return { date: null, error: 'Pick a valid date.' };
    return { date: v, error: null };
  }
  // "Mon 19 Oct" (fixed English names: the UI is English-only).
  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    return `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
  };

  // --- Recent issues (chrome.storage.local: this browser only) ---
  // The last RECENT_MAX issues booked from this browser, newest first,
  // deduplicated: [{ source?, project_id?, issue_id, label }]. With source +
  // project_id, issue_id is the tracker's own (external) id; without them it
  // is the internal id. Shown in the search box while the query is empty.
  const RECENT_KEY = 'omnitimeRecentIssues';
  const RECENT_MAX = 8;
  const recentKey = (r) => `${r.source || ''}|${r.project_id || ''}|${r.issue_id}`;
  function loadRecentIssues() {
    if (!hasLocalStorage()) return Promise.resolve([]);
    return new Promise((resolve) => {
      chrome.storage.local.get([RECENT_KEY], (r) => {
        const list = r && r[RECENT_KEY];
        resolve(Array.isArray(list) ? list.filter((x) => x && x.issue_id != null && x.label) : []);
      });
    });
  }
  function rememberRecentIssue(item) {
    if (!hasLocalStorage() || !item || item.issue_id == null || !item.label) return Promise.resolve();
    return loadRecentIssues().then((list) => {
      const next = [item].concat(list.filter((x) => recentKey(x) !== recentKey(item))).slice(0, RECENT_MAX);
      return new Promise((resolve) => chrome.storage.local.set({ [RECENT_KEY]: next }, resolve));
    });
  }

  // --- Issue search options (the form's combobox and the Book dialog's) ---
  // An option: { id (internal, or null), ext ({ source, project_id, issue_id }
  // for a recent issue picked by external id), label ("Name #ext"), name,
  // idText, kicker, raw (the API record, for starring) }.
  // `raw` keeps the API record (search, frequent, starred).
  const issueLabelText = (i) => (i.issue_external_id ? `${i.label} #${i.issue_external_id}` : String(i.label || ''));
  const searchOption = (i) => ({
    id: i.issue_internal_id,
    label: issueLabelText(i),
    name: i.label,
    idText: i.issue_external_id ? `#${i.issue_external_id}` : '',
    kicker: `${i.project || ''}${i.milestone ? ' \u2013 ' + i.milestone : ''}`,
    raw: i,
  });
  const recentOption = (r) => (r.source
    ? { id: null, ext: { source: r.source, project_id: r.project_id, issue_id: r.issue_id }, label: r.label, name: r.label }
    : { id: r.issue_id, label: r.label, name: r.label, raw: { issue_internal_id: r.issue_id, label: r.label } });
  const frequentOption = (i) => ({
    id: i.issue_internal_id,
    label: issueLabelText(i),
    name: i.label,
    idText: i.issue_external_id ? `#${i.issue_external_id}` : '',
    kicker: i.project || '',
    suggestedMinutes: Number(i.suggested_minutes) || 0,
    suggestedLabel: i.suggested_label || '',
    raw: i,
  });
  // Empty query: starred issues, recently booked ones, then the API's
  // frequent ones (each issue once, in the first group it appears in).
  // [{ title, items: [option] }]
  function emptyQueryGroups(starred, recentAll, frequentAll) {
    starred = starred || [];
    const starredIds = new Set(starred.map((i) => String(i.issue_internal_id)));
    const recent = (recentAll || []).filter((r) => r.source || !starredIds.has(String(r.issue_id)));
    const known = new Set([...starredIds, ...recent.filter((r) => !r.source).map((r) => String(r.issue_id))]);
    const frequent = (frequentAll || []).filter((i) => !known.has(String(i.issue_internal_id))).slice(0, RECENT_MAX);
    const groups = [];
    if (starred.length) groups.push({ title: 'Starred', items: starred.map(searchOption) });
    if (recent.length) groups.push({ title: 'Recent', items: recent.slice(0, RECENT_MAX).map(recentOption) });
    if (frequent.length) groups.push({ title: 'Frequent', items: frequent.map(frequentOption) });
    return groups;
  }

  // Build the new-entry form (current-issue default, search override, chips).
  function buildForm(wrap, data, ctx, sel, ctrl) {
    ctrl = ctrl || {};
    const context = ctx.context || {};
    const issueLabel = context.issue_label || (context.issue_id ? '#' + context.issue_id : 'current issue');
    // mode 'issue' books against `issueInternalId`, or against `ext`
    // ({ source, project_id, issue_id }) for a recent issue picked by external id.
    const target = { mode: 'current', issueInternalId: null, ext: null, label: issueLabel, raw: null, project: '' };
    // Why the issue was chosen (calendar bookings), shown under the target.
    let kickerText = '';
    // The search shows only while choosing another issue (or when none is set).
    let choosing = false;
    const hasCurrentIssue = !!(context.source && context.project_id && context.issue_id);
    // The calendar event a new entry is being created from (calendarPrefill).
    let pendingCal = null;
    // The "This issue" tab stashes context.issueOpen; a closed current issue
    // must not be the default target (the backend rejects it anyway).
    const currentIssueClosed = () => context.issueOpen === false;

    // Top to bottom: the issue target (a single line; the search only while
    // choosing) -> one time row (date, start, duration, end) with the quick
    // durations -> the comment -> actions. Errors show only when there is one.
    wrap.innerHTML = `
      <div class="omnitime-form">
        <div class="omnitime-form__head"><span class="omnitime-form__title">New entry</span></div>
        <div class="omnitime-form__alert" role="alert" hidden></div>
        <div class="omnitime-target">
          <div class="omnitime-target__line">
            <span class="omnitime-target__stripe" aria-hidden="true"></span>
            <span class="omnitime-target__text"><span class="omnitime-target__proj" hidden></span><span class="omnitime-target__sep" aria-hidden="true" hidden>/</span><span class="omnitime-target__label"></span></span>
            <button class="omnitime-star omnitime-target__star" type="button" aria-pressed="false" aria-label="Star this issue" hidden></button>
            <button class="omnitime-target__change" type="button">Change</button>
            <button class="omnitime-target__reset" type="button" hidden title="Back to current issue" aria-label="Back to current issue">${icon('close')}</button>
          </div>
          <span class="omnitime-target__kicker" hidden></span>
        </div>
        <div class="omnitime-sugg" role="group" aria-label="Suggested issues" hidden>
          <div class="omnitime-bk__chips"></div>
        </div>
        <div class="omnitime-search" hidden>
          <span class="omnitime-search__icon">${icon('search')}</span>
          <input type="text" class="omnitime-search__input" placeholder="Search issue&hellip;" aria-label="Search issue" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="omnitime-search-list">
          <div class="omnitime-search__results" id="omnitime-search-list" role="listbox" aria-label="Issues" hidden></div>
        </div>
        <div class="omnitime-form__time">
          <button class="omnitime-f-datebtn" type="button"></button>
          <input type="date" id="omnitime-f-date" class="omnitime-f-date" aria-label="Date" hidden>
          <input type="text" id="omnitime-f-start" class="omnitime-f-start" value="" autocomplete="off" aria-label="Start time">
          <span class="omnitime-form__for" aria-hidden="true">for</span>
          <input type="text" id="omnitime-f-dur" class="omnitime-f-dur" value="0:15" autocomplete="off" aria-label="Duration" aria-describedby="omnitime-f-end">
          <span class="omnitime-f-end" id="omnitime-f-end"></span>
        </div>
        <div class="omnitime-seg omnitime-qdur" role="group" aria-label="Quick durations">
          ${QUICK_DURATIONS.map((q) => `<button class="omnitime-seg__btn omnitime-qdur__chip" type="button" data-min="${q.minutes}" aria-pressed="false" aria-label="${q.name}">${q.label}</button>`).join('')}
        </div>
        <div class="omnitime-form__errs">
          <span class="omnitime-f-err" id="omnitime-f-start-err" hidden></span>
          <span class="omnitime-f-err" id="omnitime-f-dur-err" hidden></span>
          <span class="omnitime-f-err" id="omnitime-f-date-err" hidden></span>
        </div>
        <textarea class="omnitime-f-comment" rows="1" placeholder="Add a comment&hellip;" aria-label="Comment"></textarea>
        <div class="omnitime-form__actions">
          <button class="omnitime-save" type="button">Save entry</button>
          <button class="omnitime-form__close" type="button">Cancel</button>
          <span class="omnitime-form__msg"></span>
          <button class="omnitime-del" type="button">Delete</button>
        </div>
      </div>`;

    const formEl = wrap.querySelector('.omnitime-form');
    const targetBox = formEl.querySelector('.omnitime-target');
    const targetStripe = formEl.querySelector('.omnitime-target__stripe');
    const targetText = formEl.querySelector('.omnitime-target__text');
    const targetProj = formEl.querySelector('.omnitime-target__proj');
    const targetSep = formEl.querySelector('.omnitime-target__sep');
    const targetKicker = formEl.querySelector('.omnitime-target__kicker');
    const targetLabel = formEl.querySelector('.omnitime-target__label');
    const changeBtn = formEl.querySelector('.omnitime-target__change');
    const resetBtn = formEl.querySelector('.omnitime-target__reset');
    const targetStar = formEl.querySelector('.omnitime-target__star');
    const suggBox = formEl.querySelector('.omnitime-sugg');
    const suggChips = suggBox.querySelector('.omnitime-bk__chips');
    const searchWrap = formEl.querySelector('.omnitime-search');
    const searchInput = formEl.querySelector('.omnitime-search__input');
    const searchResults = formEl.querySelector('.omnitime-search__results');
    const durInput = formEl.querySelector('.omnitime-f-dur');
    const startInput = formEl.querySelector('.omnitime-f-start');
    const dateInput = formEl.querySelector('.omnitime-f-date');
    const dateBtn = formEl.querySelector('.omnitime-f-datebtn');
    const endEl = formEl.querySelector('.omnitime-f-end');
    endEl.setAttribute('aria-live', 'polite'); // announces the end time and the clamp note
    const errsBox = formEl.querySelector('.omnitime-form__errs');
    const durErr = formEl.querySelector('#omnitime-f-dur-err');
    const startErr = formEl.querySelector('#omnitime-f-start-err');
    const dateErr = formEl.querySelector('#omnitime-f-date-err');
    errsBox.hidden = true;
    const qdChips = [...formEl.querySelectorAll('.omnitime-qdur__chip')];
    const commentInput = formEl.querySelector('.omnitime-f-comment');
    const saveBtn = formEl.querySelector('.omnitime-save');
    const msgEl = formEl.querySelector('.omnitime-form__msg');
    const alertEl = formEl.querySelector('.omnitime-form__alert');
    const titleEl = formEl.querySelector('.omnitime-form__title');
    const delBtn = formEl.querySelector('.omnitime-del');

    dateInput.value = ctx.state.date || todayStr();
    let timeEditCb = null;
    let editing = null;

    // --- Issue search (ARIA combobox) ---
    // Focus stays in the input; ArrowUp/Down move a highlighted option
    // (aria-activedescendant), Enter picks it. `options` mirrors the rendered
    // options by index. Every query bumps `searchSeq`, so a response that
    // arrives after a newer keystroke (or after the list was closed) is dropped.
    let searchTimer = null;
    let searchSeq = 0;
    let options = [];
    let activeIdx = -1;

    // Search results are an Escape layer while shown (see createEscapeStack).
    const pushEscape = (ctx.ui && ctx.ui.pushEscape) || (() => () => {});
    let popResultsLayer = null;
    const setActive = (idx) => {
      activeIdx = idx;
      const items = [...searchResults.querySelectorAll('[role="option"][data-idx]')];
      items.forEach((el, i) => {
        el.classList.toggle('omnitime-search__item--active', i === idx);
        el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      });
      if (items[idx]) {
        searchInput.setAttribute('aria-activedescendant', items[idx].id);
        items[idx].scrollIntoView({ block: 'nearest' });
      } else {
        searchInput.removeAttribute('aria-activedescendant');
      }
    };
    const showResults = (html) => {
      options = [];
      searchResults.innerHTML = html;
      searchResults.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
      setActive(-1);
      if (!popResultsLayer) popResultsLayer = pushEscape(() => { popResultsLayer = null; hideResults(); }, searchResults);
    };
    const hideResults = () => {
      clearTimeout(searchTimer);
      searchSeq++;
      options = [];
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      searchInput.setAttribute('aria-expanded', 'false');
      setActive(-1);
      if (popResultsLayer) { popResultsLayer(); popResultsLayer = null; }
    };

    // The target is one line: project stripe, "Project / Issue #id", then the
    // star, Change and (for a picked issue) back-to-current on the right.
    const labelHtml = (label) => {
      const m = String(label).match(/^(.*?)\s*#(\S+)$/);
      return m && m[1] ? `${esc(m[1])}${idHtml(m[2])}` : esc(label);
    };
    const renderTarget = () => {
      const none = target.mode === 'none';
      const noIssue = target.mode === 'current' && !hasCurrentIssue;
      targetBox.classList.toggle('omnitime-target--warn', none);
      targetBox.classList.toggle('omnitime-target--empty', none || noIssue);
      const kicker = none ? 'This issue is closed' : kickerText;
      targetKicker.textContent = kicker;
      targetKicker.hidden = !kicker;
      if (none || noIssue) targetLabel.textContent = none ? 'Choose an open issue' : 'No issue selected';
      else targetLabel.innerHTML = labelHtml(target.label);
      const project = none || noIssue ? '' : target.project;
      targetProj.textContent = project;
      targetProj.hidden = targetSep.hidden = !project;
      targetText.title = none || noIssue ? '' : (project ? project + ' / ' : '') + target.label;
      targetStripe.className = 'omnitime-target__stripe' + (project ? ' omnitime-target__stripe--p' + projectColorIndex(project) : '');
      // Reset ("back to current issue") only applies when another issue is
      // picked and the current issue is open.
      resetBtn.hidden = target.mode !== 'issue' || currentIssueClosed();
      const showSearch = choosing || none || noIssue;
      searchWrap.hidden = !showSearch;
      changeBtn.hidden = showSearch;
      renderTargetStar();
    };
    const setChoosing = (on) => {
      if (choosing === on) return;
      choosing = on;
      renderTarget();
    };

    // --- Starred issues (ctx.state.bookmarks, see createBookmarkStore) ---
    // A star toggle on search results and on the picked issue, for open
    // issues with an internal id, once my-bookmarks has loaded.
    const bookmarks = ctx.state.bookmarks || null;
    const canStar = (id) => !!bookmarks && bookmarks.isReady() && id != null && id !== '';
    const paintStar = (btn, name) => {
      const on = bookmarks.has(btn.dataset.starId);
      btn.textContent = on ? '\u2605' : '\u2606';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('omnitime-star--on', on);
      if (name) btn.setAttribute('aria-label', `Star ${name}`);
      btn.title = on ? 'Starred - click to unstar' : 'Star this issue';
    };
    function renderTargetStar() {
      const id = target.mode === 'issue' && !editing ? target.issueInternalId : null;
      targetStar.hidden = !canStar(id);
      if (targetStar.hidden) return;
      targetStar.dataset.starId = String(id);
      paintStar(targetStar, target.label);
    }
    const toggleStar = (issue) => {
      if (!bookmarks) return;
      bookmarks.toggle(issue).catch(() => {
        if (ctx.ui && ctx.ui.toast) ctx.ui.toast("Couldn't update the star. Try again.");
      });
    };
    targetStar.addEventListener('click', () => {
      toggleStar(target.raw && String(target.raw.issue_internal_id) === String(target.issueInternalId)
        ? target.raw
        : { issue_internal_id: target.issueInternalId, label: target.label });
    });
    // Every star in this form follows the store (optimistic flip + rollback).
    if (bookmarks) {
      const unsubscribe = bookmarks.subscribe((id) => {
        if (!formEl.isConnected) { unsubscribe(); return; }
        formEl.querySelectorAll('.omnitime-star[data-star-id]').forEach((b) => { if (b.dataset.starId === String(id)) paintStar(b); });
      });
      // Stars show up once my-bookmarks is in (cached per modal open).
      bookmarks.load().then(() => { if (formEl.isConnected) renderTargetStar(); });
    }
    renderTarget();

    // raw: the picked issue's API record (bookmarks need its label/project).
    const setTarget = (mode, id, label, ext, raw, project) => {
      target.mode = mode;
      target.issueInternalId = id;
      target.ext = ext || null;
      target.label = label;
      target.raw = raw || null;
      target.project = project || (raw && raw.project) || '';
      kickerText = '';
      choosing = false;
      renderTarget();
      clearError();
    };
    // Any field edit clears a shown error.
    formEl.addEventListener('input', () => clearError());
    resetBtn.addEventListener('click', () => {
      prefillTouched = true;
      setTarget(currentIssueClosed() ? 'none' : 'current', null, issueLabel);
    });

    // --- Suggestions for a calendar event (see resolveBookingSuggestions) ---
    // Up to three one-click issues under the target; clicking one swaps it
    // with the issue the entry is booked on (which takes the chip's place).
    let formSugg = [];
    let prefillTouched = false; // the user chose something since the prefill: the late server answer must not override it
    let autoQuery = '';         // the title search the prefill started (not a user choice)
    const renderSugg = () => {
      suggBox.hidden = !formSugg.length;
      suggChips.innerHTML = formSugg.map((sg, k) => suggestionChipHtml(sg, k)).join('');
    };
    const targetIssue = () => (target.mode === 'issue' && target.issueInternalId != null
      ? bookIssueFromOption({ id: target.issueInternalId, label: target.label, raw: target.raw })
      : null);
    suggChips.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act="sugg"]');
      if (!btn) return;
      const k = Number(btn.dataset.k);
      const clicked = formSugg[k];
      if (!clicked) return;
      formSugg = swapSuggestion(targetIssue(), formSugg, k).suggestions;
      prefillTouched = true;
      setTarget('issue', clicked.id, bookIssueLabel(clicked), null, bookIssueRaw(clicked));
      searchInput.value = '';
      hideResults();
      renderSugg();
      const next = suggChips.querySelector(`[data-k="${k}"]`) || suggChips.querySelector('[data-k]');
      if (next) next.focus({ preventScroll: true });
    });

    // Cancel (close button or Escape): close the form pane and clear the
    // pending selection.
    const cancel = () => {
      hideResults();
      if (ctrl.setFormOpen) ctrl.setFormOpen(false);
      if (ctrl.clearSelection) ctrl.clearSelection();
    };
    formEl.querySelector('.omnitime-form__close').addEventListener('click', cancel);

    // --- Field validation ---
    // Typing never shows a new error (that would flag half-typed input); the
    // field is checked and normalised when it is left (change), and all of
    // them again on save. A shown error clears as soon as the text is valid.
    // Invalid text is kept as typed and never reaches the timeline selection.
    const showFieldError = (input, errEl, message, baseDescribedBy) => {
      errEl.textContent = message || '';
      errEl.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      const ids = [message ? errEl.id : '', baseDescribedBy || ''].filter(Boolean).join(' ');
      if (ids) input.setAttribute('aria-describedby', ids); else input.removeAttribute('aria-describedby');
      errsBox.hidden = [durErr, startErr, dateErr].every((el) => el.hidden);
    };
    const checkDur = () => {
      const r = parseDuration(durInput.value);
      showFieldError(durInput, durErr, r.error, endEl.id);
      if (!r.error) durInput.value = fmtDur(r.minutes);
      refreshDerived();
      return r;
    };
    // An entry that has no start time yet may keep it empty (the PATCH then
    // leaves its start alone); everything else needs one.
    const startOptional = () => !!editing && !editing.start && !startInput.value.trim();
    const checkStart = () => {
      const r = startOptional() ? { minutes: null, text: '', error: null } : parseStartTime(startInput.value);
      showFieldError(startInput, startErr, r.error);
      if (!r.error) startInput.value = r.text;
      refreshDerived();
      return r;
    };
    const checkDate = () => {
      const r = parseDateValue(dateInput.value);
      showFieldError(dateInput, dateErr, r.error);
      return r;
    };
    const clearFieldErrors = () => {
      showFieldError(durInput, durErr, null, endEl.id);
      showFieldError(startInput, startErr, null);
      showFieldError(dateInput, dateErr, null);
    };
    // Live feedback while typing: end time + active quick chip, and a shown
    // error goes away once the text is valid.
    const liveInput = (input, errEl, parse, base) => input.addEventListener('input', () => {
      if (input.hasAttribute('aria-invalid') && !parse(input.value).error) showFieldError(input, errEl, null, base);
      refreshDerived();
    });
    liveInput(durInput, durErr, parseDuration, endEl.id);
    liveInput(startInput, startErr, parseStartTime);
    liveInput(dateInput, dateErr, parseDateValue);

    // The computed end next to the duration, and the quick chip that matches.
    function refreshDerived() {
      const d = parseDuration(durInput.value);
      const s = parseStartTime(startInput.value);
      if (!d.error && !s.error) {
        const end = s.minutes + d.minutes;
        endEl.innerHTML = `<span class="ot-visually-hidden">Ends at </span>&rarr; ${fmtClock(end)}${end >= 24 * 60 ? ' (+1 day)' : ''}`;
      } else {
        endEl.textContent = '';
      }
      qdChips.forEach((b) => b.setAttribute('aria-pressed', !d.error && d.minutes === parseInt(b.dataset.min, 10) ? 'true' : 'false'));
    }
    // The date is a quiet text button ("Today", "Mon 19 Oct"); a click swaps in
    // the date input (and opens its picker), it goes back when left. A date that
    // is invalid stays an input so the error and the field sit together.
    let dateOpen = false;
    const dateText = (value) => {
      const d = parseDateValue(value).date;
      if (!d) return 'Pick a date';
      const today = todayStr();
      if (d === today) return 'Today';
      if (d === addDays(today, -1)) return 'Yesterday';
      if (d === addDays(today, 1)) return 'Tomorrow';
      return shortDate(d);
    };
    const updateWhen = () => {
      const invalid = dateInput.hasAttribute('aria-invalid');
      dateBtn.textContent = dateText(dateInput.value);
      dateBtn.title = 'Change the date';
      dateBtn.setAttribute('aria-label', `Date: ${dateBtn.textContent}. Change`);
      dateBtn.hidden = dateOpen || invalid;
      dateInput.hidden = !(dateOpen || invalid);
    };
    dateBtn.addEventListener('click', () => {
      dateOpen = true;
      updateWhen();
      dateInput.focus();
      try { if (dateInput.showPicker) dateInput.showPicker(); } catch (e) { /* needs a user gesture: the field stays editable */ }
    });
    dateInput.addEventListener('focusout', () => { dateOpen = false; updateWhen(); });
    // The comment grows with its text (up to a few lines).
    const growComment = () => {
      commentInput.style.height = 'auto';
      if (commentInput.scrollHeight) commentInput.style.height = commentInput.scrollHeight + 'px';
    };
    commentInput.addEventListener('input', growComment);

    // Valid start + duration on the viewed day move the timeline selection
    // (which may clamp them to the free gap and write them back via setTime).
    const fireEdit = () => {
      if (!timeEditCb || editing) return;
      if (dateInput.value !== ctx.state.date) return; // the selection belongs to the viewed day
      const d = parseDuration(durInput.value);
      const s = parseStartTime(startInput.value);
      if (d.error || s.error) return;
      timeEditCb(s.text, d.minutes);
    };
    const fieldChanged = (input) => {
      if (input === durInput) checkDur();
      else if (input === startInput) checkStart();
      else checkDate();
      updateWhen();
      fireEdit();
    };
    [durInput, startInput, dateInput].forEach((input) => input.addEventListener('change', () => fieldChanged(input)));

    const setDurationMinutes = (minutes) => {
      durInput.value = fmtDur(minutes);
      showFieldError(durInput, durErr, null, endEl.id);
      refreshDerived();
      fireEdit();
    };
    qdChips.forEach((b) => b.addEventListener('click', () => setDurationMinutes(parseInt(b.dataset.min, 10))));
    refreshDerived();

    // --- Search behaviour ---
    // (issueLabelText, searchOption, recentOption, frequentOption: module level,
    // shared with the "Book meetings" dialog's issue search.)
    // The star sits next to its option (not inside: an option is a button).
    // It is a mouse shortcut - out of the Tab order like the options (focus
    // stays in the combobox); the picked issue's star is the keyboard path.
    const optionHtml = (o, idx) => {
      const starred = o.id != null && canStar(o.id) && bookmarks.has(o.id);
      const option = `
      <button class="omnitime-search__item" type="button" role="option" tabindex="-1" id="omnitime-opt-${idx}" aria-selected="false" data-idx="${idx}" data-id="${esc(o.id)}" data-label="${esc(o.label)}">
        ${o.kicker ? `<span class="omnitime-search__kicker">${esc(o.kicker)}</span>` : ''}
        <span class="omnitime-search__label">${esc(o.name)}${o.idText ? ` <span class="omnitime-search__id">${esc(o.idText)}</span>` : ''}${starred ? '<span class="ot-visually-hidden"> (starred)</span>' : ''}${o.suggestedLabel ? `<span class="omnitime-search__dur">${esc(o.suggestedLabel)}</span>` : ''}</span>
      </button>`;
      if (o.id == null || !o.raw || !canStar(o.id)) return option;
      return `<div class="omnitime-search__row" role="none">${option}<button class="omnitime-star omnitime-search__star" type="button" tabindex="-1" data-star-id="${esc(o.id)}" data-star-idx="${idx}"></button></div>`;
    };
    const pick = (opt) => {
      if (!opt) return;
      prefillTouched = true;
      // The search box hides with the pick; keep focus on the issue line.
      const searchWrap = searchInput.parentElement;
      const hadFocus = searchWrap.contains(searchInput.getRootNode().activeElement);
      setTarget('issue', opt.id, opt.label, opt.ext, opt.raw);
      hideResults();
      searchInput.value = '';
      if (hadFocus) changeBtn.focus();
      // A frequent issue brings along its usual duration.
      if (opt.suggestedMinutes) setDurationMinutes(opt.suggestedMinutes);
    };
    // groups: [{ title?, items: [option] }]
    const showOptions = (groups) => {
      const flat = [];
      const html = groups.map((g, gi) => {
        const items = g.items.map((o) => optionHtml(o, flat.push(o) - 1)).join('');
        return g.title
          ? `<div role="group" aria-labelledby="omnitime-grp-${gi}"><div class="omnitime-search__group" id="omnitime-grp-${gi}">${esc(g.title)}</div>${items}</div>`
          : items;
      }).join('');
      showResults(html);
      options = flat;
      searchResults.querySelectorAll('.omnitime-search__item').forEach((b) => {
        b.addEventListener('click', () => pick(options[parseInt(b.dataset.idx, 10)]));
      });
      searchResults.querySelectorAll('.omnitime-search__star').forEach((b) => {
        const o = options[parseInt(b.dataset.starIdx, 10)];
        paintStar(b, o.label);
        b.addEventListener('click', () => toggleStar(o.raw));
      });
    };
    const showMessage = (text) => showResults(`<div class="omnitime-search__empty" role="option" aria-disabled="true" aria-selected="false">${esc(text)}</div>`);

    // Empty query: starred issues, recently booked ones, then the API's
    // frequent ones (each issue once, in the first group it appears in).
    const showRecent = () => {
      clearTimeout(searchTimer);
      const seq = ++searchSeq;
      Promise.all([loadRecentIssues(), bookmarks ? bookmarks.load() : []]).then(([recentAll]) => {
        if (seq !== searchSeq || searchInput.value.trim()) return;
        const groups = emptyQueryGroups(bookmarks && bookmarks.isReady() ? bookmarks.items() : [], recentAll, ctx.state.frequent);
        if (!groups.length) { hideResults(); return; }
        showOptions(groups);
      });
    };

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      setChoosing(true);
      const q = searchInput.value.trim();
      if (q !== autoQuery) prefillTouched = true;
      if (!q) { showRecent(); return; }
      if (q.length < 2) { hideResults(); return; }
      const seq = ++searchSeq;
      searchTimer = setTimeout(() => {
        ctx.apiClient.search(q).then((res) => {
          if (seq !== searchSeq) return; // a newer query (or closing) superseded this one
          const issues = (res && res.issues) || [];
          if (!issues.length) { showMessage('No matches'); return; }
          showOptions([{ items: issues.map(searchOption) }]);
        }).catch(() => {
          if (seq !== searchSeq) return;
          showMessage('Search unavailable');
        });
      }, 150);
    });
    // Keep the focus in the input while the list is clicked (a blur would
    // close the list before the click lands).
    searchResults.addEventListener('mousedown', (ev) => ev.preventDefault());
    searchInput.addEventListener('focus', () => { setChoosing(true); if (!searchInput.value.trim()) showRecent(); });
    changeBtn.addEventListener('click', () => {
      setChoosing(true);
      searchInput.focus();
    });
    searchInput.addEventListener('click', () => { if (searchResults.hidden && !searchInput.value.trim()) showRecent(); });
    searchWrap.addEventListener('focusout', (ev) => {
      if (ev.relatedTarget && searchWrap.contains(ev.relatedTarget)) return;
      hideResults();
      // Nothing typed, nothing picked: back to the one-line target.
      if (!searchInput.value.trim()) setChoosing(false);
    });
    searchInput.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      const open = !searchResults.hidden && options.length > 0;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!open) {
          if (ev.key === 'ArrowDown' && !searchInput.value.trim()) { ev.preventDefault(); showRecent(); }
          return;
        }
        ev.preventDefault();
        const n = options.length;
        setActive(ev.key === 'ArrowDown' ? (activeIdx + 1) % n : (activeIdx <= 0 ? n - 1 : activeIdx - 1));
      } else if (ev.key === 'Enter') {
        // Never a save from the search box: it picks the highlighted result.
        ev.preventDefault();
        if (open && activeIdx >= 0) pick(options[activeIdx]);
      }
    });

    // Frequent issues are listed by the empty search (see showRecent).
    if (!ctx.state.frequent) {
      ctx.apiClient.frequent().then((res) => {
        ctx.state.frequent = (res && res.issues) || [];
      }).catch(() => { /* the list just stays out */ });
    }

    // After a successful save: reload the viewed day. An entry saved on
    // another day leaves the view where it is and says where it went.
    const goToDay = (date) => {
      if (ctx.goToDay) { ctx.goToDay(date); return; }
      ctx.state.date = date;
      ctx.reload();
    };
    const afterSave = (date) => {
      const viewed = ctx.state.date;
      // Quiet: no busy state, scroll and focus stay.
      if (ctx.refresh) ctx.refresh({ force: true }); else ctx.reload();
      if (date !== viewed && ctx.ui && ctx.ui.toast) {
        ctx.ui.toast(`Saved on ${shortDate(date)}`, { actionLabel: 'Go to day', onAction: () => goToDay(date) });
      }
    };

    // The issue this entry is booked against, as stored in the recent list.
    const recentItemFor = (tgt) => {
      if (tgt.mode === 'current') return { source: context.source, project_id: context.project_id, issue_id: context.issue_id, label: issueLabel };
      if (tgt.ext) return { source: tgt.ext.source, project_id: tgt.ext.project_id, issue_id: tgt.ext.issue_id, label: tgt.label };
      return { issue_id: tgt.issueInternalId, label: tgt.label };
    };

    function save() {
      if (saveBtn.disabled) return;
      clearError();
      const d = checkDur();
      const s = checkStart();
      const dt = checkDate();
      const bad = [[d, durInput], [s, startInput], [dt, dateInput]].find(([r]) => r.error);
      if (bad) { updateWhen(); bad[1].focus(); return; }
      const dur = d.minutes;
      const start = s.text;
      const date = dt.date;

      // Edit mode: update the existing entry (issue stays locked). Optimistic:
      // the day shows the change at once, "Saved · Undo" PATCHes the previous
      // values back (date included); a failure rolls back with a toast.
      if (editing) {
        const other = date !== ctx.state.date;
        // Close the form first: a form that is still open makes the ops stage
        // the change instead of drawing it (see createDayOps.show).
        if (ctrl.setFormOpen) ctrl.setFormOpen(false);
        ctx.ops.update(editing, {
          date,
          start_time: start || undefined,
          duration: dur,
          comment: commentInput.value.trim(),
        }, {
          toast: other ? `Saved on ${shortDate(date)}` : 'Saved',
          what: 'save the entry',
          actions: other ? [{ label: 'Go to day', onAction: () => goToDay(date) }] : [],
        });
        return;
      }

      const payload = entryPayload(date, start, dur, commentInput.value);
      if (target.mode === 'none') {
        setError('Select an open issue to track time for.');
        return;
      }
      if (target.mode === 'current') {
        if (!context.source || !context.project_id || !context.issue_id) {
          setError('No current issue detected - search for one.');
          return;
        }
        payload.source = context.source;
        payload.project_id = context.project_id;
        payload.issue_id = context.issue_id;
      } else if (target.ext) {
        payload.source = target.ext.source;
        payload.project_id = target.ext.project_id;
        payload.issue_id = target.ext.issue_id;
      } else {
        payload.issue_internal_id = target.issueInternalId;
      }
      const tgt = { ...target };
      saveBtn.disabled = true;
      setMsg('Saving…', false);
      ctx.apiClient.create(payload).then((created) => {
        // Link the event to its booking, and remember an explicitly picked
        // issue (with the event's title) for the next occurrence of the same
        // (recurring) event.
        const cal = pendingCal;
        const tasks = [rememberRecentIssue(recentItemFor(tgt))];
        if (cal) {
          tasks.push(recordCalBooking(cal, created ? created.id : null, date,
            tgt.mode === 'issue' && tgt.issueInternalId ? { id: tgt.issueInternalId, label: tgt.label } : null));
        }
        Promise.all(tasks.map((t) => Promise.resolve(t).catch(() => {}))).then(() => afterSave(date));
      }).catch((err) => {
        saveBtn.disabled = false;
        setError(isUnavailable(err) ? 'Saving needs the updated API on the server.' : opErrorText('save the entry', err));
      });
    }
    // Pressing Save must not blur the field first: an error appearing on that
    // blur would push the button away from under the pointer and lose the
    // click. So the focused field is committed by the click itself.
    saveBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    saveBtn.addEventListener('click', () => {
      const focused = formEl.getRootNode().activeElement;
      if (focused === durInput || focused === startInput || focused === dateInput) fieldChanged(focused);
      save();
    });

    // Enter in start / duration / date saves; in the comment (a textarea,
    // where Enter is a newline) Ctrl/Cmd+Enter does. The search box handles
    // its own Enter, buttons keep theirs.
    formEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || ev.defaultPrevented) return;
      const t = ev.target;
      if (t === commentInput) {
        if (!(ev.ctrlKey || ev.metaKey)) return;
      } else if (t !== durInput && t !== startInput && t !== dateInput) {
        return;
      }
      ev.preventDefault();
      if (t !== commentInput) fieldChanged(t); // what leaving the field would have done
      save();
    });

    function resetDel() {
      delBtn.disabled = false;
    }

    // Delete (edit mode only): at once, with "Entry deleted · Undo" (see
    // createDayOps) instead of a confirm step.
    delBtn.addEventListener('click', () => {
      if (!editing) return;
      if (ctrl.setFormOpen) ctrl.setFormOpen(false); // see save(): the change must draw at once
      ctx.ops.remove(editing, { undo: true });
    });

    function setMsg(text, isErr) {
      msgEl.textContent = text;
      msgEl.className = 'omnitime-form__msg' + (isErr ? ' omnitime-form__msg--err' : '');
    }
    // Prominent error banner at the top of the form (hard to miss).
    function setError(text) {
      alertEl.innerHTML = `${icon('alert')}<span></span>`;
      alertEl.querySelector('span').textContent = text;
      alertEl.hidden = false;
      setMsg('', false);
      alertEl.scrollIntoView({ block: 'nearest' });
    }
    function clearError() {
      alertEl.hidden = true;
      alertEl.textContent = '';
    }

    return {
      el: formEl,
      cancel,
      // Open in create mode (current-issue default, search + chips available).
      reveal: () => {
        editing = null;
        pendingCal = null;
        formSugg = [];
        renderSugg();
        formEl.classList.remove('omnitime-form--edit');
        titleEl.textContent = 'New entry';
        saveBtn.textContent = 'Save entry';
        resetDel();
        dateInput.value = ctx.state.date || todayStr();
        clearFieldErrors();
        updateWhen();
        // Don't default to a closed current issue - require an open pick.
        setTarget(currentIssueClosed() ? 'none' : 'current', null, issueLabel);
        if (ctrl.setFormOpen) ctrl.setFormOpen(true);
        growComment();
        // If the issue's open/closed state isn't known yet (the "This issue"
        // fetch may not have resolved), resolve it now and flip to the closed
        // warning reactively - removes the tab-order/timing race.
        if (context.issueOpen === undefined && context.source && context.project_id && context.issue_id) {
          ctx.apiClient.issueTime(context).then((d) => {
            if (d && d.issue && typeof d.issue.open === 'boolean') {
              context.issueOpen = d.issue.open;
            }
            if (!editing && context.issueOpen === false && target.mode === 'current') {
              setTarget('none', null, '');
            }
          }).catch(() => { });
        }
      },
      // Open in edit mode bound to an existing (unbooked) entry; issue locked.
      editEntry: (entry) => {
        editing = entry;
        pendingCal = null;
        formSugg = [];
        renderSugg();
        if (ctrl.clearSelection) ctrl.clearSelection();
        formEl.classList.add('omnitime-form--edit');
        titleEl.textContent = 'Edit entry';
        saveBtn.textContent = 'Save';
        resetDel();
        setTarget('issue', entry.issue_internal_id, entryIssueText({ ...entry, issue_label: entry.issue_label || 'issue' }), null, null, entry.project);
        startInput.value = entry.start || '';
        durInput.value = fmtDur(entry.duration_minutes || 0);
        dateInput.value = ctx.state.date;
        commentInput.value = entry.comment || '';
        clearFieldErrors();
        refreshDerived();
        updateWhen();
        if (ctrl.setFormOpen) ctrl.setFormOpen(true);
        growComment();
      },
      // Pre-fill from a calendar event click: auto-search.
      // Note: time is set externally by setSelection() to snap to free gaps.
      calendarPrefill: (calEvent, fromCal = true) => {
        editing = null;
        formEl.classList.remove('omnitime-form--edit');
        titleEl.textContent = 'New entry';
        saveBtn.textContent = 'Save entry';
        resetDel();
        pendingCal = calEvent;
        dateInput.value = ctx.state.date || todayStr();
        updateWhen();
        setTarget(currentIssueClosed() ? 'none' : 'current', null, issueLabel);
        commentInput.value = calEvent.title || '';
        if (ctrl.setFormOpen) ctrl.setFormOpen(true);
        growComment();

        // Preselect the issue this event was last booked on (local memory, at
        // once); the server's suggestions (cached per modal open) then replace
        // that unless the user already chose something. Without a preselection
        // the cleaned calendar title is searched.
        const entry = ((ctx.state.calMemory || {}).issues || {})[calSeriesKey(calEvent)];
        prefillTouched = false;
        autoQuery = '';
        const apply = (r) => {
          formSugg = r.suggestions.slice();
          renderSugg();
          if (!r.preselected) return false;
          setTarget('issue', r.preselected.id, bookIssueLabel(r.preselected), null, bookIssueRaw(r.preselected));
          kickerText = r.from === 'server' ? 'Suggested for this meeting' : 'Remembered for this meeting';
          renderTarget();
          searchInput.value = '';
          hideResults();
          return true;
        };
        const hasLocal = apply(resolveBookingSuggestions(null, entry));
        const startMin = calEvent.originalStart != null ? calEvent.originalStart : calEvent.start;
        if (Number.isFinite(startMin) && calEvent.title) {
          const cache = ctx.state.bookingCache || (ctx.state.bookingCache = new Map());
          loadBookingSuggestions(ctx.apiClient, cache, calEvent.title, fmtClock(startMin), ctx.state.date).then((server) => {
            if (!server || pendingCal !== calEvent || prefillTouched || !formEl.isConnected) return;
            apply(resolveBookingSuggestions(server, entry));
          });
        }
        if (hasLocal) return;
        const Cal = window.OmniTimeCal;
        const q = Cal ? Cal.cleanTitle(calEvent.title) : calEvent.title;
        if (q) {
          autoQuery = q.trim();
          searchInput.value = q;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      isEditing: () => editing != null,
      setTime: (startStr, dur) => {
        startInput.value = startStr;
        durInput.value = fmtDur(dur);
        showFieldError(durInput, durErr, null, endEl.id);
        showFieldError(startInput, startErr, null);
        refreshDerived();
        updateWhen();
      },
      // The timeline placed the typed time differently (it had to fit the
      // free gap): a note after the end time, cleared by the next refreshDerived().
      noteClamp: (start, dur, wanted) => {
        const note = dur < wanted ? ` \u00b7 only ${fmtDur(dur)} free here` : ` \u00b7 moved to ${fmtClock(start)} to fit`;
        endEl.appendChild(document.createTextNode(note));
      },
      onTimeEdit: (cb) => { timeEditCb = cb; },
    };
  }

  // --- Optimistic entry changes (My day) ---
  // Every move / resize / edit / delete / duplicate is shown at once from the
  // local copy of the day, then sent; a quiet background reload reconciles
  // with the server afterwards (no busy state; scroll and focus stay). On
  // failure the local change is rolled back and a toast says why (Retry).
  //
  // - Requests for the same entry run one after another (per-entry queue),
  //   so e.g. an Undo can't overtake the change it undoes.
  // - New entries get a temporary id until the POST answers; later requests
  //   for them resolve it to the server id (idMap). An Undo of a delete
  //   re-creates the entry (new id) and moves calendar links to it.
  // - Totals: the day total, the week strip cell(s) and the week total move
  //   with every local change, and today's total is reported (onDayTotal).
  //
  // env: { apiClient, state, ui, shown(), alive(), render(data),
  //        reportDayTotal(date, data), reload(), isBusy(), stage(data) }
  const RECONCILE_DELAY = 150;
  const UNDO_TIMEOUT = 8000;
  const SKIP = {}; // a request that turned out unnecessary (not a failure)

  // Comparable view of a day: what the timeline and the totals show.
  function daySignature(data) {
    if (!data) return '';
    const entries = (data.entries || []).map((e) => [String(e.id), e.start || '', Number(e.duration_minutes) || 0,
      e.comment || '', !!e.editable, e.status || '', e.issue_internal_id == null ? '' : String(e.issue_internal_id)].join('|')).sort();
    const week = (data.week || []).map((c) => `${c.date}=${Number(c.total_minutes) || 0}`);
    return JSON.stringify([data.date, entries, Number(data.day_total_minutes) || 0, week]);
  }

  // Why an operation failed: the server's own message for a rejected request
  // (e.g. a closed issue), otherwise the friendly text by cause.
  function errorReason(err) {
    const status = err && err.status;
    const detail = sanitizeMessage(err && (err.message || err));
    return (status === 400 || status === 409 || status === 422) && detail ? detail : friendlyErrorText(err);
  }
  function opErrorText(what, err) {
    return `Couldn't ${what}. ${errorReason(err)}`;
  }

  function createDayOps(env) {
    const { apiClient, state } = env;
    const ui = env.ui || {};
    const idMap = new Map();   // temporary/old id -> server id
    const rootOf = new Map();  // server id -> the id it replaced (queue key)
    const queues = new Map();  // queue key -> tail of its request chain
    const pending = new Map(); // queue key -> number of unsettled requests
    let inflight = 0;
    let tempSeq = 0;
    let refreshTimer = null;
    let refreshGen = 0;
    let stale = false;
    // Data that was changed while the user is busy (form open, dragging) is
    // staged - totals move, the timeline and the form stay untouched - and
    // drawn when they are done (idle). Rebuilding the view would close the
    // form and lose the draft.
    let staged = false;
    function show(data) {
      if (env.isBusy && env.isBusy()) { if (env.stage) env.stage(data); staged = true; }
      else { staged = false; env.render(data); }
    }

    const realId = (id) => {
      let x = id;
      for (let i = 0; i < 20 && idMap.has(String(x)); i++) x = idMap.get(String(x));
      return x;
    };
    const sameId = (a, b) => String(realId(a)) === String(realId(b));
    // A copy whose POST never succeeded: nothing to PATCH/DELETE on the server.
    const isTemp = (id) => /^tmp-/.test(String(id));
    const keyOf = (id) => {
      let x = String(realId(id));
      for (let i = 0; i < 20 && rootOf.has(x); i++) x = rootOf.get(x);
      return x;
    };
    const durOf = (entry) => Number(entry && entry.duration_minutes) || 0;
    const sum = (entries) => (entries || []).reduce((s, e) => s + durOf(e), 0);
    const toast = (msg, opts) => (ui.toast ? ui.toast(msg, opts) : () => {});
    const findShown = (id) => {
      const data = env.shown();
      return data ? (data.entries || []).find((x) => sameId(x.id, id)) || null : null;
    };

    // Add `minutes` to a date's totals in `data` (the day total only for
    // the viewed date; the week strip when the date is in it).
    function bump(data, date, minutes, viewed, base) {
      if (!minutes) return;
      if (viewed) {
        const day = Number(data.day_total_minutes);
        data.day_total_minutes = Math.max(0, (data.day_total_minutes != null && Number.isFinite(day) ? day : base) + minutes);
        data.day_total_label = fmtDur(data.day_total_minutes);
      }
      const cell = (data.week || []).find((c) => c.date === date);
      if (!cell) return;
      cell.total_minutes = Math.max(0, (Number(cell.total_minutes) || 0) + minutes);
      cell.total_label = fmtDur(cell.total_minutes);
      const week = Number(data.week_total_minutes);
      data.week_total_minutes = data.week_total_minutes != null && Number.isFinite(week)
        ? Math.max(0, week + minutes)
        : data.week.reduce((s, c) => s + (Number(c.total_minutes) || 0), 0);
      data.week_total_label = fmtDur(data.week_total_minutes);
    }

    // Apply fn(data, other) to a copy of the shown day, fix the totals and
    // re-render. `other[date]` collects minutes that moved to/from other days.
    function change(fn) {
      const cur = env.shown();
      if (!cur || !env.alive()) return;
      const data = { ...cur, entries: (cur.entries || []).map((x) => ({ ...x })), week: (cur.week || []).map((c) => ({ ...c })) };
      const date = data.date || state.date;
      const other = {};
      const before = sum(data.entries);
      fn(data, other, date);
      bump(data, date, sum(data.entries) - before, true, before);
      Object.keys(other).forEach((d) => bump(data, d, other[d], false));
      show(data);
      env.reportDayTotal(date, data);
      // Today is in the strip but another day is viewed: its cell knows.
      const today = todayStr();
      const cell = other[today] && date !== today && (data.week || []).find((c) => c.date === today);
      if (cell && state.onDayTotal) {
        try { state.onDayTotal(today, cell.total_minutes); } catch (e) { /* best effort */ }
      }
    }

    // Move an entry between placements { entry, date } (null = absent).
    function put(data, other, date, from, to) {
      if (from) {
        if (from.date === date) data.entries = data.entries.filter((x) => !sameId(x.id, from.entry.id));
        else other[from.date] = (other[from.date] || 0) - durOf(from.entry);
      }
      if (to) {
        if (to.date === date) {
          data.entries = data.entries.filter((x) => !sameId(x.id, to.entry.id));
          data.entries.push({ ...to.entry });
          data.entries.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
        } else {
          other[to.date] = (other[to.date] || 0) + durOf(to.entry);
        }
      }
    }

    // The entry with a PATCH payload applied (start/stop/duration/comment).
    function patched(entry, patch) {
      const next = { ...entry };
      if (patch.start_time !== undefined) next.start = patch.start_time;
      if (patch.duration !== undefined) {
        next.duration_minutes = patch.duration;
        next.duration_label = fmtDur(patch.duration);
      }
      const s = parseClock(next.start);
      if (s != null) next.stop = fmtClock(s + durOf(next));
      if (patch.comment !== undefined) next.comment = patch.comment;
      return next;
    }

    // Refresh the "pending" look of the rendered entries.
    function syncPending() {
      const grid = ui.root && ui.root.querySelector('.omnitime-tl');
      if (!grid) return;
      grid.querySelectorAll('.omnitime-tl__entry[data-key^="entry:"]').forEach((el) => {
        const on = isPending(el.dataset.key.slice(6));
        el.classList.toggle('omnitime-tl__entry--pending', on);
        if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
      });
    }
    const isPending = (id) => pending.has(keyOf(id));

    // Run `request(serverId)` after the earlier requests for the same entry.
    function serial(id, request) {
      const key = keyOf(id);
      const prev = queues.get(key) || Promise.resolve();
      const run = prev.then(() => request(realId(id)));
      const tail = run.catch(() => {});
      queues.set(key, tail);
      pending.set(key, (pending.get(key) || 0) + 1);
      inflight++;
      clearTimeout(refreshTimer);
      tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
        const n = pending.get(key) - 1;
        if (n > 0) pending.set(key, n); else pending.delete(key);
        inflight--;
        syncPending();
        if (!inflight) scheduleRefresh();
      });
      return run;
    }

    // One optimistic operation: apply now, request in turn, roll back and
    // tell (with Retry) on failure. Resolves true on success.
    function op({ id, apply, revert, request, what, retry }) {
      change(apply);
      syncPending();
      return serial(id, request).then((res) => res !== SKIP, (err) => {
        if (window.omniDebugMode) console.warn('OmniTime: ' + what + ' failed:', err);
        change(revert);
        toast(opErrorText(what, err), { tone: 'error', timeout: UNDO_TIMEOUT, actionLabel: retry ? 'Retry' : null, onAction: retry });
        return false;
      });
    }

    // A created entry got its server id: map the temporary one, rename it in
    // the shown day and, for a re-created entry, move its calendar links.
    function adopt(tempId, created, date, payload, relink) {
      const known = (id) => id != null ? Promise.resolve(id) : apiClient.myDay(date).then((d) => {
        // No id in the POST answer: find the new entry in the day.
        const ids = new Set(((env.shown() && env.shown().entries) || []).map((x) => String(realId(x.id))));
        const match = ((d && d.entries) || []).filter((x) => !ids.has(String(x.id)) && x.start === payload.start_time
          && durOf(x) === payload.duration && String(x.issue_internal_id) === String(payload.issue_internal_id));
        return match.length ? match[match.length - 1].id : null;
      }).catch(() => null);
      return known(created && created.id).then((id) => {
        if (id == null) return;
        idMap.set(String(tempId), id);
        rootOf.set(String(id), String(tempId));
        if (state.refocus === 'entry:' + tempId) state.refocus = 'entry:' + id;
        const fix = (links) => Object.values(links || {}).forEach((l) => { if (l && String(l.entryId) === String(tempId)) l.entryId = id; });
        // Links first: the re-render below must keep the event hidden.
        if (relink && state.calMemory) fix(state.calMemory.links);
        if (findShown(tempId)) {
          change((data) => data.entries.forEach((x) => { if (String(x.id) === String(tempId)) x.id = id; }));
        }
        if (!relink) return;
        return Promise.resolve(updateCalMemory((mem) => fix(mem.links))).catch(() => {});
      });
    }

    // Create `entry` (shown under its temporary id) on `date` via POST.
    function create(entry, date, payload, opts) {
      const to = { entry, date };
      return op({
        id: entry.id,
        what: opts.what,
        apply: (data, other, d) => put(data, other, d, null, to),
        revert: (data, other, d) => put(data, other, d, to, null),
        request: () => (opts.after || Promise.resolve(true)).then((ok) => (ok
          ? apiClient.create(payload).then((created) => adopt(entry.id, created, date, payload, opts.relink))
          : SKIP)),
        retry: () => create(entry, date, payload, opts),
      });
    }

    // The POST payload that books `entry` again on `date`.
    const createPayload = (entry, date, start) => ({
      issue_internal_id: entry.issue_internal_id,
      date,
      start_time: start || entry.start || undefined,
      duration: durOf(entry),
      comment: entry.comment ? String(entry.comment) : undefined,
    });

    const api = {
      isPending,
      // A timeline data-key with a temporary id mapped to the server id.
      mapKey: (key) => {
        const m = /^entry:(.+)$/.exec(String(key || ''));
        return m && idMap.has(m[1]) ? 'entry:' + realId(m[1]) : key;
      },

      // PATCH `raw` (the entry as shown, or opts.entry when it lives on
      // another day, e.g. an Undo of a date change). opts: { toast, what,
      // actions, fromDate, entry, silent }. The toast offers an Undo that
      // PATCHes the previous values of the changed fields back.
      update(raw, patch, opts) {
        opts = opts || {};
        const cur = findShown(raw.id) || opts.entry;
        const viewed = (env.shown() && env.shown().date) || state.date;
        if (!cur) return Promise.resolve(false);
        const fromDate = opts.fromDate || viewed;
        const from = { entry: cur, date: fromDate };
        const to = { entry: patched(cur, patch), date: patch.date || fromDate };
        const undo = {};
        if (patch.date !== undefined) undo.date = fromDate;
        if (patch.start_time !== undefined) undo.start_time = cur.start || undefined;
        if (patch.duration !== undefined) undo.duration = durOf(cur);
        if (patch.comment !== undefined) undo.comment = cur.comment || '';
        const done = op({
          id: cur.id,
          what: opts.what || 'save the entry',
          apply: (data, other, d) => put(data, other, d, from, to),
          revert: (data, other, d) => put(data, other, d, to, from),
          request: (id) => (isTemp(id) ? SKIP : apiClient.update(id, patch)),
          retry: () => api.update(cur, patch, { ...opts, entry: cur, fromDate }),
        });
        if (opts.toast) {
          toast(opts.toast, {
            timeout: UNDO_TIMEOUT,
            actionLabel: 'Undo',
            onAction: () => api.update(to.entry, undo, { entry: to.entry, fromDate: to.date, what: 'undo the change' }),
            actions: opts.actions,
          });
        }
        return done;
      },

      // DELETE at once; opts.undo: "Entry deleted · Undo" re-creates it with
      // the same date/start/duration/comment/issue (a new id).
      remove(raw, opts) {
        opts = opts || {};
        const cur = findShown(raw.id);
        if (!cur) return Promise.resolve(false);
        const date = (env.shown() && env.shown().date) || state.date;
        const from = { entry: cur, date };
        const done = op({
          id: cur.id,
          what: 'delete the entry',
          apply: (data, other, d) => put(data, other, d, from, null),
          revert: (data, other, d) => put(data, other, d, null, from),
          request: (id) => (isTemp(id) ? SKIP : apiClient.remove(id)),
          retry: () => api.remove(cur, opts),
        });
        if (opts.undo) {
          const canRestore = cur.issue_internal_id != null && cur.issue_internal_id !== '';
          toast('Entry deleted', canRestore ? {
            timeout: UNDO_TIMEOUT,
            actionLabel: 'Undo',
            // The old id stands in until the POST answers (calendar links
            // keep pointing at it meanwhile); only re-create what was deleted.
            onAction: () => create({ ...cur }, date, createPayload(cur, date), { what: 'restore the entry', relink: true, after: done }),
          } : {});
        }
        return done;
      },

      // A copy of an editable entry starting at `start` (minutes) on the
      // viewed day; opts.focus moves the focus to it. Undo deletes the copy.
      duplicate(raw, start, opts) {
        opts = opts || {};
        const cur = findShown(raw.id);
        if (!cur) return Promise.resolve(false);
        const dur = durOf(cur);
        if (cur.issue_internal_id == null || cur.issue_internal_id === '') {
          toast("This entry can't be copied: its issue is unknown.", { tone: 'error' });
          return Promise.resolve(false);
        }
        if (start + dur > 24 * 60) {
          toast("No room for a copy after this entry today.", { tone: 'error' });
          return Promise.resolve(false);
        }
        const date = (env.shown() && env.shown().date) || state.date;
        const copy = {
          ...cur,
          id: 'tmp-' + (++tempSeq),
          start: fmtClock(start),
          stop: fmtClock(start + dur),
          status: 'unbooked',
          editable: true,
          active: false,
        };
        if (opts.focus) state.refocus = 'entry:' + copy.id;
        const done = create(copy, date, createPayload(cur, date, copy.start), { what: 'copy the entry' });
        toast(`Copied to ${copy.start}`, {
          timeout: UNDO_TIMEOUT,
          actionLabel: 'Undo',
          onAction: () => done.then((ok) => ok && api.remove(copy)),
        });
        return done;
      },

      // Quiet reload of the viewed day. Re-renders only when the server
      // differs from what is shown, and not while the user is busy (form
      // open, dragging): then later (idle). opts.force: always render now.
      refresh(opts) {
        opts = opts || {};
        clearTimeout(refreshTimer);
        const gen = ++refreshGen;
        const date = state.date;
        // The calendar memory too: a booking made from a calendar event links
        // it, and the event must hide on this render.
        return Promise.all([apiClient.myDay(date), loadCalMemory()]).then(([data, calMemory]) => {
          if (gen !== refreshGen || !env.alive() || state.date !== date) return;
          state.calMemory = calMemory;
          if (inflight && !opts.force) return; // the last request reconciles
          const same = daySignature(data) === daySignature(env.shown());
          // Staged data was never drawn: once the user is done, draw it even when it matches.
          if (!opts.force && same && !(staged && !env.isBusy())) { stale = false; return; }
          if (!opts.force && env.isBusy()) { stale = true; return; }
          stale = false;
          staged = false;
          env.render(data);
          env.reportDayTotal(date, data);
        }).catch((err) => {
          if (window.omniDebugMode) console.warn('OmniTime: reconcile failed:', err);
          if (opts.force && gen === refreshGen) env.reload();
        });
      },
      // The user is done (form closed): run a reconcile that had to wait.
      idle() {
        if (staged && !(env.isBusy && env.isBusy())) { staged = false; env.render(env.shown()); }
        if (stale && !inflight) api.refresh();
      },
    };
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (env.alive()) api.refresh(); }, RECONCILE_DELAY);
    }
    return api;
  }

  // --- Keyboard shortcuts (My day) ---
  // Only while the modal is open and focus is inside it (the listener sits
  // on the shadow root, so the host page never loses a key), never in text
  // fields, never with Ctrl/Cmd/Alt, and never for keys a control inside
  // already handled (defaultPrevented). Returns the unbind function.
  const isTextField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
  function bindMyDayShortcuts(ui, layout, act) {
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!ui.isOpen() || !layout.isConnected) return;
      const target = (e.composedPath && e.composedPath()[0]) || e.target;
      if (isTextField(target)) return;
      const k = e.key;
      const arrowsOwned = target && target.closest && target.closest('[role="tablist"], [role="menu"], [role="listbox"], [role="slider"], [role="radiogroup"]');
      let fn = null;
      if (k === 'n' || k === 'N') fn = act.newEntry;
      else if (k === 't' || k === 'T') fn = act.today;
      else if (k === '?') fn = act.help;
      else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !e.shiftKey && !arrowsOwned) fn = k === 'ArrowLeft' ? act.prev : act.next;
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      if (fn !== act.help) closeShortcutHelp(ui);
      fn();
    };
    ui.root.addEventListener('keydown', onKey);
    return () => ui.root.removeEventListener('keydown', onKey);
  }

  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
  function shortcutGroups() {
    const mod = IS_MAC ? '⌘' : 'Ctrl';
    const alt = IS_MAC ? '⌥' : 'Alt';
    return [
      ['My day', [
        [['N'], 'New entry at the next free slot'],
        [['←/→'], 'Previous / next day'],
        [['T'], 'Today'],
        [['?'], 'Show these shortcuts'],
      ]],
      ['Focused timeline entry', [
        [['Enter'], 'Edit the entry (or track a calendar event)'],
        [[alt, '↑/↓'], 'Move by 5 minutes'],
        [[alt, 'Shift', '↑/↓'], 'Change the end by 5 minutes'],
        [[mod, 'D'], 'Duplicate right after it'],
        [[alt + '-drag'], 'Copy to where it is dropped' + (IS_MAC ? '' : ' (or Ctrl-drag)')],
        [['Delete'], 'Hide a calendar event'],
      ]],
      ['Entry form', [
        [['Enter'], 'Save (in start, duration or date)'],
        [[mod, 'Enter'], 'Save from the comment'],
        [['Esc'], 'Close the form'],
      ]],
    ];
  }

  function closeShortcutHelp(ui) {
    const pop = ui && ui.layer && ui.layer.querySelector('.omnitime-keys');
    if (pop && pop._close) pop._close(false);
  }

  // The shortcuts popover (ui.layer, an Escape layer), under `anchor` (the
  // nav's "?" button). A second call closes it; so do Escape, the close
  // button and a click elsewhere. Focus moves in and comes back on close.
  function toggleShortcutHelp(ui, anchor) {
    const open = ui.layer.querySelector('.omnitime-keys');
    if (open) { open._close(true); return; }
    const prevFocus = ui.root.activeElement;
    const pop = elem('div', 'omnitime-keys');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'omnitime-keys-title');
    pop.tabIndex = -1;
    const keys = (list) => list.map((k) => `<kbd class="omnitime-keys__kbd">${esc(k)}</kbd>`).join('<span class="omnitime-keys__plus">+</span>');
    pop.innerHTML = `
      <div class="omnitime-keys__head">
        <strong class="omnitime-keys__title" id="omnitime-keys-title">Keyboard shortcuts</strong>
        <button class="omnitime-keys__close" type="button" aria-label="Close">${icon('close')}</button>
      </div>
      ${shortcutGroups().map(([title, rows]) => `
        <div class="omnitime-keys__group">
          <div class="omnitime-keys__grouptitle">${esc(title)}</div>
          <dl class="omnitime-keys__list">
            ${rows.map(([k, label]) => `<div class="omnitime-keys__row"><dt>${keys(k)}</dt><dd>${esc(label)}</dd></div>`).join('')}
          </dl>
        </div>`).join('')}`;
    ui.layer.appendChild(pop);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');

    // Below the anchor, right-aligned to it, inside the viewport.
    const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    const w = pop.offsetWidth || 320;
    const h = pop.offsetHeight || 0;
    let left = r ? r.right - w : (window.innerWidth - w) / 2;
    let top = r ? r.bottom + 6 : 60;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    if (h && top + h > window.innerHeight - 10) top = Math.max(10, window.innerHeight - h - 10);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    const onDown = (ev) => {
      const t = (ev.composedPath && ev.composedPath()[0]) || ev.target;
      if (pop.contains(t) || (anchor && anchor.contains(t))) return;
      close(false);
    };
    let popLayer = null;
    function close(restore) {
      if (!pop.isConnected) return;
      pop.remove();
      if (popLayer) popLayer();
      ui.root.removeEventListener('pointerdown', onDown, true);
      if (anchor) anchor.setAttribute('aria-expanded', 'false');
      if (restore && prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    }
    pop._close = close;
    popLayer = ui.pushEscape(() => close(true), pop);
    ui.root.addEventListener('pointerdown', onDown, true);
    pop.querySelector('.omnitime-keys__close').addEventListener('click', () => close(true));
    pop.focus();
  }

  // __resetCapability lets the dev harness re-probe when toggling "old API";
  // production never calls it, so detection stays cached per page load.
  window.OmniTime = {
    createApiClient,
    // openModal({ apiClient, context, settings, activeTab, icalUrl, theme,
    //   settingsUrl, onSettingsClosed }) -> { overlay, cleanup, ui, applySettings }.
    // settingsUrl (string | () => string) adds the gear + embedded settings panel.
    openModal,
    // openNotice({ title, html, theme, settingsUrl, onSettingsClosed }) - simple
    // message dialog, same shell (with settingsUrl: gear + "Open settings").
    openNotice,
    // The settings panel of the open dialog: closeSettings() answers an Escape
    // pressed inside its frame (OMNI_SETTINGS_CLOSE); both return whether
    // anything changed.
    openSettings: () => !!(current && current.settings && current.settings.open()),
    closeSettings: () => !!(current && current.settings && current.settings.close()),
    // The settings the open views depend on, and whether two snapshots of them
    // differ (the glue refreshes the view after the settings panel changed any).
    SETTINGS_WATCHED,
    settingsDiffer,
    // An API client whose implementation can be replaced while views hold on
    // to it (the API URL changed in the settings): { client, swap(next) }.
    swappableClient: createSwappableClient,
    // Stylesheet text for the shadow root; call before the first open.
    setStyles,
    hasStyles: () => !!styleText,
    // The open dialog (any kind): state, programmatic close, its shadow root.
    isOpen: () => !!current,
    close: () => { if (current) current.close(); },
    getRoot: () => (current ? current.root : null),
    // Form input parsers (pure), exposed for the tests.
    parseDuration,
    parseStartTime,
    // Week math + grouping (pure), exposed for the tests.
    weekMonday,
    isoWeek,
    groupWeek,
    renderError,
    // Day helpers (pure): dayTarget(date, targetMinutes, absence?) -> minutes
    // to work that day (0 on weekends/full absences, half on half days);
    // the rest for the tests.
    dayTarget,
    baseTarget,
    targetProgress,
    prevWorkingDay,
    findGaps,
    bookableMeetings,
    // Booking suggestions (pure), for the tests.
    localBookingSuggestions,
    resolveBookingSuggestions,
    swapSuggestion,
    pickSuggestion,
    __resetCapability: () => { apiCapable = undefined; capabilityProbe = null; },
  };

  // Mounts a small themed widget in the host page (e.g. the GitLab sidebar
  // quick-track widget, sidebar-widget.js): an <omnitime-inline> host appended
  // to `parent`, with the shared stylesheet (setStyles) and tokens in its own
  // shadow root. `opts.css` adds widget-specific rules after the shared ones;
  // `opts.theme` is as for openModal (a function follows GitLab's color mode).
  // Returns { host, root, destroy }. Call setStyles before mounting.
  window.OmniTime.mountInline = function mountInline(parent, opts) {
    opts = opts || {};
    const host = document.createElement('omnitime-inline');
    // `all: initial` on :host (style.css) would reset the display, and its
    // !important beats a plain inline value; an inline !important wins back.
    host.style.setProperty('display', 'block', 'important');
    const root = attachRoot(host);
    adoptStyles(root);
    if (opts.css) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(opts.css);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      } catch (e) {
        const style = document.createElement('style');
        style.textContent = opts.css;
        root.appendChild(style);
      }
    }
    const unbindTheme = bindTheme(host, opts.theme);
    parent.appendChild(host);
    return { host, root, destroy: () => { unbindTheme(); host.remove(); } };
  };
})();
