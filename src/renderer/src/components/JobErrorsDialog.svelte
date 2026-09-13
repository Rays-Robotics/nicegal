<script lang="ts">
  import type { JobSnapshot } from "../../../shared/backend";

  import Modal from "./Modal.svelte";

  let { errors, onclose }: { errors: JobSnapshot["errors"]; onclose: () => void } = $props();
  let selectedIndex = $state(0);
  const selected = $derived(errors[Math.min(selectedIndex, errors.length - 1)]);

  function fileName(path: string | null | undefined): string {
    return path?.split(/[\\/]/).pop() || "Job error";
  }
</script>

<Modal labelledby="job-errors-title" {onclose}>
  <section class="error-dialog">
    <header>
      <h1 id="job-errors-title">Reported errors <span>({errors.length.toLocaleString()})</span></h1>
      <button onclick={onclose}>Close</button>
    </header>
    <p>Select a file to see the full error. Closing this window keeps the job summary.</p>
    <div class="error-browser">
      <nav aria-label="Reported errors">
        {#each errors as error, index (index)}
          <button
            class:selected={selectedIndex === index}
            aria-current={selectedIndex === index ? "true" : undefined}
            title={error.path || error.message}
            onclick={() => (selectedIndex = index)}
          >
            <span class="error-number">{index + 1}</span>
            <span class="file-name">{fileName(error.path)}</span>
          </button>
        {/each}
      </nav>
      <section class="error-detail" aria-label="Selected error" aria-live="polite">
        {#if selected}
          <h2>{fileName(selected.path)}</h2>
          {#if selected.path}<p class="path">{selected.path}</p>{/if}
          <h3>Error details</h3>
          <p class="message">{selected.message}</p>
        {/if}
      </section>
    </div>
  </section>
</Modal>

<style>
  .error-dialog {
    padding: var(--space-12);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  h1 {
    font-size: var(--dialog-title-size);
  }
  h1 span,
  .path,
  .error-number {
    color: var(--text-secondary);
  }
  .error-dialog > p {
    margin: var(--space-8) 0;
    color: var(--text-secondary);
  }
  button {
    font: inherit;
    color: var(--text-primary);
    cursor: pointer;
  }
  header button {
    height: var(--control-height);
    padding: 0 var(--space-9);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
  }
  .error-browser {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
    height: min(340px, 55dvh);
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  nav {
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  nav button {
    display: flex;
    width: 100%;
    gap: var(--space-8);
    padding: var(--space-7);
    border: 0;
    border-bottom: 1px solid var(--border-subtle);
    background: transparent;
    text-align: left;
  }
  nav button:hover {
    background: var(--surface-hover);
  }
  nav button.selected {
    background: var(--surface-hover);
    box-shadow: inset 3px 0 var(--accent);
  }
  .error-number {
    flex: none;
    min-width: 2ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error-detail {
    min-width: 0;
    overflow: auto;
    padding: var(--space-12);
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: var(--font-size-md);
  }
  .path {
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
  }
  h3 {
    margin: var(--space-12) 0 var(--space-5);
    font-size: var(--font-size-sm);
  }
  .message {
    white-space: pre-wrap;
    user-select: text;
  }
  .path {
    user-select: text;
  }
  button:focus-visible,
  .error-detail:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
  }
  @media (width < 40rem) {
    .error-browser {
      grid-template-columns: 1fr;
      grid-template-rows: 40% minmax(0, 1fr);
      height: 55dvh;
    }
    nav {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
