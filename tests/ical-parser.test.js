const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom } = require('./helpers');

const { window } = loadDom(['ical-parser.js']);
// Results come from the jsdom realm; clone them so deepStrictEqual compares
// values rather than Array prototypes from two different realms.
const Cal = Object.fromEntries(Object.entries(window.OmniTimeCal)
  .map(([name, fn]) => [name, (...args) => JSON.parse(JSON.stringify(fn(...args)))]));

const ics = (...events) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  ...events.flatMap((ev) => ['BEGIN:VEVENT', ...ev, 'END:VEVENT']),
  'END:VCALENDAR',
].join('\r\n');

// Week of Monday 2026-07-13 (CEST, UTC+2).
const WEEK = '2026-07-13';

describe('weekMonday', () => {
  it('returns the Monday of the week for any day', () => {
    assert.equal(Cal.weekMonday('2026-07-13'), '2026-07-13');
    assert.equal(Cal.weekMonday('2026-07-17'), '2026-07-13');
    assert.equal(Cal.weekMonday('2026-07-19'), '2026-07-13'); // Sunday
  });
});

describe('cleanTitle', () => {
  it('strips punctuation but keeps letters and digits from any script', () => {
    assert.equal(Cal.cleanTitle('[ACME] Daily: Sprint #12 — Планиране!'), 'ACME Daily Sprint 12 Планиране');
    assert.equal(Cal.cleanTitle(null), '');
  });
});

describe('parseICalForWeek', () => {
  it('converts UTC and TZID times to local minutes', () => {
    const text = ics(
      ['SUMMARY:UTC call', 'DTSTART:20260714T080000Z', 'DTEND:20260714T083000Z'],
      ['SUMMARY:Sofia call', 'DTSTART;TZID=Europe/Sofia:20260715T120000', 'DURATION:PT45M'],
    );
    const events = Cal.parseICalForWeek(text, WEEK);
    const utc = events.find((e) => e.title === 'UTC call');
    assert.deepEqual([utc.date, utc.startMinutes, utc.endMinutes], ['2026-07-14', 10 * 60, 10 * 60 + 30]);
    const sofia = events.find((e) => e.title === 'Sofia call');
    // 12:00 in Sofia (UTC+3) is 11:00 in Berlin (UTC+2).
    assert.deepEqual([sofia.date, sofia.startMinutes, sofia.durationMinutes], ['2026-07-15', 11 * 60, 45]);
  });

  it('skips all-day, cancelled and out-of-week events', () => {
    const text = ics(
      ['SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260714', 'DTEND;VALUE=DATE:20260715'],
      ['SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20260714T090000Z', 'DTEND:20260714T100000Z'],
      ['SUMMARY:Next week', 'DTSTART:20260721T090000Z', 'DTEND:20260721T100000Z'],
    );
    assert.deepEqual(Cal.parseICalForWeek(text, WEEK), []);
  });

  it('expands weekly RRULEs and honours EXDATE', () => {
    const text = ics([
      'SUMMARY:Standup',
      'DTSTART;TZID=Europe/Berlin:20260601T093000',
      'DTEND;TZID=Europe/Berlin:20260601T094500',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'EXDATE;TZID=Europe/Berlin:20260715T093000',
    ]);
    const days = Cal.parseICalForWeek(text, WEEK).map((e) => e.date);
    assert.deepEqual(days.sort(), ['2026-07-13', '2026-07-17']);
  });

  it('replaces a moved occurrence with its RECURRENCE-ID override', () => {
    const text = ics(
      ['UID:x', 'SUMMARY:Sync', 'DTSTART:20260713T080000Z', 'DTEND:20260713T090000Z', 'RRULE:FREQ=DAILY;COUNT=3'],
      ['UID:x', 'SUMMARY:Sync (moved)', 'RECURRENCE-ID:20260714T080000Z', 'DTSTART:20260714T120000Z', 'DTEND:20260714T130000Z'],
    );
    const tuesday = Cal.filterEventsForDate(Cal.parseICalForWeek(text, WEEK), '2026-07-14');
    assert.deepEqual(tuesday.map((e) => [e.title, e.startMinutes]), [['Sync (moved)', 14 * 60]]);
  });

  it('keeps the event UID so recurring occurrences can be recognised', () => {
    const text = ics(['UID:standup@example.test', 'SUMMARY:Standup', 'DTSTART:20260713T080000Z', 'DTEND:20260713T081500Z', 'RRULE:FREQ=DAILY;COUNT=2']);
    assert.deepEqual(Cal.parseICalForWeek(text, WEEK).map((e) => e.uid), ['standup@example.test', 'standup@example.test']);
  });

  it('unescapes summary, description and location', () => {
    const text = ics([
      'SUMMARY:Review\\, part 2',
      'DESCRIPTION:Line 1\\nLine 2',
      'LOCATION:Room 4\\, 2nd floor',
      'DTSTART:20260716T070000Z',
      'DTEND:20260716T080000Z',
    ]);
    const [ev] = Cal.parseICalForWeek(text, WEEK);
    assert.equal(ev.title, 'Review, part 2');
    assert.equal(ev.description, 'Line 1\nLine 2');
    assert.equal(ev.location, 'Room 4, 2nd floor');
  });
});

describe('parseGoogleCalJsonForWeek', () => {
  const item = (summary, start, end, extra = {}) => ({ summary, start: { dateTime: start }, end: { dateTime: end }, ...extra });

  it('maps timed events in the week and skips all-day, cancelled and other weeks', () => {
    const json = {
      items: [
        item('Planning', '2026-07-14T10:00:00+02:00', '2026-07-14T11:30:00+02:00', { location: 'Room 1' }),
        { summary: 'Vacation', start: { date: '2026-07-15' }, end: { date: '2026-07-16' } },
        item('Dropped', '2026-07-15T10:00:00+02:00', '2026-07-15T11:00:00+02:00', { status: 'cancelled' }),
        item('Later', '2026-07-22T10:00:00+02:00', '2026-07-22T11:00:00+02:00'),
      ],
    };
    const events = Cal.parseGoogleCalJsonForWeek(json, WEEK);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Planning');
    assert.equal(events[0].location, 'Room 1');
    assert.deepEqual([events[0].date, events[0].startMinutes, events[0].durationMinutes], ['2026-07-14', 600, 90]);
  });

  it('uses iCalUID so the key matches the same event from the iCal feed', () => {
    const json = { items: [item('Standup', '2026-07-14T09:00:00+02:00', '2026-07-14T09:15:00+02:00', { id: 'abc_20260714', iCalUID: 'standup@example.test', recurringEventId: 'abc' })] };
    assert.equal(Cal.parseGoogleCalJsonForWeek(json, WEEK)[0].uid, 'standup@example.test');
  });

  it('returns nothing for an empty or missing payload', () => {
    assert.deepEqual(Cal.parseGoogleCalJsonForWeek(null, WEEK), []);
    assert.deepEqual(Cal.parseGoogleCalJsonForWeek({}, WEEK), []);
  });
});

describe('calendar filters', () => {
  const when = ['DTSTART:20260714T090000Z', 'DTEND:20260714T100000Z'];

  it('iCal: drops free (TRANSP:TRANSPARENT) events but keeps opaque ones', () => {
    const text = ics(['SUMMARY:Free', 'TRANSP:TRANSPARENT', ...when], ['SUMMARY:Busy', 'TRANSP:OPAQUE', ...when]);
    assert.deepEqual(Cal.parseICalForWeek(text, WEEK).map((e) => e.title), ['Busy']);
  });

  it('iCal: drops cancelled override occurrences too', () => {
    const text = ics(['UID:x', 'RECURRENCE-ID:20260714T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Gone', ...when]);
    assert.deepEqual(Cal.parseICalForWeek(text, WEEK), []);
  });

  it('iCal: drops events the signed-in user declined, only when the email is known', () => {
    const text = ics(['SUMMARY:Declined', 'ATTENDEE;PARTSTAT=DECLINED;CN=Me:mailto:Me@Example.test', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.test', ...when]);
    assert.equal(Cal.parseICalForWeek(text, WEEK).length, 1);
    assert.equal(Cal.parseICalForWeek(text, WEEK, { selfEmail: 'someone@example.test' }).length, 1);
    assert.equal(Cal.parseICalForWeek(text, WEEK, { selfEmail: 'me@example.test' }).length, 0);
  });

  it('iCal: someone else declining does not hide the event', () => {
    const text = ics(['SUMMARY:Kept', 'ATTENDEE;PARTSTAT=DECLINED:mailto:other@example.test', ...when]);
    assert.equal(Cal.parseICalForWeek(text, WEEK, { selfEmail: 'me@example.test' }).length, 1);
  });

  const g = (extra) => ({ items: [{ summary: 'E', start: { dateTime: '2026-07-14T10:00:00+02:00' }, end: { dateTime: '2026-07-14T11:00:00+02:00' }, ...extra }] });

  it('Google: drops transparent events', () => {
    assert.equal(Cal.parseGoogleCalJsonForWeek(g({ transparency: 'transparent' }), WEEK).length, 0);
    assert.equal(Cal.parseGoogleCalJsonForWeek(g({ transparency: 'opaque' }), WEEK).length, 1);
  });

  it('Google: drops events the user declined, keeps other attendees\' declines', () => {
    const declined = { attendees: [{ email: 'a@example.test', self: true, responseStatus: 'declined' }] };
    const other = { attendees: [{ email: 'b@example.test', responseStatus: 'declined' }, { email: 'a@example.test', self: true, responseStatus: 'accepted' }] };
    assert.equal(Cal.parseGoogleCalJsonForWeek(g(declined), WEEK).length, 0);
    assert.equal(Cal.parseGoogleCalJsonForWeek(g(other), WEEK).length, 1);
  });

  it('Google: keeps default events, drops out-of-office, focus-time, working-location and Gmail items', () => {
    assert.equal(Cal.parseGoogleCalJsonForWeek(g({ eventType: 'default' }), WEEK).length, 1);
    assert.equal(Cal.parseGoogleCalJsonForWeek(g({}), WEEK).length, 1, 'no eventType (older payloads) is a meeting');
    ['outOfOffice', 'focusTime', 'workingLocation', 'fromGmail', 'birthday'].forEach((eventType) => {
      assert.equal(Cal.parseGoogleCalJsonForWeek(g({ eventType }), WEEK).length, 0, eventType);
    });
  });

  it('Google: parses the reduced shape the sync requests (fields=)', () => {
    const reduced = { items: [{
      id: 'a1', iCalUID: 'a1@google.com', recurringEventId: 'r1', summary: 'Planning', description: 'd', location: 'Room',
      start: { dateTime: '2026-07-14T10:00:00+02:00' }, end: { dateTime: '2026-07-14T11:00:00+02:00' },
      status: 'confirmed', transparency: 'opaque', eventType: 'default', attendees: [{ self: true, responseStatus: 'accepted' }],
    }] };
    const [ev] = Cal.parseGoogleCalJsonForWeek(reduced, WEEK);
    assert.deepEqual([ev.title, ev.uid, ev.location, ev.durationMinutes], ['Planning', 'a1@google.com', 'Room', 60]);
  });

  it('Google: drops cancelled and all-day events', () => {
    assert.equal(Cal.parseGoogleCalJsonForWeek(g({ status: 'cancelled' }), WEEK).length, 0);
    const allDay = { items: [{ summary: 'Day', start: { date: '2026-07-14' }, end: { date: '2026-07-15' } }] };
    assert.equal(Cal.parseGoogleCalJsonForWeek(allDay, WEEK).length, 0);
  });
});
