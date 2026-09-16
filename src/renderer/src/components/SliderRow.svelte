<script lang="ts">
  /** A Win32-style trackbar: label + readout, a tick ruler, and a sunken groove with a tall thumb. */
  let {
    label,
    compact = false,
    value = $bindable(),
    min,
    max,
    step = 1,
    unit = "px",
    disabled = false,
    title = undefined,
    tickStep = 16,
    majorEvery = 5,
  }: {
    label: string;
    compact?: boolean;
    value: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    disabled?: boolean;
    title?: string;
    tickStep?: number;
    majorEvery?: number;
  } = $props();
  /** Value interval between tick marks — one mark per 16px of the setting it drives. */
  /** Every nth tick is drawn taller, like a ruler (every 5th = every 80px by default). */

  type Tick = { fraction: number; major: boolean };

  const marks = $derived(buildTicks(min, max, tickStep, majorEvery));
  let draggingPointer = $state<number | null>(null);

  function endDrag(event: PointerEvent): void {
    if (event.pointerId === draggingPointer) draggingPointer = null;
  }

  function buildTicks(from: number, to: number, interval: number, major: number): Tick[] {
    if (!(interval > 0) || to <= from) return [];
    const ticks: Tick[] = [];
    const first = Math.ceil(from / interval) * interval;
    const limit = to + interval * 1e-6;
    let ordinal = Math.round(first / interval);
    for (let at = first; at <= limit; at += interval, ordinal += 1) {
      ticks.push({ fraction: (at - from) / (to - from), major: ordinal % major === 0 });
    }
    return ticks;
  }
</script>

<svelte:window
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onblur={() => (draggingPointer = null)}
/>

<div class={{ "slider-row": true, disabled, compact }}>
  <div class="head">
    <span class="label">{compact ? "Size" : label}</span>
    <span class="readout">{value}{unit ? ` ${unit}` : ""}</span>
  </div>
  <div class="trackbar">
    <div class="ruler" aria-hidden="true">
      {#each marks as mark (mark.fraction)}
        <span
          class={{ tick: true, major: mark.major }}
          style:left={`calc(${mark.fraction} * (100% - var(--thumb-width)) + var(--thumb-width) / 2)`}
        ></span>
      {/each}
    </div>
    <input
      class="ui-trackbar"
      type="range"
      aria-label={label}
      aria-valuetext={`${value}${unit ? ` ${unit}` : ""}`}
      {min}
      {max}
      {step}
      {disabled}
      {title}
      bind:value
      onpointerdown={(event) => {
        if (!disabled && event.isPrimary && event.button === 0) draggingPointer = event.pointerId;
      }}
      onlostpointercapture={endDrag}
    />
    {#if compact && draggingPointer !== null && !disabled}
      <span class="drag-value" aria-hidden="true">{value}{unit ? ` ${unit}` : ""}</span>
    {/if}
  </div>
</div>

<style>
  .slider-row {
    padding: var(--space-4) var(--space-9) var(--space-7);
    font-size: var(--font-size-md);
    color: var(--text-primary);
  }

  .slider-row.compact {
    display: flex;
    box-sizing: border-box;
    align-items: center;
    gap: var(--space-8);
    padding: 0 var(--space-8);
    height: var(--toolbar-control-height);
    border: 1px solid var(--toolbar-field-border, var(--border-subtle));
    border-radius: var(--radius-sm);
    background: var(--surface-0);
  }
  .slider-row.compact:focus-within {
    border-color: var(--btn-border-hover);
  }
  .compact .head {
    padding: 0;
    flex: none;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-tight);
  }
  .compact .readout,
  .compact .ruler {
    display: none;
  }
  .compact .trackbar {
    flex: 1;
    min-width: 0;
  }

  .slider-row.disabled {
    color: var(--text-tertiary);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-8);
    padding-bottom: var(--space-3);
  }

  .readout {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .slider-row.disabled .readout {
    color: var(--text-tertiary);
  }

  .trackbar {
    position: relative;
  }

  .drag-value {
    position: absolute;
    z-index: var(--z-popover);
    top: calc(100% + var(--space-8));
    left: 50%;
    transform: translateX(-50%);
    padding: var(--space-3) var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    line-height: var(--line-height-tight);
    white-space: nowrap;
    pointer-events: none;
  }

  .ruler {
    position: relative;
    height: var(--space-7);
  }

  .tick {
    position: absolute;
    bottom: 0;
    width: var(--space-1);
    height: var(--space-3);
    background: var(--tick-mark);
    transform: translateX(-0.5px);
  }

  .tick.major {
    height: var(--space-6);
    background: var(--tick-mark-major);
  }

  .slider-row.disabled .tick,
  .slider-row.disabled .tick.major {
    background: var(--border);
  }
</style>
