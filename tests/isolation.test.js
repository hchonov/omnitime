// Shadow root isolation: the UI is mounted in a CLOSED shadow root in
// production, so page scripts (session replay tools included) can't read or
// drive it. Dev builds, the jsdom helpers and dev/preview.html open it via
// window.__omnitimeShadowMode = 'open' (see SHADOW_MODE_DEFAULT in core.js).
// Everything the UI does internally must keep working with a closed root:
// focus parking, the Copy popover's outside-click handling, ...
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, uiRoot, makeEvent, settle } = require('./helpers');

const ENTRY = {
  id: 1, start: '09:00', stop: '10:00', duration_minutes: 60, duration_label: '1:00',
  project: 'Internal', issue_label: 'Standup', issue_external_id: '1', issue_internal_id: 1001,
  issue_link: '', comment: 'Work', status: 'unbooked', editable: true, break_label: null, active: false,
};

// Today is empty, every other day has one entry: the empty day offers "Copy from ...".
function fakeApi() {
  return {
    myDay: (date) => Promise.resolve(date === todayLocal()
      ? { date, week: [], day_total_minutes: 0, day_total_label: '0:00', entries: [], target_minutes: 480 }
      : { date, week: [], day_total_minutes: 60, day_total_label: '1:00', entries: [ENTRY], target_minutes: 480 }),
    frequent: () => Promise.resolve({ issues: [] }),
    search: () => Promise.resolve({ issues: [] }),
    issueTime: () => Promise.resolve({ issue: { open: true } }),
    create: () => Promise.resolve({ id: 9 }),
    update: () => Promise.resolve({}),
    remove: () => Promise.resolve(null),
  };
}
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function chromeStub() {
  const store = {};
  return {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
      onChanged: makeEvent(),
    },
    runtime: { sendMessage: (msg, cb) => cb && cb({ success: true, notModified: true }) },
  };
}

async function openClosed(shadow = 'closed') {
  const env = loadDom(['ical-parser.js', 'core.js'], { chrome: chromeStub(), shadow });
  const modal = env.window.OmniTime.openModal({ apiClient: fakeApi(), context: {}, activeTab: 'myday', settings: { dayStart: 8, dayEnd: 17 } });
  await settle(40);
  return { ...env, modal, root: env.window.OmniTime.getRoot() };
}

describe('closed shadow root (production default)', () => {
  it('hides the shadow root from the page but not from OmniTime', async () => {
    const { document, window, root, errors } = await openClosed();
    const host = document.querySelector('omnitime-root');
    assert.ok(host);
    assert.equal(host.shadowRoot, null, 'page scripts get null');
    assert.ok(root, 'OmniTime.getRoot() still returns it');
    assert.equal(window.OmniTime.getRoot(), uiRoot(document));
    assert.ok(root.querySelector('.omnitime-modal'));
    assert.equal(root.querySelector('.omnitime-myday__cols') !== null, true, 'My day rendered');
    assert.deepEqual(errors, []);
  });

  it('is open when the dev flag is set before core.js', async () => {
    const { document, root } = await openClosed('open');
    const host = document.querySelector('omnitime-root');
    assert.ok(host.shadowRoot);
    assert.equal(host.shadowRoot.mode, 'open');
    assert.equal(host.shadowRoot, root);
  });

  it('only the exact string "open" opens it (a clobbered global does not)', async () => {
    const env = loadDom(['core.js'], { shadow: 'closed' });
    env.window.__omnitimeShadowMode = env.document.createElement('a'); // what DOM clobbering would give
    env.window.OmniTime.openNotice({ title: 'Hi', html: 'x' });
    assert.equal(env.document.querySelector('omnitime-root').shadowRoot, null);
    env.window.OmniTime.close();
    env.window.__omnitimeShadowMode = 'OPEN';
    env.window.OmniTime.openNotice({ title: 'Hi', html: 'x' });
    assert.equal(env.document.querySelector('omnitime-root').shadowRoot, null);
  });

  it('mounts the inline widget host closed as well', () => {
    const { window, document } = loadDom(['core.js'], { shadow: 'closed' });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const inline = window.OmniTime.mountInline(parent, {});
    assert.equal(parent.querySelector('omnitime-inline').shadowRoot, null);
    assert.ok(inline.root, 'the caller keeps the root');
    inline.root.appendChild(document.createElement('span'));
    assert.equal(inline.root.children.length >= 1, true);
  });

  it('keeps focus parking working: a focused toast that goes away leaves the focus on the dialog', async () => {
    const { modal, root } = await openClosed();
    const ui = modal.ui;
    const dismiss = ui.toast('Deleted', { actionLabel: 'Undo', timeout: 0 });
    const btn = root.querySelector('.omnitime-toast__action');
    btn.focus();
    assert.equal(root.activeElement, btn);
    dismiss();
    assert.equal(root.querySelector('.omnitime-toast'), null, 'toast gone');
    assert.equal(root.activeElement, ui.dialog, 'focus parked on the dialog, not lost to <body>');
    // A replacement toast parks it the same way.
    ui.toast('One', { actionLabel: 'Undo', timeout: 0 });
    root.querySelector('.omnitime-toast__action').focus();
    ui.toast('Two', { timeout: 0 });
    assert.equal(root.activeElement, ui.dialog);
  });

  describe('Copy popover', () => {
    const openPopover = async () => {
      const t = await openClosed();
      const btn = t.root.querySelector('.omnitime-tl__copy');
      assert.ok(btn, 'an empty day offers Copy from the previous working day');
      btn.click();
      await settle(40);
      const pop = t.root.querySelector('.omnitime-daypop');
      assert.ok(pop);
      return { ...t, pop, box: pop.querySelector('input[type="checkbox"]') };
    };
    const down = (t, el) => el.dispatchEvent(new t.window.MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true }));

    it('survives a pointerdown inside it, and closes on one elsewhere in the dialog', async () => {
      const t = await openPopover();
      assert.ok(t.box);
      down(t, t.box);
      assert.ok(t.root.querySelector('.omnitime-daypop'), 'a click inside keeps it open');
      down(t, t.root.querySelector('.omnitime-modal-header'));
      assert.equal(t.root.querySelector('.omnitime-daypop'), null, 'a click elsewhere closes it');
    });

    it("doesn't leave a document listener behind when the modal closes underneath it", async () => {
      const env = loadDom(['ical-parser.js', 'core.js'], { chrome: chromeStub(), shadow: 'closed' });
      const added = [];
      const real = env.document.addEventListener.bind(env.document);
      env.document.addEventListener = (type, fn, opts) => { added.push(type); return real(type, fn, opts); };
      env.window.OmniTime.openModal({ apiClient: fakeApi(), context: {}, activeTab: 'myday', settings: { dayStart: 8, dayEnd: 17 } });
      await settle(40);
      const root = env.window.OmniTime.getRoot();
      root.querySelector('.omnitime-tl__copy').click();
      await settle(40);
      assert.ok(root.querySelector('.omnitime-daypop'));
      assert.equal(added.includes('pointerdown'), false, 'the outside-click listener sits on the shadow root, not the document');
      env.window.OmniTime.close();
      env.document.dispatchEvent(new env.window.MouseEvent('pointerdown', { bubbles: true }));
      await settle(5);
      assert.deepEqual(env.errors, []);
    });
  });
});
