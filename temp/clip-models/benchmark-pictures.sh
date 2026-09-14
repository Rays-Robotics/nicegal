#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
report_dir="temp/clip-models/state/benchmarks/pictures-$(date +%Y%m%d-%H%M%S)"
printf 'Benchmark reports: %s\n' "$report_dir"
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/benchmark_models.py \
  --limit 2000 --runs 3 --provider directml --output "$report_dir"
# Keep the first trial bounded. Whole-library DINO indexing is a later user decision.
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py \
  --models dinov3 --debug-limit 2000 --select-model dinov3 \
  --report-dir "$report_dir/dino-evaluation"
echo 'Benchmark and 2,000-image DINO trial complete; starting the regular gallery app.'
cmd.exe //d //c "$(cygpath -w temp/clip-models/launch-evaluation.cmd)"
