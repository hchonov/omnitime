// Offline, generic demo fixtures for the preview harness (no real data).
window.OMNI_FIXTURES = {
  // Demo entries (shown on weekdays): comments vs. none, several projects
  // (distinct stripe colours), a 5-minute entry, a long entry, adjacent short
  // entries (no-overlap rendering) and one booked (locked) entry after a
  // 1:30 break that has the "Design sync" placeholder inside (the break rule
  // keeps clear of it).
  entries: [
    { id: 100, start: '08:30', stop: '08:35', duration_minutes: 5, duration_label: '0:05', project: 'Project Alpha', milestone: 'Development', issue_label: 'Pipeline maintenance', issue_external_id: '104', issue_internal_id: 1004, issue_link: 'https://gitlab.example.test/alpha/-/issues/104', comment: 'Restarted flaky pipeline', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 101, start: '08:45', stop: '09:00', duration_minutes: 15, duration_label: '0:15', project: 'Project Alpha', milestone: 'Development', issue_label: 'Team standup', issue_external_id: '101', issue_internal_id: 1001, issue_link: 'https://gitlab.example.test/alpha/-/issues/101', comment: 'Standup', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 102, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30', project: 'Internal', milestone: 'Project Management', issue_label: 'Weekly company meeting', issue_external_id: '102', issue_internal_id: 1002, issue_link: 'https://gitlab.example.test/internal/-/issues/102', comment: '', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 103, start: '09:30', stop: '11:45', duration_minutes: 135, duration_label: '2:15', project: 'Customer Portal', milestone: 'Search', issue_label: 'Implement basic search', issue_external_id: '103', issue_internal_id: 1003, issue_link: 'https://gitlab.example.test/portal/-/issues/103', comment: 'Search API: facets and pagination, wired up the results view and fixed the empty state', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 104, start: '11:45', stop: '12:00', duration_minutes: 15, duration_label: '0:15', project: 'Customer Portal', milestone: 'Search', issue_label: 'Implement basic search', issue_external_id: '103', issue_internal_id: 1003, issue_link: 'https://gitlab.example.test/portal/-/issues/103', comment: 'Code review feedback', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 105, start: '13:30', stop: '15:30', duration_minutes: 120, duration_label: '2:00', project: 'Project Gamma', milestone: 'Release 2.4', issue_label: 'Release preparation', issue_external_id: '301', issue_internal_id: 3001, issue_link: 'https://gitlab.example.test/gamma/-/issues/301', comment: 'Release notes and smoke tests', status: 'booked', editable: false, break_label: '1:30', active: false },
    { id: 106, start: '15:30', stop: '16:00', duration_minutes: 30, duration_label: '0:30', project: 'Project Delta', milestone: 'Quality', issue_label: 'Accessibility audit', issue_external_id: '401', issue_internal_id: 4001, issue_link: 'https://gitlab.example.test/delta/-/issues/401', comment: 'Keyboard navigation findings', status: 'unbooked', editable: true, break_label: null, active: false },
  ],
  // Calendar events on every weekday ([title, start, end, uid]); the weekly
  // meeting is covered by a tracked entry, planning has a remembered issue.
  calendar: [
    ['Weekly company meeting', '0900', '0930', 'fixture-weekly'],
    ['Design sync', '1215', '1245', 'fixture-design'],
    ['Sprint planning', '1615', '1700', 'fixture-planning'],
    ['Customer call', '1500', '1530', 'fixture-call'],
  ],
  calIssues: {
    'uid:fixture-planning': { id: 4001, label: 'Development - daily meeting #401' },
  },
  weekdayLabels: ['M', 'T', 'W', 'Th', 'F', 'S', 'Su'],
  // Weekdays shown without the demo entries (e.g. to try "Copy from ..."),
  // and entries created/deleted in this session, by date (POST/DELETE).
  emptyDates: [],
  added: {},
  nextId: 900000,
  dayEntries(dateStr) {
    const dow = (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7;
    const base = !this.hasEntries(dow) || this.emptyDates.includes(dateStr) ? [] : this.entries;
    return base.concat(this.added[dateStr] || []).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  },
  // Synthetic absences in every week (0 = Monday): a half day on Tuesday and
  // a full day on Friday (no entries that day). The Sunday item mimics a
  // Personio absence spanning a weekend (the UI ignores weekend days).
  absenceDays: { 1: true, 4: false, 6: false }, // dow -> half_day
  hasEntries(dow) { return dow <= 4 && !(dow in this.absenceDays && this.absenceDays[dow] === false); },
  entrySum() { return this.entries.reduce((s, e) => s + e.duration_minutes, 0); },

  pad(n) { return String(n).padStart(2, '0'); },
  fmt(mins) { return `${Math.floor(mins / 60)}:${this.pad(mins % 60)}`; },
  ymd(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },

  buildMyDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);

    let weekTotal = 0;
    const week = this.weekdayLabels.map((label, i) => {
      const cell = new Date(monday);
      cell.setDate(monday.getDate() + i);
      const mins = this.dayEntries(this.ymd(cell)).reduce((s, e) => s + e.duration_minutes, 0);
      weekTotal += mins;
      return { label, date: this.ymd(cell), total_minutes: mins, total_label: this.fmt(mins), active: this.ymd(cell) === dateStr };
    });

    const entries = this.dayEntries(dateStr);
    const dayTotal = entries.reduce((s, e) => s + e.duration_minutes, 0);

    return {
      date: dateStr,
      week,
      week_total_minutes: weekTotal,
      week_total_label: this.fmt(weekTotal),
      day_total_minutes: dayTotal,
      day_total_label: this.fmt(dayTotal),
      entries,
      target_minutes: 480,
    };
  },

  // Project-manager mode (the preview's "PM" checkbox): the caller may view
  // colleagues' weeks - responses carry can_view_others, tracked-time rows a
  // uid, and /people finds the synthetic colleagues below.
  pm: false,
  people: [
    { uid: 101, name: 'Dana Example' },
    { uid: 102, name: 'Daniel Sample' },
    { uid: 103, name: 'Darius Demo' },
    { uid: 104, name: 'Eva Example' },
    { uid: 105, name: 'Mara Placeholder' },
  ],
  findPeople(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return { __status: 400, message: 'Type at least 2 characters.' };
    return { people: this.people.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 10) };
  },
  // A colleague's week: a few of the demo entries (read-only), a half day of
  // absence on Wednesday (neutral label only), their own working hours.
  buildColleagueWeek(dateStr, uid) {
    const person = this.people.find((p) => p.uid === uid);
    if (!person) return { __status: 404, message: 'Not found' };
    const d = new Date(dateStr + 'T00:00:00');
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekEntries = [];
    const absences = [];
    const shown = [this.entries[1], this.entries[3], this.entries[5], this.entries[6]];
    for (let i = 0; i < 5; i++) {
      const cell = new Date(monday);
      cell.setDate(monday.getDate() + i);
      const date = this.ymd(cell);
      if (i === 2) {
        absences.push({ date, half_day: true, label: 'Absent' });
        shown.slice(0, 2).forEach((e) => weekEntries.push({ ...e, id: uid * 1000 + i * 10 + weekEntries.length, date, editable: false, status: 'booked', break_label: null }));
      } else {
        shown.forEach((e) => weekEntries.push({ ...e, id: uid * 1000 + i * 10 + weekEntries.length, date, editable: false, status: 'booked', break_label: null }));
      }
    }
    return { date: dateStr, daily_working_hours: 8, week_entries: weekEntries, absences, user: { uid: person.uid, name: person.name }, can_view_others: true };
  },

  // my-tracked-week: the demo entries on each weekday with entries + absences.
  buildWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekEntries = [];
    const absences = [];
    for (let i = 0; i < 7; i++) {
      const cell = new Date(monday);
      cell.setDate(monday.getDate() + i);
      const date = this.ymd(cell);
      if (this.hasEntries(i)) this.entries.forEach((e, k) => weekEntries.push({ ...e, id: e.id * 10 + i, date }));
      if (i in this.absenceDays) absences.push({ date, half_day: this.absenceDays[i], label: 'Absent' });
    }
    return { date: dateStr, daily_working_hours: 8, week_entries: weekEntries, absences, ...(this.pm ? { can_view_others: true } : {}) };
  },

  // Starred issues (my-bookmarks), toggled by POST /bookmark + DELETE /bookmark/{id}.
  bookmarked: [1003],
  issueCatalog: {
    1003: { issue_internal_id: 1003, issue_external_id: '103', label: 'Implement basic search', project: 'Customer Portal', milestone: 'Search', link: '#' },
    4001: { issue_internal_id: 4001, issue_external_id: '401', label: 'Development - daily meeting', project: 'Project Delta', milestone: 'Development', link: '#' },
    5001: { issue_internal_id: 5001, issue_external_id: '501', label: 'Meetings / daily / planning', project: 'Project Epsilon', milestone: 'Project Management', link: '#' },
    1001: { issue_internal_id: 1001, issue_external_id: '101', label: 'Team standup', project: 'Project Alpha', milestone: 'Development', link: '#' },
    1002: { issue_internal_id: 1002, issue_external_id: '102', label: 'Weekly company meeting', project: 'Internal', milestone: 'Project Management', link: '#' },
    2001: { issue_internal_id: 2001, issue_external_id: '201', label: 'Retainer daily', project: 'Project Beta', milestone: 'Retainer', link: '#' },
    3001: { issue_internal_id: 3001, issue_external_id: '301', label: 'Development daily / weekly', project: 'Project Gamma', milestone: 'Sprint 4', link: '#' },
    // Closed: a booking on it is rejected (see match), to try the failed-row flow.
    7001: { issue_internal_id: 7001, issue_external_id: '701', label: 'Legacy portal cleanup', project: 'Customer Portal', milestone: 'Archive', link: '#' },
  },
  // booking-suggestions by meeting title: "Sprint planning" has a full history
  // (preselected + two history suggestions + one "time" suggestion), "Design
  // sync" only time suggestions, anything else (e.g. "Customer call") nothing.
  bookingSuggestions(title) {
    const issue = (id, reason) => ({ ...this.issueCatalog[id], ...(reason ? { reason } : {}) });
    const t = String(title || '').trim().toLowerCase();
    if (t === 'sprint planning') {
      return { preselected: issue(4001), suggestions: [issue(5001, 'history'), issue(1001, 'history'), issue(2001, 'time')], history_count: 23 };
    }
    if (t === 'design sync') {
      return { preselected: null, suggestions: [issue(3001, 'time'), issue(1002, 'time')], history_count: 0 };
    }
    return { preselected: null, suggestions: [], history_count: 0 };
  },
  myBookmarks() {
    return { issues: this.bookmarked.map((id) => this.issueCatalog[id] || { issue_internal_id: id, issue_external_id: String(id), label: 'Issue ' + id, project: '' }).map((i) => ({ ...i, bookmarked: true })) };
  },

  frequent: {
    issues: [
      { issue_internal_id: 1001, issue_external_id: '101', label: 'Team standup', project: 'Project Alpha', link: '#', frequency: 51, suggested_minutes: 15, suggested_label: '0:15' },
      { issue_internal_id: 2001, issue_external_id: '201', label: 'Retainer daily', project: 'Project Beta', link: '#', frequency: 38, suggested_minutes: 15, suggested_label: '0:15' },
      { issue_internal_id: 3001, issue_external_id: '301', label: 'Development daily / weekly', project: 'Project Gamma', link: '#', frequency: 33, suggested_minutes: 15, suggested_label: '0:15' },
      { issue_internal_id: 1002, issue_external_id: '102', label: 'Weekly company meeting', project: 'Internal', link: '#', frequency: 8, suggested_minutes: 30, suggested_label: '0:30' },
    ],
  },
  search: {
    issues: [
      { issue_internal_id: 4001, issue_external_id: '401', label: 'Development - daily meeting', project: 'Project Delta', milestone: 'Development', link: '#' },
      { issue_internal_id: 5001, issue_external_id: '501', label: 'Meetings / daily / planning', project: 'Project Epsilon', milestone: 'Project Management', link: '#' },
      { issue_internal_id: 7001, issue_external_id: '701', label: 'Legacy portal cleanup', project: 'Customer Portal', milestone: 'Archive', link: '#' },
    ],
  },
  // PM mode: the same rows with a uid (never on "Others").
  get pmIssueTime() {
    const uids = { 'Alice Example': 100, 'Bob Example': 101 };
    return { ...this.issueTime, tracked_time: this.issueTime.tracked_time.map((r) => ({ ...r, uid: uids[r.user] })).concat([{ user: 'Others', time_spent: 12, self: false, others: true }]), total_sum: this.issueTime.total_sum + 12 };
  },
  issueTime: {
    tracked_time: [
      { user: 'Alice Example', time_spent: 90, self: true },
      { user: 'Bob Example', time_spent: 25, self: false },
    ],
    own_sum: 90,
    total_sum: 115,
    issue: { open: true, external_id: '42', title: 'Fix login redirect' },
    details: [
      { user: 'Alice Example', start_time: '2026-10-22 08:30', stop_time: '2026-10-22 09:20', time_spent: 50, comment: '<p>Reviewed the MR.</p>' },
      { user: 'Bob Example', start_time: '2026-10-22 13:00', stop_time: '2026-10-22 13:25', time_spent: 25, comment: null },
      { user: 'Alice Example', start_time: '2026-10-21 09:00', stop_time: '2026-10-21 09:40', time_spent: 40, comment: 'Reproduced the redirect loop' },
    ],
  },

  // A created entry shows up on its day (issue details from the known demo issues).
  addEntry(body) {
    const id = this.nextId++;
    const date = body.date || this.ymd(new Date());
    const dur = Number(body.duration) || 15;
    const [h, m] = String(body.start_time || '09:00').split(':').map(Number);
    const stop = h * 60 + m + dur;
    const known = this.entries.concat(this.search.issues.map((i) => ({
      issue_internal_id: i.issue_internal_id, issue_label: i.label, issue_external_id: i.issue_external_id, project: i.project, milestone: i.milestone,
    }))).find((e) => e.issue_internal_id === body.issue_internal_id) || {};
    (this.added[date] = this.added[date] || []).push({
      id, start: body.start_time || '09:00', stop: `${this.pad(Math.floor(stop / 60) % 24)}:${this.pad(stop % 60)}`,
      duration_minutes: dur, duration_label: this.fmt(dur), project: known.project || 'Project Alpha', milestone: known.milestone || '',
      issue_label: known.issue_label || 'Demo issue', issue_external_id: known.issue_external_id || '1', issue_internal_id: body.issue_internal_id || 1,
      issue_link: '', comment: body.comment || '', status: 'unbooked', editable: true, break_label: null, active: false,
    });
    return { id, time_spent: dur };
  },

  // .ics feed with the demo calendar on the weekdays around today.
  ics() {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    const today = new Date();
    for (let i = -21; i <= 21; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const day = this.ymd(d).replace(/-/g, '');
      this.calendar.forEach(([title, start, end, uid]) => {
        lines.push('BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${day}T${start}00`, `DTEND:${day}T${end}00`, 'END:VEVENT');
      });
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  },

  // Fixtures mode only: a chrome.storage / runtime stand-in so the calendar
  // placeholders, calendar memory and sync status render offline.
  installChrome() {
    const chrome = window.chrome || (window.chrome = {});
    if (chrome.storage && chrome.storage.local) return;
    const store = {
      icalRaw: this.ics(),
      omnitimeCalIssues: this.calIssues,
      omnitimeCalSyncedAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
      googleUserInfo: { email: 'demo.user@example.test' },
    };
    const listeners = new Set();
    chrome.storage = {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => {
          const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
          Object.assign(store, obj);
          listeners.forEach((fn) => fn(changes, 'local'));
          if (cb) cb();
        },
      },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    };
    chrome.runtime = chrome.runtime || {};
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.action === 'OMNI_FORCE_SYNC_ICAL') chrome.storage.local.set({ omnitimeCalSyncedAt: new Date().toISOString() });
      if (cb) setTimeout(() => cb({ success: true, notModified: true }), 50);
    };
  },

  match(method, url, body) {
    if (method === 'POST' && /\/bookmark(\?|$)/.test(url)) {
      const id = Number(body && body.issue_internal_id);
      if (!this.bookmarked.includes(id)) this.bookmarked.unshift(id);
      return { issue_internal_id: id, bookmarked: true };
    }
    if (method === 'DELETE' && /\/bookmark\/\d+/.test(url)) {
      const id = Number(url.match(/\/bookmark\/(\d+)/)[1]);
      this.bookmarked = this.bookmarked.filter((x) => x !== id);
      return null;
    }
    if (method === 'POST' && body && body.issue_internal_id === 7001) return { __status: 400, message: 'The issue is closed.' };
    if (method === 'POST') return this.addEntry(body || {});
    if (method === 'PATCH') return { id: 999999, ok: true };
    if (method === 'DELETE') {
      const id = Number((url.match(/\/time-entry\/(\d+)/) || [])[1]);
      Object.keys(this.added).forEach((d) => { this.added[d] = this.added[d].filter((e) => e.id !== id); });
      return { ok: true };
    }
    if (url.includes('/my-tracked-time')) {
      const m = url.match(/[?&]date=([^&]+)/);
      const date = m ? decodeURIComponent(m[1]) : this.ymd(new Date());
      return this.buildMyDay(date);
    }
    if (url.includes('/my-tracked-week')) {
      const m = url.match(/[?&]date=([^&]+)/);
      const date = m ? decodeURIComponent(m[1]) : this.ymd(new Date());
      const u = url.match(/[?&]uid=(\d+)/);
      if (u) return this.pm ? this.buildColleagueWeek(date, Number(u[1])) : { __status: 403, message: 'Permission required.' };
      return this.buildWeek(date);
    }
    if (url.includes('/people')) {
      if (!this.pm) return { __status: 403, message: 'Permission required.' };
      const m = url.match(/[?&]q=([^&]*)/);
      return this.findPeople(m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '');
    }
    if (url.includes('/booking-suggestions')) {
      const m = url.match(/[?&]title=([^&]*)/);
      return this.bookingSuggestions(m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '');
    }
    if (url.includes('/my-bookmarks')) return this.myBookmarks();
    if (url.includes('/frequent-issues')) return this.frequent;
    if (url.includes('/issue-search')) {
      return { issues: this.search.issues.map((i) => ({ ...i, bookmarked: this.bookmarked.includes(i.issue_internal_id) })) };
    }
    if (url.includes('/tracked-time')) return this.pm ? this.pmIssueTime : this.issueTime;
    return {};
  },
};
