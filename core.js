// core.js - Transport-agnostic OmniTime UI (modal, tabs, My day timeline,
// new-entry form, frequent chips). No direct chrome.* calls: the production
// glue (content.js) and the dev harness both inject a `transport` function.

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

  // Status codes that mean "the new API is not (yet) available on the server".
  const UNAVAILABLE = [403, 404, 405, 501];

  // --- Helpers ---
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDur = (m) => `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  const fmtClock = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  const parseClock = (s) => {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
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
    plus: '<path d="M12 5v14M5 12h14"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
    chevronRight: '<path d="M9 18l6-6-6-6"/>',
  };
  const icon = (name) => `<svg class="ot-svg ot-svg--${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

  // --- API client ---
  // `urls` may be a string (the tracked-time endpoint, siblings derived) or an
  // object { trackedTime, myDay, frequent, search } with any subset overridden.
  function resolveEndpoints(urls) {
    const cfg = typeof urls === 'string' ? { trackedTime: urls } : (urls || {});
    const tracked = cfg.trackedTime || cfg.apiUrl || '';
    const base = tracked.replace(/\/tracked-time\/?(\?.*)?$/, '');
    return {
      trackedTime: tracked,
      myDay: cfg.myDay || base + '/my-tracked-time',
      frequent: cfg.frequent || base + '/frequent-issues',
      search: cfg.search || base + '/issue-search',
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
    };
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

  // --- Modal scaffold ---
  function openModal(opts) {
    const apiClient = opts.apiClient;
    const context = opts.context || {};

    const existing = document.querySelector('.omnitime-modal-overlay');
    if (existing) existing.remove();

    const overlay = elem('div', 'omnitime-modal-overlay');
    overlay.innerHTML = `
      <div class="omnitime-modal">
        <div class="omnitime-modal-header">
          <div class="omnitime-headerleft"><span class="omnitime-title">Time tracking</span></div>
          <button class="omnitime-modal-close" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="omnitime-modal-content"></div>
      </div>`;
    document.body.appendChild(overlay);

    const content = overlay.querySelector('.omnitime-modal-content');
    const headerLeft = overlay.querySelector('.omnitime-headerleft');

    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.omnitime-modal-close').addEventListener('click', cleanup);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cleanup();
    });

    const myDayState = { date: todayStr(), frequent: null };
    const showIssue = () => {
      content.classList.remove('omnitime-modal-content--myday');
      renderIssueTab(content, apiClient, context);
    };
    const showMyDay = () => {
      content.classList.add('omnitime-modal-content--myday');
      renderMyDayTab(content, apiClient, context, myDayState);
    };

    // Single-view by default - works on the old API (tracked-time only).
    showIssue();

    // Reveal the tab bar only once the new API is detected.
    detectCapability(apiClient).then((capable) => {
      if (!capable || !overlay.isConnected) return;
      headerLeft.innerHTML = `
        <div class="omnitime-tabs">
          <button class="omnitime-tab omnitime-tab--active" data-tab="issue">${icon('users')}<span>This issue</span></button>
          <button class="omnitime-tab" data-tab="myday">${icon('calendar')}<span>My day</span></button>
        </div>`;
      const tabs = headerLeft.querySelectorAll('.omnitime-tab');
      const activate = (name) => {
        tabs.forEach((t) => t.classList.toggle('omnitime-tab--active', t.dataset.tab === name));
        content.innerHTML = '';
        if (name === 'issue') showIssue(); else showMyDay();
      };
      tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));
    });

    return { overlay, cleanup };
  }

  // --- "This issue" tab (read-only aggregate; works with the old API) ---
  function renderIssueTab(root, apiClient, context) {
    root.innerHTML = `<div class="omnitime-loading">${icon('users')} Loading time data&hellip;</div>`;
    apiClient.issueTime(context).then((data) => {
      // Remember whether the current issue is open so the My-day form doesn't
      // pre-select a closed issue (old API omits `issue` → stays undefined).
      if (data && data.issue) context.issueOpen = data.issue.open;
      const entries = (data && data.tracked_time) || [];
      const totalSum = (data && data.total_sum) || 0;
      const details = (data && data.details) || [];

      if (!entries.length && !totalSum) {
        root.innerHTML = '<div class="omnitime-empty">No time tracking data found for this issue.</div>';
        return;
      }

      const rows = entries.map((u) => `<tr><td>${esc(u.user)}</td><td>${fmtDur(u.time_spent)}</td></tr>`).join('');
      let html = `
        <table class="omnitime-table">
          <thead><tr><th>User</th><th>Total time</th></tr></thead>
          <tbody>${rows}<tr class="omnitime-total-row"><td>Total</td><td>${fmtDur(totalSum)}</td></tr></tbody>
        </table>`;
      if (details.length) {
        const drows = details.map((d) => `
          <tr>
            <td>${esc(d.start_time)}</td>
            <td>${esc(d.user)}</td>
            <td>${fmtDur(d.time_spent)}</td>
            <td class="omnitime-comment" title="${esc(stripTags(d.comment))}">${esc(stripTags(d.comment))}</td>
          </tr>`).join('');
        html += `
          <div class="omnitime-details-container">
            <details class="omnitime-details-collapsible">
              <summary>View detailed logs</summary>
              <div class="omnitime-details-scroll">
                <table class="omnitime-table omnitime-details-table">
                  <thead><tr><th>Date</th><th>User</th><th>Time</th><th>Comment</th></tr></thead>
                  <tbody>${drows}</tbody>
                </table>
              </div>
            </details>
          </div>`;
      }
      root.innerHTML = html;
    }).catch((err) => {
      root.innerHTML = `<div class="omnitime-error">Failed to load: ${esc(err.message || err)}</div>`;
    });
  }

  // --- "My day" tab ---
  // The scaffold (week strip + day nav + timeline/form columns + footer) is
  // built once; switching days fetches in the background and swaps only the
  // changed pieces in place, so transitions are seamless (no full re-render).
  function renderMyDayTab(root, apiClient, context, state) {
    root.innerHTML = '';
    const layout = elem('div', 'omnitime-myday');
    const weekWrap = elem('div', 'omnitime-week-wrap');

    const nav = elem('div', 'omnitime-daynav');
    nav.innerHTML = `
      <div class="omnitime-daynav__left">
        <button class="omnitime-daynav__btn" data-nav="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <span class="omnitime-daynav__label"></span>
      </div>
      <button class="omnitime-daynav__btn omnitime-daynav__today" data-nav="today">today</button>
      <button class="omnitime-daynav__btn" data-nav="next" aria-label="Next day">${icon('chevronRight')}</button>`;
    const navLabel = nav.querySelector('.omnitime-daynav__label');
    nav.querySelector('[data-nav="prev"]').addEventListener('click', () => loadDay(addDays(state.date, -1)));
    nav.querySelector('[data-nav="next"]').addEventListener('click', () => loadDay(addDays(state.date, 1)));
    nav.querySelector('[data-nav="today"]').addEventListener('click', () => loadDay(todayStr()));

    const cols = elem('div', 'omnitime-myday__cols');
    const timelineWrap = elem('div', 'omnitime-myday__timeline');
    const formWrap = elem('div', 'omnitime-myday__form');
    cols.appendChild(timelineWrap);
    cols.appendChild(formWrap);

    const footer = elem('div', 'omnitime-myday__total', '<span class="omnitime-myday__total-group">Total <strong>0:00</strong></span>');
    const footerTotal = footer.querySelector('strong');

    layout.appendChild(weekWrap);
    layout.appendChild(nav);
    layout.appendChild(cols);
    layout.appendChild(footer);

    let loaded = false;
    let reqId = 0;

    function applyData(data) {
      loaded = true;
      navLabel.textContent = prettyDate(state.date);
      weekWrap.innerHTML = '';
      weekWrap.appendChild(buildWeekStrip(data, loadDay));
      footerTotal.textContent = data.day_total_label || '0:00';
      cols.classList.remove('omnitime-myday__cols--form-open');
      timelineWrap.innerHTML = '';
      formWrap.innerHTML = '';
      buildTimeline(timelineWrap, formWrap, data, {
        apiClient,
        context,
        state,
        reload: () => loadDay(state.date),
      });
    }

    function loadDay(date) {
      state.date = date;
      navLabel.textContent = prettyDate(date); // instant feedback while fetching
      const myReq = ++reqId;
      layout.classList.add('omnitime-myday--busy');
      apiClient.myDay(date).then((data) => {
        if (myReq !== reqId || !root.contains(layout)) return; // superseded / tab switched
        layout.classList.remove('omnitime-myday--busy');
        applyData(data);
      }).catch((err) => {
        if (myReq !== reqId || !root.contains(layout)) return;
        layout.classList.remove('omnitime-myday--busy');
        if (loaded) return; // keep the current day on a transient switch error
        if (isUnavailable(err)) {
          root.innerHTML = `
            <div class="omnitime-empty omnitime-unavailable">
              ${icon('calendar')}
              <div>
                <strong>“My day” isn’t available on this server yet.</strong>
                <span class="omnitime-empty__sub">It needs the updated OmniTime time-tracking API. The “This issue” tab works with the current API.</span>
              </div>
            </div>`;
        } else {
          root.innerHTML = `<div class="omnitime-error">Failed to load your day: ${esc(err.message || err)}</div>`;
        }
      });
    }

    // Initial paint: a one-time loading line in the timeline area only.
    timelineWrap.innerHTML = `<div class="omnitime-loading">${icon('calendar')} Loading your day&hellip;</div>`;
    root.appendChild(layout);
    loadDay(state.date);
  }

  function buildWeekStrip(data, onPick) {
    const strip = elem('div', 'omnitime-week');
    (data.week || []).forEach((d) => {
      const cell = elem('button', 'omnitime-week__day' + (d.active ? ' omnitime-week__day--active' : ''));
      cell.innerHTML = `<span class="omnitime-week__label">${esc(d.label)}</span><span class="omnitime-week__total">${esc(d.total_label)}</span>`;
      cell.addEventListener('click', () => onPick(d.date));
      strip.appendChild(cell);
    });
    const total = elem('div', 'omnitime-week__sum');
    total.innerHTML = `<span class="omnitime-week__label">Total</span><span class="omnitime-week__total">${esc(data.week_total_label)}</span>`;
    strip.appendChild(total);
    return strip;
  }

  // Build the vertical timeline with read-only entries + drag-to-create.
  function buildTimeline(wrap, formWrap, data, ctx) {
    const entries = (data.entries || []).map((e) => {
      const start = parseClock(e.start);
      const dur = e.duration_minutes || 0;
      return { start, stop: start != null ? start + dur : null, dur, raw: e };
    }).filter((e) => e.start != null).sort((a, b) => a.start - b.start);

    let winStart = DAY_START_DEFAULT;
    let winEnd = DAY_END_DEFAULT;
    entries.forEach((e) => {
      winStart = Math.min(winStart, e.start - 30);
      winEnd = Math.max(winEnd, e.stop + 30);
    });
    winStart = Math.max(0, Math.floor(winStart / 60) * 60);
    winEnd = Math.min(24 * 60, Math.ceil(winEnd / 60) * 60);
    // Elastic (piecewise) axis: empty gaps use the base scale; each entry is
    // expanded to at least MIN_ENTRY_H so its content is readable, with the
    // surplus inserted locally (pushing later content + hour lines down) rather
    // than scaling the whole day up. A lone short tracking only stretches its
    // own band.
    const segments = [];
    let cursor = winStart;
    let yAcc = 0;
    entries.forEach((e, i) => {
      const startClamped = Math.max(e.start, cursor);
      if (startClamped > cursor) {
        const gh = (startClamped - cursor) * PX_PER_MIN;
        segments.push({ startMin: cursor, endMin: startClamped, yTop: yAcc, yBottom: yAcc + gh });
        yAcc += gh;
      }
      const effStop = i + 1 < entries.length ? Math.min(e.stop, entries[i + 1].start) : e.stop;
      const segEnd = Math.max(effStop, startClamped);
      const h = Math.max((segEnd - startClamped) * PX_PER_MIN, MIN_ENTRY_H);
      e._top = yAcc;
      e._height = h;
      segments.push({ startMin: startClamped, endMin: segEnd, yTop: yAcc, yBottom: yAcc + h });
      yAcc += h;
      cursor = Math.max(cursor, segEnd);
    });
    if (cursor < winEnd) {
      const gh = (winEnd - cursor) * PX_PER_MIN;
      segments.push({ startMin: cursor, endMin: winEnd, yTop: yAcc, yBottom: yAcc + gh });
      yAcc += gh;
    }
    const height = yAcc;
    const interp = (v, a0, a1, b0, b1) => (a1 === a0 ? b0 : b0 + ((v - a0) / (a1 - a0)) * (b1 - b0));
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

    const grid = elem('div', 'omnitime-tl');
    grid.style.height = height + 'px';

    for (let m = winStart; m <= winEnd; m += 60) {
      const line = elem('div', 'omnitime-tl__hour');
      line.style.top = minToY(m) + 'px';
      line.innerHTML = `<span class="omnitime-tl__hourlabel">${pad2(m / 60)}:00</span>`;
      grid.appendChild(line);
    }

    entries.forEach((e) => {
      const editable = !!e.raw.editable;
      const block = elem('div', 'omnitime-tl__entry' + (editable ? ' omnitime-tl__entry--editable' : ''));
      block.style.top = e._top + 'px';
      block.style.height = e._height + 'px';
      block.innerHTML = `
        <span class="omnitime-tl__entrytitle">${esc(e.raw.project || e.raw.issue_label)} <span class="omnitime-tl__lock">${editable ? icon('edit') : icon('lock')}${esc(e.raw.duration_label)}</span></span>
        <span class="omnitime-tl__entrymeta">${esc(e.raw.issue_label)}${e.raw.issue_external_id ? ' #' + esc(e.raw.issue_external_id) : ''} &middot; ${fmtClock(e.start)}&ndash;${fmtClock(e.stop)}</span>`;
      if (editable) {
        block.title = 'Click to edit';
        block.addEventListener('click', (ev) => { ev.stopPropagation(); form.editEntry(e.raw); });
      }
      grid.appendChild(block);
    });

    wrap.appendChild(grid);

    const cols = wrap.parentElement;
    const setFormOpen = (open) => { if (cols) cols.classList.toggle('omnitime-myday__cols--form-open', open); };

    const sel = { start: null, dur: DEFAULT_DUR, block: null };
    function clearSelection() { sel.start = null; renderSelection(); }
    const form = buildForm(formWrap, data, ctx, sel, { setFormOpen, clearSelection });

    function gapAround(minute) {
      let lo = winStart;
      let hi = winEnd;
      entries.forEach((e) => {
        if (e.stop <= minute && e.stop > lo) lo = e.stop;
        if (e.start >= minute && e.start < hi) hi = e.start;
      });
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
      const sh = Math.max(minToY(sel.start + sel.dur) - minToY(sel.start), 18);
      sel.block.style.height = sh + 'px';
      sel.block.classList.toggle('omnitime-tl__sel--tiny', sh < 34);
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
    function clampPlacement(start, dur) {
      start = snap(start);
      dur = snap(dur);
      const gap = gapAround(start);
      dur = clamp(dur, MIN_DUR, Math.min(MAX_DUR, Math.max(MIN_DUR, gap.hi - gap.lo)));
      start = clamp(start, gap.lo, gap.hi - dur);
      return { start, dur };
    }

    function setSelection(start, dur) {
      const p = clampPlacement(start, dur);
      sel.start = p.start;
      sel.dur = p.dur;
      renderSelection();
      applySelToForm();
    }

    grid.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.omnitime-tl__entry') || ev.target.closest('.omnitime-tl__sel')) return;
      const rect = grid.getBoundingClientRect();
      const minute = snap(yToMin(ev.clientY - rect.top));
      hideGhost();
      setSelection(minute, DEFAULT_DUR);
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
      const gap = gapAround(sel.start + 1);
      resize = { edge, rect, gap };
      document.addEventListener('pointermove', onResize);
      document.addEventListener('pointerup', endResize, { once: true });
    }
    function onResize(ev) {
      if (!resize) return;
      const minute = snap(yToMin(ev.clientY - resize.rect.top));
      if (resize.edge === 'bottom') {
        const end = clamp(minute, sel.start + MIN_DUR, Math.min(resize.gap.hi, sel.start + MAX_DUR));
        sel.dur = end - sel.start;
      } else {
        const top = clamp(minute, Math.max(resize.gap.lo, (sel.start + sel.dur) - MAX_DUR), (sel.start + sel.dur) - MIN_DUR);
        sel.dur = (sel.start + sel.dur) - top;
        sel.start = top;
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
    });

    // --- Discoverability: hover ghost over free space + "+ Add entry" button ---
    let ghost;
    function hideGhost() { if (ghost) ghost.style.display = 'none'; }
    function showGhost(minute) {
      if (!ghost) {
        ghost = elem('div', 'omnitime-tl__ghost', '<span class="omnitime-tl__ghosttext"></span>');
        grid.appendChild(ghost);
      }
      const p = clampPlacement(minute, DEFAULT_DUR);
      const top = minToY(p.start);
      ghost.style.top = top + 'px';
      ghost.style.height = Math.max(minToY(p.start + p.dur) - top, 18) + 'px';
      ghost.querySelector('.omnitime-tl__ghosttext').innerHTML = `${icon('plus')} Add time ${fmtClock(p.start)}`;
      ghost.style.display = 'flex';
    }
    grid.addEventListener('pointermove', (ev) => {
      // Only hint in the empty state (no active selection / form closed).
      if (resize || sel.start != null || ev.target.closest('.omnitime-tl__entry')) { hideGhost(); return; }
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
      setSelection(minute, DEFAULT_DUR);
      form.reveal();
      if (sel.block) sel.block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // "+ Add entry" lives in the footer row (bottom-left), beside the total.
    // The footer persists across day switches, so drop any prior button first
    // to avoid accumulating duplicates on re-render.
    const myday = wrap.closest('.omnitime-myday');
    const footer = myday && myday.querySelector('.omnitime-myday__total');
    if (footer) {
      footer.querySelector('.omnitime-add-btn')?.remove();
      const addBtn = elem('button', 'omnitime-add-btn', `${icon('plus')}<span>Add entry</span>`);
      addBtn.addEventListener('click', () => openAt(pickDefaultStart()));
      footer.insertBefore(addBtn, footer.firstChild);
    }
  }

  // Build the new-entry form (current-issue default, search override, chips).
  function buildForm(wrap, data, ctx, sel, ctrl) {
    ctrl = ctrl || {};
    const context = ctx.context || {};
    const issueLabel = context.issue_label || (context.issue_id ? '#' + context.issue_id : 'current issue');
    const target = { mode: 'current', issueInternalId: null, label: issueLabel };
    // The "This issue" tab stashes context.issueOpen; a closed current issue
    // must not be the default target (the backend rejects it anyway).
    const currentIssueClosed = () => context.issueOpen === false;

    wrap.innerHTML = `
      <div class="omnitime-form">
        <div class="omnitime-form__head"><span class="omnitime-form__title">New entry</span> <span class="omnitime-form__when"></span><button class="omnitime-form__close" type="button" aria-label="Cancel">${icon('close')}</button></div>
        <div class="omnitime-form__alert" role="alert" hidden></div>
        <div class="omnitime-target">
          ${icon('target')}
          <div class="omnitime-target__body">
            <span class="omnitime-target__kicker">Tracking for</span>
            <span class="omnitime-target__label"></span>
          </div>
          <button class="omnitime-target__reset" hidden title="Back to current issue">${icon('close')}</button>
        </div>
        <div class="omnitime-form__hint">To track time for a different issue, search here</div>
        <div class="omnitime-search">
          <span class="omnitime-search__icon">${icon('search')}</span>
          <input type="text" class="omnitime-search__input" placeholder="Search issue&hellip;" autocomplete="off">
          <div class="omnitime-search__results" hidden></div>
        </div>
        <div class="omnitime-form__row">
          <label>Duration<input type="text" class="omnitime-f-dur" value="0:15"></label>
          <label>Start time<input type="text" class="omnitime-f-start" value=""></label>
        </div>
        <textarea class="omnitime-f-comment" rows="2" placeholder="Comment&hellip;"></textarea>
        <div class="omnitime-form__actions">
          <button class="omnitime-del" type="button">${icon('trash')}<span>Delete</span></button>
          <span class="omnitime-form__msg"></span>
          <button class="omnitime-save">Save entry</button>
        </div>
        <div class="omnitime-freq">
          <div class="omnitime-freq__title">${icon('repeat')} Frequently tracked times</div>
          <div class="omnitime-freq__chips"></div>
        </div>
      </div>`;

    const formEl = wrap.querySelector('.omnitime-form');
    const whenEl = formEl.querySelector('.omnitime-form__when');
    const targetBox = formEl.querySelector('.omnitime-target');
    const targetKicker = formEl.querySelector('.omnitime-target__kicker');
    const targetLabel = formEl.querySelector('.omnitime-target__label');
    const resetBtn = formEl.querySelector('.omnitime-target__reset');
    const searchInput = formEl.querySelector('.omnitime-search__input');
    const searchResults = formEl.querySelector('.omnitime-search__results');
    const durInput = formEl.querySelector('.omnitime-f-dur');
    const startInput = formEl.querySelector('.omnitime-f-start');
    const commentInput = formEl.querySelector('.omnitime-f-comment');
    const chipsWrap = formEl.querySelector('.omnitime-freq__chips');
    const freqSection = formEl.querySelector('.omnitime-freq');
    const saveBtn = formEl.querySelector('.omnitime-save');
    const msgEl = formEl.querySelector('.omnitime-form__msg');
    const alertEl = formEl.querySelector('.omnitime-form__alert');
    const titleEl = formEl.querySelector('.omnitime-form__title');
    const delBtn = formEl.querySelector('.omnitime-del');

    let timeEditCb = null;
    let editing = null;

    const renderTarget = () => {
      const none = target.mode === 'none';
      targetBox.classList.toggle('omnitime-target--warn', none);
      targetKicker.textContent = none ? 'This issue is closed' : 'Tracking for';
      targetLabel.textContent = none ? 'Search for an open issue or pick a frequent one below.' : target.label;
      // Reset ("back to current issue") only applies when another issue is
      // picked and the current issue is open.
      resetBtn.hidden = target.mode !== 'issue' || currentIssueClosed();
    };
    renderTarget();

    const setTarget = (mode, id, label) => {
      target.mode = mode;
      target.issueInternalId = id;
      target.label = label;
      renderTarget();
      clearError();
    };
    // Any field edit clears a shown error.
    formEl.addEventListener('input', () => clearError());
    resetBtn.addEventListener('click', () => setTarget(currentIssueClosed() ? 'none' : 'current', null, issueLabel));

    // Cancel: close the form pane and clear the pending selection.
    formEl.querySelector('.omnitime-form__close').addEventListener('click', () => {
      if (ctrl.setFormOpen) ctrl.setFormOpen(false);
      if (ctrl.clearSelection) ctrl.clearSelection();
    });

    const fireEdit = () => { if (timeEditCb && !editing) timeEditCb(startInput.value.trim(), parseDur(durInput.value)); };
    durInput.addEventListener('change', fireEdit);
    startInput.addEventListener('change', fireEdit);

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 2) { searchResults.hidden = true; searchResults.innerHTML = ''; return; }
      searchTimer = setTimeout(() => {
        ctx.apiClient.search(q).then((res) => {
          const issues = (res && res.issues) || [];
          if (!issues.length) { searchResults.innerHTML = '<div class="omnitime-search__empty">No matches</div>'; searchResults.hidden = false; return; }
          searchResults.innerHTML = issues.map((i) => `
            <button class="omnitime-search__item" data-id="${i.issue_internal_id}" data-label="${esc(i.label)} #${esc(i.issue_external_id)}">
              <span class="omnitime-search__kicker">${esc(i.project)}${i.milestone ? ' &ndash; ' + esc(i.milestone) : ''}</span>
              <span class="omnitime-search__label">${esc(i.label)} <span class="omnitime-search__id">#${esc(i.issue_external_id)}</span></span>
            </button>`).join('');
          searchResults.hidden = false;
          searchResults.querySelectorAll('.omnitime-search__item').forEach((b) => {
            b.addEventListener('click', () => {
              setTarget('issue', parseInt(b.dataset.id, 10), b.dataset.label);
              searchResults.hidden = true;
              searchInput.value = '';
            });
          });
        }).catch(() => {
          searchResults.innerHTML = '<div class="omnitime-search__empty">Search unavailable</div>';
          searchResults.hidden = false;
        });
      }, 250);
    });

    const renderChips = (issues) => {
      if (!issues || !issues.length) { freqSection.style.display = 'none'; return; }
      freqSection.style.display = '';
      chipsWrap.innerHTML = '';
      issues.forEach((i) => {
        const chip = elem('button', 'omnitime-chip');
        const labelHtml = i.project
          ? `<span class="omnitime-chip__proj">${esc(i.project)}:</span> ${esc(i.label)}`
          : esc(i.label);
        chip.innerHTML = `${icon('play')}<span class="omnitime-chip__label">${labelHtml}</span><span class="omnitime-chip__dur">${esc(i.suggested_label || '')}</span>`;
        chip.title = (i.project ? i.project + ': ' : '') + i.label;
        chip.addEventListener('click', () => {
          setTarget('issue', i.issue_internal_id, i.label + ' #' + i.issue_external_id);
          if (i.suggested_minutes) {
            durInput.value = fmtDur(i.suggested_minutes);
            fireEdit();
          }
          // Chips sit below the actions now - bring Save + target back into view.
          saveBtn.scrollIntoView({ block: 'nearest' });
        });
        chipsWrap.appendChild(chip);
      });
    };
    if (ctx.state.frequent) {
      renderChips(ctx.state.frequent);
    } else {
      ctx.apiClient.frequent().then((res) => {
        ctx.state.frequent = (res && res.issues) || [];
        renderChips(ctx.state.frequent);
      }).catch(() => { freqSection.style.display = 'none'; });
    }

    saveBtn.addEventListener('click', () => {
      clearError();
      const start = startInput.value.trim();
      const dur = parseDur(durInput.value);
      if (!dur) { setError('Enter a duration.'); return; }

      // Edit mode: update the existing entry (issue stays locked).
      if (editing) {
        saveBtn.disabled = true;
        setMsg('Saving…', false);
        ctx.apiClient.update(editing.id, {
          date: ctx.state.date,
          start_time: start || undefined,
          duration: dur,
          comment: commentInput.value.trim(),
        }).then(() => ctx.reload()).catch((err) => {
          saveBtn.disabled = false;
          setError(isUnavailable(err) ? 'Editing needs the updated API on the server.' : (err.message || 'Save failed.'));
        });
        return;
      }

      const payload = {
        date: ctx.state.date,
        start_time: start || undefined,
        duration: dur,
        comment: commentInput.value.trim() || undefined,
      };
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
      } else {
        payload.issue_internal_id = target.issueInternalId;
      }
      saveBtn.disabled = true;
      setMsg('Saving…', false);
      ctx.apiClient.create(payload).then(() => {
        ctx.reload();
      }).catch((err) => {
        saveBtn.disabled = false;
        setError(isUnavailable(err) ? 'Saving needs the updated API on the server.' : (err.message || 'Save failed.'));
      });
    });

    function resetDel() {
      clearTimeout(delBtn._t);
      delBtn.dataset.confirm = '';
      delBtn.disabled = false;
      delBtn.classList.remove('omnitime-del--confirm');
      delBtn.innerHTML = `${icon('trash')}<span>Delete</span>`;
    }

    // Delete (edit mode only) with an inline two-step confirm.
    delBtn.addEventListener('click', () => {
      if (!editing) return;
      if (delBtn.dataset.confirm !== '1') {
        delBtn.dataset.confirm = '1';
        delBtn.classList.add('omnitime-del--confirm');
        delBtn.innerHTML = '<span>Confirm delete?</span>';
        delBtn._t = setTimeout(resetDel, 3000);
        return;
      }
      delBtn.disabled = true;
      setMsg('Deleting…', false);
      ctx.apiClient.remove(editing.id).then(() => ctx.reload()).catch((err) => {
        resetDel();
        setError(isUnavailable(err) ? 'Deleting needs the updated API on the server.' : (err.message || 'Delete failed.'));
      });
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
    function parseDur(v) {
      v = String(v || '').trim();
      if (v.includes(':')) {
        const [h, m] = v.split(':');
        return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
      }
      return parseInt(v, 10) || 0;
    }

    return {
      // Open in create mode (current-issue default, search + chips available).
      reveal: () => {
        editing = null;
        formEl.classList.remove('omnitime-form--edit');
        titleEl.textContent = 'New entry';
        saveBtn.textContent = 'Save entry';
        resetDel();
        // Don't default to a closed current issue - require an open pick.
        setTarget(currentIssueClosed() ? 'none' : 'current', null, issueLabel);
        if (ctrl.setFormOpen) ctrl.setFormOpen(true);
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
          }).catch(() => {});
        }
      },
      // Open in edit mode bound to an existing (unbooked) entry; issue locked.
      editEntry: (entry) => {
        editing = entry;
        if (ctrl.clearSelection) ctrl.clearSelection();
        formEl.classList.add('omnitime-form--edit');
        titleEl.textContent = 'Edit entry';
        saveBtn.textContent = 'Save';
        resetDel();
        setTarget('issue', entry.issue_internal_id, (entry.issue_label || 'issue') + (entry.issue_external_id ? ' #' + entry.issue_external_id : ''));
        startInput.value = entry.start || '';
        durInput.value = fmtDur(entry.duration_minutes || 0);
        commentInput.value = entry.comment || '';
        whenEl.textContent = `· ${entry.start || ''}, ${prettyDate(ctx.state.date)}`;
        if (ctrl.setFormOpen) ctrl.setFormOpen(true);
      },
      isEditing: () => editing != null,
      setTime: (startStr, dur) => {
        startInput.value = startStr;
        durInput.value = fmtDur(dur);
        whenEl.textContent = `· ${startStr}, ${prettyDate(ctx.state.date)}`;
      },
      onTimeEdit: (cb) => { timeEditCb = cb; },
    };
  }

  // __resetCapability lets the dev harness re-probe when toggling "old API";
  // production never calls it, so detection stays cached per page load.
  window.OmniTime = {
    createApiClient,
    openModal,
    __resetCapability: () => { apiCapable = undefined; capabilityProbe = null; },
  };
})();
