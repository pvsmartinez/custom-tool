#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ios-device.sh  —  Run cafezin on a connected iPhone for local development
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/ios-device.sh                     # lists devices and lets you pick
#   ./scripts/ios-device.sh "Pedro iPhone (2)"  # run directly on the named device
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
echo "  cafezin  →  iOS device dev build"
echo "  Team: $APPLE_DEVELOPMENT_TEAM"
echo "═══════════════════════════════════════════════════════"
echo ""

cd "$APP_DIR"

# Detect local IP for --host (needed for physical devices)
LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
if [[ -z "$LOCAL_IP" ]]; then
  echo "  WARNING: Could not detect local IP — dev server may not be reachable from the device."
fi

# List available devices so user can copy a name if needed
echo "▶ Connected iOS devices:"
xcrun xctrace list devices 2>/dev/null | grep -E "iPhone|iPad" | grep -v "Simulator" || \
  echo "  (Could not list devices — ensure iPhone is trusted and plugged in)"
echo ""

# Build and run
if [[ -n "${1:-}" ]]; then
  DEVICE_ARG="$1"
  echo "▶ Targeting device: $DEVICE_ARG"
else
  DEVICE_ARG=""
  echo "▶ No device specified — Tauri will prompt if multiple devices found…"
fi

HOST_FLAG=""
if [[ -n "$LOCAL_IP" ]]; then
  echo "▶ Dev server host: $LOCAL_IP"
  HOST_FLAG="--host $LOCAL_IP"
fi

if [[ -n "$DEVICE_ARG" ]]; then
  npx tauri ios dev "$DEVICE_ARG" $HOST_FLAG
else
  npx tauri ios dev $HOST_FLAG
fi
