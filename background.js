// background.js - Service worker. Performs API calls so content scripts are
// not subject to page CORS (host_permissions grant cross-origin access here).

function doFetch(request, sendResponse) {
  const method = (request.method || 'GET').toUpperCase();
  const headers = {
    'api-key': request.apiKey || '',
    'Accept': 'application/json',
  };
  const init = { method, headers };
  if (request.body !== undefined && request.body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }

  fetch(request.url, init)
    .then(async (response) => {
      let data = null;
      const text = await response.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = text;
      }
      if (!response.ok) {
        const message = data && data.message ? data.message : `HTTP error! status: ${response.status}`;
        sendResponse({ success: false, error: message, status: response.status });
        return;
      }
      sendResponse({ success: true, data });
    })
    .catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
}

function doFetchIcal(request, sendResponse) {
  const headers = { 'Accept': 'text/calendar, text/plain' };
  if (request.etag) headers['If-None-Match'] = request.etag;

  fetch(request.url, { method: 'GET', headers })
    .then(async (response) => {
      if (response.status === 304) {
        sendResponse({ success: true, notModified: true });
        return;
      }
      if (!response.ok) {
        sendResponse({ success: false, error: `HTTP ${response.status}`, status: response.status });
        return;
      }
      const data = await response.text();
      const etag = response.headers.get('ETag') || '';
      sendResponse({ success: true, data, etag });
    })
    .catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Generic request used by the new UI, plus the legacy GET action.
  if (request.action === 'OMNI_FETCH' || request.action === 'FETCH_TIME_DATA') {
    doFetch(request, sendResponse);
    return true; // Respond asynchronously.
  }
  // iCal feed fetch with conditional ETag support.
  if (request.action === 'OMNI_FETCH_ICAL') {
    doFetchIcal(request, sendResponse);
    return true;
  }
});
