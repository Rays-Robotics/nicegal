import { createContext } from "svelte";
import { get } from "svelte/store";

import type { JobSnapshot } from "../../../shared/backend";
import type { ThumbnailBackfillOptions } from "./job-params";

import { CatalogController, rootsMatch } from "./catalog.svelte";
import { ONBOARDING_DISMISSED_STORAGE_KEY } from "./constants";
import { errorMessage } from "./errors";
import { JobOrchestrator } from "./job-orchestrator.svelte";
import { JobTracker } from "./job-tracker.svelte";
import { OcrSearchController } from "./ocr-search.svelte";
import { RuntimeController } from "./runtime.svelte";
import { settings } from "./settings.svelte";

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

  constructor() {
    const catalog = new CatalogController();
    const runtime = new RuntimeController();
    const ocrSearch = new OcrSearchController();
    const jobs = new JobTracker(
      (delay) => catalog.scheduleRefresh(delay),
      () => catalog.bumpThumbnailRevision(),
      (snapshot) => {
        orchestrator.handleTerminalJob(snapshot);
        void runtime.refreshModels();
        if (snapshot.type === "ocrModelLoad" && snapshot.status === "completed") {
          void runtime.refreshActualProvider();
        }
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
        void runtime.refresh();
        void runtime.refreshActualProvider();
        void runtime.refreshModels();
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
    } catch (error) {
      jobs.error = errorMessage(error);
    }
  }

  private async startCatalogSync(root: string): Promise<JobSnapshot | null> {
    const { jobs } = this.services;
    if (jobs.running || !root) return null;
    const debugLimit = get(settings).debugIndexLimit;
    return jobs.start({
      type: "catalogSync",
      params: {
        root,
        scan: {
          recursive: true,
          ...(debugLimit > 0 ? { debugLimit } : {}),
        },
      },
    });
  }

  private async syncNewLibrary(root: string): Promise<void> {
    await this.startCatalogSync(root);
  }

  private async startIndex(root: string, retryFailed = false): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running || orchestrator.indexing || !root) return;
    await orchestrator.startOcrIndex(root, retryFailed);
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
