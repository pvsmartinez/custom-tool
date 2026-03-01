#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-testflight.sh  —  Build a release IPA and upload to TestFlight
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/upload-testflight.sh
#   ./scripts/upload-testflight.sh --skip-upload   # build only, no upload
#
# One-time setup (see README below for full instructions):
#   1. Create an App Store Connect API key:
#      https://appstoreconnect.apple.com/access/integrations/api
#      → Keys tab → "+" → name it, role "Developer" is enough for TestFlight
#      → Copy the Key ID and Issuer ID
#      → Download AuthKey_XXXXXXXXX.p8 (you only get one chance!)
#      → Move it to:  mkdir -p ~/.private_keys && mv AuthKey_*.p8 ~/.private_keys/
#
#   2. Create .env.local in the repo root (never committed):
#      APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX   # 10-char team ID, developer.apple.com
#      APPLE_API_KEY_ID=XXXXXXXXXX         # Key ID from step 1
#      APPLE_API_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#
#   3. Make sure your Mac keychain has a valid "Apple Distribution" certificate.
#      (Xcode → Settings → Accounts → Manage Certificates → "+" → Apple Distribution)
#
# Requirements: Xcode CLI, Tauri CLI (npx tauri), node/npm
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
APP_DIR="$ROOT/app"
APPLE_DIR="$APP_DIR/src-tauri/gen/apple"
EXPORT_OPTS="$APP_DIR/src-tauri/ios/ExportOptions-AppStore.plist"
SKIP_UPLOAD=false

# Parse args
for arg in "$@"; do
  [[ "$arg" == "--skip-upload" ]] && SKIP_UPLOAD=true
done

# ── Load secrets ──────────────────────────────────────────────────────────────
if [[ -f "$ROOT/.env.local" ]]; then
  set -a; source "$ROOT/.env.local"; set +a
  echo "✓ Loaded .env.local"
fi

# ── Validate required vars ────────────────────────────────────────────────────
MISSING=()
[[ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]] && MISSING+=("APPLE_DEVELOPMENT_TEAM")
if [[ "$SKIP_UPLOAD" == "false" ]]; then
  [[ -z "${APPLE_API_KEY_ID:-}" ]]    && MISSING+=("APPLE_API_KEY_ID")
  [[ -z "${APPLE_API_ISSUER_ID:-}" ]] && MISSING+=("APPLE_API_ISSUER_ID")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "  ERROR: Missing required environment variables:"
  for v in "${MISSING[@]}"; do echo "    • $v"; done
  echo ""
  echo "  Add them to .env.local in the repo root."
  echo "  See the header of this script for setup instructions."
  echo ""
  exit 1
fi

# Validate API key file exists (altool looks in ~/.private_keys/)
if [[ "$SKIP_UPLOAD" == "false" ]]; then
  KEY_FILE="$HOME/.private_keys/AuthKey_${APPLE_API_KEY_ID}.p8"
  if [[ ! -f "$KEY_FILE" ]]; then
    echo ""
    echo "  ERROR: API key file not found at:"
    echo "    $KEY_FILE"
    echo ""
    echo "  Download AuthKey_${APPLE_API_KEY_ID}.p8 from App Store Connect and place it there:"
    echo "    mkdir -p ~/.private_keys && mv ~/Downloads/AuthKey_*.p8 ~/.private_keys/"
    echo ""
    exit 1
  fi
fi

export APPLE_DEVELOPMENT_TEAM
export VITE_TAURI_MOBILE=true

# ── Renew Apple Sign In client secret ────────────────────────────────────────
# The Apple JWT expires in ~6 months. We regenerate on every submission so it
# never expires in production. Generating a new token does NOT invalidate the
# previous one — both are valid until their own expiry.
echo "→ Renovando Apple Sign In client secret…"
APPLE_SIWA_PY="$(dirname "$SCRIPT_DIR")/../pedrin/secrets/apple-signin/gen_apple_secret.py"
SUPABASE_PAT="$(grep '^SUPABASE_PAT=' "$(dirname "$SCRIPT_DIR")/../pedrin/.env" | cut -d'=' -f2- | tr -d '[:space:]')"

if [[ -f "$APPLE_SIWA_PY" && -n "$SUPABASE_PAT" ]]; then
  APPLE_JWT="$(python3.11 "$APPLE_SIWA_PY" --token-only 2>/dev/null)"
  if [[ -n "$APPLE_JWT" ]]; then
    PATCH_RESULT="$(curl -s -o /dev/null -w "%{http_code}" -X PATCH \
      "https://api.supabase.com/v1/projects/dxxwlnvemqgpdrnkzrcr/config/auth" \
      -H "Authorization: Bearer $SUPABASE_PAT" \
      -H "Content-Type: application/json" \
      -d "{\"external_apple_secret\": \"$APPLE_JWT\"}")"
    if [[ "$PATCH_RESULT" == "200" ]]; then
      echo "✓ Apple Sign In secret renovado no Supabase"
    else
      echo "  ⚠ Falha ao renovar Apple secret (HTTP $PATCH_RESULT) — continuando mesmo assim"
    fi
  else
    echo "  ⚠ Não foi possível gerar Apple JWT — continuando mesmo assim"
  fi
else
  echo "  ⚠ gen_apple_secret.py ou SUPABASE_PAT não encontrado — pulando renovação"
fi

# ── Patch ExportOptions with real team ID ────────────────────────────────────
# Our source plist lives in app/src-tauri/ios/ (committed).
# Tauri reads from gen/apple/ExportOptions.plist — copy ours there.
/usr/libexec/PlistBuddy -c "Set :teamID $APPLE_DEVELOPMENT_TEAM" "$EXPORT_OPTS" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_DEVELOPMENT_TEAM" "$EXPORT_OPTS"

# Ensure gen/apple/ exists (created by `tauri ios init`)
if [[ ! -d "$APPLE_DIR" ]]; then
  echo "  Gen directory not found. Running tauri ios init first…"
  cd "$APP_DIR" && VITE_TAURI_MOBILE=true npx tauri ios init
fi

cp "$EXPORT_OPTS" "$APPLE_DIR/ExportOptions.plist"
echo "✓ ExportOptions patched (method: app-store-connect)"

# ── Auto-increment build number (sequential, stored in ios/build-number.txt) ──────
BUILD_NUM_FILE="$APP_DIR/src-tauri/ios/build-number.txt"
if [[ -f "$BUILD_NUM_FILE" ]]; then
  BUILD_NUM="$(( $(cat "$BUILD_NUM_FILE" | tr -d '[:space:]') + 1 ))"
else
  BUILD_NUM=1
fi
echo "$BUILD_NUM" > "$BUILD_NUM_FILE"

# Read marketing version from tauri.conf.json
MARKETING_VER="$(python3 -c "import json; print(json.load(open('$APP_DIR/src-tauri/tauri.conf.json'))['version'])")"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  cafezin  →  TestFlight upload"
echo "  Version: $MARKETING_VER  Build: $BUILD_NUM"
echo "  Team:    $APPLE_DEVELOPMENT_TEAM"
if [[ "$SKIP_UPLOAD" == "false" ]]; then
  echo "  Key ID:  $APPLE_API_KEY_ID"
fi
echo "═══════════════════════════════════════════════════════"
echo ""

# NOTE: We do NOT patch gen/apple/app_iOS/Info.plist here because
# `npx tauri ios build` regenerates it from tauri.conf.json, overwriting
# any patches made before the build. The build number is injected into
# the IPA *after* the build in the post-processing section below.

# ── Patch project.yml (sets CFBundleVersion before xcodegen runs) ─────────────
# Tauri does NOT regenerate project.yml on each build (only on `tauri ios init`),
# so patching it here is safe and survives the build.
PROJECT_YML="$APPLE_DIR/project.yml"
if [[ -f "$PROJECT_YML" ]]; then
  # Replace CFBundleVersion value (quoted or unquoted) with the new build number
  sed -i '' "s/CFBundleVersion: .*/CFBundleVersion: \"$BUILD_NUM\"/" "$PROJECT_YML"
  echo "✓ project.yml CFBundleVersion set to $BUILD_NUM"
else
  echo "  ⚠ project.yml not found — run 'npx tauri ios init' first"
fi

# ── Build the release IPA ──────────────────────────────────────────────────
echo ""
echo "▶ Building release IPA…"
cd "$APP_DIR"

# Remove stale debug libapp.a artifacts that cause "Multiple commands produce" error
# when both debug and release versions exist in Externals simultaneously
find "$APPLE_DIR/Externals" -name "libapp.a" -delete 2>/dev/null || true

npx tauri ios build --ci

echo ""
echo "▶ Locating IPA…"

# Tauri v2 puts the exported IPA here (falls back to a broader find)
IPA_PATH=""

# Common Tauri output locations
for candidate in \
  "$APPLE_DIR/build/arm64/release/app.ipa" \
  "$APPLE_DIR/build/aarch64/release/app.ipa" \
  "$APP_DIR/target/release/bundle/ios/app.ipa"; do
  if [[ -f "$candidate" ]]; then
    IPA_PATH="$candidate"
    break
  fi
done

# Broader search as fallback (look in last-modified .ipa within 2 minutes)
if [[ -z "$IPA_PATH" ]]; then
  IPA_PATH="$(find "$ROOT" -name "*.ipa" -newer "$EXPORT_OPTS" -not -path "*/node_modules/*" 2>/dev/null | head -1)"
fi

if [[ -z "$IPA_PATH" ]]; then
  echo ""
  echo "  ERROR: Could not find the exported .ipa file."
  echo "  Check the build output above for the xcodebuild export location."
  echo ""
  exit 1
fi

echo "✓ IPA: $IPA_PATH"
IPA_SIZE="$(du -sh "$IPA_PATH" | cut -f1)"
echo "  Size: $IPA_SIZE"

# ── Strip static libraries from IPA (Apple rejects bundles with .a files) ────
echo ""
echo "▶ Stripping .a files from IPA…"
WORK_DIR="$(mktemp -d)"
cp "$IPA_PATH" "$WORK_DIR/app.ipa"
pushd "$WORK_DIR" > /dev/null
unzip -q app.ipa
A_FILES="$(find . -name "*.a" 2>/dev/null)"
if [[ -n "$A_FILES" ]]; then
  echo "$A_FILES" | while read -r f; do echo "  removing: $f"; done
  find . -name "*.a" -delete
  zip -qr cleaned.ipa Payload/
  IPA_PATH="$WORK_DIR/cleaned.ipa"
  echo "✓ Cleaned IPA"
else
  echo "  (no .a files found)"
fi
popd > /dev/null

if [[ "$SKIP_UPLOAD" == "true" ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Build complete (--skip-upload was set, not uploading)"
  echo "  IPA: $IPA_PATH"
  echo "═══════════════════════════════════════════════════════"
  exit 0
fi

# ── Upload to TestFlight ──────────────────────────────────────────────────────
echo ""
echo "▶ Uploading to App Store Connect (TestFlight)…"

if xcrun altool \
  --upload-app \
  -f "$IPA_PATH" \
  -t ios \
  --apiKey  "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER_ID" \
  --verbose; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ✓ Upload complete!"
  echo "  Version $MARKETING_VER ($BUILD_NUM) is now processing."
  echo "  Check TestFlight status at:"
  echo "  https://appstoreconnect.apple.com/apps"
  echo ""
  echo "  TestFlight usually takes 5–15 minutes before testers"
  echo "  can install. You'll get an email when it's ready."
  echo "═══════════════════════════════════════════════════════"
else
  echo ""
  echo "  ERROR: Upload failed. Check altool output above."
  exit 1
fi
