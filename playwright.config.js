// Playwright e2e tests: load the built dev extension (dist/omnitime) into
// Chromium and drive it against a local 1x TIMES API. See e2e/README.md.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  // One browser at a time: every test shares the e2e user's day on the API.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
