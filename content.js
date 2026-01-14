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
      const projectId = metadata.project_id;
      const issueIid = metadata.issue_id;

      // Construct URL
      // Use window.location.origin for the source parameter (e.g. https://git.1xinternet.de)
      const source = encodeURIComponent(window.location.origin);
      const url = `${settings.apiUrl}?source=${source}&project_id=${projectId}&issue_id=${issueIid}`;

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

  const modal = document.createElement('div');
  modal.className = 'omnitime-modal';

  const header = document.createElement('div');
  header.className = 'omnitime-modal-header';

  const h3 = document.createElement('h3');
  h3.textContent = 'Tracking report';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'omnitime-modal-close';
  closeBtn.innerHTML = '&times;'; // entity is safe here, or use textContent = '×'

  header.appendChild(h3);
  header.appendChild(closeBtn);

  const content = document.createElement('div');
  content.className = 'omnitime-modal-content';

  const initialMsg = document.createElement('div');
  initialMsg.style.cssText = 'padding: 20px; text-align: center; color: #666;';
  initialMsg.textContent = initialText;

  content.appendChild(initialMsg);

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

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

  if (entries.length === 0 && totalSum === 0) {
    contentDiv.innerHTML = '<div style="padding: 20px; text-align: center;">No time tracking entries found.</div>';
    return;
  }



  let rows = '';
  entries.forEach(u => {
    rows += `
      <tr>
        <td>${u.user}</td>
        <td>${formatTime(u.time_spent)}</td>
      </tr>
    `;
  });



  // Add total row
  rows += `
    <tr class="omnitime-total-row">
      <td>Total</td>
      <td>${formatTime(totalSum)}</td>
    </tr>
  `;

  // Conditionally hide "User" header text if there are no named user entries
  const userHeaderText = entries.length > 0 ? 'User' : '';

  contentDiv.innerHTML = ''; // Clear previous content safely

  const table = document.createElement('table');
  table.className = 'omnitime-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');

  const thUser = document.createElement('th');
  thUser.textContent = entries.length > 0 ? 'User' : '';

  const thTime = document.createElement('th');
  thTime.textContent = 'Time Spent';

  trHead.appendChild(thUser);
  trHead.appendChild(thTime);
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  entries.forEach(u => {
    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    tdUser.textContent = u.user;

    const tdTime = document.createElement('td');
    tdTime.textContent = formatTime(u.time_spent);

    tr.appendChild(tdUser);
    tr.appendChild(tdTime);
    tbody.appendChild(tr);
  });

  // Total row
  const trTotal = document.createElement('tr');
  trTotal.className = 'omnitime-total-row';

  const tdTotalLabel = document.createElement('td');
  tdTotalLabel.textContent = 'Total';

  const tdTotalValue = document.createElement('td');
  tdTotalValue.textContent = formatTime(totalSum);

  trTotal.appendChild(tdTotalLabel);
  trTotal.appendChild(tdTotalValue);
  tbody.appendChild(trTotal);

  table.appendChild(tbody);
  contentDiv.appendChild(table);
}

function updateModalError(msg) {
  const contentDiv = document.querySelector('.omnitime-modal-content');
  if (contentDiv) {
    contentDiv.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'padding: 20px; text-align: center; color: #d9534f;';
    errDiv.textContent = msg;
    contentDiv.appendChild(errDiv);
  }
}

init();
