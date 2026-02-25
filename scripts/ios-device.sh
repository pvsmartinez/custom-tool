#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ios-device.sh  —  Run custom-tool on a connected iPhone for local development
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/ios-device.sh              # lists devices and lets you pick
#   ./scripts/ios-device.sh --device ID  # run directly on the device with that ID
#
# Requirements:
#   - iPhone connected via USB and trusted on this Mac
#   - Xcode installed with a valid development signing identity
#   - Apple Developer Team ID in APPLE_DEVELOPMENT_TEAM env var (or .env.local)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
APP_DIR="$ROOT/app"

# Load .env.local if it exists (not committed to git)
if [[ -f "$ROOT/.env.local" ]]; then
  set -a; source "$ROOT/.env.local"; set +a
fi

# ── Require Team ID ──────────────────────────────────────────────────────────
if [[ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]]; then
  echo ""
  echo "  ERROR: APPLE_DEVELOPMENT_TEAM is not set."
  echo ""
  echo "  Add it to .env.local in the repo root:"
  echo "    echo 'APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX' >> .env.local"
  echo ""
  echo "  Find your Team ID at: https://developer.apple.com/account"
  echo "  (Account → Membership Details → Team ID)"
  echo ""
  exit 1
fi

export APPLE_DEVELOPMENT_TEAM
export VITE_TAURI_MOBILE=true

echo "═══════════════════════════════════════════════════════"
echo "  custom-tool  →  iOS device dev build"
echo "  Team: $APPLE_DEVELOPMENT_TEAM"
echo "═══════════════════════════════════════════════════════"
echo ""

cd "$APP_DIR"

# List available devices so user can copy an ID if needed
echo "▶ Connected iOS devices:"
xcrun xctrace list devices 2>/dev/null | grep -E "iPhone|iPad" | grep -v "Simulator" || \
  ios-deploy --detect 2>/dev/null || \
  echo "  (Could not list devices — ensure iPhone is trusted and plugged in)"
echo ""

# Build and run
if [[ "${1:-}" == "--device" && -n "${2:-}" ]]; then
  echo "▶ Targeting device: $2"
  npx tauri ios dev --device "$2"
else
  echo "▶ Launching device picker (Tauri will prompt if multiple devices found)…"
  npx tauri ios dev
fi
