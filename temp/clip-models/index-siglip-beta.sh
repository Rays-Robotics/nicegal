#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py \
  --models swinv2-frozen swinv2-unfrozen eva02
echo 'Indexing complete; starting the evaluation app with the regular databases.'
cmd.exe //d //c "$(cygpath -w temp/clip-models/launch-evaluation.cmd)"
