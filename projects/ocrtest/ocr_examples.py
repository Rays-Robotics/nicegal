"""Run RapidOCR over every image below a directory.

Usage:
    uv venv
    uv pip install --python .venv/Scripts/python.exe rapidocr onnxruntime
    .venv/Scripts/python.exe ocr_examples.py

The script writes one JSON record per image to ``ocr-output/results.jsonl`` and
one annotated image per input to ``ocr-output/visualizations``.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from rapidocr import RapidOCR
from tqdm import tqdm


IMAGE_EXTENSIONS = {
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}


def image_paths(source: Path) -> list[Path]:
    """Return supported images in deterministic recursive order."""
    return sorted(
        (
            path
            for path in source.rglob("*")
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ),
        key=lambda path: path.as_posix().lower(),
    )


def load_image(path: Path) -> str | np.ndarray:
    """Use RapidOCR's path loader, with a PIL fallback for animated GIFs."""
    if path.suffix.lower() != ".gif":
        return str(path)

    with Image.open(path) as image:
        image.seek(0)
        return np.asarray(image.convert("RGB"))


def as_list(value: Any) -> list[Any]:
    """Convert numpy-backed RapidOCR values into JSON-compatible lists."""
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def ocr_record(
    source: Path,
    path: Path,
    result: Any,
    visualizations: Path,
) -> dict[str, Any]:
    relative_path = path.relative_to(source)
    visualization_path = visualizations / relative_path.with_suffix(
        relative_path.suffix + ".jpg"
    )
    visualization_path.parent.mkdir(parents=True, exist_ok=True)
    result.vis(str(visualization_path))

    return {
        "image": relative_path.as_posix(),
        "text": as_list(result.txts),
        "scores": [float(score) for score in as_list(result.scores)],
        "boxes": as_list(result.boxes),
        "elapsed_seconds": float(result.elapse or 0),
        "visualization": visualization_path.relative_to(
            visualizations.parent
        ).as_posix(),
    }


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Run RapidOCR over all images below a directory."
    )
    parser.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=project_root.parent / "testdata",
        help="directory containing input images (default: ../testdata)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=project_root / "ocr-output",
        help="directory for results.jsonl and visualizations/",
    )
    parser.add_argument(
        "--no-vis",
        action="store_true",
        help="skip writing annotated visualization images",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    results_path = output / "results.jsonl"
    visualizations = output / "visualizations"

    if not source.is_dir():
        raise SystemExit(f"Input directory does not exist: {source}")

    paths = image_paths(source)
    if not paths:
        raise SystemExit(f"No supported images found below: {source}")

    output.mkdir(parents=True, exist_ok=True)
    engine = RapidOCR(
        params={
            "Det.limit_type": "max",
            "Det.limit_side_len": 736,
            "EngineConfig.onnxruntime.intra_op_num_threads": 4,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    succeeded = 0
    failed = 0
    started = time.perf_counter()

    with results_path.open("w", encoding="utf-8") as results_file:
        progress = tqdm(paths, desc="OCR", unit="image", dynamic_ncols=True)
        for path in progress:
            try:
                result = engine(load_image(path))
                record = ocr_record(
                    source,
                    path,
                    result,
                    visualizations,
                ) if not args.no_vis else {
                    "image": path.relative_to(source).as_posix(),
                    "text": as_list(result.txts),
                    "scores": [
                        float(score) for score in as_list(result.scores)
                    ],
                    "boxes": as_list(result.boxes),
                    "elapsed_seconds": float(result.elapse or 0),
                }
                results_file.write(json.dumps(record, ensure_ascii=False) + "\n")
                results_file.flush()
                succeeded += 1
            except Exception as error:  # keep processing the remaining images
                results_file.write(
                    json.dumps(
                        {
                            "image": path.relative_to(source).as_posix(),
                            "error": f"{type(error).__name__}: {error}",
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                results_file.flush()
                failed += 1
                tqdm.write(f"Failed: {path}: {error}")

    elapsed = time.perf_counter() - started
    rate = len(paths) / elapsed if elapsed else 0
    print(
        f"Processed {len(paths)} images: {succeeded} succeeded, "
        f"{failed} failed in {elapsed:.1f}s ({rate:.2f} images/s)."
    )
    print(f"Results: {results_path}")
    if not args.no_vis:
        print(f"Visualizations: {visualizations}")


if __name__ == "__main__":
    main()
