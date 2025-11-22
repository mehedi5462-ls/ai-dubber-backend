#!/usr/bin/env bash
set -e

if [ -n "${MODEL_URL:-}" ]; then
  echo "Downloading Whisper model..."
  mkdir -p /opt/app/models
  MODEL_FILE="/opt/app/models/$(basename $MODEL_URL)"
  if [ ! -f "$MODEL_FILE" ]; then
    wget -q --show-progress -O "$MODEL_FILE" "$MODEL_URL"
  fi
fi

exec "$@" 