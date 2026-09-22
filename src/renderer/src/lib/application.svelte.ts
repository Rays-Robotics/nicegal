import { createContext } from "svelte";
import { get } from "svelte/store";

import type { JobSnapshot } from "../../../shared/backend";
import type { ThumbnailBackfillOptions } from "./job-params";

import { CatalogController, rootsMatch } from "./catalog.svelte";
import { ONBOARDING_DISMISSED_STORAGE_KEY } from "./constants";
import { errorMessage } from "./errors";
import { JobOrchestrator } from "./job-orchestrator.svelte";
import { JobTracker } from "./job-tracker.svelte";
import { rootKey } from "./library-root";
import { OcrSearchController } from "./ocr-search.svelte";
import { RuntimeController } from "./runtime.svelte";
import { libraryIndexing, settings } from "./settings.svelte";

type IndexBucket = 128 | 256 | 512 | 1024;

export interface ApplicationServices {
  readonly catalog: CatalogController;
  readonly runtime: RuntimeController;
  readonly ocrSearch: OcrSearchController;
  readonly jobs: JobTracker;
  readonly orchestrator: JobOrchestrator;
}

export interface ApplicationCommands {
  readonly showFileContextMenu: (assetIds: string[]) => Promise<void>;
  readonly startFileDrag: (assetIds: string[], isCurrent: () => boolean) => Promise<void>;
  readonly startCatalogSync: (root: string) => Promise<JobSnapshot | null>;
  readonly syncNewLibrary: (root: string) => Promise<void>;
  readonly startIndex: (root: string, retryFailed?: boolean) => Promise<void>;
  readonly startThumbnailBackfill: (
    root: string,
    options: ThumbnailBackfillOptions,
  ) => Promise<void>;
  readonly dismissJobResult: () => void;
  readonly unregisterLibrary: (root: string) => Promise<boolean>;
  readonly removeLibrary: (root: string, purge: boolean) => Promise<void>;
  readonly dismissWelcome: () => void;
  readonly showWelcome: () => void;
}

export interface ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  readonly initialized: boolean;
  readonly librarySelectionRevision: number;
  readonly welcomeVisible: boolean;
}

class Application implements ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  initialized = $state(false);
  librarySelectionRevision = $state(0);
  welcomeVisible = $state(false);

  private started = false;
  private backendInitialized = false;
  private manualImageIndexRoot: string | null = null;

  constructor() {
    const ocrSearch = new OcrSearchController();
    const catalog = new CatalogController();
    const runtime = new RuntimeController();
    const jobs: JobTracker = new JobTracker(
      (delay) => catalog.scheduleRefresh(delay),
      () => catalog.bumpThumbnailRevision(),
      (snapshot) => {
        if (snapshot.type === "libraryIndex" && this.manualImageIndexRoot) {
          if (snapshot.status === "completed" && snapshot.indexStages?.image)
            this.rememberImageIndex(this.manualImageIndexRoot);
          this.manualImageIndexRoot = null;
        }
        orchestrator.handleTerminalJob(snapshot);
        void runtime.refreshModels();
      },
    );
    const orchestrator = new JobOrchestrator(
      jobs,
      () => catalog.libraryRoot,
      async (root) => {
        await this.handleOrchestratedLibraryRemoval(root);
      },
      () => catalog.refreshLibraryStatuses(),
    );

    this.services = Object.freeze({ catalog, runtime, ocrSearch, jobs, orchestrator });
    this.commands = Object.freeze({
      startFileDrag: async (assetIds: string[], isCurrent: () => boolean) => {
        const token = await window.nicegal.native.prepareFileDrag({ assetIds });
        // A release, cancellation, or newer press during resolution must not start a late drag.
        if (isCurrent()) await window.nicegal.native.startFileDrag(token);
      },
      showFileContextMenu: (assetIds: string[]) =>
        window.nicegal.native.showFileContextMenu({ assetIds }),
      startCatalogSync: (root: string) => this.startCatalogSync(root),
      syncNewLibrary: (root: string) => this.syncNewLibrary(root),
      startIndex: (root: string, retryFailed?: boolean) => this.startIndex(root, retryFailed),
      startThumbnailBackfill: (root: string, options: ThumbnailBackfillOptions) =>
        this.startThumbnailBackfill(root, options),
      dismissJobResult: () => this.dismissJobResult(),
      unregisterLibrary: (root: string) => this.unregisterLibrary(root),
      removeLibrary: (root: string, purge: boolean) => this.removeLibrary(root, purge),
      dismissWelcome: () => this.dismissWelcome(),
      showWelcome: () => {
        this.welcomeVisible = true;
      },
    });
  }

  start(): () => void {
    if (this.started) throw new Error("Application lifecycle already started");
    this.started = true;

    const { catalog, runtime } = this.services;
    const unsubscribeSettings = settings.subscribe((value) => catalog.onSettingsChange(value));
    const unsubscribeVisualSearch = window.nicegal.native.onAddToVisualSearch(
      (assetIds, replace) => {
        this.services.ocrSearch.addLibraryReferences(
          catalog.items
            .filter((item) => assetIds.includes(item.id))
            .map((item) => ({ id: item.id, displayName: item.displayName })),
          replace,
        );
      },
    );
    const unsubscribeBackendStatus = window.nicegal.backend.onBackendStatusChanged((status) => {
      const recovered = !catalog.backendStatus.ready && status.ready;
      const disconnected = catalog.backendStatus.ready && !status.ready;
      catalog.applyBackendStatus(status);
      if (status.error && this.services.orchestrator.restartingIndex) {
        this.services.orchestrator.backendDisconnected();
      }
      if (disconnected) {
        runtime.reset();
        const providerFallback = status.restartReason === "provider-fallback";
        const resuming = this.services.orchestrator.backendDisconnected(providerFallback);
        this.services.jobs.backendDisconnected(resuming);
      }
      if (recovered) {
        if (this.backendInitialized) {
          void runtime.refresh();
          void runtime.refreshModels();
        }
        void catalog.refresh();
        void this.initializeReadyBackend();
        void this.services.orchestrator.backendReady();
      }
    });
    const revisionPoll = setInterval(() => void catalog.pollRevision(), 2_000);
    void this.initialize();

    return () => {
      unsubscribeSettings();
      unsubscribeVisualSearch();
      unsubscribeBackendStatus();
      clearInterval(revisionPoll);
      this.services.ocrSearch.dispose();
      catalog.dispose();
      this.services.jobs.dispose();
      this.started = false;
    };
  }

  private async initialize(): Promise<void> {
    const { catalog, jobs } = this.services;
    try {
      await catalog.initialize();
      this.initialized = true;
      if (catalog.backendStatus.ready) await this.initializeReadyBackend();
    } catch (error) {
      this.initialized = true;
      jobs.error = errorMessage(error);
    }
  }

  private async initializeReadyBackend(): Promise<void> {
    if (this.backendInitialized) return;
    this.backendInitialized = true;
    const { catalog, runtime, orchestrator, jobs } = this.services;
    this.welcomeVisible = !catalog.libraryRoot && !this.welcomeWasDismissed();
    void catalog.refreshLibraryStatuses();
    void runtime.refresh();
    void runtime.refreshModels();
    try {
      await orchestrator.resumeInterruptedJob();
      if (!jobs.running && !orchestrator.indexing && catalog.libraryRoot) {
        await this.startQuickSync(catalog.libraryRoot);
      }
    } catch (error) {
      jobs.error = errorMessage(error);
    }
  }

  private imageIndexKey(root: string): string {
    return `nicegal:image-indexed:${rootKey(root)}`;
  }

  private rememberImageIndex(root: string): void {
    try {
      localStorage.setItem(this.imageIndexKey(root), "1");
    } catch {
      /* Best effort. */
    }
  }

  private async startQuickSync(root: string): Promise<void> {
    const { jobs, catalog } = this.services;
    if (jobs.running) return;
    let image = false;
    if (libraryIndexing(get(settings), root).image) {
      try {
        const coverage = await window.nicegal.backend.getImageEmbeddingCoverage(root);
        image = coverage.indexed > 0;
      } catch {
        // Coverage is optional for the catalog pass; skip CLIP if its history is unknown.
      }
      try {
        image ||= localStorage.getItem(this.imageIndexKey(root)) === "1";
      } catch {
        // Coverage can still establish CLIP history when browser storage is unavailable.
      }
    }
    if (jobs.running || !rootsMatch(root, catalog.libraryRoot)) return;
    // A library added before automatic preparation may never have been indexed.
    if (!image && libraryIndexing(get(settings), root).image) {
      await this.syncNewLibrary(root);
      return;
    }
    await this.startCatalogSync(root, { newOnly: true, image });
  }

  private async startCatalogSync(
    root: string,
    quick: { newOnly: true; image: boolean } | null = null,
  ): Promise<JobSnapshot | null> {
    const { jobs } = this.services;
    if (jobs.running || !root) return null;
    const debugLimit = get(settings).debugIndexLimit;
    return jobs.start(
      {
        type: "catalogSync",
        params: {
          root,
          ...(quick ? { image: quick.image } : {}),
          scan: {
            recursive: true,
            ...(quick ? { newOnly: true } : {}),
            ...(debugLimit > 0 ? { debugLimit } : {}),
          },
        },
      },
      quick !== null,
    );
  }

  private async syncNewLibrary(root: string): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running || orchestrator.indexing || !root) return;
    if (!libraryIndexing(get(settings), root).image) {
      await this.startCatalogSync(root);
      return;
    }
    this.manualImageIndexRoot = root;
    await orchestrator.startLibraryIndex(root, false, { ocr: false, image: true });
    if (!jobs.running && !orchestrator.indexing) this.manualImageIndexRoot = null;
  }

  private async startIndex(root: string, retryFailed = false): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running || orchestrator.indexing || !root) return;
    const { ocr, image } = libraryIndexing(get(settings), root);
    if (!ocr && !image) return;
    if (image) this.manualImageIndexRoot = root;
    await orchestrator.startLibraryIndex(root, retryFailed, { ocr, image });
    if (!jobs.running && !orchestrator.indexing) this.manualImageIndexRoot = null;
  }

  private async startThumbnailBackfill(
    root: string,
    options: ThumbnailBackfillOptions,
  ): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running || !root) return;
    const buckets = this.toBucketList(options.buckets);
    const { sortField } = get(settings);
    await orchestrator.startResumableJob(root, {
      type: "thumbnailGenerate",
      params: {
        root,
        buckets: buckets.length ? buckets : undefined,
        timeline: sortField,
        range:
          options.fromNs || options.toNs
            ? { fromNs: options.fromNs, toNs: options.toNs }
            : undefined,
      },
    });
  }

  private dismissJobResult(): void {
    this.services.jobs.dismiss();
  }

  private async unregisterLibrary(root: string): Promise<boolean> {
    return this.services.catalog.unregisterLibrary(root);
  }

  private async handleOrchestratedLibraryRemoval(root: string): Promise<void> {
    const selected = rootsMatch(root, this.services.catalog.libraryRoot);
    const removed = await this.unregisterLibrary(root);
    if (removed && selected) this.librarySelectionRevision += 1;
  }

  private async removeLibrary(root: string, purge: boolean): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running || !root) return;
    if (purge) {
      await orchestrator.purgeLibrary(root);
      return;
    }
    await this.unregisterLibrary(root);
  }

  private welcomeWasDismissed(): boolean {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private dismissWelcome(): void {
    this.welcomeVisible = false;
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, "1");
    } catch {
      // The welcome has still been dismissed for this session if browser storage is unavailable.
    }
  }

  private toBucketList(values: number[]): IndexBucket[] {
    const validBuckets: readonly number[] = [128, 256, 512, 1024];
    return values.filter((value): value is IndexBucket => validBuckets.includes(value));
  }
}

const [getApplication, setApplication] = createContext<ApplicationContext>();

export function createApplication(): ApplicationContext & { start(): () => void } {
  return new Application();
}

export function provideApplication(application: ApplicationContext): void {
  setApplication(application);
}

export function useApplication(): ApplicationContext {
  return getApplication();
}
