import { buildGridLayout } from "./grid-layout";
import { buildJustifiedLayout } from "./justified-layout";
import { buildMasonryLayout } from "./masonry-layout";
import { resolveLayoutOptions, type LayoutOptions } from "./options";
import { emptyLayout, type GalleryItem, type GalleryLayout, type LayoutMode } from "./types";

export const layoutModes: readonly LayoutMode[] = ["justified", "masonry", "grid"];

export const layoutModeLabels: Record<LayoutMode, string> = {
  justified: "Justified",
  masonry: "Masonry",
  grid: "Grid",
};

/**
 * Single entry point for every layout mode. Packing is mode-specific; everything downstream
 * (virtualization, pooling, prefetch, timeline) consumes the shared `GalleryLayout` shape.
 */
export function buildLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: LayoutOptions = {},
): GalleryLayout {
  const resolved = resolveLayoutOptions(options);
  if (!viewportWidth || !items.length) return emptyLayout(resolved.mode);

  switch (resolved.mode) {
    case "masonry":
      return buildMasonryLayout(items, viewportWidth, resolved);
    case "grid":
      return buildGridLayout(items, viewportWidth, resolved);
    default:
      return buildJustifiedLayout(items, viewportWidth, resolved);
  }
}
