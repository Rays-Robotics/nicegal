import type { DividerGranularity } from "./types";

const dayLabelFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const monthLabelFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** Bucket key for a timestamp at the given granularity. Same-bucket items share this key. */
export function bucketKey(timestamp: number, granularity: DividerGranularity): string {
  const date = new Date(timestamp);
  if (granularity === "month") return `${date.getFullYear()}-${date.getMonth()}`;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Human label for the bucket a timestamp falls into. */
export function bucketLabel(timestamp: number, granularity: DividerGranularity): string {
  const date = new Date(timestamp);
  return granularity === "month"
    ? monthLabelFormatter.format(date)
    : dayLabelFormatter.format(date);
}

/** Short label for timeline scrollbar ticks, e.g. "Jan 2026" or "Mar 3". */
export function timelineTickLabel(timestamp: number, granularity: DividerGranularity): string {
  const date = new Date(timestamp);
  return granularity === "month"
    ? new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
