# OmniTime: Universal Time Tracking Overlay

OmniTime is a browser extension that retrieves time tracking information from your external system (e.g., custom time tracker, Jira, internal tool) and embeds it directly into your ticket management system (currently supporting GitLab).

It provides a "Tracking report" overlay when viewing Issues or Merge Requests, allowing you to see time spent without leaving the ticket page.

## Features
-   **Universal Backend**: Works with any backend that implements the simple JSON API.
-   **Security**: Uses optional permissions. You explicitly grant access only to the sites you use (e.g., your company's GitLab instance).
-   **Privacy**: No data collection. Requests are made directly from your browser to your configured provider.

## Installation

### Chrome / Edge / Brave
1.  Download the `omnitime_*.zip` file from the [Releases page](../../releases).
2.  Unzip it to a folder.
3.  Open `chrome://extensions/`.
4.  Enable **Developer mode** (top right).
5.  Click **Load unpacked**.
6.  Select the folder where you unzipped the extension.

### Firefox
1.  Download the `omnitime_*.xpi` file from the [Releases page](../../releases).
2.  Open `about:addons`.
3.  Click the gear icon (settings) -> **Install Add-on From File...**.
4.  Select the `.xpi` file.
    *   *Note: For self-hosted/unsigned extensions, you may need to use Firefox Developer Edition or load it temporarily via `about:debugging`.*

## Configuration

1.  **Open Options**:
    *   Click the extension icon in your browser toolbar and select **Options**.
2.  **Global Provider Settings**:
    *   **Provider URL**: The endpoint of your time tracking API (e.g., `https://api.mycompany.com/time-stats`).
    *   **API Key**: (Optional) Your API key, sent as `api-key` header.
3.  **Instances**:
    *   **Host URL**: The domain where you want the extension to run (e.g., `gitlab.com` or `gitlab.mycompany.com`).
    *   **Source ID**: An ID forwarded to your API to identify the source system.
    *   **System Type**: Select "GitLab" (more types coming soon).
4.  **Save & Grant Permissions**:
    *   Click **Save All Settings**.
    *   Click **Save All Settings**.
    *   Accept the browser permission prompt to allow the extension to run on your configured Host URLs.
    *   *Note: You may see a warning about "reading and changing data on all websites". This is required because the extension supports custom domains for your API instance, which we cannot whitelist in advance.*

## Usage

### Gitlab
1.  Navigate to a GitLab Issue or Merge Request.
2.  Locate the **Time tracking** section in the right sidebar.
3.  The **Time tracking** header looks as usual, however it is now clickable.
4.  **Click the header** to open the generic OmniTime overlay and view the time report for the ticket.

## API Specification

To use OmniTime with your custom backend, your API must support the following:

### Request
`GET {Provider URL}`

**Query Parameters:**
-   `project_id`: The project ID from the ticket system.
-   `issue_id`: The issue/ticket IID.
-   `source_id`: The value configured in the Options page.

**Headers:**
-   `api-key`: The configured API Key.
-   `Accept`: `application/json`

### Response
Must return JSON with specific keys:

```json
{
  "tracked_time": [
    {
      "user": "Users Name",
      "time_spent": 120
    },
    {
      "user": "Another User",
      "time_spent": 60
    }
  ],
  "total_sum": 180
}
```

-   `tracked_time`: List of user entries.
    -   `user`: The name of the user.
    -   `time_spent`: Minutes (integer).
-   `total_sum`: Total minutes (integer).

## Files
-   `privacy_policy.md`: Data handling details.
