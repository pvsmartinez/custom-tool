#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# update-app.sh  —  Incrementally rebuild custom-tool and replace the running app
#
# Usage:
#   ./scripts/update-app.sh            # rebuild → replace in /Applications → relaunch
#   ./scripts/update-app.sh --no-launch  # same but don't relaunch after update
#
# Subsequent builds are fast because Rust recompiles only changed modules:
#   • Frontend (React/CSS) only changed  →  ~15–30 seconds
#   • Rust backend changed               →  ~1–2 minutes
#   • First ever build                   →  ~5–8 minutes (one-time)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")/app"
APP_NAME="custom-tool"
INSTALL_PATH="/Applications/${APP_NAME}.app"
BUNDLE_DIR="${APP_DIR}/src-tauri/target/release/bundle/macos"

RELAUNCH=true
for arg in "$@"; do
  [[ "$arg" == "--no-launch" ]] && RELAUNCH=false
done

# ── Rust toolchain ───────────────────────────────────────────────────────────
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

if ! command -v rustc &>/dev/null; then
  echo "Error: rustc not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

echo ""
echo "╔════════════════════════════════════╗"
echo "║   custom-tool  —  update           ║"
echo "╚════════════════════════════════════╝"
echo ""

# ── Quit the running app gracefully (if open) ────────────────────────────────
if pgrep -x "$APP_NAME" &>/dev/null; then
  echo "▸ Quitting running ${APP_NAME}…"
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || \
    pkill -x "$APP_NAME" 2>/dev/null || true
  # Give it a moment to shut down cleanly
  sleep 1
else
  echo "▸ ${APP_NAME} is not running — skipping quit step"
fi

# ── Incremental build ────────────────────────────────────────────────────────
echo ""
echo "▸ Building (incremental)…"
cd "$APP_DIR"
npm run tauri build

# ── Locate the fresh bundle ──────────────────────────────────────────────────
NEW_APP=""
if [[ -d "${BUNDLE_DIR}/${APP_NAME}.app" ]]; then
  NEW_APP="${BUNDLE_DIR}/${APP_NAME}.app"
else
  NEW_APP="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)"
fi

if [[ -z "$NEW_APP" || ! -d "$NEW_APP" ]]; then
  echo "Error: .app bundle not found in ${BUNDLE_DIR}" >&2
  exit 1
fi

# ── Replace installed copy ───────────────────────────────────────────────────
echo ""
echo "▸ Installing to /Applications (may ask for your password)…"
sudo rm -rf "$INSTALL_PATH"
sudo cp -R "$NEW_APP" "$INSTALL_PATH"
echo "✓  Updated: $INSTALL_PATH"

# Print a quick diff summary of what changed vs git
echo ""
CHANGED=$(git -C "$(dirname "$APP_DIR")" diff --name-only HEAD 2>/dev/null | head -10 || true)
if [[ -n "$CHANGED" ]]; then
  echo "   Changed files in this update:"
  echo "$CHANGED" | sed 's/^/     /'
fi

# ── Relaunch ─────────────────────────────────────────────────────────────────
if $RELAUNCH; then
  echo ""
  echo "▸ Launching ${APP_NAME}…"
  open "$INSTALL_PATH"
  echo "✓  Done."
else
  echo ""
  echo "   To launch:  open \"$INSTALL_PATH\""
fi
