import type {
  JobRequest,
  LibraryIndexJobRequest,
  ThumbnailJobRequest,
} from "../../../shared/backend";

import { JOB_RESUME_STORAGE_KEY } from "./constants";

/**
 * Job types worth auto-resuming after an interrupted app exit. `libraryIndex` and
 * `thumbnailGenerate` are explicitly documented as safe to retry — their writes are fingerprinted/upserted, so
 * replaying the same request just skips whatever already finished (see "Jobs" in
 * `nicegal-server/INTERNAL_API.md`). `pruneMissing` is deliberately excluded: it is a destructive,
 * user-confirmed action and must never restart on its own, especially a non-dry-run deletion.
 */
export type ResumableJobRequest = LibraryIndexJobRequest | ThumbnailJobRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isResumable(request: unknown): request is ResumableJobRequest {
  if (!isRecord(request) || !isRecord(request.params) || !hasOwn(request.params, "root"))
    return false;
  const candidate = request as { type?: unknown; params: { root?: unknown } };
  return (
    (candidate.type === "libraryIndex" || candidate.type === "thumbnailGenerate") &&
    isRoot(candidate.params.root)
  );
}

interface PendingJob {
  root: string;
  request: ResumableJobRequest;
}

/** Records in-flight job intent so it can be replayed if the app exits before the job finishes. */
export function savePendingJob(root: string, request: JobRequest): void {
  if (!isRoot(root) || !isResumable(request) || request.params.root !== root) return;
  try {
    localStorage.setItem(
      JOB_RESUME_STORAGE_KEY,
      JSON.stringify({ root, request } satisfies PendingJob),
    );
  } catch {
    // Best-effort only; losing the resume hint just means no auto-resume next launch.
  }
}

/** Call once a tracked job reaches a confirmed terminal state (completed/failed/cancelled). */
export function clearPendingJob(): void {
  try {
    localStorage.removeItem(JOB_RESUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Converts the one historical thumbnail resume representation into the current
 * request contract. Library-index records have always carried their root in params and
 * therefore remain strict.
 */
function normalizePendingRequest(root: string, request: unknown): ResumableJobRequest | null {
  if (!isRecord(request) || !isRecord(request.params)) return null;

  if (request.type === "libraryIndex") {
    if (
      !hasOwn(request.params, "root") ||
      !isRoot(request.params.root) ||
      request.params.root !== root
    ) {
      return null;
    }
    return {
      ...request,
      type: "libraryIndex",
      params: { ...request.params, root },
    } as LibraryIndexJobRequest;
  }

  if (request.type !== "thumbnailGenerate") return null;

  if (
    hasOwn(request.params, "root") &&
    (!isRoot(request.params.root) || request.params.root !== root)
  ) {
    return null;
  }

  return {
    ...request,
    type: "thumbnailGenerate",
    params: {
      ...request.params,
      root,
    },
  } as ThumbnailJobRequest;
}

/** Returns the pending job to replay, if any, scoped to the currently active library root. */
export function loadPendingJob(root: string): ResumableJobRequest | null {
  try {
    const raw = localStorage.getItem(JOB_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRoot(root) ||
      !isRecord(parsed) ||
      !hasOwn(parsed, "root") ||
      !isRoot(parsed.root) ||
      parsed.root !== root ||
      !hasOwn(parsed, "request")
    ) {
      return null;
    }
    return normalizePendingRequest(root, parsed.request);
  } catch {
    return null;
  }
}
