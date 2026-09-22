import { settings, settingsLimits } from "../settings.svelte";

/** Ctrl+wheel changes tile size. The owner supplies whether an overlay blocks the gallery. */
export function createGalleryWheelZoom(
  isBlocked: () => boolean,
): (element: HTMLDivElement) => () => void {
  return (element: HTMLDivElement): (() => void) => {
    let accumulated = 0;
    let lastWheelTime = 0;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || isBlocked()) {
        accumulated = 0;
        return;
      }
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (!delta) return;
      if (event.timeStamp - lastWheelTime > 250 || Math.sign(delta) !== Math.sign(accumulated))
        accumulated = 0;
      lastWheelTime = event.timeStamp;
      accumulated += delta;
      const steps = Math.trunc(accumulated / 80);
      if (!steps) return;
      accumulated -= steps * 80;
      settings.update((current) => {
        const key =
          current.layoutMode === "justified"
            ? "targetRowHeight"
            : current.layoutMode === "masonry"
              ? "masonryColumnWidth"
              : "gridCellWidth";
        const limit = settingsLimits[key];
        return {
          ...current,
          [key]: Math.max(limit.min, Math.min(limit.max, current[key] - steps * limit.step * 3)),
          ...(current.layoutMode === "grid" ? { gridColumns: 0 } : {}),
        };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  };
}
