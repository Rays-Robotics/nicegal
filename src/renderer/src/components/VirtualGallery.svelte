<!--
  @component
  A virtualized, recycled-DOM image grid. Renders only what's near the viewport no matter how
  large `items` is, by keeping a small, fixed pool of `<img>` elements and reassigning what each
  one points at as the user scrolls, instead of mounting one element per item.

  Virtualization model, end to end:
  1. `layout` ($derived from `buildLayout`) packs every item into a `GalleryPosition` (x/y/w/h)
     using the active mode's packer (justified/masonry/grid — see `lib/gallery/layout.ts`), plus
     row or column indices for fast range queries and a total canvas `height`.
  2. On scroll, `visibleIndexRange` binary-searches those rows/columns for the item indices that
     intersect the current scroll band, expanded by `overscan` bands on each side (see the
     overscan controller effect below) so nearby content is ready before it's on-screen.
  3. `recyclePool` maps that index range onto the image element pool (below) and produces the new
     `tiles` array painted by the `{#each}` block.

  The image element pool: `tiles` is a bounded array of `PoolTile`s, each carrying a stable
  `slot` number. The `{#each tiles as tile (tile.slot)}` block is keyed on `slot`, not on the
  item — so when a slot's occupant changes, Svelte reuses the existing DOM node (and its `<img>`)
  rather than destroying and recreating it. `recyclePool` (in `lib/gallery/tile-pool.ts`) is what
  decides which slots keep their current item and which get recycled to a newly-visible one; a
  slot whose item and computed thumbnail `src` haven't changed keeps them untouched, so scrolling
  back to something still in range never re-triggers a decode. This is the performance-critical
  path: an unnecessary `src` change here is an unnecessary image decode.
-->
<script lang="ts">
  import Video from "@lucide/svelte/icons/video";
  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";

  import type { SelectionModifiers } from "../lib/gallery/selection.svelte";
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { createGalleryInput } from "../lib/gallery/input";
  import { buildLayout } from "../lib/gallery/layout";
  import { GalleryMediaLifecycle } from "../lib/gallery/media-lifecycle.svelte";
  import { selectPromotedIds } from "../lib/gallery/media-policy";
  import { layoutDefaults, type LayoutOptions } from "../lib/gallery/options";
  import { createOverscanController, type OverscanWindow } from "../lib/gallery/overscan";
  import { literalSnippetTerms } from "../lib/gallery/snippet-highlight";
  import { createThumbnailScheduler, type ThumbnailMiss } from "../lib/gallery/thumbnail-scheduler";
  import { tileImage } from "../lib/gallery/tile-image";
  import { recyclePool, type PoolTile } from "../lib/gallery/tile-pool";
  import {
    physicalThumbnailSize,
    type GalleryItem,
    type GalleryLayout,
    type GallerySection,
  } from "../lib/gallery/types";
  import { firstVisibleIndex, visibleIndexRange } from "../lib/gallery/visible-range";
  import { parseQuery } from "../lib/search-query";

  /** Give up on a poster that keeps failing to ensure (corrupt/unreadable source) rather than
   * retrying it forever. */
  const MAX_ENSURE_ATTEMPTS = 3;

  let {
    items = [],
    sections = [],
    viewKey = "gallery",
    oninteractionchange = () => {},
    layoutOptions = {},
    imagePoolSize = 300,
    immediateOverscan = 1,
    overscanBehind = 4,
    overscanAhead = 12,
    hideNativeScrollbar = false,
    /**
     * `sync` paints a tile only once its image is decoded — no stale frame from the recycled
     * `<img>`, but the decode lands on the main thread. `async` trades that for a tile that may
     * briefly show the previous occupant. Exposed so the two can be measured against each other.
     */
    imageDecoding = "async",
    /**
     * Images whose largest side is below this are upscaled with nearest-neighbour instead of the
     * browser's smooth filter — at this size the source is usually pixel art or an icon, and
     * bilinear turns it to mush. Measured on the largest side so a narrow strip is not mistaken
     * for a sprite.
     */
    pixelatedBelow = 100,
    /** User setting for animated-preview playback; combined with `prefers-reduced-motion`, which
     * always wins when the OS expresses a preference. Animated media is promoted only for eligible
     * pooled tiles, after scrolling settles, subject to the concurrency and source-size limits. */
    playAnimatedPreviews = true,
    /** Filename/OCR-text snippets for the current search, by item id. A tile with an entry shows an
     * iBooks-style caption strip over its bottom edge so the user can see *why* it matched. */
    snippets,
    /** Raw query text used to highlight matching terms inside the caption. */
    snippetQuery = "",
    /** A changed search starts a new result set, which must begin at the top rather than retain
     * an anchor from the previous query. */
    searchQuery = "",
    onScroll = () => {},
    /** The app-owned, ID-keyed selection stays stable while this component recycles tile DOM. */
    selectedIds = new SvelteSet<string>(),
    /** Fires when a tile is modifier-selected without opening it. */
    onselect = () => {},
    /** ViSelect's live marquee hit set, expressed as stable asset IDs instead of pooled DOM nodes. */
    onmarqueestart = () => {},
    onmarqueechange = () => {},
    onmarqueeend = () => {},
    /** Fires when a tile is opened by a primary click or Enter. */
    onopen = () => {},
    /** Requests file actions for the right-clicked tile. Selection ownership stays with the app. */
    onfilemenu = () => {},
    /** Fires when the user clicks empty gallery background (not a tile); the caller clears the
     * selection so a stray click does not leave stale targets behind. */
    onclear = () => {},
  }: {
    items?: GalleryItem[];
    sections?: readonly GallerySection[];
    viewKey?: string;
    oninteractionchange?: (active: boolean) => void;
    layoutOptions?: LayoutOptions;
    imagePoolSize?: number;
    immediateOverscan?: number;
    overscanBehind?: number;
    overscanAhead?: number;
    hideNativeScrollbar?: boolean;
    imageDecoding?: "sync" | "async" | "auto";
    pixelatedBelow?: number;
    playAnimatedPreviews?: boolean;
    snippets?: ReadonlyMap<string, string>;
    snippetQuery?: string;
    searchQuery?: string;
    onScroll?: (state: { scrollTop: number; layout: GalleryLayout }) => void;
    selectedIds?: ReadonlySet<string>;
    onselect?: (index: number, modifiers: SelectionModifiers) => void;
    onmarqueestart?: (modifiers: SelectionModifiers) => void;
    onmarqueechange?: (ids: readonly string[]) => void;
    onmarqueeend?: () => void;
    onopen?: (index: number) => void;
    onfilemenu?: (index: number) => void;
    onclear?: () => void;
  } = $props();

  const input = createGalleryInput({
    onopen: (index) => onopen(index),
    onselect: (index, modifiers) => onselect(index, modifiers),
    onfilemenu: (index) => onfilemenu(index),
    onclear: () => onclear(),
    onmarqueestart: (modifiers) => onmarqueestart(modifiers),
    onmarqueechange: (ids) => onmarqueechange(ids),
    onmarqueeend: () => onmarqueeend(),
  });

  let viewport: HTMLDivElement;
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let pixelRatio = $state(1);
  let scrollTop = $state(0);
  let overscan = $state<OverscanWindow>({ before: 1, after: 1 });
  /** What sits under the top of the viewport, tracked by item id so it survives a relayout. */
  type ScrollAnchor =
    | { kind: "top" }
    | { kind: "section"; key: string; offset: number }
    | { kind: "item"; id: string; progress: number };
  let anchor = $state<ScrollAnchor>();
  let sectionHeaderHeight = $state(26);
  let sectionGap = $state(6);
  let previousSearchQuery: string | undefined;
  let restoringAnchor = $state(false);
  const layout = $derived(
    buildLayout(items, viewportWidth, layoutOptions, sections, sectionHeaderHeight, sectionGap),
  );
  let previousViewKey: string | undefined;
  const viewOffsets = new SvelteMap<string, { top: number; anchor: typeof anchor }>();
  let tiles = $state<PoolTile[]>([]);

  // Animated GIF/video promotion (see lib/gallery/media-policy.ts): which pooled tiles currently
  // show their real original source instead of a static thumbnail poster.
  const media = new GalleryMediaLifecycle();
  const animationsEnabled = $derived(playAnimatedPreviews && !media.reducedMotion);
  const promotedIds = $derived(
    selectPromotedIds({
      tiles,
      scrollIdle: media.scrollIdle,
      hoveredId: media.hoveredId,
      viewportTop: scrollTop,
      viewportHeight,
      animationsEnabled,
      failedIds: media.failedOriginalIds,
    }),
  );
  /** Snapshot of the last-logged promoted set, purely for the debug-log diff below. */
  let loggedPromotedIds = new Set<string>();

  // On-demand thumbnail generation (generator version 1 no longer builds thumbnails eagerly
  // during indexing — see nicegal-server/INTERNAL_API.md). A poster's normal thumb:// request is tried
  // first, unchanged, so an already-generated library never pays a round trip; only a genuine miss
  // (the asset was never thumbnailed) queues a batched `POST /v1/thumbnails` call, flushed once
  // scrolling settles so a fling-scroll doesn't request thumbnails for tiles already scrolled past.
  /** Per-asset cache-bust counter: bumped once an ensure call succeeds, so that asset's poster
   * `<img>` re-requests thumb:// and picks up the now-generated row. */
  const localRefresh = new SvelteMap<string, number>();
  const thumbnailFailures = new SvelteMap<string, ThumbnailFailure>();
  export function getThumbnailFailures(
    catalogItems: readonly GalleryItem[],
  ): (ThumbnailFailure & { name: string })[] {
    if (!thumbnailFailures.size) return [];
    return catalogItems.flatMap((item) => {
      const failure = thumbnailFailures.get(item.id);
      return failure ? [{ ...failure, name: item.displayName }] : [];
    });
  }

  export function retryThumbnails(ids: readonly string[]): void {
    thumbnailScheduler.retry(ids);
    for (const id of ids) {
      thumbnailFailures.delete(id);
      localRefresh.set(id, (localRefresh.get(id) ?? 0) + 1);
    }
  }

  function onPosterLoad(tile: PoolTile): void {
    thumbnailScheduler.loaded(tile.itemId);
    thumbnailFailures.delete(tile.itemId);
  }
  /** Last user scroll direction. Positive means lower items are ahead; negative means upper items
   * are ahead. This is imperative scheduler input, not template state. */
  let thumbnailDirection = 1;

  function selectThumbnailCandidates(
    pending: ReadonlyMap<string, ThumbnailMiss>,
  ): readonly string[] {
    const visible: Array<{ id: string; distance: number }> = [];
    const ahead: Array<{ id: string; distance: number }> = [];
    const behind: Array<{ id: string; distance: number }> = [];
    const viewportBottom = scrollTop + viewportHeight;

    for (const tile of tiles) {
      if (!pending.has(tile.itemId)) continue;
      const tileBottom = tile.y + tile.height;
      if (tileBottom >= scrollTop && tile.y <= viewportBottom) {
        visible.push({ id: tile.itemId, distance: Math.abs(tile.y - scrollTop) });
      } else {
        const isAhead = thumbnailDirection > 0 ? tile.y > viewportBottom : tileBottom < scrollTop;
        const distance =
          thumbnailDirection > 0
            ? Math.abs(tile.y - viewportBottom)
            : Math.abs(scrollTop - tileBottom);
        (isAhead ? ahead : behind).push({ id: tile.itemId, distance });
      }
    }

    const byDistance = (
      left: { id: string; distance: number },
      right: { id: string; distance: number },
    ): number => left.distance - right.distance;
    visible.sort(byDistance);
    ahead.sort(byDistance);
    behind.sort(byDistance);
    return [...visible, ...ahead, ...behind].map((candidate) => candidate.id);
  }

  const thumbnailScheduler = createThumbnailScheduler({
    concurrency: 4,
    batchSize: 2,
    maxAttempts: MAX_ENSURE_ATTEMPTS,
    selectCandidates: selectThumbnailCandidates,
    requiredSize: (miss) => physicalThumbnailSize(miss.width, miss.height, pixelRatio),
    ensure: (request) => window.nicegal.backend.ensureThumbnails(request),
    onFailed: (failure) => thumbnailFailures.set(failure.assetId, failure),
    onReady: (assetIds) => {
      for (const id of assetIds) localRefresh.set(id, (localRefresh.get(id) ?? 0) + 1);
    },
    onRetry: (id) => {
      // Retry only after thumb:// confirms the poster is still absent. This avoids immediately
      // repeating a failed service request when a row was committed despite a transport error.
      localRefresh.set(id, (localRefresh.get(id) ?? 0) + 1);
    },
  });

  function posterSrc(tile: PoolTile): string {
    const bump = localRefresh.get(tile.itemId);
    return bump ? `${tile.src}&e=${bump}` : tile.src;
  }

  function onPosterError(tile: PoolTile): void {
    if (tile.mediaKind !== "image") return;
    const queued = thumbnailScheduler.enqueue({
      assetId: tile.itemId,
      width: tile.width,
      height: tile.height,
    });
    if (!queued) return;
    console.debug("[nicegal:thumbnails] poster miss, queued", {
      assetId: tile.itemId,
      width: tile.width,
      height: tile.height,
    });
    if (media.scrollIdle) thumbnailScheduler.resume();
  }

  /** Logs promotion changes (not every recompute — only when the promoted set actually differs)
   * so the console stays readable while scrolling. */
  $effect(() => {
    const current = promotedIds;
    const previous = untrack(() => loggedPromotedIds);
    const added = Array.from(current).filter((id) => !previous.has(id));
    const removed = Array.from(previous).filter((id) => !current.has(id));
    if (added.length || removed.length) {
      console.debug("[nicegal:media-promotion] promoted set changed", {
        added,
        removed,
        total: current.size,
        scrollIdle: media.scrollIdle,
        animationsEnabled,
      });
    }
    loggedPromotedIds = current;
  });

  const visibleDividers = $derived(
    layout.dividers.filter(
      (divider) =>
        divider.y + divider.height >= scrollTop - viewportHeight &&
        divider.y <= scrollTop + viewportHeight * 2,
    ),
  );

  // Four effects, each doing something an effect is actually needed for — none of them are a
  // computation that could just be `$derived` instead. See the file header for the pool model;
  // per-effect reasoning is inline below.

  /**
   * Recomputes the pool whenever anything that changes what should be visible changes. This has
   * to be an effect rather than `$derived`: `recyclePool` needs to read the *previous* `tiles` to
   * decide which slots to keep (that's the whole point of pooling — see the file header), and a
   * derived value can't read its own prior output. `updatePool` reads that previous value via
   * `untrack` so re-running doesn't itself count as a dependency.
   */
  $effect(() => {
    updatePool(layout, viewportHeight, scrollTop, overscan, imagePoolSize);
  });

  /**
   * An anchor is useful for presentation-only relayouts, but a changed search means the user is
   * reading a new result set. Clearing it before the layout-restoration effect runs prevents a
   * match from the old viewport from pulling the new results into the middle.
   */
  $effect(() => {
    if (previousSearchQuery === undefined) {
      previousSearchQuery = searchQuery;
      return;
    }
    if (searchQuery === previousSearchQuery) return;
    previousSearchQuery = searchQuery;
    viewOffsets.clear();
    anchor = undefined;
    if (!viewport) return;
    viewport.scrollTop = 0;
    scrollTop = viewport.scrollTop;
  });

  // Date and Relevance are two readings of the same results, each with its own scroll position.
  // This is presentation state only: switching never schedules another backend search.
  $effect(() => {
    const key = viewKey;
    untrack(() => {
      if (previousViewKey === key) return;
      if (previousViewKey !== undefined)
        viewOffsets.set(previousViewKey, { top: scrollTop, anchor });
      const saved = viewOffsets.get(key);
      const first = previousViewKey === undefined;
      previousViewKey = key;
      if (first) return;
      anchor = saved?.anchor;
      void tick().then(() => {
        if (previousViewKey !== key || !viewport) return;
        viewport.scrollTop = saved?.top ?? 0;
        scrollTop = viewport.scrollTop;
      });
    });
  });

  /** Enables thumbnail launches once scrolling has settled and re-ranks queued misses whenever
   * the pool changes. In-progress work is left alone while the user moves to a new viewport. */
  $effect(() => {
    void tiles;
    if (media.scrollIdle) untrack(() => thumbnailScheduler.resume());
  });

  /**
   * Restores the scroll anchor whenever the layout is rebuilt (mode switch, a size knob, a
   * resize, or filtering). This is a real side effect — it awaits a `tick()` and then writes
   * `viewport.scrollTop` imperatively — not a value `$derived` could produce.
   */
  $effect(() => {
    const currentLayout = layout;
    void restoreAnchor(currentLayout);
  });

  /**
   * Notifies the parent (via the `onScroll` prop) of the current scroll position and layout.
   * Kept separate from the pool-update effect above even though its dependencies are a subset of
   * that effect's: the two serve different consumers (internal DOM pool vs. an external prop
   * callback that mainly feeds `TimelineScrollbar`), and this one also needs to fire on a
   * layout-only change (e.g. a filter shrinks `items`) with no single imperative call site to
   * hook into otherwise, since `layout` recomputes on its own via `$derived`.
   */
  $effect(() => {
    onScroll({ scrollTop, layout });
  });

  let overscanController: ReturnType<typeof createOverscanController> | undefined;

  /**
   * Owns the overscan controller's lifecycle: a fresh controller (with its own
   * `requestAnimationFrame` chain) is needed whenever the overscan props change, and the old one
   * must be disposed so it doesn't keep scheduling frames. The `return` cleanup is why this can't
   * be a derived value — only effects get teardown.
   */
  $effect(() => {
    overscan = { before: immediateOverscan, after: immediateOverscan };
    const controller = createOverscanController(
      { immediate: immediateOverscan, behind: overscanBehind, ahead: overscanAhead },
      (window) => (overscan = window),
    );
    overscanController = controller;
    return () => {
      controller.dispose();
      if (overscanController === controller) overscanController = undefined;
    };
  });

  export function scrollTo(y: number): void {
    if (!viewport) return;
    restoringAnchor = false;
    viewport.scrollTop = y;
    scrollTop = viewport.scrollTop;
    trackAnchor();
  }

  export function scrollToSection(key: string): void {
    const section = layout.dividers.find((divider) => divider.key === key);
    if (section) scrollTo(section.y);
  }

  function updatePool(
    currentLayout: GalleryLayout,
    height: number,
    top: number,
    window: OverscanWindow,
    poolSize: number,
  ): void {
    if (!height || !currentLayout.positions.length) return void (tiles = []);

    // Overscan is counted in tile bands; each mode reports its own band pitch.
    const band = currentLayout.unitHeight || height;
    const { start, end } = visibleIndexRange(
      currentLayout,
      top - window.before * band,
      top + height + window.after * band,
    );
    tiles = recyclePool({
      tiles: untrack(() => tiles),
      layout: currentLayout,
      items,
      start,
      end,
      poolSize,
      devicePixelRatio: pixelRatio,
      // Filenames use literal substrings, including punctuation and words like "OR" which
      // the OCR highlighter treats as operators. Empty searches still have no captions.
      snippets: snippetTerms.length || filenameQuery ? snippets : undefined,
      snippetTerms,
      snippetTermsKey,
      filenameQuery,
    });
  }

  function tileStyle(tile: PoolTile): string {
    return `transform: translate3d(${tile.x}px, ${tile.y}px, 0); width: ${tile.width}px; height: ${tile.height}px`;
  }

  /** True for sources small enough that smooth upscaling would blur them into mush. */
  function isPixelArt(tile: PoolTile): boolean {
    if (!tile.naturalWidth || !tile.naturalHeight) return false;
    return Math.max(tile.naturalWidth, tile.naturalHeight) < pixelatedBelow;
  }

  function onscroll(): void {
    const previousScrollTop = scrollTop;
    scrollTop = viewport.scrollTop;
    if (scrollTop !== previousScrollTop) {
      thumbnailDirection = scrollTop > previousScrollTop ? 1 : -1;
    }
    thumbnailScheduler.pause();
    overscan = overscanController?.track(scrollTop) ?? overscan;
    media.onScroll();
    // A restore's own scroll event would re-anchor onto whichever neighbour now sits at the top,
    // so repeated relayouts would walk away from the item the user was actually looking at.
    if (restoringAnchor) {
      restoringAnchor = false;
      return;
    }
    trackAnchor();
  }

  function onTileEnter(tile: PoolTile): void {
    media.hoveredId = tile.itemId;
  }

  function onTileLeave(tile: PoolTile): void {
    if (media.hoveredId === tile.itemId) media.hoveredId = null;
  }

  /** Literal body terms worth highlighting in a caption. `parseQuery` removes the scope prefix
   * and date tokens before `literalSnippetTerms` (lib/gallery/snippet-highlight.ts) inspects the
   * text and discards FTS control words. */
  const parsedSnippetQuery = $derived(parseQuery(snippetQuery));
  const snippetTerms = $derived(literalSnippetTerms(parsedSnippetQuery.body));
  const filenameQuery = $derived(
    parsedSnippetQuery.scope === "ocr" || parsedSnippetQuery.scope === "like"
      ? ""
      : parsedSnippetQuery.body.trim(),
  );
  /** Lets the pool retain a caption's precomputed marks until the actual terms change. */
  const snippetTermsKey = $derived(`${snippetTerms.join("\u0000")}\u0001${filenameQuery}`);

  /**
   * Records what is under the top of the viewport on every scroll, by item id rather than index.
   * Tracking continuously (instead of capturing just before a known relayout) means the anchor is
   * already there whatever causes the rebuild — mode switch, a size knob, a resize, or filtering.
   */
  function trackAnchor(): void {
    // Zero is a position in its own right, not the top of the first thumbnail (which follows
    // padding and possibly a section header). Preserving an item there used to hide the header.
    if (scrollTop <= 0.5) {
      anchor = { kind: "top" };
      return;
    }
    const section = layout.dividers.find(
      (divider) => divider.key && divider.y <= scrollTop && scrollTop < divider.y + divider.height,
    );
    if (section?.key) {
      anchor = { kind: "section", key: section.key, offset: scrollTop - section.y };
      return;
    }
    if (!layout.positions.length) return;
    const index = firstVisibleIndex(layout, scrollTop);
    const position = layout.positions[index];
    const item = items[index];
    if (!position || !item) return;
    anchor = {
      kind: "item",
      id: item.id,
      progress: Math.min(1, (scrollTop - position.y) / position.height),
    };
  }

  async function restoreAnchor(currentLayout: GalleryLayout): Promise<void> {
    const currentAnchor = untrack(() => anchor);
    const currentViewport = untrack(() => viewport);
    if (!currentAnchor || !currentViewport || !currentLayout.positions.length) return;
    let nextScrollTop = 0;
    if (currentAnchor.kind === "section") {
      const section = currentLayout.dividers.find((divider) => divider.key === currentAnchor.key);
      if (!section) return;
      nextScrollTop = section.y + currentAnchor.offset;
    } else if (currentAnchor.kind === "item") {
      // Rare enough (only on relayout) that a scan beats maintaining an id->index map.
      const index = items.findIndex((item) => item.id === currentAnchor.id);
      const position = currentLayout.positions[index];
      if (!position) return;
      nextScrollTop = Math.max(0, position.y + position.height * currentAnchor.progress);
    }

    // Reactive statements run before Svelte patches the DOM, so the canvas is still the previous
    // layout's height right now. Switching to a taller layout would have scrollTop clamped to the
    // old scrollHeight and silently land short — wait for the canvas to resize first.
    await tick();
    if (
      viewport !== currentViewport ||
      layout !== currentLayout ||
      anchor !== currentAnchor ||
      Math.abs(nextScrollTop - viewport.scrollTop) < 0.5
    )
      return;
    const previous = viewport.scrollTop;
    restoringAnchor = true;
    viewport.scrollTop = nextScrollTop;
    scrollTop = viewport.scrollTop;
    // A clamped write fires no scroll event, which would leave the flag set and swallow the
    // user's next real scroll.
    if (Math.abs(scrollTop - previous) < 0.5) restoringAnchor = false;
  }

  onMount(() => {
    const updatePixelRatio = (): void => {
      pixelRatio = window.devicePixelRatio || 1;
    };
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.contentRect.width;
      viewportWidth = nextWidth;
      viewportHeight = entry.contentRect.height;
    });
    observer.observe(viewport);
    window.addEventListener("resize", updatePixelRatio);
    updatePixelRatio();
    viewportWidth = viewport.clientWidth;
    viewportHeight = viewport.clientHeight;

    const stopMedia = media.start();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePixelRatio);
      stopMedia();
      thumbnailScheduler.dispose();
    };
  });
</script>

<svelte:window
  onpointerup={() => oninteractionchange(false)}
  onpointercancel={() => oninteractionchange(false)}
  onblur={() => oninteractionchange(false)}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -- background-click deselection is a
     mouse-only convenience; the keyboard equivalent is Escape (handled by the caller). -->
<div
  class={{ "gallery-viewport": true, "hide-native-scrollbar": hideNativeScrollbar }}
  bind:this={viewport}
  {@attach input.attach}
  {onscroll}
  onpointerdown={(event) => {
    oninteractionchange(true);
    input.onViewportPointerDown(event);
  }}
  onpointerup={input.onViewportPointerUp}
>
  <div
    class="section-metric"
    aria-hidden="true"
    bind:clientHeight={sectionHeaderHeight}
    bind:clientWidth={sectionGap}
  ></div>
  <div class="gallery-canvas" style:height={`${layout.height}px`}>
    {#each tiles as tile (tile.slot)}
      {@const promoted = promotedIds.has(tile.itemId)}
      <div
        class={{
          "gallery-frame": true,
          "is-pixelated": isPixelArt(tile),
          "is-selected": selectedIds.has(tile.itemId),
        }}
        data-gallery-item-id={tile.itemId}
        title={tile.snippet && tile.snippet !== tile.alt
          ? `${tile.alt}\n${tile.snippet}`
          : tile.alt}
        aria-label={thumbnailFailures.has(tile.itemId)
          ? `${tile.alt}: thumbnail unavailable. Open image`
          : tile.alt}
        style={tileStyle(tile)}
        role="button"
        tabindex="0"
        onclick={(event) => input.activate(tile, event)}
        oncontextmenu={(event) => input.openFileMenu(event, tile)}
        onkeydown={(event) => input.onFrameKeydown(event, tile)}
        onmouseenter={() => onTileEnter(tile)}
        onmouseleave={() => onTileLeave(tile)}
      >
        {#if tile.mediaKind === "video" && promoted}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            class="gallery-tile"
            src={tile.originalSrc}
            width={tile.naturalWidth || tile.width}
            height={tile.naturalHeight || tile.height}
            muted
            loop
            playsinline
            autoplay
            onerror={() => media.onOriginalError(tile)}
          ></video>
        {:else}
          {@const showingOriginal = tile.animated && promoted}
          {@const currentSrc = showingOriginal ? tile.originalSrc : posterSrc(tile)}
          <img
            class="gallery-tile"
            src={currentSrc}
            alt={tile.alt}
            decoding={imageDecoding}
            width={tile.naturalWidth || tile.width}
            height={tile.naturalHeight || tile.height}
            onerror={() => (showingOriginal ? media.onOriginalError(tile) : onPosterError(tile))}
            onload={() => {
              if (!showingOriginal) onPosterLoad(tile);
            }}
            use:tileImage={currentSrc}
          />
          {#if tile.mediaKind === "video"}
            <span class="media-badge" title="Video"><Video size={11} aria-hidden="true" /></span>
          {:else if tile.animated && !promoted}
            <span class="media-badge">GIF</span>
          {/if}
        {/if}
        {#if thumbnailFailures.has(tile.itemId)}
          <span class="thumbnail-failed">Thumbnail unavailable</span>
        {/if}
        {#if tile.snippetSegments}
          <span class="match-caption">
            {#each tile.snippetSegments as segment, index (index)}
              {#if segment.hit}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
            {/each}
          </span>
        {/if}
      </div>
    {/each}
    {#each visibleDividers as divider (divider.key ?? divider.itemIndex)}
      <div
        class="gallery-divider"
        class:search-section={Boolean(divider.key)}
        data-search-section={divider.key}
        title={divider.status}
        style:top={`${divider.y}px`}
        style:height={`${divider.height}px`}
        style:padding-inline={divider.key
          ? `${layoutOptions.padding ?? layoutDefaults.padding}px`
          : undefined}
      >
        {divider.label}
        {#if divider.count !== undefined}<span class="section-count"
            >({divider.count.toLocaleString()})</span
          >{/if}
        {#if divider.status}<span class="section-status">{divider.status}</span>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .section-metric {
    position: absolute;
    width: var(--search-section-gap);
    height: var(--search-section-height);
    visibility: hidden;
    pointer-events: none;
  }
  .section-count {
    margin-left: var(--space-6);
    color: var(--text-secondary);
    font-weight: var(--font-weight-normal);
  }
  .section-status {
    margin-left: var(--space-10);
    font-weight: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gallery-divider.search-section {
    color: var(--search-section-text);
    background: var(--surface-0);
    letter-spacing: normal;
  }
  .gallery-divider.search-section::after {
    height: 1px;
    background: var(--search-section-rule);
  }

  .thumbnail-failed {
    position: absolute;
    inset: var(--space-4);
    display: grid;
    place-content: center;
    overflow: hidden;
    overflow-wrap: anywhere;
    text-align: center;
    color: var(--text-secondary);
    background: var(--surface-2);
    font-size: var(--font-size-sm);
    pointer-events: none;
  }
  .gallery-viewport {
    overflow: auto;
    scrollbar-gutter: stable;
    background: var(--surface-0);
  }

  .gallery-viewport.hide-native-scrollbar {
    scrollbar-width: none;
  }

  .gallery-viewport.hide-native-scrollbar::-webkit-scrollbar {
    display: none;
  }

  .gallery-canvas {
    position: relative;
    min-width: 100%;
  }

  /* The frame is the placeholder. It occupies the tile's exact calculated geometry from the moment
     the slot is mounted, so a fast scroll or a jump shows a clean skeleton at the right size rather
     than the previous image the pooled <img> happened to be holding. */
  .gallery-frame {
    position: absolute;
    top: 0;
    left: 0;
    padding: var(--space-2);
    border: 1px solid var(--border);
    background: var(--surface-2);
    will-change: transform;
    cursor: pointer;
    transition: border-color var(--duration-fast) ease;
  }

  .gallery-frame:hover {
    border-color: var(--accent);
    z-index: var(--z-raised);
  }

  .gallery-frame.is-selected {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    z-index: var(--z-raised);
  }

  /* ViSelect appends this element imperatively, so its class must be global. The compact,
     translucent band follows the existing Win32 selection accent rather than adding a second
     selection color. */
  .gallery-viewport :global(.gallery-selection-area) {
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .gallery-frame:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
    z-index: var(--z-raised);
  }

  .gallery-tile {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Revealed by the tileImage action once this element's current src has loaded. */
    visibility: hidden;
  }

  /* `is-loaded` is added imperatively by the tileImage action, so the compiler cannot see it in
     the markup; :global keeps it out of the unused-selector check without unscoping the rule. */
  .gallery-tile:global(.is-loaded) {
    visibility: visible;
  }

  video.gallery-tile {
    visibility: visible;
  }

  /* Small sources fill their tile like any other, but with nearest-neighbour scaling: bilinear
     turns sprites and icons to mush at these enlargement factors. */
  .gallery-frame.is-pixelated .gallery-tile {
    image-rendering: pixelated;
  }

  /* iBooks-style "why this matched" strip: pinned to the tile's bottom edge over the image,
     two lines max, query terms marked. Semi-transparent so the image stays readable behind it. */
  .match-caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    padding: var(--space-2) var(--space-4);
    background: var(--surface-caption);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    line-height: 1.3;
    word-break: break-word;
    pointer-events: none;
  }

  .match-caption mark {
    background: var(--search-highlight-bg);
    color: var(--search-highlight-fg);
    padding: 0 1px;
  }

  /* Marks a tile as video/animated when it is showing its static poster (or, for video today, no
     poster at all — see DEFERRED_WORK.md) rather than actively playing, so it never reads as a
     plain broken image. */
  .media-badge {
    position: absolute;
    right: calc(var(--space-2) + var(--space-2));
    bottom: calc(var(--space-2) + var(--space-2));
    display: inline-flex;
    align-items: center;
    height: var(--space-14);
    padding: 0 var(--space-4);
    border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 9px;
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.02em;
    pointer-events: none;
  }

  .gallery-divider {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    padding: 0 var(--space-14);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.02em;
    pointer-events: none;
  }

  .gallery-divider::after {
    content: "";
    flex: 1;
    margin-left: var(--space-10);
    height: var(--space-1);
    background: var(--border-subtle);
  }
</style>
