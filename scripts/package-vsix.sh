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
for f in server.js eagle-parser.js eagle-data.js; do
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

# ---- Generate patched extension.js ----
# Replace the relative server path with the bundled server path.
echo "==> Generating patched extension.js"
sed "s|path\.join(__dirname, '\.\.', '\.\.', 'server\.js')|path.join(__dirname, 'server', 'server.js')|g" \
  "$VSCODE_DIR/extension.js" > "$BUILD_DIR/extension.js"

# ---- Copy server files ----
echo "==> Copying server files"
cp "$REPO_ROOT/server.js"       "$BUILD_DIR/server/"
cp "$REPO_ROOT/eagle-parser.js" "$BUILD_DIR/server/"
cp "$REPO_ROOT/eagle-data.js"   "$BUILD_DIR/server/"
cp "$REPO_ROOT/data/eagle_commands.json"   "$BUILD_DIR/server/data/"
cp "$REPO_ROOT/data/eagle_procedures.json" "$BUILD_DIR/server/data/"

# ---- Generate merged package.json ----
# Combine extension metadata with both client and server dependencies.
echo "==> Generating merged package.json"
node -e "
const ext = require('$VSCODE_DIR/package.json');
const srv = require('$REPO_ROOT/package.json');

// Merge dependencies: client deps + server deps
const merged = Object.assign({}, ext, {
  dependencies: Object.assign({}, ext.dependencies || {}, srv.dependencies || {})
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

# ---- Install production dependencies ----
echo "==> Installing production dependencies"
(cd "$BUILD_DIR" && npm install --production)

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
