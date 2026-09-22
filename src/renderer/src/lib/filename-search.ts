export type FilenameEntry = readonly [id: string, name: string];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function searchFilenames(items: readonly FilenameEntry[], query: string): FilenameEntry[] {
  const needle = query.toLowerCase();
  const matches: FilenameEntry[] = [];
  for (const entry of items) if (entry[1].toLowerCase().includes(needle)) matches.push(entry);
  matches.sort((left, right) => {
    const compared = collator.compare(left[1], right[1]);
    return compared !== 0 ? compared : left[0].localeCompare(right[0]);
  });
  return matches;
}
