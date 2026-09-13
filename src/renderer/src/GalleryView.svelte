<script lang="ts">
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import Settings from "@lucide/svelte/icons/settings";
  import { onMount } from "svelte";

  import type { ExternalVisualReference } from "../../shared/backend";

  import AppMessage from "./components/AppMessage.svelte";
  import AppShell from "./components/AppShell.svelte";
  import DetailView from "./components/DetailView.svelte";
  import JobIndicator from "./components/JobIndicator.svelte";
  import LibrariesDialog from "./components/LibrariesDialog.svelte";
  import MetadataPanel from "./components/MetadataPanel.svelte";
  import Modal from "./components/Modal.svelte";
  import SearchBar from "./components/SearchBar.svelte";
  import SearchOptions from "./components/SearchOptions.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TimelineScrollbar from "./components/TimelineScrollbar.svelte";
  import ViewControls from "./components/ViewControls.svelte";
  import VirtualGallery from "./components/VirtualGallery.svelte";
  import { useApplication } from "./lib/application.svelte";
  import { originalUrlOf } from "./lib/gallery/types";
  import { createLibraryViewController } from "./lib/library-view.svelte";
  import { RANKED_RESULT_LIMIT } from "./lib/ocr-search.svelte";
  import { galleryLayoutState, settings } from "./lib/settings.svelte";

  const application = useApplication();
  const { catalog, runtime, ocrSearch, jobs, orchestrator } = application.services;
  const commands = application.commands;
  let infoOpen = $state(false);
  function toggleInfo(): void {
    if (infoOpen) closeInfo();
    else infoOpen = true;
  }
  function closeInfo(): void {
    infoOpen = false;
    document.querySelector<HTMLButtonElement>('button[aria-controls="metadata-panel"]')?.focus();
  }
  let gallery = $state<VirtualGallery>();
  let settingsPage = $state<"gallery" | "search">("gallery");
  let galleryContainer = $state<HTMLDivElement>();
  const view = createLibraryViewController(application, (y) => gallery?.scrollTo(y));
  const inspectedAsset = $derived(
    view.detailItem ??
      (view.gallerySelection.count === 1
        ? (catalog.items.find((item) => view.gallerySelection.ids.has(item.id)) ?? null)
        : null),
  );

  async function addDroppedVisualFiles(files: File[]): Promise<void> {
    const limit = 16 * 1024 * 1024;
    const accepted: ExternalVisualReference[] = [];
    for (const file of files.slice(0, 16)) {
      if (file.size > limit) {
        ocrSearch.error = `${file.name} is larger than the 16 MB visual-search limit.`;
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      accepted.push({ displayName: file.name, bytesBase64: btoa(binary) });
    }
    if (accepted.length) ocrSearch.addExternalReferences(accepted);
  }

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      view.galleryScroll.height = entry.contentRect.height;
    });
    observer.observe(galleryContainer);
    return () => {
      observer.disconnect();
      view.dispose();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (
      event.key.toLowerCase() === "i" &&
      !document.fullscreenElement &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.repeat &&
      !(
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, dialog"))
      )
    ) {
      event.preventDefault();
      toggleInfo();
      return;
    }
    if (
      event.key === "Escape" &&
      event.target instanceof Element &&
      event.target.closest(".metadata-panel")
    ) {
      event.preventDefault();
      closeInfo();
      return;
    }
    view.handleKeydown(event);
  }}
/>

{#snippet toolbar()}
  {#if !view.detailItem}
    <div
      class="search-row app-toolbar"
      class:semantic-suggestion-visible={ocrSearch.shouldSuggestSemantic}
    >
      <SearchBar
        bind:value={ocrSearch.query}
        message={ocrSearch.queryHint || ocrSearch.error}
        infoNotice={ocrSearch.indexNotice}
        semanticSuggestion={ocrSearch.shouldSuggestSemantic}
        onsemanticsearch={view.switchToMeaningSearch}
        visualReferences={ocrSearch.visualReferences}
        onvisualreferenceschange={(references) => ocrSearch.setVisualReferences(references)}
        onchoosevisualfile={() =>
          void window.nicegal.native
            .chooseVisualSearchImage()
            .then((reference) => reference && ocrSearch.addExternalReferences([reference]))
            .catch(
              (error: unknown) =>
                (ocrSearch.error = error instanceof Error ? error.message : String(error)),
            )}
        onaddlibraryvisual={() =>
          ocrSearch.addLibraryReferences(
            catalog.items
              .filter((item) => view.gallerySelection.ids.has(item.id))
              .map((item) => ({ id: item.id, displayName: item.displayName })),
          )}
        ondropvisualfiles={(files) => void addDroppedVisualFiles(files)}
      />
      {#if orchestrator.restartingIndex}
        <span role="status">Switching to CPU…</span>
        <button class="ui-button" onclick={() => orchestrator.cancel()}>Stop indexing</button>
      {:else if jobs.active}
        <JobIndicator
          job={jobs.active}
          running={view.jobRunning}
          oncancel={() => orchestrator.cancel()}
          ondismiss={commands.dismissJobResult}
        />
      {/if}
      <ViewControls
        ranked={view.rankedView}
        bind:layoutMode={$settings.layoutMode}
        bind:sortField={$settings.sortField}
        bind:dateHeaders={$settings.dateHeaders}
      />
      <button
        class="app-toolbar-button app-toolbar-text-button"
        class:active={view.activeDialog === "libraries"}
        onclick={view.openLibrariesDialog}
        title="Libraries"
        aria-label="Libraries"
        aria-haspopup="dialog"
        aria-expanded={view.activeDialog === "libraries"}
      >
        <FolderOpen size={13} aria-hidden="true" />
        <span>Libraries</span>
      </button>
      <button
        class="app-toolbar-button app-toolbar-text-button"
        class:active={view.activeDialog === "settings"}
        onclick={view.openSettingsDialog}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={view.activeDialog === "settings"}
      >
        <Settings size={13} aria-hidden="true" />
        <span>Settings</span>
      </button>
    </div>
    {#if ocrSearch.rankable}
      <SearchOptions
        bind:sortMode={ocrSearch.sortMode}
        bind:minMatchPercentile={ocrSearch.minMatchPercentile}
        showSlider={ocrSearch.sliderApplicable}
        sliderDisabled={ocrSearch.sliderDisabled}
        shownCount={view.filteredItems.length}
        matchTotal={view.searchView.matchTotal}
        truncated={view.rankedView && view.searchView.matchTotal > RANKED_RESULT_LIMIT}
      />
    {/if}
  {/if}
{/snippet}

{#snippet workspace()}
  <div class="workspace-row">
    <div class="content-row" bind:this={galleryContainer}>
      <div class="gallery-workspace" inert={Boolean(view.detailItem)}>
        <VirtualGallery
          bind:this={gallery}
          items={view.filteredItems}
          layoutOptions={view.galleryLayoutOptions}
          imagePoolSize={galleryLayoutState.imagePoolSize}
          playAnimatedPreviews={$settings.playAnimatedPreviews}
          snippets={ocrSearch.snippets}
          snippetQuery={ocrSearch.query}
          searchQuery={ocrSearch.query}
          selectedIds={view.gallerySelection.ids}
          hideNativeScrollbar
          onScroll={view.handleGalleryScroll}
          onselect={view.selectGalleryItem}
          onmarqueestart={view.beginGalleryMarquee}
          onmarqueechange={view.updateGalleryMarquee}
          onmarqueeend={view.endGalleryMarquee}
          onopen={view.openDetail}
          onfilemenu={view.openFileMenu}
          onclear={() => view.gallerySelection.clear()}
        /><TimelineScrollbar
          items={view.filteredItems}
          layout={view.galleryScroll.layout}
          scrollTop={view.galleryScroll.scrollTop}
          viewportHeight={view.galleryScroll.height}
          showTicks={!view.rankedView}
          onSeek={view.handleSeek}
        />
      </div>
      {#if !catalog.backendStatus.ready && !catalog.backendStatus.error}<AppMessage
          title="Starting gallery…"
          message="Opening your local catalog."
          placement="overlay"
          tone="neutral"
        />{:else if !catalog.backendStatus.ready && catalog.backendStatus.error}<AppMessage
          title="Backend unavailable"
          guidance="The gallery service could not start or stopped unexpectedly. Review the details, then restart the app. For an incompatible index version, use a compatible app version and preserve the index until migration or rebuilding is chosen."
          message={catalog.backendStatus.error}
          placement="overlay"
        />{:else if catalog.loadError}<AppMessage
          title="Catalog read failed"
          guidance="The library could not be read. Check that its drive is connected and accessible, then retry."
          actionLabel="Retry"
          onaction={() => catalog.refresh()}
          message={catalog.loadError}
          placement="overlay"
        />{:else if !catalog.loading && !catalog.libraryRoot}<AppMessage
          title="No library yet"
          message="Choose a folder of images to get started."
          placement="overlay"
          tone="neutral"
          actionLabel="Choose image folder…"
          onaction={view.openLibrariesDialog}
        />{:else if !catalog.loading && catalog.items.length === 0}<AppMessage
          title="The catalog is empty."
          message="This library is empty. Add pictures to its folder, then open Libraries and enable search to scan it."
          placement="overlay"
          tone="neutral"
          actionLabel="Open Libraries"
          onaction={view.openLibrariesDialog}
        />{/if}
      {#if jobs.error && catalog.backendStatus.ready && !catalog.loadError}
        <AppMessage
          title="Job error"
          message={jobs.error}
          placement="overlay"
          actionLabel="Dismiss"
          onaction={() => jobs.dismiss()}
        />
      {:else if jobs.connectionError && catalog.backendStatus.ready}
        <AppMessage
          title="Progress updates interrupted"
          message={jobs.connectionError}
          guidance="The job may still be running. Nicegal is reconnecting; its last reported progress is retained."
          placement="overlay"
        />
      {/if}
      {#if view.detailItem}
        {#key originalUrlOf(view.detailItem)}
          <DetailView
            item={view.detailItem}
            hasPrev={view.detailIndex !== null && view.detailIndex > 0}
            hasNext={view.detailIndex !== null && view.detailIndex < view.filteredItems.length - 1}
            onclose={view.closeDetail}
            onprev={view.showPrevDetail}
            onnext={view.showNextDetail}
            onstatuschange={(status) => (view.detailStatus = status)}
            onfilemenu={() => view.detailIndex !== null && view.openFileMenu(view.detailIndex)}
          />
        {/key}
      {/if}
    </div>
    {#if infoOpen}
      <MetadataPanel
        asset={inspectedAsset}
        selectedCount={view.gallerySelection.count}
        ready={catalog.backendStatus.ready}
        onclose={closeInfo}
      />
    {/if}
  </div>
{/snippet}

{#snippet status()}
  <div class="status-details">
    {#if !view.detailItem}
      <StatusBar
        libraryName={view.libraryName}
        libraryRoot={catalog.libraryRoot}
        hasLibrary={Boolean(catalog.libraryRoot)}
        matchedCount={view.filteredItems.length}
        totalCount={catalog.items.length}
        filtering={view.searchView.filtering}
        searching={ocrSearch.pending}
        selectedCount={view.gallerySelection.count}
        status={catalog.selectedStatus}
        message={view.statusMessage}
        backendReady={catalog.backendStatus.ready}
        backendError={catalog.backendStatus.error}
        {runtime}
        indexingRunning={view.indexingRunning}
        indexRate={jobs.indexRate}
        onsettings={() => {
          settingsPage = "search";
          view.openSettingsDialog();
        }}
      />
    {:else}
      <span class="status-segment viewer-name" title={view.detailItem.displayName}>
        {view.detailStatus?.filename ?? view.detailItem.displayName}
      </span>
      {#if view.detailStatus?.width && view.detailStatus.height}
        <span class="status-segment viewer-meta">
          {view.detailStatus.width}×{view.detailStatus.height}
        </span>
      {/if}
      {#if view.detailStatus?.loading}
        <span class="status-segment viewer-meta" role="status">Loading…</span>
      {:else if view.detailStatus?.failed}
        <span class="status-segment viewer-error" role="status">Load failed</span>
      {:else if view.detailStatus?.zoom}
        <span class="status-segment viewer-meta" aria-live="polite">{view.detailStatus.zoom}</span>
      {/if}
    {/if}
  </div>
  <button
    class="status-pane-toggle"
    aria-controls="metadata-panel"
    aria-pressed={infoOpen}
    title="Show or hide photo info (I)"
    onclick={toggleInfo}
  >
    <PanelRight size={13} aria-hidden="true" /><span>Info</span>
  </button>
{/snippet}

{#snippet modals()}
  {#if application.welcomeVisible}
    <Modal
      labelledby="welcome-splash-title"
      describedby="welcome-splash-description"
      onclose={commands.dismissWelcome}
      --modal-width="400px"
    >
      <div class="welcome-splash">
        <h1 id="welcome-splash-title">Welcome to Nicegal</h1>
        <p id="welcome-splash-description">
          Keep your picture folders together, then search the words and visual meaning inside them.
        </p>
        <ol>
          <li>
            <strong>Add a library</strong>
            <span>Choose a folder of pictures to browse.</span>
          </li>
          <li>
            <strong>Index it when you are ready</strong>
            <span
              >Indexing downloads search models on first use, then enables text and visual searches.
              Follow progress in the toolbar and check Search models in Settings.</span
            >
          </li>
        </ol>
        <div class="welcome-splash-actions">
          <button type="button" onclick={commands.dismissWelcome}>Not now</button>
          <button class="primary" type="button" onclick={view.startWelcomeLibraryPicker}
            >Add a folder</button
          >
        </div>
      </div>
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
      />
    </Modal>
  {:else if view.activeDialog === "settings"}
    <Modal labelledby="settings-title" onclose={view.closeDialog}>
      <div class="settings-dialog">
        <SettingsPanel {runtime} bind:page={settingsPage} onclose={view.closeDialog} />
      </div>
    </Modal>
  {/if}
{/snippet}

<AppShell theme={$settings.theme} {toolbar} {workspace} {status} {modals} />

<style>
  /* The tab is anchored below SearchBar's field. Reserve its physical row here, so it does not
     cover the search options immediately below the toolbar. Padding keeps the toolbar controls
     aligned to the field instead of vertically centering them in the added space. */
  .search-row.semantic-suggestion-visible {
    padding-bottom: calc(var(--space-6) + 23px);
  }
  .search-row :global(.search-bar) {
    flex: 1;
  }
  .search-row > :global(.view-controls),
  .search-row > :global(.app-toolbar-button) {
    align-self: flex-start;
  }
  .status-details {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .workspace-row {
    display: flex;
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .content-row {
    min-width: 0;
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .gallery-workspace {
    display: flex;
    min-width: 0;
    flex: 1;
  }
  .content-row :global(.gallery-viewport) {
    flex: 1;
    min-width: 0;
  }
  .settings-dialog {
    max-height: min(var(--dialog-max-height), 100%);
    overflow: auto;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .welcome-splash {
    width: min(400px, 100%);
    box-sizing: border-box;
    padding: var(--space-16);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .welcome-splash h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--dialog-title-size);
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash > p {
    margin: var(--space-8) 0 var(--space-14);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    line-height: var(--line-height-normal);
  }
  .welcome-splash ol {
    display: grid;
    gap: var(--space-8);
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: welcome-step;
  }
  .welcome-splash li {
    display: grid;
    grid-template-columns: 20px 1fr;
    column-gap: var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    counter-increment: welcome-step;
  }
  .welcome-splash li::before {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--accent-active);
    content: counter(welcome-step);
    font-size: var(--font-size-sm);
  }
  .welcome-splash li strong,
  .welcome-splash li span {
    grid-column: 2;
  }
  .welcome-splash li strong {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash li span {
    margin-top: var(--space-1);
  }
  .welcome-splash-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-6);
    margin-top: var(--space-16);
  }
  .welcome-splash-actions button {
    height: var(--toolbar-control-height);
    padding: 0 var(--space-9);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-md);
    cursor: pointer;
  }
  .welcome-splash-actions button:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
  }
  .welcome-splash-actions button:active {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
  }
  .welcome-splash-actions .primary {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
  }
  .welcome-splash-actions button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
