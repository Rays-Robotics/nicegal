import { type WebContents } from "electron";
import { isAbsolute, resolve } from "node:path";

import type {
  BackendStatus,
  CatalogSyncJobRequest,
  EnsureThumbnailsRequest,
  ExecutionProviderId,
  JobRequest,
  JobSnapshot,
  LibraryPurgeJobRequest,
  OcrIndexJobRequest,
  OcrModelLoadTarget,
  SearchRequest,
  ThumbnailJobRequest,
  Timeline,
} from "../../shared/backend";
import type { NicegalServerClient } from "./nicegal-server-client";

import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { handleTrustedIpc, type IpcSenderValidator } from "../ipc";

interface BackendIpcContext {
  status: BackendStatus;
  client: NicegalServerClient | null;
  isTrustedSender: IpcSenderValidator;
}

interface JobSubscription {
  listeners: Set<WebContents>;
  abort: AbortController;
}

export function registerBackendIpc(context: BackendIpcContext): void {
  const subscriptions = new Map<string, JobSubscription>();
  const searchRequests = new Map<number, AbortController>();
  // Senders that already have a one-shot "destroyed" cleanup hook registered — see
  // `ensureSenderTracked`. Prevents accumulating one listener per subscribeJob/search call.
  const trackedSenders = new Set<WebContents>();

  const requireBackend = (): NicegalServerClient => {
    if (!context.client) {
      throw new Error(context.status.error ?? "nicegal-server is not ready");
    }
    return context.client;
  };

  const removeSubscription = (jobId: string, sender: WebContents): void => {
    const subscription = subscriptions.get(jobId);
    if (!subscription) return;
    subscription.listeners.delete(sender);
    if (subscription.listeners.size === 0) {
      subscription.abort.abort();
      subscriptions.delete(jobId);
    }
  };

  const removeSender = (sender: WebContents): void => {
    for (const [jobId] of subscriptions) removeSubscription(jobId, sender);
    searchRequests.get(sender.id)?.abort();
    searchRequests.delete(sender.id);
  };

  // Registers the destroyed-cleanup hook for `sender` exactly once, no matter how many times
  // (or from which handler — search, subscribeJob, ...) it is called for that sender.
  const ensureSenderTracked = (sender: WebContents): void => {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    sender.once("destroyed", () => {
      trackedSenders.delete(sender);
      removeSender(sender);
    });
  };

  handleTrustedIpc(IPC_CHANNELS.backend.status, context.isTrustedSender, () => context.status);
  handleTrustedIpc(IPC_CHANNELS.backend.getRuntimeStatus, context.isTrustedSender, () =>
    requireBackend().getRuntimeStatus(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.setExecutionProvider,
    context.isTrustedSender,
    (_event, value: unknown) => {
      return requireBackend().setExecutionProvider(validateExecutionProvider(value));
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.listAssets,
    context.isTrustedSender,
    (_event, value: unknown) => {
      const { root, timeline } = validateListAssetsRequest(value);
      return requireBackend().listAssets(root, timeline);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.assetMetadata,
    context.isTrustedSender,
    (_event, value: unknown) => {
      if (
        typeof value !== "string" ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      ) {
        throw new TypeError("Asset ID must be a safe positive decimal string");
      }
      return requireBackend().getAssetMetadata(value);
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.catalogRevision, context.isTrustedSender, () =>
    requireBackend().getRevision(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.countAssets,
    context.isTrustedSender,
    (_event, value: unknown) => requireBackend().countAssets(validateAbsoluteRoot(value)),
  );
  handleTrustedIpc(
    IPC_CHANNELS.backend.getTextEmbeddingCoverage,
    context.isTrustedSender,
    (_event, value: unknown) => {
      return requireBackend().getTextEmbeddingCoverage(validateAbsoluteRoot(value));
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.getOcrModels, context.isTrustedSender, () =>
    requireBackend().getOcrModels(),
  );
  handleTrustedIpc(IPC_CHANNELS.backend.getSearchModels, context.isTrustedSender, () =>
    requireBackend().getSearchModels(),
  );
  handleTrustedIpc(IPC_CHANNELS.backend.search, context.isTrustedSender, async (event, value) => {
    const request = validateSearchRequest(value);
    ensureSenderTracked(event.sender);
    searchRequests.get(event.sender.id)?.abort();
    const abort = new AbortController();
    searchRequests.set(event.sender.id, abort);
    try {
      return await requireBackend().search(request, abort.signal);
    } finally {
      if (searchRequests.get(event.sender.id) === abort) searchRequests.delete(event.sender.id);
    }
  });
  // Deliberately not cancelled by a later call, unlike search: an in-flight ensure represents
  // real generation work already committed toward SQLite, so aborting it would only throw away
  // completed work and force a retry. The renderer's own flush loop already serializes its calls;
  // see the "flushing" guard in VirtualGallery.svelte.
  handleTrustedIpc(
    IPC_CHANNELS.backend.ensureThumbnails,
    context.isTrustedSender,
    async (_event, value) => {
      const request = validateEnsureThumbnailsRequest(value);
      return requireBackend().ensureThumbnails(request);
    },
  );
  handleTrustedIpc(IPC_CHANNELS.backend.startJob, context.isTrustedSender, (_event, value) => {
    return requireBackend().startJob(validateJobRequest(value));
  });
  handleTrustedIpc(IPC_CHANNELS.backend.cancelJob, context.isTrustedSender, (_event, value) => {
    return requireBackend().cancelJob(validateJobId(value));
  });
  handleTrustedIpc(IPC_CHANNELS.backend.subscribeJob, context.isTrustedSender, (event, value) => {
    const jobId = validateJobId(value);
    const client = requireBackend();
    let subscription = subscriptions.get(jobId);
    if (!subscription) {
      // Captured by name in the closures below (instead of re-reading the mutable outer
      // `subscription` binding) so each invocation's watch loop only ever acts on — and only
      // ever tears down — the exact subscription object it created. Without this, an aborted
      // watch whose promise settles late can delete a *newer* subscription that has since taken
      // its place at the same jobId key, orphaning the new watch's snapshots (see finding notes).
      const created: JobSubscription = {
        listeners: new Set<WebContents>(),
        abort: new AbortController(),
      };
      subscription = created;
      subscriptions.set(jobId, created);
      void client
        .watchJob(
          jobId,
          (snapshot: JobSnapshot) => {
            if (subscriptions.get(jobId) !== created) return;
            for (const listener of created.listeners) {
              if (!listener.isDestroyed()) {
                listener.send(IPC_CHANNELS.backend.jobSnapshot, { jobId, snapshot });
              }
            }
          },
          created.abort.signal,
          (error) => {
            if (subscriptions.get(jobId) !== created) return;
            for (const listener of created.listeners) {
              if (!listener.isDestroyed())
                listener.send(IPC_CHANNELS.backend.jobConnection, { jobId, error });
            }
          },
        )
        .catch((error: unknown) => {
          if (!created.abort.signal.aborted) {
            console.error(`Job ${jobId} subscription failed`, error);
          }
        })
        .finally(() => {
          if (subscriptions.get(jobId) === created) subscriptions.delete(jobId);
        });
    }
    subscription.listeners.add(event.sender);
    ensureSenderTracked(event.sender);
  });
  handleTrustedIpc(IPC_CHANNELS.backend.unsubscribeJob, context.isTrustedSender, (event, value) => {
    removeSubscription(validateJobId(value), event.sender);
  });
}

function validateTimeline(value: unknown): Timeline {
  if (value !== "modified" && value !== "capture") throw new TypeError("Invalid timeline");
  return value;
}

function validateListAssetsRequest(value: unknown): { root: string; timeline: Timeline } {
  if (!value || typeof value !== "object") throw new TypeError("Invalid asset listing request");
  const request = value as { root?: unknown; timeline?: unknown };
  return { root: validateAbsoluteRoot(request.root), timeline: validateTimeline(request.timeline) };
}

function validateAbsoluteRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("Invalid library root");
  return resolve(value);
}

function validateExecutionProvider(value: unknown): ExecutionProviderId {
  if (value !== "cpu" && value !== "directml" && value !== "openvino") {
    throw new TypeError("Invalid execution provider");
  }
  return value;
}

function validateJobId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new TypeError("Invalid job ID");
  return value;
}

function validateSearchRequest(value: unknown): SearchRequest {
  if (!value || typeof value !== "object") throw new TypeError("Invalid search request");
  const request = value as Partial<SearchRequest>;
  if (
    typeof request.query !== "string" ||
    request.query.length > 10_000 ||
    (request.type !== "simple" &&
      request.type !== "match" &&
      request.type !== "glob" &&
      request.type !== "vector" &&
      request.type !== "image") ||
    typeof request.root !== "string" ||
    !isAbsolute(request.root) ||
    (request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 250_000))
  ) {
    throw new TypeError("Invalid search request");
  }
  if (request.imageQuery !== undefined && !validateImageQuery(request.imageQuery)) {
    throw new TypeError("Invalid image query");
  }
  if (request.imageQuery !== undefined && request.type !== "image") {
    throw new TypeError("Image components require image search");
  }
  if (request.imageQuery === undefined && !request.query.trim()) {
    throw new TypeError("Search query is required");
  }
  return request as SearchRequest;
}

function validateImageQuery(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.components) || !value.components.length || value.components.length > 16) return false;
  let imageBytes = 0;
  return value.components.every((component) => {
    if (!isRecord(component) || typeof component.weight !== "number" || !Number.isFinite(component.weight) || component.weight === 0 || Math.abs(component.weight) > 100) return false;
    const sources = Number("text" in component) + Number("assetId" in component) + Number("externalImage" in component);
    if (sources !== 1) return false;
    if (typeof component.text === "string") return component.text.trim().length > 0 && new TextEncoder().encode(component.text).length <= 4096;
    if (typeof component.assetId === "number") return Number.isSafeInteger(component.assetId) && component.assetId > 0;
    if (!isRecord(component.externalImage) || typeof component.externalImage.bytesBase64 !== "string") return false;
    const bytes = component.externalImage.bytesBase64.length;
    imageBytes += bytes;
    return bytes > 0 && bytes <= 22_369_624 && imageBytes <= 44_739_248;
  });
}

function validateEnsureThumbnailsRequest(value: unknown): EnsureThumbnailsRequest {
  if (!value || typeof value !== "object") throw new TypeError("Invalid ensure-thumbnails request");
  const request = value as Partial<EnsureThumbnailsRequest>;
  if (
    !Array.isArray(request.assetIds) ||
    request.assetIds.length === 0 ||
    request.assetIds.length > 500 ||
    !request.assetIds.every((id) => typeof id === "string" && /^\d+$/.test(id)) ||
    typeof request.requiredSize !== "number" ||
    !Number.isInteger(request.requiredSize) ||
    request.requiredSize < 1 ||
    request.requiredSize > 1024
  ) {
    throw new TypeError("Invalid ensure-thumbnails request");
  }
  return request as EnsureThumbnailsRequest;
}

// Uniformly strict across every job type: validates that `value` is `{ type, params }` with no
// extra top-level keys, that `params` is a record, and that `params` itself carries only the
// given whitelist of keys. Returns the whitelisted-shape params record for the branch to pick
// apart and rebuild explicitly — nothing from `params` should ever be spread through as-is.
function requireJobParams(
  value: Record<string, unknown>,
  paramFields: readonly string[],
  errorMessage: string,
): Record<string, unknown> {
  const params = (value as { params?: unknown }).params;
  if (
    !hasOnlyFields(value, ["type", "params"]) ||
    !isRecord(params) ||
    !hasOnlyFields(params, paramFields)
  ) {
    throw new TypeError(errorMessage);
  }
  return params;
}

function validateJobRequest(value: unknown): JobRequest {
  if (!isRecord(value)) throw new TypeError("Invalid job request");
  const request = value as { type?: unknown; params?: unknown };
  if (request.type === "modelPrepare") {
    requireJobParams(value, [], "Invalid model preparation job");
    return { type: "modelPrepare", params: {} };
  }
  if (request.type === "ocrIndex") {
    const params = requireJobParams(value, ["root", "embed", "scan"], "Invalid OCR index job");
    if (params.embed !== undefined && typeof params.embed !== "boolean") {
      throw new TypeError("Invalid OCR index job");
    }
    const root = validateAbsoluteRoot(params.root);
    const scan = validateOcrIndexScan(params.scan);
    const job: OcrIndexJobRequest = {
      type: "ocrIndex",
      params: {
        root,
        ...(params.embed === undefined ? {} : { embed: params.embed as boolean }),
        ...(scan === undefined ? {} : { scan }),
      },
    };
    return job;
  }
  if (request.type === "ocrModelLoad") {
    const params = requireJobParams(
      value,
      ["detection", "recognition"],
      "Invalid OCR model load job",
    );
    return {
      type: "ocrModelLoad",
      params: {
        detection: validateOcrModelLoadTarget(params.detection),
        recognition: validateOcrModelLoadTarget(params.recognition),
      },
    };
  }
  if (request.type === "catalogSync") {
    const params = requireJobParams(value, ["root", "scan"], "Invalid catalog sync job");
    if (params.scan !== undefined && !isCatalogSyncScan(params.scan)) {
      throw new TypeError("Invalid catalog sync job");
    }
    const job: CatalogSyncJobRequest = {
      type: "catalogSync",
      params: {
        root: validateAbsoluteRoot(params.root),
        ...(params.scan === undefined ? {} : { scan: params.scan }),
      },
    };
    return job;
  }
  if (request.type === "pruneMissing") {
    const params = requireJobParams(value, ["root", "dryRun"], "Invalid missing-file prune job");
    if (typeof params.dryRun !== "boolean") {
      throw new TypeError("Invalid missing-file prune job");
    }
    return {
      type: "pruneMissing",
      params: { root: validateAbsoluteRoot(params.root), dryRun: params.dryRun },
    };
  }
  if (request.type === "libraryPurge") {
    const params = requireJobParams(value, ["root"], "Invalid library purge job");
    const job: LibraryPurgeJobRequest = {
      type: "libraryPurge",
      params: { root: validateAbsoluteRoot(params.root) },
    };
    return job;
  }
  if (request.type === "thumbnailGenerate") {
    const params = requireJobParams(
      value,
      ["root", "buckets", "force", "sweepStale", "timeline", "range"],
      "Invalid thumbnail generation job",
    );
    if (!isThumbnailGenerateParams(params)) throw new TypeError("Invalid thumbnail generation job");
    const job: ThumbnailJobRequest = {
      type: "thumbnailGenerate",
      params: {
        ...params,
        root: validateAbsoluteRoot(params.root),
      },
    };
    return job;
  }
  throw new TypeError("Unsupported job type");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function isCatalogSyncScan(
  value: unknown,
): value is NonNullable<CatalogSyncJobRequest["params"]["scan"]> {
  if (!isRecord(value) || !hasOnlyFields(value, ["recursive", "exclude", "debugLimit"]))
    return false;
  return (
    (value.recursive === undefined || typeof value.recursive === "boolean") &&
    (value.exclude === undefined ||
      (Array.isArray(value.exclude) &&
        value.exclude.every((pattern) => typeof pattern === "string"))) &&
    (value.debugLimit === undefined ||
      (typeof value.debugLimit === "number" &&
        Number.isSafeInteger(value.debugLimit) &&
        value.debugLimit > 0))
  );
}

function validateOcrIndexScan(value: unknown): OcrIndexJobRequest["params"]["scan"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      "recursive",
      "exclude",
      "force",
      "retryFailed",
      "cleanup",
      "maxDimensions",
    ]) ||
    (value.recursive !== undefined && typeof value.recursive !== "boolean") ||
    (value.exclude !== undefined &&
      (!Array.isArray(value.exclude) ||
        !value.exclude.every((pattern) => typeof pattern === "string"))) ||
    (value.force !== undefined && typeof value.force !== "boolean") ||
    (value.retryFailed !== undefined && typeof value.retryFailed !== "boolean") ||
    // `cleanup` may only ever be omitted or explicitly `false` — the backend does not accept
    // requesting cleanup from the renderer.
    (value.cleanup !== undefined && value.cleanup !== false) ||
    (value.maxDimensions !== undefined && !isMaxDimensions(value.maxDimensions))
  ) {
    throw new TypeError("Invalid OCR index job");
  }
  return {
    ...(value.recursive === undefined ? {} : { recursive: value.recursive as boolean }),
    ...(value.exclude === undefined ? {} : { exclude: value.exclude as string[] }),
    ...(value.force === undefined ? {} : { force: value.force as boolean }),
    ...(value.retryFailed === undefined ? {} : { retryFailed: value.retryFailed as boolean }),
    ...(value.cleanup === undefined ? {} : { cleanup: value.cleanup as false }),
    ...(value.maxDimensions === undefined
      ? {}
      : { maxDimensions: value.maxDimensions as { width: number; height: number } }),
  };
}

function isMaxDimensions(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ["width", "height"]) &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function validateOcrModelLoadTarget(value: unknown): OcrModelLoadTarget {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["modelId", "revision", "filename", "configFilename"]) ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    (value.revision !== undefined && typeof value.revision !== "string") ||
    (value.filename !== undefined && typeof value.filename !== "string") ||
    (value.configFilename !== undefined && typeof value.configFilename !== "string")
  ) {
    throw new TypeError("Invalid OCR model load job");
  }
  return {
    modelId: value.modelId,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.filename === undefined ? {} : { filename: value.filename }),
    ...(value.configFilename === undefined ? {} : { configFilename: value.configFilename }),
  };
}

function isThumbnailGenerateParams(value: unknown): value is ThumbnailJobRequest["params"] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["root", "buckets", "force", "sweepStale", "timeline", "range"]) ||
    typeof value.root !== "string" ||
    (value.buckets !== undefined &&
      (!Array.isArray(value.buckets) ||
        !value.buckets.every(
          (bucket) => bucket === 128 || bucket === 256 || bucket === 512 || bucket === 1024,
        ))) ||
    (value.force !== undefined && typeof value.force !== "boolean") ||
    (value.sweepStale !== undefined && typeof value.sweepStale !== "boolean") ||
    (value.timeline !== undefined && value.timeline !== "modified" && value.timeline !== "capture")
  ) {
    return false;
  }
  return isTimelineRange(value.range);
}

function isTimelineRange(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyFields(value, ["fromNs", "toNs"]) &&
      (value.fromNs === undefined || typeof value.fromNs === "string") &&
      (value.toNs === undefined || typeof value.toNs === "string"))
  );
}
