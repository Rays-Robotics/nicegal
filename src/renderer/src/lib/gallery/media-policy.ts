import type { PoolTile } from "./tile-pool";

/**
 * Decides which visible tiles get to swap their static thumbnail for the real animated GIF or a
 * lazily-attached muted `<video>` preview. Kept separate from `tile-pool.ts` (which only knows
 * about geometry/DOM-slot recycling) because promotion depends on signals the pool doesn't see:
 * scroll-idle state, hover, and distance from the viewport center. Promotion is disabled while
 * scrolling or when animations are disabled, and candidates are bounded by source size and a
 * concurrency limit.
 */

/** Sources over this size are treated as "large" and never promoted, even if otherwise eligible. */
export const MAX_PROMOTABLE_SOURCE_BYTES = 25 * 1024 * 1024;

/** Hard ceiling on simultaneously-playing tiles, so a dense grid of GIFs can't tank scroll perf. */
export const MAX_CONCURRENT_PROMOTIONS = 6;

export interface PromotionInput {
  /** The pool's current tiles — promotion never reaches outside what's already pooled/visible. */
  tiles: PoolTile[];
  /** True once the scroll position has been still for a short debounce window. */
  scrollIdle: boolean;
  /** Item id under the pointer, if any — always wins a slot when eligible. */
  hoveredId: string | null;
  /** Viewport band, in canvas pixels, used to rank candidates by distance from its center. */
  viewportTop: number;
  viewportHeight: number;
  /** Combines the user's setting and `prefers-reduced-motion`; false disables promotion entirely. */
  animationsEnabled: boolean;
  /** Ids that previously failed to load as originals — permanently excluded this session. */
  failedIds: ReadonlySet<string>;
  maxConcurrent?: number;
}

function isCandidate(tile: PoolTile, failedIds: ReadonlySet<string>): boolean {
  if (failedIds.has(tile.itemId)) return false;
  if (Number(tile.sourceSize) > MAX_PROMOTABLE_SOURCE_BYTES) return false;
  return tile.mediaKind === "video" || tile.animated;
}

/** Recomputes which item ids should be promoted right now. Pure — call it, don't mutate state in it. */
export function selectPromotedIds({
  tiles,
  scrollIdle,
  hoveredId,
  viewportTop,
  viewportHeight,
  animationsEnabled,
  failedIds,
  maxConcurrent = MAX_CONCURRENT_PROMOTIONS,
}: PromotionInput): Set<string> {
  if (!animationsEnabled || !scrollIdle) return new Set();

  const viewportCenter = viewportTop + viewportHeight / 2;
  const candidates = tiles
    .filter((tile) => isCandidate(tile, failedIds))
    .map((tile) => ({
      id: tile.itemId,
      distance: Math.abs(tile.y + tile.height / 2 - viewportCenter),
    }))
    .sort((left, right) => left.distance - right.distance);

  const promoted = new Set<string>();
  if (hoveredId && candidates.some((candidate) => candidate.id === hoveredId)) {
    promoted.add(hoveredId);
  }
  for (const candidate of candidates) {
    if (promoted.size >= maxConcurrent) break;
    promoted.add(candidate.id);
  }
  return promoted;
}
