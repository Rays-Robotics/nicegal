<script lang="ts">
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { errorMessage } from "../lib/errors";

  let {
    failures,
    onretry,
  }: {
    failures: readonly (ThumbnailFailure & { name?: string })[];
    onretry: () => void;
  } = $props();
  let showDetails = $state(false);
  let copyStatus = $state("");
  const diagnostic = $derived(
    failures
      .map(
        (failure) =>
          `${failure.name || failure.assetId}\nAsset: ${failure.assetId}\nAttempts: ${failure.attempts}\n${errorMessage(failure.error)}`,
      )
      .join("\n\n"),
  );

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostic);
      copyStatus = "Copied";
    } catch {
      copyStatus = "Select the details and copy them manually.";
    }
  }

  function retry(): void {
    showDetails = false;
    onretry();
  }
</script>

{#if failures.length}
  <details class="thumbnail-diagnostics" bind:open={showDetails}>
    <summary
      >{failures.length} {failures.length === 1 ? "thumbnail" : "thumbnails"} unavailable</summary
    >
    <div class="thumbnail-details">
      <p>
        Automatic retries stopped. Check that the files are accessible, then retry. You can still
        try opening an image.
      </p>
      <textarea readonly aria-label="Thumbnail error details" value={diagnostic}></textarea>
      <span role="status">{copyStatus}</span>
      <div class="actions">
        <button class="ui-button" type="button" onclick={copyDetails}>Copy details</button>
        <button class="ui-button" type="button" onclick={retry} disabled={!failures.length}
          >Retry thumbnails</button
        >
        <button
          class="ui-button"
          type="button"
          onclick={(event) => {
            showDetails = false;
            event.currentTarget.closest("details")?.querySelector("summary")?.focus();
          }}>Dismiss</button
        >
      </div>
    </div>
  </details>
{/if}

<style>
  .thumbnail-diagnostics {
    padding-block: var(--space-8);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  summary {
    cursor: pointer;
  }
  summary:focus-visible {
    outline: var(--focus-ring);
  }
  .thumbnail-details {
    display: grid;
    gap: var(--space-6);
    padding-top: var(--space-6);
    font-size: var(--font-size-md);
  }
  p {
    margin: 0;
  }
  textarea {
    width: 100%;
    min-width: 0;
    height: min(220px, 30vh);
    resize: none;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-6);
  }
</style>
