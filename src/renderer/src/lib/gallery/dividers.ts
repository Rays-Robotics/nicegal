import type { DividerGranularity, GalleryDivider, GalleryItem } from "./types";

import { bucketKey, bucketLabel } from "./dates";

export const DIVIDER_HEIGHT = 34;

/**
 * Tracks which date bucket a packer is currently filling. Every layout mode shares the same
 * rule: a tile band (justified row, grid row, masonry flush) never spans two buckets, and each
 * new bucket opens with a divider.
 */
export interface DividerTracker {
  /** Dividers emitted so far, in document order. */
  readonly dividers: GalleryDivider[];
  readonly enabled: boolean;
  /** Bucket key for an item index, or undefined when dividers are off / index is out of range. */
  keyAt(index: number): string | undefined;
  /** True when `index` belongs to a different bucket than the one being packed. */
  opensBucket(index: number): boolean;
  /** Emits a divider for `index` at `y` and returns the y its first tile band starts at. */
  open(index: number, y: number, gap: number): number;
}

export function createDividerTracker(
  items: GalleryItem[],
  granularity: DividerGranularity,
): DividerTracker {
  const dividers: GalleryDivider[] = [];
  const enabled = granularity !== "none";
  let current: string | undefined;

  function keyAt(index: number): string | undefined {
    if (!enabled || index < 0 || index >= items.length) return undefined;
    return bucketKey(items[index].date, granularity);
  }

  function opensBucket(index: number): boolean {
    if (!enabled || index >= items.length) return false;
    return keyAt(index) !== current;
  }

  function open(index: number, y: number, gap: number): number {
    // Buckets after the first get breathing room above their divider.
    const top = current === undefined ? y : y + gap;
    dividers.push({
      itemIndex: index,
      y: top,
      height: DIVIDER_HEIGHT,
      label: bucketLabel(items[index].date, granularity),
      timestamp: items[index].date,
    });
    current = keyAt(index);
    return top + DIVIDER_HEIGHT;
  }

  return { dividers, enabled, keyAt, opensBucket, open };
}
