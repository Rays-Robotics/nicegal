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

/**
 * Owns the multi-job *intent* the user (or app startup) expressed, as opposed to `JobTracker`,
 * which only knows about the one job the backend is currently running. Three kinds of intent
 * live here, all funneled through `handleTerminalJob` — the single place a terminal
 * `JobSnapshot` is interpreted against whichever of these intents it belongs to (if any):
 *
 * - OCR continuations (`ocrContinuation`): an OCR model-load or index request can be temporarily
 *   represented by a different job than the one requested (the backend compiling models, or an
 *   already-running job), and this remembers what should happen once that stand-in job
 *   finishes — see `startOcrIndex` / `startOcrModelLoad` / `continueOcrRequest`. A `null` root
 *   marks the app-startup "just get models loaded, don't index anything" case (`prepareOcrModels`);
 *   a real root marks a user-initiated index request that may have been swapped for a model load.
 * - Resume bookkeeping (`resumeTrackedJobId` / `startupModelsReadyPromise` /
 *   `startupResumeAttempted`): which job (if any) is backed by a persisted resume record (see
 *   `lib/job-resume.ts`), and the one-shot startup replay of a job interrupted by the app exiting
 *   mid-run — deferred until the startup model load (if any) has settled, see `prepareOcrModels`
 *   / `resumeInterruptedJob`.
 * - Library purge tracking (`libraryPurge`): a library removal-with-purge only unregisters its
 *   root once its own `libraryPurge` job — and only that job — completes.
 */
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
    await this.startOcrIndex(intent.root, intent.retryFailed, intent.selection);
  }
  /**
   * An OCR request can be temporarily represented by another job when the backend is compiling
   * models or serving an already-running job. Keep the original library root until its own index
   * job can start; the returned snapshot alone does not carry that request's root. `root === null`
   * means this chain exists only to get models loaded (app startup), not to index anything.
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
  /** Whether the app-startup OCR model load (if any) finished with models actually loaded.
   * Defaults to true: when `prepareOcrModels` finds models already loaded, no load runs and
   * `resumeInterruptedJob` should proceed immediately. */
  private startupModelsLoaded = true;
  /** Resolves once the startup model-load chain (root `null`) has fully settled — success,
   * failure, or cancellation. Defaults to an already-resolved promise for the "no load needed"
   * case. */
  private startupModelsReadyPromise: Promise<void> = Promise.resolve();
  private startupModelsReadyResolve: (() => void) | null = null;
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

  /** Clears `ocrContinuation` and, if the chain that just ended was the startup model-load chain
   * (root `null`), resolves `startupModelsReadyPromise` and records whether it ended with models
   * loaded. Safe to call unconditionally at every point the chain ends — a no-op for the
   * startup-detection part when `ocrContinuation.root` isn't `null` or there's no pending
   * resolver. */
  private finishOcrContinuation(loaded: boolean): void {
    const wasStartupLoad = this.ocrContinuation?.root === null;
    this.ocrContinuation = null;
    if (wasStartupLoad && this.startupModelsReadyResolve) {
      this.startupModelsLoaded = loaded;
      this.startupModelsReadyResolve();
      this.startupModelsReadyResolve = null;
    }
  }

  async startOcrIndex(
    root: string,
    retryFailed = false,
    selection: IndexSelection = { ocr: true, image: true },
  ): Promise<void> {
    if (!selection.ocr && !selection.image) return;
    const debugLimit = get(settings).debugIndexLimit;
    const request: JobRequest = {
      type: "ocrIndex",
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
    if (snapshot.type === "ocrIndex") {
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

  /** `root` is only ever non-null for a user-initiated index request that got swapped for a model
   * load (via `continueOcrRequest`'s "models" branch); app-startup model prep passes `null` so the
   * continuation ends when models are ready, instead of implying an index of the whole library —
   * see `prepareOcrModels`. */
  async startOcrModelLoad(root: string | null, retryFailed = false): Promise<void> {
    this.ocrContinuation = { root, retryFailed, stage: "models", jobId: null };
    const snapshot = await this.jobs.start(DEFAULT_OCR_MODEL_LOAD_REQUEST);
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
        await this.startOcrIndex(
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
    if (snapshot) {
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

  /** Loads OCR models if they aren't already, as an app-startup step. Passes `root: null` to
   * `startOcrModelLoad` so this never implies indexing anything — only a user pressing "Index"
   * that gets swapped to a model load (see `startOcrIndex`) should continue on to a real index.
   * Settles `startupModelsReadyPromise` (via `finishOcrContinuation`) once this step's job chain
   * ends, which gates `resumeInterruptedJob`. */
  async prepareOcrModels(): Promise<void> {
    const models = await window.nicegal.backend.getOcrModels();
    if (models.loaded) {
      this.startupModelsLoaded = true;
      this.startupModelsReadyPromise = Promise.resolve();
      return;
    }
    this.startupModelsLoaded = false;
    this.startupModelsReadyPromise = new Promise((resolve) => {
      this.startupModelsReadyResolve = resolve;
    });
    await this.startOcrModelLoad(null);
  }

  /** One user-facing setup action; the existing OCR continuation settles before search setup. */
  async prepareSearchModels(): Promise<void> {
    if (this.preparingSearchModels || this.jobs.running) return;
    this.preparingSearchModels = true;
    try {
      await this.prepareOcrModels();
      await this.startupModelsReadyPromise;
      if (this.startupModelsLoaded) await this.jobs.start({ type: "modelPrepare", params: {} });
    } catch (error) {
      this.jobs.error = errorMessage(error);
    } finally {
      this.preparingSearchModels = false;
    }
  }

  /** Replays a job interrupted by the app exiting mid-run, scoped to the current library root.
   * Runs at most once per app session: immediately if `prepareOcrModels` didn't need to start a
   * model load, or once that load's job chain reaches a terminal state otherwise. If that load
   * failed or was cancelled, nothing is resumed — the replay would hit the same missing-models
   * condition and only add a second failed job. */
  async resumeInterruptedJob(): Promise<void> {
    await this.startupModelsReadyPromise;
    if (this.startupResumeAttempted) return;
    this.startupResumeAttempted = true;
    if (!this.startupModelsLoaded || this.jobs.running) return;
    const root = this.getLibraryRoot();
    if (!root) return;
    const pending = loadPendingJob(root);
    if (!pending) return;
    if (pending.type === "ocrIndex")
      // The UI's former force flag meant "retry failures"; do not replay it as a full rebuild.
      await this.startOcrIndex(
        pending.params.root,
        pending.params.scan?.retryFailed ?? pending.params.scan?.force,
        {
          ocr: pending.params.ocr ?? true,
          image: pending.params.image ?? pending.params.embed ?? true,
        },
      );
    else await this.startResumableJob(pending.params.root, pending);
  }

  /** The single place a terminal `JobSnapshot` is interpreted against whichever tracked intent it
   * belongs to, if any. Must be wired as `JobTracker`'s `onTerminal` callback. */
  handleTerminalJob(snapshot: JobSnapshot): void {
    this.onLibraryStatusesChanged();
    if (snapshot.type === "ocrIndex" && this.indexIntent) {
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
