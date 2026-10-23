// overlay-dashboard.js — Injected into the active tab by background.js when
// the extension icon is clicked.  Reuses the same openModal() UI from core.js
// in dashboardMode (shows "My Day" full timeline).  Toggle: if the overlay is
// already visible, clicking the icon again closes it.

(function () {
  'use strict';

  // Toggle: if the overlay is already open, close it and bail out.
  const existing = document.querySelector('.omnitime-modal-overlay');
  if (existing) {
    existing.remove();
    return;
  }

  // --- Transport bound to the background service worker (avoids page CORS) ---
  function makeTransport(apiKey) {
    return (method, url, body) => new Promise((resolve, reject) => {
      chrome.storage.sync.get(['debug'], (s) => {
        const debug = !!s.debug;
        if (debug) console.log(`OmniTime Dashboard: [API Request] ${method} ${url}`, body || '');
        chrome.runtime.sendMessage({ action: 'OMNI_FETCH', method, url, body, apiKey }, (resp) => {
          if (chrome.runtime.lastError) {
            if (debug) console.error('OmniTime Dashboard: [Runtime Error]', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp && resp.success) {
            if (debug) console.log(`OmniTime Dashboard: [API Response] ${method} ${url}:`, resp.data);
            resolve(resp.data);
          } else {
            if (debug) {
              console.warn(`OmniTime Dashboard: [API Error] ${method} ${url} | HTTP ${resp ? resp.status : '?'}:`, resp ? resp.error : 'Unknown', `(Auth: ${resp ? resp.authType : 'none'}${resp && resp.email ? ', Google User: ' + resp.email : ''})`);
            }
            const err = new Error((resp && resp.error) || 'Request failed');
            if (resp && resp.status) err.status = resp.status;
            reject(err);
          }
        });
      });
    });
  }

  function makeIcalTransport() {
    return (url, etag) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'OMNI_FETCH_ICAL', url, etag }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp && resp.success) {
          resolve(resp);
        } else {
          reject(new Error((resp && resp.error) || 'iCal fetch failed'));
        }
      });
    });
  }

  chrome.storage.sync.get(['apiUrl', 'apiKey', 'endpoints', 'icalUrl', 'useGoogleCalendar', 'dayStart', 'dayEnd'], (settings) => {
    chrome.storage.local.get(['googleAuthToken'], (local) => {
      const hasUrl = !!(settings.apiUrl && settings.apiUrl.trim());
      const hasAuth = !!(settings.apiKey && settings.apiKey.trim()) || !!local.googleAuthToken;

      if (!hasUrl || !hasAuth) {
        let missingMsg = '';
        if (!hasUrl && !hasAuth) {
          missingMsg = 'Please configure your API URL and authenticate (API key or Log In with Google) in the extension settings.<br><br>';
        } else if (!hasUrl) {
          missingMsg = 'Please configure your <strong>API URL</strong> in the extension settings.<br><br>';
        } else {
          missingMsg = 'Please configure your API key (or Log In with Google) in the extension settings.<br><br>';
        }

        // Show a minimal inline message if not configured.
        const overlay = document.createElement('div');
        overlay.className = 'omnitime-modal-overlay';
        overlay.innerHTML = `
          <div class="omnitime-modal omnitime-modal--dashboard">
            <div class="omnitime-modal-header">
              <div class="omnitime-headerleft"><span class="omnitime-title">1x TIMES — Time Tracking</span></div>
              <button class="omnitime-modal-close" aria-label="Close">
                <svg class="ot-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="omnitime-modal-content" style="padding:60px 40px;text-align:center;color:#666;font-size:16px;">
              ${missingMsg}
              Right-click the extension icon → Options.
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('.omnitime-modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
        document.addEventListener('keydown', function onKey(e) {
          if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
        });
        return;
      }

      const overrides = settings.endpoints || {};
      const cleanUrl = (url) => (url || '').trim().replace(/([^:])\/{2,}/g, '$1/');
      const rawApiUrl = cleanUrl(settings.apiUrl);
      const baseApi = rawApiUrl.replace(/\/tracked-time\/?$/, '');
      const endpoints = {
        trackedTime: rawApiUrl,
        myDay: cleanUrl(overrides.myDay) || (baseApi + '/my-tracked-time'),
        frequent: cleanUrl(overrides.frequent) || (baseApi + '/frequent-issues'),
        search: cleanUrl(overrides.search) || (baseApi + '/issue-search'),
      };

      const apiClient = window.OmniTime.createApiClient(makeTransport(settings.apiKey), endpoints);
      const icalTransport = makeIcalTransport();

      window.OmniTime.openModal({
        apiClient,
        context: {},
        icalUrl: settings.icalUrl || '',
        icalTransport,
        activeTab: 'myday',
        settings: {
          useGoogleCalendar: settings.useGoogleCalendar || false,
          dayStart: settings.dayStart !== undefined ? settings.dayStart : 8,
          dayEnd: settings.dayEnd !== undefined ? settings.dayEnd : 17
        }
    });
    });
  });
})();
