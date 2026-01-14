#!/bin/bash

# Define output directory
DIST_DIR="dist"
BUILD_STAGE="build_stage"

# Get Version from argument (if provided)
VERSION=$1
if [ -n "$VERSION" ]; then
  CHROME_FILE="omnitime_${VERSION}.zip"
  FIREFOX_FILE="omnitime_${VERSION}.xpi"
  # Strip leading 'v' for manifest version (e.g., v1.0.0 -> 1.0.0)
  CLEAN_VERSION="${VERSION#v}"
else
  CHROME_FILE="omnitime.zip"
  FIREFOX_FILE="omnitime.xpi"
  CLEAN_VERSION=""
fi

# Create dist directory if it doesn't exist
mkdir -p "$DIST_DIR"

# Clean previous builds
rm -f "$DIST_DIR"/omnitime*.zip
rm -f "$DIST_DIR"/omnitime*.xpi

# Setup Build Stage (avoid modifying source files in place)
rm -rf "$BUILD_STAGE"
mkdir -p "$BUILD_STAGE"

echo "Setting up build stage..."
# Copy all files to stage, excluding dist, git, etc.
# We use rsync if available, or cp. simple cp -r is easier but excluding is header.
# Let's use cp -r and then remove excluded items
# Use rsync to copy files, excluding build artifacts and version control
echo "Using rsync..."
rsync -av --exclude="$DIST_DIR" --exclude="$BUILD_STAGE" --exclude=".git" --exclude=".github" --exclude="*.DS_Store" . "$BUILD_STAGE/"
# Remove things we don't want in the build
rm -rf "$BUILD_STAGE/$DIST_DIR"
rm -rf "$BUILD_STAGE/.git"
rm -rf "$BUILD_STAGE/.github"
rm -f "$BUILD_STAGE/build_extension.sh"
rm -f "$BUILD_STAGE/.DS_Store"
rm -f "$BUILD_STAGE/icons/icon-original.png"
rm -f "$BUILD_STAGE/icons/icon-original.jpg"

# Update Version in Manifests if provided
if [ -n "$CLEAN_VERSION" ]; then
  echo "Updating manifests to version $CLEAN_VERSION..."
  # Use sed to replace version. Compatible with Mac and Linux.
  # We look for "version": "...",
  
  # Update manifest.json
  sed "s/\"version\": \".*\"/\"version\": \"$CLEAN_VERSION\"/" "$BUILD_STAGE/manifest.json" > "$BUILD_STAGE/manifest.json.tmp" && mv "$BUILD_STAGE/manifest.json.tmp" "$BUILD_STAGE/manifest.json"
  
  # Update manifest_firefox.json
  sed "s/\"version\": \".*\"/\"version\": \"$CLEAN_VERSION\"/" "$BUILD_STAGE/manifest_firefox.json" > "$BUILD_STAGE/manifest_firefox.json.tmp" && mv "$BUILD_STAGE/manifest_firefox.json.tmp" "$BUILD_STAGE/manifest_firefox.json"
fi

echo "Building for Chrome ($CHROME_FILE)..."
(cd "$BUILD_STAGE" && zip -r "../$DIST_DIR/$CHROME_FILE" . -x "*.DS_Store")
echo "Created $DIST_DIR/$CHROME_FILE"

echo "Building for Firefox ($FIREFOX_FILE)..."
# Firefox needs manifest_firefox.json renamed to manifest.json
# We do this in a subdir of stage to not break the chrome build which just finished
mkdir -p "$BUILD_STAGE/firefox_build"
cp -r "$BUILD_STAGE"/* "$BUILD_STAGE/firefox_build/" 2>/dev/null || true # cp returns error if copying into self, ignore
# Clean up the recursion if it happened (cp -r . into subdir) - actually better to just move/rename in place since Chrome is done.

# Let's just modify the stage for Firefox now since Chrome is done
mv "$BUILD_STAGE/manifest_firefox.json" "$BUILD_STAGE/manifest.json"

(cd "$BUILD_STAGE" && zip -r "../$DIST_DIR/$FIREFOX_FILE" . -x "*.DS_Store" -x "firefox_build/*")
echo "Created $DIST_DIR/$FIREFOX_FILE"

# Cleanup
rm -rf "$BUILD_STAGE"
echo "Build complete!"
