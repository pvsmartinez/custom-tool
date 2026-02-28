#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh  —  Build (release) + upload Cafezin para TestFlight
# ─────────────────────────────────────────────────────────────────────────────
#
# Orquestra:
#   1. Build release IPA (via build.sh --release)
#   2. Upload para TestFlight (via pedrin/fastlane cafezin_deploy)
#
# Usage:
#   ./scripts/deploy.sh                  # build + upload
#   ./scripts/deploy.sh --skip-build     # usa IPA_PATH já definido, só faz upload
#
# Configuração (opcional, em .env.local):
#   DEPLOY_CHANGELOG="O que há de novo nesta versão"
#   PERSONAL_ADMIN_DIR=/caminho/absoluto/para/pedrin
#     (padrão: ../../pedrin relativo a este script)
#
# Exemplo customizando changelog:
#   DEPLOY_CHANGELOG="Nova funcionalidade X, correção de Y" ./scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
IPA_TMP_FILE="/tmp/.cafezin_ipa"

# ── Parse args ────────────────────────────────────────────────────────────────
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
  esac
done

# ── Load secrets ──────────────────────────────────────────────────────────────
if [[ -f "$ROOT/.env.local" ]]; then
  set -a; source "$ROOT/.env.local"; set +a
fi

# ── Resolver caminho do pedrin ───────────────────────────────────────
PERSONAL_ADMIN="${PERSONAL_ADMIN_DIR:-$(cd "$SCRIPT_DIR/../../pedrin" 2>/dev/null && pwd || echo "")}"

if [[ -z "$PERSONAL_ADMIN" || ! -d "$PERSONAL_ADMIN" ]]; then
  echo ""
  echo "  ERROR: pedrin não encontrado."
  echo "  Defina PERSONAL_ADMIN_DIR em .env.local:"
  echo "    PERSONAL_ADMIN_DIR=/caminho/para/pedrin"
  echo ""
  exit 1
fi

# ── Step 1: Build ─────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo ""
  echo "──────────────────────────────────────────────────────"
  echo "  [1/2] Build release IPA"
  echo "──────────────────────────────────────────────────────"
  echo ""

  # Executa build.sh — saída vai direto para o terminal
  bash "$SCRIPT_DIR/build.sh" --release

  # Lê o caminho do IPA escrito pelo build.sh
  if [[ ! -f "$IPA_TMP_FILE" ]]; then
    echo ""
    echo "  ERROR: build.sh não gravou o caminho do IPA em $IPA_TMP_FILE"
    echo "  Verifique os erros do build acima."
    echo ""
    exit 1
  fi

  IPA_PATH="$(cat "$IPA_TMP_FILE")"
else
  # Modo --skip-build: usa IPA_PATH da env ou do arquivo temporário
  if [[ -n "${IPA_PATH:-}" ]]; then
    : # já definido
  elif [[ -f "$IPA_TMP_FILE" ]]; then
    IPA_PATH="$(cat "$IPA_TMP_FILE")"
    echo "✓ Usando IPA do último build: $IPA_PATH"
  else
    echo ""
    echo "  ERROR: --skip-build usado mas IPA_PATH não está definido."
    echo "  Opções:"
    echo "    export IPA_PATH=/caminho/do/app.ipa && ./scripts/deploy.sh --skip-build"
    echo "    ./scripts/deploy.sh              # build + upload"
    echo ""
    exit 1
  fi
fi

if [[ ! -f "$IPA_PATH" ]]; then
  echo ""
  echo "  ERROR: IPA não encontrado: $IPA_PATH"
  echo ""
  exit 1
fi

# ── Step 2: Upload para TestFlight via Fastlane ───────────────────────────────
echo ""
echo "──────────────────────────────────────────────────────"
echo "  [2/2] Upload para TestFlight"
echo "  IPA: $IPA_PATH"
echo "──────────────────────────────────────────────────────"
echo ""

cd "$PERSONAL_ADMIN"

# DEPLOY_CHANGELOG pode ser definido em .env.local ou na chamada do script
CHANGELOG_ARGS=""
if [[ -n "${DEPLOY_CHANGELOG:-}" ]]; then
  CHANGELOG_ARGS="changelog:$DEPLOY_CHANGELOG"
fi

bundle exec fastlane cafezin_deploy ipa:"$IPA_PATH" $CHANGELOG_ARGS

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ Deploy concluído!"
echo ""
echo "  Próximos passos:"
echo "    • Aguarde o processamento no TestFlight (5–15 min)"
echo "    • Quando pronto para App Store:"
echo "        cd $PERSONAL_ADMIN"
echo "        bundle exec fastlane cafezin_send_review"
echo "═══════════════════════════════════════════════════════"
