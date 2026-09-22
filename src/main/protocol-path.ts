import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a URL pathname beneath a fixed directory without allowing path traversal. */
export function resolveProtocolAssetPath(
  rootDirectory: string,
  urlPathname: string,
): string | null {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  // URL paths always use forward slashes. Rejecting backslashes avoids giving Windows a second,
  // encoded path separator with subtly different normalization rules.
  if (
    !decodedPathname.startsWith("/") ||
    decodedPathname.includes("\0") ||
    decodedPathname.includes("\\")
  ) {
    return null;
  }

  const root = resolve(rootDirectory);
  const candidate = resolve(root, `.${decodedPathname}`);
  const relativePath = relative(root, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return candidate;
}
