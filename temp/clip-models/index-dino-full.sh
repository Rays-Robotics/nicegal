#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Uses the validated active export and regular AppData databases; no image limit.
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py \
  --models dinov3 --provider directml --select-model dinov3 \
  --report-dir temp/clip-models/state/pictures-dino-full
