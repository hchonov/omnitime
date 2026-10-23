---
name: rebuild-omnitime-extension
description: Trigger this skill after making any changes to the codebase to rebuild the Omnitime extension and unpack it for testing in the browser.
---

# Rebuilding and Unpacking the Omnitime Extension

Whenever you modify the extension code, you MUST follow these steps to deploy the changes to the unpacked extension directory:

1. Run the build script from the workspace root to generate the extension packages with dev credentials:
   ```bash
   ./build_extension.sh --dev
   ```

2. Delete the old unpacked extension directory (if it exists):
   ```bash
   rm -rf dist/omnitime
   ```

3. Unpack the newly built Chrome extension zip into the directory:
   ```bash
   unzip dist/omnitime.zip -d dist/omnitime
   ```

Do this automatically after making changes to ensure the local unpacked extension is always up-to-date for testing.
