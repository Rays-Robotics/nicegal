<script lang="ts">
  import { onMount } from "svelte";

  import type { SearchModelsResponse, SearchModelStatus } from "../../../shared/backend";

  import { useApplication } from "../lib/application.svelte";
  import { cleanDiagnostic } from "../lib/errors";
  import { jobLabel, jobPhaseProgress } from "../lib/job-format";

  const { services } = useApplication();
  const { runtime, jobs, orchestrator, catalog } = services;
  const names: { key: keyof SearchModelsResponse; label: string }[] = [
    { key: "text", label: "Text meaning" },
    { key: "clipImage", label: "CLIP image indexing" },
    { key: "clipText", label: "CLIP text search" },
  ];
  const labels: Record<SearchModelStatus["state"], string> = {
    notLoaded: "Not loaded this session",
    preparing: "Downloading or loading…",
    ready: "Ready",
    failed: "Preparation failed",
  };
  const setupJob = $derived(
    jobs.active && (jobs.active.type === "modelPrepare" || jobs.active.type === "ocrModelLoad")
      ? jobs.active
      : null,
  );
  const settingUp = $derived(
    orchestrator.preparingSearchModels || Boolean(setupJob && jobs.running),
  );
  const ready = $derived(
    runtime.ocrLoaded &&
      runtime.models &&
      Object.values(runtime.models).every((model) => model.state === "ready"),
  );
  const failed = $derived(
    Boolean(
      runtime.modelError ||
      jobs.error ||
      setupJob?.status === "failed" ||
      (runtime.models && Object.values(runtime.models).some((model) => model.state === "failed")),
    ),
  );
  const stopped = $derived(!settingUp && setupJob?.status === "cancelled");
  onMount(() => {
    void runtime.refreshModels();
    const poll = setInterval(() => {
      if (catalog.backendStatus.ready) void runtime.refreshModels();
    }, 2000);
    return () => clearInterval(poll);
  });
</script>

<section aria-labelledby="search-models-title" class="model-section">
  <h2 id="search-models-title">Search setup</h2>
  <p>
    Find words, meaning and similar pictures. Indexing sets this up automatically, or you can do it
    here.
  </p>
  <p class="setup-status" role="status">
    {#if settingUp}Setting up search…{:else if ready}Search is ready{:else if failed}Search setup
      needs attention{:else if stopped}Setup stopped{:else}Search models load when needed{/if}
  </p>
  {#if settingUp && setupJob}<p>{jobLabel(setupJob)} {jobPhaseProgress(setupJob).text}</p>{/if}
  {#if setupJob?.status === "cancelling"}<p>
      Stopping after the current download or model finishes. Completed downloads will be kept.
    </p>{/if}
  {#if failed}<p>
      Setup could not finish. Review model details below, check your connection and disk space, then
      try again.
    </p>{/if}
  <div class="model-actions">
    {#if settingUp}
      <button
        class="ui-button"
        disabled={!jobs.running || setupJob?.status === "cancelling"}
        onclick={() => orchestrator.cancel()}>Stop setup</button
      >
    {:else if !ready}
      <button
        class="ui-button"
        disabled={jobs.running || !catalog.backendStatus.ready}
        onclick={() => orchestrator.prepareSearchModels()}
        >{failed ? "Try setup again" : stopped ? "Continue setup" : "Set up search"}</button
      >
    {/if}
  </div>
  <p>
    First-time setup downloads search models and may take a few minutes. Downloaded files are
    reused. Your pictures stay on this computer.
  </p>
  <details open={failed}>
    <summary>Model details</summary>
    <dl>
      <div>
        <dt>OCR text recognition</dt>
        <dd>{runtime.ocrLoaded ? "Ready" : "Not loaded this session"}</dd>
      </div>
      {#each names as model (model.key)}
        {@const status = runtime.models?.[model.key]}
        <div>
          <dt>{model.label}</dt>
          <dd>{status ? labels[status.state] : "Status unavailable"}</dd>
        </div>
        {#if status?.error}<div class="model-error" role="alert">
            {cleanDiagnostic(status.error)}
          </div>{/if}
      {/each}
    </dl>
    {#if runtime.modelError}<p class="model-error" role="alert">{runtime.modelError}</p>{/if}
    {#if jobs.active && (jobs.active.type === "modelPrepare" || jobs.active.type === "ocrModelLoad")}
      {#if jobs.active.error}<p class="model-error" role="alert">
          {cleanDiagnostic(jobs.active.error)}
        </p>{/if}
      {#if jobs.active.status === "cancelled"}<p>
          Preparation cancelled. You can retry; completed downloads remain cached.
        </p>{/if}
    {/if}
    {#if jobs.error}<p class="model-error" role="alert">{jobs.error}</p>{/if}
  </details>
</section>

<style>
  .model-section {
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  h2 {
    margin: 0;
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--font-size-md);
  }
  p,
  dl,
  .model-actions {
    margin: var(--space-8) var(--space-9);
  }
  details {
    margin: var(--space-8) var(--space-9);
  }
  summary {
    cursor: pointer;
  }
  .setup-status {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  p {
    color: var(--text-secondary);
    line-height: var(--line-height-normal);
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-3) 0;
  }
  dd {
    margin: 0;
  }
  .model-error {
    color: var(--danger);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 140px;
    overflow: auto;
    user-select: text;
  }
  .model-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
  }
</style>
