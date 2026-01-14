if (typeof window.GitlabAdapter === 'undefined') {
    class GitlabAdapter {
        constructor() {
            this.name = 'gitlab';
        }

        scanForTarget() {
            // 1. Precise Selectors: Try to find the exact time tracking component via test IDs
            const specificSelectors = [
                '[data-testid="work-item-time-tracking"]',
                '[data-testid="time-tracking-component"]',
                '[data-testid="time-tracking-item"]',
                '.time-tracking-component',
                '.block.time-tracking'
            ];

            for (const sel of specificSelectors) {
                const target = document.querySelector(sel);
                if (target) return target;
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
            // Note: textDecoration underline removed per user request
            trigger.title = 'Click to view OmniTime report';

            return trigger;
        }

        getMetadata() {
            // Extract Project ID and Issue ID (IID)
            // GitLab usually puts project ID in body dataset
            const projectId = document.body.dataset.projectId;

            // Issue IID is usually in URL: /namespace/project/issues/123
            const issueIid = window.location.pathname.split('/issues/')[1]?.split('/')[0];

            if (!projectId || !issueIid) {
                throw new Error('Could not extract GitLab Project ID or Issue ID.');
            }

            return {
                project_id: projectId,
                issue_id: issueIid
            };
        }
    }

    // Export to global scope
    window.GitlabAdapter = GitlabAdapter;
}
