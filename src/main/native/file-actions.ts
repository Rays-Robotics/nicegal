import { clipboard, ClipboardItem, shell } from "electron";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import type { NicegalServerClient } from "../backend/nicegal-server-client";

export interface ResolvedFileTarget {
  id: string;
  path: string;
  displayName: string;
}

/** Resolves renderer-owned IDs at the trusted Rust boundary. The same targets can later feed
 * Electron's `startDrag` without adding renderer-visible paths or another catalog read path. */
export async function resolveFileTargets(
  client: NicegalServerClient,
  assetIds: readonly string[],
): Promise<ResolvedFileTarget[]> {
  const response = await client.resolveAssets(assetIds);
  const byId = new Map(
    response.assets
      .filter((asset) => isAbsolute(asset.path))
      .map((asset) => [
        asset.id,
        { id: asset.id, path: asset.path, displayName: asset.displayName },
      ]),
  );
  return assetIds.flatMap((id) => {
    const target = byId.get(id);
    return target ? [target] : [];
  });
}

export async function openFiles(files: readonly ResolvedFileTarget[]): Promise<void> {
  const results = await Promise.all(
    files.map(async (file) => ({ file, error: await shell.openPath(file.path) })),
  );
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    throw new Error(failures.map(({ file, error }) => `${file.displayName}: ${error}`).join("\n"));
  }
}

export function revealFiles(files: readonly ResolvedFileTarget[]): void {
  for (const file of files) shell.showItemInFolder(file.path);
}

/** Places file references on the clipboard rather than exposing paths to renderer code. */
export async function copyFiles(files: readonly ResolvedFileTarget[]): Promise<void> {
  const uriList = `${files.map((file) => pathToFileURL(file.path).href).join("\r\n")}\r\n`;
  await clipboard.write([new ClipboardItem({ "text/uri-list": uriList })]);
}

export async function copyFilePaths(files: readonly ResolvedFileTarget[]): Promise<void> {
  await clipboard.writeText(files.map((file) => file.path).join("\n"));
}
