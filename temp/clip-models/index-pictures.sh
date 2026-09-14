#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py
