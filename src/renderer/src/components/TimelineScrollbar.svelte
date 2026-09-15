<script lang="ts">
  import type { GalleryItem, GalleryLayout } from "../lib/gallery/types";

  import { timelineTickLabel, bucketLabel } from "../lib/gallery/dates";
  import { firstVisibleIndex } from "../lib/gallery/visible-range";

  // All five are always supplied by App.svelte, the sole caller, and none of them degrade
  // gracefully: an empty layout/onSeek no-op wouldn't be a usable reduced state, just a scrollbar
  // that silently does nothing. Required, not optional — the old `?`/defaults papered over what
  // is really a hard dependency on the gallery it's paired with.
  let {
    items,
    layout,
    scrollTop,
    viewportHeight,
    showTicks = true,
    onSeek,
  }: {
    items: GalleryItem[];
    layout: GalleryLayout;
    scrollTop: number;
    viewportHeight: number;
    /**
     * Date ticks describe a date-ordered gallery. Relevance-sorted search results are not one —
     * their dates run in no order at all — so ranked mode turns the ruler off and keeps only the
     * scrollbar.
     */
    showTicks?: boolean;
    onSeek: (y: number) => void;
  } = $props();

  type Tick = { y: number; label: string; major: boolean };

  let trackEl: HTMLDivElement;
  let dragging = $state(false);

  // Dates are ordered whenever the ruler is shown. Find each year's first item with a
  // binary search, so a large library does not need a full scan when its layout changes.
  const yearStarts = $derived.by(() => {
    const starts: { index: number; year: number }[] = [];
    if (!showTicks) return starts;
    let index = 0;
    while (index < items.length) {
      const year = new Date(items[index].date).getFullYear();
      starts.push({ index, year });
      let low = index + 1;
      let high = items.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (new Date(items[middle].date).getFullYear() === year) low = middle + 1;
        else high = middle;
      }
      index = low;
    }
    return starts;
  });

  const contentHeight = $derived(Math.max(layout.height, 1));
  const thumbHeight = $derived(
    Math.max(24, viewportHeight * Math.min(1, viewportHeight / contentHeight)),
  );
  const maxThumbTravel = $derived(Math.max(0, viewportHeight - thumbHeight));
  const scrollRange = $derived(Math.max(1, contentHeight - viewportHeight));
  const thumbTop = $derived((scrollTop / scrollRange) * maxThumbTravel);

  const ticks = $derived(showTicks ? buildTicks(items, layout, viewportHeight) : []);
  const activeLabel = $derived(showTicks ? currentLabel(items, layout, scrollTop) : "");
  const scrollPercent = $derived(Math.round((scrollTop / scrollRange) * 100));

  /** Vertical breathing room between two tick labels, in track pixels. */
  const TICK_SPACING = 26;
  /** Below this thumb height the grip would touch the bevel edges — hide it rather than crowd. */
  const GRIP_MIN_THUMB_HEIGHT = 48;

  function buildTicks(
    galleryItems: GalleryItem[],
    currentLayout: GalleryLayout,
    trackHeight: number,
  ): Tick[] {
    if (!galleryItems.length || !currentLayout.positions.length || trackHeight <= 0) return [];
    const content = Math.max(1, currentLayout.height);
    // Keep labels inside the track and reserve room for years before adding minor dates.
    const inset = Math.min(TICK_SPACING / 2, trackHeight / 2);
    const trackY = (y: number): number =>
      Math.max(inset, Math.min(trackHeight - inset, (y / content) * trackHeight));
    const years: Tick[] = [];
    for (const start of yearStarts) {
      const position = currentLayout.positions[start.index];
      if (!position) continue;
      const y = trackY(position.y);
      const previous = years[years.length - 1];
      if (previous && y - previous.y < TICK_SPACING) {
        // Tiny year sections share a range label instead of silently losing their year.
        previous.label = `${previous.label.split("–")[0]}–${start.year}`;
        continue;
      }
      years.push({ y, label: String(start.year), major: true });
    }
    // Sample finely, then thin out by label and by spacing — the track is short, and tile
    // positions are content-space, so many samples collapse onto the same few track pixels.
    const step = Math.max(1, Math.floor(galleryItems.length / Math.max(2, trackHeight / 8)));
    const result: Tick[] = [];
    let lastLabel = "";
    let lastY = Number.NEGATIVE_INFINITY;
    for (let itemIndex = 0; itemIndex < galleryItems.length; itemIndex += step) {
      const position = currentLayout.positions[itemIndex];
      if (!position) continue;
      const label = timelineTickLabel(galleryItems[itemIndex].date, "day");
      if (label === lastLabel) continue;
      // Content space -> track space. Without this, every tick past the first lands below the
      // track and is clipped away.
      const y = trackY(position.y);
      if (y - lastY < TICK_SPACING) continue;
      if (years.some((year) => Math.abs(year.y - y) < TICK_SPACING)) continue;
      lastLabel = label;
      lastY = y;
      result.push({ y, label, major: false });
    }
    // The first year (or compressed year range) only describes the start of the library.
    // Keep its spacing reserved, but show labels only for the later year sections.
    return [...years.slice(1), ...result].sort((a, b) => a.y - b.y);
  }

  function currentLabel(
    galleryItems: GalleryItem[],
    currentLayout: GalleryLayout,
    top: number,
  ): string {
    if (!galleryItems.length || !currentLayout.positions.length) return "";
    const item = galleryItems[firstVisibleIndex(currentLayout, top)];
    return item ? bucketLabel(item.date, "day") : "";
  }

  function seekToClientY(clientY: number): void {
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const fraction =
      maxThumbTravel > 0 ? (clientY - rect.top - thumbHeight / 2) / maxThumbTravel : 0;
    onSeek(Math.max(0, Math.min(scrollRange, fraction * scrollRange)));
  }

  function onpointerdown(event: PointerEvent): void {
    dragging = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    seekToClientY(event.clientY);
  }

  function onpointermove(event: PointerEvent): void {
    if (!dragging) return;
    seekToClientY(event.clientY);
  }

  function onpointerup(): void {
    dragging = false;
  }
</script>

<div
  class="timeline-scrollbar"
  bind:this={trackEl}
  role="slider"
  aria-label="Scroll to date"
  aria-orientation="vertical"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={scrollPercent}
  tabindex="0"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
>
  {#each ticks as tick (`${tick.label}@${tick.y}`)}
    <div class={{ tick: true, "year-tick": tick.major }} style:top={`${tick.y}px`}>
      <span class="tick-mark"></span>
      <span class="tick-label">{tick.label}</span>
    </div>
  {/each}

  <div
    class={{ thumb: true, dragging }}
    style:top={`${thumbTop}px`}
    style:height={`${thumbHeight}px`}
  >
    {#if thumbHeight >= GRIP_MIN_THUMB_HEIGHT}
      <span class="grip" aria-hidden="true"></span>
    {/if}
    {#if dragging && activeLabel}
      <div class="active-label">{activeLabel}</div>
    {/if}
  </div>
</div>

<style>
  .timeline-scrollbar {
    position: relative;
    width: 18px;
    height: 100%;
    background: var(--surface-1);
    border-left: 1px solid var(--border-subtle);
    /* Right edge sits flush against the window/content edge with nothing beyond it to frame it —
       per the user's review, an unbordered flush edge reads as cropped even once the thumb's
       corner-cut illusion (border-radius) is fixed. A matching 1px border gives the whole track a
       defined right edge, like the left one already has. */
    border-right: 1px solid var(--border-subtle);
    touch-action: none;
    cursor: pointer;
    user-select: none;
  }

  .timeline-scrollbar:focus-visible {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }

  .tick {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    height: 0;
    pointer-events: none;
  }

  .tick-mark {
    width: var(--space-9);
    height: var(--space-1);
    background: var(--tick-mark);
  }

  .tick-label {
    position: absolute;
    right: 100%;
    margin-right: var(--space-6);
    padding: var(--space-1) var(--space-5);
    white-space: nowrap;
    font-size: 10px;
    color: var(--text-secondary);
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    opacity: 0;
    transform: translateX(4px);
    transition:
      opacity var(--duration-fast) ease,
      transform var(--duration-fast) ease;
  }

  .timeline-scrollbar:hover .tick-label,
  .timeline-scrollbar:focus-visible .tick-label,
  .year-tick .tick-label {
    opacity: 1;
    transform: translateX(0);
  }

  .year-tick .tick-mark {
    width: 100%;
    height: var(--space-2);
    background: var(--tick-mark-major);
  }

  .year-tick .tick-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-normal);
    color: var(--text-primary);
    background: var(--surface-1);
    border-color: var(--tick-mark-major);
  }

  .thumb {
    position: absolute;
    /* Flush with the track edges, like a real Win32 scrollbar handle — it fills the trough
       edge-to-edge rather than floating with margin on either side. No border-radius: a rounded
       corner sitting directly on an unframed edge (the track has no right border to visually
       contain it) reads as a clipped/cropped corner rather than an intentional curve. A real
       Win32 scrollbar thumb is a plain rectangle anyway. */
    left: 0;
    right: 0;
    background: var(--btn-face);
    /* Frame is a single uniform inset ring drawn in box-shadow, following 7.css's scrollbar
       (--w7-el-sd: inset 0 0 0 1px). A real 1px CSS border is sub-pixel at 125% device scale and
       the browser rounds it inward unevenly, which showed up live as a fat left indent; and the
       theme --bevel-* tokens are deliberately asymmetric (top-edge highlight), which reads as
       left-padding on a 16px handle. One even ring + one faint inner white ring (the classic
       raised-control sheen) is centered at any DPI. No bevel: the thumb is a flat control. */
    box-shadow:
      inset 0 0 0 1px var(--btn-border),
      inset 0 0 0 2px rgb(255 255 255 / 55%);
  }

  .timeline-scrollbar:hover .thumb {
    background: var(--btn-face-hover);
    box-shadow:
      inset 0 0 0 1px var(--btn-border-hover),
      inset 0 0 0 2px rgb(255 255 255 / 55%);
  }

  .thumb.dragging {
    /* Pressed/held: a flat soft-blue fill (7.css's active scrollbar gradient), not the saturated
       --accent and not a sunken bevel — both were called out in live review as too blue and too
       harsh on a narrow handle. The faint inner ring stays so the edge still reads. */
    background: var(--scrollbar-thumb-active);
    box-shadow:
      inset 0 0 0 1px var(--scrollbar-thumb-active-border),
      inset 0 0 0 2px rgb(255 255 255 / 45%);
  }

  /* Win32-style grip: three short horizontal bars centered in the thumb, the classic
     "this handle drags" cue. Each bar is an engraved pair — 1px shadow line with a 1px
     highlight directly under it — drawn as six fixed 1px rows inside an 8x7 box. Pure
     background layers keep it one element; the border-tone shadow + translucent white
     highlight stay legible over the button face in every theme, including the sunken
     pressed state. */
  .grip {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 8px;
    height: 8px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    background:
      linear-gradient(to bottom, var(--btn-border), var(--btn-border)) 0 0 / 8px 1px,
      linear-gradient(to bottom, rgb(255 255 255 / 55%), rgb(255 255 255 / 55%)) 0 1px / 8px 1px,
      linear-gradient(to bottom, var(--btn-border), var(--btn-border)) 0 3px / 8px 1px,
      linear-gradient(to bottom, rgb(255 255 255 / 55%), rgb(255 255 255 / 55%)) 0 4px / 8px 1px,
      linear-gradient(to bottom, var(--btn-border), var(--btn-border)) 0 6px / 8px 1px,
      linear-gradient(to bottom, rgb(255 255 255 / 55%), rgb(255 255 255 / 55%)) 0 7px / 8px 1px;
    background-repeat: no-repeat;
  }

  .active-label {
    position: absolute;
    right: calc(100% + var(--space-6));
    top: 50%;
    transform: translateY(-50%);
    padding: var(--space-3) var(--space-8);
    white-space: nowrap;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--text-on-accent);
    background: var(--accent);
    border: 1px solid var(--accent-active);
    border-radius: var(--radius-sm);
    box-shadow: 1px 1px 4px rgba(0, 0, 0, 0.3);
  }
</style>
