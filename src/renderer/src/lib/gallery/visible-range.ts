import type { GalleryLayout, GalleryLayoutColumn, GalleryLayoutRow } from "./types";

export interface IndexRange {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
}

/** First row whose bottom edge is at or below `y`. */
export function firstVisibleRow(rows: GalleryLayoutRow[], y: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].y + rows[middle].height < y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** First position in `values` (ascending) that is >= `target`. */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** First position in `values` (ascending) that is > `target`. */
function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The contiguous item range that covers everything intersecting the band [`top`, `bottom`].
 *
 * Row-packed modes binary-search their row bands. Masonry has no rows, so each column's own
 * ascending Y index is searched and the per-column hits are unioned; items land in near-index
 * order across columns, so the union stays tight.
 */
export function visibleIndexRange(layout: GalleryLayout, top: number, bottom: number): IndexRange {
  if (!layout.positions.length) return { start: 0, end: 0 };
  if (layout.columns.length) return columnRange(layout.columns, top, bottom);
  if (!layout.rows.length) return { start: 0, end: 0 };

  const rows = layout.rows;
  const firstRow = firstVisibleRow(rows, top);
  if (firstRow >= rows.length)
    return { start: rows[rows.length - 1].end, end: rows[rows.length - 1].end };
  const lastRow = Math.min(rows.length - 1, firstVisibleRow(rows, bottom));
  return { start: rows[firstRow].start, end: rows[lastRow].end };
}

function columnRange(columns: GalleryLayoutColumn[], top: number, bottom: number): IndexRange {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;

  for (const column of columns) {
    const first = lowerBound(column.bottoms, top);
    const last = upperBound(column.tops, bottom) - 1;
    if (first > last || first >= column.indices.length || last < 0) continue;
    start = Math.min(start, column.indices[first]);
    end = Math.max(end, column.indices[last]);
  }

  return end < 0 ? { start: 0, end: 0 } : { start, end: end + 1 };
}

/** Index of the first item intersecting `y`; useful for scroll anchors and timeline labels. */
export function firstVisibleIndex(layout: GalleryLayout, y: number): number {
  return visibleIndexRange(layout, y, y).start;
}
