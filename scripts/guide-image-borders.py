"""Audit or trim the two guide screenshots to their existing solid border.

uvx --with pillow python scripts/guide-image-borders.py --audit
uvx --with pillow python scripts/guide-image-borders.py --trim
"""

import argparse
from collections import Counter
from pathlib import Path

from PIL import Image


def colors(image: Image.Image, box: tuple[int, int, int, int]) -> Counter:
    return Counter(image.crop(box).get_flattened_data())


def trim_border(image: Image.Image) -> Image.Image:
    width, height = image.size
    # The solid border is the darkest nearly uniform row within each outer ten pixels.
    def horizontal(rows: range) -> tuple[int, tuple[int, int, int]]:
        candidates = []
        for y in rows:
            color, count = colors(image, (0, y, width, y + 1)).most_common(1)[0]
            if count / width >= 0.9:
                candidates.append((sum(color), y, color))
        assert candidates, "No solid horizontal border found; inspect the capture."
        _, y, color = min(candidates)
        return y, color

    top, border = horizontal(range(10))
    bottom, bottom_border = horizontal(range(height - 10, height))
    assert border == bottom_border, "Top and bottom borders differ; inspect the capture."

    def vertical(columns: range) -> int:
        matches = [x for x in columns if colors(image, (x, 0, x + 1, height))[border] / height >= 0.9]
        assert matches, "No matching vertical border found; inspect the capture."
        return matches[0]

    left = vertical(range(10))
    right = vertical(range(width - 1, width - 11, -1))
    cropped = image.crop((left, top, right + 1, bottom + 1))
    w, h = cropped.size
    for edge in [(0, 0, w, 1), (0, h - 1, w, h), (0, 0, 1, h), (w - 1, 0, w, h)]:
        assert set(colors(cropped, edge)) == {border}, "Crop does not have four complete borders."
    return cropped


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--audit", action="store_true", help="Print colors for the top and bottom ten rows")
parser.add_argument("--trim", action="store_true", help="Crop away pixels outside the existing border")
args = parser.parse_args()
folder = Path(__file__).resolve().parents[1] / "src/renderer/src/assets/guide"
for name in ("search-menu.png", "visual-search.png"):
    path = folder / name
    with Image.open(path) as source:
        image = source.convert("RGB")
    if args.trim:
        cropped = trim_border(image)
        cropped.save(path)
        print(f"{name}: {image.size} -> {cropped.size}; all four borders verified")
        image = cropped
    if args.audit or not args.trim:
        print(f"\n{name}: {image.size}")
        for y in [*range(10), *range(image.height - 10, image.height)]:
            print(f"row {y}: {colors(image, (0, y, image.width, y + 1)).most_common(5)}")
