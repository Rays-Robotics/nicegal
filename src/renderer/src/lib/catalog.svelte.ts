import { SvelteMap } from "svelte/reactivity";
import { get } from "svelte/store";

import type {
  BackendStatus,
  GalleryAsset,
  ImageEmbeddingCoverage,
  Timeline,
} from "../../../shared/backend";

import { LIBRARIES_STORAGE_KEY, LIBRARY_ROOT_STORAGE_KEY } from "./constants";
import { errorMessage } from "./errors";
import { aspectRatioOf, type GalleryItem } from "./gallery/types";
import { settings, type GallerySettings } from "./settings.svelte";

/** Persisted metadata and restorable view state for one library root. */
export interface LibraryRecord {
  root: string;
  displayName: string;
  /** The unparsed search text, so a library restores exactly what the user entered. */
  query: string;
  scrollTop: number;
}

export type LibraryViewStatePatch = Partial<Pick<LibraryRecord, "query" | "scrollTop">>;

/** Independent catalog and embedding counts rendered beside each registered library. */
export interface LibraryRowStatus {
  imageCoverage?: ImageEmbeddingCoverage | null;
  cataloged: number;
  indexed: number;
  embedded: number;
  pending: number;
  /** Unix seconds of the newest indexed file under the root; null when the backend has none. */
  lastIndexedAt: number | null;
  loading: boolean;
  error: string | null;
}

interface LibraryRegistry {
  libraries: LibraryRecord[];
  selectedRoot: string;
}

function emptyLibraryRowStatus(): LibraryRowStatus {
  return {
    cataloged: 0,
    indexed: 0,
    embedded: 0,
    pending: 0,
    lastIndexedAt: null,
    loading: false,
    error: null,
  };
}

// The main process (`nicegal-server-client.ts#getTextEmbeddingCoverage`) already validates this shape
// with an equivalent `isCount` guard before it crosses IPC, so today this can only ever see a
// well-formed payload or a rejected promise. We still re-check here because the IPC boundary's
// `TextEmbeddingCoverage` contract is enforced only by TypeScript types, which are erased at compile
// time and not verified at runtime by Electron's IPC layer. The renderer and main process are
// built and can be edited independently; a future change to the main-side validation (or a
// stubbed/mocked backend in dev) would otherwise hand this class an untyped `any` straight
// through with no runtime signal. Keeping this check is cheap insurance against that drift, not
// evidence that main is currently wrong.
function statusCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid text embedding coverage ${field} count`);
  }
  return value;
}

function normalizeTextEmbeddingCoverage(
  value: unknown,
): Pick<LibraryRowStatus, "indexed" | "embedded" | "pending" | "lastIndexedAt"> {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid text embedding coverage response");
  }
  const coverage = value as Record<string, unknown>;
  return {
    indexed: statusCount(coverage.indexed, "indexed"),
    embedded: statusCount(coverage.embedded, "embedded"),
    pending: statusCount(coverage.pending, "pending"),
    // Unlike the counts, a missing timestamp is legitimate — an unindexed root has none, and so
    // does a server built before the field existed. Absent reads as null rather than throwing.
    lastIndexedAt:
      typeof coverage.lastIndexedAt === "number" && Number.isFinite(coverage.lastIndexedAt)
        ? coverage.lastIndexedAt
        : null,
  };
}

function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

function rootKey(root: string): string {
  return isWindows() ? root.toLowerCase() : root;
}

export function rootsMatch(left: string, right: string): boolean {
  return rootKey(left) === rootKey(right);
}

function displayNameFor(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || root;
}

function normalizeLibraryRecord(value: unknown): LibraryRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LibraryRecord>;
  if (typeof record.root !== "string") return null;
  const root = record.root.trim();
  if (!root) return null;
  return {
    root,
    displayName:
      typeof record.displayName === "string" && record.displayName.trim()
        ? record.displayName.trim()
        : displayNameFor(root),
    query: typeof record.query === "string" ? record.query : "",
    scrollTop:
      typeof record.scrollTop === "number" && Number.isFinite(record.scrollTop)
        ? Math.max(0, record.scrollTop)
        : 0,
  };
}

function normalizeLibraries(values: unknown[]): LibraryRecord[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupe set, scoped to this call, never read reactively
  const keys = new Set<string>();
  const libraries: LibraryRecord[] = [];
  for (const entry of values) {
    const library = normalizeLibraryRecord(entry);
    if (!library) continue;
    const key = rootKey(library.root);
    if (keys.has(key)) continue;
    keys.add(key);
    libraries.push(library);
  }
  return libraries;
}

/**
 * Owns the asset catalog: what's loaded from the backend, the library root it was loaded from,
 * the library registry, and the polling/refresh plumbing that keeps it in sync with
 * catalog-mutating jobs.
 *
 * Pulled out of `App.svelte` because these fields and their refresh-adjacent methods are one
 * concern — loading and re-loading the catalog — separate from job orchestration (`JobTracker`)
 * and OCR search (`OcrSearchController`), which `App` wires together but does not need to reach
 * into the internals of. Application owns cross-controller job and library orchestration.
 */
export class CatalogController {
  /** Catalog snapshots are replaced as a whole. Avoid deep proxies for tens of thousands of
   * immutable rows; publish a new array if an asset changes. */
  items = $state.raw<GalleryItem[]>([]);
  loading = $state(true);
  loadError = $state("");
  backendStatus = $state<BackendStatus>({ ready: false, error: null });
  /** Every known root, including the saved raw query and scroll position for each one. */
  libraries = $state<LibraryRecord[]>([]);
  /** The selected library's canonical root, or empty when no libraries are registered. */
  selectedRoot = $state("");
  /**
   * Per-root counts used by the library dialog; keys are canonical registered roots.
   * `SvelteMap` gives fine-grained reactivity for single-row updates (set/delete) without
   * copying the whole map on every row change; it satisfies the `ReadonlyMap` prop type
   * `LibrariesDialog` expects.
   */
  libraryStatuses = new SvelteMap<string, LibraryRowStatus>();

  /** Compatibility surface for existing single-library callers. */
  get libraryRoot(): string {
    return this.selectedRoot;
  }

  /** Timeline field the currently-loaded `items` were sorted/grouped by; `null` until first load. */
  private loadedTimeline: Timeline | null = null;
  /** Backend catalog revision as of the last successful load, used only for change polling. */
  private catalogRevision = $state("");
  /** Bumped on every `refresh()` call; a response that lands after a newer one starts is dropped. */
  private generation = 0;
  /** Cache-busting counter stamped onto items, advanced whenever a job regenerates thumbnails. */
  private thumbnailRevision = $state(0);
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Prevents the two-second revision interval from stacking requests behind a slow backend. */
  private revisionPollPending = false;
  /** Invalidates every outstanding row-status pass when a newer pass starts. */
  private libraryStatusGeneration = 0;
  /** Invalidates status completions for one root when its cataloged count can change. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- generation counters are private bookkeeping, never read reactively by the UI
  private readonly libraryStatusRootGenerations = new Map<string, number>();
  /** Set when a catalog load supersedes row-status work; the winning catalog load retries it. */
  private libraryStatusRefreshRequested = false;

  constructor() {
    const registry = this.loadRegistry();
    this.libraries = registry.libraries;
    this.selectedRoot = registry.selectedRoot;
    this.libraryStatuses = new SvelteMap(
      registry.libraries.map((library) => [library.root, emptyLibraryRowStatus()]),
    );
  }

  /** Fetches backend status and, if ready, loads the catalog. Call once, from `onMount`. */
  async initialize(): Promise<void> {
    this.backendStatus = await window.nicegal.backend.getBackendStatus();
    if (this.backendStatus.ready) await this.refresh();
    else this.loading = false;
  }

  /** Applies a status pushed live from the main process — today, only an nicegal-server crash.
   * See `onBackendStatusChanged` wiring in `App.svelte`. */
  applyBackendStatus(status: BackendStatus): void {
    this.backendStatus = status;
  }

  /** Re-loads `items` from the backend. A response overtaken by a newer `refresh()` is discarded. */
  async refresh(timeline: Timeline = get(settings).sortField): Promise<void> {
    if (!this.backendStatus.ready) return;
    const generation = ++this.generation;
    this.loading = true;
    this.loadError = "";
    const root = this.libraryRoot;
    this.invalidateLibraryStatusRequest(root);
    if (!root) {
      this.items = [];
      this.catalogRevision = "";
      this.loadedTimeline = null;
      this.loading = false;
      return;
    }
    try {
      const assets = await window.nicegal.backend.listAssets({ root, timeline });
      if (generation !== this.generation) return;
      this.items = assets.map((asset) => this.mapGalleryAsset(asset, timeline));
      // Record what was actually loaded so `onSettingsChange` can tell a real sort-field change
      // from a settings emission that leaves the loaded timeline untouched. Without this, only
      // `onSettingsChange` itself ever wrote `loadedTimeline`, so `refreshSelectedLibrary`'s reset
      // to `null` (before calling `refresh`) was never overwritten by the load it triggered — the
      // very next settings emission, even a no-op one for sortField, then saw a spurious mismatch
      // against `null` and fired a redundant second full reload right after a library switch.
      this.loadedTimeline = timeline;
      this.updateSelectedCatalogCount();
      const revision = await window.nicegal.backend.getCatalogRevision();
      if (generation !== this.generation) return;
      this.catalogRevision = revision;
    } catch (error) {
      if (generation === this.generation) {
        const message = errorMessage(error);
        this.loadError = message;
        this.updateLibraryStatus(root, {
          ...this.statusFor(root),
          loading: false,
          error: message,
        });
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        if (this.libraryStatusRefreshRequested) {
          this.libraryStatusRefreshRequested = false;
          void this.refreshLibraryStatuses();
        }
      }
    }
  }

  /** Debounced refresh, used after a job reports catalog progress. */
  scheduleRefresh(delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  /** Cheap poll for a changed catalog revision (e.g. another window indexed); refreshes on change. */
  async pollRevision(): Promise<void> {
    if (
      this.revisionPollPending ||
      !this.backendStatus.ready ||
      document.visibilityState !== "visible"
    )
      return;
    this.revisionPollPending = true;
    const generation = this.generation;
    try {
      const revision = await window.nicegal.backend.getCatalogRevision();
      if (generation !== this.generation) return;
      if (this.catalogRevision && revision !== this.catalogRevision) await this.refresh();
      else this.catalogRevision = revision;
      const root = this.selectedRoot;
      if (root && generation === this.generation) {
        const imageCoverage = await window.nicegal.backend.getImageEmbeddingCoverage(root);
        if (generation === this.generation && root === this.selectedRoot) {
          this.updateLibraryStatus(root, { ...this.statusFor(root), imageCoverage });
        }
      }
    } catch (error) {
      console.warn("Catalog revision poll failed", error);
      if (generation === this.generation && this.selectedRoot) {
        this.updateLibraryStatus(this.selectedRoot, {
          ...this.statusFor(this.selectedRoot),
          imageCoverage: null,
        });
      }
    } finally {
      this.revisionPollPending = false;
    }
  }

  /** Re-loads when the settings store's sort field changes; a no-op for any other settings change. */
  onSettingsChange(value: GallerySettings): void {
    if (value.sortField === this.loadedTimeline) return;
    this.loadedTimeline = value.sortField;
    if (this.backendStatus.ready) void this.refresh(value.sortField);
  }

  /** Advances the thumbnail cache-buster; call after a job regenerates thumbnails. */
  bumpThumbnailRevision(): void {
    this.thumbnailRevision += 1;
  }

  /**
   * Refreshes independent catalog and embedding counts for every library row. Failures stay on
   * their row so a malformed response for one root cannot blank otherwise healthy rows.
   */
  async refreshLibraryStatuses(): Promise<void> {
    if (!this.backendStatus.ready) return;

    const generation = ++this.libraryStatusGeneration;
    const libraries = [...this.libraries];
    const selectedRoot = this.selectedRoot;
    const selectedCataloged = this.items.length;
    // `this.items` is only trustworthy as the selected root's count once a `refresh()` has
    // finished landing it; mid-load it is stale (the previous root's items, or empty). Snapshot
    // `loading` now rather than fetch a shortcut count that a concurrent refresh could invalidate.
    const selectedLoading = this.loading;
    for (const library of libraries) {
      this.updateLibraryStatus(library.root, {
        ...this.statusFor(library.root),
        loading: true,
        error: null,
      });
    }

    await Promise.all(
      libraries.map(async ({ root }) => {
        const rootGeneration = this.libraryStatusRootGeneration(root);
        try {
          // Only take the `this.items.length` shortcut for the selected root when no catalog
          // load is in flight for it; mid-load that count is stale or zero, and this pass writes
          // `loading: false` over it before the in-flight `refresh()` can correct it.
          const catalogedRequest =
            root === selectedRoot && !selectedLoading
              ? Promise.resolve(selectedCataloged)
              : window.nicegal.backend.countAssets(root).then((count) => {
                  if (!Number.isSafeInteger(count) || count < 0)
                    throw new Error("Invalid catalog status response");
                  return count;
                });
          const [cataloged, rawCoverage, imageCoverage] = await Promise.all([
            catalogedRequest,
            window.nicegal.backend.getTextEmbeddingCoverage(root),
            window.nicegal.backend.getImageEmbeddingCoverage(root),
          ]);
          const coverage = normalizeTextEmbeddingCoverage(rawCoverage);
          if (!this.isCurrentLibraryStatusRequest(root, generation, rootGeneration)) return;
          this.updateLibraryStatus(root, {
            cataloged,
            imageCoverage,
            ...coverage,
            loading: false,
            error: null,
          });
        } catch (error) {
          if (!this.isCurrentLibraryStatusRequest(root, generation, rootGeneration)) return;
          this.updateLibraryStatus(root, {
            ...this.statusFor(root),
            imageCoverage: null,
            loading: false,
            error: errorMessage(error),
          });
        }
      }),
    );
  }

  /**
   * Adds a root to the registry if it is not already present. The existing record wins when
   * Windows reports the same root with different casing, preserving its canonical spelling.
   */
  registerLibrary(root: string): LibraryRecord | null {
    const library = normalizeLibraryRecord({ root });
    if (!library) return null;
    const existing = this.libraries.find((candidate) => rootsMatch(candidate.root, library.root));
    if (existing) return existing;

    const libraries = [...this.libraries, library];
    this.replaceRegistry(libraries, this.selectedRoot || library.root);
    this.updateLibraryStatus(library.root, emptyLibraryRowStatus());
    return library;
  }

  /**
   * Selects a registered library, resets the loaded catalog, and loads the newly selected root.
   * Returns false when `root` is not registered.
   */
  async selectLibrary(root: string): Promise<boolean> {
    const library = this.libraries.find((candidate) => rootsMatch(candidate.root, root));
    if (!library) return false;

    if (this.selectedRoot !== library.root) {
      this.invalidateLibraryStatusRequest(this.selectedRoot);
      this.invalidateLibraryStatusRequest(library.root);
      this.replaceRegistry(this.libraries, library.root);
    }
    await this.refreshSelectedLibrary();
    return true;
  }

  /**
   * Removes a registered root. When it was selected, the record now occupying its position is
   * selected; if it was the final record, the previous record is selected instead.
   */
  async unregisterLibrary(root: string): Promise<boolean> {
    const index = this.libraries.findIndex((candidate) => rootsMatch(candidate.root, root));
    if (index < 0) return false;

    const removed = this.libraries[index];
    const libraries = this.libraries.filter((_, candidateIndex) => candidateIndex !== index);
    const selected = rootsMatch(removed.root, this.selectedRoot);
    const selectedRoot = selected
      ? (libraries[index]?.root ?? libraries[index - 1]?.root ?? "")
      : this.selectedRoot;
    this.invalidateLibraryStatusRequest(removed.root);
    if (selected) this.invalidateLibraryStatusRequest(selectedRoot);
    this.replaceRegistry(libraries, selectedRoot);
    this.libraryStatuses.delete(removed.root);
    // Otherwise this map grows for the lifetime of the session: entries are only ever added
    // (`invalidateLibraryStatusRequest`, called above) or read, never pruned on unregister.
    this.libraryStatusRootGenerations.delete(rootKey(removed.root));

    if (selected) await this.refreshSelectedLibrary();
    return true;
  }

  /** Persists raw search text and scroll position for one registered root. */
  updateLibraryViewState(root: string, patch: LibraryViewStatePatch): void {
    const index = this.libraries.findIndex((candidate) => rootsMatch(candidate.root, root));
    if (index < 0) return;

    const current = this.libraries[index];
    const query = typeof patch.query === "string" ? patch.query : current.query;
    const scrollTop =
      typeof patch.scrollTop === "number" && Number.isFinite(patch.scrollTop)
        ? Math.max(0, patch.scrollTop)
        : current.scrollTop;
    if (query === current.query && scrollTop === current.scrollTop) return;

    const libraries = [...this.libraries];
    libraries[index] = { ...current, query, scrollTop };
    this.replaceRegistry(libraries, this.selectedRoot);
  }

  /** Opens the OS folder picker and, if the user picked one, registers and selects it. */
  async chooseLibraryRoot(): Promise<string | null> {
    const selected = await window.nicegal.native.chooseDirectory();
    if (!selected) return null;
    const library = this.registerLibrary(selected);
    if (!library) return null;
    await this.selectLibrary(library.root);
    return library.root;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private mapGalleryAsset(asset: GalleryAsset, timeline: Timeline): GalleryItem {
    const width = asset.width ?? 1;
    const height = asset.height ?? 1;
    const timestampNs =
      timeline === "capture" ? (asset.captureNs ?? asset.modifiedNs) : asset.modifiedNs;
    return {
      id: asset.id,
      displayName: asset.displayName,
      extension: asset.extension,
      modifiedNs: asset.modifiedNs,
      createdNs: asset.createdNs,
      captureNs: asset.captureNs,
      sourceSize: asset.sourceSize,
      thumbnailRevision: this.thumbnailRevision,
      mediaKind: asset.mediaKind,
      mediaFormat: asset.mediaFormat,
      animated: asset.animated,
      frameCount: asset.frameCount,
      durationMs: asset.durationMs,
      width,
      height,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      aspectRatio: aspectRatioOf(width, height),
      date: Number(BigInt(timestampNs) / 1_000_000n),
    };
  }

  /**
   * The selected library's counts, or undefined when nothing is selected. Rows start as an empty
   * status the moment a library is registered, so callers that display this must still treat a
   * zero `cataloged` as "nothing to show yet" rather than a real reading.
   */
  get selectedStatus(): LibraryRowStatus | undefined {
    if (!this.selectedRoot) return undefined;
    const library = this.libraries.find((candidate) =>
      rootsMatch(candidate.root, this.selectedRoot),
    );
    return library ? this.libraryStatuses.get(library.root) : undefined;
  }

  private statusFor(root: string): LibraryRowStatus {
    const library = this.libraries.find((candidate) => rootsMatch(candidate.root, root));
    return library
      ? (this.libraryStatuses.get(library.root) ?? emptyLibraryRowStatus())
      : emptyLibraryRowStatus();
  }

  private updateLibraryStatus(root: string, status: LibraryRowStatus): void {
    const library = this.libraries.find((candidate) => rootsMatch(candidate.root, root));
    if (!library) return;
    this.libraryStatuses.set(library.root, status);
  }

  private libraryStatusRootGeneration(root: string): number {
    return this.libraryStatusRootGenerations.get(rootKey(root)) ?? 0;
  }

  private invalidateLibraryStatusRequest(root: string): void {
    if (!root) return;
    const key = rootKey(root);
    this.libraryStatusRootGenerations.set(key, this.libraryStatusRootGeneration(root) + 1);
    const status = this.statusFor(root);
    if (status.loading) {
      // The request that owned this loading flag can no longer settle it. Clear it immediately,
      // then let the catalog refresh that superseded it request fresh counts once it lands.
      this.libraryStatusRefreshRequested = true;
      this.updateLibraryStatus(root, { ...status, loading: false });
    }
  }

  private isCurrentLibraryStatusRequest(
    root: string,
    generation: number,
    rootGeneration: number,
  ): boolean {
    return (
      generation === this.libraryStatusGeneration &&
      rootGeneration === this.libraryStatusRootGeneration(root) &&
      this.libraries.some((library) => rootsMatch(library.root, root))
    );
  }

  private updateSelectedCatalogCount(): void {
    if (!this.libraryRoot) return;
    this.updateLibraryStatus(this.libraryRoot, {
      ...this.statusFor(this.libraryRoot),
      cataloged: this.items.length,
    });
  }

  private loadRegistry(): LibraryRegistry {
    let serializedRegistry: string | null = null;
    try {
      serializedRegistry = localStorage.getItem(LIBRARIES_STORAGE_KEY);
    } catch {
      return { libraries: [], selectedRoot: "" };
    }

    if (serializedRegistry !== null) {
      const registry = this.parseRegistry(serializedRegistry);
      if (registry) return registry;
    }

    let legacyRoot: string | null = null;
    try {
      legacyRoot = localStorage.getItem(LIBRARY_ROOT_STORAGE_KEY);
    } catch {
      return { libraries: [], selectedRoot: "" };
    }
    const library = normalizeLibraryRecord({ root: legacyRoot });
    if (!library) return { libraries: [], selectedRoot: "" };

    const registry = { libraries: [library], selectedRoot: library.root };
    if (this.persistRegistry(registry)) {
      try {
        localStorage.removeItem(LIBRARY_ROOT_STORAGE_KEY);
      } catch {
        // The v2 registry is already durable; leaving a stale legacy key is harmless.
      }
    }
    return registry;
  }

  private parseRegistry(serialized: string): LibraryRegistry | null {
    try {
      const value: unknown = JSON.parse(serialized);
      if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as LibraryRegistry).libraries)
      ) {
        return null;
      }

      const serializedLibraries = (value as LibraryRegistry).libraries;
      const libraries = normalizeLibraries(serializedLibraries);
      if (serializedLibraries.length > 0 && libraries.length === 0) return null;
      const storedSelectedRoot =
        typeof (value as Partial<LibraryRegistry>).selectedRoot === "string"
          ? (value as LibraryRegistry).selectedRoot
          : "";
      const selectedRoot =
        libraries.find((library) => rootsMatch(library.root, storedSelectedRoot))?.root ??
        libraries[0]?.root ??
        "";
      return { libraries, selectedRoot };
    } catch {
      return null;
    }
  }

  private replaceRegistry(libraries: LibraryRecord[], selectedRoot: string): void {
    this.libraries = libraries;
    this.selectedRoot = selectedRoot;
    this.persistRegistry({ libraries, selectedRoot });
  }

  private persistRegistry(registry: LibraryRegistry): boolean {
    try {
      localStorage.setItem(
        LIBRARIES_STORAGE_KEY,
        JSON.stringify({
          libraries: registry.libraries,
          selectedRoot: registry.selectedRoot,
        } satisfies LibraryRegistry),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async refreshSelectedLibrary(): Promise<void> {
    this.items = [];
    this.catalogRevision = "";
    this.loadedTimeline = null;
    this.loadError = "";
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await this.refresh();
  }
}
