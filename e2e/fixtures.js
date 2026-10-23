// Fixtures for the OmniTime e2e tests.
//
// Each test gets a fresh Chromium profile with dist/omnitime loaded, configured
// (through the service worker) to call the API from .env.e2e with the local
// e2e user's api-key. The GitLab issue page is a synthetic page served by a
// Playwright route on the real GitLab origin, so nothing reaches GitLab and the
// API still recognises the source. Calendar events come from a local .ics
// server with events on today's date.

const { test: base, expect, chromium, request } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'dist', 'omnitime');

function loadEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(ROOT, '.env.e2e'), 'utf8').split('\n').forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    });
  } catch (e) { /* reported below */ }
  const required = ['OMNITIME_E2E_API_URL', 'OMNITIME_E2E_API_KEY', 'OMNITIME_E2E_SOURCE', 'OMNITIME_E2E_PROJECT_ID', 'OMNITIME_E2E_ISSUE_ID', 'OMNITIME_E2E_SEARCH'];
  const missing = required.filter((k) => !(process.env[k] || env[k]));
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} in .env.e2e (see e2e/README.md).`);
  return Object.fromEntries(required.map((k) => [k.replace('OMNITIME_E2E_', '').toLowerCase(), process.env[k] || env[k]]));
}
const ENV = loadEnv();
if (!fs.existsSync(path.join(EXTENSION, 'manifest.json'))) {
  throw new Error('dist/omnitime is missing: run `npm run build:dev` (or `npm run test:e2e`).');
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => ymd(new Date());
// The working day before today (Monday → Friday), as "Copy from ..." uses it.
const prevWorkingDay = () => {
  const d = new Date();
  const back = d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1;
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
};

// Calendar events on today's date (floating local time, like a Google feed
// rendered for the user's zone).
const CALENDAR = [
  ['E2E Planning', '1300', '1345'],
  ['E2E Overlap A', '1500', '1600'],
  ['E2E Overlap B', '1530', '1630'],
];
function icsFeed() {
  const day = today().replace(/-/g, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    ...CALENDAR.flatMap(([title, start, end], i) => [
      'BEGIN:VEVENT', `UID:e2e-${i}@omnitime.test`, `SUMMARY:${title}`,
      `DTSTART:${day}T${start}00`, `DTEND:${day}T${end}00`, 'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

const issueUrl = `${ENV.source}/omnitime-e2e/project/-/issues/${ENV.issue_id}`;
const issuePage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OmniTime e2e issue (#${ENV.issue_id}) · GitLab</title></head>
<body data-project-id="${ENV.project_id}">
  <main><h1>OmniTime e2e issue</h1></main>
  <aside><div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div></aside>
</body></html>`;

const test = base.extend({
  // Direct API access as the e2e user, for seeding, assertions and cleanup.
  api: async ({}, use) => {
    const ctx = await request.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'api-key': ENV.api_key, Accept: 'application/json' },
    });
    const base = ENV.api_url.replace(/\/tracked-time\/?$/, '');
    const json = async (res) => {
      expect(res.ok(), `${res.url()} → HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
      return res.status() === 204 ? null : res.json();
    };
    const api = {
      issue: { source: ENV.source, project_id: ENV.project_id, issue_id: ENV.issue_id },
      search: ENV.search,
      // `date` defaults to today (YYYY-MM-DD); create takes body.date.
      myDay: async (date = today()) => json(await ctx.get(`${base}/my-tracked-time`, { params: { _format: 'json', date } })),
      entries: async (date) => (await api.myDay(date)).entries || [],
      create: async (body) => json(await ctx.post(`${ENV.api_url}`, { params: { _format: 'json' }, data: { date: today(), ...api.issue, ...body } })),
      // Starred issues (bookmarks) of the e2e user, for setup and cleanup.
      bookmarkIds: async () => ((await json(await ctx.get(`${base}/my-bookmarks`, { params: { _format: 'json' } }))).issues || []).map((i) => String(i.issue_internal_id)),
      bookmark: async (id) => json(await ctx.post(`${base}/bookmark`, { params: { _format: 'json' }, data: { issue_internal_id: Number(id) } })),
      unbookmark: async (id) => json(await ctx.delete(`${base}/bookmark/${id}`, { params: { _format: 'json' } })),
      // The e2e user is dedicated to these tests, so its whole day is fair
      // game - today and the previous working day ("Copy from ..." seeds it).
      clearDay: async (dates = [today(), prevWorkingDay()]) => {
        for (const date of [].concat(dates)) {
          for (const e of await api.entries(date)) {
            if (e.editable) await json(await ctx.delete(`${base}/time-entry/${e.id}`, { params: { _format: 'json' } }));
          }
        }
      },
    };
    await api.clearDay();
    await use(api);
    await api.clearDay();
    await ctx.dispose();
  },

  calendarUrl: async ({}, use) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(icsFeed());
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await use(`http://127.0.0.1:${server.address().port}/basic.ics`);
    await new Promise((r) => server.close(r));
  },

  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      // ddev's mkcert certificate is not in Playwright Chromium's trust store.
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--ignore-certificate-errors'],
    });
    await context.route(`${ENV.source}/**`, (route) => route.fulfill({ contentType: 'text/html', body: issuePage }));
    await context.route('https://elsewhere.omnitime.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!DOCTYPE html><title>Any page</title><h1>Any page</h1>',
    }));
    await use(context);
    await context.close();
  },

  // The extension's service worker, with settings saved as the options page
  // would (plus its content-script registration).
  extension: async ({ context, api, calendarUrl }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await worker.evaluate(async (settings) => {
      await chrome.storage.sync.set(settings);
      await registerContentScriptsFromSettings();
    }, {
      apiUrl: ENV.api_url,
      apiKey: ENV.api_key,
      instances: [{ hostUrl: new URL(ENV.source).host, systemType: 'gitlab' }],
      icalUrl: calendarUrl,
      useGoogleCalendar: false,
      dayStart: 8,
      dayEnd: 17,
      debug: false,
    });
    await use({ worker, id: new URL(worker.url()).host });
  },

  // A page showing the synthetic GitLab issue with the OmniTime trigger ready.
  issuePage: async ({ context, extension }, use) => {
    const page = await context.newPage();
    await page.goto(issueUrl);
    await expect(page.locator('[data-testid="work-item-time-tracking"] h3')).toHaveAttribute('title', 'Click to view OmniTime report');
    await use(page);
  },
});

module.exports = { test, expect, today, prevWorkingDay, CALENDAR, ENV, EXTENSION, icsFeed, issueUrl, issuePage };
