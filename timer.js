// timer.js - The running timer: pure logic, storage and its small UI parts.
//
// The 1x TIMES API has no start/stop endpoint (see "Running timer" in the API
// contract): the web app keeps the start time in the browser and creates the
// entry when the timer stops. So does the extension. The one timer lives in
// chrome.storage.local under `omnitimeTimer`, so it survives closed tabs and
// reloads and is shared by every tab (chrome.storage.onChanged):
//
//   { startedAt: ISO string,
//     issue: { issue_internal_id?, source?, project_id?, issue_id?, label },
//     comment: string }
//
// Loaded before core.js in every injection list (content script, toolbar
// overlay, dev harness); core.js, sidebar-widget.js and the service worker's
// badge only read the storage key and use the pieces below. core.js and the
// widget work without this file (no pill, no Start button), so it is optional
// for them.
//
//   const T = OmniTimeTimer;
//   T.planBooking(timer, end)      // pure: rounding, discard, chunks
//   const ctl = T.shared();        // one controller per page (or T.createController(opts))
//   ctl.load() / ctl.current() / ctl.start(issue) / ctl.stop(api, { end }) /
//   ctl.undo(api, result) / ctl.discard() / ctl.subscribe(fn)
//   T.createStopper({ controller, apiClient, notify, onDayTotal, onChange, pushEscape })
//   T.mountPill(slot, { controller, stopper }) / T.mountStartButton(head, { ... })
//
// Booking rules (stop): the entry starts at startedAt rounded to 5 minutes and
// lasts the elapsed time rounded to 5 minutes (minimum 5). Under 2.5 minutes
// there is nothing to book (discard). It is split into chunks of at most 240
// minutes (the API limit) and at midnight, each chunk on its own date.

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.OmniTimeTimer) return;

  const KEY = 'omnitimeTimer';
  const SNAP = 5;              // minutes: entries start and last a multiple of this
  const MIN_DUR = 5;           // shortest entry
  const MAX_CHUNK = 240;       // API limit per entry (minutes)
  const DISCARD_BELOW = 2.5;   // minutes: less than this is not worth booking
  const STALE_MINUTES = 600;   // 10 h: probably forgotten, ask for the real end
  const MAX_CHUNKS = 100;      // sanity cap for absurd ranges
  const TICK_MS = 30000;       // how often the displayed time updates
  const UNDO_MS = 8000;

  // --- Helpers ---
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDur = (m) => `${Math.floor(m / 60)}:${pad2(Math.floor(m) % 60)}`;
  const clock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const coded = (code, message) => Object.assign(new Error(message || code), { code });
  const prettyWhen = (d) => `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(d)}`;

  // --- Pure logic ---

  // A stored value as a valid timer, or null (corrupt, or no bookable issue).
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = Date.parse(raw.startedAt);
    const i = raw.issue;
    if (isNaN(at) || !i || typeof i !== 'object') return null;
    const ext = i.source && i.project_id && i.issue_id;
    if (!i.issue_internal_id && !ext) return null;
    const issue = { label: String(i.label || '') };
    ['issue_internal_id', 'source', 'project_id', 'issue_id'].forEach((k) => {
      if (i[k] !== undefined && i[k] !== null && i[k] !== '') issue[k] = i[k];
    });
    return { startedAt: new Date(at).toISOString(), issue, comment: typeof raw.comment === 'string' ? raw.comment : '' };
  }

  const sameTimer = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Two issue descriptions name the same issue (internal id when both have
  // one, else source + project + issue).
  function sameIssue(a, b) {
    if (!a || !b) return false;
    if (a.issue_internal_id && b.issue_internal_id) return String(a.issue_internal_id) === String(b.issue_internal_id);
    if (!(a.source && b.source)) return false;
    return [a.source, a.project_id, a.issue_id].join('|') === [b.source, b.project_id, b.issue_id].join('|');
  }

  // "#14 Fix login" from a number and a title; the title may already carry
  // the number ("Fix login (#14)", as on GitLab pages).
  function issueLabel(number, title) {
    const num = number == null ? '' : String(number).trim();
    let text = String(title || '').trim();
    if (!num) return text;
    text = text.replace(new RegExp(`\\s*\\(?#${num.replace(/[^\w-]/g, '')}\\)?\\s*$`), '').trim();
    return `#${num}${text ? ' ' + text : ''}`;
  }

  // Minutes (fractional) from startedAt to `at`; never negative.
  function elapsedMinutes(timer, at) {
    return Math.max(0, ((at || new Date()).getTime() - Date.parse(timer.startedAt)) / 60000);
  }
  const isStale = (timer, at) => elapsedMinutes(timer, at) > STALE_MINUTES;

  // 0:42 (whole minutes, floored: the display never runs ahead).
  const formatElapsed = (minutes) => fmtDur(Math.max(0, Math.floor(minutes)));

  // The start rounded to the 5-minute grid on the local clock (23:58 -> 00:00
  // of the next day).
  function roundToGrid(d) {
    const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.round(m / SNAP) * SNAP);
  }

  // [{ date, start_time, duration }] for `duration` minutes from `start`:
  // at most MAX_CHUNK each and none crossing midnight.
  function splitChunks(start, duration) {
    const out = [];
    let cur = start;
    let left = duration;
    while (left > 0 && out.length < MAX_CHUNKS) {
      const minOfDay = cur.getHours() * 60 + cur.getMinutes();
      const len = Math.min(left, MAX_CHUNK, 1440 - minOfDay);
      out.push({ date: ymd(cur), start_time: clock(cur), duration: len });
      left -= len;
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), 0, minOfDay + len);
    }
    return out;
  }

  // What stopping at `end` books: { discard: true } when it is too short, else
  // { discard: false, elapsed, duration, start (Date), chunks }.
  function planBooking(timer, end) {
    const started = new Date(timer.startedAt);
    const elapsed = (end.getTime() - started.getTime()) / 60000;
    if (!(elapsed >= DISCARD_BELOW)) return { discard: true, elapsed: Math.max(0, elapsed || 0) };
    const duration = Math.max(MIN_DUR, Math.round(elapsed / SNAP) * SNAP);
    const start = roundToGrid(started);
    return { discard: false, elapsed, duration, start, chunks: splitChunks(start, duration) };
  }

  // The POST body for one chunk (same fields the form and the sidebar widget
  // send): the external issue ids when known, else the internal id.
  function chunkPayload(timer, chunk) {
    const i = timer.issue;
    const payload = { date: chunk.date, start_time: chunk.start_time, duration: chunk.duration };
    if (i.source && i.project_id && i.issue_id) {
      payload.source = i.source;
      payload.project_id = i.project_id;
      payload.issue_id = i.issue_id;
    } else {
      payload.issue_internal_id = i.issue_internal_id;
    }
    if (timer.comment) payload.comment = timer.comment;
    return payload;
  }

  // The end time a forgotten timer defaults to in the confirm: startedAt + 1 h.
  const defaultEndTime = (timer) => clock(new Date(Date.parse(timer.startedAt) + 3600000));

  // "HH:MM" -> the first such time after the start, as a Date. { error } when
  // it is malformed or still in the future.
  function resolveEnd(timer, hhmm, at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return { error: 'invalid' };
    const started = new Date(timer.startedAt);
    let end = new Date(started.getFullYear(), started.getMonth(), started.getDate(), +m[1], +m[2]);
    if (end.getTime() <= started.getTime()) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, +m[1], +m[2]);
    if (end.getTime() > (at || new Date()).getTime()) return { error: 'future' };
    return { end };
  }

  // --- Controller: storage + shared state ---
  // opts: { storage (chrome.storage.local-like), events (chrome.storage.onChanged
  // -like), now }. All default to chrome.* (looked up at call time).
  function createController(opts) {
    opts = opts || {};
    const now = opts.now || (() => new Date());
    const store = () => opts.storage || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
    const events = () => opts.events || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) || null;
    let timer = null;
    const subs = new Set();
    let listening = null; // the events object the listener is on
    let stopping = false;

    const emit = () => subs.forEach((fn) => { try { fn(timer); } catch (e) { /* a broken view must not stop the others */ } });
    const setTimer = (next) => {
      const changed = !sameTimer(timer, next);
      timer = next;
      if (changed) emit();
    };
    // Other tabs (and our own writes) arrive here.
    const onStorage = (changes, area) => {
      if (area !== 'local' || !changes || !(KEY in changes)) return;
      setTimer(normalize(changes[KEY].newValue));
    };

    function read() {
      const s = store();
      if (!s) { setTimer(null); return Promise.resolve(null); }
      return new Promise((resolve) => {
        s.get([KEY], (r) => {
          setTimer(normalize(r && r[KEY]));
          resolve(timer);
        });
      });
    }

    function write(next) {
      const s = store();
      if (!s) return Promise.reject(new Error('Storage is not available.'));
      return new Promise((resolve) => {
        const done = () => { setTimer(next); resolve(next); };
        if (next) s.set({ [KEY]: next }, done);
        else if (typeof s.remove === 'function') s.remove(KEY, done);
        else s.set({ [KEY]: null }, done);
      });
    }

    function removeEntries(api, ids) {
      let firstErr = null;
      return ids.reduce((p, id) => p.then(() => api.remove(id).catch((err) => { if (!firstErr) firstErr = err; })), Promise.resolve())
        .then(() => { if (firstErr) throw firstErr; });
    }

    return {
      // The timer as last read/changed; call load() first for a fresh read.
      current: () => timer,
      load: read,

      // fn(timer|null) on every change, here or in another tab. Returns the
      // unsubscribe; the storage listener only exists while someone listens.
      subscribe(fn) {
        subs.add(fn);
        const ev = events();
        if (!listening && ev) { ev.addListener(onStorage); listening = ev; }
        return () => {
          subs.delete(fn);
          if (!subs.size && listening) { listening.removeListener(onStorage); listening = null; }
        };
      },

      // Start a timer for `issue`. Rejects (code 'timer-running') when one runs.
      start(issue, comment) {
        return read().then((cur) => {
          if (cur) throw Object.assign(coded('timer-running', 'A timer is already running.'), { timer: cur });
          const next = normalize({ startedAt: now().toISOString(), issue, comment });
          if (!next) throw coded('bad-issue', 'This issue cannot be timed.');
          return write(next);
        });
      },

      // Drop the timer without booking anything.
      discard: () => write(null),

      // Book the timer (ending at `o.end`, default now) and clear it. Rejects
      // with code 'no-timer', 'too-short' (nothing to book: discard instead),
      // 'needs-end' (ran over 10 h and no end was given) or the API error;
      // after an API error nothing stays booked and the timer keeps running.
      // Resolves { ids, minutes, chunks, timer, undoable }.
      stop(api, o) {
        o = o || {};
        if (stopping) return Promise.reject(coded('busy', 'Already booking.'));
        stopping = true;
        const release = (v) => { stopping = false; return v; };
        const fail = (e) => { stopping = false; throw e; };
        return read().then((cur) => {
          if (!cur) throw coded('no-timer', 'No timer is running.');
          const at = now();
          if (!o.end && isStale(cur, at)) throw coded('needs-end', 'This timer ran for a long time.');
          const plan = planBooking(cur, o.end || at);
          if (plan.discard) throw coded('too-short', 'Too short to book.');
          const ids = [];
          let post = Promise.resolve();
          plan.chunks.forEach((chunk) => {
            post = post.then(() => api.create(chunkPayload(cur, chunk)).then((created) => {
              ids.push(created && created.id != null ? created.id : null);
            }));
          });
          return post.then(
            () => write(null).then(() => ({
              ids: ids.filter((id) => id != null),
              minutes: plan.duration,
              chunks: plan.chunks,
              timer: cur,
              undoable: ids.every((id) => id != null),
            })),
            // Half-booked: take back what was created so a retry can't double up.
            (err) => removeEntries(api, ids.filter((id) => id != null)).catch(() => {}).then(() => { throw err; }),
          );
        }).then(release, fail);
      },

      // Take back a booking: delete its entries and start the timer again with
      // its original start. Rejects (code 'timer-running') when another timer
      // runs meanwhile, which would be lost.
      undo(api, result) {
        return read().then((cur) => {
          if (cur) throw coded('timer-running', 'Another timer is running.');
          return removeEntries(api, result.ids).then(() => write(result.timer));
        });
      },
    };
  }

  let sharedController = null;
  const shared = () => sharedController || (sharedController = createController());

  // --- UI parts ---
  // Plain DOM (no innerHTML with data), styled by style.css (.omnitime-timer*).
  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const PLAY = '<svg class="ot-svg ot-svg--play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l13 8-13 8V4z" fill="currentColor" stroke="none"/></svg>';
  const STOP = '<svg class="ot-svg ot-svg--stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>';
  const failText = (what, err) => `Couldn't ${what}${err && err.status ? ` (HTTP ${err.status})` : ''}.`;

  // The stop / start flows with their inline confirms. They render into a
  // `host` element the caller provides (a popover under the header pill, a row
  // in the issue tab or the widget); at most one panel is open at a time.
  //   opts: { controller, apiClient, notify(message, { actionLabel, onAction, timeout }),
  //           onDayTotal(date, minutes), onChange(), pushEscape(fn, el) -> pop,
  //           focusFallback(), now }
  function createStopper(opts) {
    const controller = opts.controller;
    const api = opts.apiClient;
    const now = opts.now || (() => new Date());
    const notify = opts.notify || (() => {});
    let busy = false;
    let panel = null; // { host, el, pop }
    const busyFns = new Set();
    const setBusy = (v) => { busy = v; busyFns.forEach((fn) => fn(v)); };

    function closePanel(host) {
      if (!panel || (host && panel.host !== host)) return;
      const p = panel;
      panel = null;
      if (p.pop) p.pop();
      // Focus inside a panel that goes away would fall to <body>.
      const active = p.el.isConnected ? p.el.getRootNode().activeElement : null;
      if (active && p.el.contains(active) && opts.focusFallback) opts.focusFallback();
      p.el.remove();
    }

    // spec: { label, text, alert, busy, fields: [Node], buttons: [{ label, kind, onClick, focus }], onEscape }
    function show(host, spec) {
      closePanel();
      const el = h('div', 'omnitime-timerpanel');
      el.setAttribute('role', spec.alert ? 'alert' : 'group');
      el.setAttribute('aria-label', spec.label || 'Timer');
      el.appendChild(h('p', 'omnitime-timerpanel__msg', spec.text));
      (spec.fields || []).forEach((f) => el.appendChild(f));
      let focusEl = null;
      if ((spec.buttons || []).length) {
        const row = h('div', 'omnitime-timerpanel__row');
        spec.buttons.forEach((b) => {
          const btn = h('button', 'omnitime-timerpanel__btn' + (b.kind ? ' omnitime-timerpanel__btn--' + b.kind : ''), b.label);
          btn.type = 'button';
          btn.addEventListener('click', b.onClick);
          if (b.focus) focusEl = btn;
          row.appendChild(btn);
        });
        el.appendChild(row);
      }
      host.textContent = '';
      host.appendChild(el);
      const escape = () => { if (spec.onEscape) spec.onEscape(); else closePanel(); };
      let pop = null;
      if (opts.pushEscape) pop = opts.pushEscape(() => { closePanel(); if (spec.onEscape) spec.onEscape(); }, el);
      else el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escape(); } });
      panel = { host, el, pop };
      if (!spec.busy) (spec.focusEl ? spec.focusEl() : focusEl || el.querySelector('input, button'))?.focus({ preventScroll: true });
      return el;
    }

    // Today's total changed: tell the badge (best effort).
    function reportTotal() {
      if (!opts.onDayTotal || !api.myDay) return;
      const date = ymd(now());
      api.myDay(date).then((d) => {
        const total = Number(d && d.day_total_minutes);
        if (Number.isFinite(total)) opts.onDayTotal(date, total);
      }).catch(() => {});
    }
    const changed = () => { reportTotal(); if (opts.onChange) opts.onChange(); };

    function undo(result) {
      return controller.undo(api, result).then(() => {
        notify('Timer is running again');
        changed();
      }, (err) => {
        notify(err && err.code === 'timer-running' ? 'Stop the running timer first, then undo.' : failText('undo', err));
      });
    }

    function afterBooked(result) {
      const n = result.chunks.length;
      const msg = `Booked ${fmtDur(result.minutes)}${n > 1 ? ` in ${n} entries` : ''}`;
      notify(msg, result.undoable ? { actionLabel: 'Undo', onAction: () => undo(result), timeout: UNDO_MS } : { timeout: UNDO_MS });
      changed();
    }

    // Stop the running timer. cb: { onDone({ booked } | { discarded } | {}), onCancel }.
    function begin(host, cb) {
      cb = cb || {};
      const done = (outcome) => { closePanel(host); if (cb.onDone) cb.onDone(outcome); };
      const cancel = () => { closePanel(host); if (cb.onCancel) cb.onCancel(); };

      const showError = (err, retry) => show(host, {
        label: 'Booking failed', alert: true, onEscape: cancel,
        text: `${failText('book the timer', err)} It is still running.`,
        buttons: [{ label: 'Retry', kind: 'primary', onClick: retry, focus: true }, { label: 'Dismiss', onClick: cancel }],
      });

      const discard = () => controller.discard().then(() => { notify('Timer discarded'); changed(); done({ discarded: true }); });

      function book(cur, end) {
        show(host, { label: 'Booking', text: 'Booking…', busy: true });
        setBusy(true);
        controller.stop(api, { end }).then((result) => {
          setBusy(false);
          afterBooked(result);
          done({ booked: result });
        }, (err) => {
          setBusy(false);
          if (err.code === 'no-timer') { notify('The timer was already stopped.'); return done({}); }
          if (err.code === 'too-short') return showShort();
          if (err.code === 'needs-end') return showEnd(cur);
          return showError(err, () => book(cur, end));
        });
      }

      function showShort() {
        show(host, {
          label: 'Timer too short', onEscape: cancel,
          text: 'Under 3 minutes: too short to book.',
          buttons: [{ label: 'Discard', kind: 'danger', onClick: discard }, { label: 'Keep running', onClick: cancel, focus: true }],
        });
      }

      function showEnd(cur) {
        const started = new Date(cur.startedAt);
        const input = h('input', 'omnitime-timerpanel__input');
        input.type = 'time';
        input.value = defaultEndTime(cur);
        input.setAttribute('aria-label', 'End time');
        const field = h('label', 'omnitime-timerpanel__field', 'Stopped at ');
        field.appendChild(input);
        const hint = h('div', 'omnitime-timerpanel__hint');
        const err = h('div', 'omnitime-timerpanel__error');
        err.setAttribute('role', 'alert');
        const preview = () => {
          const r = resolveEnd(cur, input.value, now());
          err.textContent = '';
          if (r.error) { hint.textContent = ''; return r; }
          const plan = planBooking(cur, r.end);
          hint.textContent = plan.discard ? 'Too short to book.' : `Books ${fmtDur(plan.duration)} from ${clock(plan.start)}${plan.chunks.length > 1 ? ` in ${plan.chunks.length} entries` : ''}.`;
          return r;
        };
        const submit = () => {
          const r = preview();
          if (r.error) {
            err.textContent = r.error === 'future' ? "That's in the future." : 'Enter a time like 17:30.';
            input.focus();
            return;
          }
          if (planBooking(cur, r.end).discard) { err.textContent = 'Pick a later time: that is too short to book.'; input.focus(); return; }
          book(cur, r.end);
        };
        input.addEventListener('input', preview);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        show(host, {
          label: 'Timer ran long', onEscape: cancel,
          text: `This timer has run ${formatElapsed(elapsedMinutes(cur, now()))}, since ${prettyWhen(started)}. When did you stop?`,
          fields: [field, hint, err],
          buttons: [
            { label: 'Book', kind: 'primary', onClick: submit },
            { label: 'Discard', kind: 'danger', onClick: discard },
            { label: 'Keep running', onClick: cancel },
          ],
          focusEl: () => input,
        });
        preview();
      }

      return controller.load().then((cur) => {
        if (!cur) return done({});
        if (isStale(cur, now())) return showEnd(cur);
        if (elapsedMinutes(cur, now()) < DISCARD_BELOW) return showShort();
        return book(cur, null);
      });
    }

    // Start a timer for `issue`; with another one running, ask to book that
    // first. cb: { onDone({ started } | { running }), onCancel }.
    function startFlow(host, issue, cb) {
      cb = cb || {};
      const cancel = () => { closePanel(host); if (cb.onCancel) cb.onCancel(); };
      const startNow = () => controller.start(issue).then(() => {
        closePanel(host);
        if (cb.onDone) cb.onDone({ started: true });
      }, (err) => {
        if (err && err.code === 'timer-running') return startFlow(host, issue, cb);
        show(host, {
          label: 'Start failed', alert: true, onEscape: cancel,
          text: err && err.code === 'bad-issue' ? 'This issue cannot be timed.' : failText('start the timer', err),
          buttons: [{ label: 'Dismiss', onClick: cancel, focus: true }],
        });
      });
      return controller.load().then((cur) => {
        if (!cur) return startNow();
        if (sameIssue(cur.issue, issue)) { closePanel(host); if (cb.onDone) cb.onDone({ running: true }); return undefined; }
        show(host, {
          label: 'Timer already running', onEscape: cancel,
          text: `A timer is running on ${cur.issue.label || 'another issue'} (${formatElapsed(elapsedMinutes(cur, now()))}). Book it first, then start this one?`,
          buttons: [
            { label: 'Book and start', kind: 'primary', focus: true, onClick: () => begin(host, { onDone: () => startNow(), onCancel: cancel }) },
            { label: 'Cancel', onClick: cancel },
          ],
        });
        return undefined;
      });
    }

    return {
      begin,
      startFlow,
      closePanel,
      isBusy: () => busy,
      onBusy: (fn) => { busyFns.add(fn); return () => busyFns.delete(fn); },
    };
  }

  // The running pill in the modal header: "● 0:42 #12 Issue  Stop". `slot` is
  // an empty element; it hides itself while no timer runs. The time refreshes
  // every 30 s, the timer is picked up from other tabs, Stop is a normal Tab
  // stop and opens its confirm in `opts.panelHost` (a row under the header; a
  // popover would be clipped by the dialog; default: inside the slot).
  //   opts: { controller, stopper, panelHost, now, tickMs, focusFallback() }
  function mountPill(slot, opts) {
    const controller = opts.controller;
    const stopper = opts.stopper;
    const now = opts.now || (() => new Date());
    slot.textContent = '';
    const pill = h('div', 'omnitime-timerpill');
    pill.setAttribute('role', 'group');
    pill.setAttribute('aria-label', 'Running timer');
    const dot = h('span', 'omnitime-timerpill__dot');
    dot.setAttribute('aria-hidden', 'true');
    const time = h('span', 'omnitime-timerpill__time');
    const issue = h('span', 'omnitime-timerpill__issue');
    const stop = h('button', 'omnitime-timerpill__stop', 'Stop');
    stop.type = 'button';
    pill.append(dot, time, issue, stop);
    const host = opts.panelHost || h('div', 'omnitime-timerpanel-host');
    slot.append(pill);
    if (!opts.panelHost) slot.append(host);
    slot.hidden = true;

    function render(timer) {
      if (!timer) {
        if (slot.contains(slot.getRootNode().activeElement) && opts.focusFallback) opts.focusFallback();
        stopper.closePanel(host);
        slot.hidden = true;
        return;
      }
      const t = formatElapsed(elapsedMinutes(timer, now()));
      const label = timer.issue.label || 'issue';
      time.textContent = t;
      issue.textContent = label;
      issue.title = label;
      stop.setAttribute('aria-label', `Stop timer, running ${t} on ${label}`);
      slot.hidden = false;
    }
    stop.addEventListener('click', () => {
      if (stopper.isBusy()) return;
      stopper.begin(host, { onCancel: () => stop.focus({ preventScroll: true }) });
    });
    const offBusy = stopper.onBusy((b) => { stop.disabled = b; });
    const unsub = controller.subscribe(render);
    const tick = setInterval(() => { if (controller.current()) render(controller.current()); }, opts.tickMs || TICK_MS);
    controller.load().then(render);
    return {
      el: pill,
      destroy() {
        clearInterval(tick);
        unsub();
        offBusy();
        stopper.closePanel(host);
        slot.textContent = '';
      },
    };
  }

  // "Start timer" next to an issue's other actions; "Stop · 0:42" while the
  // timer runs on that very issue. Its confirms open in a row after `head`.
  //   opts: { controller, stopper, issue, now, tickMs, onChange() }
  function mountStartButton(head, opts) {
    const controller = opts.controller;
    const stopper = opts.stopper;
    const now = opts.now || (() => new Date());
    const btn = h('button', 'omnitime-timer-start');
    btn.type = 'button';
    const host = h('div', 'omnitime-timerpanel-host omnitime-timerpanel-host--inline');
    head.appendChild(btn);
    head.after(host);
    let running = false;

    function render(timer) {
      running = !!timer && sameIssue(timer.issue, opts.issue);
      btn.classList.toggle('omnitime-timer-start--running', running);
      if (running) {
        const t = formatElapsed(elapsedMinutes(timer, now()));
        btn.innerHTML = STOP;
        btn.append(h('span', null, `Stop timer · ${t}`));
        btn.setAttribute('aria-label', `Stop timer, running ${t}`);
      } else {
        btn.innerHTML = PLAY;
        btn.append(h('span', null, 'Start timer'));
        btn.removeAttribute('aria-label');
      }
    }
    const back = () => btn.focus({ preventScroll: true });
    btn.addEventListener('click', () => {
      if (stopper.isBusy()) return;
      if (running) stopper.begin(host, { onDone: () => { if (opts.onChange) opts.onChange(); }, onCancel: back });
      else stopper.startFlow(host, opts.issue, { onDone: () => { back(); }, onCancel: back });
    });
    render(controller.current());
    let unsub = null;
    unsub = controller.subscribe((t) => {
      // Re-rendered away (tab switch): stop listening.
      if (!btn.isConnected) { if (unsub) unsub(); return; }
      render(t);
    });
    const tick = setInterval(() => {
      if (!btn.isConnected) { clearInterval(tick); if (unsub) unsub(); return; }
      if (running) render(controller.current());
    }, opts.tickMs || TICK_MS);
    controller.load().then(render);
    return {
      el: btn,
      destroy() { clearInterval(tick); if (unsub) unsub(); stopper.closePanel(host); host.remove(); btn.remove(); },
    };
  }

  root.OmniTimeTimer = {
    KEY, SNAP, MIN_DUR, MAX_CHUNK, DISCARD_BELOW, STALE_MINUTES,
    normalize, sameIssue, issueLabel, elapsedMinutes, isStale, formatElapsed,
    roundToGrid, splitChunks, planBooking, chunkPayload, defaultEndTime, resolveEnd,
    createController, shared, createStopper, mountPill, mountStartButton,
  };
})();
