import { get } from "svelte/store";

import type { JobTracker } from "./job-tracker.svelte";

import {
  DEFAULT_OCR_MODEL_LOAD_REQUEST,
  type JobRequest,
  type IndexSelection,
  type JobSnapshot,
} from "../../../shared/backend";
import { errorMessage } from "./errors";
import { clearPendingJob, loadPendingJob, savePendingJob } from "./job-resume";
import { isTerminalJobStatus } from "./job-state";
import { settings } from "./settings.svelte";

/** Coordinates model preparation, indexing continuations, persisted jobs, and library removal.
 * JobTracker owns the current backend job; this class retains the user's intent across jobs. */
export class JobOrchestrator {
  preparingSearchModels = $state(false);
  indexRoot = $state<string | null>(null);
  restartingIndex = $state(false);
  private indexIntent = $state<{
    root: string;
    retryFailed: boolean;
    selection: IndexSelection;
  } | null>(null);
  private indexGeneration = 0;
  private fallbackResumes = 0;

  get indexing(): boolean {
    return this.indexIntent !== null;
  }

  async cancel(): Promise<void> {
    this.indexGeneration += 1;
    this.indexIntent = null;
    this.restartingIndex = false;
    this.finishOcrContinuation(false);
    clearPendingJob();
    await this.jobs.cancel();
  }

  async backendReady(): Promise<void> {
    if (!this.restartingIndex || !this.indexIntent) return;
    const intent = this.indexIntent;
    this.restartingIndex = false;
    await this.startLibraryIndex(intent.root, intent.retryFailed, intent.selection);
  }
  /**
   * An OCR request can be temporarily represented by another job when the backend is compiling
   * models or serving an already-running job. Keep the original library root until its own index
   * job can start; the returned snapshot alone does not carry that request's root. `root === null`
   * means this chain exists only to get models loaded (explicit setup), not to index anything.
   */
  private ocrContinuation: {
    root: string | null;
    retryFailed: boolean;
    stage: "models" | "index";
    jobId: string | null;
  } | null = null;
  /** A purge can only unregister its matching root after that exact job completes. `jobId` is
   * temporarily null while `JobTracker.start` is receiving the initial snapshot, which lets an
   * immediately-terminal job still be handled by `handleTerminalJob`. */
  private libraryPurge: { root: string; jobId: string | null } | null = null;
  /** Job id currently backed by a persisted resume record, so only *its* terminal snapshot clears
   * that record — an unrelated job (e.g. a prune preview) reaching terminal must not. */
  private resumeTrackedJobId: string | null = null;
  /** Explicit setup waits for OCR preparation before preparing the remaining search models. */
  private preparationModelsLoaded = true;
  private modelPreparationReady: Promise<void> = Promise.resolve();
  private resolveModelPreparation: (() => void) | null = null;
  /** Guards `resumeInterruptedJob` to at most one attempt per app session. */
  private startupResumeAttempted = false;

  constructor(
    private readonly jobs: JobTracker,
    /** Reads the currently selected library root at the moment it's needed, rather than a value
     * captured earlier — `resumeInterruptedJob`'s attempt can fire well after app startup, once
     * an in-flight model load settles. */
    private readonly getLibraryRoot: () => string,
    /** Unregisters a library root; called once a `libraryPurge` job this orchestrator started
     * for that root completes successfully. */
    private readonly onUnregisterLibrary: (root: string) => Promise<void>,
    /** Refreshes per-library catalog/embedding counts; called after every terminal job, since any
     * job type can move those numbers. */
    private readonly onLibraryStatusesChanged: () => void,
  ) {}

  private queueOcrContinuation(): void {
    queueMicrotask(() => void this.continueOcrRequest());
  }

  backendDisconnected(providerFallback = false): boolean {
    this.indexGeneration += 1;
    if (providerFallback && this.indexIntent && this.fallbackResumes < 1) {
      this.fallbackResumes += 1;
      this.restartingIndex = true;
    } else {
      this.indexIntent = null;
      this.restartingIndex = false;
    }
    this.finishOcrContinuation(false);
    this.libraryPurge = null;
    this.resumeTrackedJobId = null;
    return this.restartingIndex;
  }

  /** Settles explicit model preparation when its rootless continuation ends. */
  private finishOcrContinuation(loaded: boolean): void {
    const wasModelPreparation = this.ocrContinuation?.root === null;
    this.ocrContinuation = null;
    if (wasModelPreparation && this.resolveModelPreparation) {
      this.preparationModelsLoaded = loaded;
      this.resolveModelPreparation();
      this.resolveModelPreparation = null;
    }
  }

  async startLibraryIndex(
    root: string,
    retryFailed = false,
    selection: IndexSelection = { ocr: true, image: true },
  ): Promise<void> {
    if (!selection.ocr && !selection.image) return;
    const debugLimit = get(settings).debugIndexLimit;
    const request: JobRequest = {
      type: "libraryIndex",
      params: {
        root,
        ...selection,
        scan: {
          recursive: true,
          cleanup: false,
          ...(retryFailed ? { retryFailed: true } : {}),
          ...(debugLimit > 0 ? { debugLimit } : {}),
        },
      },
    };
    if (!this.indexIntent) {
      this.indexGeneration += 1;
      this.fallbackResumes = 0;
      this.indexIntent = { root, retryFailed, selection: { ...selection } };
    }
    this.indexRoot = root;
    const generation = this.indexGeneration;
    // Persist the user's request before model preparation, which can replace the index job and
    // deliberately restart the backend. The model-load job itself is never the resumable intent.
    savePendingJob(root, request);
    this.ocrContinuation = { root, retryFailed, stage: "index", jobId: null };
    const snapshot = await this.jobs.start(request);
    if (generation !== this.indexGeneration) return;
    if (!snapshot) {
      this.finishOcrContinuation(false);
      this.indexIntent = null;
      clearPendingJob();
      return;
    }
    if (snapshot.type === "libraryIndex") {
      this.finishOcrContinuation(true);
      if (!isTerminalJobStatus(snapshot.status)) {
        this.resumeTrackedJobId = snapshot.jobId;
        savePendingJob(root, request);
      }
      return;
    }
    this.ocrContinuation = {
      root,
      retryFailed,
      stage: "index",
      jobId: snapshot.jobId,
    };
    if (isTerminalJobStatus(snapshot.status)) this.handleTerminalJob(snapshot);
  }

  /** A null root prepares models only; a library root continues into indexing. */
  async startOcrModelLoad(root: string | null, retryFailed = false): Promise<void> {
    const generation = this.indexGeneration;
    this.ocrContinuation = { root, retryFailed, stage: "models", jobId: null };
    const snapshot = await this.jobs.start(DEFAULT_OCR_MODEL_LOAD_REQUEST);
    if (generation !== this.indexGeneration) return;
    if (!snapshot) {
      this.finishOcrContinuation(false);
      return;
    }
    this.ocrContinuation = {
      root,
      retryFailed,
      stage: snapshot.type === "ocrModelLoad" ? "index" : "models",
      jobId: snapshot.jobId,
    };
    if (isTerminalJobStatus(snapshot.status)) this.handleTerminalJob(snapshot);
  }

  private async continueOcrRequest(): Promise<void> {
    const continuation = this.ocrContinuation;
    if (!continuation || continuation.jobId !== null) return;
    if (continuation.stage === "models") {
      await this.startOcrModelLoad(continuation.root, continuation.retryFailed);
      return;
    }
    if (continuation.root) {
      const generation = this.indexGeneration;
      try {
        const runtime = await window.nicegal.backend.getRuntimeStatus();
        if (generation !== this.indexGeneration || !this.indexIntent) return;
        // Model preparation can complete just before the server's deliberate provider restart.
        // Do not launch an index into that retiring process during its completion grace period.
        if (
          runtime.restartRequired &&
          runtime.activeExecutionProvider === "directml" &&
          runtime.configuredExecutionProvider === "openvino"
        ) {
          this.restartingIndex = true;
          return;
        }
        await this.startLibraryIndex(
          continuation.root,
          continuation.retryFailed,
          this.indexIntent.selection,
        );
      } catch (error) {
        if (generation !== this.indexGeneration) return;
        this.jobs.error = errorMessage(error);
        this.finishOcrContinuation(false);
        this.indexIntent = null;
        clearPendingJob();
      }
    } else this.finishOcrContinuation(true);
  }

  /** Starts a job and, for the resumable types, records it so an interrupted run picks back up on
   * the next launch — see `lib/job-resume.ts`. */
  async startResumableJob(root: string, request: JobRequest): Promise<JobSnapshot | null> {
    const snapshot = await this.jobs.start(request);
    if (snapshot && isTerminalJobStatus(snapshot.status)) {
      clearPendingJob();
      this.resumeTrackedJobId = null;
    } else if (snapshot) {
      this.resumeTrackedJobId = snapshot.jobId;
      savePendingJob(root, request);
    }
    return snapshot;
  }

  /** Starts (or attaches tracking to) a `libraryPurge` job for `root`; `handleTerminalJob`
   * unregisters the root once that exact job completes successfully. Caller is responsible for
   * the usual `jobs.running` / non-empty-root guard. */
  async purgeLibrary(root: string): Promise<void> {
    this.libraryPurge = { root, jobId: null };
    const snapshot = await this.jobs.start({ type: "libraryPurge", params: { root } });
    if (!snapshot) {
      if (this.libraryPurge?.root === root && this.libraryPurge.jobId === null) {
        this.libraryPurge = null;
      }
      return;
    }
    if (this.libraryPurge?.root === root && this.libraryPurge.jobId === null) {
      this.libraryPurge = { root, jobId: snapshot.jobId };
    }
  }

  /** Starts explicit OCR preparation and exposes its completion to the setup sequence. */
  async prepareOcrModels(): Promise<void> {
    const generation = this.indexGeneration;
    const models = await window.nicegal.backend.getOcrModels();
    if (generation !== this.indexGeneration) return;
    if (models.loaded) {
      this.preparationModelsLoaded = true;
      this.modelPreparationReady = Promise.resolve();
      return;
    }
    this.preparationModelsLoaded = false;
    this.modelPreparationReady = new Promise((resolve) => {
      this.resolveModelPreparation = resolve;
    });
    await this.startOcrModelLoad(null);
  }

  /** One user-facing setup action; the existing OCR continuation settles before search setup. */
  async prepareSearchModels(): Promise<void> {
    if (this.preparingSearchModels || this.jobs.running) return;
    this.preparingSearchModels = true;
    const generation = this.indexGeneration;
    try {
      await this.prepareOcrModels();
      if (generation !== this.indexGeneration) return;
      await this.modelPreparationReady;
      if (generation !== this.indexGeneration) return;
      if (this.preparationModelsLoaded) await this.jobs.start({ type: "modelPrepare", params: {} });
    } catch (error) {
      if (generation === this.indexGeneration) this.jobs.error = errorMessage(error);
    } finally {
      this.preparingSearchModels = false;
    }
  }

  /** Replays an interrupted job once per session, after any active model preparation settles. */
  async resumeInterruptedJob(): Promise<void> {
    await this.modelPreparationReady;
    if (this.startupResumeAttempted) return;
    this.startupResumeAttempted = true;
    if (!this.preparationModelsLoaded || this.jobs.running) return;
    const root = this.getLibraryRoot();
    if (!root) return;
    const pending = loadPendingJob(root);
    if (!pending) return;
    if (pending.type === "libraryIndex")
      // The UI's former force flag meant "retry failures"; do not replay it as a full rebuild.
      await this.startLibraryIndex(
        pending.params.root,
        pending.params.scan?.retryFailed ?? pending.params.scan?.force,
        {
          ocr: pending.params.ocr ?? true,
          image: pending.params.image ?? pending.params.embed ?? true,
          indexVideos: pending.params.indexVideos ?? true,
        },
      );
    else await this.startResumableJob(pending.params.root, pending);
  }

  /** The single place a terminal `JobSnapshot` is interpreted against whichever tracked intent it
   * belongs to, if any. Must be wired as `JobTracker`'s `onTerminal` callback. */
  handleTerminalJob(snapshot: JobSnapshot): void {
    this.onLibraryStatusesChanged();
    if (snapshot.type === "libraryIndex" && this.indexIntent) {
      this.indexIntent = null;
      clearPendingJob();
    }
    if (this.resumeTrackedJobId && snapshot.jobId === this.resumeTrackedJobId) {
      clearPendingJob();
      this.resumeTrackedJobId = null;
    }
    const purge = this.libraryPurge;
    if (
      snapshot.type === "libraryPurge" &&
      purge &&
      (purge.jobId === null || snapshot.jobId === purge.jobId)
    ) {
      this.libraryPurge = null;
      if (snapshot.status === "completed") void this.onUnregisterLibrary(purge.root);
    }
    const continuation = this.ocrContinuation;
    if (!continuation || snapshot.jobId !== continuation.jobId) return;
    if (snapshot.status !== "completed") {
      this.finishOcrContinuation(false);
      this.indexIntent = null;
      clearPendingJob();
      return;
    }
    this.ocrContinuation = { ...continuation, jobId: null };
    this.queueOcrContinuation();
  }
}
