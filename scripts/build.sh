#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh  —  Build Cafezin para iOS, macOS ou ambos
# ─────────────────────────────────────────────────────────────────────────────
#
# Por padrão gera os dois. Use flags para escolher:
#
#   ./scripts/build.sh                  # release iOS + macOS
#   ./scripts/build.sh --ios            # release iOS apenas
#   ./scripts/build.sh --mac            # release macOS apenas
#   ./scripts/build.sh --dev            # dev/debug iOS + macOS
#   ./scripts/build.sh --dev --ios      # debug iOS apenas (abre Xcode)
#   ./scripts/build.sh --dev --mac      # dev macOS (incremental + instala + abre)
#   ./scripts/build.sh --mac --install  # release macOS + instala em ~/Applications
#
# Saída (release):
#   iOS  → caminho do IPA gravado em /tmp/.cafezin_ipa
#   macOS → caminho do .app gravado em /tmp/.cafezin_app
#
# Variáveis de ambiente (.env.local):
#   APPLE_DEVELOPMENT_TEAM  10-char Team ID (obrigatório para iOS)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
APP_DIR="$ROOT/app"
APPLE_DIR="$APP_DIR/src-tauri/gen/apple"
EXPORT_OPTS="$APP_DIR/src-tauri/ios/ExportOptions-AppStore.plist"

# ── Parse flags ───────────────────────────────────────────────────────────────
MODE="release"
BUILD_IOS=true
BUILD_MAC=true
MAC_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --dev)     MODE="dev"     ;;
    --release) MODE="release" ;;
    --ios)     BUILD_IOS=true;  BUILD_MAC=false ;;
    --mac)     BUILD_MAC=true;  BUILD_IOS=false ;;
    --install) MAC_INSTALL=true ;;
  esac
done

# ── Load secrets ──────────────────────────────────────────────────────────────
if [[ -f "$ROOT/.env.local" ]]; then
  set -a; source "$ROOT/.env.local"; set +a
fi

# ── Rust toolchain ────────────────────────────────────────────────────────────
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
if ! command -v rustc &>/dev/null; then
  echo "  ERROR: rustc não encontrado. Instale em https://rustup.rs" >&2; exit 1
fi

# ── Ler versão ────────────────────────────────────────────────────────────────
MARKETING_VER="$(python3 -c "import json; print(json.load(open('$APP_DIR/src-tauri/tauri.conf.json'))['version'])")"

# ── Header ────────────────────────────────────────────────────────────────────
PLATFORMS=""
[[ "$BUILD_IOS" == "true" && "$BUILD_MAC" == "true" ]] && PLATFORMS="iOS + macOS"
[[ "$BUILD_IOS" == "true" && "$BUILD_MAC" == "false" ]] && PLATFORMS="iOS"
[[ "$BUILD_IOS" == "false" && "$BUILD_MAC" == "true" ]] && PLATFORMS="macOS"

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
printf  "║  cafezin v%-47s║\n" "${MARKETING_VER}  —  ${MODE}  [${PLATFORMS}]"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# ── npm install (compartilhado) ───────────────────────────────────────────────
cd "$APP_DIR"
echo "▸ npm install…"
npm install --legacy-peer-deps --silent
echo "✓ Dependências OK"
echo ""

# =============================================================================
# iOS
# =============================================================================
build_ios_dev() {
  if [[ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]]; then
    echo "  ERROR: APPLE_DEVELOPMENT_TEAM não definido no .env.local" >&2; return 1
  fi
  export APPLE_DEVELOPMENT_TEAM VITE_TAURI_MOBILE=true

  if [[ ! -d "$APPLE_DIR" ]]; then
    echo "▸ [iOS] tauri ios init…"
    VITE_TAURI_MOBILE=true npx tauri ios init
  fi

  echo "▸ [iOS] build debug…"
  VITE_TAURI_MOBILE=true npx tauri ios build

  XCWORKSPACE=$(find "$APPLE_DIR" -maxdepth 2 -name "*.xcworkspace" 2>/dev/null | head -1 || true)
  XCODEPROJ=$(find "$APPLE_DIR" -maxdepth 2 -name "*.xcodeproj" 2>/dev/null | head -1 || true)

  if [[ -n "$XCWORKSPACE" ]]; then
    echo "▸ [iOS] Abrindo Xcode: $(basename "$XCWORKSPACE")"
    open "$XCWORKSPACE"
  elif [[ -n "$XCODEPROJ" ]]; then
    echo "▸ [iOS] Abrindo Xcode: $(basename "$XCODEPROJ")"
    open "$XCODEPROJ"
  fi
  echo "✓ [iOS] Build debug concluído — use ⌘R no Xcode para rodar"
}

build_ios_release() {
  if [[ -z "${APPLE_DEVELOPMENT_TEAM:-}" ]]; then
    echo "  ERROR: APPLE_DEVELOPMENT_TEAM não definido no .env.local" >&2; return 1
  fi
  export APPLE_DEVELOPMENT_TEAM VITE_TAURI_MOBILE=true

  BUILD_NUM="$(date '+%y%m%d%H%M')"

  if [[ ! -d "$APPLE_DIR" ]]; then
    echo "▸ [iOS] tauri ios init…"
    VITE_TAURI_MOBILE=true npx tauri ios init
  fi

  /usr/libexec/PlistBuddy -c "Set :teamID $APPLE_DEVELOPMENT_TEAM" "$EXPORT_OPTS" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_DEVELOPMENT_TEAM" "$EXPORT_OPTS"
  cp "$EXPORT_OPTS" "$APPLE_DIR/ExportOptions.plist"

  INFO_PLIST="$APPLE_DIR/app_iOS/Info.plist"
  if [[ -f "$INFO_PLIST" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUM" "$INFO_PLIST" 2>/dev/null || \
      /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $BUILD_NUM" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VER" "$INFO_PLIST" 2>/dev/null || true
  fi

  echo "▸ [iOS] build release (build: $BUILD_NUM)…"
  VITE_TAURI_MOBILE=true npx tauri ios build --release

  IPA_PATH=""
  for candidate in \
    "$APPLE_DIR/build/arm64/release/app.ipa" \
    "$APPLE_DIR/build/aarch64/release/app.ipa" \
    "$APP_DIR/target/release/bundle/ios/app.ipa"; do
    [[ -f "$candidate" ]] && IPA_PATH="$candidate" && break
  done
  if [[ -z "$IPA_PATH" ]]; then
    IPA_PATH="$(find "$ROOT" -name "*.ipa" -newer "$EXPORT_OPTS" \
                -not -path "*/node_modules/*" 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$IPA_PATH" ]]; then
    echo "  ERROR: [iOS] .ipa não encontrado após o build." >&2; return 1
  fi

  echo "$IPA_PATH" > /tmp/.cafezin_ipa
  echo "✓ [iOS] IPA: $IPA_PATH  ($(du -sh "$IPA_PATH" | cut -f1))"
}

# =============================================================================
# macOS
# =============================================================================
_find_mac_app() {
  local BUNDLE_DIR="$APP_DIR/src-tauri/target/release/bundle/macos"
  local APP_PATH=""
  [[ -d "$BUNDLE_DIR/Cafezin.app" ]] && APP_PATH="$BUNDLE_DIR/Cafezin.app"
  [[ -z "$APP_PATH" ]] && APP_PATH="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.app' 2>/dev/null | head -1 || true)"
  echo "$APP_PATH"
}

build_mac_dev() {
  local APP_NAME="Cafezin"

  if pgrep -x "$APP_NAME" &>/dev/null; then
    echo "▸ [macOS] Encerrando $APP_NAME…"
    osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || \
      pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 1
  fi

  echo "▸ [macOS] build incremental…"
  npm run tauri build -- --bundles app

  local APP_PATH
  APP_PATH="$(_find_mac_app)"
  if [[ -z "$APP_PATH" ]]; then
    echo "  ERROR: [macOS] .app não encontrado após o build." >&2; return 1
  fi

  echo "$APP_PATH" > /tmp/.cafezin_app
  local DEST="$HOME/Applications/$(basename "$APP_PATH")"
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP_PATH" "$DEST"
  echo "✓ [macOS] Instalado em $DEST"
  open "$DEST"
}

build_mac_release() {
  echo "▸ [macOS] build release…"
  npm run tauri build -- --bundles app

  local APP_PATH
  APP_PATH="$(_find_mac_app)"
  if [[ -z "$APP_PATH" ]]; then
    echo "  ERROR: [macOS] .app não encontrado após o build." >&2; return 1
  fi

  echo "$APP_PATH" > /tmp/.cafezin_app
  echo "✓ [macOS] .app: $APP_PATH  ($(du -sh "$APP_PATH" | cut -f1))"

  if [[ "$MAC_INSTALL" == "true" ]]; then
    local DEST="$HOME/Applications/$(basename "$APP_PATH")"
    rm -rf "$DEST"
    cp -R "$APP_PATH" "$DEST"
    echo "✓ [macOS] Instalado em $DEST"
    open "$DEST"
  fi
}

# =============================================================================
# Executar
# =============================================================================
if [[ "$MODE" == "dev" ]]; then
  [[ "$BUILD_IOS" == "true" ]] && build_ios_dev
  [[ "$BUILD_MAC" == "true" ]] && build_mac_dev
else
  [[ "$BUILD_IOS" == "true" ]] && build_ios_release
  [[ "$BUILD_MAC" == "true" ]] && build_mac_release
fi

# =============================================================================
# Resumo
# =============================================================================
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ Build concluído — v${MARKETING_VER} (${MODE})"
if [[ "$MODE" == "release" ]]; then
  [[ "$BUILD_IOS" == "true" && -f /tmp/.cafezin_ipa ]] && \
    echo "  iOS  IPA:  $(cat /tmp/.cafezin_ipa)"
  [[ "$BUILD_MAC" == "true" && -f /tmp/.cafezin_app ]] && \
    echo "  macOS .app: $(cat /tmp/.cafezin_app)"
  echo ""
  echo "  Próximo passo (deploy iOS):"
  echo "    ./scripts/deploy.sh --skip-build"
fi
echo "═══════════════════════════════════════════════════════"
