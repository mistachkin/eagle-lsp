#!/usr/bin/env bash
#
# package-vsix.sh - Build a self-contained VS Code extension VSIX for Eagle
# Scripting Language.
#
# Usage: bash scripts/package-vsix.sh
# Run from the repository root (the directory containing server.js).
#

set -euo pipefail

# ---- Ensure node and npm are on PATH ----
# Source common profile files if node/npm are not already available.
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.profile"; do
    # shellcheck source=/dev/null
    [ -f "$rc" ] && source "$rc" 2>/dev/null || true
  done
  # Try common Node.js version manager init scripts
  # shellcheck source=/dev/null
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  [ -s "$HOME/.fnm/fnm" ] && eval "$(~/.fnm/fnm env)" 2>/dev/null || true
fi
if ! command -v node &>/dev/null; then
  echo "ERROR: node is not installed or not on PATH." >&2
  echo "       Install Node.js 18+ from https://nodejs.org/" >&2
  exit 1
fi
if ! command -v npm &>/dev/null; then
  echo "ERROR: npm is not installed or not on PATH." >&2
  exit 1
fi
echo "==> Using node $(node --version) and npm $(npm --version)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build"
VSCODE_DIR="$REPO_ROOT/editors/vscode"

echo "==> Repository root: $REPO_ROOT"

# ---- Validate required source files exist ----
for f in server.js eagle-parser.js eagle-data.js eagle-brace.js; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "ERROR: Missing $f in $REPO_ROOT" >&2
    exit 1
  fi
done
for f in data/eagle_commands.json data/eagle_procedures.json; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "ERROR: Missing $f in $REPO_ROOT" >&2
    exit 1
  fi
done
if [ ! -f "$VSCODE_DIR/package.json" ]; then
  echo "ERROR: Missing editors/vscode/package.json" >&2
  exit 1
fi

# ---- Clean and create build directory ----
echo "==> Cleaning build directory"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/server/data"
mkdir -p "$BUILD_DIR/syntaxes"

# ---- Copy extension client files ----
echo "==> Copying extension client files"
cp "$VSCODE_DIR/language-configuration.json" "$BUILD_DIR/"
if [ -f "$VSCODE_DIR/syntaxes/eagle.tmLanguage.json" ]; then
  cp "$VSCODE_DIR/syntaxes/eagle.tmLanguage.json" "$BUILD_DIR/syntaxes/"
fi

# ---- Copy language icon files ----
echo "==> Copying language icon files"
for icon in "$VSCODE_DIR"/eagle-*.png; do
  if [ -f "$icon" ]; then
    cp "$icon" "$BUILD_DIR/"
  fi
done

# ---- Install source dependencies for bundling ----
# These node_modules directories are needed only so esbuild can resolve imports.
# They are cleaned up after bundling (see below) and are NOT included in the VSIX.
echo "==> Installing source dependencies"
REPO_NODE_MODULES_CREATED=false
VSCODE_NODE_MODULES_CREATED=false
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  REPO_NODE_MODULES_CREATED=true
fi
if [ ! -d "$VSCODE_DIR/node_modules" ]; then
  VSCODE_NODE_MODULES_CREATED=true
fi
(cd "$REPO_ROOT" && npm install --ignore-scripts 2>/dev/null)
(cd "$VSCODE_DIR" && npm install --ignore-scripts 2>/dev/null)

# ---- Bundle extension client with esbuild ----
# Patches the server path and bundles vscode-languageclient into a single file.
# The "vscode" module is external (provided by VS Code at runtime).
echo "==> Bundling extension client (esbuild)"
PATCHED_EXT="$VSCODE_DIR/_extension_patched.js"
sed "s|path\.join(__dirname, '\.\.', '\.\.', 'server\.js')|path.join(__dirname, 'server', 'server.js')|g" \
  "$VSCODE_DIR/extension.js" > "$PATCHED_EXT"
npx --yes esbuild "$PATCHED_EXT" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --external:vscode \
  --outfile="$BUILD_DIR/extension.js"
rm -f "$PATCHED_EXT"

# ---- Bundle language server with esbuild ----
# Bundles server.js, eagle-parser.js, and eagle-data.js into a single file.
# The JSON data files are loaded at runtime via fs.readFileSync, so they must
# be copied alongside the bundle (see below).
echo "==> Bundling language server (esbuild)"
npx --yes esbuild "$REPO_ROOT/server.js" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --outfile="$BUILD_DIR/server/server.js"

# ---- Copy runtime data files ----
# eagle-data.js loads these via fs.readFileSync(path.join(__dirname, 'data', ...))
# so they must exist relative to the bundled server.js.
echo "==> Copying runtime data files"
cp "$REPO_ROOT/data/eagle_commands.json"   "$BUILD_DIR/server/data/"
cp "$REPO_ROOT/data/eagle_procedures.json" "$BUILD_DIR/server/data/"

# ---- Clean up build-time node_modules ----
# Only remove node_modules that the script created; leave pre-existing ones alone.
if [ "$REPO_NODE_MODULES_CREATED" = true ] && [ -d "$REPO_ROOT/node_modules" ]; then
  echo "==> Cleaning up $REPO_ROOT/node_modules (created by this script)"
  rm -rf "$REPO_ROOT/node_modules"
fi
if [ "$VSCODE_NODE_MODULES_CREATED" = true ] && [ -d "$VSCODE_DIR/node_modules" ]; then
  echo "==> Cleaning up $VSCODE_DIR/node_modules (created by this script)"
  rm -rf "$VSCODE_DIR/node_modules"
fi

# ---- Generate merged package.json ----
# Extension metadata with no runtime dependencies (everything is bundled).
echo "==> Generating merged package.json"
node -e "
const ext = require('$VSCODE_DIR/package.json');

// Start from extension manifest, but clear dependencies since everything
// is bundled by esbuild.
const merged = Object.assign({}, ext, {
  dependencies: {}
});

// Remove scripts that reference the source tree
delete merged.scripts;

// Remove icon field if the icon file does not exist in the build dir
const fs = require('fs');
const path = require('path');
if (merged.icon) {
  const iconSrc = path.join('$VSCODE_DIR', merged.icon);
  const iconRepo = path.join('$REPO_ROOT', merged.icon);
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join('$BUILD_DIR', merged.icon));
  } else if (fs.existsSync(iconRepo)) {
    fs.copyFileSync(iconRepo, path.join('$BUILD_DIR', merged.icon));
  } else {
    delete merged.icon;
  }
}

process.stdout.write(JSON.stringify(merged, null, 2) + '\n');
" > "$BUILD_DIR/package.json"

# ---- Copy supporting files ----
echo "==> Copying supporting files"
for f in CHANGELOG.md LICENSE README.md; do
  if [ -f "$REPO_ROOT/$f" ]; then
    cp "$REPO_ROOT/$f" "$BUILD_DIR/"
  fi
done
if [ -f "$VSCODE_DIR/.vscodeignore" ]; then
  cp "$VSCODE_DIR/.vscodeignore" "$BUILD_DIR/"
fi

# ---- Package VSIX ----
echo "==> Packaging VSIX"
(cd "$BUILD_DIR" && npx --yes @vscode/vsce package --allow-missing-repository)

# ---- Copy VSIX to repo root ----
VSIX_FILE=$(find "$BUILD_DIR" -maxdepth 1 -name '*.vsix' -print -quit)
if [ -n "$VSIX_FILE" ]; then
  cp "$VSIX_FILE" "$REPO_ROOT/"
  VSIX_NAME=$(basename "$VSIX_FILE")
  echo ""
  echo "==> VSIX created: $VSIX_NAME"
  echo "    Install with: code --install-extension $VSIX_NAME"
else
  echo "ERROR: No .vsix file found in build directory" >&2
  exit 1
fi
