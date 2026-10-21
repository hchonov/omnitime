// content.js - Production glue for OmniTime. Reads settings, locates the host
// "Time tracking" element via the adapter, and opens the OmniTime modal
// (defined in core.js) wired to the chrome.runtime fetch proxy (background.js).

var omniDebugMode = false;

// Normalize legacy saved URLs without requiring users to re-save Options.
// Keep this compatible with the copy in options.js.
function normalizeInstanceHost(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  const hasPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(input);
  if (!hasScheme && /^[a-z][a-z\d+.-]*:/i.test(input) && !hasPort) return null;
  if (/^https?:\/\/\//i.test(input)) return null;

  try {
    const url = new URL(hasScheme ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.hostname.includes('*')) return null;
    return url.host;
  } catch (e) {
    return null;
  }
}

function log(...args) {
  if (omniDebugMode) console.log('OmniTime:', ...args);
}
function warn(...args) {
  if (omniDebugMode) console.warn('OmniTime:', ...args);
}

// Transport bound to the background service worker (avoids page CORS).
function makeTransport(apiKey) {
  return (method, url, body) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'OMNI_FETCH', method, url, body, apiKey }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (resp && resp.success) {
        resolve(resp.data);
      } else {
        const err = new Error((resp && resp.error) || 'Request failed');
        if (resp && resp.status) err.status = resp.status;
        reject(err);
      }
    });
  });
}

// Build the issue context (source/project/issue + label) for the modal.
function buildContext(adapter) {
  const context = { source: window.location.origin };
  try {
    const meta = adapter.getMetadata();
    context.project_id = meta.project_id;
    context.issue_id = meta.issue_id;
    // Best-effort human label from the page title, e.g. "Title (#689) · …".
    const title = (document.title || '').split(' · ')[0].trim();
    if (title) context.issue_label = title;
  } catch (e) {
    warn('Could not read issue metadata:', e.message);
  }
  return context;
}

async function init() {
  const settings = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'instances', 'debug', 'endpoints']);
  omniDebugMode = !!settings.debug;
  log('Extension initialized', settings);

  if (!Array.isArray(settings.instances) || !settings.apiUrl) {
    warn('Missing configuration (instances or apiUrl)');
    return;
  }

  const config = settings.instances.find((inst) =>
    normalizeInstanceHost(inst && inst.hostUrl) === window.location.host);
  if (!config) return;

  const systemType = config.systemType || 'gitlab';
  let adapter;
  if (systemType === 'gitlab' && window.GitlabAdapter) {
    adapter = new window.GitlabAdapter();
    adapter.debugMode = omniDebugMode;
  } else {
    warn(`No adapter found for system type '${systemType}'.`);
    return;
  }
  log(`Using adapter '${adapter.name}'`);

  // Endpoint URLs are pre-configured from the tracked-time base, but each can
  // be overridden in the options page (keeps the extension generic).
  const overrides = settings.endpoints || {};
  const endpoints = {
    trackedTime: settings.apiUrl,
    myDay: overrides.myDay,
    frequent: overrides.frequent,
    search: overrides.search,
  };
  const apiClient = window.OmniTime.createApiClient(makeTransport(settings.apiKey), endpoints);

  const scanForTarget = () => {
    const target = adapter.scanForTarget();
    if (target) {
      if (!target.dataset.omniTimeInjected) {
        target.dataset.omniTimeInjected = 'true';
        attachClick(target, adapter, apiClient);
      }
      return true;
    }
    return false;
  };

  if (!scanForTarget()) log('Target not found immediately. Polling & observing.');

  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (scanForTarget() || attempts > 15) clearInterval(pollInterval);
  }, 1000);

  const observer = new MutationObserver(() => scanForTarget());
  observer.observe(document.body, { childList: true, subtree: true });
}

function attachClick(target, adapter, apiClient) {
  const trigger = adapter.styleTarget(target);
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.OmniTime.openModal({ apiClient, context: buildContext(adapter) });
  });
}

init();
