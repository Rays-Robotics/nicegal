<script lang="ts">
  import { onMount } from "svelte";

  import type { ExecutionProviderId } from "../../../shared/backend";
  import type { UpdatePreferences } from "../../../shared/updates";
  import type { RuntimeController } from "../lib/runtime.svelte";

  import { useApplication } from "../lib/application.svelte";
  import { settings, settingsLimits, type GalleryTheme } from "../lib/settings.svelte";
  import AboutSettings from "./AboutSettings.svelte";
  import SearchModels from "./SearchModels.svelte";
  import SliderRow from "./SliderRow.svelte";

  let {
    runtime,
    onclose,
    onshowintro,
    page = $bindable<"gallery" | "search" | "about">("gallery"),
  }: {
    runtime: RuntimeController;
    onclose: () => void;
    onshowintro: () => void;
    page?: "gallery" | "search" | "about";
  } = $props();

  const themes: { id: GalleryTheme; label: string }[] = [
    { id: "seven-a", label: "very" },
    { id: "seven-b", label: "Hospital" },
  ];
  const { catalog } = useApplication().services;
  let updatePreferences = $state<UpdatePreferences | null>(null);
  let updateSaving = $state(false);
  let updateError = $state<string | null>(null);
  onMount(() => {
    let disposed = false;
    void window.nicegal.updates
      .getPreferences()
      .then((value) => {
        if (!disposed) updatePreferences = value;
      })
      .catch((error: unknown) => {
        if (!disposed) updateError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      disposed = true;
    };
  });

  async function setAutomaticUpdates(
    event: Event & { currentTarget: HTMLInputElement },
  ): Promise<void> {
    const checkbox = event.currentTarget;
    updateSaving = true;
    updateError = null;
    try {
      updatePreferences = await window.nicegal.updates.setEnabled(checkbox.checked);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    } finally {
      checkbox.checked = updatePreferences?.enabled ?? false;
      updateSaving = false;
    }
  }

  const isLinux = navigator.userAgent.includes("Linux");
  const executionProviders: { id: ExecutionProviderId; label: string }[] = [
    { id: "directml", label: "DirectML" },
    { id: "openvino", label: "OpenVINO (CPU)" },
    { id: "cpu", label: "Legacy" },
  ];

  async function setExecutionProvider(id: ExecutionProviderId): Promise<void> {
    await runtime.setExecutionProvider(id);
  }
</script>

<section class="settings-panel" aria-labelledby="settings-title">
  <header>
    <div>
      <h1 id="settings-title">Settings</h1>
    </div>
    <button class="close-button" onclick={onclose}>Close</button>
  </header>

  <nav class="settings-pages" aria-label="Settings pages">
    <button class="ui-button" aria-pressed={page === "gallery"} onclick={() => (page = "gallery")}
      >Gallery</button
    >
    <button class="ui-button" aria-pressed={page === "search"} onclick={() => (page = "search")}
      >Search</button
    >
    <button class="ui-button" aria-pressed={page === "about"} onclick={() => (page = "about")}
      >About</button
    >
  </nav>
  {#if !catalog.backendStatus.ready && catalog.backendStatus.error}
    <div class="settings-error" role="alert">
      The gallery service is unavailable.
      <button class="ui-button" onclick={onclose}>Show error details</button>
    </div>
  {/if}
  <div class="settings-groups">
    {#if page === "gallery"}
      <section class="settings-group" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance</h2>
        <div class="row segmented-row">
          <span>Theme</span>
          <div class="segmented" aria-label="Theme">
            {#each themes as theme (theme.id)}
              <button
                class={{ active: $settings.theme === theme.id }}
                aria-pressed={$settings.theme === theme.id}
                onclick={() => ($settings.theme = theme.id)}>{theme.label}</button
              >
            {/each}
          </div>
        </div>
        <label class="row"
          ><span>Play animated GIFs in the grid</span><input
            type="checkbox"
            bind:checked={$settings.playAnimatedPreviews}
          /></label
        >
      </section>

      <section class="settings-group" aria-labelledby="layout-title">
        <h2 id="layout-title">Layout</h2>
        {#if $settings.layoutMode === "justified"}
          <SliderRow
            label="Row height"
            bind:value={$settings.targetRowHeight}
            {...settingsLimits.targetRowHeight}
          />
        {:else if $settings.layoutMode === "masonry"}
          <SliderRow
            label="Column width"
            bind:value={$settings.masonryColumnWidth}
            {...settingsLimits.masonryColumnWidth}
          />
        {:else}
          <label class="row"
            ><span>Columns</span><input
              class="number-input"
              type="number"
              title="0 = auto"
              min={settingsLimits.gridColumns.min}
              max={settingsLimits.gridColumns.max}
              step={settingsLimits.gridColumns.step}
              bind:value={$settings.gridColumns}
            /></label
          >
          <SliderRow
            label="Cell size"
            title="Used when columns is 0 (auto)"
            disabled={$settings.gridColumns > 0}
            bind:value={$settings.gridCellWidth}
            {...settingsLimits.gridCellWidth}
          />
        {/if}
        <label class="row"
          ><span>Gap</span><input
            class="number-input"
            type="number"
            min={settingsLimits.gap.min}
            max={settingsLimits.gap.max}
            step={settingsLimits.gap.step}
            bind:value={$settings.gap}
          /></label
        >
      </section>
      <section class="settings-group" aria-labelledby="updates-title">
        <h2 id="updates-title">Updates</h2>
        <label class="row">
          <span class="setting-label"
            >Automatic updates</span
          >
          <input
            type="checkbox"
            checked={updatePreferences?.enabled ?? false}
            disabled={!updatePreferences || updateSaving}
            onchange={setAutomaticUpdates}
          />
        </label>
        {#if updatePreferences && !updatePreferences.supported}
          <p class="update-build-note">This build uses manual updates.</p>
        {/if}
        {#if updateError}<p class="settings-error" role="alert">{updateError}</p>{/if}
      </section>
    {:else if page === "about"}
      <AboutSettings />
    {:else}
      <SearchModels />
      <details class="settings-group advanced-settings" open={Boolean(runtime.error)}>
        <summary>Advanced search settings</summary>
        <div class="row segmented-row">
          <span class="setting-label"
            >Execution provider<small
              >{runtime.status?.restartRequired
                ? "Restart the app to apply."
                : isLinux
                  ? "OpenVINO (CPU) is the default. Leave this unless indexing fails."
                  : "DirectML is the default. Leave this unless indexing fails."}</small
            ></span
          >
          <div class="segmented" aria-label="Execution provider">
            {#each executionProviders.filter((provider) => !isLinux || provider.id !== "directml") as provider (provider.id)}
              <button
                class={{ active: runtime.status?.configuredExecutionProvider === provider.id }}
                aria-pressed={runtime.status?.configuredExecutionProvider === provider.id}
                disabled={runtime.loading || runtime.saving}
                onclick={() => setExecutionProvider(provider.id)}>{provider.label}</button
              >
            {/each}
          </div>
        </div>
        {#if runtime.error}
          <p class="settings-error" role="alert">{runtime.error}</p>
        {/if}
        <label class="row">
          <span class="setting-label"
            >Index limit (debug)<small>0 indexes the complete library.</small></span
          ><input
            class="number-input"
            type="number"
            title="0 = no limit"
            min={settingsLimits.debugIndexLimit.min}
            max={settingsLimits.debugIndexLimit.max}
            step={settingsLimits.debugIndexLimit.step}
            bind:value={$settings.debugIndexLimit}
          />
        </label>
      </details>
    {/if}
  </div>
  <footer class="settings-help">
    <span>New to Nicegal?</span>
    <button class="ui-button" onclick={onshowintro}>Getting started</button>
  </footer>
</section>

<style>
  .update-build-note {
    padding: 0 var(--space-9) var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .settings-panel {
    display: flex;
    width: 100%;
    max-width: var(--dialog-width);
    max-height: min(var(--dialog-max-height), calc(100vh - (var(--space-16) * 2)));
    flex-direction: column;
    padding: var(--space-16);
    overflow: hidden;
  }
  .settings-pages {
    display: flex;
    flex: none;
    gap: var(--space-4);
    padding-top: var(--space-10);
  }
  .settings-help {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    margin-top: var(--space-12);
    padding-top: var(--space-10);
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
  }
  .settings-pages button[aria-pressed="true"] {
    background: var(--btn-face-active);
    border-color: var(--btn-border-active);
    box-shadow: var(--bevel-sunken);
  }
  header {
    flex: none;
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-12);
    padding-bottom: var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    color: var(--text-primary);
    font-size: var(--dialog-title-size);
    font-weight: var(--font-weight-semibold);
  }
  .settings-groups {
    display: grid;
    min-height: 0;
    gap: var(--space-14);
    padding-top: var(--space-14);
    overflow: auto;
  }
  .settings-group {
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  .advanced-settings {
    color: var(--text-primary);
  }
  .advanced-settings summary {
    display: flex;
    min-height: 32px;
    align-items: center;
    padding: var(--space-7) var(--space-9);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .advanced-settings summary::marker {
    color: var(--text-secondary);
  }
  h2 {
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-height: var(--control-height);
    padding: var(--space-5) var(--space-9);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .setting-label {
    display: grid;
    gap: var(--space-2);
  }
  .setting-label small {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .settings-error {
    margin: 0;
    padding: var(--space-5) var(--space-9);
  }
  .settings-error {
    border-top: 1px solid var(--border-subtle);
    color: var(--danger);
    font-size: var(--font-size-sm);
  }

  input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
  }
  .number-input {
    width: 64px;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
  }
  .segmented {
    display: flex;
    gap: var(--space-3);
  }
  .segmented button {
    padding: var(--space-2) var(--space-8);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .segmented button:hover:not(:disabled) {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
  }
  .segmented button.active {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }
  .segmented button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .advanced-settings summary:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .close-button {
    height: var(--control-height);
    padding: 0 var(--space-9);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-primary);
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .close-button:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
  }
  input:focus-visible,
  .segmented button:focus-visible,
  .close-button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
