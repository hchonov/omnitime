// Offline, generic demo fixtures for the preview harness (no real data).
window.OMNI_FIXTURES = {
  // Demo entries (shown on weekdays). Includes adjacent short entries so the
  // no-overlap rendering can be exercised, plus one booked (locked) entry.
  entries: [
    { id: 101, start: '08:45', stop: '09:00', duration_minutes: 15, duration_label: '0:15', project: 'Project Alpha', milestone: 'Development', issue_label: 'Team standup', issue_external_id: '101', issue_internal_id: 1001, issue_link: '#', comment: 'Standup', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 102, start: '09:00', stop: '09:30', duration_minutes: 30, duration_label: '0:30', project: 'Internal', milestone: 'Project Management', issue_label: 'Weekly company meeting', issue_external_id: '102', issue_internal_id: 1002, issue_link: '#', comment: '', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 103, start: '10:20', stop: '11:05', duration_minutes: 45, duration_label: '0:45', project: 'Project Beta', milestone: 'Search', issue_label: 'Implement basic search', issue_external_id: '103', issue_internal_id: 1003, issue_link: '#', comment: 'Search setup', status: 'unbooked', editable: true, break_label: null, active: false },
    { id: 104, start: '13:25', stop: '17:25', duration_minutes: 240, duration_label: '4:00', project: 'Project Beta', milestone: 'Search', issue_label: 'Implement basic search', issue_external_id: '103', issue_internal_id: 1003, issue_link: '#', comment: 'Booked block', status: 'booked', editable: false, break_label: null, active: false },
  ],
  weekdayLabels: ['M', 'T', 'W', 'Th', 'F', 'S', 'Su'],
  entrySum() { return this.entries.reduce((s, e) => s + e.duration_minutes, 0); },

  pad(n) { return String(n).padStart(2, '0'); },
  fmt(mins) { return `${Math.floor(mins / 60)}:${this.pad(mins % 60)}`; },
  ymd(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },

  buildMyDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);

    const sum = this.entrySum();
    let weekTotal = 0;
    const week = this.weekdayLabels.map((label, i) => {
      const cell = new Date(monday);
      cell.setDate(monday.getDate() + i);
      const mins = i <= 4 ? sum : 0; // weekdays have the demo entries
      weekTotal += mins;
      return { label, date: this.ymd(cell), total_minutes: mins, total_label: this.fmt(mins), active: this.ymd(cell) === dateStr };
    });

    const isWeekend = dow >= 5;
    const entries = isWeekend ? [] : this.entries;
    const dayTotal = isWeekend ? 0 : sum;

    return {
      date: dateStr,
      week,
      week_total_minutes: weekTotal,
      week_total_label: this.fmt(weekTotal),
      day_total_minutes: dayTotal,
      day_total_label: this.fmt(dayTotal),
      entries,
    };
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
    ],
  },
  issueTime: {
    tracked_time: [
      { user: 'Alice Example', time_spent: 50 },
      { user: 'Bob Example', time_spent: 25 },
    ],
    total_sum: 75,
    details: [
      { user: 'Alice Example', start_time: '2026-06-11 09:00', stop_time: '2026-06-11 09:50', time_spent: 50, comment: '<p>Reviewed the MR.</p>' },
      { user: 'Bob Example', start_time: '2026-05-08 07:41', stop_time: '2026-05-08 07:56', time_spent: 25, comment: null },
    ],
  },

  match(method, url) {
    if (method === 'POST') return { id: 999999, time_spent: 15 };
    if (method === 'PATCH') return { id: 999999, ok: true };
    if (method === 'DELETE') return { ok: true };
    if (url.includes('/my-tracked-time')) {
      const m = url.match(/[?&]date=([^&]+)/);
      const date = m ? decodeURIComponent(m[1]) : this.ymd(new Date());
      return this.buildMyDay(date);
    }
    if (url.includes('/frequent-issues')) return this.frequent;
    if (url.includes('/issue-search')) return this.search;
    if (url.includes('/tracked-time')) return this.issueTime;
    return {};
  },
};
