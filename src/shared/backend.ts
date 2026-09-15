export type Timeline = "modified" | "capture";

export interface BackendStatus {
  ready: boolean;
  error: string | null;
  /** A deliberate provider fallback may resume the user's indexing intent once ready. */
  restartReason?: "provider-fallback" | "runtime-change";
}

/** See `nicegal_core::runtime::ExecutionProvider`. */
export type ExecutionProviderId = "cpu" | "directml" | "openvino" | "webgpu";

export interface ImageModelStatus {
  activeModel: string;
  selectedModel: string;
  supportsTextQueries: boolean;
  restartRequired: boolean;
  models: {
    id: string;
    name: string;
    dimensions: number;
    license: string;
    url: string;
    available: boolean;
    supportsTextQueries: boolean;
  }[];
}

/** `GET`/`PUT /v1/runtime` — the ONNX Runtime provider nicegal-server is running with, and the
 * persisted choice for its next launch. They differ right after a change, since the server never
 * replaces its already-loaded runtime in place. */
export interface RuntimeStatus {
  availableExecutionProviders?: ExecutionProviderId[];
  imageModel: ImageModelStatus;
  activeExecutionProvider: string;
  activeRuntimeDistribution: string;
  onnxRuntimeBuildInfo: string;
  configuredExecutionProvider: string;
  restartRequired: boolean;
}

export interface GalleryAsset {
  id: string;
  path: string;
  displayName: string;
  /** File-system extension as written on disk, without its leading dot. */
  extension: string | null;
  modifiedNs: string;
  /** Source file creation time when the platform exposes one. */
  createdNs: string | null;
  captureNs: string | null;
  sourceSize: string;
  mediaKind: "image" | "video";
  mediaFormat: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  frameCount: number | null;
  durationMs: number | null;
}

export interface AssetMetadata {
  asset: GalleryAsset;
  file: {
    sourceState: "current" | "changed" | "missing" | "unavailable";
    attributes: string[];
    exif: Array<{ label: string; value: string }>;
    error: string | null;
  };
  ocrState: "indexed" | "stale" | "notIndexed";
  /** Recognized text for the current file fingerprint, or null until OCR has indexed it. */
  ocrText: string | null;
  imageIndexed: boolean;
  textState: "notIndexed" | "noText" | "embedded" | "pending";
  decodeFailed: boolean;
}

/** Canonical file details and OCR state from the Rust asset lookup API. Main-process OS
 * integrations resolve renderer-supplied IDs here rather than trusting renderer-supplied paths. */
export interface CatalogAssetDetails {
  id: string;
  path: string;
  displayName: string;
  folderPath: string | null;
  extension: string | null;
  modifiedNs: string;
  createdNs: string | null;
  captureNs: string | null;
  sourceSize: number;
  mediaKind: "image" | "video";
  mediaFormat: string;
  width: number | null;
  height: number | null;
  animated: boolean;
  frameCount: number | null;
  durationMs: number | null;
  indexState: "indexed" | "stale" | "notIndexed";
}

export interface ResolveAssetsResponse {
  assets: CatalogAssetDetails[];
  missingAssetIds: string[];
}

export interface NativeFileMenuRequest {
  assetIds: string[];
}

/** A session-only snapshot chosen through Electron's native file picker. It is never catalogued. */
export interface ExternalVisualReference {
  displayName: string;
  bytesBase64: string;
}

export interface SearchRequest {
  /** IPC-only generation, increasing within this renderer's lifetime. Supply with searchLane. */
  searchSession?: number;
  /** Independent requests in one session may run concurrently; each lane is latest-wins. */
  searchLane?: "literal" | "meaning" | "visual";
  query: string;
  type: "simple" | "match" | "glob" | "vector" | "image";
  root: string;
  limit?: number;
  before?: string;
  after?: string;
  /** Required by the backend whenever a time bound is present. */
  timeline?: Timeline;
  /** Structured CLIP components use POST /v1/search. `query` stays empty: sending it as well
   * would add the text a second time to the composite direction. */
  imageQuery?: ImageQuery;
}

export type ImageQueryComponent =
  | { text: string; weight: number }
  | { assetId: number; weight: number }
  | { externalImage: { bytesBase64: string }; weight: number };

export interface ImageQuery {
  components: ImageQueryComponent[];
}

/** OCR-text embedding coverage for one library root — `GET /v1/text-embeddings`. Tells "nothing
 * matched" apart from "nothing has been text-embedded yet". */
export interface TextEmbeddingCoverage {
  indexed: number;
  embedded: number;
  pending: number;
  /**
   * Unix seconds of the newest indexed source file under the root, or null when nothing is
   * indexed. The backend has no wall-clock record of when indexing ran, so this is its stand-in;
   * an older server omits the field entirely, which reads as null here.
   */
  lastIndexedAt: number | null;
}

/** Current CLIP coverage for cataloged images under one root, excluding videos. */
export interface ImageEmbeddingCoverage {
  total: number;
  indexed: number;
}

export interface SearchResult {
  assetId: string;
  snippet: string;
  /**
   * Position in this mode's own final ranking, from 1 — already reranked server-side, so the
   * response array is in rank order. Absent from an older server, where response order is the
   * only ranking signal there is.
   */
  rank?: number;
  /** Cosine distance for OCR-vector and CLIP image hits; absent from literal OCR matches. */
  distance?: number;
  /**
   * The mode's own relevance score: FTS5 `bm25()` for `match` (lower is better) or matching-word
   * count for `glob` (higher is better). Not comparable across modes — use `rank` for ordering.
   */
  score?: number;
}

export interface SearchResponse {
  total: number;
  results: SearchResult[];
}

export type JobStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type JobPhase =
  | "queued"
  | "downloadingModels"
  | "loadingModels"
  | "scanning"
  | "cataloging"
  | "thumbnails"
  | "ocr"
  | "imageEmbedding"
  | "textEmbedding"
  | "cleanup"
  | "pruning"
  | "finished";

export interface JobProgress {
  discovered: number;
  /** Denominator of the CURRENT phase (null = phase progress is indeterminate). */
  total: number | null;
  /** Items completed within the CURRENT phase — pair with `total` for the within-phase bar. */
  phaseCompleted: number;
  /** Backend-measured average rate for this phase; null before any work completes.
   * OCR excludes skipped images, including results retained when resuming.
   * Optional while an older backend binary is in use. */
  itemsPerSecond?: number | null;
  processed: number;
  cataloged: number;
  thumbnailsGenerated: number;
  thumbnailFailures: number;
  pruneCandidates: number;
  embedded: number;
  indexed: number;
  skipped: number;
  failed: number;
  deleted: number;
  downloadedBytes: number;
  downloadTotalBytes: number;
  /** Current model file; absent for cache hits and while loading sessions. */
  download?: {
    modelId: string;
    filename: string;
    downloadedBytes: number;
    /** Zero while the remote size is unknown. */
    totalBytes: number;
  };
  modelsLoaded: number;
}

export interface JobItemError {
  path?: string;
  message: string;
}

export interface JobSnapshot {
  indexStages?: { ocr: boolean; image: boolean; text: boolean };
  jobId: string;
  type:
    | "ocrModelLoad"
    | "modelPrepare"
    | "ocrIndex"
    | "catalogSync"
    | "thumbnailGenerate"
    | "pruneMissing"
    | "libraryPurge";
  status: JobStatus;
  phase: JobPhase;
  progress: JobProgress;
  /** In-flight paths, including parallel workers; cleared on phase changes and completion. */
  activeAssetPaths?: string[];
  errors: JobItemError[];
  error?: string;
}

export interface IndexSelection {
  ocr: boolean;
  image: boolean;
}

export interface OcrIndexJobRequest {
  type: "ocrIndex";
  params: {
    root: string;
    /** Select text recognition and image search independently; both default to true. */
    ocr?: boolean;
    image?: boolean;
    /** Continue into pending CLIP-image and OCR-text embeddings after OCR (default true backend-side). */
    embed?: boolean;
    scan?: {
      recursive?: boolean;
      exclude?: string[];
      /** Re-run OCR on unchanged files and retry cached decode failures (default false). */
      force?: boolean;
      /** Retry cached indexing failures while retaining successful current results. */
      retryFailed?: boolean;
      cleanup?: false;
      maxDimensions?: { width: number; height: number };
      /** Debug cap applied to each indexing phase. */
      debugLimit?: number;
    };
  };
}

export interface OcrModelLoadTarget {
  modelId: string;
  revision?: string;
  filename?: string;
  configFilename?: string;
}

export interface OcrModelLoadJobRequest {
  type: "ocrModelLoad";
  params: {
    detection: OcrModelLoadTarget;
    recognition: OcrModelLoadTarget;
  };
}

export const DEFAULT_OCR_MODEL_LOAD_REQUEST: OcrModelLoadJobRequest = {
  type: "ocrModelLoad",
  params: {
    detection: {
      modelId: "PaddlePaddle/PP-OCRv6_small_det_onnx",
      revision: "main",
      filename: "inference.onnx",
      configFilename: "inference.yml",
    },
    recognition: {
      modelId: "PaddlePaddle/PP-OCRv6_small_rec_onnx",
      revision: "main",
      filename: "inference.onnx",
      configFilename: "inference.yml",
    },
  },
};

export interface OcrLoadedModel {
  modelId: string;
  revision: string;
  filename: string;
}

export interface OcrModelsResponse {
  loaded?: {
    detection: OcrLoadedModel;
    recognition: OcrLoadedModel;
    executionProvider: string;
  };
}

export interface SearchModelStatus {
  state: "notLoaded" | "preparing" | "ready" | "failed" | "unsupported";
  error: string | null;
}

export interface SearchModelsResponse {
  text: SearchModelStatus;
  clipImage: SearchModelStatus;
  clipText: SearchModelStatus;
}

export interface ThumbnailJobRequest {
  type: "thumbnailGenerate";
  params: {
    root: string;
    buckets?: Array<128 | 256 | 512 | 1024>;
    force?: boolean;
    sweepStale?: boolean;
    timeline?: Timeline;
    range?: { fromNs?: string; toNs?: string };
  };
}

export interface CatalogSyncJobRequest {
  type: "catalogSync";
  params: {
    root: string;
    scan?: {
      recursive?: boolean;
      exclude?: string[];
      /** Debug-only cap on discovered catalog entries. Omit to scan the complete root. */
      debugLimit?: number;
    };
  };
}

export interface PruneMissingJobRequest {
  type: "pruneMissing";
  params: {
    root: string;
    dryRun: boolean;
  };
}

export interface LibraryPurgeJobRequest {
  type: "libraryPurge";
  params: {
    root: string;
  };
}

export type JobRequest =
  | { type: "modelPrepare"; params: Record<string, never> }
  | OcrModelLoadJobRequest
  | OcrIndexJobRequest
  | CatalogSyncJobRequest
  | ThumbnailJobRequest
  | PruneMissingJobRequest
  | LibraryPurgeJobRequest;

/**
 * Synchronous on-demand thumbnail generation for a visible-tile batch — `POST /v1/thumbnails`,
 * distinct from the background `thumbnailGenerate` job. Generator version 1 no longer builds
 * thumbnails eagerly during `ocrIndex`; the gallery calls this for whatever is actually on screen.
 */
export interface EnsureThumbnailsRequest {
  assetIds: string[];
  /** Physical pixels; 1 through 1024. Selects the smallest adequate fixed bucket. */
  requiredSize: number;
}

export interface EnsureThumbnailsResponse {
  assetIds: string[];
  requiredSize: number;
  sizeBucket: number;
  generatorVersion: number;
}

export interface BackendBridge {
  getBackendStatus(): Promise<BackendStatus>;
  /** Receives a fresh `BackendStatus` whenever the main process's view of it changes on its own —
   * today, only when the nicegal-server process exits unexpectedly. */
  onBackendStatusChanged(listener: (status: BackendStatus) => void): () => void;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  setImageModel(model: string): Promise<RuntimeStatus>;
  setExecutionProvider(executionProvider: ExecutionProviderId): Promise<RuntimeStatus>;
  listAssets(options: { root: string; timeline: Timeline }): Promise<GalleryAsset[]>;
  countAssets(root: string): Promise<number>;
  getAssetMetadata(assetId: string): Promise<AssetMetadata>;
  getCatalogRevision(): Promise<string>;
  getOcrModels(): Promise<OcrModelsResponse>;
  getSearchModels(): Promise<SearchModelsResponse>;
  searchOcr(request: SearchRequest): Promise<SearchResponse>;
  /** Abort all current searches and close their session. The next session must be newer. */
  cancelSearch(): Promise<void>;
  getTextEmbeddingCoverage(root: string): Promise<TextEmbeddingCoverage>;
  getImageEmbeddingCoverage(root: string): Promise<ImageEmbeddingCoverage>;
  startJob(request: JobRequest): Promise<JobSnapshot>;
  cancelJob(jobId: string): Promise<JobSnapshot>;
  subscribeJob(
    jobId: string,
    listener: (snapshot: JobSnapshot) => void,
    onConnection?: (error: string | null) => void,
  ): () => void;
  ensureThumbnails(request: EnsureThumbnailsRequest): Promise<EnsureThumbnailsResponse>;
}

export interface NativeBridge {
  openExternalUrl(url: string): Promise<void>;
  openLicenseInformation(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseVisualSearchImage(): Promise<ExternalVisualReference | null>;
  onAddToVisualSearch(listener: (assetIds: string[], replace: boolean) => void): () => void;
  showFileContextMenu(request: NativeFileMenuRequest): Promise<void>;
  prepareFileDrag(request: NativeFileMenuRequest): Promise<string>;
  startFileDrag(token: string): Promise<void>;
}

export interface NicegalBridge {
  updates: import("./updates").UpdateBridge;
  backend: BackendBridge;
  native: NativeBridge;
}
