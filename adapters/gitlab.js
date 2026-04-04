if (typeof window.GitlabAdapter === 'undefined') {
  class GitlabAdapter {
    constructor() {
      this.name = 'gitlab';
    }

    log(...args) {
      if (typeof this.debugMode !== 'undefined' && this.debugMode) {
        console.log('OmniTime:', ...args);
      }
    }

    scanForTarget() {
      // 1. Precise Selectors: Try to find the exact time tracking component via test IDs
      const specificSelectors = [
        '[data-testid="work-item-time-tracking"]',
        '[data-testid="time-tracking-component"]',
        '[data-testid="time-tracking-item"]',
        '.time-tracking-component',
        '.block.time-tracking',
      ];

      for (const sel of specificSelectors) {
        const target = document.querySelector(sel);
        if (target) {
          return target;
        }
      }

      // 2. Text Search Fallback: Look for "Time tracking" header in sidebars
      // This avoids selecting the whole specific sidebar or random wiki sidebars
      const sidebar = document.querySelector('aside') || document.querySelector('.right-sidebar') || document.querySelector('.issuable-sidebar');

      if (sidebar) {
        // Look for any header or likely container with "Time tracking" text
        const candidates = sidebar.querySelectorAll('h3, .title, .block-title, div, span');
        for (const el of candidates) {
          if (el.innerText && el.innerText.trim().toLowerCase() === 'time tracking') {
            // We found the label. Return its parent container (usually .block) or the element itself if it looks standalone
            return el.closest('.block') || el.parentElement || el;
          }
        }
      }

      return null;
    }

    styleTarget(target) {
      let trigger = target.querySelector('h3');

      // If target itself is a header or small element (from text search), use it as trigger
      if (!trigger) {
        if (target.tagName === 'H3' || (target.innerText && target.innerText.trim().toLowerCase() === 'time tracking')) {
          trigger = target;
        } else {
          // Fallback: use the whole target
          trigger = target;
        }
      }

      trigger.style.cursor = 'pointer';
      trigger.title = 'Click to view OmniTime report';

      return trigger;
    }

    getMetadata() {
      // 1. Prioritize the Drawer (Split View) for Boards/SPA stability
      const drawer = document.querySelector('[data-testid="work-item-drawer"]');

      let issueIid = null;
      let projectId = null;

      if (drawer) {
        // Look for IID and Project within the active drawer scope
        let issueIid = drawer.querySelector('[data-work-item-iid]')?.getAttribute('data-work-item-iid');
        // The data-project is an attribute that will be present on a milestone
        // or a label, so if an issue does not have either then we will not be
        // able to find the project id in a split view.
        let projectId = drawer.querySelector('[data-project]')?.dataset.project;

        this.log('Drawer found:', drawer);
        this.log('Drawer - Project ID:', projectId);
        this.log('Drawer - Issue IID:', issueIid);

        if (issueIid && !projectId) {
          throw new Error('Cannot find project ID in split view since the item does not have neither a label nor milestone. Please try again in the standard view.');
        }

        if (issueIid && projectId) {
          return {
            project_id: projectId,
            issue_id: issueIid,
          };
        }
      }

      // 2. Fallback to Standard View (URL and Body)
      projectId = document.body.dataset.projectId;
      issueIid = window.location.pathname.match(/\/(?:issues|work_items)\/(\d+)/)?.[1];

      this.log('Standard View - Project ID:', projectId);
      this.log('Standard View - Issue IID:', issueIid);

      if (!projectId || !issueIid) {
        throw new Error('Metadata extraction failed.');
      }

      return { project_id: projectId, issue_id: issueIid };
    }
  }

  window.GitlabAdapter = GitlabAdapter;
}
