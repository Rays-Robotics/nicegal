/** Registered roots compare without case on Windows. */
export function rootKey(root: string): string {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
    ? root.toLowerCase()
    : root;
}

export function rootsMatch(left: string, right: string): boolean {
  return rootKey(left) === rootKey(right);
}
