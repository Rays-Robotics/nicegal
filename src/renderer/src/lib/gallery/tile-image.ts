import type { ActionReturn } from "svelte/action";
/**
 * Hides a pooled `<img>` until the image it currently points at has loaded, so a recycled slot
 * shows the frame's placeholder rather than the previous occupant. Done as an action because
 * the alternative — a per-tile `loaded` flag in `tiles` — would re-render the whole pool on
 * every image load.
 */
export function tileImage(node: HTMLImageElement, src: string): ActionReturn<string> {
  const loadedClass = "is-loaded";
  const markLoaded = (): void => node.classList.add(loadedClass);
  node.addEventListener("load", markLoaded);
  if (node.complete && node.naturalWidth > 0) markLoaded();

  return {
    update(next: string): void {
      if (next === src) return;
      src = next;
      // Never trust `complete` here: whether the new src has been applied to the element yet
      // depends on update ordering. The load event is the only reliable signal.
      node.classList.remove(loadedClass);
    },
    destroy(): void {
      node.removeEventListener("load", markLoaded);
    },
  };
}
