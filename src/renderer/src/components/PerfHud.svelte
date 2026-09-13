<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import type { GalleryPerfMonitor, PerfSnapshot } from "../lib/gallery/perf-metrics";

  import { createGalleryPerfMonitor } from "../lib/gallery/perf-metrics";

  // Only ever active in dev builds. `import.meta.env.DEV` is a compile-time constant, so Vite
  // dead-code-eliminates everything below the guard from production bundles.
  const DEV = import.meta.env.DEV;

  const POLL_MS = 300;

  let collapsed = $state(true);
  let stats = $state<PerfSnapshot | null>(null);

  let monitor: GalleryPerfMonitor | undefined;
  let pollHandle: ReturnType<typeof setInterval> | undefined;

  function toggle(): void {
    collapsed = !collapsed;
  }

  function fmt(value: number | undefined, digits = 1): string {
    return value === undefined || Number.isNaN(value) ? "–" : value.toFixed(digits);
  }

  onMount(() => {
    if (!DEV) return;
    monitor = createGalleryPerfMonitor();
    monitor.start();
    pollHandle = setInterval(() => {
      stats = monitor ? monitor.snapshot() : null;
    }, POLL_MS);
  });

  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
    monitor?.stop();
  });

  // Health is judged on Long Task data (see perf-metrics.ts), not fps: fps legitimately drops to
  // 0 when Chrome throttles/pauses requestAnimationFrame on an idle-but-foreground window to save
  // power, which is indistinguishable from a real stall if you only look at frame rate. Long Tasks
  // fire off main-thread scheduling regardless of paint/rAF activity, so they stay quiet when idle
  // and spike exactly when something blocks the thread (the thing that actually causes hitches).
  const LONG_TASK_WARN_MS = 100;
  const BLOCKED_TOTAL_WARN_MS = 200;
  const healthy = $derived(
    !stats ||
      !stats.bound ||
      ((!stats.longTaskSupported ||
        (stats.longTaskMaxMs < LONG_TASK_WARN_MS &&
          stats.longTaskTotalMs < BLOCKED_TOTAL_WARN_MS)) &&
        stats.blankViewportEvents === 0),
  );
</script>

{#if DEV}
  <div class={{ "perf-hud": true, collapsed }}>
    <button class="perf-hud-header" onclick={toggle} type="button">
      <span class={{ dot: true, warn: !healthy }}></span>
      <span class="label">PERF</span>
      {#if stats}
        <!-- Headline metric is main-thread blocking time (Long Tasks API), not fps: fps reads 0
             both when the renderer stalls AND when Chrome throttles rAF on an idle window to save
             power, so it can't tell those apart. Blocked-ms stays quiet when idle and spikes
             exactly when something actually blocks the thread. -->
        <span
          class="metric"
          title="main-thread blocked (long tasks) in last {fmt(stats.windowMs / 1000, 1)}s"
          >{stats.longTaskSupported ? `${fmt(stats.longTaskTotalMs, 0)}ms blk` : "n/a"}</span
        >
      {/if}
      <span class="chevron">{collapsed ? "▸" : "▾"}</span>
    </button>

    {#if !collapsed}
      <div class="perf-hud-body">
        {#if !stats || !stats.bound}
          <div class="row muted"><span>waiting for .gallery-viewport…</span></div>
        {:else}
          <div class="row">
            <span>long tasks</span><span
              >{stats.longTaskSupported
                ? `${stats.longTaskCount} (${fmt(stats.longTaskTotalMs, 0)} / ${fmt(stats.longTaskMaxMs, 0)} ms)`
                : "unsupported"}</span
            >
          </div>
          <div class="row muted">
            <span>fps (idle ⇒ 0)</span><span>{fmt(stats.fps, 0)}</span>
          </div>
          <div class="row">
            <span>frame avg / max</span><span
              >{fmt(stats.frameTimeAvgMs)} / {fmt(stats.frameTimeMaxMs)} ms</span
            >
          </div>
          <div class="row">
            <span>decode avg / p95</span><span
              >{fmt(stats.decodeAvgMs)} / {fmt(stats.decodeP95Ms)} ms</span
            >
          </div>
          <div class="row">
            <span>decode samples</span><span>{stats.decodeSampleCount}</span>
          </div>
          <div class="row">
            <span>pool churn</span><span>{fmt(stats.poolChurnPerSec)}/s</span>
          </div>
          <div class="row">
            <span>added / removed</span><span>{stats.poolAdded} / {stats.poolRemoved}</span>
          </div>
          <div class="row">
            <span>blank events</span><span
              >{stats.blankViewportEvents} ({fmt(stats.blankViewportPerMin)}/min)</span
            >
          </div>
          <div class="row">
            <span>live tiles</span><span>{stats.tileCount}</span>
          </div>
          <div class="row muted">
            <span>window</span><span>{fmt(stats.windowMs / 1000, 1)}s</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .perf-hud {
    position: fixed;
    right: var(--space-8);
    bottom: calc(var(--statusbar-height, 22px) + var(--space-8));
    z-index: var(--z-perf-hud);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 11px;
    line-height: 1.4;
    color: #d7f7e6;
    background: rgba(12, 16, 14, 0.82);
    border: 1px solid rgba(120, 220, 170, 0.35);
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(2px);
    user-select: none;
    min-width: 96px;
    max-width: 240px;
  }

  .perf-hud-header {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    width: 100%;
    padding: var(--space-4) var(--space-8);
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }

  .perf-hud.collapsed .perf-hud-header {
    padding: var(--space-3) var(--space-7);
  }

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #46d38a;
    box-shadow: 0 0 4px rgba(70, 211, 138, 0.8);
  }

  .dot.warn {
    background: #e8935a;
    box-shadow: 0 0 4px rgba(232, 147, 90, 0.8);
  }

  .label {
    flex: none;
    letter-spacing: 0.06em;
    opacity: 0.75;
  }

  .metric {
    flex: 1;
    text-align: right;
    opacity: 0.9;
    font-variant-numeric: tabular-nums;
  }

  .chevron {
    flex: none;
    opacity: 0.55;
    width: 10px;
    text-align: center;
  }

  .perf-hud-body {
    padding: var(--space-2) var(--space-8) var(--space-6);
    border-top: 1px solid rgba(120, 220, 170, 0.2);
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: var(--space-12);
    padding: var(--space-1) 0;
    white-space: nowrap;
  }

  .row span:last-child {
    font-variant-numeric: tabular-nums;
    opacity: 0.92;
  }

  .row.muted {
    opacity: 0.55;
  }
</style>
