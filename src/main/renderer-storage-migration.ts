import type { BrowserWindow } from "electron";

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LIBRARIES_STORAGE_KEY,
  LIBRARY_ROOT_STORAGE_KEY,
  PERSISTED_RENDERER_STORAGE_KEYS,
  STORAGE_ORIGIN_MIGRATION_KEY,
  type PersistedRendererStorageKey,
} from "../shared/renderer-storage";
import { APP_STORAGE_MIGRATION_URL } from "./renderer-location";

type StorageSnapshot = Partial<Record<PersistedRendererStorageKey, string>> & {
  [STORAGE_ORIGIN_MIGRATION_KEY]?: string;
};

const STORAGE_KEYS = [...PERSISTED_RENDERER_STORAGE_KEYS, STORAGE_ORIGIN_MIGRATION_KEY];

/**
 * Copy renderer state from the former `file:` origin to the new `app://renderer` origin.
 *
 * The probe document has no application scripts, so migrated values land before Svelte imports
 * settings or constructs the catalog. A profile that already registered libraries on the new
 * origin wins over legacy state.
 */
export async function migrateLegacyRendererStorage(
  window: BrowserWindow,
  rendererDirectory: string,
): Promise<boolean> {
  await window.loadURL(APP_STORAGE_MIGRATION_URL);
  const targetStorage = await readStorage(window);
  if (targetStorage[STORAGE_ORIGIN_MIGRATION_KEY] === "1") return false;

  if (
    targetStorage[LIBRARIES_STORAGE_KEY] !== undefined ||
    targetStorage[LIBRARY_ROOT_STORAGE_KEY] !== undefined
  ) {
    await writeStorage(window, {}, false);
    return false;
  }

  const legacyEntryUrl = pathToFileURL(join(rendererDirectory, "index.html")).toString();
  await window.loadURL(legacyEntryUrl);
  const legacyStorage = await readStorage(window);

  // Return to the app origin before writing. Legacy values intentionally replace automatically
  // generated defaults on a fresh app origin, while established app-origin libraries above win.
  await window.loadURL(APP_STORAGE_MIGRATION_URL);
  const values = Object.fromEntries(
    PERSISTED_RENDERER_STORAGE_KEYS.flatMap((key) =>
      legacyStorage[key] === undefined ? [] : [[key, legacyStorage[key]]],
    ),
  ) as Partial<Record<PersistedRendererStorageKey, string>>;
  await writeStorage(window, values, true);
  return Object.keys(values).length > 0;
}

async function readStorage(window: BrowserWindow): Promise<StorageSnapshot> {
  return window.webContents.executeJavaScript(`
    (() => {
      const result = {};
      for (const key of ${JSON.stringify(STORAGE_KEYS)}) {
        const value = localStorage.getItem(key);
        if (value !== null) result[key] = value;
      }
      return result;
    })()
  `);
}

async function writeStorage(
  window: BrowserWindow,
  values: Partial<Record<PersistedRendererStorageKey, string>>,
  overwrite: boolean,
): Promise<void> {
  await window.webContents.executeJavaScript(`
    (() => {
      const values = ${JSON.stringify(values)};
      for (const [key, value] of Object.entries(values)) {
        if (${overwrite} || localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      localStorage.setItem(${JSON.stringify(STORAGE_ORIGIN_MIGRATION_KEY)}, "1");
    })()
  `);
}
