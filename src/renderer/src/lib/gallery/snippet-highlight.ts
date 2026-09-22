/**
 * Search-text concerns for the gallery's "why this matched" caption strip: which terms from a
 * query are worth highlighting, and how a snippet string is split into hit/non-hit segments for
 * that highlighting. Kept separate from `tile-pool.ts` (DOM-slot recycling) and
 * `VirtualGallery.svelte` (rendering) so neither owns text-parsing logic that isn't theirs.
 */

export type SnippetSegment = {
  text: string;
  hit: boolean;
};

/** FTS control words that survive `parseQuery`'s body extraction but aren't literal search terms
 * worth highlighting. */
const FTS_CONTROL_WORD = /^(and|or|not|near)$/u;

/** Literal body terms worth highlighting in a caption. Callers pass `parseQuery(query).body`,
 * which has already had the scope prefix and date tokens removed; this filter discards FTS
 * control words on top of that. */
export function literalSnippetTerms(body: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of body.toLowerCase().matchAll(/"([^"]+)"|[\p{L}\p{N}]+/gu)) {
    const term = match[1] ?? match[0];
    if (FTS_CONTROL_WORD.test(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Splits a snippet into segments, marking the portions that match one of `terms` (case
 * insensitive) so the caller can render highlighted `<mark>`s without doing per-render text work. */
export function segmentSnippet(raw: string, terms: readonly string[]): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const lower = raw.toLowerCase();
  let cursor = 0;
  while (cursor < raw.length) {
    let nextAt = -1;
    let nextTerm = "";
    for (const term of terms) {
      const at = lower.indexOf(term, cursor);
      if (at !== -1 && (nextAt === -1 || at < nextAt)) {
        nextAt = at;
        nextTerm = term;
      }
    }
    if (nextAt === -1) {
      segments.push({ text: raw.slice(cursor), hit: false });
      break;
    }
    if (nextAt > cursor) segments.push({ text: raw.slice(cursor, nextAt), hit: false });
    segments.push({ text: raw.slice(nextAt, nextAt + nextTerm.length), hit: true });
    cursor = nextAt + nextTerm.length;
  }
  return segments;
}

/** Keep a match near the end of a long filename inside the two-line caption, not clipped away.
 * The pool retains the full filename separately for alt text and the native tooltip. */
export function segmentFilename(filename: string, query: string): SnippetSegment[] {
  const term = query.toLowerCase();
  const at = filename.toLowerCase().indexOf(term);
  if (!term || at < 0) return [{ text: filename, hit: false }];
  const start = Math.max(0, at - 24);
  const end = Math.min(filename.length, at + term.length + 36);
  const excerpt = `${start ? "…" : ""}${filename.slice(start, end)}${end < filename.length ? "…" : ""}`;
  return segmentSnippet(excerpt, [term]);
}
