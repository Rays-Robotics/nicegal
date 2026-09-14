import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { UpdateStatus } from "../shared/updates";

import { IPC_CHANNELS } from "../shared/ipc-channels";
import { loadAutomaticUpdates, saveAutomaticUpdates } from "./update-preferences";

const { autoUpdater } = electronUpdater;
const RELEASES = "https://github.com/centuryofimage/nicegal/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/centuryofimage/nicegal/releases/latest";

/** GitHub's web /releases/latest redirects; electron-updater 6.x expects JSON from it. */
export async function latestStableReleaseFeed(): Promise<string> {
  const response = await net.fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "nicegal-updater",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Latest release lookup failed: HTTP ${response.status}`);
  const release: unknown = await response.json();
  if (
    typeof release !== "object" ||
    release === null ||
    !("tag_name" in release) ||
    typeof release.tag_name !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !("prerelease" in release) ||
    release.prerelease !== false ||
    !("draft" in release) ||
    release.draft !== false
  ) {
    throw new Error("Latest release response is not a stable numeric release");
  }
  return `${RELEASES}/download/${release.tag_name}`;
}

/** Only the NSIS installer creates this marker; ZIP/portable share the same app payload. */
export function supportsAutomaticUpdates(
  packaged: boolean,
  platform: string,
  installed: boolean,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (!packaged) return false;
  if (platform === "win32") return installed && !environment.PORTABLE_EXECUTABLE_FILE;
  return platform === "linux" && Boolean(environment.APPIMAGE);
}

/** Main-process ownership keeps checks independent of gallery navigation and renderer reloads. */
export function startUpdates(isTrustedSender: (event: IpcMainInvokeEvent) => boolean): {
  stop: () => void;
  deferInstallation: () => void;
} {
  const supported = supportsAutomaticUpdates(
    app.isPackaged,
    process.platform,
    existsSync(join(process.resourcesPath, "nicegal-installed")),
    process.env,
  );
  const preferencesPath = join(app.getPath("userData"), "update-settings.json");
  let automaticUpdates = loadAutomaticUpdates(preferencesPath);
  // Once disabled, this launch stays opted out even if re-enabled. No second check, and no
  // accidentally re-armed cached installer; enabling takes effect on the next launch.
  let disabledForSession = !automaticUpdates;
  let cancelDownload: (() => void) | undefined;
  const mayUpdate = (): boolean => supported && !disabledForSession;
  const enabled = mayUpdate();
  let status: UpdateStatus = { phase: enabled ? "idle" : "disabled", version: null };
  let stopped = false;
  const timers: {
    initial?: ReturnType<typeof setTimeout>;
  } = {};

  const publish = (phase: UpdateStatus["phase"], version: string | null = null): void => {
    status = { phase, version };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed())
        window.webContents.send(IPC_CHANNELS.updates.statusChanged, status);
    }
  };
  const hasDownload = (): boolean => status.phase === "ready";
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedSender(event)) throw new Error("Untrusted update request");
  };
  ipcMain.handle(IPC_CHANNELS.updates.status, (event) => {
    authorize(event);
    return status;
  });
  ipcMain.handle(IPC_CHANNELS.updates.preferences, (event) => {
    authorize(event);
    return { enabled: automaticUpdates, supported };
  });
  ipcMain.handle(IPC_CHANNELS.updates.setEnabled, (event, value: unknown) => {
    authorize(event);
    if (typeof value !== "boolean") throw new Error("Automatic updates must be a boolean");
    // Persist first: failed writes must not report a preference as saved.
    saveAutomaticUpdates(preferencesPath, value);
    automaticUpdates = value;
    if (!value) {
      disabledForSession = true;
      clearTimeout(timers.initial);
      autoUpdater.autoInstallOnAppQuit = false;
      cancelDownload?.();
      publish("disabled");
    }
    return { enabled: automaticUpdates, supported };
  });
  ipcMain.handle(IPC_CHANNELS.updates.releaseNotes, async (event) => {
    authorize(event);
    if (status.phase !== "ready" || !status.version) return;
    // Never navigate to arbitrary URLs supplied by release metadata or by the renderer.
    await shell.openExternal(`${RELEASES}/tag/v${encodeURIComponent(status.version)}`);
  });

  const deferInstallation = (): void => {
    autoUpdater.autoInstallOnAppQuit = false;
  };
  const stop = (): void => {
    stopped = true;
    clearTimeout(timers.initial);
  };
  if (!enabled) {
    autoUpdater.autoInstallOnAppQuit = false;
    return { stop, deferInstallation };
  }

  autoUpdater.logger = console;
  // Start the download explicitly so opting out while the feed request is in flight cannot
  // start an unwanted download, and so we hold its cancellation token before work begins.
  autoUpdater.autoDownload = false;
  // electron-updater 6.x's equivalent of v7's autoInstallEvent = "onQuit".
  // Its install hook runs on `quit`, AFTER index.ts's asynchronous before-quit backend drain.
  // Do not call quitAndInstall(): that starts the installer before the backend has stopped.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.channel = "latest";
  autoUpdater.allowDowngrade = false; // Setting the channel enables downgrades unless reset.
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = false;

  // 6.x lacks v7's session-end guard. Do not start an installer during OS shutdown/logoff.
  // Leave the verified download cached for the next launch/check and normal quit.
  powerMonitor.on("shutdown", deferInstallation);
  const watchWindow = (window: BrowserWindow): void => {
    window.on("query-session-end", deferInstallation);
    window.on("session-end", deferInstallation);
  };
  BrowserWindow.getAllWindows().forEach(watchWindow);
  app.on("browser-window-created", (_event, window) => watchWindow(window));

  autoUpdater.on("checking-for-update", () => {
    if (mayUpdate()) publish("checking");
  });
  autoUpdater.on("update-available", (info) => {
    if (mayUpdate()) publish("downloading", info.version);
  });
  autoUpdater.on("update-not-available", () => {
    if (mayUpdate()) publish("idle");
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (mayUpdate()) publish("ready", info.version);
  });
  autoUpdater.on("error", (error) => {
    console.error("Automatic update failed", error);
    // A later installation error must not pretend the downloaded update disappeared.
    if (mayUpdate() && status.phase !== "ready") publish("error");
  });

  const check = async (): Promise<void> => {
    if (stopped || !mayUpdate()) return;
    try {
      const feedUrl = await latestStableReleaseFeed();
      if (stopped || !mayUpdate()) return;
      // Keep electron-updater's verified NSIS/AppImage downloads and versioned blockmap URLs,
      // while bypassing its GitHub provider's broken /releases/latest JSON lookup.
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable || stopped || !mayUpdate()) return;
      const token = result.cancellationToken;
      if (!token) throw new Error("Update check returned no download cancellation token");
      cancelDownload = () => token.cancel();
      await autoUpdater.downloadUpdate(token);
    } catch (error) {
      console.error("Automatic update check/download failed", error);
      if (mayUpdate() && !hasDownload()) publish("error");
    } finally {
      cancelDownload = undefined;
    }
  };
  // One check per launch, after initial gallery startup. No polling or in-session retry.
  timers.initial = setTimeout(() => void check(), 30_000);
  timers.initial.unref();
  return { stop, deferInstallation };
}
