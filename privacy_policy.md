# Privacy Policy for OmniTime

**Last Updated:** 2026-10-23

OmniTime ("the Extension") shows and edits your time entries from a time tracking provider that you configure, inside your ticket management system (for example GitLab) and in a toolbar overlay. The developers do not operate any server for the Extension. We do not collect, receive or share your data, and the Extension contains no analytics or advertising.

## 1. Where data is sent
The Extension makes network requests only to the destinations below, only for the purposes described, and only from your browser.

1. **The Provider URL you configured** (your 1x TIMES server or another compatible provider). The Extension sends and receives:
   - your time entries (read, create, change, delete), with their comments, issue and project names;
   - issue search and your starred issues (bookmarks);
   - your week overview, which includes your absence markers ("Absent", full or half day);
   - booking suggestions: if you book calendar meetings, the meeting's **title and start time** are sent to the provider to suggest an issue.

   Requests are authenticated with your Google sign-in or, if you use it, the API key you saved.
2. **Google**, only if you choose "Sign in with Google" in the Options:
   - `accounts.google.com`: the sign-in and consent screen;
   - `www.googleapis.com/oauth2/v3/userinfo`: your name, email address and profile picture, shown in the Options;
   - `oauth2.googleapis.com/tokeninfo` and `oauth2.googleapis.com/revoke`: checking a sign-in token and revoking it when you sign out;
   - the Google Calendar API (`www.googleapis.com/calendar/v3`), only if you turn on "Use Google Calendar": your primary calendar, read-only, to show meetings as placeholders in your day.
3. **The iCal URL you configured**, if any: the calendar feed is downloaded to show meetings as placeholders.

No other network destinations are contacted. Data is never sent to the developers.

## 2. Background activity
Without any page being open, the Extension's background worker:
- fetches today's tracked total from the Provider about every 15 minutes, to show it on the toolbar icon (can be turned off with "Show badge");
- refreshes the calendar every 3 hours when a calendar is configured;
- on weekdays at the time you chose, if you enabled the end-of-day reminder, checks today's total, your absence and unbooked meetings and may show a notification. The reminder is off by default.

## 3. What is stored in your browser
All of the following stays in your browser's extension storage on your device.
- **Settings** (Provider URL, optional API key, host mappings, calendar options, day hours, target, badge and reminder choices) in `chrome.storage.sync`. If you are signed in to your browser's sync, the browser may sync these settings between your devices.
- **Google account details** (name, email address, profile picture), shown in the Options, in `chrome.storage.local` until you sign out.
- **The Google sign-in token**: in session storage only, readable only by the Extension's own trusted scripts, and cleared when the browser closes. The Extension then signs in again silently, if your Google grant is still valid.
- **Calendar cache** (`chrome.storage.local`): for each event within about three months back and forward, its title, time, description, location, status and your own response (accepted, declined...). Attendee lists, organisers, conference links and attachments are not requested. The Google Calendar cache is removed when you log out. A downloaded iCal feed is cached as received (it can contain more than the fields above) until the next sync replaces it; the secret iCal address itself is a setting, so treat it as sensitive.
- **Meeting memory**: for each recurring meeting you booked, its title, the issue you chose and up to 30 recent bookings. A meeting you have not booked for 180 days is forgotten automatically. You can remove entries at any time with "Forget" or "Forget all" in the Options.
- **Recently viewed colleagues** (project managers only): the id and name of up to 10 people whose week you opened, in `chrome.storage.local` on this device. Removed when you sign out or lose the permission to view others' time.
- **Eight recent issues** and the **running timer** (start time and issue).

**Shown, never stored:** your absences ("Absent") are displayed in the Week view and used by the reminder, but are never written to storage and never logged.

## 4. The toolbar overlay and permissions
- When you click the toolbar icon, the Extension injects its overlay into the **active tab only**, on that click. It runs in an isolated (closed) shadow root, so the page cannot read or change it. The Extension does not read the content of the page.
- On the ticket systems you configured, it also adds a time tracking section and a quick-track widget. It reads only the project and issue identifiers and the title of the page it is on.

**Why we request "Read and change all your data on the websites you visit" (`*://*/*`):**
The Extension must be able to talk to *your* Provider and to inject its overlay and widget on *your* ticket system. Because we cannot know your company's domains in advance (for example `https://time.mycompany.com`), the permission cannot be narrowed. The Extension sends data only to the destinations listed in section 1 and acts on a page only on the hosts you configured, or the active tab when you click the icon.

Other permissions:
- `storage`: save your settings and the data in section 3;
- `scripting`: show the overlay and register the scripts for your configured hosts;
- `alarms`: the periodic refreshes in section 2;
- `unlimitedStorage`: keep the calendar cache and meeting memory;
- `identity`: Google sign-in;
- `notifications`: the optional end-of-day reminder.

## 5. Google API Services User Data Policy (Limited Use)
OmniTime's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. In particular:
- Calendar data (`calendar.readonly`) is used only to show your meetings as placeholders and to let you book them as time entries. Your meeting title and start time are sent to the Provider you configured, only to suggest an issue, and only when you book meetings.
- It is not used for advertising, is not sold, and is not transferred to anyone else except as described in section 1 or as required by law.
- No human at the developers reads your data: it never reaches us.

## 6. Your choices
- Sign out in the Options: the sign-in token is revoked and the Google account details and Google Calendar cache are deleted.
- Remove the iCal URL (the cached feed is replaced at the next sync) or turn off "Use Google Calendar" to stop calendar integration.
- Forget remembered meetings in the Options, or remove the Extension to delete all of its stored data.
- Revoke the Extension's access in your Google Account settings (Security > Third-party access).
- Data held by your Provider (time entries, absences) is governed by the Provider's own privacy policy and your organisation.

## 7. Changes
We may update this policy to reflect changes in our practices. Review this file in the repository or listing for updates.

## 8. Contact
For questions about this policy, please contact: Hristo Chonov (hristo.chonov@gmail.com).
