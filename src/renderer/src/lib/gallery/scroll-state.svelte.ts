import { emptyLayout, type GalleryLayout } from "./types";

/**
 * Scroll position and computed layout, mirrored up from `VirtualGallery`'s `onScroll` callback,
 * plus the viewport's rendered height from `App`'s `ResizeObserver`.
 *
 * `TimelineScrollbar` is a sibling of `VirtualGallery`, not a child, so this is how it learns
 * what the gallery is currently showing (for its thumb size/position and seek target) without
 * `App` holding three loose, easy-to-miss-the-connection-between `$state` fields itself.
 */
export class GalleryScrollState {
  scrollTop = $state(0);
  layout = $state.raw<GalleryLayout>(emptyLayout());
  /** Rendered height of the row `VirtualGallery` shares with `TimelineScrollbar`. */
  height = $state(0);
  /** A gallery mounts at zero before `App` can restore its saved offset. Do not persist callbacks
   * from that transition over the saved view state. */
  private restoring = false;

  /**
   * Starts a root change. `App` calls `scrollTo` after the new gallery has rendered; until then,
   * the gallery's initial zero-position notification must not erase the saved position.
   */
  prepareRestore(scrollTop: number): void {
    this.scrollTop = Math.max(0, scrollTop);
    this.restoring = true;
  }

  /** Enables persistence again after `App` has imperatively restored the gallery. */
  finishRestore(): void {
    this.restoring = false;
  }

  onScroll(state: { scrollTop: number; layout: GalleryLayout }): void {
    this.layout = state.layout;
    if (this.restoring && state.scrollTop === 0) return;
    this.scrollTop = state.scrollTop;
  }
}
