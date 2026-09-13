export interface ThumbnailBackfillOptions {
  buckets: number[];
  fromNs?: string;
  toNs?: string;
}

const NS_PER_MS = 1_000_000n;

/**
 * Converts a `<input type="date">` value (local calendar date, "YYYY-MM-DD") to Unix nanoseconds
 * at local midnight, as a decimal string — the wire format `ThumbnailJobRequest.params.range`
 * expects. Returns `undefined` for an empty/invalid input so an unset field stays unset rather
 * than becoming `"NaN"`.
 */
export function localDateToNs(value: string): string | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T00:00:00`).getTime();
  if (Number.isNaN(ms)) return undefined;
  return (BigInt(ms) * NS_PER_MS).toString();
}

/**
 * Same as `localDateToNs`, but for the exclusive upper bound of a half-open range: rolls forward
 * to the start of the *next* calendar day, so picking a date includes that whole day.
 */
export function localDateToExclusiveNs(value: string): string | undefined {
  if (!value) return undefined;
  const start = new Date(`${value}T00:00:00`);
  if (Number.isNaN(start.getTime())) return undefined;
  const nextDay = new Date(start);
  nextDay.setDate(nextDay.getDate() + 1);
  return (BigInt(nextDay.getTime()) * NS_PER_MS).toString();
}
