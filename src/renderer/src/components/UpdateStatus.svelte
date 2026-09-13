<script lang="ts">
  import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";

  import type { UpdateStatus } from "../../../shared/updates";

  let { status, onnotes }: { status: UpdateStatus; onnotes: () => void } = $props();
</script>

{#if status.phase === "ready"}
  <span class="update-status" role="status">
    <button
      onclick={onnotes}
      title={`Nicegal ${status.version} will install when you quit. View release notes.`}
    >
      <CircleArrowUp size={13} aria-hidden="true" />Update
    </button>
  </span>
{/if}

<style>
  .update-status {
    display: flex;
    flex: none;
    align-self: stretch;
    margin-right: var(--space-8);
    border-right: 1px solid var(--border-subtle);
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-10);
    border: 0;
    background: var(--update-ready-background);
    color: var(--update-ready-text);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  button:hover {
    background: var(--update-ready-hover);
  }

  button:focus-visible {
    outline: 1px dotted var(--update-ready-text);
    outline-offset: -2px;
  }
</style>
