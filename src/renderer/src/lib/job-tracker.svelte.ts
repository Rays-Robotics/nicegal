import type { JobRequest, JobSnapshot } from "../../../shared/backend";

import { cleanDiagnostic, errorMessage } from "./errors";
import { summarizeCompletion } from "./job-format";
import { isTerminalJobStatus } from "./job-state";

const COMPLETION_MESSAGE_MS = 6_000;

export class JobTracker {
  active = $state<JobSnapshot | null>(null);
  /** Covers the request/response gap before the backend returns the first job snapshot. */
  starting = $state(false);
  root = $state<string | null>(null);
  error = $state("");
  connectionError = $state<string | null>(null);
  /** Transient result line for the status bar after a terminal job result. */
  completionMessage = $state("");

  private previousCataloged = 0;
  private previousPhase: JobSnapshot["phase"] | null = null;
  private refreshedThumbnailJobId: string | null = null;
  private libraryIndexEmbeds = false;
  private unsubscribe: (() => void) | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** A job subscription can send its terminal snapshot more than once while it winds down. */
  private completedJobId: string | null = null;
  /** The job this tracker is currently subscribed to — kept separately from `active` since
   * `active` can go back to null on a clean completion while the subscription is still live. */
  private currentJobId: string | null = null;
  private generation = 0;
  private cancelRequested = false;

  constructor(
    private readonly onCatalogRefresh: (delay: number) => void,
    private readonly onThumbnailsGenerated: () => void,
    /** Fires once, exactly when a job reaches a terminal status — independent of whether `active`
     * goes on to clear itself, so callers that need to observe "this job finished" (e.g. clearing
     * a resume record) don't miss it if it's cleared within the same tick. */
    private readonly onTerminal: (snapshot: JobSnapshot) => void,
  ) {}

  get running(): boolean {
    return this.starting || Boolean(this.active && !isTerminalJobStatus(this.active.status));
  }

  async start(request: JobRequest): Promise<JobSnapshot | null> {
    if (this.running) return null;
    const generation = ++this.generation;
    this.cancelRequested = false;
    this.root = "root" in request.params ? request.params.root : null;
    this.error = "";
    this.connectionError = null;
    this.completionMessage = "";
    this.libraryIndexEmbeds = request.type === "libraryIndex" && request.params.embed !== false;
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }

    let snapshot: JobSnapshot;
    this.starting = true;
    try {
      snapshot = await window.nicegal.backend.startJob(request);
    } catch (error) {
      // Leave the previous job's subscription and `active` snapshot exactly as they were — a
      // failed start must not drop the old subscription while its (now-frozen) snapshot stays
      // on screen.
      if (generation === this.generation) this.error = errorMessage(error);
      return null;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
    if (generation !== this.generation) return null;

    // Only now that the new job actually started do we tear down the previous subscription.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.active = snapshot;
    this.currentJobId = snapshot.jobId;
    this.completedJobId = null;
    this.previousCataloged = snapshot.progress.cataloged;
    this.previousPhase = snapshot.phase;
    this.handleSnapshot(snapshot);
    if (!isTerminalJobStatus(snapshot.status)) {
      this.unsubscribe = window.nicegal.backend.subscribeJob(
        snapshot.jobId,
        (next) => {
          if (generation === this.generation) this.handleSnapshot(next);
        },
        (error) => {
          if (generation === this.generation)
            this.connectionError = error ? errorMessage(error) : null;
        },
      );
    }
    if (this.cancelRequested) await this.cancel();
    return snapshot;
  }

  async cancel(): Promise<void> {
    if (this.starting) {
      this.cancelRequested = true;
      return;
    }
    if (!this.active || isTerminalJobStatus(this.active.status)) return;
    const generation = this.generation;
    try {
      const snapshot = await window.nicegal.backend.cancelJob(this.active.jobId);
      if (generation === this.generation) this.handleSnapshot(snapshot);
    } catch (error) {
      if (generation === this.generation) this.error = errorMessage(error);
    }
  }

  /**
   * Acknowledges a terminal result or an operation error.
   */
  dismiss(): void {
    this.error = "";
    this.completionMessage = "";
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    if (!this.active || !isTerminalJobStatus(this.active.status)) return;

    this.active = null;
  }

  dispose(): void {
    this.generation += 1;
    this.unsubscribe?.();
    if (this.completionTimer) clearTimeout(this.completionTimer);
  }

  backendDisconnected(restarting = false): void {
    const interrupted = this.running;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentJobId = null;
    this.active = null;
    this.starting = false;
    this.connectionError = null;
    if (restarting) this.error = "";
    else if (interrupted)
      this.error =
        "The gallery service stopped before this job finished. Once it is available, retry setup or indexing to continue. Completed work is retained.";
  }

  private handleSnapshot(snapshot: JobSnapshot): void {
    if (this.currentJobId && snapshot.jobId !== this.currentJobId) return;
    if (snapshot.jobId === this.completedJobId) return;
    this.connectionError = null;
    snapshot = {
      ...snapshot,
      ...(snapshot.error ? { error: cleanDiagnostic(snapshot.error) } : {}),
      errors: snapshot.errors.map((error) => ({
        ...error,
        message: cleanDiagnostic(error.message),
      })),
    };
    const catalogAdvanced = snapshot.progress.cataloged > this.previousCataloged;
    const enteredThumbnailPhase =
      snapshot.phase === "thumbnails" && this.previousPhase !== "thumbnails";
    const generatedThumbnails =
      isTerminalJobStatus(snapshot.status) &&
      snapshot.progress.thumbnailsGenerated > 0 &&
      this.refreshedThumbnailJobId !== snapshot.jobId;
    const isTerminal = Boolean(isTerminalJobStatus(snapshot.status));

    this.active = snapshot;
    this.previousCataloged = snapshot.progress.cataloged;
    this.previousPhase = snapshot.phase;

    if (catalogAdvanced) this.onCatalogRefresh(250);
    if (generatedThumbnails) {
      this.refreshedThumbnailJobId = snapshot.jobId;
      this.onThumbnailsGenerated();
    }
    if (enteredThumbnailPhase || isTerminal) this.onCatalogRefresh(0);
    if (isTerminal) {
      this.completedJobId = snapshot.jobId;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onTerminal(snapshot);
      // A terminal result that needs a destructive confirmation or acknowledgement stays in the
      // canonical job indicator until dismissed. Otherwise fold it into the status bar and free
      // the toolbar space.
      const needsAttention =
        snapshot.status === "failed" || Boolean(snapshot.error) || snapshot.errors.length > 0;
      if (!needsAttention) {
        this.completionMessage = summarizeCompletion(snapshot, this.libraryIndexEmbeds);
        // Keep successful work in the toolbar until the user opens then closes its progress card.
        // Fast jobs otherwise mount and unmount between paints, making completion invisible.
        if (snapshot.status !== "completed") this.active = null;
        this.completionTimer = setTimeout(() => {
          this.completionMessage = "";
          this.completionTimer = null;
        }, COMPLETION_MESSAGE_MS);
      }
    }
  }
}
