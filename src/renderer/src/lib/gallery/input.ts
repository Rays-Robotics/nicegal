import type { Attachment } from "svelte/attachments";

import SelectionArea from "@viselect/vanilla";

import type { SelectionModifiers } from "./selection.svelte";
import type { PoolTile } from "./tile-pool";

interface GalleryInputCallbacks {
  onopen(index: number): void;
  onselect(index: number, modifiers: SelectionModifiers): void;
  onfilemenu(index: number): void;
  onclear(): void;
  onmarqueestart(modifiers: SelectionModifiers): void;
  onmarqueechange(ids: readonly string[]): void;
  onmarqueeend(): void;
}

/** Owns pointer/keyboard interpretation and marquee hit testing, independently of the DOM pool. */
export function createGalleryInput(callbacks: GalleryInputCallbacks): {
  attach: Attachment<HTMLDivElement>;
  activate(tile: PoolTile, event: MouseEvent): void;
  onFrameKeydown(event: KeyboardEvent, tile: PoolTile): void;
  openFileMenu(event: MouseEvent, tile: PoolTile): void;
  onViewportPointerDown(event: PointerEvent): void;
  onViewportPointerUp(event: PointerEvent): void;
} {
  const BACKGROUND_CLICK_SLOP_PX = 4;
  function activate(tile: PoolTile, event: MouseEvent): void {
    const modifiers = { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey };
    if (modifiers.toggle || modifiers.extend) {
      callbacks.onselect(tile.index, modifiers);
    } else {
      callbacks.onopen(tile.index);
    }
  }

  function onFrameKeydown(event: KeyboardEvent, tile: PoolTile): void {
    if (event.key === "Enter") {
      event.preventDefault();
      callbacks.onopen(tile.index);
    } else if (event.key === " ") {
      event.preventDefault();
      callbacks.onselect(tile.index, { toggle: false, extend: event.shiftKey });
    }
  }

  function openFileMenu(event: MouseEvent, tile: PoolTile): void {
    event.preventDefault();
    callbacks.onfilemenu(tile.index);
  }

  /** Press position of a potential background click; consumed on the matching pointerup. A tile
   * press leaves it null so the tile's own activation path owns that interaction. */
  let backgroundPress: { x: number; y: number } | null = null;

  function onViewportPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
    backgroundPress = { x: event.clientX, y: event.clientY };
  }

  function onViewportPointerUp(event: PointerEvent): void {
    const start = backgroundPress;
    backgroundPress = null;
    if (!start) return;
    const travelled = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y);
    // A marquee drag (or any drag) ends with a pointerup too; only a genuine click clears.
    if (travelled > BACKGROUND_CLICK_SLOP_PX) return;
    if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
    callbacks.onclear();
  }

  function selectionModifiers(event: MouseEvent | TouchEvent | null): SelectionModifiers {
    if (!(event instanceof MouseEvent)) return { toggle: false, extend: false };
    return { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey };
  }

  function selectableIds(elements: readonly Element[]): string[] {
    const ids: string[] = [];
    for (const element of elements) {
      const id = element instanceof HTMLElement ? element.dataset.galleryItemId : undefined;
      if (id) ids.push(id);
    }
    return ids;
  }

  const attach: Attachment<HTMLDivElement> = (viewport) => {
    const selectionArea = new SelectionArea({
      container: viewport,
      startAreas: [viewport],
      boundaries: [viewport],
      selectables: [".gallery-frame"],
      selectionAreaClass: "gallery-selection-area",
      behaviour: {
        intersect: "touch",
        startThreshold: 4,
        overlap: "keep",
        scrolling: { startScrollMargins: { x: 0, y: 16 } },
      },
      features: {
        // Tile clicks remain app-owned: a primary click opens a detail view and modifier clicks
        // retain the gallery's keyboard-compatible range semantics.
        singleTap: { allow: false },
        range: false,
        touch: false,
      },
    })
      .on("start", ({ event, selection }) => {
        // ViSelect stores elements between drags. A recycled pooled element must never carry a
        // previous asset's state, so it is just a hit-testing engine for this drag.
        selection.clearSelection(true, true);
        callbacks.onmarqueestart(selectionModifiers(event));
      })
      .on("move", ({ store }) => {
        callbacks.onmarqueechange(selectableIds(store.selected));
      })
      .on("stop", ({ selection }) => {
        selection.clearSelection(true, true);
        callbacks.onmarqueeend();
      });

    /**
     * A marquee drag only finishes on its own pointerup. Focus loss — Alt+Tab, a native menu
     * stealing focus, minimize — never delivers that pointerup, so the selection box would hang
     * until the next drag. `cancel(true)` tears down the in-progress drag and fires `stop` so the
     * app's marquee snapshot is closed as well.
     */
    const cancelMarqueeOnFocusLoss = (): void => {
      selectionArea.cancel(true);
    };
    const cancelMarqueeOnHidden = (): void => {
      if (document.hidden) selectionArea.cancel(true);
    };
    window.addEventListener("blur", cancelMarqueeOnFocusLoss);
    document.addEventListener("visibilitychange", cancelMarqueeOnHidden);

    const resetPress = (): void => {
      backgroundPress = null;
    };
    viewport.addEventListener("pointercancel", resetPress);
    window.addEventListener("blur", resetPress);
    return () => {
      selectionArea.destroy();
      viewport.removeEventListener("pointercancel", resetPress);
      window.removeEventListener("blur", resetPress);
      window.removeEventListener("blur", cancelMarqueeOnFocusLoss);
      document.removeEventListener("visibilitychange", cancelMarqueeOnHidden);
    };
  };
  return {
    attach,
    activate,
    onFrameKeydown,
    openFileMenu,
    onViewportPointerDown,
    onViewportPointerUp,
  };
}
