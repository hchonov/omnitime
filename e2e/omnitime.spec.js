const { test, expect, issueUrl, prevWorkingDay, today } = require('./fixtures');

// Open the OmniTime modal from the GitLab sidebar and switch to "My day".
async function openMyDay(page) {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-tab[data-tab="myday"]').click();
  await expect(page.locator('.omnitime-tl')).toBeVisible();
  await expect(page.locator('.omnitime-myday--busy')).toHaveCount(0);
}

const entryBlock = (page, text) => page.locator('.omnitime-tl__entry', { hasText: text });
const calBlock = (page, title) => page.locator('.omnitime-tl__cal-event', { hasText: title });

// The form shows its issue as one line; the search only appears after "Change".
async function changeIssue(page) {
  await page.locator('.omnitime-target__change').click();
  await expect(page.locator('.omnitime-search__input')).toBeVisible();
}

async function fillForm(page, { start, dur, comment }) {
  if (start !== undefined) await page.locator('.omnitime-f-start').fill(start);
  if (dur !== undefined) await page.locator('.omnitime-f-dur').fill(dur);
  if (comment !== undefined) await page.locator('.omnitime-f-comment').fill(comment);
}

// Drag an element vertically with real pointer events. Mouse events only reach
// elements inside the viewport, so bring the target (and room below it) in.
async function dragBy(page, locator, dy) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 10);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 5 });
  await page.mouse.move(x, y + dy, { steps: 5 });
  await page.mouse.up();
}

test('"This issue" shows the tracked time for the GitLab issue', async ({ api, issuePage: page }) => {
  await api.create({ start_time: '08:00', duration: 15, comment: 'e2e seed' });
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  const summary = page.locator('.omnitime-table:not(.omnitime-details-table) tr', { hasText: 'omnitime-e2e' });
  await expect(summary).toContainText('0:15');
  const detail = page.locator('.omnitime-details-table tr', { hasText: 'e2e seed' });
  await expect(detail).toContainText('omnitime-e2e');
  // The tab bar only appears once the new API endpoints answered.
  await expect(page.locator('.omnitime-tab')).toHaveCount(3);
});

test('"This issue" details show the local start time', async ({ api, issuePage: page }) => {
  // The API stores UTC; details must come back in the caller's timezone.
  await api.create({ start_time: '08:00', duration: 15, comment: 'e2e seed' });
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await expect(page.locator('.omnitime-details-table tr', { hasText: 'e2e seed' })).toContainText('08:00', { timeout: 5_000 });
});

test('"Track time on this issue" opens the add form with the issue preselected', async ({ api, issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-issuehead__track').click();
  await expect(page.locator('.omnitime-tab--active')).toHaveAttribute('data-tab', 'myday');
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(1);
  await expect(page.locator('.omnitime-target__label')).toContainText(`#${api.issue.issue_id}`);
});

test('My day: create, edit, move and delete an entry for the current issue', async ({ api, issuePage: page }) => {
  await openMyDay(page);

  await page.locator('.omnitime-add-btn').click();
  await expect(page.locator('.omnitime-target__label')).toContainText(`#${api.issue.issue_id}`);
  await fillForm(page, { start: '10:00', dur: '0:30', comment: 'e2e create' });
  await page.locator('.omnitime-save').click();
  await expect(entryBlock(page, '10:00–10:30')).toBeVisible();
  let [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '10:00', duration_minutes: 30, comment: 'e2e create', issue_external_id: api.issue.issue_id });

  // Edit: clicking an editable entry opens the form in edit mode.
  await entryBlock(page, '10:00–10:30').click();
  await expect(page.locator('.omnitime-form--edit')).toBeVisible();
  await fillForm(page, { dur: '0:45' });
  await page.locator('.omnitime-save').click();
  // Optimistic: the block changes at once, the PATCH lands right after.
  await expect(entryBlock(page, '10:00–10:45')).toBeVisible();
  await expect(page.locator('.omnitime-toast__msg')).toHaveText('Saved');
  await expect.poll(async () => (await api.entries())[0].duration_minutes).toBe(45);

  // Resize: the bottom handle appears on hover and extends the entry.
  const block = entryBlock(page, '10:00–10:45');
  await block.hover();
  const bottom = block.locator('[data-h="bottom"]');
  await expect(bottom).toHaveCSS('opacity', '1');
  const handleBox = await bottom.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 36, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await api.entries())[0].duration_minutes).toBeGreaterThan(45);
  [entry] = await api.entries();
  expect(entry.start).toBe('10:00');
  await expect(page.locator('.omnitime-myday--busy')).toHaveCount(0);
  // Back to 45 minutes for the move below.
  await entryBlock(page, '10:00–').click();
  await fillForm(page, { dur: '0:45' });
  await page.locator('.omnitime-save').click();
  await expect(entryBlock(page, '10:00–10:45')).toBeVisible();
  await expect.poll(async () => (await api.entries())[0].duration_minutes).toBe(45);

  // Move: dragging an entry PATCHes its start time and keeps the duration.
  await dragBy(page, entryBlock(page, '10:00–10:45'), 70);
  await expect.poll(async () => (await api.entries())[0].start).not.toBe('10:00');
  [entry] = await api.entries();
  expect(entry.start > '10:00').toBe(true);
  expect(entry.duration_minutes).toBe(45);
  await expect(page.locator('.omnitime-myday--busy')).toHaveCount(0);

  // Delete is immediate (no confirm step); the toast offers Undo instead.
  await page.locator('.omnitime-tl__entry--editable').first().click();
  await page.locator('.omnitime-del').click();
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);
  await expect(page.locator('.omnitime-toast__msg')).toHaveText('Entry deleted');
  await expect(page.locator('.omnitime-toast__action', { hasText: 'Undo' })).toBeVisible();
  await expect.poll(async () => (await api.entries()).length).toBe(0);
});

test('My day: delete, then Undo restores the entry', async ({ api, issuePage: page }) => {
  await api.create({ start_time: '10:00', duration: 30, comment: 'e2e undo' });
  await openMyDay(page);
  const [before] = await api.entries();

  await entryBlock(page, '10:00–10:30').click();
  await page.locator('.omnitime-del').click();
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);
  await expect.poll(async () => (await api.entries()).length).toBe(0);

  await page.locator('.omnitime-toast__action', { hasText: 'Undo' }).click();
  await expect(entryBlock(page, '10:00–10:30')).toBeVisible();
  await expect.poll(async () => (await api.entries()).length).toBe(1);
  const [restored] = await api.entries();
  expect(restored).toMatchObject({ start: '10:00', duration_minutes: 30, comment: 'e2e undo', issue_external_id: api.issue.issue_id });
  expect(restored.id).not.toBe(before.id); // re-created
  // The quiet reconcile shows the server's copy (new id), still one block.
  await expect(page.locator('.omnitime-myday--busy')).toHaveCount(0);
  await expect(page.locator(`.omnitime-tl__entry[data-key="entry:${restored.id}"]`)).toBeVisible();
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(1);
});

test('My day: Alt-drag duplicates an entry, Ctrl/Cmd+D copies it after itself', async ({ api, issuePage: page }) => {
  await api.create({ start_time: '10:00', duration: 30, comment: 'e2e copy' });
  await openMyDay(page);

  // Alt (Option) held while dragging: a copy at the drop position.
  await page.keyboard.down('Alt');
  await dragBy(page, entryBlock(page, '10:00–10:30'), 90);
  await page.keyboard.up('Alt');
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(2);
  await expect.poll(async () => (await api.entries()).length).toBe(2);
  let entries = await api.entries();
  expect(entries.every((e) => e.comment === 'e2e copy' && e.duration_minutes === 30 && e.issue_external_id === api.issue.issue_id)).toBe(true);
  const starts = entries.map((e) => e.start).sort();
  expect(starts[0]).toBe('10:00'); // the original did not move
  expect(starts[1] > '10:00').toBe(true);

  // Keyboard: Ctrl/Cmd+D on the focused original adds a copy at 10:30.
  await expect(page.locator('.omnitime-myday--busy')).toHaveCount(0);
  await entryBlock(page, '10:00–10:30').focus();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(entryBlock(page, '10:30–11:00')).toBeVisible();
  await expect.poll(async () => (await api.entries()).length).toBe(3);
  entries = await api.entries();
  expect(entries.map((e) => e.start)).toContain('10:30');
});

test('My day: keyboard shortcuts N, ←/→, T and the "?" help', async ({ issuePage: page }) => {
  await openMyDay(page);
  const label = page.locator('.omnitime-daynav__label');
  const todayText = await label.textContent();

  // Focus inside the dialog, outside any field (clicking text lands on the dialog).
  await label.click();
  await page.keyboard.press('n');
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(1);
  await expect(page.locator('.omnitime-f-dur')).toBeFocused();
  // Typing in a field never triggers a shortcut.
  await page.locator('.omnitime-f-comment').focus();
  await page.keyboard.type('nt');
  await expect(page.locator('.omnitime-f-comment')).toHaveValue('nt');
  await expect(label).toHaveText(todayText);
  await page.keyboard.press('Escape');
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(0);

  await label.click();
  await page.keyboard.press('ArrowLeft');
  await expect(label).not.toHaveText(todayText);
  await expect(page.locator('.omnitime-daynav__today')).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(label).toHaveText(todayText);
  // "Today" is disabled (not hidden) on today.
  await expect(page.locator('.omnitime-daynav__today')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(label).not.toHaveText(todayText);
  await page.keyboard.press('t');
  await expect(label).toHaveText(todayText);

  await label.click();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Duplicate right after it');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(page.locator('.omnitime-modal')).toBeVisible();
});

test('My day: the quick durations match the sidebar row and the active one is highlighted', async ({ issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  const chips = page.locator('.omnitime-qdur__chip');
  await expect(chips).toHaveText(['5m', '10m', '15m', '30m', '1h']);
  await expect(page.locator('.omnitime-qdur__chip[aria-pressed="true"]')).toHaveText('15m');
  await chips.nth(3).click();
  await expect(page.locator('.omnitime-f-dur')).toHaveValue('0:30');
  await expect(page.locator('.omnitime-qdur__chip[aria-pressed="true"]')).toHaveText('30m');
  await page.locator('.omnitime-f-dur').fill('0:47');
  await expect(page.locator('.omnitime-qdur__chip[aria-pressed="true"]')).toHaveCount(0);
  // Same strip look as the GitLab sidebar's quick row (shared segmented control).
  await expect(page.locator('.omnitime-qdur')).toHaveClass(/omnitime-seg/);
});

test('My day: search books time against another issue', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  await changeIssue(page);
  await page.locator('.omnitime-search__input').fill(api.search);
  const result = page.locator('.omnitime-search__item').first();
  await expect(result).toContainText(`#${api.issue.issue_id}`);
  await result.click();
  await expect(page.locator('.omnitime-target__label')).toContainText(`#${api.issue.issue_id}`);
  await fillForm(page, { start: '07:00', dur: '0:15', comment: 'e2e search' });
  await page.locator('.omnitime-save').click();
  await expect(entryBlock(page, '07:00–07:15')).toBeVisible();
  const [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '07:00', duration_minutes: 15, comment: 'e2e search', issue_external_id: api.issue.issue_id });
});

test('My day: an invalid duration shows an error and nothing is saved', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  await fillForm(page, { start: '10:00', dur: 'abc', comment: 'e2e invalid' });
  await page.locator('.omnitime-save').click();

  const dur = page.locator('.omnitime-f-dur');
  await expect(dur).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#omnitime-f-dur-err')).toBeVisible();
  await expect(dur).toHaveValue('abc'); // kept as typed, not turned into 0:05
  await expect(dur).toBeFocused();
  // Give a (wrong) request time to land before asserting there is none.
  await page.waitForTimeout(500);
  expect(await api.entries()).toEqual([]);
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);

  // Fixing the text clears the error; Enter saves.
  await dur.fill('1h');
  await expect(dur).not.toHaveAttribute('aria-invalid', 'true');
  await dur.press('Enter');
  await expect(entryBlock(page, '10:00–11:00')).toBeVisible();
  const [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '10:00', duration_minutes: 60, comment: 'e2e invalid' });
});

test('My day: keyboard-only search pick, then Enter saves', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  await changeIssue(page);
  const search = page.locator('.omnitime-search__input');
  await search.focus();
  await page.keyboard.type(api.search);
  await expect(page.locator('.omnitime-search__item').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.omnitime-search__item--active')).toHaveCount(1);
  await expect(search).toHaveAttribute('aria-activedescendant', /omnitime-opt-0$/);

  // Enter in the search box picks the highlighted result; it does not save.
  await page.keyboard.press('Enter');
  await expect(page.locator('.omnitime-target__label')).toContainText(`#${api.issue.issue_id}`);
  await expect(page.locator('.omnitime-search__results')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await api.entries()).toEqual([]);

  // Focus stays on the issue line (the search box hid); Tab then follows the
  // row (back-to-current, date, Start time, Duration); Enter saves.
  await expect(page.locator('.omnitime-target__change')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.omnitime-target__reset')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.omnitime-f-datebtn')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.omnitime-f-start')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('1015');
  await page.keyboard.press('Tab');
  await expect(page.locator('.omnitime-f-dur')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  await expect(entryBlock(page, '10:15–10:45')).toBeVisible();
  const [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '10:15', duration_minutes: 30, issue_external_id: api.issue.issue_id });
});

test('My day: calendar placeholders lay out, move and turn into a booking', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await expect(calBlock(page, 'E2E Planning')).toBeVisible();
  await expect(page.locator('.omnitime-cal-status')).toContainText('Synced');

  // Overlapping events share the width side by side.
  for (const title of ['E2E Overlap A', 'E2E Overlap B']) {
    await expect(calBlock(page, title)).toHaveAttribute('style', /width: calc\(50% - 8px\)/);
  }

  // Hiding one of two overlapping events gives the other the full width back.
  await calBlock(page, 'E2E Overlap A').hover();
  await calBlock(page, 'E2E Overlap A').locator('.omnitime-tl__cal-dismiss').click();
  await expect(calBlock(page, 'E2E Overlap A')).toHaveCount(0);
  await expect(calBlock(page, 'E2E Overlap B')).toHaveAttribute('style', /width: auto/);

  // Dragging a placeholder moves it (regression: the drop used to throw and
  // leave the event's time unchanged, visible in the hover popover).
  await dragBy(page, calBlock(page, 'E2E Overlap B'), 140);
  await calBlock(page, 'E2E Overlap B').hover();
  await expect(page.locator('.omnitime-tl__cal-popover-time')).not.toContainText('15:30');
  await page.mouse.move(0, 0);

  // Clicking a placeholder prefills the form from the event.
  await calBlock(page, 'E2E Planning').click();
  await expect(page.locator('.omnitime-f-comment')).toHaveValue('E2E Planning');
  await expect(page.locator('.omnitime-f-start')).toHaveValue('13:00');
  await expect(page.locator('.omnitime-f-dur')).toHaveValue('0:45');
  await expect(page.locator('.omnitime-search__input')).toHaveValue('E2E Planning');
  await page.locator('.omnitime-save').click();

  await expect(entryBlock(page, '13:00–13:45')).toBeVisible();
  await expect(calBlock(page, 'E2E Planning')).toHaveCount(0); // booked from the calendar: hidden
  const [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '13:00', duration_minutes: 45, comment: 'E2E Planning' });
});

test('My day: a calendar event can be booked with the keyboard only', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  // Tab from the day nav through the timeline (time order) to the event.
  await page.locator('.omnitime-daynav [data-nav="next"]').focus();
  const event = calBlock(page, 'E2E Planning');
  await expect(event).toHaveAttribute('role', 'button');
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await event.evaluate((el) => el.getRootNode().activeElement === el)) break;
  }
  await expect(event).toBeFocused();
  await expect(event).toHaveAttribute('aria-label', /^13:00–13:45, calendar event: E2E Planning/);

  // Enter opens the prefilled form and moves the focus into it.
  await page.keyboard.press('Enter');
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(1);
  await expect(page.locator('.omnitime-f-comment')).toHaveValue('E2E Planning');
  await expect(page.locator('.omnitime-f-start')).toHaveValue('13:00');
  await expect(page.locator('.omnitime-search__input')).toBeFocused();

  // Book against the current issue (the default target) from the keyboard.
  await page.locator('.omnitime-save').focus();
  await page.keyboard.press('Enter');
  await expect(entryBlock(page, '13:00–13:45')).toBeVisible();
  await expect(calBlock(page, 'E2E Planning')).toHaveCount(0);
  const [entry] = await api.entries();
  expect(entry).toMatchObject({ start: '13:00', duration_minutes: 45, comment: 'E2E Planning', issue_external_id: api.issue.issue_id });
  // The meeting title is the comment line of the new entry block (meta, title, comment); the time range stays visible.
  await expect(entryBlock(page, '13:00–13:45').locator('.omnitime-tl__commenttext')).toHaveText('E2E Planning');
});

test('My day: an event booked elsewhere is hidden and remembers its issue', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await calBlock(page, 'E2E Planning').click();

  // Pick the issue via search and book the meeting later than it happened.
  if (await page.locator('.omnitime-target__change').isVisible()) await changeIssue(page);
  await page.locator('.omnitime-search__input').fill(api.search);
  await page.locator('.omnitime-search__item', { hasText: `#${api.issue.issue_id}` }).first().click();
  await fillForm(page, { start: '16:45', dur: '0:45' });
  await page.locator('.omnitime-save').click();
  await expect(entryBlock(page, '16:45–17:30')).toBeVisible();

  // Booked elsewhere, so the event is hidden.
  await expect(calBlock(page, 'E2E Planning')).toHaveCount(0);

  // Without its booking it comes back, with the issue preselected.
  await api.clearDay();
  await page.locator('.omnitime-tab[data-tab="issue"]').click();
  await page.locator('.omnitime-tab[data-tab="myday"]').click();
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);
  await calBlock(page, 'E2E Planning').click();
  await expect(page.locator('.omnitime-target__kicker')).toHaveText(/^(Remembered|Suggested) for this meeting$/);
  await expect(page.locator('.omnitime-target__label')).toContainText(`#${api.issue.issue_id}`);
  await page.locator('.omnitime-save').click();
  await expect(entryBlock(page, '13:00–13:45')).toBeVisible();
  const [entry] = await api.entries();
  expect(entry.issue_external_id).toBe(api.issue.issue_id);
});

test('My day: "Book meetings" books the day\'s meetings through the step dialog, then undoes them', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  // The e2e calendar: "E2E Planning" 13:00-13:45 and the overlapping "E2E Overlap A"
  // 15:00-16:00 / "E2E Overlap B" 15:30-16:30. All three can be booked.
  const book = page.locator('.omnitime-bookall');
  await expect(book).toContainText('Book meetings');
  await expect(book.locator('.omnitime-bookall__count')).toHaveText('3');
  await book.click();

  const dialog = page.locator('.omnitime-bk__panel');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.omnitime-bk__step[aria-current="step"]')).toHaveText('Review');
  const row = (title) => dialog.locator('.omnitime-bk__row', { has: page.locator('.omnitime-bk__name-title', { hasText: new RegExp(`^${title}$`) }) });
  await expect(dialog.locator('.omnitime-bk__name-title')).toHaveText(['E2E Planning', 'E2E Overlap A', 'E2E Overlap B']);
  // Meetings later today start unchecked: check what we book, leave "Overlap B" out
  // (it overlaps "Overlap A").
  await row('E2E Planning').locator('.omnitime-bk__check').check();
  await row('E2E Overlap A').locator('.omnitime-bk__check').check();
  await row('E2E Overlap B').locator('.omnitime-bk__check').uncheck();
  await expect(row('E2E Planning').locator('.omnitime-bk__skel')).toHaveCount(0); // suggestions loaded

  // A suggestion, if the e2e user has a history: clicking swaps it with "Book on" and back.
  const planning = row('E2E Planning');
  const suggestions = planning.locator('.omnitime-bk__sugg');
  if (await suggestions.count()) {
    const before = await planning.locator('.omnitime-bk__on .omnitime-bk__chiptext').textContent().catch(() => null);
    const first = await suggestions.first().locator('.omnitime-bk__chiptext').textContent();
    await suggestions.first().click();
    await expect(planning.locator('.omnitime-bk__on .omnitime-bk__chiptext')).toHaveText(first);
    if (before) {
      await expect(suggestions.first().locator('.omnitime-bk__chiptext')).toHaveText(before);
      await suggestions.first().click();
      await expect(planning.locator('.omnitime-bk__on .omnitime-bk__chiptext')).toHaveText(before);
    }
  }

  // Pick the e2e issue for both rows with Search...
  for (const title of ['E2E Planning', 'E2E Overlap A']) {
    await row(title).locator('.omnitime-bk__find-btn').click();
    await row(title).locator('.omnitime-bk__finder-input').fill(api.search);
    await dialog.locator('.omnitime-search__item', { hasText: `#${api.issue.issue_id}` }).first().click();
    await expect(row(title).locator('.omnitime-bk__on')).toContainText(`#${api.issue.issue_id}`);
  }
  await expect(dialog.locator('.omnitime-bk__summary')).toContainText('2 of 3 selected');
  await expect(dialog.locator('.omnitime-bk__ok')).toHaveText('Book 2 meetings');
  await dialog.locator('.omnitime-bk__ok').click();

  // Booking -> Done.
  await expect(dialog.locator('.omnitime-bk__result')).toContainText('Booked 2 meetings');
  await expect(dialog.locator('.omnitime-bk__step[aria-current="step"]')).toHaveText('Done');
  await expect(dialog.locator('.omnitime-bk__prow--ok')).toHaveCount(2);
  const entries = await api.entries();
  expect(entries.map((e) => [e.start, e.duration_minutes, e.comment, e.issue_external_id])).toEqual([
    ['13:00', 45, 'E2E Planning', api.issue.issue_id],
    ['15:00', 60, 'E2E Overlap A', api.issue.issue_id],
  ]);
  // Done closes the dialog and reloads: the booked events are gone.
  await dialog.locator('.omnitime-bk__ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(entryBlock(page, '13:00–13:45')).toBeVisible();
  await expect(calBlock(page, 'E2E Planning')).toHaveCount(0);
  await expect(calBlock(page, 'E2E Overlap A')).toHaveCount(0);

  // Booking again from the footer is not offered for them; Undo from a second run
  // is covered below by undoing the first one: clear the day and reopen.
  await api.clearDay();
  await page.locator('.omnitime-tab[data-tab="issue"]').click();
  await page.locator('.omnitime-tab[data-tab="myday"]').click();
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);
  await expect(calBlock(page, 'E2E Planning')).toBeVisible();

  // Undo in the dialog's last step deletes exactly what it created.
  await book.click();
  await row('E2E Planning').locator('.omnitime-bk__check').check();
  await row('E2E Overlap A').locator('.omnitime-bk__check').uncheck();
  await row('E2E Overlap B').locator('.omnitime-bk__check').uncheck();
  // The issue booked before is now this meeting's history: preselected by the server.
  await expect(row('E2E Planning').locator('.omnitime-bk__skel')).toHaveCount(0);
  if (!(await row('E2E Planning').locator('.omnitime-bk__on').count())) {
    await row('E2E Planning').locator('.omnitime-bk__find-btn').click();
    await row('E2E Planning').locator('.omnitime-bk__finder-input').fill(api.search);
    await dialog.locator('.omnitime-search__item', { hasText: `#${api.issue.issue_id}` }).first().click();
  }
  await dialog.locator('.omnitime-bk__ok').click();
  await expect(dialog.locator('.omnitime-bk__result')).toContainText('Booked 1 meeting');
  await expect.poll(async () => (await api.entries()).length).toBe(1);
  await dialog.locator('.omnitime-bk__cancel').click(); // Undo
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await api.entries()).length).toBe(0);
  await expect(calBlock(page, 'E2E Planning')).toBeVisible();
});

test('My day: an empty day copies entries from the previous working day', async ({ api, issuePage: page }) => {
  const prev = prevWorkingDay();
  await api.create({ date: prev, start_time: '09:00', duration: 30, comment: 'e2e copy one' });
  await api.create({ date: prev, start_time: '10:00', duration: 15, comment: 'e2e copy two' });
  await openMyDay(page);
  await expect(page.locator('.omnitime-tl__entry')).toHaveCount(0);

  await page.locator('.omnitime-tl__copy').click();
  const pop = page.locator('.omnitime-daypop');
  await expect(pop.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(pop.locator('.omnitime-daypop__meta').first()).toContainText('09:00–09:30');
  // Leave the second one out.
  await pop.locator('input[type="checkbox"]').nth(1).uncheck();
  await expect(pop.locator('.omnitime-daypop__ok')).toHaveText('Copy 1 entry');
  await pop.locator('.omnitime-daypop__ok').click();
  await expect(pop).toHaveCount(0);
  await expect(page.locator('.omnitime-toast__msg')).toHaveText('Copied 1 entry');
  await expect(entryBlock(page, '09:00–09:30')).toBeVisible();
  const entries = await api.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ start: '09:00', duration_minutes: 30, comment: 'e2e copy one', issue_external_id: api.issue.issue_id });
  // The source day is untouched.
  expect(await api.entries(prev)).toHaveLength(2);
});

test('toolbar icon opens My day as an overlay on any page and toggles it', async ({ context, extension }) => {
  const page = await context.newPage();
  await page.goto('https://elsewhere.omnitime.test/');
  const clickIcon = () => extension.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://elsewhere.omnitime.test/*' });
    await openOverlay(tab);
  });

  await clickIcon();
  await expect(page.locator('.omnitime-modal .omnitime-tl')).toBeVisible();
  // No issue on this page: My day + Week, no "This issue".
  await expect(page.locator('.omnitime-tab')).toHaveCount(2);
  await expect(page.locator('.omnitime-tab[data-tab="issue"]')).toHaveCount(0);
  await expect(page.locator('.omnitime-title')).toHaveText('My day');
  // Mounted in the shadow root of a single host; nothing in the page's DOM
  // and no page-level stylesheet (CSS locators pierce open shadow roots).
  expect(await page.evaluate(() => ({
    hosts: document.querySelectorAll('omnitime-root').length,
    lightDom: document.querySelectorAll('[class*="omnitime"]').length,
    sheets: [...document.styleSheets].length,
  }))).toEqual({ hosts: 1, lightDom: 0, sheets: 0 });

  await clickIcon();
  await expect(page.locator('.omnitime-modal-overlay')).toHaveCount(0);

  await clickIcon();
  await expect(page.locator('.omnitime-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.omnitime-modal-overlay')).toHaveCount(0);
});

test('Escape closes the topmost layer first: search results, form, then the modal', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(1);
  await changeIssue(page);
  await page.locator('.omnitime-search__input').fill(api.search);
  await expect(page.locator('.omnitime-search__item').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.omnitime-search__results')).toBeHidden();
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.omnitime-myday__cols--form-open')).toHaveCount(0);
  await expect(page.locator('.omnitime-modal')).toBeVisible();

  // The closed form leaves the pointer over the timeline; a hovered meeting's
  // popover would be the topmost layer, so move away first.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('omnitime-root')).toHaveCount(0);
});

test('the modal is an accessible dialog with keyboard tabs', async ({ issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  const dialog = page.getByRole('dialog', { name: 'Time tracking' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('tab', { name: 'This issue' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'This issue' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'My day' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'My day' })).toBeFocused();
  await expect(page.locator('.omnitime-tl')).toBeVisible();
});

test('starred issues: star from search, listed under "Starred", unstar', async ({ api, issuePage: page }) => {
  await openMyDay(page);
  await page.locator('.omnitime-add-btn').click();
  const input = page.locator('.omnitime-search__input');
  await changeIssue(page);
  await input.fill(api.search);
  const row = page.locator('.omnitime-search__row', { hasText: `#${api.issue.issue_id}` }).first();
  const star = row.locator('.omnitime-search__star');
  await expect(star).toBeVisible();
  const id = await star.getAttribute('data-star-id');
  const wasStarred = (await api.bookmarkIds()).includes(id);
  try {
    // Start unstarred (the modal caches my-bookmarks per open: reopen after).
    if (wasStarred) {
      await api.unbookmark(id);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await openMyDay(page);
      await page.locator('.omnitime-add-btn').click();
      await changeIssue(page);
      await input.fill(api.search);
    }
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await api.bookmarkIds()).includes(id)).toBe(true);

    // Empty query: "Starred" comes first and lists it.
    await input.fill('');
    const starredGroup = page.locator('.omnitime-search__results [role="group"]', { has: page.locator('.omnitime-search__group', { hasText: 'Starred' }) });
    await expect(page.locator('.omnitime-search__group').first()).toHaveText('Starred');
    await expect(starredGroup.locator(`.omnitime-star[data-star-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');

    // Unstar from the list.
    await starredGroup.locator(`.omnitime-star[data-star-id="${id}"]`).click();
    await expect.poll(async () => (await api.bookmarkIds()).includes(id)).toBe(false);
  } finally {
    // Leave the e2e user's bookmarks as they were, even when a step failed.
    const now = (await api.bookmarkIds()).includes(id);
    if (now && !wasStarred) await api.unbookmark(id);
    if (!now && wasStarred) await api.bookmark(id);
  }
});

test('Week tab shows today\'s entry and a day opens in My day', async ({ api, issuePage: page }) => {
  await api.create({ start_time: '08:00', duration: 15, comment: 'e2e week seed' });
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-tab[data-tab="week"]').click();
  const day = page.locator(`.omnitime-wk__day[data-date="${today()}"]`);
  await expect(day).toBeVisible();
  await expect(day.locator('.omnitime-wk__entry', { hasText: 'e2e week seed' })).toContainText('08:00–08:15');
  await expect(day.locator('.omnitime-wk__total')).toContainText('0:15');
  // An empty weekend is hidden until "Show weekend" (shown as soon as it has time).
  const weekendToggle = page.locator('.omnitime-wk__weekend');
  if (await weekendToggle.isVisible()) {
    await expect(page.locator('.omnitime-wk__day')).toHaveCount(5);
    await weekendToggle.click();
  }
  await expect(page.locator('.omnitime-wk__day')).toHaveCount(7);
  await expect(page.locator('.omnitime-wk__range')).toContainText('Week ');

  await day.locator('.omnitime-wk__head').click();
  await expect(page.locator('.omnitime-tab--active')).toHaveAttribute('data-tab', 'myday');
  await expect(page.locator('.omnitime-tl')).toBeVisible();
  await expect(entryBlock(page, '08:00–08:15')).toBeVisible();
});

// The e2e user is a regular user (no "view all time trackings"): no person
// picker in the Week tab, and the names in "This issue" are plain text.
test('regular user: no person picker in the Week tab, names are not clickable', async ({ api, issuePage: page }) => {
  await api.create({ start_time: '08:00', duration: 15, comment: 'e2e people seed' });
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await expect(page.locator('.omnitime-table:not(.omnitime-details-table) tr', { hasText: 'omnitime-e2e' })).toContainText('0:15');
  await expect(page.locator('.omnitime-personlink')).toHaveCount(0);
  await page.locator('.omnitime-tab[data-tab="week"]').click();
  await expect(page.locator('.omnitime-wk__day').first()).toBeVisible();
  await expect(page.locator('.omnitime-wk__whobtn')).toHaveCount(0);
  await expect(page.locator('.omnitime-wk__viewing')).toBeHidden();
  // Day heads stay clickable (own week): they open My day.
  await expect(page.locator(`.omnitime-wk__day[data-date="${today()}"] button.omnitime-wk__head`)).toHaveCount(1);
});

// The quick-track widget under the sidebar's "Time tracking" section.
// It is collapsed on every page load (privacy): the chevron next to the heading
// expands it, which is also when its numbers are fetched.
const sidebarWidget = (page) => page.locator('[data-testid="work-item-time-tracking"] .omnitime-sw');
const sidebarChevron = (page) => page.locator('[data-testid="work-item-time-tracking"] h3 .omnitime-sw__chev');
async function expandSidebar(page) {
  await sidebarChevron(page).click();
  await expect(sidebarChevron(page)).toHaveAttribute('aria-expanded', 'true');
  return sidebarWidget(page);
}

// Minutes shown in a "h:mm" element. "You" is the whole time on the issue
// (own_sum) on the new API, today's time on older servers, and the issue total
// may include other people's: the tests compare these as deltas.
const minutesOf = async (locator) => {
  await expect(locator).toHaveText(/^\d+:\d\d$/);
  const [h, m] = (await locator.textContent()).split(':').map(Number);
  return h * 60 + m;
};

test('sidebar widget: totals, the 15m segment books an entry ending now, Undo removes it', async ({ api, issuePage: page }) => {
  let widget = await expandSidebar(page);
  const ownBase = await minutesOf(widget.locator('[data-el="own"]'));
  await api.create({ start_time: '08:00', duration: 30, comment: 'e2e seed' });
  await page.reload(); // the widget loaded before the seed existed
  widget = await expandSidebar(page);
  const ownMinutes = () => minutesOf(widget.locator('[data-el="own"]'));
  const issueMinutes = () => minutesOf(widget.locator('[data-el="issue"]'));
  await expect.poll(ownMinutes).toBe(ownBase + 30);
  const issueBefore = await issueMinutes();

  const before = new Date();
  await widget.getByRole('button', { name: 'Add 15 minutes, ending now' }).click();
  await expect(widget.locator('[data-el="msg"]')).toContainText('Added 0:15');
  await expect.poll(ownMinutes).toBe(ownBase + 45);
  await expect.poll(issueMinutes).toBe(issueBefore + 15);

  const entries = await api.entries();
  expect(entries).toHaveLength(2);
  const added = entries.find((e) => e.comment !== 'e2e seed');
  expect(added).toMatchObject({ duration_minutes: 15, issue_external_id: api.issue.issue_id });
  // Starts on the 5-minute grid and ends at or just before now (a few minutes of slack for the snapping).
  const [h, m] = added.stop.split(':').map(Number);
  const nowMin = before.getHours() * 60 + before.getMinutes();
  expect(Number(added.start.slice(3)) % 5).toBe(0);
  expect(h * 60 + m).toBeLessThanOrEqual(nowMin + 2);
  expect(h * 60 + m).toBeGreaterThanOrEqual(nowMin - 6);

  await widget.locator('[data-el="msg"] button', { hasText: 'Undo' }).click();
  await expect.poll(ownMinutes).toBe(ownBase + 30);
  expect((await api.entries()).map((e) => e.comment)).toEqual(['e2e seed']);
});

test('sidebar widget: a regular user (own time + Others) gets the summary line but no people list', async ({ issuePage: page }) => {
  const widget = await expandSidebar(page);
  await expect(widget.locator('[data-el="own"]')).toHaveText(/^\d+:\d\d$/);
  await expect(widget.locator('[data-el="people"]')).toBeHidden();
  await expect(widget.locator('.omnitime-sw__person')).toHaveCount(0);
});

test('sidebar widget: clicking the totals opens the modal', async ({ issuePage: page }) => {
  const widget = await expandSidebar(page);
  await widget.locator('[data-el="totals"]').click();
  await expect(page.locator('.omnitime-modal')).toBeVisible();
});

test('sidebar widget survives the sidebar being re-created, without doubling', async ({ issuePage: page }) => {
  await expandSidebar(page);
  await expect(sidebarWidget(page).locator('[data-el="issue"]')).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('aside').innerHTML = '<div data-testid="work-item-time-tracking"><h3>Time tracking</h3></div>';
  });
  // Still expanded afterwards; one chevron host and one details host.
  await expect(sidebarWidget(page).locator('[data-el="issue"]')).toBeVisible();
  await expect(sidebarChevron(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('omnitime-inline')).toHaveCount(2);
});

test('sidebar widget: collapsed by default shows no totals; presentation mode removes the chevron', async ({ context, extension, issuePage: page }) => {
  // Collapsed on load: just the chevron, nothing of the widget.
  await expect(sidebarChevron(page)).toHaveAttribute('aria-label', 'Show time tracking');
  await expect(sidebarChevron(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('omnitime-inline')).toHaveCount(1);
  await expect(page.locator('[data-el="issue"], [data-el="totals"], .omnitime-sw__btn')).toHaveCount(0);

  // Presentation mode (set as the toolbar menu does) removes the chevron live...
  await extension.worker.evaluate(() => chrome.storage.local.set({ omnitimePresentationMode: true }));
  await expect(sidebarChevron(page)).toHaveCount(0);
  await expect(page.locator('omnitime-inline')).toHaveCount(0);
  // ...and the heading still opens the modal on purpose.
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await expect(page.locator('.omnitime-modal')).toBeVisible();

  // A fresh page load renders none either; turning it off brings the chevron back.
  const fresh = await context.newPage();
  await fresh.goto(issueUrl);
  await expect(fresh.locator('[data-testid="work-item-time-tracking"] h3')).toHaveAttribute('title', 'Click to view OmniTime report');
  await fresh.waitForTimeout(500);
  await expect(fresh.locator('omnitime-inline')).toHaveCount(0);
  await extension.worker.evaluate(() => chrome.storage.local.set({ omnitimePresentationMode: false }));
  await expect(sidebarChevron(fresh)).toHaveAttribute('aria-expanded', 'false');
});

test('sidebar widget can be turned off in the settings', async ({ context, extension }) => {
  await extension.worker.evaluate(() => chrome.storage.sync.set({ showSidebarWidget: false }));
  const page = await context.newPage();
  await page.goto(issueUrl);
  await expect(page.locator('[data-testid="work-item-time-tracking"] h3')).toHaveAttribute('title', 'Click to view OmniTime report');
  await page.waitForTimeout(500);
  await expect(page.locator('omnitime-inline')).toHaveCount(0);
});

// --- Running timer ---
// The timer lives in chrome.storage.local (`omnitimeTimer`); tests move its
// start into the past through the service worker instead of waiting.
const setTimerStart = (worker, minutesAgo) => worker.evaluate(async (m) => {
  const { omnitimeTimer } = await chrome.storage.local.get('omnitimeTimer');
  await chrome.storage.local.set({ omnitimeTimer: { ...omnitimeTimer, startedAt: new Date(Date.now() - m * 60000 - 3000).toISOString() } });
}, minutesAgo);
const minutesIntoDay = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

test('timer: start on "This issue", the pill shows, Stop books an entry for the issue, Undo restores it', async ({ api, extension, issuePage: page }) => {
  test.skip(minutesIntoDay() < 50, 'a 40-minute booking would cross midnight');
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-timer-start').click();
  const pill = page.locator('.omnitime-timerpill');
  await expect(pill).toBeVisible();
  await expect(pill.locator('.omnitime-timerpill__issue')).toContainText(`#${api.issue.issue_id}`);
  await expect(page.locator('.omnitime-timer-start')).toContainText('Stop timer');

  await setTimerStart(extension.worker, 40);
  await expect(pill.locator('.omnitime-timerpill__time')).toHaveText('0:40');
  await pill.getByRole('button', { name: /^Stop timer/ }).click();
  await expect(page.locator('.omnitime-toast')).toContainText('Booked 0:40');
  await expect(pill).toBeHidden();
  const entries = await api.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ duration_minutes: 40, issue_external_id: api.issue.issue_id });
  expect(Number(entries[0].start.slice(3)) % 5).toBe(0);
  expect(await extension.worker.evaluate(async () => (await chrome.storage.local.get('omnitimeTimer')).omnitimeTimer)).toBeUndefined();

  await page.locator('.omnitime-toast__action', { hasText: 'Undo' }).click();
  await expect(pill).toBeVisible();
  expect(await api.entries()).toEqual([]);
  expect(await extension.worker.evaluate(async () => !!(await chrome.storage.local.get('omnitimeTimer')).omnitimeTimer)).toBe(true);
});

test('timer: a forgotten timer asks for the end time instead of booking, and can keep running', async ({ api, extension, issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-timer-start').click();
  await setTimerStart(extension.worker, 12 * 60);
  await page.locator('.omnitime-timerpill__stop').click();
  await expect(page.locator('.omnitime-timerpanel input[type="time"]')).toBeVisible();
  await expect(page.locator('.omnitime-timerpanel__hint')).toContainText('Books 1:00');
  expect(await api.entries()).toEqual([]);
  await page.keyboard.press('Escape'); // closes the confirm, not the dialog
  await expect(page.locator('.omnitime-timerpanel')).toHaveCount(0);
  await expect(page.locator('.omnitime-modal')).toBeVisible();
  await expect(page.locator('.omnitime-timerpill')).toBeVisible();
});

test('timer: starting while another timer runs asks to book it first', async ({ api, extension, issuePage: page }) => {
  // A timer on another (synthetic) issue, started just now.
  await extension.worker.evaluate((issue) => chrome.storage.local.set({
    omnitimeTimer: { startedAt: new Date(Date.now() - 4 * 60000).toISOString(), issue: { ...issue, issue_id: '999999', label: '#999999 Elsewhere' }, comment: '' },
  }), api.issue);
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-timer-start').click();
  await expect(page.locator('.omnitime-timerpanel')).toContainText('#999999 Elsewhere');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await extension.worker.evaluate(async () => (await chrome.storage.local.get('omnitimeTimer')).omnitimeTimer.issue.issue_id)).toBe('999999');
});

test('timer: the toolbar badge shows the elapsed time in red while it runs, the day total after', async ({ api, extension, issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await page.locator('.omnitime-timer-start').click();
  await setTimerStart(extension.worker, 40);
  const badge = () => extension.worker.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    color: await chrome.action.getBadgeBackgroundColor({}),
  }));
  await expect.poll(async () => (await badge()).text).toBe('0:40');
  expect((await badge()).color.slice(0, 3)).toEqual([198, 40, 40]);
  // Discard (via the storage key, as another tab would): the badge leaves the timer.
  await extension.worker.evaluate(() => chrome.storage.local.remove('omnitimeTimer'));
  await expect.poll(async () => (await badge()).text).not.toBe('0:40');
  expect((await badge()).color.slice(0, 3)).not.toEqual([198, 40, 40]);
});

test('timer: the sidebar widget starts, shows "● 0:40 · Stop" and books on Stop', async ({ api, extension, issuePage: page }) => {
  test.skip(minutesIntoDay() < 50, 'a 40-minute booking would cross midnight');
  const widget = await expandSidebar(page);
  const ownBase = await minutesOf(widget.locator('[data-el="own"]'));
  await widget.locator('[data-el="start"]').click();
  await expect(widget.locator('[data-el="timer"]')).toBeVisible();
  await setTimerStart(extension.worker, 40);
  await expect(widget.locator('[data-el="timer"]')).toContainText('0:40 · Stop');
  await widget.locator('[data-el="timerStop"]').click();
  await expect(widget.locator('[data-el="msg"]')).toContainText('Booked 0:40');
  await expect(widget.locator('[data-el="timer"]')).toBeHidden();
  await expect.poll(() => minutesOf(widget.locator('[data-el="own"]'))).toBe(ownBase + 40);
  const entries = await api.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ duration_minutes: 40, issue_external_id: api.issue.issue_id });
});

// --- Settings behind a gear ---
// The modal embeds the extension's own options page in an iframe (a web-
// accessible resource under a dynamic URL, so the ID in it changes per session).
const gearButton = (page) => page.locator('.omnitime-modal-gear');
const settingsFrame = (page) => page.frameLocator('.omnitime-settings__frame');

test('settings: the gear opens the options page in an iframe; a change saved there shows in My day after Back', async ({ extension, issuePage: page }) => {
  // The daily target is only shown on working days (and not on a full absence).
  const day = new Date().getDay();
  test.skip(day === 0 || day === 6, 'no daily target on weekends');
  await openMyDay(page);
  // The API's own target_minutes wins over the setting unless the setting is
  // 0:00 ("off"), so this test turns the target off and watches the footer.
  await expect(page.locator('.omnitime-progress')).toBeVisible();

  await gearButton(page).click();
  await expect(page.locator('.omnitime-settings__frame')).toHaveAttribute('src', /^chrome-extension:\/\/[^/]+\/options\.html\?embedded=1&theme=(light|dark)$/);
  const frame = settingsFrame(page);
  await expect(frame.locator('#dailyTarget')).toBeVisible();
  // The tabs behind the panel are inert; the panel has Back + "Settings".
  await expect(page.locator('.omnitime-settings__title')).toHaveText('Settings');

  await frame.locator('#dailyTarget').fill('0:00');
  await frame.locator('#dailyTarget').blur();
  await expect(frame.locator('#saveStatus')).toHaveText('Saved');
  expect(await extension.worker.evaluate(async () => (await chrome.storage.sync.get('dailyTargetMinutes')).dailyTargetMinutes)).toBe(0);

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.omnitime-settings')).toHaveCount(0);
  await expect(gearButton(page)).toBeFocused();
  // My day reloaded with the new setting: no target, no progress.
  await expect(page.locator('.omnitime-progress')).toBeHidden();
});

test('settings: an invalid value inside the frame shows an inline error and is not saved', async ({ extension, issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await gearButton(page).click();
  const frame = settingsFrame(page);
  await frame.locator('#dailyTarget').fill('8:75');
  await frame.locator('#dailyTarget').blur();
  await expect(frame.locator('#dailyTarget')).toHaveAttribute('aria-invalid', 'true');
  await expect(frame.locator('#dailyTargetError')).not.toBeEmpty();
  expect(await extension.worker.evaluate(async () => 'dailyTargetMinutes' in (await chrome.storage.sync.get('dailyTargetMinutes')))).toBe(false);
});

test('settings: Escape inside the frame closes the panel first (via the service worker), then the modal', async ({ issuePage: page }) => {
  await page.locator('[data-testid="work-item-time-tracking"] h3').click();
  await gearButton(page).click();
  const frame = settingsFrame(page);
  await frame.locator('#dailyTarget').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.omnitime-settings')).toHaveCount(0);
  await expect(page.locator('.omnitime-modal')).toBeVisible();
  await expect(gearButton(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('omnitime-root')).toHaveCount(0);
});

test('settings: the toolbar overlay on a non-GitLab page has the gear too', async ({ context, extension }) => {
  const page = await context.newPage();
  await page.goto('https://elsewhere.omnitime.test/');
  await extension.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://elsewhere.omnitime.test/*' });
    await openOverlay(tab);
  });
  await expect(page.locator('.omnitime-modal .omnitime-tl')).toBeVisible();
  await expect(gearButton(page)).toBeVisible();
  await gearButton(page).click();
  await expect(settingsFrame(page).locator('#apiUrl')).toBeVisible();
  // The service worker trusts the frame (an extension page), not the web page.
  await expect(settingsFrame(page).locator('#googleLoggedOutWrap, #googleLoggedInWrap').first()).toBeAttached();
});

test('settings: the not-configured notice offers "Open settings" in the same dialog', async ({ context, extension }) => {
  await extension.worker.evaluate(() => chrome.storage.sync.remove(['apiUrl', 'apiKey']));
  const page = await context.newPage();
  await page.goto('https://elsewhere.omnitime.test/');
  await extension.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://elsewhere.omnitime.test/*' });
    await openOverlay(tab);
  });
  await expect(page.locator('.omnitime-modal-content--message')).toContainText('API URL');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.locator('omnitime-root')).toHaveCount(1);
  await expect(settingsFrame(page).locator('#getStarted')).toBeVisible();
});

test('first install opens the settings in a tab with the "Get started" checklist', async ({ context, extension }) => {
  // The extension was just installed in this fresh profile (onInstalled "install").
  await expect.poll(() => context.pages().some((p) => /\/options\.html$/.test(p.url()))).toBe(true);
  const options = context.pages().find((p) => /\/options\.html$/.test(p.url()));
  // The test setup has saved the API URL and a site since the tab opened, so
  // reload it; sign-in is the step still missing (the tests use the legacy key).
  await options.reload();
  await expect(options.locator('#getStarted')).toBeVisible();
  await expect(options.locator('#stepSignIn')).not.toHaveClass(/step--done/);
  await expect(options.locator('#stepApi')).toHaveClass(/step--done/);
});

test('the modal moves by its header, resizes from a corner and reopens where it was left', async ({ extension, issuePage: page }) => {
  const dialog = page.locator('.omnitime-modal');
  const rounded = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  try {
    await openMyDay(page);
    const before = await dialog.boundingBox();

    // Drag by the empty header area (not the tabs, gear or close button).
    const header = await page.locator('.omnitime-modal-header').boundingBox();
    const hx = header.x + header.width / 2;
    const hy = header.y + header.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    // Left and down, so the whole dialog (and its corner) stays on screen.
    await page.mouse.move(hx - 25, hy + 15, { steps: 5 });
    await page.mouse.move(hx - 50, hy + 30, { steps: 5 });
    await page.mouse.up();
    const moved = await dialog.boundingBox();
    expect(Math.round(moved.x - before.x)).toBe(-50);
    expect(Math.round(moved.y - before.y)).toBe(30);
    await expect(page.locator('.omnitime-modal-overlay')).toBeVisible(); // a drag is not a backdrop click

    // Resize from the bottom-right corner (4px inside the 8px hit zone).
    const cx = moved.x + moved.width - 4;
    const cy = moved.y + moved.height - 4;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 40, cy - 40, { steps: 5 });
    await page.mouse.up();
    const smaller = await dialog.boundingBox();
    expect(smaller.width).toBeLessThan(moved.width);
    expect(smaller.height).toBeLessThan(moved.height);
    await page.mouse.move(smaller.x + smaller.width - 4, smaller.y + smaller.height - 4);
    await page.mouse.down();
    await page.mouse.move(smaller.x + smaller.width + 20, smaller.y + smaller.height + 20, { steps: 5 });
    await page.mouse.up();
    const resized = await dialog.boundingBox();
    expect(resized.width).toBeGreaterThan(smaller.width);
    expect(resized.height).toBeGreaterThan(smaller.height);

    // Close, reopen: same rect.
    await page.keyboard.press('Escape');
    await expect(page.locator('omnitime-root')).toHaveCount(0);
    await openMyDay(page);
    expect(rounded(await dialog.boundingBox())).toEqual(rounded(resized));

    // Double-clicking the header resets it.
    const h2 = await page.locator('.omnitime-modal-header').boundingBox();
    await page.mouse.dblclick(h2.x + h2.width / 2, h2.y + h2.height / 2);
    expect(rounded(await dialog.boundingBox())).toEqual(rounded(before));
  } finally {
    await extension.worker.evaluate(() => chrome.storage.local.remove(['omnitimeModalRect', 'omnitimeModalPos']));
  }
});
