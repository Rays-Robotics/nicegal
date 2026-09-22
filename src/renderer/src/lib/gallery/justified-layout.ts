import type { ResolvedLayoutOptions } from "./options";
import type { GalleryPosition } from "./types";

import { aspectBounds, clampAspectRatio } from "./clamp";
import { createDividerTracker } from "./dividers";
import { emptyLayout, type GalleryItem, type GalleryLayout, type GalleryLayoutRow } from "./types";

/**
 * Flickr-style justified rows: fill a row with clamped aspect ratios until it overflows the
 * content width, then solve for the height that makes it fit exactly.
 */
export function buildJustifiedLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: ResolvedLayoutOptions,
): GalleryLayout {
  if (!viewportWidth || !items.length) return emptyLayout("justified");

  const { gap, padding, targetRowHeight, maxRowHeight, granularity, clamp } = options;
  const rowWidth = Math.max(1, viewportWidth - padding * 2);
  // Tiles are drawn at a fixed height, so the panorama guard becomes a width cap.
  const bounds = aspectBounds(clamp, { referenceHeight: targetRowHeight });
  const tracker = createDividerTracker(items, granularity);
  const rows: GalleryLayoutRow[] = [];
  const positions: GalleryPosition[] = [];
  let index = 0;
  let y = padding;

  while (index < items.length) {
    const start = index;
    if (tracker.opensBucket(start)) y = tracker.open(start, y, gap);
    const startBucket = tracker.keyAt(start);

    let totalAspectRatio = 0;
    while (index < items.length) {
      if (tracker.enabled && tracker.keyAt(index) !== startBucket) break;
      totalAspectRatio += clampAspectRatio(items[index].aspectRatio, bounds);
      index += 1;
      const gaps = (index - start - 1) * gap;
      if (totalAspectRatio * targetRowHeight + gaps >= rowWidth) break;
    }

    const count = index - start;
    const isLastRowOfGroup =
      index === items.length || (tracker.enabled && tracker.keyAt(index) !== startBucket);
    // Edge rows can have too little content to justify naturally. Cap their height instead
    // of making a lone wide or tall image fill the entire gallery width.
    const naturalHeight = Math.max(
      clamp.minDisplayHeight,
      (rowWidth - (count - 1) * gap) / totalAspectRatio,
    );
    const height = isLastRowOfGroup
      ? Math.min(targetRowHeight, naturalHeight)
      : Math.min(maxRowHeight, naturalHeight);

    let x = padding;
    for (let itemIndex = start; itemIndex < index; itemIndex += 1) {
      const width = clampAspectRatio(items[itemIndex].aspectRatio, bounds) * height;
      positions.push({ index: itemIndex, x, y, width, height });
      x += width + gap;
    }
    rows.push({ start, end: index, y, height });
    y += height + gap;
  }

  return {
    mode: "justified",
    positions,
    rows,
    columns: [],
    dividers: tracker.dividers,
    unitHeight: targetRowHeight + gap,
    height: y - gap + padding,
  };
}
