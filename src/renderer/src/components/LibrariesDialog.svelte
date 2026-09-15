<script lang="ts">
  import { tick } from "svelte";

  import type { LibraryRecord, LibraryRowStatus } from "../lib/catalog.svelte";
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import {
    localDateToExclusiveNs,
    localDateToNs,
    type ThumbnailBackfillOptions,
  } from "../lib/job-params";
  import LibraryIndexing from "./LibraryIndexing.svelte";
  import ThumbnailFailures from "./ThumbnailFailures.svelte";

  let {
    libraries,
    selectedRoot,
    statuses,
    backendReady,
    jobRunning,
    onclose,
    onadd,
    onselect,
    onthumbnails,
    onremove,
    thumbnailFailures = [],
    onretrythumbnails,
  }: {
    libraries: LibraryRecord[];
    selectedRoot: string;
    statuses: ReadonlyMap<string, LibraryRowStatus>;
    backendReady: boolean;
    jobRunning: boolean;
    onclose: () => void;
    onadd: () => void;
    onselect: (root: string) => void;
    onthumbnails: (root: string, options: ThumbnailBackfillOptions) => void;
    onremove: (root: string, purge: boolean) => void;
    thumbnailFailures?: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
  } = $props();

  const bucketOptions = [128, 256, 512, 1024] as const;
  const selectedLibrary = $derived(libraries.find((library) => library.root === selectedRoot));
  let selectedBuckets = $state<number[]>([128, 256, 512, 1024]);
  let limitToRange = $state(false);
  let fromDate = $state("");
  let toDate = $state("");
  let removeTarget = $state<LibraryRecord | null>(null);
  let addFolderButton = $state<HTMLButtonElement | null>(null);
  let dialogHeading = $state<HTMLHeadingElement | null>(null);
  let removeTrigger: HTMLButtonElement | null = null;
  let removalHeading = $state<HTMLHeadingElement | null>(null);
  let removeOnlyButton = $state<HTMLButtonElement | null>(null);

  function statusSummary(status: LibraryRowStatus | undefined): string {
    if (!status) return "Index status is not available";
    if (status.loading) return "Loading library index status";
    if (status.error) return `Library index status error: ${status.error}`;
    return [
      `${status.cataloged.toLocaleString()} files`,
      `${status.indexed.toLocaleString()} with OCR text`,
      `${status.embedded.toLocaleString()} of ${status.indexed.toLocaleString()} OCR results embedded for meaning search`,
      `${status.pending.toLocaleString()} without a current meaning embedding`,
    ].join(", ");
  }

  function toggleBucket(bucket: number): void {
    selectedBuckets = selectedBuckets.includes(bucket)
      ? selectedBuckets.filter((value) => value !== bucket)
      : [...selectedBuckets, bucket].sort((left, right) => left - right);
  }

  function startBackfill(root: string): void {
    if (selectedBuckets.length === 0 || jobRunning || !backendReady) return;
    onthumbnails(root, {
      buckets: selectedBuckets,
      fromNs: limitToRange ? localDateToNs(fromDate) : undefined,
      toNs: limitToRange ? localDateToExclusiveNs(toDate) : undefined,
    });
  }

  async function requestRemoval(library: LibraryRecord, trigger: HTMLButtonElement): Promise<void> {
    removeTrigger = trigger;
    removeTarget = library;
    await tick();
    (removalHeading ?? removeOnlyButton)?.focus();
  }

  async function closeRemovalConfirmation(): Promise<void> {
    const focusTarget = removeTrigger;
    removeTarget = null;
    removeTrigger = null;
    await tick();

    if (focusTarget?.isConnected && !focusTarget.disabled) {
      focusTarget.focus();
    } else if (addFolderButton?.isConnected && !addFolderButton.disabled) {
      addFolderButton.focus();
    } else {
      dialogHeading?.focus();
    }
  }

  function handleRemovalKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    void closeRemovalConfirmation();
  }

  function removeLibrary(purge: boolean): void {
    if (!removeTarget || jobRunning) return;
    onremove(removeTarget.root, purge);
    void closeRemovalConfirmation();
  }
</script>

<section class="libraries-dialog" aria-labelledby="libraries-title">
  <header>
    <div>
      <h1 id="libraries-title" tabindex="-1" bind:this={dialogHeading}>Libraries</h1>
    </div>
    <button class="button" onclick={onclose}>Close</button>
  </header>

  <div class="library-toolbar">
    <button class="button" onclick={onadd} disabled={jobRunning} bind:this={addFolderButton}>
      Add folder…
    </button>
    {#if selectedLibrary}
      <div
        class="row-actions"
        role="group"
        aria-label={`Actions for ${selectedLibrary.displayName}`}
      >
        <button
          class="button danger-button"
          onclick={(event) => requestRemoval(selectedLibrary, event.currentTarget)}
          disabled={jobRunning}>Remove…</button
        >
      </div>
    {/if}
  </div>
  <p class="library-hint">
    {#if jobRunning}<span class="job-note">Library changes are unavailable while a job runs.</span
      >{:else}Select a library to browse or manage it.{/if}
  </p>

  {#if selectedLibrary}
    <LibraryIndexing root={selectedLibrary.root}>
      <section
        class="thumbnail-options"
        aria-label={`Thumbnail options for ${selectedLibrary.displayName}`}
      >
        <h2>Thumbnails</h2>
        <p>Thumbnails are generated on demand. Pre-generate only if you need them.</p>
        <div class="bucket-row">
          {#each bucketOptions as bucket (bucket)}
            <label class="bucket-option">
              <input
                type="checkbox"
                checked={selectedBuckets.includes(bucket)}
                onchange={() => toggleBucket(bucket)}
                disabled={jobRunning}
              />
              {bucket}px
            </label>
          {/each}
          <label class="range-toggle">
            <input type="checkbox" bind:checked={limitToRange} disabled={jobRunning} />
            Date range
          </label>
        </div>
        {#if limitToRange}
          <div class="range-row">
            <label>From <input type="date" bind:value={fromDate} disabled={jobRunning} /></label>
            <label>To <input type="date" bind:value={toDate} disabled={jobRunning} /></label>
          </div>
        {/if}
        <div class="thumbnail-actions">
          <button
            class="button"
            onclick={() => startBackfill(selectedLibrary.root)}
            disabled={!backendReady || jobRunning || selectedBuckets.length === 0}
          >
            Generate
          </button>
        </div>
      </section>
    </LibraryIndexing>
    <ThumbnailFailures failures={thumbnailFailures} onretry={onretrythumbnails} />
  {/if}

  <div class="list-heading" aria-hidden="true">
    <span>Library</span><span>Files</span><span>OCR</span><span>Text embeddings</span>
  </div>
  <ul class="library-list" aria-label="Libraries">
    {#each libraries as library (library.root)}
      {@const isSelected = library.root === selectedRoot}
      {@const status = statuses.get(library.root)}
      <li class:selected={isSelected} class="library-row">
        <button
          class="library-select"
          aria-pressed={isSelected}
          aria-label={`Select ${library.displayName}`}
          onclick={() => {
            removeTarget = null;
            onselect(library.root);
          }}
          disabled={jobRunning}
        >
          <svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 4.25h5l1.25 1.5h6.75v6.5H1.5z" />
            <path d="M1.5 4.25V2.75h4.6l1.25 1.5" />
          </svg>
          <span class="library-details">
            <strong>{library.displayName}</strong>
            <span class="library-path" title={library.root}>{library.root}</span>
          </span>
        </button>
        <div
          class:error={Boolean(status?.error)}
          class="library-status"
          role="status"
          aria-label={statusSummary(status)}
          title={statusSummary(status)}
        >
          {#if !status || status.loading}
            <span class="status-message">Loading index status…</span>
          {:else if status.error}
            <span class="status-message" title={status.error}>Status unavailable</span>
          {:else}
            <dl class="status-metrics">
              <div>
                <dt>Files</dt>
                <dd>{status.cataloged.toLocaleString()}</dd>
              </div>
              <div>
                <dt>OCR</dt>
                <dd>
                  {status.indexed.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Text embeddings</dt>
                <dd>
                  {status.embedded.toLocaleString()}
                </dd>
              </div>
            </dl>
          {/if}
        </div>
      </li>
    {:else}
      <li class="empty-state">Add an image folder to create your first library.</li>
    {/each}
  </ul>

  {#if removeTarget}
    <div
      class="remove-confirmation"
      role="alertdialog"
      tabindex="-1"
      aria-labelledby="remove-library-title"
      aria-describedby="remove-library-description"
      onkeydown={handleRemovalKeydown}
    >
      <h2 id="remove-library-title" tabindex="-1" bind:this={removalHeading}>
        Remove “{removeTarget.displayName}”?
      </h2>
      <p id="remove-library-description">
        Remove only keeps its indexed data. Removing indexed data cannot be undone.
      </p>
      <div class="confirmation-actions">
        <button
          class="button"
          onclick={() => removeLibrary(false)}
          disabled={jobRunning}
          bind:this={removeOnlyButton}
        >
          Remove only
        </button>
        <button
          class="button danger-button"
          onclick={() => removeLibrary(true)}
          disabled={!backendReady || jobRunning}
        >
          Remove and delete indexed data
        </button>
        <button class="button" onclick={() => void closeRemovalConfirmation()}>Cancel</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .thumbnail-options h2 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  .libraries-dialog {
    --metric-columns: 75px 75px 115px;
    box-sizing: border-box;
    width: 100%;
    max-height: min(var(--dialog-max-height), 100%);
    overflow: auto;
    padding: var(--space-12);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  header {
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
  }
  .thumbnail-options p,
  .remove-confirmation p {
    margin-top: var(--space-4);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
  }
  .library-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-10) 0 var(--space-7);
    flex-wrap: wrap;
  }
  .library-hint {
    margin: 0 0 var(--space-8);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .list-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--metric-columns);
    padding: var(--space-5) var(--space-9);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .list-heading span:not(:first-child) {
    text-align: right;
  }
  .job-note {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .library-list {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-top: 0;
  }
  .library-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 265px;
    padding-right: var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-1);
  }
  .library-row.selected {
    background: var(--surface-hover);
    box-shadow: inset var(--space-3) 0 0 var(--accent);
  }
  .library-select {
    display: flex;
    min-width: 0;
    padding: var(--space-8) var(--space-9);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .library-select:disabled {
    cursor: default;
  }
  .library-details {
    display: grid;
    min-width: 0;
    gap: var(--space-2);
  }
  .folder-icon {
    flex: 0 0 auto;
    width: var(--space-14);
    height: var(--space-14);
    margin: var(--space-1) var(--space-7) 0 0;
    fill: var(--text-secondary);
    stroke: var(--text-primary);
    stroke-linejoin: round;
    stroke-width: 1;
  }
  .library-details strong,
  h2 {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .library-path {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .library-status {
    display: flex;
    min-height: 34px;
    align-items: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .library-status.error {
    color: var(--danger);
  }
  .status-message {
    overflow: hidden;
    padding: 0 var(--space-9);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-metrics {
    display: grid;
    width: 100%;
    grid-template-columns: var(--metric-columns);
    margin: 0;
  }
  .status-metrics > div {
    display: block;
    min-width: 0;
    align-items: baseline;
    gap: var(--space-4);
    text-align: right;
  }
  .status-metrics dt {
    display: none;
  }
  .status-metrics dd {
    min-width: 0;
    margin: 0;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    padding-left: var(--space-8);
    border-left: 1px solid var(--border);
  }
  .thumbnail-options {
    grid-column: 1 / -1;
    padding-top: var(--space-7);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-0);
  }
  .bucket-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-7);
    margin-top: var(--space-7);
  }
  .thumbnail-actions,
  .confirmation-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
    margin-top: var(--space-7);
  }
  .bucket-option,
  .range-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .range-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-7);
    margin-top: var(--space-6);
  }
  .range-row label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-5);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .range-row input[type="date"] {
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
  }
  input[type="checkbox"] {
    width: var(--space-14);
    height: var(--space-14);
    accent-color: var(--accent);
  }
  .remove-confirmation {
    margin-top: var(--space-10);
    padding: var(--space-9);
    border: 1px solid var(--border-strong);
    background: var(--surface-1);
  }
  .remove-confirmation h2 {
    font-size: var(--font-size-md);
  }
  .empty-state {
    padding: var(--space-12) var(--space-9);
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
  .button:hover:not(:disabled) {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
  }
  .danger-button {
    color: var(--danger);
  }
  .danger-button:hover:not(:disabled) {
    border-color: var(--danger);
  }
  .button:focus-visible,
  .library-select:focus-visible,
  input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .button:disabled {
    color: var(--text-tertiary);
    opacity: 0.65;
    cursor: default;
  }
  @media (width < 40rem) {
    .list-heading {
      display: none;
    }
    .library-list {
      border-top: 1px solid var(--border);
    }
    .library-row {
      grid-template-columns: 1fr;
    }
    .row-actions {
      padding-left: 0;
      border-left: 0;
    }
    .library-status {
      padding: 0 var(--space-9) var(--space-8);
    }
    .status-metrics > div {
      display: flex;
      gap: var(--space-4);
    }
    .status-metrics {
      grid-template-columns: auto auto auto;
      gap: var(--space-8);
    }
    .status-metrics dt {
      display: block;
    }
  }
</style>
