import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import { IPC_CHANNELS } from "../src/shared/ipc-channels.ts";

const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
Object.assign(globalThis, { __fileDragHandlers: handlers });
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-file-drag-tests",
  plugins: [
    {
      name: "mock-native-drag",
      enforce: "pre",
      resolveId: (id) =>
        id === "electron" ? "\0drag-electron" : id.includes("?asset") ? "\0drag-asset" : undefined,
      load: (id) =>
        id === "\0drag-asset"
          ? 'export default "icon.png";'
          : id === "\0drag-electron"
            ? `
      export const ipcMain = { handle: (key, fn) => globalThis.__fileDragHandlers.set(key, fn) };
      export const nativeImage = { createFromPath: () => ({ resize: () => ({ icon: true }) }) };
      export const BrowserWindow = {}, dialog = {}, Menu = {}, shell = {}, clipboard = {};
      export class ClipboardItem {}
    `
            : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { registerNativeIpc } = await vite.ssrLoadModule("/src/main/native/ipc.ts");
const channels = IPC_CHANNELS.native;

test("native dragging validates IDs, resolves groups in batches and consumes sender-bound tokens", async () => {
  const starts: unknown[] = [];
  const batches: number[] = [];
  const sender = { startDrag: (item: unknown) => starts.push(item), isDestroyed: () => false };
  const event = { sender, trusted: true };
  registerNativeIpc({
    isTrustedSender: (event: { trusted: boolean }) => event.trusted,
    client: {
      resolveAssets: async (ids: string[]) => {
        batches.push(ids.length);
        return {
          assets: ids
            .toReversed()
            .map((id) => ({ id, path: `${process.cwd()}/${id}.png`, displayName: id })),
        };
      },
    },
  });
  const prepare = handlers.get(channels.prepareFileDrag)!;
  const start = handlers.get(channels.startFileDrag)!;
  assert.throws(() => prepare({ ...event, trusted: false }, { assetIds: ["1"] }), /untrusted/);
  await assert.rejects(async () => prepare(event, { assetIds: ["../file"] }), /asset IDs/);
  const ids = Array.from({ length: 513 }, (_, i) => String(i + 1));
  const token = await prepare(event, { assetIds: [...ids, "1"] });
  assert.deepEqual(batches, [512, 1]);
  assert.throws(() => start({ ...event, sender: {} }, token), /expired/);
  start(event, token);
  assert.deepEqual(starts, [
    {
      file: `${process.cwd()}/1.png`,
      files: ids.map((id) => `${process.cwd()}/${id}.png`),
      icon: { icon: true },
    },
  ]);
  assert.throws(() => start(event, token), /expired/);
});

test("missing files fail the whole drag and old resolutions cannot replace a newer drag", async () => {
  const pending = Promise.withResolvers<{ assets: unknown[] }>();
  const sender = { startDrag: () => assert.fail("must not start"), isDestroyed: () => false };
  const event = { sender };
  registerNativeIpc({
    isTrustedSender: () => true,
    client: {
      resolveAssets: (ids: string[]) =>
        ids[0] === "1" ? pending.promise : Promise.resolve({ assets: [] }),
    },
  });
  const prepare = handlers.get(channels.prepareFileDrag)!;
  const old = prepare(event, { assetIds: ["1"] });
  await assert.rejects(async () => prepare(event, { assetIds: ["2"] }), /no longer available/);
  pending.resolve({ assets: [{ id: "1", path: `${process.cwd()}/1.png`, displayName: "1" }] });
  await assert.rejects(async () => old, /superseded/);
});
