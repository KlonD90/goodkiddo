#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '[dev] %s\n' "$1"
}

cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_cmd bun

if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source ".env"
  set +a
fi

if [[ ! -d node_modules ]]; then
  log "Installing Bun dependencies"
  bun install
fi

log "Building landing"
bun run landing:build

log "Building web"
bun run web:build

log "Starting bot"
exec bun run start
