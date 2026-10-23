// Shared helpers for the OmniTime node test suite (node --test + jsdom).
// Not shipped: build_extension.sh excludes tests/.

// Pin the timezone before any Date is created so expectations are stable.
process.env.TZ = 'Europe/Berlin';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { after } = require('node:test');

// Windows are closed after the file's tests, which stops their timers (e.g.
// the timeline's "now" line ticks every minute while a modal is open).
const windows = [];
after(() => windows.splice(0).forEach((w) => w.close()));

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const icsStamp = (d, h, m) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(h)}${pad2(m)}00`;

// Minimal chrome.storage.onChanged stand-in that tracks its listeners.
function makeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

// A jsdom window with the given extension scripts evaluated in order.
// Uncaught errors (including ones thrown inside event listeners) are collected
// in `errors` instead of being printed. When core.js is loaded, the stylesheet
// is handed over like the extension does (OmniTime.setStyles) unless
// `styles: false`.
function loadDom(files, { chrome, styles = true, shadow = 'open' } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err));
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', virtualConsole });
  const { window } = dom;
  windows.push(window);
  window.addEventListener('error', (ev) => errors.push(ev.error || ev.message));
  // jsdom has no pointer capture or scrollIntoView; the UI only calls them.
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  if (chrome) window.chrome = chrome;
  // The UI's shadow root is closed in production; tests open it unless asked
  // otherwise ({ shadow: 'closed' }), like dev builds do.
  if (shadow === 'open') window.__omnitimeShadowMode = 'open';
  files.forEach((file) => window.eval(read(file)));
  if (styles && window.OmniTime) window.OmniTime.setStyles(read('style.css'));
  return { window, document: window.document, errors };
}

// The OmniTime UI lives in a shadow root on <omnitime-root> (open here, closed
// in production); queries must go through it (document.querySelector can't see
// inside). A closed root is reached through OmniTime.getRoot().
function uiRoot(document) {
  const host = document.querySelector('omnitime-root');
  if (!host) return null;
  if (host.shadowRoot) return host.shadowRoot;
  const w = document.defaultView;
  return (w && w.OmniTime && w.OmniTime.getRoot()) || null;
}

// Dispatch a keydown as a real key press would (bubbles, crosses the shadow
// boundary). Returns false when a listener called preventDefault().
function key(window, el, keyName, opts = {}) {
  return el.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, composed: true, ...opts }));
}

// Dispatch a pointer-style event (jsdom lacks PointerEvent; listeners only
// read clientY/target, which MouseEvent provides).
function pointer(window, el, type, clientY) {
  el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
}

// Resolve after pending promise callbacks and timers have run.
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Evaluate background.js in a fresh context with the given chrome/fetch stubs.
function loadBackground({ chrome, fetch, browser, userAgent = 'Chrome' }) {
  const context = {
    chrome,
    fetch,
    navigator: { userAgent },
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    setTimeout,
    Promise,
  };
  if (browser) context.browser = browser;
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  return context;
}

module.exports = { ROOT, read, ymd, icsStamp, makeEvent, loadDom, uiRoot, key, pointer, settle, loadBackground };
