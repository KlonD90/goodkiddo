#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${TOP_FEDDER_DEV_IMAGE:-top-fedder-dev:latest}"
MODEL_URL="${TOP_FEDDER_MODEL_URL:-http://localhost:1234}"

log() {
  printf '[dev] %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

cd "$ROOT_DIR"

require_cmd bun
require_cmd docker

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

if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  log "Building development image $IMAGE_NAME"
  docker build -f Dockerfile.dev -t "$IMAGE_NAME" .
fi

if ! curl --silent --fail --max-time 2 "$MODEL_URL" >/dev/null 2>&1; then
  log "Model endpoint $MODEL_URL is not reachable"
  log "bot.ts expects an Anthropic-compatible endpoint at $MODEL_URL"
  exit 1
fi

log "Running tests"
bun test

log "Starting bot"
exec bun src/bin/bot.ts
