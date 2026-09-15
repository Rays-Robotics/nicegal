<script lang="ts">
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import Settings from "@lucide/svelte/icons/settings";
  import { onDestroy } from "svelte";

  import type { ExternalVisualReference } from "../../shared/backend";

  import searchMenuGuide from "./assets/guide/search-menu.png";
  import visualSearchGuide from "./assets/guide/visual-search.png";
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
  import { galleryLayoutState, settings, settingsLimits } from "./lib/settings.svelte";

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
  const thumbnailFailures = $derived(gallery?.getThumbnailFailures(catalog.items) ?? []);
  let settingsPage = $state<"gallery" | "search" | "about">("gallery");
  const view = createLibraryViewController(application, (y) => gallery?.scrollTo(y));
  const inspectedAsset = $derived(
    view.detailItem ??
      (view.gallerySelection.count === 1
        ? (catalog.items.find((item) => view.gallerySelection.ids.has(item.id)) ?? null)
        : null),
  );

  async function addDroppedVisualFiles(files: File[]): Promise<void> {
    const session = ocrSearch.visualSessionRevision;
    const limit = 16 * 1024 * 1024;
    const accepted: ExternalVisualReference[] = [];
    for (const file of files.slice(0, 16)) {
      if (file.size > limit) {
        ocrSearch.error = `${file.name} is larger than the 16 MB visual-search limit.`;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (error: unknown) {
        if (session === ocrSearch.visualSessionRevision) {
          ocrSearch.error = error instanceof Error ? error.message : String(error);
        }
        return;
      }
      if (session !== ocrSearch.visualSessionRevision) return;
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      accepted.push({ displayName: file.name, bytesBase64: btoa(binary) });
    }
    if (accepted.length && session === ocrSearch.visualSessionRevision)
      ocrSearch.addExternalReferences(accepted);
  }

  async function chooseVisualFile(): Promise<void> {
    const session = ocrSearch.visualSessionRevision;
    try {
      const reference = await window.nicegal.native.chooseVisualSearchImage();
      if (reference && session === ocrSearch.visualSessionRevision) {
        ocrSearch.addExternalReferences([reference]);
      }
    } catch (error: unknown) {
      if (session === ocrSearch.visualSessionRevision) {
        ocrSearch.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function observeGallery(element: HTMLDivElement): () => void {
    const observer = new ResizeObserver(([entry]) => {
      view.galleryScroll.height = entry.contentRect.height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }
  function galleryWheelZoom(element: HTMLDivElement): () => void {
    let accumulated = 0;
    let lastWheelTime = 0;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || view.detailItem || view.activeDialog) {
        accumulated = 0;
        return;
      }
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (!delta) return;
      if (event.timeStamp - lastWheelTime > 250 || Math.sign(delta) !== Math.sign(accumulated))
        accumulated = 0;
      lastWheelTime = event.timeStamp;
      accumulated += delta;
      const steps = Math.trunc(accumulated / 80);
      if (!steps) return;
      accumulated -= steps * 80;
      const key =
        $settings.layoutMode === "justified"
          ? "targetRowHeight"
          : $settings.layoutMode === "masonry"
            ? "masonryColumnWidth"
            : "gridCellWidth";
      const limit = settingsLimits[key];
      $settings[key] = Math.max(
        limit.min,
        Math.min(limit.max, $settings[key] - steps * limit.step * 3),
      );
      if ($settings.layoutMode === "grid") $settings.gridColumns = 0;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }
  onDestroy(() => view.dispose());
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
        bind:composerOpen={ocrSearch.composerOpen}
        message={ocrSearch.queryHint || (ocrSearch.allMode ? "" : ocrSearch.error)}
        infoNotice={ocrSearch.allMode ? "" : ocrSearch.indexNotice}
        textSetupRequired={ocrSearch.textSetupRequired}
        semanticSuggestion={ocrSearch.shouldSuggestSemantic}
        onsemanticsearch={view.switchToMeaningSearch}
        onsetuptextsearch={view.openLibrariesDialog}
        visualReferences={ocrSearch.visualReferences}
        onvisualreferenceschange={(references) => ocrSearch.setVisualReferences(references)}
        onchoosevisualfile={() => void chooseVisualFile()}
        selectedPhotoCount={view.gallerySelection.count}
        onaddlibraryvisual={() =>
          ocrSearch.addLibraryReferences(
            catalog.items
              .filter((item) => view.gallerySelection.ids.has(item.id))
              .map((item) => ({ id: item.id, displayName: item.displayName })),
          )}
        ondropvisualfiles={(files) =>
          void addDroppedVisualFiles(files).catch((error: unknown) => {
            ocrSearch.error = error instanceof Error ? error.message : String(error);
          })}
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
        truncated={false}
        sliderLabel={ocrSearch.sliderLabel}
        sections={view.searchView.sections}
        onsection={(key) => gallery?.scrollToSection(key)}
        notice={ocrSearch.allMode && ocrSearch.sortMode === "date" ? ocrSearch.allNotice : ""}
      />
    {/if}
  {/if}
{/snippet}

{#snippet workspace()}
  <div class="workspace-row">
    <div class="content-row" {@attach observeGallery}>
      <div class="gallery-workspace" inert={Boolean(view.detailItem)} {@attach galleryWheelZoom}>
        <VirtualGallery
          bind:this={gallery}
          items={view.filteredItems}
          sections={view.searchView.sections}
          ontogglesection={view.toggleSection}
          viewKey={ocrSearch.sortMode}
          oninteractionchange={(active) => ocrSearch.setInteracting(active)}
          layoutOptions={view.galleryLayoutOptions}
          imagePoolSize={galleryLayoutState.imagePoolSize}
          playAnimatedPreviews={$settings.playAnimatedPreviews}
          snippets={ocrSearch.displaySnippets}
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
          onfiledrag={view.startFileDrag}
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
        matchedCount={view.searchView.matchTotal}
        totalCount={catalog.items.length}
        filtering={view.searchView.filtering}
        searching={ocrSearch.pending}
        selectedCount={view.gallerySelection.count}
        status={catalog.selectedStatus}
        message={view.statusMessage}
        backendReady={catalog.backendStatus.ready}
        backendError={catalog.backendStatus.error}
        {runtime}
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
      --modal-width="640px"
    >
      <div class="welcome-splash">
        <h1 id="welcome-splash-title">Welcome to Nicegal</h1>
        <p id="welcome-splash-description">
          Browse picture folders and find images by name, text, or appearance.
        </p>
        <ol class="themed-scrollbar">
          <li>
            <strong>Add a folder, then enable search</strong>
            <span
              >Open <b>Libraries → Add folder</b> to start browsing. Your files stay in their original
              folders.</span
            >
            <span
              >Choose <b>Index</b> in Libraries to enable image search. The first run downloads search
              models; pictures are processed locally.</span
            >
            <span
              >You can also enable text search in Libraries for screenshots, scans, and other
              pictures containing writing.</span
            >
          </li>
          <li>
            <strong>Choose what to search</strong>
            <div class="welcome-search-menu">
              <img
                src={searchMenuGuide}
                width="216"
                height="125"
                alt="Search menu with All, Visual search, and File name above Exact text and Related text"
              />
              <div>
                <p>Choose a search type from the menu, or type a prefix:</p>
                <ul class="search-types">
                  <li>
                    <b>Visual search</b> (<code>like:</code>) — Find images by appearance, concept,
                    or similarity to another image.
                  </li>
                  <li>
                    <b>Exact text</b> (<code>ocr:</code>) — Find specific words written in images
                    <em>(requires OCR)</em>.
                  </li>
                  <li>
                    <b>Related text</b> (<code>meaning:</code>) — Find writing with a similar
                    meaning, even with different wording <em>(requires OCR)</em>.
                  </li>
                </ul>
                <p>
                  <b>All</b> searches file names and available visual results. With text
                  recognition, it also includes exact text and related text.
                  <b>File name</b> searches names without indexing.
                </p>
                <p>
                  Use <b>Relevance</b> for grouped results, or <b>Date</b> for one timeline. In
                  All's Date view,
                  <b>Visual similarity</b> narrows only visual results; names and text results stay.
                  Add <code>during:2026-06</code> to search within a month in either view.
                </p>
              </div>
            </div>
          </li>
          <li>
            <strong>Combine images and descriptions with <code>like:</code></strong>
            <span
              >Right-click a photo and choose <b>Find similar images</b> to start a new search, or
              <b>Add to visual search</b> to build on the current search.</span
            >
            <figure>
              <img
                src={visualSearchGuide}
                width="508"
                height="71"
                alt="Visual search composer with sunset weighted 2.00 and crowds weighted −1.00"
              />
              <figcaption>
                Open <b>Compose visual search</b> to add descriptions or images and adjust their weights.
              </figcaption>
            </figure>
            <span>Search updates as you edit.</span>
          </li>
        </ol>
        <div class="welcome-splash-actions">
          <span>Reopen this guide from <b>Settings → Getting started</b>.</span>
          <button type="button" onclick={commands.dismissWelcome}>Close</button>
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
        {thumbnailFailures}
        onretrythumbnails={() =>
          gallery?.retryThumbnails(thumbnailFailures.map((failure) => failure.assetId))}
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
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    max-height: min(var(--dialog-max-height), calc(100vh - var(--space-16) * 2));
    overflow: hidden;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .welcome-splash {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - var(--space-16) * 2);
    width: 100%;
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
    gap: var(--space-14);
    min-height: 0;
    overflow: auto;
    padding-right: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: welcome-step;
  }
  .welcome-splash ol > li {
    display: grid;
    grid-template-columns: 20px 1fr;
    column-gap: var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    counter-increment: welcome-step;
  }
  .welcome-splash ol > li::before {
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
  .welcome-splash ol > li > strong,
  .welcome-splash ol > li > span {
    grid-column: 2;
  }
  .welcome-splash ol > li > strong {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash ol > li > span {
    margin-top: var(--space-4);
  }
  .welcome-splash li {
    line-height: var(--line-height-normal);
  }
  .welcome-splash h1,
  .welcome-splash > p,
  .welcome-splash-actions {
    flex: none;
  }
  .welcome-search-menu {
    grid-column: 2;
    margin-top: var(--space-6);
  }
  .welcome-search-menu p {
    margin: 0;
  }
  .search-types {
    margin: var(--space-6) 0;
    padding-left: var(--space-16);
    list-style: disc;
  }
  .search-types li + li {
    margin-top: var(--space-4);
  }
  .welcome-splash img {
    display: block;
    max-width: 100%;
    height: auto;
    object-fit: contain;
  }
  .welcome-search-menu img {
    width: 216px;
    float: right;
    margin: 0 0 var(--space-6) var(--space-12);
  }
  .welcome-splash figure {
    grid-column: 2;
    margin: var(--space-8) 0 var(--space-4);
  }
  .welcome-splash figcaption {
    margin-top: var(--space-6);
  }
  .welcome-splash code {
    color: var(--text-primary);
    font-size: inherit;
  }
  .welcome-splash b {
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash-actions > span {
    margin-right: auto;
    align-self: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  @media (max-width: 560px) {
    .welcome-search-menu img {
      width: min(216px, 50%);
    }
    .welcome-splash-actions {
      flex-wrap: wrap;
    }
    .welcome-splash-actions > span {
      width: 100%;
    }
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
