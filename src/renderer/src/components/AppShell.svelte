<script lang="ts">
  import { onMount, type Snippet } from "svelte";

  import type { UpdateStatus as UpdateState } from "../../../shared/updates";

  import PerfHud from "./PerfHud.svelte";
  import UpdateStatus from "./UpdateStatus.svelte";

  let update = $state<UpdateState>({ phase: "disabled", version: null });
  onMount(() => {
    // Subscribe before reading the snapshot; an intervening event is newer than that read.
    let receivedEvent = false;
    let disposed = false;
    const unsubscribe = window.nicegal.updates.onStatusChanged((status) => {
      receivedEvent = true;
      update = status;
    });
    void window.nicegal.updates
      .getStatus()
      .then((status) => {
        if (!disposed && !receivedEvent) update = status;
      })
      .catch((error: unknown) => console.error("Could not read update status", error));
    return () => {
      disposed = true;
      unsubscribe();
    };
  });

  function openReleaseNotes(): void {
    void window.nicegal.updates.openReleaseNotes().catch((error: unknown) => {
      console.error("Could not open release notes", error);
    });
  }

  let {
    theme,
    toolbar,
    workspace,
    status,
    modals,
  }: {
    theme: string;
    toolbar?: Snippet;
    workspace: Snippet;
    status: Snippet;
    modals?: Snippet;
  } = $props();
</script>

<main data-theme={theme}>
  {#if toolbar}
    <header class="shell-toolbar">
      {@render toolbar()}
    </header>
  {/if}
  <section class="shell-workspace">
    {@render workspace()}
  </section>
  <footer class="status-bar">
    <UpdateStatus status={update} onnotes={openReleaseNotes} />
    {@render status()}
  </footer>
  <PerfHud />
</main>

{#if modals}
  <div class="modal-layer" data-theme={theme}>
    {@render modals()}
  </div>
{/if}

<style>
  main {
    display: flex;
    height: 100%;
    flex-direction: column;
    background: var(--surface-0);
  }

  .shell-toolbar,
  .shell-workspace {
    display: contents;
  }

  .status-bar {
    display: flex;
    height: var(--statusbar-height);
    flex: none;
    align-items: center;
    padding: 0 var(--space-4) 0 var(--space-10);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-1);
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }

  .status-bar:has(:global(.update-status)) {
    padding-left: 0;
  }

  .status-bar :global(.status-segment) {
    overflow: hidden;
    padding-right: var(--space-8);
    margin-right: var(--space-8);
    border-right: 1px solid var(--border-subtle);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-bar :global(.status-segment:last-child) {
    border-right: 0;
  }

  .modal-layer {
    display: contents;
  }
</style>
