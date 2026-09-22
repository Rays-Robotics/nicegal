<!--
  @component
  A win32 segmented control: one bordered group of flush buttons where the current choice reads as
  held down. The pressed segment gets the button face's active gradient and the sunken bevel, so
  it looks pushed into the group rather than merely tinted — the same construction as the toolbar
  buttons in `App.svelte`, laid out as one strip instead of separate keys.

  Height comes from `--segment-height`, which the caller sets: the status bar needs a control that
  fits inside 22px of chrome, the search options strip wants full `--control-height`.
-->
<script lang="ts" generics="Value extends string">
  let {
    value = $bindable(),
    options,
    label,
    disabled = false,
  }: {
    value: Value;
    options: ReadonlyArray<{ value: Value; label: string; title?: string }>;
    /** Names the group for screen readers; there is no visible legend. */
    label: string;
    disabled?: boolean;
  } = $props();
</script>

<div class="segmented" class:disabled role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={option.value === value}
      title={option.title}
      {disabled}
      onclick={() => (value = option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    flex: none;
    height: var(--segment-height, var(--control-height));
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-secondary);
  }

  .segmented button {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-7);
    border: 0;
    /* Segments share one edge rather than each drawing a full border, which is what makes the
       group read as one control. */
    border-left: 1px solid var(--btn-border);
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .segmented button:first-child {
    border-left: 0;
  }

  .segmented button:hover:not(:disabled):not([aria-checked="true"]) {
    background: var(--btn-face-hover);
    color: var(--text-primary);
  }

  /* The accent border is what marks a control as chosen everywhere else in the app (see the
     toggle rows in SettingsPanel), and in themes whose pressed face is barely darker than the
     resting one it is doing most of the work. Segments share edges, so the segment after a
     selected one has to accent the edge it owns. */
  .segmented button[aria-checked="true"] {
    border-left-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }

  .segmented button[aria-checked="true"] + button {
    border-left-color: var(--btn-border-active);
  }

  .segmented.disabled {
    border-color: var(--border);
    color: var(--text-tertiary);
    opacity: 0.65;
  }

  .segmented button:disabled {
    border-left-color: var(--border);
    cursor: default;
  }

  .segmented button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
