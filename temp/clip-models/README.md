# Local CLIP evaluation

## DINOv3 image similarity evaluation

The 2026-09-13 follow-up selects **DINOv3 ViT-B/16 at 224px**. For evaluation it
uses the existing model selector and visual search composer, accepting only image
examples (including signed combinations). A separate search type is release work;
the temporary selector arrangement does not settle that design. File-name, OCR,
and related-text searches remain available; All skips text-to-image search while
DINO is selected.

```powershell
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/dinov3.py
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py --root testdata/catcopy --state temp/clip-models/state/catcopy --models dinov3 --provider directml
```

`dinov3.py` prepares a local copy of the pinned
[ONNX export](https://huggingface.co/onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX)
under `exports/facebook-dinov3-vitb16-pretrain-lvd1689m/`. The original graph's
`Reshape(allowzero=1)` operations fail with the tested DirectML runtime. Preparation
fixes spatial dimensions at 224 and changes reshape zero handling after checking
every reshape target contains no zero dimensions for batches 1–8. CPU output
parity is checked for every batch size in that range. Weights are unchanged, batch
size remains dynamic, and each 768-dimensional CLS vector is L2-normalized.
Preprocessing is RGB, bilinear resize to 224×224, rescale by 1/255, and ImageNet
mean/std normalization. The manifest is written only after validation succeeds.

The [DINOv3 weights](https://huggingface.co/facebook/dinov3-vitb16-pretrain-lvd1689m)
use the [DINOv3 License](https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md),
accepted for this evaluation. The local export includes the license and a modification
notice. The application licenses do not replace these weight terms. Validated ONNX
exports are published in the [`bep256` model repositories](https://huggingface.co/bep256/models);
no weights are committed to the source repositories. Set `NICEGAL_LOCAL_MODELS_DIR` to this folder's
`exports` directory, as `launch-evaluation.cmd` already does.

`nicegal-server/examples/validate_dinov3.rs` checks native CPU/DirectML vectors
against the original ONNX reference fixtures, including batch/single equivalence.

## Pictures performance benchmark

The 2026-09-13 follow-up requests a 2,000-image performance comparison before full
DINO indexing. `benchmark_models.py` drives the existing native `image_index`
benchmark, using three measured runs per model, batch size 8, four runtime threads,
and a full-batch warmup. All seven current model choices use copies of one regular
AppData catalog snapshot and the same asset-ID order. Each measured run starts
with a fresh vector database; existing gallery indexes cannot turn it into a skip
benchmark. Decode failures are retried so one model's failures cannot alter the
next model's sample. DirectML fallback is disabled in the benchmark.

The trace filter supersedes the earlier blanket `trace` setting per the user's
follow-up, including ONNX Runtime and both legacy/current application targets while
silencing the EXIF crate:

```text
warn,ocrlocate=trace,nicegal_core=trace,nicegal_server=trace,image_index=trace,fastembed=trace,ort=trace,nom_exif=off
```

Build with `./dev.cmd bench --bench image_index --no-run` from the
backend directory. Launch `benchmark-pictures.sh` in tmux. Reports appear under
`state/benchmarks/pictures-<timestamp>/` as `results.json`, `results.csv`, and
`results.md`. The reports contain aggregates only: throughput, elapsed time,
failure counts, model loading, warmup, and process working set (not GPU VRAM).
Private JSONL traces and catalog copies remain alongside them for user inspection;
the agent must not read their contents. Tracing overhead is included in timings.

After successful benchmarks, the script indexes at most 2,000 pending DINO images
into the regular AppData database and starts the regular dev app with DINO selected.
It does **not** start unlimited Pictures indexing. The user will decide on the full
pass after reviewing the benchmark. `index_models.py --debug-limit N` limits image
embedding, and `--select-model dinov3` explicitly persists the evaluated selection.

For a small non-private harness check:

```powershell
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/benchmark_models.py --corpus testdata/catcopy --asset-database temp/clip-models/state/catcopy/assets.db --limit 8 --runs 1 --models siglip2 dinov3
```


This temporary project folder replaces the root MobileCLIP starter with
`export_models.py`. MobileCLIP is excluded. Nothing here publishes to Hugging Face.
The venv, weights, generated fixtures, logs and indexes are ignored by Git.

From the repository root, using uv only:

```powershell
uv venv --python cp313 temp/clip-models/.venv
uv pip sync --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/requirements.lock
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/export_models.py --model metaclip-b32
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/export_models.py --model metaclip-b16
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/export_models.py --model siglip2
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/siglip_beta.py --download --inspect
```

The installed uv uses `--python` for the requested CPython selection. Each export
contains FP32 image/text ONNX graphs, tokenizer and preprocessing configs, original
checkpoint revision, SHA256 file hashes, and parity fixtures from `testdata/catcopy`.
Export checks compare batches 1, 2 and 7 against the original framework and require
finite, unit-normalized embeddings within 0.0003 absolute/relative tolerance.
An existing validated manifest skips export; remove/move that model's output
directory explicitly if you want to regenerate it.

The three DeepGHS SigLIP beta checkpoints already have image and text ONNX graphs.
`siglip_beta.py` pins one Hugging Face revision, downloads their five required files
per checkpoint into the normal Hugging Face cache, and checks the graphs and
metadata. The backend uses its existing Hugging Face cache/download path when a
checkpoint is selected; no export or extra application dependency is needed.
`--download` is optional when the backend has network access.

## Indexing and evaluation

`index_models.py` launches the release gallery service for each model in turn,
catalogs the root, and embeds pending images into independent model databases.
It defaults to `%USERPROFILE%/Pictures`, using the regular desktop databases in
`%APPDATA%/nicegal/nicegal-server` and runtime settings in
`%LOCALAPPDATA%/nicegal-server`. This supersedes the initial separate Pictures
evaluation-state plan per the user's 2026-09-13 follow-up, preserving the already
indexed original CLIP model. The 2026-09-13 follow-up retires the original CLIP
baseline and LAION from the selector, while preserving their existing indexes and
legacy model IDs. The script does not read image files itself.
Completed vectors persist if the script is stopped; rerunning skips current
vectors. No OCR reindexing is required for this image-model comparison.

For a non-private trial:

```powershell
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/index_models.py --root testdata/catcopy --state temp/clip-models/state/catcopy --models swinv2-frozen swinv2-unfrozen eva02
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/smoke_search.py
```

For the long Pictures pass, in MSYS2:

```bash
tmux new-session -d -s nicegal-siglip-beta 'bash /c/Users/bepvt/nicegal/temp/clip-models/index-siglip-beta.sh'
tmux attach -t nicegal-siglip-beta
```

Aggregate progress and completion status are saved to
`state/pictures/progress.json`. The `*-private.log` files contain local diagnostic
details and may contain private paths; they are for the user's inspection only.
As requested, the agent checks startup and beginning of indexing, then stops
monitoring the long pass. On successful completion, the same tmux session
automatically starts `launch-evaluation.cmd` with the debug backend.

The app uses the regular databases and local exports. Open your Pictures
library, then use Settings → Search → Image search
model. Each selection preserves all the other model indexes. The three DeepGHS
checkpoints were evaluated; only frozen SwinV2 is offered in the release selector.

Close the app before starting the indexing pass. The corpus trial uses a separate
state directory; the long pass uses the regular app databases.

Model weight licenses and source links are listed in the root README. MetaCLIP2
uses CC-BY-NC-4.0, SigLIP2 and DeepGHS SigLIP beta Apache-2.0, and the retired LAION
checkpoint MIT. The application code licenses do not replace those weight licenses.

## Validation (2026-09-13)

All four exports passed ONNX numerical checks (largest absolute error 0.00000102).
The native fixture helper in `nicegal-server/examples/validate_local_clip.rs`
matched 28 tokenizer cases exactly; the lowest native image-vector cosine versus
the original framework was 0.9999765. Accurate JPEG decoding, interpolation and
crop rounding are applied for the new models.

The release server indexed all 106 `catcopy` images with each model, without
failures. A resumed pass retained 106 vectors and embedded no images again. Live
CDP checks exercised the Settings selector and image search across all four models:
each returned the complete corpus with distinct rankings, and returning to the
first model reproduced its saved results. Frontend build/type checks, Svelte
analysis, ESLint and backend clippy passed (existing Rust warnings remain).

The three DeepGHS beta checkpoints passed ONNX graph checks and CPU ONNX Runtime
reference inference. Native Rust inference matched all five 128-token text cases
and three `catcopy` images per checkpoint; the lowest native image cosine was
0.99999940. The release service then indexed all 106 `catcopy` images per model
through DirectML, with zero failures. Measured image embedding rates were 30.8,
34.8 and 44.3 images/second for frozen SwinV2, unfrozen SwinV2 and EVA02,
respectively; the same 106-image trial with SigLIP2 Base 256 reached 139.4
images/second. These small-corpus rates are useful for comparing this machine,
but do not measure peak GPU memory or predict whole-library elapsed time.
`smoke_search.py` queried all three isolated indexes for `a cat`; each returned
the 106-image corpus with different top-five rankings.
## Fresh DINOv3 export from timm (2026-09-13)

`export_dinov3_timm.py` downloads the ungated safetensors from
[`timm/vit_base_patch16_dinov3.lvd1689m`](https://huggingface.co/timm/vit_base_patch16_dinov3.lvd1689m),
pinned to `c6a5fb7d12bbd3cf3b0079253141c3332aaed7da`. The DINOv3 weight license still applies.
It exports fixed 224px spatial dimensions, dynamic batches, and the final normalized-layer
CLS token (not timm's default average pooling). RoPE periods are rounded through BF16
to match the original implementation, then cached at the fixed spatial size.

```powershell
uv run --no-project --python temp/clip-models/.venv/Scripts/python.exe temp/clip-models/export_dinov3_timm.py
```

The candidate is written to `state/dino-timm-export/exports/`, separately from the
active exports. Point `NICEGAL_LOCAL_MODELS_DIR` there to evaluate it. No application
model selection or existing vectors are changed by the exporter.

CPU outputs matched the three original public fixtures with cosine >= 0.99999991.
ONNX/PyTorch checks passed for batches 1–8. The native DirectML validator matched
the original fixtures with minimum cosine 0.99999601 and passed batch/single parity.
The graph uses opset 17 and ordinary Split instead of sequence operators; the
original runtime position calculations are constant-folded. No post-export Reshape
compatibility patch is applied.

Public `catcopy` benchmark: 106 images, DirectML, batch 8, four threads, three fresh
index passes after full-batch warmup, backend and ORT tracing enabled:

| Export | Median images/s | Median elapsed | Peak process MiB | Failures |
| --- | ---: | ---: | ---: | ---: |
| Existing onnx-community Base + compatibility patch | 27.17 | 3.901 s | 518 | 0 |
| Fresh timm Base | **246.97** | **0.429 s** | 398 | 0 |

The fresh export is approximately **9.1× faster on this small corpus**. This is not
a new Pictures benchmark or a retrieval-quality evaluation. Both exports emitted
the same Rust thread-local-storage shutdown panic with ORT trace logging enabled,
after all measured passes completed. Repeating the timm benchmark with `ort=off`
completed cleanly at 244.89 images/s. The shutdown issue therefore also affects the
old export and is associated with ORT logging; its precise cause remains unresolved.
