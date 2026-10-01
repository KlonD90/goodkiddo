#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for GoodKiddo
# Handles Bun runtime setup, then hands off to the setup modules.
# This is the only bash script in the setup flow.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"
}

# --- Bun check ---

check_bun() {
  BUN_OK="false"
  BUN_VERSION="not_found"
  BUN_PATH_FOUND=""

  if command -v bun >/dev/null 2>&1; then
    BUN_VERSION=$(bun --version 2>/dev/null)
    BUN_PATH_FOUND=$(command -v bun)
    BUN_OK="true"
    log "Bun $BUN_VERSION at $BUN_PATH_FOUND (ok=$BUN_OK)"
  else
    log "Bun not found"
  fi
}

# --- bun install ---

install_deps() {
  DEPS_OK="false"

  if [ "$BUN_OK" = "false" ]; then
    log "Skipping bun install — Bun not available"
    return
  fi

  cd "$PROJECT_ROOT"

  log "Running bun install"
  if bun install >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "bun install succeeded"
  else
    log "bun install failed"
    return
  fi
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform
check_bun
install_deps
check_build_tools

# Emit status block
STATUS="success"
if [ "$BUN_OK" = "false" ]; then
  STATUS="bun_missing"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
fi

cat <<EOF
=== GOODKIDDO SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
BUN_VERSION: $BUN_VERSION
BUN_OK: $BUN_OK
BUN_PATH: ${BUN_PATH_FOUND:-not_found}
DEPS_OK: $DEPS_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$BUN_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ]; then
  exit 1
fi
