// ical-parser.js — Lightweight iCal (.ics) parser for OmniTime.
// Parses VEVENT blocks, handles RRULE expansion (DAILY, WEEKLY, MONTHLY, YEARLY)
// and converts all timestamps to the user's local timezone.
// No external dependencies.

(function () {
  'use strict';

  // ---- Helpers ----

  // Parse an iCal date/time string into a JS Date in the correct timezone.
  // Formats:
  //   "20260717T130000Z"        → UTC
  //   "20260717T130000"         → interpreted as tzid or local
  //   "20260717"                → all-day (date only)
  function parseICalDate(raw, tzid) {
    if (!raw) return null;
    const dateOnly = raw.length === 8; // YYYYMMDD
    const y = parseInt(raw.slice(0, 4), 10);
    const mo = parseInt(raw.slice(4, 6), 10) - 1;
    const d = parseInt(raw.slice(6, 8), 10);
    if (dateOnly) return { date: new Date(y, mo, d), allDay: true };

    const h = parseInt(raw.slice(9, 11), 10);
    const mi = parseInt(raw.slice(11, 13), 10);
    const s = parseInt(raw.slice(13, 15), 10) || 0;
    const isUtc = raw.endsWith('Z');

    if (isUtc) {
      return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
    }

    if (tzid) {
      // Build the date in its declared timezone, then let the browser convert
      // to local. We use a trick: construct in UTC and adjust by the tz offset.
      const utcGuess = new Date(Date.UTC(y, mo, d, h, mi, s));
      const offset = getTzOffset(utcGuess, tzid);
      // offset is "minutes ahead of UTC" for that timezone at that instant.
      // The wall-clock time in tzid is UTC + offset, so the true UTC is
      // wall-clock - offset.
      const trueUtc = new Date(Date.UTC(y, mo, d, h, mi - offset, s));
      return { date: trueUtc, allDay: false };
    }

    // Floating time — treat as user's local.
    return { date: new Date(y, mo, d, h, mi, s), allDay: false };
  }

  // Get the UTC offset (in minutes) for a given timezone at a given instant.
  // Returns positive for east of UTC (e.g. +180 for Europe/Sofia in summer).
  function getTzOffset(instant, tzid) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = {};
      fmt.formatToParts(instant).forEach((p) => { parts[p.type] = p.value; });
      // Reconstruct the wall-clock time as a UTC date for offset calculation.
      const wall = Date.UTC(
        parseInt(parts.year, 10),
        parseInt(parts.month, 10) - 1,
        parseInt(parts.day, 10),
        parseInt(parts.hour, 10) % 24,
        parseInt(parts.minute, 10),
        parseInt(parts.second, 10)
      );
      return (wall - instant.getTime()) / 60000;
    } catch (e) {
      // Unknown timezone — fall back to treating as local.
      return -instant.getTimezoneOffset();
    }
  }

  // ---- iCal line unfolding ----
  // RFC 5545 §3.1: long lines are folded with CRLF + space/tab.
  function unfold(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // ---- Parse a property line ----
  // Returns { name, params: { TZID, VALUE, ... }, value }
  function parseLine(line) {
    // Property line: NAME;PARAM=VAL;PARAM=VAL:VALUE
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return { name: '', params: {}, value: line };
    const left = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const parts = left.split(';');
    const name = parts[0].toUpperCase();
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq !== -1) {
        params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
      }
    }
    return { name, params, value };
  }

  // ---- Extract VEVENT blocks ----
  function extractEvents(text) {
    const lines = unfold(text).split('\n');
    const events = [];
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'BEGIN:VEVENT') { current = {}; continue; }
      if (trimmed === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
      if (!current) continue;
      const parsed = parseLine(trimmed);
      switch (parsed.name) {
        case 'UID':
          current.uid = parsed.value;
          break;
        case 'SUMMARY':
          current.summary = parsed.value.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
          break;
        case 'DESCRIPTION':
          current.description = parsed.value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
          break;
        case 'LOCATION':
          current.location = parsed.value.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
          break;
        case 'DTSTART':
          current.dtstart = parsed.value;
          current.dtstartTzid = parsed.params.TZID || null;
          current.dtstartValueType = parsed.params.VALUE || null;
          break;
        case 'DTEND':
          current.dtend = parsed.value;
          current.dtendTzid = parsed.params.TZID || null;
          break;
        case 'DURATION':
          current.duration = parsed.value;
          break;
        case 'RRULE':
          current.rrule = parseRRule(parsed.value);
          break;
        case 'EXDATE':
          if (!current.exdates) current.exdates = [];
          // EXDATE can have TZID too; we parse each date.
          parsed.value.split(',').forEach((v) => {
            const ex = parseICalDate(v.trim(), parsed.params.TZID || null);
            if (ex) current.exdates.push(ex.date.getTime());
          });
          break;
        case 'STATUS':
          current.status = parsed.value.toUpperCase();
          break;
        case 'TRANSP':
          current.transp = parsed.value.toUpperCase();
          break;
        case 'ATTENDEE':
          if ((parsed.params.PARTSTAT || '').toUpperCase() === 'DECLINED') {
            if (!current.declined) current.declined = [];
            current.declined.push(parsed.value.replace(/^mailto:/i, '').trim().toLowerCase());
          }
          break;
        case 'RECURRENCE-ID':
          current.recurrenceId = parsed.value;
          current.recurrenceIdTzid = parsed.params.TZID || null;
          break;
      }
    }
    return events;
  }

  // Events that should not become placeholders: cancelled, free (transparent)
  // and, when the signed-in email is known, declined by that attendee.
  function isSkippedIcalEvent(ev, selfEmail) {
    if (ev.status === 'CANCELLED' || ev.transp === 'TRANSPARENT') return true;
    const me = String(selfEmail || '').trim().toLowerCase();
    return !!(me && ev.declined && ev.declined.includes(me));
  }

  // Same for a Google Calendar API item (all-day items have start.date only).
  // Out-of-office, focus-time, working-location and Gmail items are not meetings.
  function isSkippedGoogleEvent(ev) {
    if (!ev || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return true;
    if (ev.eventType && ev.eventType !== 'default') return true;
    if (ev.status === 'cancelled' || ev.transparency === 'transparent') return true;
    return (ev.attendees || []).some((a) => a && a.self === true && a.responseStatus === 'declined');
  }

  // ---- RRULE parser ----
  function parseRRule(value) {
    const rule = {};
    value.split(';').forEach((part) => {
      const [k, v] = part.split('=');
      if (!v) return;
      switch (k) {
        case 'FREQ': rule.freq = v; break;
        case 'COUNT': rule.count = parseInt(v, 10); break;
        case 'UNTIL': rule.until = v; break;
        case 'INTERVAL': rule.interval = parseInt(v, 10) || 1; break;
        case 'BYDAY': rule.byday = v.split(','); break;
        case 'BYMONTHDAY': rule.bymonthday = v.split(',').map(Number); break;
        case 'BYMONTH': rule.bymonth = v.split(',').map(Number); break;
        case 'WKST': rule.wkst = v; break;
      }
    });
    if (!rule.interval) rule.interval = 1;
    return rule;
  }

  // ---- RRULE expansion ----
  // Given a VEVENT's original start Date and an RRULE, generate all occurrence
  // start Dates that fall within [rangeStart, rangeEnd).
  const DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  function expandRRule(originalStart, rrule, rangeStart, rangeEnd, exdates) {
    const results = [];
    const until = rrule.until ? (parseICalDate(rrule.until, null) || {}).date : null;
    const maxDate = until && until < rangeEnd ? until : rangeEnd;
    const maxCount = rrule.count || 10000;
    const interval = rrule.interval;
    const exSet = new Set((exdates || []).map((t) => {
      // Normalise exdates to midnight local for date-level comparison.
      const d = new Date(t);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }));
    const isExcluded = (dt) => exSet.has(`${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`);

    let count = 0;
    const addIfInRange = (dt) => {
      if (count >= maxCount) return false;
      if (dt >= maxDate) return false;
      count++;
      if (dt >= rangeStart && !isExcluded(dt)) results.push(new Date(dt));
      return true;
    };

    switch (rrule.freq) {
      case 'DAILY': {
        const cur = new Date(originalStart);
        while (cur < maxDate && count < maxCount) {
          addIfInRange(cur);
          cur.setDate(cur.getDate() + interval);
        }
        break;
      }
      case 'WEEKLY': {
        if (rrule.byday && rrule.byday.length) {
          const dayNums = rrule.byday.map((d) => DAY_NAMES.indexOf(d.replace(/^[+-]?\d*/, ''))).filter((n) => n >= 0);
          // Walk week by week from the original start.
          const cur = new Date(originalStart);
          // Align to the start of the week (Monday or per WKST).
          const wkst = rrule.wkst ? DAY_NAMES.indexOf(rrule.wkst) : 1; // default MO
          while (cur.getDay() !== wkst) cur.setDate(cur.getDate() - 1);
          while (cur < maxDate && count < maxCount) {
            for (const dn of dayNums) {
              const occ = new Date(cur);
              const diff = (dn - wkst + 7) % 7;
              occ.setDate(cur.getDate() + diff);
              occ.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds());
              if (occ >= originalStart && !addIfInRange(occ)) break;
            }
            cur.setDate(cur.getDate() + 7 * interval);
          }
        } else {
          const cur = new Date(originalStart);
          while (cur < maxDate && count < maxCount) {
            addIfInRange(cur);
            cur.setDate(cur.getDate() + 7 * interval);
          }
        }
        break;
      }
      case 'MONTHLY': {
        const cur = new Date(originalStart);
        if (rrule.bymonthday && rrule.bymonthday.length) {
          while (cur < maxDate && count < maxCount) {
            for (const md of rrule.bymonthday) {
              const occ = new Date(cur.getFullYear(), cur.getMonth(), md, originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds());
              if (occ >= originalStart) addIfInRange(occ);
            }
            cur.setMonth(cur.getMonth() + interval);
          }
        } else {
          while (cur < maxDate && count < maxCount) {
            addIfInRange(cur);
            cur.setMonth(cur.getMonth() + interval);
          }
        }
        break;
      }
      case 'YEARLY': {
        const cur = new Date(originalStart);
        while (cur < maxDate && count < maxCount) {
          addIfInRange(cur);
          cur.setFullYear(cur.getFullYear() + interval);
        }
        break;
      }
    }
    return results;
  }

  // ---- Duration parser (e.g. "PT30M", "PT1H30M", "P1DT2H") ----
  function parseDuration(dur) {
    if (!dur) return 0;
    let minutes = 0;
    const m = dur.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (m) {
      minutes += (parseInt(m[1], 10) || 0) * 1440;
      minutes += (parseInt(m[2], 10) || 0) * 60;
      minutes += parseInt(m[3], 10) || 0;
      if (parseInt(m[4], 10) > 0) minutes += 1; // round up seconds
    }
    return minutes;
  }

  // ---- Public API ----

  /**
   * Parse an .ics text and return calendar events for a given week.
   * @param {string} icsText  Raw .ics file contents.
   * @param {string} weekStartStr  ISO date of Monday (e.g. "2026-07-13").
   * @param {{selfEmail?: string}} [opts]  selfEmail: signed-in Google email, used to drop declined events.
   * @returns {Array<{title: string, date: string, startMinutes: number, endMinutes: number, durationMinutes: number}>}
   *   startMinutes/endMinutes are minutes since local midnight; date is the local ISO date.
   */
  function parseICalForWeek(icsText, weekStartStr, opts) {
    const selfEmail = opts && opts.selfEmail;
    const rawEvents = extractEvents(icsText);
    const weekStart = new Date(weekStartStr + 'T00:00:00');
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    // Build a set of recurrence-id overrides so we can skip their originals.
    const overrides = new Set();
    rawEvents.forEach((ev) => {
      if (ev.recurrenceId) {
        const rid = parseICalDate(ev.recurrenceId, ev.recurrenceIdTzid);
        if (rid) overrides.add(rid.date.getTime());
      }
    });

    const results = [];

    rawEvents.forEach((ev) => {
      if (!ev.dtstart) return;
      // RECURRENCE-ID overrides are added by the second pass below.
      if (ev.recurrenceId) return;
      // Skip cancelled, free (TRANSP:TRANSPARENT) and declined events.
      if (isSkippedIcalEvent(ev, selfEmail)) return;

      const isDateOnly = ev.dtstartValueType === 'DATE' || ev.dtstart.length === 8;
      if (isDateOnly) return; // Filter out all-day events.

      const startParsed = parseICalDate(ev.dtstart, ev.dtstartTzid);
      if (!startParsed || startParsed.allDay) return;

      // Calculate duration in minutes.
      let durationMin = 0;
      if (ev.duration) {
        durationMin = parseDuration(ev.duration);
      } else if (ev.dtend) {
        const endParsed = parseICalDate(ev.dtend, ev.dtendTzid);
        if (endParsed) {
          durationMin = Math.round((endParsed.date.getTime() - startParsed.date.getTime()) / 60000);
        }
      }
      if (durationMin <= 0) durationMin = 30; // default fallback

      const title = ev.summary || '(No title)';

      const addOccurrence = (occStart) => {
        // occStart is a local Date representing when this occurrence starts.
        const localDate = `${occStart.getFullYear()}-${String(occStart.getMonth() + 1).padStart(2, '0')}-${String(occStart.getDate()).padStart(2, '0')}`;
        const startMin = occStart.getHours() * 60 + occStart.getMinutes();
        let endMin = startMin + durationMin;
        // Cap at midnight for display.
        if (endMin > 24 * 60) endMin = 24 * 60;
        results.push({
          title,
          uid: ev.uid || '',
          description: ev.description || '',
          location: ev.location || '',
          date: localDate,
          startMinutes: startMin,
          endMinutes: endMin,
          durationMinutes: durationMin,
        });
      };

      if (ev.rrule) {
        // Expand recurring events over the week range.
        const occurrences = expandRRule(startParsed.date, ev.rrule, weekStart, weekEnd, ev.exdates);
        occurrences.forEach((occ) => {
          if (!overrides.has(occ.getTime())) addOccurrence(occ);
        });
      } else {
        // Single event: check if its local start falls in the week range.
        const dt = startParsed.date;
        if (dt >= weekStart && dt < weekEnd) {
          addOccurrence(dt);
        }
      }
    });

    // Also process override events (RECURRENCE-ID) as standalone occurrences.
    rawEvents.forEach((ev) => {
      if (!ev.recurrenceId || !ev.dtstart) return;
      if (isSkippedIcalEvent(ev, selfEmail)) return;
      const isDateOnly = ev.dtstartValueType === 'DATE' || ev.dtstart.length === 8;
      if (isDateOnly) return;

      const startParsed = parseICalDate(ev.dtstart, ev.dtstartTzid);
      if (!startParsed || startParsed.allDay) return;
      const dt = startParsed.date;
      if (dt < weekStart || dt >= weekEnd) return;

      let durationMin = 0;
      if (ev.duration) {
        durationMin = parseDuration(ev.duration);
      } else if (ev.dtend) {
        const endParsed = parseICalDate(ev.dtend, ev.dtendTzid);
        if (endParsed) durationMin = Math.round((endParsed.date.getTime() - dt.getTime()) / 60000);
      }
      if (durationMin <= 0) durationMin = 30;

      const startMin = dt.getHours() * 60 + dt.getMinutes();
      let endMin = startMin + durationMin;
      if (endMin > 24 * 60) endMin = 24 * 60;
      results.push({
        title: ev.summary || '(No title)',
        uid: ev.uid || '',
        description: ev.description || '',
        location: ev.location || '',
        date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
        startMinutes: startMin,
        endMinutes: endMin,
        durationMinutes: durationMin,
      });
    });

    return results;
  }

  /**
   * Filter a week's parsed events to a single date.
   * @param {Array} weekEvents  Output of parseICalForWeek().
   * @param {string} dateStr    ISO date string (e.g. "2026-07-17").
   * @returns {Array} Events for that date, sorted by startMinutes.
   */
  function filterEventsForDate(weekEvents, dateStr) {
    return weekEvents
      .filter((e) => e.date === dateStr)
      .sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /**
   * Clean a meeting title for use as a search query.
   * Strips all punctuation/symbols, keeps letters and numbers from any script.
   * @param {string} s  Raw event title.
   * @returns {string}  Cleaned search string.
   */
  function cleanTitle(s) {
    return String(s || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Compute the Monday of the ISO week containing the given date string.
   * @param {string} dateStr ISO date "YYYY-MM-DD".
   * @returns {string} ISO date of Monday.
   */
  function weekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay(); // 0=Sun
    const diff = (day === 0 ? -6 : 1) - day; // Monday offset
    d.setDate(d.getDate() + diff);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Parse Google Calendar API JSON response.
   * @param {Object} json  JSON object from Google API.
   * @param {string} weekStart ISO date "YYYY-MM-DD" for Monday.
   * @returns {Array} List of simple event objects for the week.
   */
  function parseGoogleCalJsonForWeek(json, weekStart) {
    if (!json || !json.items) return [];

    const weekStartDate = new Date(weekStart + 'T00:00:00');
    const weekEndDate = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const results = [];

    json.items.forEach(ev => {
      // Ignore all-day, cancelled, free and declined events.
      if (isSkippedGoogleEvent(ev)) return;

      const dt = new Date(ev.start.dateTime);
      if (dt < weekStartDate || dt >= weekEndDate) return;

      const endDt = new Date(ev.end.dateTime);
      let durationMin = Math.round((endDt.getTime() - dt.getTime()) / 60000);
      if (durationMin <= 0) durationMin = 30;

      const startMin = dt.getHours() * 60 + dt.getMinutes();
      let endMin = startMin + durationMin;
      if (endMin > 24 * 60) endMin = 24 * 60;
      
      results.push({
        title: ev.summary || '(No title)',
        // iCalUID matches the UID in the iCal feed, so remembered issues
        // survive switching between the two calendar sources.
        uid: ev.iCalUID || ev.recurringEventId || ev.id || '',
        description: ev.description || '',
        location: ev.location || '',
        date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
        startMinutes: startMin,
        endMinutes: endMin,
        durationMinutes: durationMin,
      });
    });

    return results;
  }

  // Expose on window for use by core.js and content.js (the background
  // script has no window and loads this file for the reminder).
  (typeof window !== 'undefined' ? window : globalThis).OmniTimeCal = {
    parseICalForWeek,
    parseGoogleCalJsonForWeek,
    filterEventsForDate,
    cleanTitle,
    weekMonday,
  };
})();
