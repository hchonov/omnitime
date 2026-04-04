// content.js - Main Logic for OmniTime Overlay

const formatTime = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

var omniDebugMode = false;

function log(...args) {
  if (typeof omniDebugMode !== 'undefined' && omniDebugMode) {
    console.log('OmniTime:', ...args);
  }
}

function warn(...args) {
  if (typeof omniDebugMode !== 'undefined' && omniDebugMode) {
    console.warn('OmniTime:', ...args);
  }
}

async function init() {
  const settings = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'instances', 'debug']);
  omniDebugMode = !!settings.debug;

  log('Extension initialized');
  log('Settings loaded', settings);

  if (!settings.instances || !settings.apiUrl) {
    warn('Missing configuration (instances or apiUrl)');
    return;
  }

  // Find if current host is one of our configured instances
  const config = settings.instances.find(inst => window.location.host === inst.hostUrl);
  if (!config) {
    // Silent return if not configured match
    return;
  }

  log('Configuration match found. Starting adapter selection.');

  // Determine Adapter System Type
  const systemType = config.systemType || 'gitlab'; // Default to gitlab
  let adapter;

  // Since we load adapters globally via manifest, check for them
  if (systemType === 'gitlab' && window.GitlabAdapter) {
    adapter = new window.GitlabAdapter();
    adapter.debugMode = omniDebugMode;
  } else {
    // Future support for 'jira', 'azure', etc.
    warn(`No adapter found for system type '${systemType}'.`);
    return;
  }

  log(`Using adapter '${adapter.name}'`);

  const scanForTarget = () => {
    // Use adapter to find the target element
    let target = adapter.scanForTarget();

    if (target) {
      if (!target.dataset.omniTimeInjected) {
        log(`Found target`, target);
        log('Injecting click listener into target');
        target.dataset.omniTimeInjected = "true";
        attachClick(target, settings, config, adapter);
      }
      // Return true because we found it (whether freshly injected or already there)
      return true;
    }
    return false;
  };

  // 1. Try immediately
  if (!scanForTarget()) {
    log('Target not found immediately. Starting Polling & Observer.');
  }

  // 2. Poll every second for 15 seconds (Fail-safe for SPAs)
  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (scanForTarget() || attempts > 15) {
      clearInterval(pollInterval);
      if (attempts > 15) log('Polling timed out. Target not found.');
    }
  }, 1000);

  // 3. Observe for future changes
  const observer = new MutationObserver((mutations) => {
    scanForTarget();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function attachClick(target, settings, instanceConfig, adapter) {
  // Use adapter to style the target (add pointer, title, etc)
  let trigger = adapter.styleTarget(target);

  trigger.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Show Loading Modal
    showModal('Loading time data...');

    try {
      // Get metadata from adapter
      const metadata = adapter.getMetadata();
      const source = encodeURIComponent(window.location.origin);
      const url = `${settings.apiUrl}?source=${source}&project_id=${metadata.project_id}&issue_id=${metadata.issue_id}`;

      const response = await chrome.runtime.sendMessage({
        action: 'FETCH_TIME_DATA',
        url: url,
        apiKey: settings.apiKey
      });

      if (response && response.success) {
        updateModalContent(response.data);
      } else {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (err) {
      console.error(err);
      updateModalError(`Failed to load time data: ${err.message}. Please check logs.`);
    }
  });
}

function showModal(initialText) {
  // Remove existing modal if any
  const existing = document.querySelector('.omnitime-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'omnitime-modal-overlay';
  overlay.innerHTML = `
    <div class="omnitime-modal">
      <div class="omnitime-modal-header">
        <h3>Tracking report</h3>
        <button class="omnitime-modal-close">&times;</button>
      </div>
      <div class="omnitime-modal-content">
        <div style="padding: 20px; text-align: center; color: #666;">${initialText}</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', handleEsc);
  };

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      cleanup();
    }
  };

  document.addEventListener('keydown', handleEsc);

  overlay.querySelector('.omnitime-modal-close').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
}

function updateModalContent(data) {
  const contentDiv = document.querySelector('.omnitime-modal-content');
  if (!contentDiv) return;

  const entries = data.tracked_time || [];
  const totalSum = data.total_sum || 0;
  const details = data.details || [];

  if (entries.length === 0 && totalSum === 0) {
    contentDiv.innerHTML = '<div style="padding: 20px; text-align: center;">No time tracking data found.</div>';
    return;
  }

  contentDiv.innerHTML = '';

  // 1. Summary Table (Per User)
  const summaryTable = document.createElement('table');
  summaryTable.className = 'omnitime-table';
  summaryTable.innerHTML = `
    <thead><tr><th>User</th><th>Total Time</th></tr></thead>
    <tbody>
      ${entries.map(u => `<tr><td>${u.user}</td><td>${formatTime(u.time_spent)}</td></tr>`).join('')}
      <tr class="omnitime-total-row"><td>Total</td><td>${formatTime(totalSum)}</td></tr>
    </tbody>
  `;
  contentDiv.appendChild(summaryTable);

  // 2. Detailed Logs (Collapsible)
  if (details.length > 0) {
    const detailsContainer = document.createElement('div');
    detailsContainer.className = 'omnitime-details-container';
    detailsContainer.innerHTML = `
      <details class="omnitime-details-collapsible">
        <summary>View detailed logs</summary>
        <div class="omnitime-details-scroll">
          <table class="omnitime-table omnitime-details-table">
            <thead>
              <tr><th>Date</th><th>User</th><th>Time</th><th>Comment</th></tr>
            </thead>
            <tbody>
              ${details.map(d => `
                <tr>
                  <td>${d.start_time}</td>
                  <td>${d.user}</td>
                  <td>${formatTime(d.time_spent)}</td>
                  <td class="omnitime-comment" title="${d.comment || ''}">${d.comment || ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </details>
    `;
    contentDiv.appendChild(detailsContainer);
  }
}

function updateModalError(msg) {
  const contentDiv = document.querySelector('.omnitime-modal-content');
  if (contentDiv) {
    contentDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: #d9534f;">${msg}</div>`;
  }
}

init();