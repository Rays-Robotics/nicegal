import type { LayoutMode } from "./types";

/**
 * Display bounds a layout applies to a tile. These exist to tame the extremes of a real photo
 * library: panoramas that would eat a whole row, and icons/screenshots that would be upscaled
 * into a tower. They apply to *layout geometry only* — `GalleryItem.aspectRatio` keeps the
 * image's true ratio so detail/preview views can render it uncropped.
 */
export interface DisplayClamp {
  /** Narrowest tile a layout may draw, as width / height. */
  minAspectRatio: number;
  /** Widest tile a layout may draw, as width / height. */
  maxAspectRatio: number;
  /** Shortest tile a layout may draw, in pixels. Binds when tile width is fixed (masonry). */
  minDisplayHeight: number;
  /** Widest tile a layout may draw, in pixels. Binds when tile height is fixed (justified). */
  maxDisplayWidth: number;
}

/**
 * Per-mode clamps. Justified rows share a height, so the panorama guard is a width cap;
 * masonry columns share a width, so the guard is a minimum height. Grid crops every cell to a
 * uniform box with `object-fit: cover`, so its ratio bounds are inert and kept only for
 * completeness.
 */
export const modeClamps: Record<LayoutMode, DisplayClamp> = {
  justified: {
    minAspectRatio: 0.5,
    maxAspectRatio: 2.5,
    minDisplayHeight: 64,
    maxDisplayWidth: 460,
  },
  masonry: {
    minAspectRatio: 0.55,
    maxAspectRatio: 2,
    minDisplayHeight: 32,
    maxDisplayWidth: Number.POSITIVE_INFINITY,
  },
  grid: {
    minAspectRatio: 0.5,
    maxAspectRatio: 2.5,
    minDisplayHeight: 48,
    maxDisplayWidth: Number.POSITIVE_INFINITY,
  },
};

export interface AspectBounds {
  min: number;
  max: number;
}

/**
 * Folds the pixel bounds into ratio bounds for whichever dimension the mode holds fixed.
 * Pass `referenceHeight` for a fixed-height mode (justified), `referenceWidth` for a
 * fixed-width one (masonry).
 */
export function aspectBounds(
  clamp: DisplayClamp,
  reference: { referenceHeight?: number; referenceWidth?: number },
): AspectBounds {
  let max = clamp.maxAspectRatio;
  if (reference.referenceHeight) {
    max = Math.min(max, clamp.maxDisplayWidth / reference.referenceHeight);
  }
  if (reference.referenceWidth) {
    max = Math.min(max, reference.referenceWidth / clamp.minDisplayHeight);
  }
  return { min: Math.min(clamp.minAspectRatio, max), max };
}

/** The ratio a layout should pack an item at. Cropping to it is the renderer's job. */
export function clampAspectRatio(aspectRatio: number, bounds: AspectBounds): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return 1;
  return Math.min(bounds.max, Math.max(bounds.min, aspectRatio));
}
