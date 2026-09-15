import { tick, untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { fromStore } from "svelte/store";

import type { DetailViewStatus } from "../components/DetailView.svelte";
import type { ApplicationContext } from "./application.svelte";
import type { LayoutOptions } from "./gallery/options";
import type { GalleryLayout } from "./gallery/types";
import type { GalleryItem } from "./gallery/types";
import type { SearchView } from "./ocr-search.svelte";

import { rootsMatch } from "./catalog.svelte";
import { errorMessage } from "./errors";
import { GalleryScrollState } from "./gallery/scroll-state.svelte";
import { collapseSearchSections } from "./gallery/search-sections";
import { GallerySelection, type SelectionModifiers } from "./gallery/selection.svelte";
import { isActiveJob } from "./job-state";
import { withScope } from "./search-query";
import { layoutOptions, settings } from "./settings.svelte";

export interface LibraryViewController {
  readonly galleryScroll: GalleryScrollState;
  readonly gallerySelection: GallerySelection;
  readonly activeDialog: "libraries" | "settings" | null;
  readonly detailIndex: number | null;
  detailStatus: DetailViewStatus | null;
  readonly searchView: SearchView;
  readonly filteredItems: GalleryItem[];
  readonly rankedView: boolean;
  readonly galleryLayoutOptions: LayoutOptions;
  readonly statusMessage: string | undefined;
  readonly jobRunning: boolean;
  readonly indexingRunning: boolean;
  readonly detailItem: GalleryItem | undefined;
  readonly libraryName: string;
  toggleSection(key: string): void;
  closeDialog(): void;
  startWelcomeLibraryPicker(): void;
  openLibrariesDialog(): void;
  openSettingsDialog(): void;
  handleKeydown(event: KeyboardEvent): void;
  switchToMeaningSearch(): void;
  openDetail(index: number): void;
  openFileMenu(index: number): void;
  startFileDrag(index: number, isCurrent: () => boolean): void;
  selectGalleryItem(index: number, modifiers: SelectionModifiers): void;
  beginGalleryMarquee(modifiers: SelectionModifiers): void;
  updateGalleryMarquee(ids: readonly string[]): void;
  endGalleryMarquee(): void;
  closeDetail(): void;
  showPrevDetail(): void;
  showNextDetail(): void;
  handleGalleryScroll(state: { scrollTop: number; layout: GalleryLayout }): void;
  handleSeek(y: number): void;
  chooseLibraryRoot(): Promise<void>;
  selectLibrary(root: string): Promise<void>;
  removeLibrary(root: string, purge: boolean): Promise<void>;
  dispose(): void;
}

/** Component-scoped library session. Create during component initialization so its effects
 * belong to that view. The viewport is accessed through a port, never retained as a DOM node. */
export function createLibraryViewController(
  application: ApplicationContext,
  scrollTo: (y: number) => void,
): LibraryViewController {
  const { catalog, runtime, ocrSearch, jobs } = application.services;
  const commands = application.commands;
  const preferences = fromStore(settings);
  // Presentation settings emit through the same store. Only a changed timeline should rerun a
  // search; layout switches must retain the ranked results rather than clearing/requerying them.
  const searchTimeline = $derived(preferences.current.sortField);
  const supportsImageTextQueries = $derived(runtime.supportsImageTextQueries);
  // Saving scroll position replaces the library registry, and status polls replace row objects.
  // Only an actual change in OCR availability should restart the search. Keep the last count
  // during status loading/errors rather than toggling engines for a transient refresh.
  const hasOcr = $derived.by(() => {
    const status = catalog.selectedStatus;
    return !status || status.indexed > 0;
  });
  const layoutPreferences = fromStore(layoutOptions);
  const galleryScroll = new GalleryScrollState();
  const searchIdentity = $derived(
    [catalog.libraryRoot, ocrSearch.query, ocrSearch.visualReferenceRevision].join("\u0000"),
  );
  const gallerySelection = $derived.by(() => {
    void searchIdentity;
    return new GallerySelection();
  });
  // User overrides last for this query, including progressive arrivals and sort changes.
  let collapsedSections = $derived.by(() => {
    void searchIdentity;
    return new SvelteSet<string>();
  });
  let activeDialog = $state<"libraries" | "settings" | null>(null);
  // Progressive results may move an image between sections. The viewer follows its ID, not
  // whichever image later occupies the index that was clicked.
  let detailId = $derived.by(() => {
    void ocrSearch.composerOpen;
    return null as string | null;
  });
  const detailIndex = $derived.by(() => {
    if (detailId === null) return null;
    const index = filteredItems.findIndex((item) => item.id === detailId);
    return index < 0 ? null : index;
  });
  let detailStatus = $state<DetailViewStatus | null>(null);
  let restoringLibraryView = Boolean(catalog.libraryRoot);
  let disposed = false;
  let cancelSearchWait: (() => void) | undefined;
  let libraryViewGeneration = 0;
  /** The generation that currently owns `GalleryScrollState`'s restore suppression. */
  let preparedLibraryViewRestoreGeneration: number | null = null;
  let viewStateSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const fullSearchView = $derived(ocrSearch.apply(catalog.items));
  const searchView = $derived(collapseSearchSections(fullSearchView, collapsedSections));
  const filteredItems = $derived(searchView.items);
  /** Stable until the current search result changes; marquee moves must not rebuild this per event. */
  const filteredItemIds = $derived(filteredItems.map((item) => item.id));
  /** Relevance changes order, not presentation. Suppress date boundaries locally so the saved
   * header preference is restored on date sort (2026-09-12 supersedes the masonry override). */
  const rankedView = $derived(ocrSearch.rankable && ocrSearch.sortMode === "relevance");
  const galleryLayoutOptions = $derived(
    rankedView
      ? { ...layoutPreferences.current, granularity: "none" as const }
      : layoutPreferences.current,
  );
  const statusMessage = $derived(
    jobs.completionMessage
      ? jobs.completionMessage
      : catalog.loading
        ? "Loading catalog…"
        : ocrSearch.pending
          ? ocrSearch.pendingLabel
          : undefined,
  );
  const jobRunning = $derived(jobs.running || application.services.orchestrator.indexing);
  const indexingRunning = $derived(jobs.active?.type === "ocrIndex" && isActiveJob(jobs.active));
  /** `undefined` (out-of-range index, e.g. the filter changed while open) closes the detail view. */
  const detailItem = $derived(detailIndex !== null ? filteredItems[detailIndex] : undefined);
  const libraryName = $derived(
    catalog.libraryRoot
      ? (catalog.libraryRoot.split(/[\\/]/).pop() ?? catalog.libraryRoot)
      : "No library",
  );
  $effect(() => {
    const root = catalog.libraryRoot;
    const query = ocrSearch.query;
    const visualReferenceRevision = ocrSearch.visualReferenceRevision;
    const scrollTop = untrack(() => galleryScroll.scrollTop);
    if (!root || restoringLibraryView) return;
    void visualReferenceRevision;
    scheduleLibraryViewState(root, query, scrollTop);
  });
  $effect(() => {
    void ocrSearch.query;
    const root = catalog.libraryRoot;
    const items = catalog.items;
    const timeline = searchTimeline;
    const visualReferenceRevision = ocrSearch.visualReferenceRevision;
    if (!catalog.backendStatus.ready) {
      untrack(() => ocrSearch.suspend());
      return;
    }
    void visualReferenceRevision;
    const ocrAvailable = hasOcr;
    const imageTextAvailable = supportsImageTextQueries;
    untrack(() => ocrSearch.schedule(root, items, timeline, imageTextAvailable, ocrAvailable));
  });
  $effect(() => {
    const catalogItems = catalog.items;
    untrack(() => gallerySelection.retainCatalogAssets(catalogItems));
  });
  $effect(() => {
    if (!application.initialized) return;
    void application.librarySelectionRevision;
    untrack(() => {
      const generation = beginLibraryViewRestore();
      void restoreLibraryView(catalog.libraryRoot, generation);
    });
  });
  function toggleSection(key: string): void {
    const next = new SvelteSet(collapsedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedSections = next;
    gallerySelection.retainCatalogAssets(filteredItems);
  }
  function closeDialog(): void {
    activeDialog = null;
  }
  function startWelcomeLibraryPicker(): void {
    commands.dismissWelcome();
    openLibrariesDialog();
  }
  function openLibrariesDialog(): void {
    activeDialog = "libraries";
    void catalog.refreshLibraryStatuses();
  }
  function openSettingsDialog(): void {
    activeDialog = "settings";
    if (catalog.backendStatus.ready && !runtime.status && !runtime.loading) void runtime.refresh();
  }
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (document.fullscreenElement) return;
    if (detailIndex !== null) closeDetail();
    else if (gallerySelection.count > 0) gallerySelection.clear();
  }
  function switchToMeaningSearch(): void {
    ocrSearch.query = withScope(ocrSearch.query, "meaning");
  }
  function openDetail(index: number): void {
    detailStatus = null;
    detailId = filteredItems[index]?.id ?? null;
  }
  function openFileMenu(index: number): void {
    const item = filteredItems[index];
    if (!item) return;
    if (!gallerySelection.ids.has(item.id)) {
      gallerySelection.select(item.id, filteredItemIds, { toggle: false, extend: false });
    }
    const assetIds = filteredItemIds.filter((id) => gallerySelection.ids.has(id));
    void commands.showFileContextMenu(assetIds).catch((error: unknown) => {
      jobs.error = errorMessage(error);
    });
  }
  function selectGalleryItem(index: number, modifiers: SelectionModifiers): void {
    const item = filteredItems[index];
    if (!item) return;
    gallerySelection.select(item.id, filteredItemIds, modifiers);
  }
  function startFileDrag(index: number, isCurrent: () => boolean): void {
    const item = filteredItems[index];
    if (!item) return;
    gallerySelection.endMarquee();
    if (!gallerySelection.ids.has(item.id)) {
      gallerySelection.select(item.id, filteredItemIds, { toggle: false, extend: false });
    }
    const assetIds = filteredItemIds.filter((id) => gallerySelection.ids.has(id));
    const selection = gallerySelection;
    const visibleIds = filteredItemIds;
    const canStart = (): boolean =>
      isCurrent() && gallerySelection === selection && filteredItemIds === visibleIds;
    void commands.startFileDrag(assetIds, canStart).catch((error: unknown) => {
      if (canStart()) jobs.error = errorMessage(error);
    });
  }
  function beginGalleryMarquee(modifiers: SelectionModifiers): void {
    gallerySelection.beginMarquee(modifiers);
  }
  function updateGalleryMarquee(ids: readonly string[]): void {
    gallerySelection.updateMarquee(ids, filteredItemIds);
  }
  function endGalleryMarquee(): void {
    gallerySelection.endMarquee();
  }
  function closeDetail(): void {
    detailId = null;
    detailStatus = null;
  }
  function showPrevDetail(): void {
    if (detailIndex !== null && detailIndex > 0) {
      detailStatus = null;
      detailId = filteredItems[detailIndex - 1].id;
    }
  }
  function showNextDetail(): void {
    if (detailIndex !== null && detailIndex < filteredItems.length - 1) {
      detailStatus = null;
      detailId = filteredItems[detailIndex + 1].id;
    }
  }
  function handleGalleryScroll(state: { scrollTop: number; layout: GalleryLayout }): void {
    galleryScroll.onScroll(state);
    if (catalog.libraryRoot && !restoringLibraryView)
      scheduleLibraryViewState(catalog.libraryRoot, ocrSearch.query, galleryScroll.scrollTop);
  }
  function handleSeek(y: number): void {
    scrollTo(y);
  }
  function scheduleLibraryViewState(root: string, query: string, scrollTop: number): void {
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer);
    viewStateSaveTimer = setTimeout(() => {
      viewStateSaveTimer = undefined;
      catalog.updateLibraryViewState(root, { query, scrollTop });
    }, 150);
  }

  function flushLibraryViewState(): void {
    if (viewStateSaveTimer) {
      clearTimeout(viewStateSaveTimer);
      viewStateSaveTimer = undefined;
    }
    if (!catalog.libraryRoot || restoringLibraryView) return;
    catalog.updateLibraryViewState(catalog.libraryRoot, {
      query: ocrSearch.query,
      scrollTop: galleryScroll.scrollTop,
    });
  }

  function beginLibraryViewRestore(): number {
    cancelSearchWait?.();
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer);
    viewStateSaveTimer = undefined;
    closeDetail();
    gallerySelection.clear();
    const generation = ++libraryViewGeneration;
    if (preparedLibraryViewRestoreGeneration !== null) {
      galleryScroll.finishRestore();
      preparedLibraryViewRestoreGeneration = null;
    }
    restoringLibraryView = true;
    return generation;
  }

  function abandonLibraryViewRestore(generation: number): void {
    if (preparedLibraryViewRestoreGeneration === generation) {
      galleryScroll.finishRestore();
      preparedLibraryViewRestoreGeneration = null;
    }
    if (generation === libraryViewGeneration) restoringLibraryView = false;
  }

  function canRestoreLibraryView(root: string, generation: number): boolean {
    return (
      !disposed && generation === libraryViewGeneration && rootsMatch(catalog.libraryRoot, root)
    );
  }

  /** A saved offset belongs to the final search layout, not the empty/debounced result set.
   * The wait is cancelled by a newer library switch, a query edit, or view disposal. */
  function waitForRestoredSearch(
    root: string,
    query: string,
    generation: number,
  ): Promise<boolean> {
    if (!canRestoreLibraryView(root, generation) || ocrSearch.query !== query) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let stop = (): void => {};
      const finish = (ready: boolean): void => {
        stop();
        if (cancelSearchWait === cancel) cancelSearchWait = undefined;
        resolve(ready);
      };
      const cancel = (): void => finish(false);
      cancelSearchWait = cancel;
      stop = $effect.root(() => {
        $effect(() => {
          const currentRoot = catalog.libraryRoot;
          const currentQuery = ocrSearch.query;
          const pending = catalog.loading || ocrSearch.pending;
          untrack(() => {
            if (
              !rootsMatch(currentRoot, root) ||
              currentQuery !== query ||
              !canRestoreLibraryView(root, generation)
            ) {
              finish(false);
            } else if (!pending) {
              finish(true);
            }
          });
        });
      });
    });
  }

  async function restoreLibraryView(root: string, generation: number): Promise<boolean> {
    if (!canRestoreLibraryView(root, generation)) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    const saved = catalog.libraries.find((library) => rootsMatch(library.root, root));
    const query = saved?.query ?? "";
    const scrollTop = saved?.scrollTop ?? 0;
    ocrSearch.resetVisualSearch();
    ocrSearch.query = query;
    galleryScroll.prepareRestore(scrollTop);
    preparedLibraryViewRestoreGeneration = generation;
    await tick();
    if (!(await waitForRestoredSearch(root, query, generation))) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!canRestoreLibraryView(root, generation) || ocrSearch.query !== query) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    scrollTo(scrollTop);
    abandonLibraryViewRestore(generation);
    return true;
  }

  async function chooseLibraryRoot(): Promise<void> {
    if (jobs.running) return;
    flushLibraryViewState();
    const generation = beginLibraryViewRestore();
    const selected = await catalog.chooseLibraryRoot();
    if (!selected) {
      abandonLibraryViewRestore(generation);
      return;
    }
    if (!(await restoreLibraryView(selected, generation))) return;
    await commands.syncNewLibrary(selected);
  }

  async function selectLibrary(root: string): Promise<void> {
    if (jobs.running || rootsMatch(root, catalog.libraryRoot)) return;
    flushLibraryViewState();
    const generation = beginLibraryViewRestore();
    if (!(await catalog.selectLibrary(root))) {
      abandonLibraryViewRestore(generation);
      return;
    }
    await restoreLibraryView(root, generation);
  }
  async function unregisterLibrary(root: string): Promise<void> {
    const selected = rootsMatch(root, catalog.libraryRoot);
    const generation = selected ? beginLibraryViewRestore() : null;
    const removed = await commands.unregisterLibrary(root);
    if (generation !== null) {
      if (removed) await restoreLibraryView(catalog.libraryRoot, generation);
      else abandonLibraryViewRestore(generation);
    }
  }
  async function removeLibrary(root: string, purge: boolean): Promise<void> {
    if (purge) await commands.removeLibrary(root, true);
    else await unregisterLibrary(root);
  }

  return {
    galleryScroll,
    get gallerySelection() {
      return gallerySelection;
    },
    get activeDialog() {
      return activeDialog;
    },
    get detailIndex() {
      return detailIndex;
    },
    get detailStatus() {
      return detailStatus;
    },
    get searchView() {
      return searchView;
    },
    get filteredItems() {
      return filteredItems;
    },
    get rankedView() {
      return rankedView;
    },
    get galleryLayoutOptions() {
      return galleryLayoutOptions;
    },
    get statusMessage() {
      return statusMessage;
    },
    get jobRunning() {
      return jobRunning;
    },
    get indexingRunning() {
      return indexingRunning;
    },
    get detailItem() {
      return detailItem;
    },
    get libraryName() {
      return libraryName;
    },
    set detailStatus(value: DetailViewStatus | null) {
      detailStatus = value;
    },
    toggleSection,
    closeDialog,
    startWelcomeLibraryPicker,
    openLibrariesDialog,
    openSettingsDialog,
    handleKeydown,
    switchToMeaningSearch,
    openDetail,
    openFileMenu,
    startFileDrag,
    selectGalleryItem,
    beginGalleryMarquee,
    updateGalleryMarquee,
    endGalleryMarquee,
    closeDetail,
    showPrevDetail,
    showNextDetail,
    handleGalleryScroll,
    handleSeek,
    chooseLibraryRoot,
    selectLibrary,
    removeLibrary,
    dispose(): void {
      flushLibraryViewState();
      disposed = true;
      cancelSearchWait?.();
      libraryViewGeneration += 1;
      galleryScroll.finishRestore();
    },
  };
}
