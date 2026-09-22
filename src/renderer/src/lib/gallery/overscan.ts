/** How many tile bands to keep mounted beyond the viewport, before and after it. */
export interface OverscanWindow {
  before: number;
  after: number;
}

export interface OverscanOptions {
  /** Applied on the scroll event itself, so a fast scroll only pays for what it must paint. */
  immediate: number;
  /** Bands kept behind the scroll direction once the scroll settles. */
  behind: number;
  /** Bands prefetched ahead of the scroll direction once the scroll settles. */
  ahead: number;
}

export interface OverscanController {
  /** Feed every scroll position; returns the window to use for this frame. */
  track(scrollTop: number): OverscanWindow;
  dispose(): void;
}

/**
 * Direction-aware prefetch window, shared by all layout modes (it is measured in tile bands, and
 * each layout reports its own band pitch via `GalleryLayout.unitHeight`).
 *
 * While scrolling, the window collapses to `immediate` so the pool is not churned on frames that
 * will be scrolled past anyway. Two animation frames after the last scroll event — i.e. once a
 * paint has landed — it expands asymmetrically in the direction of travel.
 */
export function createOverscanController(
  options: OverscanOptions,
  onSettle: (window: OverscanWindow) => void,
): OverscanController {
  let direction = 1;
  let lastScrollTop = 0;
  let prefetchFrame: number | undefined;
  let paintFrame: number | undefined;

  function cancel(): void {
    if (prefetchFrame) cancelAnimationFrame(prefetchFrame);
    if (paintFrame) cancelAnimationFrame(paintFrame);
    prefetchFrame = undefined;
    paintFrame = undefined;
  }

  return {
    track(scrollTop: number): OverscanWindow {
      if (scrollTop !== lastScrollTop) direction = scrollTop > lastScrollTop ? 1 : -1;
      lastScrollTop = scrollTop;
      cancel();
      prefetchFrame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(() => {
          onSettle({
            before: direction > 0 ? options.behind : options.ahead,
            after: direction > 0 ? options.ahead : options.behind,
          });
        });
      });
      return { before: options.immediate, after: options.immediate };
    },
    dispose: cancel,
  };
}
