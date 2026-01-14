# Privacy Policy for OmniTime

**Last Updated:** 2026-01-08

## 1. Data Collection
OmniTime ("the Extension") does not collect, store, or transmit any personal data to the developers or any third-party analytics services. 

The Extension communicates solely between:
1.  The website you are currently visiting (e.g., your generic ticket management system like GitLab, Jira).
2.  The external time tracking provider you have explicitly configured in the Extension settings.

## 2. API Keys and Configuration
Your Configuration Settings (Provider URL, API Keys, and Host mappings) are stored locally on your device using the browser's storage API (`chrome.storage.sync` or local). 
- **Encryption**: Data is encrypted by your browser/OS if you use sync features.
- **Access**: We (the developers) have no access to your API keys or configuration data.

## 3. Network Requests
The Extension makes network requests (via `fetch`) **only** to the Provider URL you have configured.
- These requests are performed to retrieve time tracking data relevant to the tickets you view.
- No other background network activity occurs.

## 4. Permissions
The Extension requests access to websites (hosts) solely for the purpose of:
1.  Detecting if the current page matches one of your configured instances.
2.  Injecting the "Tracking report" overlay into the page.

We use **Optional Permissions** where possible to ensure the Extension only runs on the specific corporate or public domains you authorize.

**Why we request "Read and change all your data on the websites you visit" (`*://*/*`):**
This permission is technically required to allow the extension to interact with *your* specific API instance. Since we cannot know your company's domain name in advance (e.g., `https://time.mycompany.com`), we must request the ability to communicate with any URL you configure.
-   **Rest assured**: The extension **only** sends data to the "Provider URL" you explicitly save in the settings. It does not indiscriminately access or transmit data from other sites.

## 5. Changes
We may update this policy to reflect changes in our practices. Review this file in the repository or listing for updates.

## 6. Contact
For questions about this policy, please contact: Hristo Chonov (hristo.chonov@gmail.com).
