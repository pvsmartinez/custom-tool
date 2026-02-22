#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-mac.sh   –   Build custom-tool as a native macOS .app bundle
# Usage:
#   ./scripts/build-mac.sh           # build only
#   ./scripts/build-mac.sh --install # build + copy to /Applications
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/app"

# ── Ensure Rust toolchain is on PATH ────────────────────────────────────────
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v rustc &>/dev/null; then
  echo "Error: rustc not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

# ── Move into the app directory ──────────────────────────────────────────────
cd "$APP_DIR"

echo ""
echo "╔════════════════════════════════════╗"
echo "║   custom-tool  — macOS app build   ║"
echo "╚════════════════════════════════════╝"
echo ""
echo "▸ Installing npm dependencies…"
npm install --legacy-peer-deps

echo ""
echo "▸ Running Tauri production build…"
npm run tauri build

# ── Locate the built bundle ──────────────────────────────────────────────────
BUNDLE_DIR="$APP_DIR/src-tauri/target/release/bundle/macos"
APP_PATH=""

# Try exact match first, then glob
if [[ -d "$BUNDLE_DIR/custom-tool.app" ]]; then
  APP_PATH="$BUNDLE_DIR/custom-tool.app"
else
  # Tauri sometimes uses the app name from tauri.conf.json
  APP_PATH="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)"
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo ""
  echo "⚠  Build completed but .app bundle was not found in:"
  echo "   $BUNDLE_DIR"
  echo ""
  echo "Check src-tauri/target/release/bundle/ manually."
  exit 1
fi

echo ""
echo "✓  Build successful!"
echo "   Bundle: $APP_PATH"

# ── Optionally install into /Applications ───────────────────────────────────
if [[ "${1:-}" == "--install" ]]; then
  echo ""
  echo "▸ Copying to /Applications (may require your password)…"
  sudo cp -R "$APP_PATH" /Applications/
  echo "✓  Installed to /Applications/$(basename "$APP_PATH")"
  echo ""
  echo "   Launch it:  open /Applications/$(basename "$APP_PATH")"
else
  echo ""
  echo "   To install:   ./scripts/build-mac.sh --install"
  echo "   To run now:   open \"$APP_PATH\""
fi
