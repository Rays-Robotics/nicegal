// Dev-only performance monitor for the virtualized gallery.
//
// This module is intentionally decoupled from VirtualGallery's internals: it observes the
// DOM purely through the three stable class names the gallery is expected to render
// (`.gallery-viewport`, `.gallery-canvas`, `.gallery-tile`) so it keeps working across
// refactors of the component's markup/props. It is safe to import from a dev-only context;
// it does no work until `start()` is called.

export interface PerfSnapshot {
  /**
   * Frames captured per second, measured over the rolling window via requestAnimationFrame deltas.
   * NOTE: not a reliable health signal on its own — Chrome throttles/pauses rAF on a genuinely
   * idle foreground window to save power, so this legitimately reads 0 when nothing is wrong.
   * Prefer `longTask*` fields to distinguish "idle" from "renderer actually stalled".
   */
  fps: number;
  /** Mean time between animation frames in the rolling window, in ms. */
  frameTimeAvgMs: number;
  /** Worst (longest) single frame gap in the rolling window, in ms — a jank indicator. */
  frameTimeMaxMs: number;
  /** Number of frame samples currently in the rolling window. */
  frameSampleCount: number;

  /**
   * Count of Long Tasks (PerformanceObserver 'longtask', >50ms of uninterrupted main-thread
   * work) that started within the rolling window. Unlike fps, this fires purely off main-thread
   * scheduling and is unaffected by rAF throttling — it reads 0 when the renderer is idle
   * (nothing to observe) and nonzero exactly when something actually blocked the thread.
   */
  longTaskCount: number;
  /** Sum of Long Task durations in the rolling window, in ms — total main-thread blocking time. */
  longTaskTotalMs: number;
  /** Longest single Long Task duration in the rolling window, in ms — worst-case stall so far. */
  longTaskMaxMs: number;
  /** Whether the Long Tasks API is available in this runtime (it is on all modern Chromium/Electron). */
  longTaskSupported: boolean;

  /** Mean img.decode() duration for tiles decoded in the rolling window, in ms. */
  decodeAvgMs: number;
  /** 95th percentile img.decode() duration in the rolling window, in ms. */
  decodeP95Ms: number;
  /** Number of decode samples currently in the rolling window. */
  decodeSampleCount: number;

  /** `.gallery-tile` DOM nodes inserted into `.gallery-canvas` in the rolling window. */
  poolAdded: number;
  /** `.gallery-tile` DOM nodes removed from `.gallery-canvas` in the rolling window. */
  poolRemoved: number;
  /** (added + removed) per second over the rolling window — DOM pool churn rate. */
  poolChurnPerSec: number;

  /** Blank-viewport episodes detected (edge-triggered) in the rolling window. */
  blankViewportEvents: number;
  /** Blank-viewport episodes, normalized to a per-minute rate. */
  blankViewportPerMin: number;

  /** Live count of `.gallery-tile` elements currently under `.gallery-canvas`. */
  tileCount: number;
  /** Whether the monitor currently has a `.gallery-viewport`/`.gallery-canvas` pair bound. */
  bound: boolean;
  /** Width of the rolling window, in ms (for display/context). */
  windowMs: number;
}

export interface GalleryPerfMonitor {
  /** Begin observing (rAF loop + MutationObserver + scroll listener). Idempotent. */
  start(): void;
  /** Stop observing and release all listeners/observers. Idempotent. */
  stop(): void;
  /** Clear all accumulated samples without stopping observation. */
  reset(): void;
  /** Compute a fresh snapshot from the current rolling-window samples. Cheap; safe to poll. */
  snapshot(): PerfSnapshot;
}

export interface GalleryPerfMonitorOptions {
  /** Rolling window size in ms. Defaults to 4000ms. */
  windowMs?: number;
  /** How often (ms) the internal maintenance tick re-checks binding + does a fallback blank check. */
  maintenanceIntervalMs?: number;
}

const VIEWPORT_SELECTOR = ".gallery-viewport";
const CANVAS_SELECTOR = ".gallery-canvas";
const TILE_SELECTOR = ".gallery-tile";

interface TimedSample {
  t: number;
  dt: number;
}
interface ChurnEvent {
  t: number;
  kind: "add" | "remove";
}
interface BlankEpisode {
  t: number;
}

function isTileImage(node: Node): node is HTMLImageElement {
  return (
    node.nodeType === 1 &&
    (node as Element).tagName === "IMG" &&
    (node as Element).matches(TILE_SELECTOR)
  );
}

/** Collect every tile matching TILE_SELECTOR within (and including) a subtree root. */
function collectTiles(node: Node): HTMLImageElement[] {
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  const found: HTMLImageElement[] = [];
  if (el.matches(TILE_SELECTOR)) found.push(el as HTMLImageElement);
  el.querySelectorAll<HTMLImageElement>(TILE_SELECTOR).forEach((tile) => found.push(tile));
  return found;
}

function prune<T extends { t: number }>(arr: T[], now: number, windowMs: number): void {
  let cut = 0;
  while (cut < arr.length && now - arr[cut].t > windowMs) cut++;
  if (cut > 0) arr.splice(0, cut);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export function createGalleryPerfMonitor(
  options: GalleryPerfMonitorOptions = {},
): GalleryPerfMonitor {
  const windowMs = options.windowMs ?? 4000;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? 500;

  let running = false;
  let rafId: number | null = null;
  let lastFrameAt = 0;
  let nextMaintenanceAt = 0;

  let boundViewport: Element | null = null;
  let boundCanvas: Element | null = null;
  let mutationObserver: MutationObserver | null = null;
  let scrollScheduled = false;

  const frameSamples: TimedSample[] = [];
  const decodeSamples: TimedSample[] = [];
  const churnEvents: ChurnEvent[] = [];
  const blankEpisodes: BlankEpisode[] = [];
  const longTaskSamples: TimedSample[] = [];
  const lastTimedSrc = new WeakMap<HTMLImageElement, string>();
  let wasBlank = false;
  let longTaskObserver: PerformanceObserver | null = null;
  const longTaskSupported =
    typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false);

  function startLongTaskObserver(): void {
    if (!longTaskSupported || longTaskObserver) return;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskSamples.push({ t: entry.startTime, dt: entry.duration });
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch {
      // Some embedders (or a locked-down Electron build) may reject the entry type — degrade
      // gracefully rather than throwing out of start().
      longTaskObserver = null;
    }
  }

  function timeDecode(img: HTMLImageElement): void {
    const srcAtCall = img.currentSrc || img.src;
    if (!srcAtCall || lastTimedSrc.get(img) === srcAtCall) return;
    lastTimedSrc.set(img, srcAtCall);
    const t0 = performance.now();
    const record = (): void => {
      // Guard against a stale decode() resolving after the node moved on to a newer src.
      if ((img.currentSrc || img.src) !== srcAtCall) return;
      decodeSamples.push({ t: performance.now(), dt: performance.now() - t0 });
    };
    if (typeof img.decode === "function") {
      img.decode().then(record, () => {
        /* decode aborted/replaced — skip the sample, it would be misleading */
      });
    } else if (img.complete) {
      record();
    } else {
      img.addEventListener("load", record, { once: true });
    }
  }

  function handleMutations(mutations: MutationRecord[]): void {
    const now = performance.now();
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (target.nodeType === 1 && isTileImage(target)) {
          timeDecode(target);
        }
        continue;
      }
      mutation.addedNodes.forEach((node) => {
        for (const tile of collectTiles(node)) {
          churnEvents.push({ t: now, kind: "add" });
          timeDecode(tile);
        }
      });
      mutation.removedNodes.forEach((node) => {
        const removedCount = collectTiles(node).length;
        for (let i = 0; i < removedCount; i += 1) {
          churnEvents.push({ t: now, kind: "remove" });
        }
      });
    }
  }

  function checkBlankViewport(now: number): void {
    if (!boundViewport) return;
    const vRect = boundViewport.getBoundingClientRect();
    if (vRect.width <= 0 || vRect.height <= 0) return;

    const tiles = boundViewport.querySelectorAll<HTMLImageElement>(TILE_SELECTOR);
    if (tiles.length === 0) {
      // Nothing rendered yet (e.g. initial load) — not a meaningful "blank" signal.
      wasBlank = false;
      return;
    }

    let loadedIntersecting = false;
    for (const tile of tiles) {
      if (!(tile.complete && tile.naturalWidth > 0)) continue;
      const r = tile.getBoundingClientRect();
      if (
        r.bottom > vRect.top &&
        r.top < vRect.bottom &&
        r.right > vRect.left &&
        r.left < vRect.right
      ) {
        loadedIntersecting = true;
        break;
      }
    }

    if (loadedIntersecting) {
      wasBlank = false;
      return;
    }
    // Edge-triggered: count the start of a blank episode, not every frame it persists.
    if (!wasBlank) {
      wasBlank = true;
      blankEpisodes.push({ t: now });
    }
  }

  function onScroll(): void {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      checkBlankViewport(performance.now());
    });
  }

  function ensureBound(): void {
    const viewport = document.querySelector(VIEWPORT_SELECTOR);
    const canvas = document.querySelector(CANVAS_SELECTOR);

    if (viewport !== boundViewport) {
      if (boundViewport) boundViewport.removeEventListener("scroll", onScroll);
      boundViewport = viewport;
      if (boundViewport) boundViewport.addEventListener("scroll", onScroll, { passive: true });
    }

    if (canvas !== boundCanvas) {
      mutationObserver?.disconnect();
      boundCanvas = canvas;
      if (boundCanvas) {
        mutationObserver = new MutationObserver(handleMutations);
        mutationObserver.observe(boundCanvas, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src"],
        });
      } else {
        mutationObserver = null;
      }
    }
  }

  function frameTick(now: number): void {
    if (lastFrameAt) frameSamples.push({ t: now, dt: now - lastFrameAt });
    lastFrameAt = now;

    prune(frameSamples, now, windowMs);
    prune(decodeSamples, now, windowMs);
    prune(churnEvents, now, windowMs);
    prune(blankEpisodes, now, windowMs);
    prune(longTaskSamples, now, windowMs);

    if (now >= nextMaintenanceAt) {
      nextMaintenanceAt = now + maintenanceIntervalMs;
      ensureBound();
      checkBlankViewport(now);
    }

    rafId = requestAnimationFrame(frameTick);
  }

  function start(): void {
    if (running) return;
    running = true;
    lastFrameAt = 0;
    nextMaintenanceAt = 0;
    ensureBound();
    startLongTaskObserver();
    rafId = requestAnimationFrame(frameTick);
  }

  function stop(): void {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    longTaskObserver?.disconnect();
    longTaskObserver = null;
    if (boundViewport) boundViewport.removeEventListener("scroll", onScroll);
    boundViewport = null;
    boundCanvas = null;
  }

  function reset(): void {
    frameSamples.length = 0;
    decodeSamples.length = 0;
    churnEvents.length = 0;
    blankEpisodes.length = 0;
    longTaskSamples.length = 0;
    wasBlank = false;
  }

  function snapshot(): PerfSnapshot {
    const now = performance.now();
    prune(frameSamples, now, windowMs);
    prune(decodeSamples, now, windowMs);
    prune(churnEvents, now, windowMs);
    prune(blankEpisodes, now, windowMs);
    prune(longTaskSamples, now, windowMs);

    const windowSec = windowMs / 1000;
    const frameDeltas = frameSamples.map((s) => s.dt);
    const decodeDurations = decodeSamples.map((s) => s.dt).sort((a, b) => a - b);
    const added = churnEvents.reduce((n, e) => n + (e.kind === "add" ? 1 : 0), 0);
    const removed = churnEvents.reduce((n, e) => n + (e.kind === "remove" ? 1 : 0), 0);
    const longTaskDurations = longTaskSamples.map((s) => s.dt);

    return {
      fps: frameDeltas.length ? Math.min(240, 1000 / mean(frameDeltas)) : 0,
      frameTimeAvgMs: mean(frameDeltas),
      frameTimeMaxMs: frameDeltas.length ? Math.max(...frameDeltas) : 0,
      frameSampleCount: frameDeltas.length,

      longTaskCount: longTaskDurations.length,
      longTaskTotalMs: longTaskDurations.reduce((a, b) => a + b, 0),
      longTaskMaxMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0,
      longTaskSupported,

      decodeAvgMs: mean(decodeDurations),
      decodeP95Ms: percentile(decodeDurations, 95),
      decodeSampleCount: decodeDurations.length,

      poolAdded: added,
      poolRemoved: removed,
      poolChurnPerSec: (added + removed) / windowSec,

      blankViewportEvents: blankEpisodes.length,
      blankViewportPerMin: (blankEpisodes.length / windowSec) * 60,

      tileCount: boundCanvas ? boundCanvas.querySelectorAll(TILE_SELECTOR).length : 0,
      bound: Boolean(boundViewport && boundCanvas),
      windowMs,
    };
  }

  return { start, stop, reset, snapshot };
}
