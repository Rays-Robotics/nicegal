<script lang="ts">
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Settings from "@lucide/svelte/icons/settings";

  import type { LibraryViewController } from "../lib/library-view.svelte";

  import { useApplication } from "../lib/application.svelte";
  import { errorMessage } from "../lib/errors";
  import { settings } from "../lib/settings.svelte";
  import { addDroppedVisualFiles, chooseVisualFile } from "../lib/visual-search-input";
  import JobIndicator from "./JobIndicator.svelte";
  import SearchBar from "./SearchBar.svelte";
  import SearchOptions from "./SearchOptions.svelte";
  import ViewControls from "./ViewControls.svelte";

  let {
    view,
    onsection,
  }: {
    view: LibraryViewController;
    onsection: (key: string) => void;
  } = $props();
  const {
    services: { catalog, ocrSearch, jobs, orchestrator },
    commands,
  } = useApplication();

  let searchBar = $state<SearchBar>();
  export function focusSearch(): void {
    searchBar?.focus();
  }

  function addSelectedImages(): void {
    ocrSearch.addLibraryReferences(
      catalog.items
        .filter((item) => view.gallerySelection.ids.has(item.id))
        .map((item) => ({ id: item.id, displayName: item.displayName })),
    );
  }
  function dropImages(files: File[]): void {
    void addDroppedVisualFiles(ocrSearch, files).catch((error: unknown) => {
      ocrSearch.error = errorMessage(error);
    });
  }
</script>

{#if !view.detailItem}
  <div
    class="search-row app-toolbar"
    class:semantic-suggestion-visible={ocrSearch.shouldSuggestSemantic}
  >
    <SearchBar
      bind:this={searchBar}
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
      onchoosevisualfile={() => void chooseVisualFile(ocrSearch)}
      selectedPhotoCount={view.gallerySelection.count}
      onaddlibraryvisual={addSelectedImages}
      ondropvisualfiles={dropImages}
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
      {onsection}
      notice={ocrSearch.allMode && ocrSearch.sortMode === "date" ? ocrSearch.allNotice : ""}
    />
  {/if}
{/if}

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
</style>
