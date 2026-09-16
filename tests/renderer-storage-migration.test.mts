import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";

import {
  LIBRARIES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  STORAGE_ORIGIN_MIGRATION_KEY,
} from "../src/shared/renderer-storage.ts";

type StoredValues = Record<string, string>;

interface MigrationWindowFixture {
  navigations: string[];
  window: {
    loadURL: (url: string) => Promise<void>;
    webContents: { executeJavaScript: <T>(source: string) => Promise<T> };
  };
}

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-storage-migration-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { migrateLegacyRendererStorage } = await vite.ssrLoadModule(
  "/src/main/renderer-storage-migration.ts",
);

function migrationWindow(
  appStorage: StoredValues,
  fileStorage: StoredValues,
): MigrationWindowFixture {
  let currentStorage = appStorage;
  const navigations: string[] = [];
  const localStorage = {
    getItem: (key: string): string | null => currentStorage[key] ?? null,
    setItem: (key: string, value: string): void => {
      currentStorage[key] = value;
    },
  };
  return {
    navigations,
    window: {
      async loadURL(url: string): Promise<void> {
        navigations.push(url);
        currentStorage = url.startsWith("file:") ? fileStorage : appStorage;
      },
      webContents: {
        async executeJavaScript<T>(source: string): Promise<T> {
          return runInNewContext(source, { localStorage }) as T;
        },
      },
    },
  };
}

test("legacy renderer storage migrates to a fresh app origin", async () => {
  const appStorage: StoredValues = { [SETTINGS_STORAGE_KEY]: "new automatic defaults" };
  const fileStorage: StoredValues = {
    [LIBRARIES_STORAGE_KEY]: '{"libraries":[{"root":"C:/Pictures"}]}',
    [SETTINGS_STORAGE_KEY]: "legacy preferences",
    unrelated: "do not copy",
  };
  const fixture = migrationWindow(appStorage, fileStorage);

  assert.equal(
    await migrateLegacyRendererStorage(fixture.window as never, "C:/application/out/renderer"),
    true,
  );
  assert.equal(appStorage[LIBRARIES_STORAGE_KEY], fileStorage[LIBRARIES_STORAGE_KEY]);
  assert.equal(appStorage[SETTINGS_STORAGE_KEY], "legacy preferences");
  assert.equal(appStorage["unrelated"], undefined);
  assert.equal(appStorage[STORAGE_ORIGIN_MIGRATION_KEY], "1");
  assert.equal(fixture.navigations.length, 3);
  assert.match(fixture.navigations[1], /^file:/);
});

test("an established app-origin library registry wins over legacy storage", async () => {
  const appStorage: StoredValues = { [LIBRARIES_STORAGE_KEY]: "new registry" };
  const fileStorage: StoredValues = { [LIBRARIES_STORAGE_KEY]: "old registry" };
  const fixture = migrationWindow(appStorage, fileStorage);

  assert.equal(
    await migrateLegacyRendererStorage(fixture.window as never, "C:/application/out/renderer"),
    false,
  );
  assert.equal(appStorage[LIBRARIES_STORAGE_KEY], "new registry");
  assert.equal(appStorage[STORAGE_ORIGIN_MIGRATION_KEY], "1");
  assert.deepEqual(fixture.navigations, ["app://renderer/.storage-migration"]);
});

test("a completed origin migration skips subsequent legacy probes", async () => {
  const appStorage: StoredValues = { [STORAGE_ORIGIN_MIGRATION_KEY]: "1" };
  const fixture = migrationWindow(appStorage, {});

  assert.equal(
    await migrateLegacyRendererStorage(fixture.window as never, "C:/application/out/renderer"),
    false,
  );
  assert.deepEqual(fixture.navigations, ["app://renderer/.storage-migration"]);
});
