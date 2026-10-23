# OmniTime end-to-end tests

Playwright loads the dev build (`dist/omnitime`) into Chromium and drives it
against a **local** 1x TIMES API. Each test gets a fresh browser profile. The
specs cover the "This issue" tab, My day create/edit/move/delete (with Undo), duplicate, keyboard shortcuts, booking via
search, calendar placeholders from an iCal feed, the toolbar overlay and the
running timer (tests move its start into the past through the service worker),
the settings gear (the options page embedded in an iframe under a dynamic
extension URL, autosave, Escape from inside the frame) and the first-install tab.

```bash
npm run test:e2e          # rebuilds dist/omnitime, then runs the specs
HEADED=1 npx playwright test   # watch it run against the current dist/
```

## What is real and what is simulated

- **Real:** the extension (background service worker, content script, core
  UI) and the API, including its database.
- **Simulated:**
  - **GitLab issue page:** a synthetic page served by a Playwright route on the
    GitLab origin, so nothing is sent to GitLab and the API still recognises
    the source.
  - **Calendar feed:** a local `.ics` server with events on today's date.
  - **Toolbar icon click:** a call to `openOverlay()` in the service worker,
    since Playwright can't click the browser toolbar.
- **Not covered:**
  - **Google sign-in:** `chrome.identity` doesn't work in Playwright's
    Chromium, so the tests authenticate with the legacy `api-key` header.
  - **The Google Calendar API sync.**

## Local API setup (one time, local only)

The 1x TIMES API normally accepts only Google bearer tokens. For these tests,
let it accept an `api-key` for a dedicated test user, **only in your local
ddev site**. In the 1x TIMES checkout:

1. Enable `key_auth`. This changes only the local database; undo it with
   `ddev drush pmu key_auth`.

   ```bash
   ddev drush pm:install key_auth -y
   ```

2. Allow `key_auth` on the OmniTime REST resources in the git-ignored
   `web/sites/default/settings.local.php`, then run `ddev drush cr`:

   ```php
   foreach (['tracked_time', 'my_tracked_time', 'frequent_issues', 'issue_search', 'time_entry'] as $omnitime_resource) {
     $config["rest.resource.$omnitime_resource"]['configuration']['authentication'] = ['google_oauth', 'cookie', 'key_auth'];
   }
   ```

3. Create the test user. Give it a role with `use key authentication`, and an
   API key. The tests delete **all** of this user's entries for today, so never
   use a real account:

   ```bash
   ddev drush role:create omnitime_e2e "OmniTime e2e (local)"
   ddev drush role:perm:add omnitime_e2e "use key authentication"
   ddev drush user:create omnitime-e2e --mail=omnitime-e2e@example.test
   ddev drush user:role:add omnitime_e2e omnitime-e2e
   ddev drush php:eval '$u = user_load_by_name("omnitime-e2e"); $k = \Drupal::service("key_auth")->generateKey(); $u->set("api_key", $k); $u->save(); echo $k;'
   ```

4. Create `.env.e2e` in this folder. It is git-ignored and never packaged:

   ```ini
   OMNITIME_E2E_API_URL=https://<site>.ddev.site/api/v1/tracked-time
   OMNITIME_E2E_API_KEY=<key from step 3>
   OMNITIME_E2E_SOURCE=<GitLab origin, exactly as the source item's link>
   OMNITIME_E2E_PROJECT_ID=<GitLab project id of an open issue>
   OMNITIME_E2E_ISSUE_ID=<that issue's iid>
   OMNITIME_E2E_SEARCH=<a word from that issue's title>
   ```

5. Make sure issue search finds that issue. After importing a production
   database, the local Elasticsearch index can be empty even though Search API
   reports 100% indexed. Reindex with:

   ```bash
   ddev drush search-api:reset-tracker issues && ddev drush search-api:index issues
   ```

Every create, update or delete also queues a BigQuery sync. Locally that goes
to the `*_test` tables configured in `settings.local.php`.
