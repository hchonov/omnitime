// Shared manual-testing session: opens a visible Chromium with dist/omnitime
// loaded and configured exactly like the e2e tests (API key of the local e2e
// user, synthetic GitLab issue page, local calendar feed), then stays open so
// a person can click around while another process connects over CDP
// (http://127.0.0.1:9333) to inspect or drive the same browser.
//
//   npm run e2e:session        # Ctrl+C or close the window to stop
//
// Extension console output and API calls are printed to stdout.

// Report the service worker's own fetches (API calls) as request events.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ENV, EXTENSION, icsFeed, issueUrl, issuePage } = require('./fixtures');

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const ICS_PORT = Number(process.env.ICS_PORT || 8799);
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

(async () => {
  const ics = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(icsFeed());
  });
  await new Promise((r) => ics.listen(ICS_PORT, '127.0.0.1', r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitime-session-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--ignore-certificate-errors',
      `--remote-debugging-port=${CDP_PORT}`,
      '--start-maximized',
    ],
  });
  await context.route(`${ENV.source}/**`, (route) => route.fulfill({ contentType: 'text/html', body: issuePage }));

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  worker.on('console', (m) => log(`[worker ${m.type()}]`, m.text()));
  await worker.evaluate(async (settings) => {
    await chrome.storage.sync.set(settings);
    await registerContentScriptsFromSettings();
  }, {
    apiUrl: ENV.api_url,
    apiKey: ENV.api_key,
    instances: [{ hostUrl: new URL(ENV.source).host, systemType: 'gitlab' }],
    icalUrl: `http://127.0.0.1:${ICS_PORT}/basic.ics`,
    useGoogleCalendar: false,
    dayStart: 8,
    dayEnd: 17,
    debug: true,
  });

  // Log API traffic without the api-key (only method, path and status).
  const apiOrigin = new URL(ENV.api_url).origin;
  context.on('requestfinished', async (req) => {
    if (!req.url().startsWith(apiOrigin)) return;
    const res = await req.response();
    const url = new URL(req.url());
    url.searchParams.delete('_format');
    log(`[api] ${req.method()} ${url.pathname}${url.search} → ${res ? res.status() : '?'}`);
  });
  context.on('requestfailed', (req) => {
    if (req.url().startsWith(apiOrigin)) log(`[api] ${req.method()} ${req.url()} FAILED ${req.failure().errorText}`);
  });
  const watchPage = (page) => {
    page.on('console', (m) => { if (/OmniTime/i.test(m.text()) || m.type() === 'error') log(`[page ${m.type()}]`, m.text()); });
    page.on('pageerror', (e) => log('[page error]', e.message));
  };
  context.on('page', watchPage);

  const [first] = context.pages();
  const page = first || await context.newPage();
  watchPage(page);
  await page.goto(issueUrl);

  log(`Ready. Issue page: ${issueUrl}`);
  log(`CDP: http://127.0.0.1:${CDP_PORT}  Calendar feed: http://127.0.0.1:${ICS_PORT}/basic.ics`);
  log('Pin the OmniTime toolbar icon (puzzle menu) to open the overlay on any page.');

  const stop = async () => {
    ics.close();
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    process.exit(0);
  };
  context.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
