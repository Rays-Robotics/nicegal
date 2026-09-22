import type { SearchView } from "../ocr-search.svelte";

/** Keep section counts/statuses, but give the layout a dense array of visible items. */
export function collapseSearchSections(
  view: SearchView,
  collapsed: ReadonlySet<string>,
): SearchView {
  if (!view.sections || !collapsed.size) return view;
  const items: SearchView["items"] = [];
  const sections = view.sections.map((section) => {
    const start = items.length;
    const hidden = collapsed.has(section.key);
    if (!hidden) {
      for (let i = section.start; i < section.start + section.count; i++) items.push(view.items[i]);
    }
    return { ...section, start, collapsed: hidden };
  });
  return { ...view, items, sections };
}
