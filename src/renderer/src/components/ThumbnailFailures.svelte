<script lang="ts">
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { errorMessage } from "../lib/errors";
  import Modal from "./Modal.svelte";

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
  <div class="thumbnail-notice">
    <span role="status"
      >{failures.length} {failures.length === 1 ? "thumbnail" : "thumbnails"} unavailable</span
    >
    <button class="ui-button" type="button" onclick={retry}>Retry thumbnails</button>
    <button
      class="ui-button"
      type="button"
      onclick={() => {
        copyStatus = "";
        showDetails = true;
      }}>Details</button
    >
  </div>
{/if}

{#if showDetails}
  <Modal labelledby="thumbnail-failure-title" onclose={() => (showDetails = false)}>
    <div class="thumbnail-details">
      <h2 id="thumbnail-failure-title">Thumbnails unavailable</h2>
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
        <button class="ui-button" type="button" onclick={() => (showDetails = false)}>Close</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .thumbnail-notice {
    position: absolute;
    top: var(--space-6);
    left: var(--space-6);
    right: var(--space-16);
    z-index: var(--z-raised);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-4) var(--space-6);
    border: 1px solid var(--border);
    background: var(--surface-0);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    box-shadow: var(--shadow-overlay);
  }
  .thumbnail-notice span {
    flex: 1;
  }
  .thumbnail-details {
    display: grid;
    gap: var(--space-6);
    padding: var(--space-12);
    background: var(--surface-0);
    border: 1px solid var(--border);
    font-size: var(--font-size-md);
  }
  h2,
  p {
    margin: 0;
  }
  h2 {
    font-size: var(--font-size-md);
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
