// options.js

// Add a new row to the UI
function createInstanceRow(hostUrl = '', systemType = 'gitlab') {
  const container = document.getElementById('instances');
  const div = document.createElement('div');
  div.className = 'instance';
  const inputHost = document.createElement('input');
  inputHost.type = 'text';
  inputHost.className = 'host-url';
  inputHost.placeholder = 'gitlab.company.com';
  inputHost.value = hostUrl;

  const select = document.createElement('select');
  select.className = 'system-type';
  select.style.cssText = 'display:block; width:100%; margin: 5px 0; padding: 5px;';

  const optionGitlab = document.createElement('option');
  optionGitlab.value = 'gitlab';
  optionGitlab.textContent = 'GitLab';
  if (systemType === 'gitlab') optionGitlab.selected = true;
  select.appendChild(optionGitlab);

  const btnRemove = document.createElement('button');
  btnRemove.className = 'remove-instance';
  btnRemove.style.cssText = 'color:red; cursor:pointer;';
  btnRemove.textContent = 'Remove';

  div.appendChild(inputHost);
  div.appendChild(select);
  div.appendChild(btnRemove);

  div.querySelector('.remove-instance').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.sync.get(['apiUrl', 'apiKey', 'instances', 'debug']);

  if (settings.debug) document.getElementById('debugMode').checked = settings.debug;

  // Migration or Loading
  const url = settings.apiUrl || '';
  if (url) document.getElementById('apiUrl').value = url;

  if (settings.apiKey) document.getElementById('apiKey').value = settings.apiKey;

  if (settings.instances && settings.instances.length > 0) {
    settings.instances.forEach(inst => createInstanceRow(inst.hostUrl, inst.systemType));
  } else {
    createInstanceRow(); // Add one empty row by default
  }
});

// Save all settings
document.getElementById('save').addEventListener('click', async () => {
  const instances = [];
  const origins = [];
  const debugMode = document.getElementById('debugMode').checked;

  document.querySelectorAll('.instance').forEach(row => {
    let hostUrl = row.querySelector('.host-url').value.trim();
    const systemType = row.querySelector('.system-type').value;

    if (hostUrl) {
      instances.push({ hostUrl, systemType });
      // Construct origin pattern (http and https)
      // If user typed 'gitlab.com', we want '*://gitlab.com/*'
      if (hostUrl.startsWith('http')) {
        // strip protocol to get clean host for pattern
        try {
          const u = new URL(hostUrl);
          hostUrl = u.host;
        } catch (e) { }
      }
      origins.push(`*://${hostUrl}/*`);
    }
  });

  const apiUrl = document.getElementById('apiUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  // 1. Request Permissions
  if (origins.length > 0) {
    const granted = await new Promise(resolve => {
      chrome.permissions.request({ origins: origins }, (granted) => resolve(granted));
    });

    if (!granted) {
      alert('Permission was NOT granted. The extension will not work on these sites.');
      return;
    }
  }

  // 2. Register Content Scripts
  // We unregister everything first to be clean, then register for the new list
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['omnitime-cs'] }).catch(() => { });

    if (origins.length > 0) {
      await chrome.scripting.registerContentScripts([{
        id: 'omnitime-cs',
        matches: origins,
        js: ['adapters/gitlab.js', 'content.js'],
        css: ['style.css'],
        runAt: 'document_idle'
      }]);
    }
  } catch (err) {
    console.error('Script registration failed:', err);
    alert('Failed to register script: ' + err.message);
    return;
  }

  // 3. Save Settings
  chrome.storage.sync.set({ apiUrl, apiKey, instances, debug: debugMode }, () => {
    alert('Settings saved and permissions granted!');
  });
});


document.getElementById('addInstance').addEventListener('click', () => createInstanceRow());
