const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

const chromeManifest = JSON.parse(read('manifest.json'));
const firefoxManifest = JSON.parse(read('manifest_firefox.json'));

// The js list passed to registerContentScripts in a source file.
const contentScripts = (file) => {
  const m = read(file).match(/id: 'omnitime-cs',[\s\S]*?js: (\[[^\]]*\])/);
  assert.ok(m, `no content-script registration in ${file}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

describe('manifests', () => {
  it('keep version and permissions in sync between Chrome and Firefox', () => {
    assert.equal(firefoxManifest.version, chromeManifest.version);
    assert.deepEqual(firefoxManifest.permissions, chromeManifest.permissions);
  });

  it('request the notifications permission (end-of-day reminder) in both browsers', () => {
    assert.ok(chromeManifest.permissions.includes('notifications'));
    assert.ok(firefoxManifest.permissions.includes('notifications'));
  });

  it('request the contextMenus permission (presentation mode item on the toolbar icon) in both browsers', () => {
    assert.ok(chromeManifest.permissions.includes('contextMenus'));
    assert.ok(firefoxManifest.permissions.includes('contextMenus'));
  });

  it('require a Chrome version with chrome.storage.session (the sign-in token lives there)', () => {
    assert.ok(Number(chromeManifest.minimum_chrome_version) >= 102);
  });

  it('keep the Google OAuth scopes narrow (email and read-only calendar)', () => {
    assert.deepEqual(chromeManifest.oauth2.scopes, ['email', 'https://www.googleapis.com/auth/calendar.readonly']);
  });

  it('load the iCal parser before background.js on Firefox (reminder filters)', () => {
    const scripts = firefoxManifest.background.scripts;
    assert.ok(scripts.indexOf('ical-parser.js') < scripts.indexOf('background.js'));
    assert.ok(read('background.js').includes("importScripts('ical-parser.js')")); // Chrome service worker
  });

  it('let the toolbar icon open the overlay (no popup) in both browsers', () => {
    assert.equal(chromeManifest.action.default_popup, undefined);
    assert.equal(firefoxManifest.action.default_popup, undefined);
  });

  // The only web-accessible resource is the options page (the settings panel in
  // the modal embeds it in an iframe, see core.js "Settings panel"): nothing else.
  const WAR = ['options.html', 'options.css', 'options.js'];

  it('expose exactly the options page as web-accessible, to all pages, under a dynamic URL in Chrome', () => {
    assert.deepEqual(chromeManifest.web_accessible_resources, [
      { resources: WAR, matches: ['<all_urls>'], use_dynamic_url: true },
    ]);
  });

  it('expose the same resources on Firefox, without use_dynamic_url (Chrome only; moz-extension URLs are random per install)', () => {
    assert.deepEqual(firefoxManifest.web_accessible_resources, [
      { resources: WAR, matches: ['<all_urls>'] },
    ]);
  });

  it('list every file options.html loads (script, stylesheet) as web-accessible, and nothing else is needed', () => {
    const html = read('options.html');
    const loaded = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]);
    assert.deepEqual(loaded.sort(), ['options.css', 'options.js']);
    loaded.forEach((file) => assert.ok(WAR.includes(file), `${file} is not web-accessible`));
    assert.ok(WAR.includes('options.html'));
  });
});

describe('content-script registration', () => {
  it('uses the same files in options.js and background.js, parser before core', () => {
    const fromOptions = contentScripts('options.js');
    assert.deepEqual(contentScripts('background.js'), fromOptions);
    assert.ok(fromOptions.indexOf('ical-parser.js') < fromOptions.indexOf('core.js'));
    // The running timer module is loaded before core.js and the widget.
    assert.ok(fromOptions.indexOf('timer.js') >= 0 && fromOptions.indexOf('timer.js') < fromOptions.indexOf('core.js'));
  });

  it('injects no page-level CSS (the UI is styled inside its shadow root)', () => {
    ['options.js', 'background.js'].forEach((file) => {
      const m = read(file).match(/id: 'omnitime-cs',[\s\S]*?runAt/);
      assert.ok(!/^\s*css:/m.test(m[0]), `${file} registers css`);
    });
    assert.ok(!read('background.js').includes('insertCSS'));
  });
});

describe('build_extension.sh', () => {
  it('keeps tests, agent notes and dev-only files out of the package', () => {
    const script = read('build_extension.sh');
    ['tests', 'test*.js', 'e2e', 'playwright.config.js', 'test-results', '.env.e2e', '.agents', 'package-lock.json', 'omnitime-overlay-bg.png', 'dev', 'node_modules', '.env']
      .forEach((pattern) => assert.ok(script.includes(`--exclude="${pattern}"`), `missing --exclude="${pattern}"`));
  });
});
