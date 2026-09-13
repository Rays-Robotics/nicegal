import { SvelteMap, SvelteSet } from "svelte/reactivity";

import type { Timeline } from "../../../shared/backend";
import type { ExternalVisualReference } from "../../../shared/backend";
import type { CatalogController } from "./catalog.svelte";

import { searchErrorMessage } from "./errors";
import { localDateToExclusiveNs, localDateToNs } from "./job-params";
import { parseQuery, type DateFilter, type SearchScope } from "./search-query";
import { isVisualComposition, parseVisualTextTerms, type VisualReferenceTerm } from "./visual-query";

type CatalogItem = CatalogController["items"][number];

/** Whether a query typed at this scope produces something a relevance order can be built from.
 * `name` is client-side substring matching — every hit is equally a hit, so there is nothing to
 * rank and the options strip stays hidden. */
export function isRankableScope(scope: SearchScope): scope is "all" | "ocr" | "meaning" | "like" {
  return scope === "all" || scope === "ocr" || scope === "meaning" || scope === "like";
}

export type SearchSortMode = "relevance" | "date";

/**
 * How long `schedule()` waits after the last keystroke before running filename matching and
 * firing the backend text/vector/image query. The filename scan itself is ~10ms even at 100k+ items
 * (indexed lookups, memoized `Map`), so this only has to coalesce a burst of keystrokes before
 * hitting the backend — it is not hiding slow client work.
 */
const SEARCH_DEBOUNCE_MS = 80;

/**
 * Ranked mode's cutoff. Vector search matches nearly everything weakly, so without a cutoff the
 * "best match first" view degenerates into the whole library in near-arbitrary tail order.
 */
export const RANKED_RESULT_LIMIT = 500;

/**
 * Slider stops for the match-quality cutoff. Ten steps put a tick on every stop and land a major
 * one exactly in the middle, which is where the control starts.
 */
export const MATCH_QUALITY_STEP = 10;

/**
 * Where the match-quality slider rests. Mid-scale rather than wide open (user, 2026-08-25,
 * overriding the spec's 0): a meaning search matches nearly everything weakly, so "everything it
 * found" is the wrong first thing to show. Half the result set is a usable starting view that the
 * user widens or narrows from.
 */
export const DEFAULT_MATCH_QUALITY = 50;

/**
 * CLIP ranks every indexed image, including weakly related ones. Its logarithmic cutoff maps the
 * midpoint to the best 10%, giving a useful conservative starting point without pushing the
 * control to its far end.
 */
export const DEFAULT_CLIP_MATCH_QUALITY = 50;

/**
 * What one `apply()` pass produced: the items to render, plus the two numbers the search options
 * strip needs but cannot recover from the array alone.
 */
export interface SearchView {
  items: CatalogItem[];
  /** Matching items before ranked mode's top-N cutoff. Equals `items.length` when nothing was cut. */
  matchTotal: number;
  /**
   * Whether the gallery is showing a search result rather than the whole library. True for any
   * non-empty query — including a date-only one, which filters with no search body at all.
   */
  filtering: boolean;
}

export class OcrSearchController {
  query = $state("");
  pending = $state(false);
  error = $state("");
  indexNotice = $state("");
  /** Set only after the current query's coverage check confirms a semantic search can run. */
  semanticAvailable = $state(false);
  total = $state(0);
  /** Indexed-search result IDs only; filename matches are tracked separately. */
  matches = $state<SvelteSet<string> | null>(null);
  snippets = $state(new SvelteMap<string, string>());
  /**
   * Result IDs in the backend's own rank order — already reranked server-side, so this array is
   * the relevance ordering, not something to re-sort. Empty until a rankable search lands.
   */
  rankedIds = $state<string[]>([]);
  /** Per-hit relevance signal: cosine distance for `meaning`/`like`, FTS5 `bm25()` for `ocr`/`all`. */
  scores = $state(new SvelteMap<string, number>());
  /** Session-only image examples. External bytes are never persisted or added to the catalog. */
  visualReferences = $state<VisualReferenceTerm[]>([]);
  visualReferenceRevision = $state(0);
  /**
   * Session state, deliberately not in the persisted settings store: the layout mode is a
   * preference, but how a particular search is being read is a mode, and it resets with the
   * library it belongs to.
   */
  sortMode = $state<SearchSortMode>("relevance");
  /** Separate semantic-engine cutoffs keep a user-adjusted text search from changing how
   * conservative a visual search starts, and vice versa. */
  private meaningMinMatchPercentile = $state(DEFAULT_MATCH_QUALITY);
  private clipMatchQuality = $state(DEFAULT_CLIP_MATCH_QUALITY);

  private filenameMatches = $state<SvelteSet<string> | null>(null);
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRoot = "";
  /** `id -> item` for `rankItems`, memoized by array identity. `filterItemsByDates` returns the
   * same array reference when no date filter is active — the common case at 100k+ items — so
   * this reuses one Map across every keystroke instead of rebuilding it each time. */
  private readonly idIndexCache = new WeakMap<CatalogItem[], Map<string, CatalogItem>>();

  /** The parse every getter below reads; `parseQuery` is pure, so one derived serves them all. */
  private readonly parsed = $derived(parseQuery(this.query));
  private readonly searchBody = $derived(normalizeSearchBody(this.parsed.scope, this.parsed.body));

  /** 0-100 cutoff control value; it is a percentile for text meaning and logarithmic for CLIP. */
  get minMatchPercentile(): number {
    return this.parsed.scope === "like" ? this.clipMatchQuality : this.meaningMinMatchPercentile;
  }

  set minMatchPercentile(value: number) {
    if (this.parsed.scope === "like") this.clipMatchQuality = value;
    else this.meaningMinMatchPercentile = value;
  }

  /** Whether the search options strip has anything to offer for the current query. */
  get rankable(): boolean {
    return Boolean(this.searchBody || this.visualReferences.length) && isRankableScope(this.parsed.scope);
  }

  setVisualReferences(references: VisualReferenceTerm[]): void {
    this.visualReferences = references.slice(0, 16);
    this.visualReferenceRevision += 1;
  }

  addLibraryReferences(items: ReadonlyArray<{ id: string; displayName: string }>): void {
    const known = new SvelteSet(this.visualReferences.map((reference) => reference.id));
    this.setVisualReferences([
      ...this.visualReferences,
      ...items.filter((item) => !known.has(`library-${item.id}`)).map((item) => ({
        id: `library-${item.id}`,
        source: "library" as const,
        assetId: item.id,
        displayName: item.displayName,
        polarity: "more" as const,
        strength: 1,
      })),
    ]);
  }

  addExternalReferences(items: readonly ExternalVisualReference[]): void {
    this.setVisualReferences([
      ...this.visualReferences,
      ...items.map((item, index) => ({
        id: `external-${crypto.randomUUID()}-${index}`,
        source: "external" as const,
        displayName: item.displayName,
        bytesBase64: item.bytesBase64,
        polarity: "more" as const,
        strength: 1,
      })),
    ]);
  }

  /** Whether the minimum-match slider applies: percentiles need a continuous score, and ranked
   * mode already cuts by rank. */
  get sliderApplicable(): boolean {
    return (
      (this.parsed.scope === "meaning" || this.parsed.scope === "like") &&
      this.sortMode === "date" &&
      Boolean(this.searchBody || this.visualReferences.length) &&
      !this.indexNotice
    );
  }

  /**
   * A result set whose scores are all equal (a tiny index, or one document repeated) has no
   * percentile structure. Disable the control rather than let it pretend to filter.
   *
   * Derived rather than a getter because it walks the whole result set, and `apply()` reads it on
   * every pass.
   */
  readonly sliderDisabled = $derived.by(() => {
    const ids = this.rankedIds;
    if (ids.length < 2) return true;
    const first = this.scores.get(ids[0]);
    if (first === undefined) return true;
    return ids.every((id) => this.scores.get(id) === first);
  });

  /**
   * The match set narrowed by the match-quality slider. Rank-based rather than score-based:
   * text-meaning search keeps the top `100 - p` percent, while CLIP keeps a logarithmic
   * `10^(-2p / 100)` share. That spreads CLIP's useful one-to-ten-percent neighbourhood across
   * the control instead of cramming it against the strict end. Position 100 still keeps the
   * single best match rather than emptying the gallery.
   */
  private readonly admittedMatches = $derived.by(() => {
    const matches = this.matches;
    if (!matches || this.minMatchPercentile <= 0 || this.sliderDisabled) return matches;
    const ranked = this.rankedIds;
    if (!ranked.length) return matches;
    const retainedShare =
      this.parsed.scope === "like"
        ? 10 ** ((-2 * this.minMatchPercentile) / 100)
        : (100 - this.minMatchPercentile) / 100;
    const admitted = Math.max(1, Math.ceil(ranked.length * retainedShare));
    return new SvelteSet(ranked.slice(0, admitted));
  });

  get pendingLabel(): string {
    switch (this.parsed.scope) {
      case "all":
        return "Searching…";
      case "ocr":
        return "Searching text…";
      case "meaning":
        return "Searching by meaning…";
      case "like":
        return "Searching images…";
      default:
        return "";
    }
  }

  get queryHint(): string {
    return this.parsed.dates.some((date) => !date.valid) ? "Unrecognized date" : "";
  }

  /** Offer the semantic engine only after the literal default search has a settled result. */
  get shouldSuggestSemantic(): boolean {
    return (
      this.parsed.scope === "all" &&
      Boolean(this.searchBody) &&
      !this.pending &&
      !this.error &&
      !this.indexNotice &&
      this.semanticAvailable
    );
  }

  schedule(root: string, items: CatalogItem[], timeline: Timeline): void {
    if (this.timer) clearTimeout(this.timer);
    // Sort mode and the percentile cutoff describe one library's result set, so they reset with
    // the library and survive edits to the query within it.
    if (root !== this.lastRoot) {
      this.lastRoot = root;
      this.sortMode = "relevance";
      this.meaningMinMatchPercentile = DEFAULT_MATCH_QUALITY;
      this.clipMatchQuality = DEFAULT_CLIP_MATCH_QUALITY;
    }
    const generation = ++this.generation;
    const { scope, body: rawBody, dates, ocrMode } = parseQuery(this.query);
    const body = normalizeSearchBody(scope, rawBody);
    const references = this.visualReferences;
    const composedVisual = scope === "like" && (isVisualComposition(body) || references.length > 0);
    this.error = "";
    this.indexNotice = "";
    this.semanticAvailable = false;
    this.pending = false;
    this.snippets = new SvelteMap<string, string>();
    this.rankedIds = [];
    this.scores = new SvelteMap<string, number>();

    if (!body && !references.length) {
      this.filenameMatches = null;
      this.matches = null;
      this.total = items.length;
      return;
    }

    // Filename matching is a synchronous full-library scan (`filenameMatchIds`), so it rides the
    // same debounce as the backend request instead of running on every keystroke.
    this.pending = true;
    this.timer = setTimeout(() => {
      this.filenameMatches =
        scope === "ocr" || scope === "like" ? null : new SvelteSet(filenameMatchIds(items, body));
      this.matches = scope === "name" ? null : new SvelteSet<string>();
      this.total = scope === "name" ? this.filenameMatches.size : 0;

      if (scope === "name") {
        this.pending = false;
        return;
      }

      const time = timeRangeForDates(dates);
      if (time === null) {
        this.matches = new SvelteSet<string>();
        this.total = 0;
        this.pending = false;
        return;
      }

      if (!root) {
        this.error = "No library selected.";
        this.pending = false;
        return;
      }

      // `all` searches text the same way `ocr` does — literal OCR matching, not embeddings.
      // `meaning` searches OCR-text vectors; `like` embeds this text with CLIP and searches
      // indexed images. Image-to-image CLIP queries deliberately remain outside this text grammar.
      const searchType =
        scope === "meaning"
          ? "vector"
          : scope === "like"
            ? "image"
            : ocrMode === "glob"
              ? "glob"
              : "match";
      // `terms` and `raw` share the `match` mode, so a `terms` body must be quoted on the way
      // out — unquoted, FTS5 would parse `12:30` as a column filter and reject it.
      const searchQuery =
        searchType === "match" && ocrMode === "terms" ? quoteFtsTerms(body) : body;
      const runSearch = (): void => {
        const visualTerms = composedVisual ? parseVisualTextTerms(body) : [];
        const visualComponents = [
          ...visualTerms.map((term) => ({
            text: term.text,
            weight: term.polarity === "more" ? term.strength : -term.strength,
          })),
          ...references.map((reference) => {
            const weight = reference.polarity === "more" ? reference.strength : -reference.strength;
            if (reference.source === "library") return { assetId: Number(reference.assetId), weight };
            return { externalImage: { bytesBase64: reference.bytesBase64 ?? "" }, weight };
          }),
        ];
        void window.nicegal.backend
          .searchOcr({
            query: composedVisual ? "" : searchQuery,
            type: searchType,
            root,
            limit: 100_000,
            timeline,
            ...time,
            ...(composedVisual
              ? {
                  imageQuery: {
                    components: visualComponents,
                  },
                }
              : {}),
          })
          .then((response) => {
            if (generation !== this.generation) return;
            this.matches = new SvelteSet(response.results.map((result) => result.assetId));
            this.snippets = new SvelteMap(
              response.results.map((result) => [result.assetId, result.snippet] as const),
            );
            // The response is already in the backend's final rank order (reranked server-side),
            // so relevance order is response order — nothing to re-sort. A server without `rank`
            // simply leaves that order as the only signal, which is the graceful degradation.
            this.rankedIds = response.results.map((result) => result.assetId);
            this.scores = new SvelteMap(
              response.results.flatMap((result) => {
                const score = result.distance ?? result.score;
                return score === undefined ? [] : [[result.assetId, score] as const];
              }),
            );
            this.total = response.total;
          })
          .catch((error: unknown) => {
            if (generation === this.generation) this.error = searchErrorMessage(error);
          })
          .finally(() => {
            if (generation === this.generation) this.pending = false;
          });
      };

      // The documented embedding-coverage endpoint reports OCR-text vectors only. CLIP image
      // coverage has no equivalent yet, so run the text-to-image search and let its empty result
      // mean exactly that — not a guessed “not indexed” state.
      if (scope === "like") {
        runSearch();
        return;
      }

      const coverageRequest = window.nicegal.backend.getTextEmbeddingCoverage(root);

      // `meaning` needs embeddings; `ocr` and `all` only need OCR text, so they gate on
      // `indexed` instead — an un-embedded-but-OCR'd library should still search fine.
      void coverageRequest
        .then((response) => {
          if (generation !== this.generation) return;
          this.semanticAvailable = response.embedded > 0;
          const notIndexed = scope === "meaning" ? response.embedded === 0 : response.indexed === 0;
          if (notIndexed) {
            this.indexNotice = "This library is not indexed. Index it in Libraries.";
            this.matches = new SvelteSet<string>();
            this.snippets = new SvelteMap<string, string>();
            this.total = this.filenameMatches?.size ?? 0;
            this.pending = false;
            return;
          }
          runSearch();
        })
        .catch(() => {
          if (generation === this.generation) runSearch();
        });
    }, composedVisual ? 250 : SEARCH_DEBOUNCE_MS);
  }

  /**
   * Turns the catalog into what the gallery should render for the current query.
   *
   * Two shapes come out of here. In date sort the result is a membership filter over the
   * date-ordered catalog, exactly as it always was — dividers and virtualization see the order
   * they expect. In relevance sort it is a re-ordered array, best match first, which
   * `VirtualGallery` renders as happily as any other order because layout consumes the array.
   */
  apply(items: CatalogItem[]): SearchView {
    const { scope, dates } = this.parsed;
    const body = this.searchBody;
    const dated = filterItemsByDates(items, dates);
    const filtering = this.query.length > 0;
    if (!body && !this.visualReferences.length) return { items: dated, matchTotal: dated.length, filtering };

    if (this.sortMode === "relevance" && isRankableScope(scope)) {
      const ranked = this.rankItems(dated, scope);
      return {
        items: ranked.length > RANKED_RESULT_LIMIT ? this.truncateRanked(ranked, scope) : ranked,
        matchTotal: ranked.length,
        filtering,
      };
    }

    const filtered = this.filterByScope(dated, scope);
    return { items: filtered, matchTotal: filtered.length, filtering };
  }

  /** Date sort: pure set membership, unchanged apart from the percentile cutoff on `meaning`. */
  private filterByScope(items: CatalogItem[], scope: SearchScope): CatalogItem[] {
    if (scope === "name") return filterItems(items, this.filenameMatches);
    if (scope === "ocr") return filterItems(items, this.matches);
    if (scope === "like") return filterItems(items, this.admittedMatches);
    if (scope === "meaning") {
      return this.indexNotice
        ? filterItems(items, this.filenameMatches)
        : filterItems(items, this.admittedMatches);
    }
    const filenameMatches = this.filenameMatches;
    const ocrMatches = this.matches;
    return filenameMatches === null && ocrMatches === null
      ? items
      : items.filter((item) => filenameMatches?.has(item.id) || ocrMatches?.has(item.id));
  }

  private idIndex(items: CatalogItem[]): Map<string, CatalogItem> {
    let index = this.idIndexCache.get(items);
    if (!index) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- memoized lookup index, never read reactively
      index = new Map(items.map((item) => [item.id, item] as const));
      this.idIndexCache.set(items, index);
    }
    return index;
  }

  /**
   * Relevance sort: ranked hits in the backend's order, then — for scope `all` only — the
   * filename matches it never saw, appended alphabetically. Those have no ranking signal at all
   * (a substring either occurs or it doesn't), so interleaving them by a made-up score would be
   * worse than admitting they are a separate, exact kind of hit.
   */
  private rankItems(
    items: CatalogItem[],
    scope: "all" | "ocr" | "meaning" | "like",
  ): CatalogItem[] {
    const byId = this.idIndex(items);
    const ranked: CatalogItem[] = [];
    // `indexNotice` means the index this scope needs (OCR for `all`/`ocr`, embeddings for
    // `meaning`) is empty, so there is no rank order to honour and the filename matches are the
    // whole result set.
    if (!this.indexNotice) {
      for (const id of this.rankedIds) {
        const item = byId.get(id);
        if (item) ranked.push(item);
      }
    }
    if (scope === "ocr" || scope === "like") return ranked;

    const filenameMatches = this.filenameMatches;
    if (!filenameMatches?.size) return ranked;
    if (scope === "meaning" && !this.indexNotice) return ranked;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupe set, scoped to this call, never read reactively
    const claimed = new Set(ranked.map((item) => item.id));
    // Walk the match set, not the catalog: `filenameMatches` is already just the hits, so this is
    // O(matches) instead of an O(catalog) scan for every keystroke.
    const filenameOnly: CatalogItem[] = [];
    for (const id of filenameMatches) {
      if (claimed.has(id)) continue;
      const item = byId.get(id);
      if (item) filenameOnly.push(item);
    }
    filenameOnly.sort(byFilename);
    return [...ranked, ...filenameOnly];
  }

  /**
   * Applies the top-N cutoff to the ranked hits while letting every filename-only match through:
   * those are exact matches on text the user typed, and dropping one would read as data loss.
   */
  private truncateRanked(
    ranked: CatalogItem[],
    scope: "all" | "ocr" | "meaning" | "like",
  ): CatalogItem[] {
    if (scope !== "all") return ranked.slice(0, RANKED_RESULT_LIMIT);
    const filenameMatches = this.filenameMatches;
    const kept = ranked.slice(0, RANKED_RESULT_LIMIT);
    if (!filenameMatches?.size) return kept;
    // `kept` and the tail are disjoint slices of the same array, so no dedupe is needed here.
    return [
      ...kept,
      ...ranked.slice(RANKED_RESULT_LIMIT).filter((item) => filenameMatches.has(item.id)),
    ];
  }

  dispose(): void {
    this.suspend();
  }

  /** Preserve the query while the service is unavailable, and ignore obsolete responses. */
  suspend(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    this.error = "";
  }
}

/** Case-insensitive filename order, with the id as a tiebreak so the sort is total. */
/** Shared across every sort call instead of building one per comparison — `localeCompare` with
 * an options object re-negotiates collation on every call, which dominates sort time once the
 * filename-only tail runs into the thousands. */
const filenameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function byFilename(left: CatalogItem, right: CatalogItem): number {
  const compared = filenameCollator.compare(left.displayName, right.displayName);
  return compared !== 0 ? compared : left.id.localeCompare(right.id);
}

function normalizeSearchBody(scope: SearchScope, rawBody: string): string {
  const body = rawBody.trim();
  // A lone `ocr"` is a mistyped `ocr:` prefix, not a query: without the colon it stays in scope
  // "all", where the odd quote reads as raw FTS5 syntax and fires a broken query mid-typing.
  // Treat it as empty.
  if (!body || (scope === "all" && /^ocr"\s*$/i.test(body))) return "";
  return scope === "name" || hasSearchText(body) ? body : "";
}

/** Wraps each whitespace-separated word of a `terms` body in FTS5 string literals (doubling any
 * embedded quote), so characters FTS5 treats as syntax — a colon, a leading hyphen — are matched
 * literally instead of parsed. Quoted words still AND together, which is what `terms` means. */
function quoteFtsTerms(body: string): string {
  return body
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

function hasSearchText(body: string): boolean {
  let inQuotes = false;
  let unquoted = "";
  for (const char of body) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes && /[\p{L}\p{N}]/u.test(char)) {
      return true;
    } else if (!inQuotes) {
      unquoted += char;
    }
  }
  return /[\p{L}\p{N}]/u.test(unquoted.replace(/\b(?:AND|OR|NOT|NEAR)(?:\/\d+)?\b/g, ""));
}

/** Display names lowercased once per item and kept as long as the item object lives, instead of
 * re-lowercasing the whole library on every keystroke. `catalog.items` is only ever reassigned
 * wholesale on a library refresh, so stale entries are simply dropped with their item. */
const lowerDisplayNameCache = new WeakMap<CatalogItem, string>();

function lowerDisplayName(item: CatalogItem): string {
  let cached = lowerDisplayNameCache.get(item);
  if (cached === undefined) {
    cached = item.displayName.toLowerCase();
    lowerDisplayNameCache.set(item, cached);
  }
  return cached;
}

function filenameMatchIds(items: CatalogItem[], query: string): string[] {
  const normalizedQuery = query.toLowerCase();
  return items
    .filter((item) => lowerDisplayName(item).includes(normalizedQuery))
    .map((item) => item.id);
}

function filterItems(items: CatalogItem[], matches: SvelteSet<string> | null): CatalogItem[] {
  return matches === null ? items : items.filter((item) => matches.has(item.id));
}

function filterItemsByDate(items: CatalogItem[], from: string, to: string): CatalogItem[] {
  const fromMs = Date.parse(`${from}T00:00:00`);
  const toMs = Date.parse(`${to}T23:59:59.999`);
  return items.filter((item) => item.date >= fromMs && item.date <= toMs);
}

type DateIntersection = { from: string; to: string; hasValidDate: boolean };

/**
 * Intersects every valid date filter down to a single `[from, to]` range, using the
 * "0000-01-01"/"9999-12-31" sentinels to mean "unbounded on this side". Shared by
 * `filterItemsByDates` (client-side filtering) and `timeRangeForDates` (backend request
 * bounds) — they apply the resulting range differently, but the intersection itself is
 * identical.
 */
function intersectDateFilters(dates: DateFilter[]): DateIntersection {
  let from = "0000-01-01";
  let to = "9999-12-31";
  let hasValidDate = false;
  for (const date of dates) {
    if (!date.valid) continue;
    hasValidDate = true;
    if (date.from > from) from = date.from;
    if (date.to < to) to = date.to;
  }
  return { from, to, hasValidDate };
}

function filterItemsByDates(items: CatalogItem[], dates: DateFilter[]): CatalogItem[] {
  const { from, to, hasValidDate } = intersectDateFilters(dates);
  return hasValidDate ? filterItemsByDate(items, from, to) : items;
}

/**
 * The API accepts nanosecond instants, while the query language accepts local calendar periods.
 * Date filters intersect, and the API's half-open range represents that intersection exactly.
 */
function timeRangeForDates(dates: DateFilter[]): { after?: string; before?: string } | null {
  const { from, to, hasValidDate } = intersectDateFilters(dates);
  if (!hasValidDate) return {};
  if (from > to) return null;

  return {
    ...(from === "0000-01-01" ? {} : { after: localDateToNs(from) }),
    ...(to === "9999-12-31" ? {} : { before: localDateToExclusiveNs(to) }),
  };
}
