<script lang="ts">
  import type { Snippet } from "svelte";

  import { useApplication } from "../lib/application.svelte";
  import { rootsMatch } from "../lib/catalog.svelte";
  import { cleanDiagnostic } from "../lib/errors";
  import { summarizeCompletion } from "../lib/job-format";
  import { libraryIndexing, setLibraryIndexing, settings } from "../lib/settings.svelte";
  import JobProgress from "./JobProgress.svelte";

  let { root, children }: { root: string; children?: Snippet } = $props();
  const { services, commands } = useApplication();
  const { jobs, orchestrator, catalog } = services;
  const selection = $derived(libraryIndexing($settings, root));
  const hintId = $props.id();
  const busy = $derived(jobs.running || orchestrator.indexing);
  const ownsIndex = $derived(
    Boolean(orchestrator.indexRoot && rootsMatch(root, orchestrator.indexRoot)),
  );
  const ownsJob = $derived(Boolean(jobs.root && rootsMatch(root, jobs.root)));
  const job = $derived(ownsJob || (ownsIndex && orchestrator.indexing) ? jobs.active : null);
  const restarting = $derived(ownsIndex && orchestrator.restartingIndex);
  const error = $derived((ownsJob || ownsIndex ? jobs.error : "") || catalog.backendStatus.error);
  const diagnostic = $derived(
    cleanDiagnostic(
      [
        error,
        job?.error,
        ...(job?.errors.map((failure) => `${failure.path ?? ""}\n${failure.message}`) ?? []),
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  );
  let copyStatus = $state("");

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostic);
      copyStatus = "Copied";
    } catch {
      copyStatus = "Select the details and copy them manually.";
    }
  }
</script>

<section class="indexing" aria-label="Library search">
  <div class="index-actions">
    <strong>Search indexing</strong>
    <button
      class="ui-button"
      disabled={!catalog.backendStatus.ready || busy || (!selection.ocr && !selection.image)}
      onclick={() => commands.startIndex(root)}>Index</button
    >
    {#if busy && (ownsJob || ownsIndex)}
      <button
        class="ui-button"
        onclick={() => orchestrator.cancel()}
        disabled={jobs.active?.status === "cancelling"}>Stop</button
      >
    {/if}
  </div>
  <div class="index-options" role="group" aria-label="Search types for this library">
    <label
      ><input
        type="checkbox"
        checked={selection.image}
        onchange={(event) =>
          setLibraryIndexing(root, { ...selection, image: event.currentTarget.checked })}
        disabled={busy}
      /> Image search</label
    >
    <div class="text-recognition-option">
      <label
        ><input
          type="checkbox"
          checked={selection.ocr}
          aria-describedby={hintId}
          onchange={(event) =>
            setLibraryIndexing(root, { ...selection, ocr: event.currentTarget.checked })}
          disabled={busy}
        /> Include text recognition</label
      >
      <p id={hintId}>10x slower than image search indexing, but good for precise text searches</p>
    </div>
  </div>
  <p>Choices are saved for this library.</p>
  <p>
    Index new and changed pictures. The first run downloads models; pictures stay on your computer.
  </p>
  {#if restarting}
    <p role="status">Switching to CPU… Indexing will continue automatically.</p>
  {:else if job}
    {#if jobs.running}
      <JobProgress {job} />
    {:else if job.status === "completed" && !orchestrator.indexing}
      <p role="status">
        {summarizeCompletion(job, true)}{job.errors.length ? " · Some files need attention." : ""}
      </p>
    {:else if job.status === "cancelled"}
      <p role="status">Stopped. Completed work is retained.</p>
    {:else if job.status === "failed"}
      <p role="status">Indexing could not finish. Review the details, then try again.</p>
    {/if}
  {:else if ownsIndex && orchestrator.indexing}
    <p role="status">Starting indexing…</p>
  {/if}
  {#if jobs.active?.status === "cancelling" && (ownsJob || ownsIndex)}
    <p>Stopping after the current download or model operation finishes…</p>
  {/if}
  {#if diagnostic}
    <details class="diagnostics">
      <summary>Indexing error details</summary>
      <textarea aria-label="Indexing error details" readonly value={diagnostic}></textarea>
      <button class="ui-button" onclick={copyDetails}>Copy details</button>
      <span role="status">{copyStatus}</span>
    </details>
  {/if}
  <details>
    <summary>Advanced options</summary>
    <div class="advanced">
      <div>
        <button
          class="ui-button"
          disabled={!catalog.backendStatus.ready || busy || (!selection.ocr && !selection.image)}
          onclick={() => commands.startIndex(root, true)}>Retry failed files</button
        >
        <p>Retry previously failed and excluded files</p>
      </div>
      {@render children?.()}
    </div>
  </details>
</section>

<style>
  .indexing {
    display: grid;
    gap: var(--space-6);
    min-width: 0;
    padding-block: var(--space-8);
    border-block: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .index-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-6);
  }
  .index-options label {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-6);
  }
  .index-options {
    display: grid;
    gap: var(--space-6);
  }
  .text-recognition-option {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    row-gap: var(--space-3);
  }
  .text-recognition-option label {
    grid-column: 1 / -1;
  }
  .text-recognition-option p {
    grid-column: 2;
  }
  .index-actions strong {
    margin-right: auto;
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
  }
  .advanced {
    display: grid;
    gap: var(--space-8);
    padding-top: var(--space-6);
  }
  .advanced p {
    margin-top: var(--space-4);
  }
  textarea {
    display: block;
    width: 100%;
    height: min(180px, 30vh);
    margin-block: var(--space-6);
    resize: none;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }
</style>
