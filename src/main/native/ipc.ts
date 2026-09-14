import { BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { readFile, stat } from "node:fs/promises";

import type { NicegalServerClient } from "../backend/nicegal-server-client";
import type { IpcSenderValidator } from "../ipc";

import licenseInformation from "../../../resources/licenses/license-information.html?asset&asarUnpack";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { handleTrustedIpc } from "../ipc";
import {
  copyFilePaths,
  copyFiles,
  openFiles,
  resolveFileTargets,
  revealFiles,
  type ResolvedFileTarget,
} from "./file-actions";

export interface NativeIpcContext {
  isTrustedSender: IpcSenderValidator;
  readonly client: NicegalServerClient | null;
}

/** Main-process capabilities backed by Electron/OS APIs rather than the search backend. */
export function registerNativeIpc(context: NativeIpcContext): void {
  handleTrustedIpc(
    IPC_CHANNELS.native.openExternalUrl,
    context.isTrustedSender,
    async (_event, value) => {
      if (typeof value !== "string") throw new TypeError("Expected a web link");
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new TypeError("Only HTTPS links without credentials can be opened");
      }
      await shell.openExternal(url.href);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.native.openLicenseInformation,
    context.isTrustedSender,
    async () => {
      // Fixed unpacked asset: the renderer cannot supply an arbitrary local path.
      const error = await shell.openPath(licenseInformation);
      if (error) throw new Error(error);
    },
  );
  handleTrustedIpc(IPC_CHANNELS.native.chooseDirectory, context.isTrustedSender, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error("Directory picker requires an owning application window");
    const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handleTrustedIpc(
    IPC_CHANNELS.native.chooseVisualSearchImage,
    context.isTrustedSender,
    async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("Image picker requires an owning application window");
      const result = await dialog.showOpenDialog(owner, {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (!path) return null;
      const info = await stat(path);
      const limit = 16 * 1024 * 1024;
      if (!info.isFile() || info.size > limit) {
        throw new Error("Choose an image smaller than 16 MB for visual search.");
      }
      const bytes = await readFile(path);
      return {
        displayName: path.split(/[\\/]/).pop() ?? "Selected image",
        bytesBase64: bytes.toString("base64"),
      };
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.native.showFileContextMenu,
    context.isTrustedSender,
    async (event, value: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("File menu requires an owning application window");
      if (!context.client) throw new Error("File actions require the catalog backend");

      const files = await resolveFileTargets(context.client, parseAssetIds(value));
      if (!files.length) return;
      Menu.buildFromTemplate(
        fileMenuTemplate(owner, files, (replace) =>
          event.sender.send(
            IPC_CHANNELS.native.addToVisualSearch,
            files.map((file) => file.id),
            replace,
          ),
        ),
      ).popup({ window: owner });
    },
  );
}

function parseAssetIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("assetIds" in value)) {
    throw new TypeError("File menu request must contain assetIds");
  }
  const assetIds = (value as { assetIds?: unknown }).assetIds;
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 512) {
    throw new TypeError("File menu requires between 1 and 512 asset IDs");
  }
  const unique = new Set<string>();
  for (const id of assetIds) {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new TypeError("File menu asset IDs must be safe positive decimal strings");
    }
    unique.add(id);
  }
  return [...unique];
}

function fileMenuTemplate(
  owner: BrowserWindow,
  files: readonly ResolvedFileTarget[],
  visualSearch: (replace: boolean) => void,
): MenuItemConstructorOptions[] {
  const multiple = files.length > 1;
  return [
    {
      label: "Find similar images",
      click: () => visualSearch(true),
    },
    {
      label: multiple ? `Add ${files.length} images to visual search` : "Add to visual search",
      click: () => visualSearch(false),
    },
    { type: "separator" },
    {
      label: multiple ? `Open ${files.length} items in default apps` : "Open in default app",
      click: () => runFileAction(owner, "Open failed", () => openFiles(files)),
    },
    { type: "separator" },
    {
      label: multiple ? `Copy ${files.length} items` : "Copy",
      click: () => runFileAction(owner, "Copy failed", () => copyFiles(files)),
    },
    {
      label: multiple ? `Copy ${files.length} paths` : "Copy as path",
      click: () => runFileAction(owner, "Copy as Path failed", () => copyFilePaths(files)),
    },
    { type: "separator" },
    {
      label: revealLabel(),
      click: () => runFileAction(owner, "Reveal failed", () => revealFiles(files)),
    },
  ];
}

function revealLabel(): string {
  if (process.platform === "darwin") return "Reveal in Finder";
  if (process.platform === "win32") return "Reveal in Explorer";
  return "Open Containing Folder";
}

function runFileAction(owner: BrowserWindow, title: string, action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    dialog.showMessageBox(owner, {
      type: "error",
      title,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
