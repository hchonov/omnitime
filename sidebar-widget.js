// sidebar-widget.js - Inline quick-track widget under the GitLab sidebar's
// "Time tracking" section: the issue total, your own time on it, a compact
// per-person list (only when others booked time and the API names them) and
// a segmented "+ | 5m | 10m | 15m | 30m | 1h" control that books an entry ending now
// (with a short Undo).
// Mounted by content.js in its own shadow root (OmniTime.mountInline, core.js),
// styled with the shared --ot-* tokens. Loaded after core.js, before content.js.
//
//   const widget = OmniTimeSidebar.attach(target, { apiClient, context, theme, onOpen, ensureStyles,
//                                                    heading, expanded, presentation, onToggle,
//                                                    onOpenPerson });
//   (onOpenPerson({ uid, name }): a colleague's name in the people list - only
//   PMs get uids from the server - opens that person's Week tab.)
//   widget.isValid(target, issueKey)   // still mounted for this target and issue?
//   widget.refresh()                   // re-fetch the numbers (e.g. after the modal closed)
//   widget.setPresentation(on)         // presentation mode: no chevron, collapsed
//   widget.destroy()                   // unmount, stop timers/listeners
//
// Privacy: the widget is COLLAPSED by default. Only a small chevron button sits
// next to the "Time tracking" heading (`heading`, an element or a function
// returning one; falls back to `target`); nothing else is rendered and no API
// request is made until the user expands it (or `expanded: true`, from the
// "open automatically" setting or an earlier expand on this issue).
// `onToggle(expanded)` reports every change so content.js can keep the state
// across GitLab's sidebar re-renders. In presentation mode (`presentation:
// true`) there is no chevron at all and the details stay collapsed.
//
// Running timer (timer.js, optional): a quiet "▶ Start" at the right end of the
// summary line; while the timer runs on this issue it reads "● 0:42 · Stop".
//
// Numbers: the issue total, "You" (own_sum, else the `self` row; the whole time
// you booked on the issue) and the people list come from the tracked-time
// endpoint (works on the old API too, minus You/people). my-tracked-time is
// still fetched with it: it tells whether the day API exists (the buttons need
// it), feeds the toolbar badge, and is the last-resort "You today" on servers
// that send neither own_sum nor a `self` row.
//
// People list: the API's rows in order (the caller's reads "You", bold; "Others"
// last), at most MAX_PEOPLE of them, then "+N more · Show all" (opens the modal
// on "This issue"). It is shown only when at least one row is another named
// person, so "only me" and "me + Others" (regular users) show just the summary.
// Entries are matched to the issue by issue_external_id only (the day view
// carries no project id), so same-numbered issues of different projects add up.

(function () {
  if (window.OmniTimeSidebar) return;

  const SNAP = 5;          // minutes; entries start on a multiple of this
  const MIN_DUR = 5;       // shortest entry a quick button books
  const UNDO_MS = 6000;    // how long "Added ... · Undo" stays
  const UNAVAILABLE = [404, 501]; // "the new API isn't on this server"
  const MAX_PEOPLE = 5;    // rows in the people list before "+N more · Show all"
  const BUTTONS = [
    { minutes: 5, label: '5m', name: '5 minutes' },
    { minutes: 10, label: '10m', name: '10 minutes' },
    { minutes: 15, label: '15m', name: '15 minutes' },
    { minutes: 30, label: '30m', name: '30 minutes' },
    { minutes: 60, label: '1h', name: '1 hour' },
  ];
  const PLUS_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDur = (m) => `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // The tracked-time rows as the widget shows them. `flagged`: the server knows
  // the `self`/`others` flags (own_sum or a boolean `self`); without them the
  // caller's row and the "Others" row can't be told from named people, so the
  // list stays off. Pure: exported for tests.
  function summarize(issue) {
    const rows = issue && Array.isArray(issue.tracked_time) ? issue.tracked_time.filter((r) => r && typeof r === 'object') : [];
    const hasOwn = !!issue && typeof issue.own_sum === 'number' && Number.isFinite(issue.own_sum);
    const selfRow = rows.find((r) => r.self === true);
    const flagged = hasOwn || rows.some((r) => typeof r.self === 'boolean');
    const people = flagged ? rows.map((r) => ({
      name: String(r.user == null ? '' : r.user),
      minutes: Number(r.time_spent) || 0,
      self: r.self === true,
      others: r.others === true,
      // Only sent to callers who may view colleagues' time (then the name opens
      // that person's week). Never kept anywhere but in this list.
      uid: Number.isInteger(r.uid) && r.uid > 0 ? r.uid : null,
    })) : [];
    return {
      // null: the server says nothing about the caller's total.
      own: hasOwn ? issue.own_sum : selfRow ? Number(selfRow.time_spent) || 0 : null,
      people,
      showPeople: people.some((p) => !p.self && !p.others),
    };
  }
  const issueKey = (ctx) => [ctx && ctx.source, ctx && ctx.project_id, ctx && ctx.issue_id].join('|');

  // The entry a quick button books: it ends (about) now. The start is `now -
  // minutes` rounded DOWN to 5 minutes, so the entry ends at or just before
  // now (never in the future) and starts on the grid the timeline uses.
  // An entry can't cross midnight (the API books a date + start time), so
  // shortly after midnight the start is clamped to 00:00 and the duration
  // shortened to the time elapsed today, rounded down to 5 minutes (00:10 with
  // +30m books 00:00-00:10). Under 5 minutes into the day nothing fits: null,
  // and the caller tells the user to use the form.
  function quickEntry(now, minutes) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const raw = nowMin - minutes;
    let start = Math.floor(raw / SNAP) * SNAP;
    let duration = minutes;
    if (start < 0) {
      start = 0;
      duration = Math.floor(nowMin / SNAP) * SNAP;
    }
    if (duration < MIN_DUR) return null;
    return {
      date: ymd(now),
      start_time: `${pad2(Math.floor(start / 60))}:${pad2(start % 60)}`,
      duration,
      clamped: duration < minutes,
    };
  }

  // The create payload: the same fields the form sends for "the current
  // issue" (see buildForm in core.js); the comment is left out when empty.
  function quickPayload(context, entry) {
    return {
      source: context.source,
      project_id: context.project_id,
      issue_id: context.issue_id,
      date: entry.date,
      start_time: entry.start_time,
      duration: entry.duration,
    };
  }

  const CSS = `
.omnitime-sw {
  margin-top: 8px;
  font-family: var(--ot-font);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ot-text);
}
/* style.css's [hidden] rule is scoped to the modal; the widget needs its own. */
.omnitime-sw [hidden] { display: none; }
.omnitime-sw__line { color: var(--ot-text-muted); }
.omnitime-sw__link {
  font: inherit;
  padding: 0;
  margin-left: 4px;
  border: 0;
  background: none;
  color: var(--ot-accent-text);
  text-decoration: underline;
  cursor: pointer;
}
.omnitime-sw__msg .omnitime-sw__link { margin-left: 0; }
.omnitime-sw__more { margin: 4px 0 0; }
.omnitime-sw__summary {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  border: 1px solid var(--ot-border);
  border-radius: var(--ot-radius-md);
  background: var(--ot-bg-subtle);
}
.omnitime-sw__totals {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 2px 6px;
  min-width: 0;
  margin: 0;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--ot-radius-md);
  background: none;
  font: inherit;
  color: var(--ot-text-muted);
  text-align: left;
  cursor: pointer;
}
.omnitime-sw__totals:hover { background: var(--ot-bg-muted); }
.omnitime-sw__val { font-weight: 600; color: var(--ot-text-strong); font-variant-numeric: tabular-nums; }
.omnitime-sw__note { margin-left: 6px; color: var(--ot-text-subtle); }
.omnitime-sw__sep { color: var(--ot-text-subtle); }
.omnitime-sw__people {
  margin: 6px 0 0;
  padding: 6px 7px 0;
  border-top: 1px solid var(--ot-border);
  list-style: none;
}
.omnitime-sw__person {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ot-text-muted);
}
.omnitime-sw__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omnitime-sw__time { flex: none; font-variant-numeric: tabular-nums; }
/* A colleague's name that opens their week (PMs): looks like the plain name, a link on hover/focus. */
.omnitime-sw__name--link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--ot-accent-text);
  text-align: left;
  cursor: pointer;
}
.omnitime-sw__name--link:hover { text-decoration: underline; }
.omnitime-sw__person--self { font-weight: 700; color: var(--ot-text-strong); }
.omnitime-sw button:focus-visible { outline: 2px solid var(--ot-focus); outline-offset: 1px; }
/* Start / "● 0:42 · Stop": a quiet text button at the right end of the summary. */
.omnitime-sw__start {
  flex: none;
  margin: 0 2px 0 0;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--ot-radius-sm);
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--ot-accent-text);
  white-space: nowrap;
  cursor: pointer;
}
.omnitime-sw__start:hover { background: var(--ot-accent-subtle); }
.omnitime-sw__start--stop { color: var(--ot-rec-text); font-variant-numeric: tabular-nums; }
.omnitime-sw__start--stop:hover { background: var(--ot-rec-bg); }
.omnitime-sw__dot { color: var(--ot-rec); font-size: 8px; vertical-align: 1px; }
/* The quick row is the shared segmented control (.omnitime-seg, style.css). */
.omnitime-sw__actions { margin-top: 6px; }
.omnitime-sw .omnitime-timerpanel-host { margin-top: 6px; }
.omnitime-sw__msg { margin-top: 6px; color: var(--ot-success); }
.omnitime-sw__msg--error { color: var(--ot-danger-text); }
`;

  // The chevron lives in its own shadow root inside GitLab's heading, so it
  // needs its own host rules: inline, centered on the text, no page styles.
  // (A later :host rule beats the shared stylesheet's `all: initial`.)
  const CHEV_CSS = `
:host {
  display: inline-flex !important;
  vertical-align: middle !important;
  margin: -2px 0 -2px 4px !important; /* the 20px button must not make the heading taller */
}
.omnitime-sw__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--ot-radius-sm);
  background: transparent;
  color: var(--ot-text-subtle);
  cursor: pointer;
}
.omnitime-sw__chev:hover { background: var(--ot-bg-muted); color: var(--ot-text-strong); }
.omnitime-sw__chev:focus-visible { outline: 2px solid var(--ot-focus); outline-offset: 1px; }
.omnitime-sw__chev svg {
  display: block;
  width: 14px;
  height: 14px;
  transition: transform 150ms ease;
}
.omnitime-sw__chev[aria-expanded="true"] svg { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) {
  .omnitime-sw__chev svg { transition: none; }
}
`;
  const CHEV_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DETAILS_ID = 'omnitime-sw-details';

  function attach(target, opts) {
    opts = opts || {};
    const apiClient = opts.apiClient;
    const context = opts.context || {};
    const now = opts.now || (() => new Date());
    const undoMs = opts.undoMs || UNDO_MS;
    const key = issueKey(context);
    let expanded = !!opts.expanded;
    let presentation = !!opts.presentation;
    if (presentation) expanded = false;
    let stylesReady = false; // the shared stylesheet is in: mounting is allowed
    let chev = null;         // { ui, btn } while the chevron is mounted

    // state: what the DOM shows. day: 'ok' | 'unavailable' (old API) | 'error'.
    const state = {
      status: 'loading', // 'loading' | 'error' | 'ready'
      issueTotal: 0, ownToday: 0, ownIssue: null, people: [], showPeople: false, dayTotal: null, dayDate: null,
      day: 'ok', closed: false,
      busy: false,
      msg: null, // { kind: 'info' | 'error', text, undoId? }
    };
    let ui = null;           // { host, root, destroy } while the details are expanded
    let els = null;
    let destroyed = false;
    let seq = 0;             // newest load wins
    let undoTimer = null;
    let lastLoad = 0;
    let lastBtn = null;

    const isUnavailable = (err) => !!err && UNAVAILABLE.includes(err.status);
    // Never show the server's message (it can carry internals): status only.
    const failText = (what, err) => `Couldn't ${what}${err && err.status ? ` (HTTP ${err.status})` : ''}.`;

    function build() {
      const wrap = document.createElement('div');
      wrap.className = 'omnitime-sw';
      wrap.id = DETAILS_ID;
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'OmniTime quick track');
      wrap.innerHTML = `
        <div class="omnitime-sw__line" data-el="line"></div>
        <div class="omnitime-sw__summary" data-el="summary">
          <button class="omnitime-sw__totals" type="button" data-el="totals" title="Open OmniTime">
            <span>Issue <span class="omnitime-sw__val" data-el="issue"></span></span>
            <span class="omnitime-sw__sep" data-el="sep" aria-hidden="true">·</span>
            <span data-el="ownWrap"><span data-el="ownLabel">You</span> <span class="omnitime-sw__val" data-el="own"></span></span>
            <span class="omnitime-sw__note" data-el="closed">Closed</span>
          </button>
          <span data-el="timer" hidden>
            <button class="omnitime-sw__start omnitime-sw__start--stop" type="button" data-el="timerStop" aria-label="Stop timer">
              <span class="omnitime-sw__dot" aria-hidden="true">●</span> <span data-el="timerTime"></span> · Stop
            </button>
          </span>
        </div>
        <ul class="omnitime-sw__people" data-el="people" aria-label="Time per person" hidden></ul>
        <div class="omnitime-sw__actions omnitime-seg" data-el="actions" role="group" aria-label="Add time ending now">
          <span class="omnitime-sw__plus omnitime-seg__lead" aria-hidden="true">${PLUS_SVG}</span>
          ${BUTTONS.map((b) => `<button class="omnitime-sw__btn omnitime-seg__btn" type="button" data-min="${b.minutes}" aria-label="Add ${b.name}, ending now">${b.label}</button>`).join('')}
        </div>
        <div class="omnitime-timerpanel-host" data-el="panel"></div>
        <div class="omnitime-sw__msg" data-el="msg" role="status" aria-live="polite"></div>`;
      const q = (n) => wrap.querySelector(`[data-el="${n}"]`);
      els = {
        wrap, line: q('line'), summary: q('summary'), totals: q('totals'), issue: q('issue'), sep: q('sep'), ownWrap: q('ownWrap'),
        ownLabel: q('ownLabel'), own: q('own'), people: q('people'), closed: q('closed'), actions: q('actions'), msg: q('msg'),
        timer: q('timer'), timerTime: q('timerTime'), timerStop: q('timerStop'), start: null, panel: q('panel'),
        btns: [...wrap.querySelectorAll('.omnitime-sw__btn[data-min]')],
      };
      els.totals.addEventListener('click', () => { if (opts.onOpen) opts.onOpen(); });
      els.btns.forEach((b) => b.addEventListener('click', () => {
        lastBtn = b;
        quickAdd(parseInt(b.dataset.min, 10));
      }));
      return wrap;
    }

    function render() {
      if (!ui || destroyed) return;
      const ready = state.status === 'ready';
      els.line.hidden = ready;
      els.summary.hidden = !ready;
      els.line.textContent = '';
      if (state.status === 'loading') {
        els.line.textContent = 'OmniTime: loading…';
      } else if (state.status === 'error') {
        els.line.textContent = 'OmniTime: couldn\'t load time data.';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'omnitime-sw__link';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => load());
        els.line.appendChild(retry);
      }
      els.issue.textContent = fmtDur(state.issueTotal);
      // "You": the whole time on the issue (own_sum / self row). Servers that
      // send neither get "You today" from the day API, or nothing on the old API.
      const knowsOwn = state.ownIssue != null;
      els.ownWrap.hidden = els.sep.hidden = !knowsOwn && state.day === 'unavailable';
      els.ownLabel.textContent = knowsOwn ? 'You' : 'You today';
      els.own.textContent = knowsOwn ? fmtDur(state.ownIssue) : state.day === 'ok' ? fmtDur(state.ownToday) : '–';
      renderPeople(ready && state.showPeople);
      els.closed.hidden = !state.closed;
      // Booking needs the day API (old API: totals only) and an open issue.
      els.actions.hidden = !(ready && state.day === 'ok' && !state.closed);
      els.btns.forEach((b) => { b.disabled = state.busy; });
      renderTimer();
      renderMsg();
    }

    // The people list. Rebuilt only when the rows change, so a focused "Show
    // all" survives the renders a booking triggers.
    let shownPeople = null;
    function renderPeople(show) {
      els.people.hidden = !show;
      const rows = show ? state.people : [];
      const sig = JSON.stringify(rows);
      if (sig === shownPeople) return;
      shownPeople = sig;
      els.people.textContent = '';
      rows.slice(0, MAX_PEOPLE).forEach((p) => {
        const li = document.createElement('li');
        li.className = 'omnitime-sw__person' + (p.self ? ' omnitime-sw__person--self' : '');
        const linkable = !!opts.onOpenPerson && p.uid != null && !p.self && !p.others;
        const name = document.createElement(linkable ? 'button' : 'span');
        name.className = 'omnitime-sw__name' + (linkable ? ' omnitime-sw__name--link' : '');
        name.textContent = p.self ? 'You' : p.name;
        name.title = linkable ? `Open ${p.name}'s week` : p.name;
        if (linkable) {
          name.type = 'button';
          name.setAttribute('aria-label', `Open ${p.name}'s week`);
          name.addEventListener('click', () => opts.onOpenPerson({ uid: p.uid, name: p.name }));
        }
        const time = document.createElement('span');
        time.className = 'omnitime-sw__time';
        time.textContent = fmtDur(p.minutes);
        li.append(name, time);
        els.people.appendChild(li);
      });
      if (rows.length > MAX_PEOPLE) {
        const li = document.createElement('li');
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'omnitime-sw__link omnitime-sw__more';
        more.textContent = `+${rows.length - MAX_PEOPLE} more · Show all`;
        more.addEventListener('click', () => { if (opts.onOpen) opts.onOpen(); });
        li.appendChild(more);
        els.people.appendChild(li);
      }
    }

    let shownMsg = null;
    function renderMsg() {
      if (shownMsg === state.msg) {
        els.msg.querySelectorAll('button').forEach((b) => { b.disabled = state.busy; });
        return;
      }
      shownMsg = state.msg;
      els.msg.textContent = '';
      els.msg.className = 'omnitime-sw__msg' + (state.msg && state.msg.kind === 'error' ? ' omnitime-sw__msg--error' : '');
      els.msg.hidden = !state.msg;
      if (!state.msg) return;
      els.msg.append(state.msg.text);
      if (state.msg.undoId != null || state.msg.action) {
        els.msg.append(' · ');
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'omnitime-sw__link';
        undo.textContent = state.msg.action ? state.msg.action.label : 'Undo';
        undo.disabled = state.busy;
        undo.addEventListener('click', () => (state.msg.action ? state.msg.action.fn() : undoAdd(state.msg)));
        els.msg.appendChild(undo);
      }
    }

    function setMsg(msg, expireMs) {
      clearTimeout(undoTimer);
      state.msg = msg;
      if (msg && expireMs) {
        undoTimer = setTimeout(() => {
          if (state.msg === msg) { state.msg = null; render(); }
        }, expireMs);
      }
    }

    // Fetch the issue total + today's entries. Never rejects: failures become
    // the compact error line (first load) or are ignored (background refresh,
    // the numbers just stay as they were).
    function load(quiet) {
      if (!ui || destroyed) return Promise.resolve(); // collapsed: no requests
      const mySeq = ++seq;
      if (!quiet && state.status !== 'ready') { state.status = 'loading'; render(); }
      const today = ymd(now());
      const dayP = apiClient.myDay(today).then((d) => ({ d }), (err) => ({ err }));
      return Promise.all([apiClient.issueTime(context), dayP]).then(([issue, day]) => {
        if (destroyed || mySeq !== seq) return;
        lastLoad = Date.now();
        state.issueTotal = Number(issue && issue.total_sum) || 0;
        // Old API responses have no `issue`: unknown counts as open.
        state.closed = !!(issue && issue.issue && issue.issue.open === false);
        Object.assign(state, (({ own, people, showPeople }) => ({ ownIssue: own, people, showPeople }))(summarize(issue)));
        if (day.d) {
          const entries = (day.d.entries || []).filter((e) => String(e.issue_external_id) === String(context.issue_id));
          state.day = 'ok';
          state.ownToday = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
          state.dayTotal = Number.isFinite(day.d.day_total_minutes) ? day.d.day_total_minutes : null;
          state.dayDate = today;
        } else {
          state.day = isUnavailable(day.err) ? 'unavailable' : 'error';
          state.dayTotal = null;
        }
        state.status = 'ready';
        render();
      }, () => {
        if (destroyed || mySeq !== seq) return;
        if (quiet && state.status === 'ready') return;
        state.status = 'error';
        render();
      });
    }

    // The toolbar badge shows today's total; tell the service worker.
    function reportDayTotal() {
      if (state.dayTotal == null || state.dayDate == null) return;
      try {
        chrome.runtime.sendMessage({ action: 'OMNI_DAY_TOTAL', date: state.dayDate, totalMinutes: state.dayTotal }, () => { void chrome.runtime.lastError; });
      } catch (e) { /* extension reloaded: nothing to update */ }
    }

    function finish() {
      state.busy = false;
      render();
      // A disabled button drops the focus; hand it back for keyboard users.
      if (lastBtn && ui && !ui.root.activeElement) lastBtn.focus({ preventScroll: true });
    }

    function quickAdd(minutes) {
      if (state.busy || destroyed) return;
      const entry = quickEntry(now(), minutes);
      if (!entry) {
        setMsg({ kind: 'error', text: 'Too early in the day: use OmniTime to add this.' }, undoMs);
        render();
        return;
      }
      state.busy = true;
      setMsg(null);
      render();
      apiClient.create(quickPayload(context, entry)).then((created) => {
        const id = created && created.id != null ? created.id : null;
        return load(true).then(() => {
          if (destroyed) return;
          reportDayTotal();
          setMsg({ kind: 'info', text: `Added ${fmtDur(entry.duration)}`, undoId: id }, undoMs);
        });
      }, (err) => {
        if (destroyed) return;
        setMsg({ kind: 'error', text: failText('add time', err) }, undoMs);
      }).then(finish);
    }

    function undoAdd(msg) {
      if (state.busy || destroyed || !msg || msg.undoId == null) return;
      state.busy = true;
      clearTimeout(undoTimer);
      render();
      apiClient.remove(msg.undoId).then(() => load(true).then(() => {
        if (destroyed) return;
        reportDayTotal();
        setMsg({ kind: 'info', text: 'Removed' }, 3000);
      }), (err) => {
        if (destroyed) return;
        setMsg({ kind: 'error', text: failText('undo', err) }, undoMs);
      }).then(finish);
    }

    // --- Running timer (timer.js) ---
    const Timer = window.OmniTimeTimer;
    const hasStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    let timerCtl = null;
    let stopper = null;
    let unsubTimer = null;
    let tickTimer = null;
    const timerIssue = () => ({
      source: context.source,
      project_id: context.project_id,
      issue_id: context.issue_id,
      label: Timer.issueLabel(context.issue_id, context.issue_label),
    });
    const timerOnThis = () => {
      const t = timerCtl && timerCtl.current();
      return t && Timer.sameIssue(t.issue, timerIssue()) ? t : null;
    };

    function renderTimer() {
      if (!els || !timerCtl) return;
      const mine = timerOnThis();
      els.timer.hidden = !mine;
      // Starting needs an open issue like the quick buttons do.
      els.start.hidden = !!mine || !(state.status === 'ready' && state.day === 'ok' && !state.closed);
      if (mine) els.timerTime.textContent = Timer.formatElapsed(Timer.elapsedMinutes(mine, now()));
    }

    function setupTimer() {
      if (!Timer || !hasStore || !els) return;
      timerCtl = Timer.shared();
      // Only offered when the timer module is there.
      els.start = document.createElement('button');
      els.start.type = 'button';
      els.start.className = 'omnitime-sw__start';
      els.start.dataset.el = 'start';
      els.start.textContent = '▶ Start';
      els.start.setAttribute('aria-label', 'Start a timer on this issue');
      els.start.hidden = true;
      els.timer.before(els.start);
      stopper = Timer.createStopper({
        controller: timerCtl,
        apiClient,
        now,
        notify: (text, o) => {
          setMsg({ kind: 'info', text, action: o && o.actionLabel ? { label: o.actionLabel, fn: o.onAction } : null }, (o && o.timeout) || undoMs);
          render();
        },
        onDayTotal: (date, totalMinutes) => {
          try { chrome.runtime.sendMessage({ action: 'OMNI_DAY_TOTAL', date, totalMinutes }, () => { void chrome.runtime.lastError; }); } catch (e) { /* extension reloaded */ }
        },
        onChange: () => load(true),
      });
      els.start.addEventListener('click', () => { stopper.startFlow(els.panel, timerIssue(), { onDone: () => els.timerStop.focus({ preventScroll: true }), onCancel: () => els.start.focus() }); });
      els.timerStop.addEventListener('click', () => { if (!stopper.isBusy()) stopper.begin(els.panel, { onCancel: () => els.timerStop.focus() }); });
      unsubTimer = timerCtl.subscribe(() => renderTimer());
      tickTimer = setInterval(renderTimer, 30000);
      timerCtl.load().then(renderTimer);
    }

    // Quiet refresh when the tab comes back (time may have been booked elsewhere).
    const onVisible = () => {
      if (ui && document.visibilityState === 'visible' && !state.busy && Date.now() - lastLoad > 60000) load(true);
    };
    document.addEventListener('visibilitychange', onVisible);

    // --- Expanded details (everything the widget shows besides the chevron) ---
    function mountDetails() {
      if (ui || destroyed || !stylesReady) return;
      ui = window.OmniTime.mountInline(target, { css: CSS, theme: opts.theme });
      Object.assign(state, { status: 'loading', msg: null, day: 'ok' });
      shownMsg = null;
      shownPeople = null;
      state.ownIssue = null;
      state.people = [];
      state.showPeople = false;
      ui.root.appendChild(build());
      setupTimer();
      render();
      load();
    }

    function unmountDetails() {
      if (!ui) return;
      seq++; // a response still in flight is dropped
      clearTimeout(undoTimer);
      clearInterval(tickTimer);
      tickTimer = null;
      if (unsubTimer) unsubTimer();
      unsubTimer = null;
      if (stopper && els) stopper.closePanel(els.panel);
      stopper = null;
      timerCtl = null;
      ui.destroy();
      ui = null;
      els = null;
    }

    // --- The chevron next to the "Time tracking" heading ---
    function updateChevron() {
      if (!chev) return;
      chev.btn.setAttribute('aria-expanded', String(expanded));
      const label = expanded ? 'Hide time tracking' : 'Show time tracking';
      chev.btn.setAttribute('aria-label', label);
      chev.btn.title = label;
    }

    function mountChevron() {
      if (chev || destroyed || presentation || !stylesReady) return;
      const found = typeof opts.heading === 'function' ? opts.heading() : opts.heading;
      const heading = found && found.isConnected ? found : target;
      const mounted = window.OmniTime.mountInline(heading, { css: CHEV_CSS, theme: opts.theme });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'omnitime-sw__chev';
      btn.setAttribute('aria-controls', DETAILS_ID);
      btn.innerHTML = CHEV_SVG;
      // The heading (and the legacy whole-block trigger) opens the modal; the
      // chevron only toggles the details.
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        setExpanded(!expanded);
      });
      mounted.root.appendChild(btn);
      chev = { ui: mounted, btn, heading };
      updateChevron();
    }

    function unmountChevron() {
      if (!chev) return;
      chev.ui.destroy();
      chev = null;
    }

    function setExpanded(next) {
      next = !!next && !presentation;
      if (next === expanded) return;
      expanded = next;
      updateChevron();
      if (expanded) mountDetails(); else unmountDetails();
      if (opts.onToggle) opts.onToggle(expanded);
    }

    const handle = {
      key,
      get host() { return ui ? ui.host : null; },
      get chevron() { return chev ? chev.ui.host : null; },
      get expanded() { return expanded; },
      // Still mounted (or about to be) under this target for this issue.
      isValid: (t, k) => !destroyed && k === key && t === target
        && (!ui || target.contains(ui.host)) && (!chev || chev.heading.contains(chev.ui.host)),
      refresh: () => (destroyed || !ui ? Promise.resolve() : load(true)),
      setExpanded,
      // Presentation mode: no chevron at all, and whatever is open collapses.
      setPresentation(on) {
        on = !!on;
        if (destroyed || on === presentation) return;
        presentation = on;
        if (on) {
          setExpanded(false);
          unmountChevron();
        } else {
          mountChevron();
        }
      },
      destroy() {
        if (destroyed) return;
        unmountDetails();
        destroyed = true;
        document.removeEventListener('visibilitychange', onVisible);
        unmountChevron();
      },
    };

    // The shared stylesheet comes from the service worker; mount once it's in
    // (or without it if it can't be had: the buttons still work).
    Promise.resolve(opts.ensureStyles ? opts.ensureStyles() : null).then(() => {
      if (destroyed) return;
      stylesReady = true;
      mountChevron();
      if (expanded) mountDetails();
    });
    return handle;
  }

  window.OmniTimeSidebar = { attach, quickEntry, quickPayload, issueKey, summarize, CSS, CHEV_CSS, BUTTONS };
})();
