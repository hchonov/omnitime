// Movable / resizable dialog (core.js attachMoveResize): drag by the header,
// resize from the edges, reset on double-click, remember + restore clamped.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, key, makeEvent, settle } = require('./helpers');

const plain = (v) => JSON.parse(JSON.stringify(v));
const api = () => {
  const ok = (v) => () => Promise.resolve(v);
  return {
    issueTime: ok({ tracked_time: [], total_sum: 0, details: [], issue: { open: true } }),
    myDay: (date) => Promise.resolve({ date, week: [], entries: [] }),
    frequent: ok({ issues: [] }),
    search: ok({ issues: [] }),
  };
};

// The viewport is jsdom's 1024x768 unless `size` says otherwise.
async function open({ stored = {}, tab = 'myday', size, noStorage = false } = {}) {
  const store = { ...stored };
  const chrome = noStorage ? {} : {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (m, cb) => cb && cb({ success: true, notModified: true }) },
  };
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome });
  const { window } = env;
  if (size) { window.innerWidth = size[0]; window.innerHeight = size[1]; }
  // jsdom has no layout: the dialog "measures" like the CSS-centred 880x600 one.
  window.Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList && this.classList.contains('omnitime-modal')) {
      const s = this.style;
      const px = (v, d) => (v ? parseFloat(v) : d);
      const w = px(s.width, 880);
      const h = px(s.height, 600);
      const x = px(s.left, (window.innerWidth - w) / 2);
      const y = px(s.top, (window.innerHeight - h) / 2);
      return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
    }
    return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  };
  window.OmniTime.openModal({
    apiClient: api(),
    context: { source: 'https://git.example.test', project_id: '3', issue_id: '14', issue_label: 'Demo' },
    activeTab: tab,
    settings: { dayStart: 8, dayEnd: 17 },
  });
  await settle();
  const root = uiRoot(env.document);
  const dialog = root.querySelector('.omnitime-modal');
  const ptr = (el, type, x, y, extra = {}) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
  const box = () => ({ x: parseFloat(dialog.style.left), y: parseFloat(dialog.style.top), w: parseFloat(dialog.style.width), h: parseFloat(dialog.style.height) });
  const header = root.querySelector('.omnitime-modal-header');
  const drag = (el, from, to) => { ptr(el, 'pointerdown', ...from); ptr(el, 'pointermove', ...to); ptr(el, 'pointerup', ...to); };
  return { ...env, store, root, dialog, header, ptr, box, drag };
}

describe('moving the dialog', () => {
  it('drags by the header and remembers the rect', async () => {
    const t = await open();
    t.drag(t.header, [100, 20], [160, 70]);
    // Started from the centred 880x600 box: (72,84) + (60,50).
    assert.deepEqual(t.box(), { x: 132, y: 134, w: 880, h: 600 });
    assert.deepEqual(plain(t.store.omnitimeModalRect), { x: 132, y: 134, w: 880, h: 600 });
    assert.equal(t.dialog.style.position, 'absolute');
  });

  it('keeps 48px of the header inside the viewport', async () => {
    const t = await open();
    t.drag(t.header, [0, 0], [5000, 5000]);
    assert.deepEqual([t.box().x, t.box().y], [1024 - 48, 768 - 48]);
    t.drag(t.header, [0, 0], [-9000, -9000]);
    assert.deepEqual([t.box().x, t.box().y], [48 - 880, 0]);
  });

  it('does not start from the tabs, the gear or the close button', async () => {
    const t = await open();
    const close = t.root.querySelector('.omnitime-modal-close');
    t.drag(close, [0, 0], [50, 50]);
    assert.equal(t.dialog.style.position, '');
    const tab = t.root.querySelector('[role="tab"]');
    t.drag(tab, [0, 0], [50, 50]);
    assert.equal(t.dialog.style.position, '');
  });

  it('disables text selection while dragging', async () => {
    const t = await open();
    t.ptr(t.header, 'pointerdown', 10, 10);
    assert.ok(t.root.querySelector('.omnitime-modal-overlay').classList.contains('omnitime-modal-overlay--moving'));
    t.ptr(t.header, 'pointerup', 10, 10);
    assert.ok(!t.root.querySelector('.omnitime-modal-overlay').classList.contains('omnitime-modal-overlay--moving'));
  });

  it('moves with Alt+Arrow by 20px from the header', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 100, y: 100, w: 700, h: 500 } } });
    key(t.window, t.header, 'ArrowRight', { altKey: true });
    key(t.window, t.header, 'ArrowDown', { altKey: true });
    assert.deepEqual(t.box(), { x: 120, y: 120, w: 700, h: 500 });
    key(t.window, t.header, 'ArrowRight', { altKey: true, shiftKey: true });
    key(t.window, t.header, 'ArrowUp', { altKey: true, shiftKey: true });
    assert.deepEqual(t.box(), { x: 120, y: 120, w: 720, h: 480 });
  });
});

describe('resizing the dialog', () => {
  it('resizes from the south-east corner and the north-west corner', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 100, y: 100, w: 700, h: 500 } } });
    t.drag(t.root.querySelector('.omnitime-resize--se'), [800, 600], [850, 640]);
    assert.deepEqual(t.box(), { x: 100, y: 100, w: 750, h: 540 });
    t.drag(t.root.querySelector('.omnitime-resize--nw'), [100, 100], [60, 70]);
    assert.deepEqual(t.box(), { x: 60, y: 70, w: 790, h: 570 });
  });

  it('stops at 560x420 (the opposite edge stays) and at the viewport', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 100, y: 100, w: 700, h: 500 } } });
    t.drag(t.root.querySelector('.omnitime-resize--nw'), [100, 100], [900, 900]);
    assert.deepEqual(t.box(), { x: 240, y: 180, w: 560, h: 420 });
    t.drag(t.root.querySelector('.omnitime-resize--se'), [800, 600], [5000, 5000]);
    assert.deepEqual(t.box(), { x: 240, y: 180, w: 1024 - 240, h: 768 - 180 });
    t.drag(t.root.querySelector('.omnitime-resize--w'), [240, 300], [-500, 300]);
    assert.deepEqual([t.box().x, t.box().w], [0, 1024]);
  });

  it('fits a viewport smaller than the minimum', async () => {
    const t = await open({ size: [500, 400], stored: { omnitimeModalRect: { x: 0, y: 0, w: 700, h: 500 } } });
    assert.deepEqual(t.box(), { x: 0, y: 0, w: 500, h: 400 });
  });

  it('has no resize handles on the small dialog', async () => {
    const t = await open({ tab: 'issue' });
    assert.ok(!t.dialog.classList.contains('omnitime-modal--large'));
    assert.equal(t.root.querySelectorAll('.omnitime-resize').length, 8);
    // Hidden by CSS; and Alt+Shift+Arrow leaves the small dialog's size alone.
    key(t.window, t.header, 'ArrowRight', { altKey: true, shiftKey: true });
    assert.equal(t.dialog.style.width, '');
  });
});

describe('remembering the rect', () => {
  it('restores a stored rect clamped into the viewport', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 900, y: 700, w: 800, h: 600 } } });
    assert.deepEqual(t.box(), { x: 224, y: 168, w: 800, h: 600 });
  });

  it('ignores garbage and works without chrome.storage', async () => {
    const bad = await open({ stored: { omnitimeModalRect: { x: 'a', y: 1 } } });
    assert.equal(bad.dialog.style.position, '');
    const none = await open({ noStorage: true });
    none.drag(none.header, [0, 0], [10, 10]);
    assert.equal(none.dialog.style.position, 'absolute');
    assert.deepEqual(none.errors, []);
  });

  it('re-clamps on a window resize without changing the stored rect', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 100, y: 100, w: 800, h: 600 } } });
    t.window.innerWidth = 700;
    t.window.innerHeight = 500;
    t.window.dispatchEvent(new t.window.Event('resize'));
    assert.deepEqual(t.box(), { x: 0, y: 0, w: 700, h: 500 });
    assert.deepEqual(plain(t.store.omnitimeModalRect), { x: 100, y: 100, w: 800, h: 600 });
  });

  it('the small dialog remembers only its position', async () => {
    const t = await open({ tab: 'issue' });
    t.drag(t.header, [0, 0], [30, 40]);
    assert.deepEqual(plain(t.store.omnitimeModalPos), { x: 72 + 30 + 0, y: 84 + 40 });
    assert.equal(t.store.omnitimeModalRect, undefined);
    assert.equal(t.dialog.style.width, '');
  });
});

describe('resetting and the backdrop', () => {
  it('a double-click on the header resets position and size', async () => {
    const t = await open({ stored: { omnitimeModalRect: { x: 100, y: 100, w: 700, h: 500 } } });
    t.header.dispatchEvent(new t.window.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(t.dialog.style.position, '');
    assert.equal(t.dialog.style.width, '');
    assert.equal(t.store.omnitimeModalRect, null);
  });

  it('a drag that ends over the backdrop does not close it, a plain click does', async () => {
    const t = await open();
    const overlay = t.root.querySelector('.omnitime-modal-overlay');
    t.drag(t.header, [0, 0], [5, 5]);
    overlay.dispatchEvent(new t.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(t.window.OmniTime.isOpen(), true);
    await settle(5);
    overlay.dispatchEvent(new t.window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(t.window.OmniTime.isOpen(), false);
  });
});
