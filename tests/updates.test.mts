import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { UpdateStatus } from "../src/shared/updates.ts";

const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
const messages: unknown[] = [];
const opened: string[] = [];
const feedUrls: string[] = [];
const releaseRequests: string[] = [];
const net = {
  fetch: async (input: string): Promise<Response> => {
    releaseRequests.push(input);
    return Response.json({ tag_name: "v0.0.42", prerelease: false, draft: false });
  },
};
const flushUpdateCheck = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const window = Object.assign(new EventEmitter(), {
  webContents: {
    isDestroyed: () => false,
    send: (_channel: string, status: unknown) => messages.push(status),
  },
});
let userData = mkdtempSync(join(tmpdir(), "nicegal-update-preferences-test-"));
const app = Object.assign(new EventEmitter(), { isPackaged: true, getPath: () => userData });
const powerMonitor = new EventEmitter();
let calls = 0;
let resolveDownload: () => void = () => {};
let cancelledDownloads = 0;
let downloads = 0;
const updater = Object.assign(new EventEmitter(), {
  autoInstallOnAppQuit: false,
  autoDownload: false,
  autoRunAppAfterInstall: true,
  allowPrerelease: false,
  channel: "",
  allowDowngrade: true,
  disableWebInstaller: false,
  disableDifferentialDownload: true,
  setFeedURL: (configuration: { provider: string; url: string }) => {
    assert.equal(configuration.provider, "generic");
    feedUrls.push(configuration.url);
  },
  checkForUpdates: async () => {
    calls++;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.0.42" });
    return {
      isUpdateAvailable: true,
      cancellationToken: {
        cancel: (): void => {
          cancelledDownloads++;
          resolveDownload();
        },
      },
    };
  },
  downloadUpdate: () => {
    downloads++;
    return new Promise<void>((resolve) => {
      resolveDownload = resolve;
    });
  },
});
const mocks = { app, window, net, powerMonitor, updater, handlers, opened };
(globalThis as typeof globalThis & { __updateMocks: typeof mocks }).__updateMocks = mocks;
// Simulated updater, temporary installed marker; never touches real installs or GitHub.
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-update-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "mock-updater",
      enforce: "pre",
      resolveId: (id) =>
        ["electron", "electron-updater"].includes(id) ? `\0update-${id}` : undefined,
      load: (id) => {
        if (id === "\0update-electron")
          return `
        const m = globalThis.__updateMocks;
        export const app = m.app;
        export const net = m.net;
        export const powerMonitor = m.powerMonitor;
        export const BrowserWindow = { getAllWindows: () => [m.window] };
        export const ipcMain = { handle: (name, handler) => m.handlers.set(name, handler) };
        export const shell = { openExternal: async (url) => { m.opened.push(url); } };
      `;
        if (id === "\0update-electron-updater")
          return "export default { autoUpdater: globalThis.__updateMocks.updater };";
        return undefined;
      },
    },
  ],
  ssr: { noExternal: ["electron", "electron-updater"] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { startUpdates, supportsAutomaticUpdates } = await vite.ssrLoadModule("/src/main/updates.ts");

test("only installed NSIS and AppImage builds support automatic updates", () => {
  assert.equal(supportsAutomaticUpdates(true, "win32", true, {}), true);
  assert.equal(supportsAutomaticUpdates(true, "win32", false, {}), false);
  assert.equal(
    supportsAutomaticUpdates(true, "win32", true, { PORTABLE_EXECUTABLE_FILE: "portable.exe" }),
    false,
  );
  assert.equal(supportsAutomaticUpdates(false, "win32", true, {}), false);
  assert.equal(
    supportsAutomaticUpdates(true, "linux", false, { APPIMAGE: "/app/nicegal.AppImage" }),
    true,
  );
  assert.equal(supportsAutomaticUpdates(true, "linux", false, {}), false);
  assert.equal(supportsAutomaticUpdates(true, "darwin", true, {}), false);
});

test("one check per launch, ready state, trusted notes and quit deferral", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  // Electron normally provides this property; Node does not.
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const previousResources = electronProcess.resourcesPath;
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-update-test-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    if (previousResources === undefined) delete electronProcess.resourcesPath;
    else electronProcess.resourcesPath = previousResources;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  const service = startUpdates((event: unknown) => event === "trusted");
  t.after(service.stop);
  assert.equal(updater.autoDownload, false, "downloads start explicitly with a cancellation token");
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.autoRunAppAfterInstall, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableDifferentialDownload, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.throws(() => handlers.get("updates:status")!("foreign"), /Untrusted/);
  await assert.rejects(async () => handlers.get("updates:release-notes")!("foreign"), /Untrusted/);
  const status = (): UpdateStatus => handlers.get("updates:status")!("trusted") as UpdateStatus;
  assert.deepEqual(status(), { phase: "idle", version: null });
  await handlers.get("updates:release-notes")!("trusted");
  assert.equal(opened.length, 0);
  t.mock.timers.tick(29_999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await flushUpdateCheck();
  assert.equal(calls, 1);
  assert.deepEqual(releaseRequests, [
    "https://api.github.com/repos/centuryofimage/nicegal/releases/latest",
  ]);
  assert.deepEqual(feedUrls, [
    "https://github.com/centuryofimage/nicegal/releases/download/v0.0.42",
  ]);
  assert.deepEqual(status(), { phase: "downloading", version: "0.0.42" });
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, 1, "no second check while the download promise is pending");
  updater.emit("update-downloaded", { version: "0.0.42" });
  resolveDownload();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(status(), { phase: "ready", version: "0.0.42" });
  assert.deepEqual(messages.at(-1), status());
  await handlers.get("updates:release-notes")!("trusted");
  assert.deepEqual(opened, ["https://github.com/centuryofimage/nicegal/releases/tag/v0.0.42"]);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, 1, "keep the downloaded version stable until quit");
  t.mock.method(console, "error", () => {});
  updater.emit("error", new Error("installation failed"));
  assert.deepEqual(status(), { phase: "ready", version: "0.0.42" });
  window.emit("query-session-end");
  assert.equal(updater.autoInstallOnAppQuit, false);
  updater.autoInstallOnAppQuit = true;
  powerMonitor.emit("shutdown");
  assert.equal(updater.autoInstallOnAppQuit, false);
  updater.autoInstallOnAppQuit = true;
  service.deferInstallation();
  assert.equal(
    updater.autoInstallOnAppQuit,
    false,
    "failed backend shutdown can suppress installation",
  );
  service.stop();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, 1);
});

test("dev is disabled and does not schedule checks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  app.isPackaged = false;
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = process.cwd();
  const service = startUpdates(() => true);
  delete electronProcess.resourcesPath;
  t.after(service.stop);
  const before = calls;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(calls, before);
  assert.deepEqual(handlers.get("updates:status")!({}), { phase: "disabled", version: null });
});

test("failed checks do not retry until the next launch; quitting before the delay cancels the check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(console, "error", () => {});
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-update-offline-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  app.isPackaged = true;
  let attempts = 0;
  t.mock.method(updater, "checkForUpdates", async () => {
    attempts++;
    throw new Error("offline");
  });
  const first = startUpdates(() => true);
  t.after(first.stop);
  t.mock.timers.tick(30_000);
  await flushUpdateCheck();
  assert.equal(attempts, 1);
  assert.deepEqual(handlers.get("updates:status")!({}), { phase: "error", version: null });
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal(attempts, 1, "no retry even after a week running");
  first.stop();
  const second = startUpdates(() => true);
  second.stop();
  t.mock.timers.tick(30_000);
  assert.equal(attempts, 1, "an early quit cancels the pending startup check");
});

test("opt-out persists, cancels a download, hides ready state and cannot re-arm this launch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(console, "error", () => {});
  userData = mkdtempSync(join(tmpdir(), "nicegal-update-optout-"));
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = userData;
  writeFileSync(join(userData, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  updater.removeAllListeners();
  app.isPackaged = true;
  const service = startUpdates((event: unknown) => event === "trusted");
  t.after(service.stop);
  const setEnabled = (value: unknown): unknown =>
    handlers.get("updates:set-enabled")!("trusted", value);
  assert.throws(() => handlers.get("updates:set-enabled")!("foreign", false), /Untrusted/);
  assert.throws(() => setEnabled("false"), /boolean/);
  assert.deepEqual(handlers.get("updates:preferences")!("trusted"), {
    enabled: true,
    supported: true,
  });
  const previousDownloads = downloads;
  t.mock.timers.tick(30_000);
  await flushUpdateCheck();
  assert.equal(downloads, previousDownloads + 1);
  const previousCancelled = cancelledDownloads;
  assert.deepEqual(setEnabled(false), { enabled: false, supported: true });
  assert.equal(cancelledDownloads, previousCancelled + 1);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(
    JSON.parse(readFileSync(join(userData, "update-settings.json"), "utf8")).automaticUpdates,
    false,
  );
  updater.emit("update-downloaded", { version: "0.0.42" });
  assert.deepEqual(handlers.get("updates:status")!("trusted"), {
    phase: "disabled",
    version: null,
  });
  setEnabled(true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  const previousCalls = calls;
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal(calls, previousCalls);
  setEnabled(false);
  service.stop();
  updater.removeAllListeners();
  const nextLaunch = startUpdates(() => true);
  t.after(nextLaunch.stop);
  t.mock.timers.tick(30_000);
  assert.equal(calls, previousCalls, "saved opt-out is read before scheduling");
  assert.deepEqual(handlers.get("updates:preferences")!({}), { enabled: false, supported: true });
});

test("invalid saved preferences fail closed; preference writes preserve unrelated files", async (t) => {
  const { loadAutomaticUpdates, saveAutomaticUpdates } = await vite.ssrLoadModule(
    "/src/main/update-preferences.ts",
  );
  const directory = mkdtempSync(join(tmpdir(), "nicegal-update-storage-"));
  const path = join(directory, "update-settings.json");
  assert.equal(loadAutomaticUpdates(path), true);
  t.mock.method(console, "error", () => {});
  writeFileSync(path, "not json");
  assert.equal(loadAutomaticUpdates(path), false);
  writeFileSync(path, '{"automaticUpdates":"false"}');
  assert.equal(loadAutomaticUpdates(path), false);
  const other = join(directory, "other-settings.json");
  writeFileSync(other, "keep me");
  saveAutomaticUpdates(path, false);
  assert.equal(loadAutomaticUpdates(path), false);
  saveAutomaticUpdates(path, true);
  assert.equal(loadAutomaticUpdates(path), true);
  assert.equal(readFileSync(other, "utf8"), "keep me");
});

test("latest release lookup accepts only a successful stable numeric release", async (t) => {
  const { latestStableReleaseFeed } = await vite.ssrLoadModule("/src/main/updates.ts");
  let response = Response.json({ tag_name: "v0.0.7", prerelease: false, draft: false });
  t.mock.method(net, "fetch", async () => response);
  assert.equal(
    await latestStableReleaseFeed(),
    "https://github.com/centuryofimage/nicegal/releases/download/v0.0.7",
  );
  response = Response.json({ tag_name: "v0.0.8-beta.1", prerelease: true, draft: false });
  await assert.rejects(latestStableReleaseFeed(), /stable numeric release/);
  response = Response.json({ tag_name: "v0.0.8/../../other", prerelease: false, draft: false });
  await assert.rejects(latestStableReleaseFeed(), /stable numeric release/);
  response = new Response("rate limited", { status: 403 });
  await assert.rejects(latestStableReleaseFeed(), /HTTP 403/);
});

test("opting out during the release lookup never starts an updater check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  userData = mkdtempSync(join(tmpdir(), "nicegal-update-lookup-optout-"));
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = userData;
  writeFileSync(join(userData, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  app.isPackaged = true;
  let finishLookup: (response: Response) => void = () => {};
  t.mock.method(
    net,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finishLookup = resolve;
      }),
  );
  const service = startUpdates(() => true);
  t.after(service.stop);
  const checksBefore = calls;
  const feedsBefore = feedUrls.length;
  t.mock.timers.tick(30_000);
  handlers.get("updates:set-enabled")!({}, false);
  finishLookup(Response.json({ tag_name: "v0.0.42", prerelease: false, draft: false }));
  await flushUpdateCheck();
  assert.equal(calls, checksBefore);
  assert.equal(feedUrls.length, feedsBefore);
  assert.deepEqual(handlers.get("updates:status")!({}), { phase: "disabled", version: null });
});
