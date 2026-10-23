// Calendar memory (chrome.storage.local omnitimeCalLinks / omnitimeCalIssues):
// remembered meeting issues expire (180 days) and are capped (300 series),
// legacy entries get a timestamp, and writes are serialised so two callers in
// one page can't overwrite each other.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, read, makeEvent, settle } = require('./helpers');

const DAY = 864e5;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

// recordCalBooking / updateCalMemory are module-private; the export object
// belongs to someone else, so the test source adds a probe in front of it.
function load(initial, { slow = false } = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const chrome = {
    storage: {
      local: {
        // `slow` lets a second caller start between a read and its write.
        get: (keys, cb) => {
          const out = Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, JSON.parse(JSON.stringify(store[k]))]));
          if (slow) setTimeout(() => cb(out), 10); else cb(out);
        },
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
  };
  const env = loadDom([], { chrome });
  env.window.eval(read('core.js').replace('window.OmniTime = {', 'window.__calMem = { recordCalBooking, updateCalMemory };\n  window.OmniTime = {'));
  return { ...env, store, mem: env.window.__calMem };
}

const series = (n) => `uid:s${n}`;
const cal = (n, title = `Meeting ${n}`) => ({ uid: `s${n}`, title, originalStart: 600, key: `uid:s${n}@2026-10-21T10:00` });

describe('meeting memory retention', () => {
  it('forgets series that were not booked for 180 days on the next write', async () => {
    const t = load({
      omnitimeCalIssues: {
        [series(1)]: { id: 1, label: 'Old', title: 'Old meeting', at: iso(200), history: [] },
        [series(2)]: { id: 2, label: 'Recent', title: 'Recent meeting', at: iso(170), history: [] },
      },
    });
    await t.mem.updateCalMemory(() => {});
    assert.deepEqual(Object.keys(t.store.omnitimeCalIssues), [series(2)]);
  });

  it('stamps legacy entries (from their newest history item, else now) instead of dropping them', async () => {
    const t = load({
      omnitimeCalIssues: {
        [series(1)]: { id: 1, label: 'A', title: 'A', history: [{ id: 1, label: 'A', at: iso(10) }] },
        [series(2)]: { id: 2, label: 'B', title: 'B' },
        [series(3)]: { id: 3, label: 'C', title: 'C', history: [{ id: 3, label: 'C', at: iso(300) }] },
      },
    });
    const before = Date.now();
    await t.mem.updateCalMemory(() => {});
    const issues = t.store.omnitimeCalIssues;
    assert.equal(issues[series(1)].at, issues[series(1)].history[0].at);
    assert.ok(Date.parse(issues[series(2)].at) >= before - 1000, 'no history: stamped now');
    assert.equal(issues[series(3)], undefined, 'a legacy entry whose last booking is old expires');
  });

  it('keeps at most 300 series, the newest by last booking', async () => {
    const issues = {};
    // Series 0 was booked most recently, series 304 the longest ago (all within 180 days).
    for (let i = 0; i < 305; i++) issues[series(i)] = { id: i, label: `L${i}`, title: `T${i}`, at: new Date(Date.now() - (i + 1) * 3600e3).toISOString() };
    const t = load({ omnitimeCalIssues: issues });
    await t.mem.updateCalMemory(() => {});
    const kept = Object.keys(t.store.omnitimeCalIssues);
    assert.equal(kept.length, 300);
    assert.ok(kept.includes(series(0)) && kept.includes(series(299)));
    assert.ok(!kept.includes(series(300)) && !kept.includes(series(304)));
  });

  it('stamps a booking with its time (drives the expiry)', async () => {
    const t = load({});
    const before = Date.now();
    await t.mem.recordCalBooking(cal(1), 9, '2026-10-21', { id: 70, label: 'Issue 70' });
    const rec = t.store.omnitimeCalIssues[series(1)];
    assert.ok(Date.parse(rec.at) >= before - 1000);
    assert.equal(rec.at, rec.history[0].at);
    assert.equal(rec.id, 70);
  });
});

describe('meeting memory writes', () => {
  it('two concurrent bookings both persist (no lost update)', async () => {
    const t = load({}, { slow: true });
    await Promise.all([
      t.mem.recordCalBooking(cal(1), 11, '2026-10-21', { id: 70, label: 'Issue 70' }),
      t.mem.recordCalBooking(cal(2), 12, '2026-10-21', { id: 71, label: 'Issue 71' }),
    ]);
    await settle(5);
    assert.deepEqual(Object.keys(t.store.omnitimeCalIssues).sort(), [series(1), series(2)]);
    assert.deepEqual(Object.keys(t.store.omnitimeCalLinks).sort(), [cal(1).key, cal(2).key]);
  });

  it('a failing change does not block the writes queued behind it', async () => {
    const t = load({});
    const failing = t.mem.updateCalMemory(() => { throw new Error('bad change'); });
    const ok = t.mem.recordCalBooking(cal(3), 13, '2026-10-21', { id: 72, label: 'Issue 72' });
    await assert.rejects(failing, /bad change/);
    await ok;
    assert.ok(t.store.omnitimeCalIssues[series(3)]);
  });
});
