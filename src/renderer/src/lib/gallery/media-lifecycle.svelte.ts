import { SvelteSet } from "svelte/reactivity";

import type { PoolTile } from "./tile-pool";

/** Animation eligibility state and its timers/listeners, independent of layout and pooling. */
export class GalleryMediaLifecycle {
  hoveredId = $state<string | null>(null);
  scrollIdle = $state(true);
  reducedMotion = $state(false);
  readonly failedOriginalIds = new SvelteSet<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  start(): () => void {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => {
      this.reducedMotion = query.matches;
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      if (this.idleTimer) clearTimeout(this.idleTimer);
    };
  }

  onScroll(): void {
    this.scrollIdle = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.scrollIdle = true;
    }, 220);
  }

  onOriginalError(tile: PoolTile): void {
    console.warn("[nicegal:media-promotion] original media failed to load, staying static", {
      assetId: tile.itemId,
      mediaKind: tile.mediaKind,
    });
    this.failedOriginalIds.add(tile.itemId);
  }
}
