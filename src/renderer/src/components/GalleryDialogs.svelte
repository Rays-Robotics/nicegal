<script lang="ts">
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";
  import type { LibraryViewController } from "../lib/library-view.svelte";

  import { useApplication } from "../lib/application.svelte";
  import GettingStarted from "./GettingStarted.svelte";
  import LibrariesDialog from "./LibrariesDialog.svelte";
  import Modal from "./Modal.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";

  let {
    view,
    settingsPage = $bindable("gallery"),
    thumbnailFailures,
    onretrythumbnails,
  }: {
    view: LibraryViewController;
    settingsPage?: "gallery" | "search" | "about";
    thumbnailFailures: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
  } = $props();
  const application = useApplication();
  const { catalog, runtime } = application.services;
  const commands = application.commands;
</script>

{#if application.welcomeVisible}
  <Modal
    labelledby="welcome-splash-title"
    describedby="welcome-splash-description"
    onclose={commands.dismissWelcome}
    --modal-width="640px"
  >
    <GettingStarted onclose={commands.dismissWelcome} onadd={view.startWelcomeLibraryPicker} />
  </Modal>
{/if}

{#if view.activeDialog === "libraries"}
  <Modal labelledby="libraries-title" onclose={view.closeDialog}>
    <LibrariesDialog
      libraries={catalog.libraries}
      selectedRoot={catalog.selectedRoot}
      statuses={catalog.libraryStatuses}
      backendReady={catalog.backendStatus.ready}
      jobRunning={view.jobRunning}
      onclose={view.closeDialog}
      onadd={view.chooseLibraryRoot}
      onselect={view.selectLibrary}
      onthumbnails={commands.startThumbnailBackfill}
      onremove={view.removeLibrary}
      {thumbnailFailures}
      {onretrythumbnails}
    />
  </Modal>
{:else if view.activeDialog === "settings"}
  <Modal labelledby="settings-title" onclose={view.closeDialog}>
    <div class="settings-dialog">
      <SettingsPanel
        {runtime}
        bind:page={settingsPage}
        onclose={view.closeDialog}
        onshowintro={() => {
          view.closeDialog();
          commands.showWelcome();
        }}
      />
    </div>
  </Modal>
{/if}

<style>
  .settings-dialog {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    max-height: min(var(--dialog-max-height), calc(100vh - var(--space-16) * 2));
    overflow: hidden;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
</style>
