import { contextBridge, ipcRenderer } from "electron";

import type {
  BackendStatus,
  AssetMetadata,
  TextEmbeddingCoverage,
  EnsureThumbnailsRequest,
  EnsureThumbnailsResponse,
  ExecutionProviderId,
  GalleryAsset,
  JobRequest,
  JobSnapshot,
  NativeBridge,
  ExternalVisualReference,
  NativeFileMenuRequest,
  NicegalBridge,
  OcrModelsResponse,
  SearchModelsResponse,
  RuntimeStatus,
  SearchRequest,
  SearchResponse,
  Timeline,
} from "../shared/backend";
import type { UpdateBridge, UpdateStatus } from "../shared/updates";

import { IPC_CHANNELS } from "../shared/ipc-channels";

const updates: UpdateBridge = {
  getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.updates.preferences),
  setEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.updates.setEnabled, enabled),
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updates.status),
  onStatusChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      listener(status);
    ipcRenderer.on(IPC_CHANNELS.updates.statusChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.updates.statusChanged, handler);
  },
  openReleaseNotes: () => ipcRenderer.invoke(IPC_CHANNELS.updates.releaseNotes),
  restartAndInstall: () => ipcRenderer.invoke(IPC_CHANNELS.updates.restartAndInstall),
};

const backend: NicegalBridge["backend"] = {
  getBackendStatus(): Promise<BackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.status);
  },
  onBackendStatusChanged(listener: (status: BackendStatus) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => {
      listener(status as BackendStatus);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.statusChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.backend.statusChanged, handler);
  },
  getRuntimeStatus(): Promise<RuntimeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.getRuntimeStatus);
  },
  setImageModel(model: string): Promise<RuntimeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.setImageModel, model);
  },
  setExecutionProvider(executionProvider: ExecutionProviderId): Promise<RuntimeStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.setExecutionProvider, executionProvider);
  },
  listAssets(options: { root: string; timeline: Timeline }): Promise<GalleryAsset[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.listAssets, options);
  },
  getAssetMetadata(assetId: string): Promise<AssetMetadata> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.assetMetadata, assetId);
  },
  countAssets(root: string): Promise<number> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.countAssets, root);
  },
  getCatalogRevision(): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.catalogRevision);
  },
  getTextEmbeddingCoverage(root: string): Promise<TextEmbeddingCoverage> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.getTextEmbeddingCoverage, root);
  },
  getOcrModels(): Promise<OcrModelsResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.getOcrModels);
  },
  getSearchModels(): Promise<SearchModelsResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.getSearchModels);
  },
  searchOcr(request: SearchRequest): Promise<SearchResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.search, request);
  },
  cancelSearch(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.cancelSearch);
  },
  startJob(request: JobRequest): Promise<JobSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.startJob, request);
  },
  cancelJob(jobId: string): Promise<JobSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.cancelJob, jobId);
  },
  ensureThumbnails(request: EnsureThumbnailsRequest): Promise<EnsureThumbnailsResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.backend.ensureThumbnails, request);
  },
  subscribeJob(
    jobId: string,
    listener: (snapshot: JobSnapshot) => void,
    onConnection?: (error: string | null) => void,
  ): () => void {
    let disposed = false;
    const handleSnapshot = (
      _event: Electron.IpcRendererEvent,
      message: { jobId: string; snapshot: JobSnapshot },
    ): void => {
      if (message.jobId === jobId) listener(message.snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.jobSnapshot, handleSnapshot);
    const handleConnection = (
      _event: Electron.IpcRendererEvent,
      message: { jobId: string; error: string | null },
    ): void => {
      if (!disposed && message.jobId === jobId) onConnection?.(message.error);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.jobConnection, handleConnection);
    void ipcRenderer
      .invoke(IPC_CHANNELS.backend.subscribeJob, jobId)
      .then(() => {
        if (disposed) void ipcRenderer.invoke(IPC_CHANNELS.backend.unsubscribeJob, jobId);
      })
      .catch((error: unknown) => {
        if (!disposed) onConnection?.(error instanceof Error ? error.message : String(error));
      });

    return (): void => {
      if (disposed) return;
      disposed = true;
      ipcRenderer.removeListener(IPC_CHANNELS.backend.jobSnapshot, handleSnapshot);
      ipcRenderer.removeListener(IPC_CHANNELS.backend.jobConnection, handleConnection);
      void ipcRenderer.invoke(IPC_CHANNELS.backend.unsubscribeJob, jobId);
    };
  },
};

const native: NativeBridge = {
  openExternalUrl(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.native.openExternalUrl, url);
  },
  openLicenseInformation(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.native.openLicenseInformation);
  },
  chooseDirectory(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.native.chooseDirectory);
  },
  chooseVisualSearchImage(): Promise<ExternalVisualReference | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.native.chooseVisualSearchImage);
  },
  onAddToVisualSearch(listener: (assetIds: string[], replace: boolean) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      assetIds: unknown,
      replace: unknown,
    ): void => {
      if (Array.isArray(assetIds) && assetIds.every((id) => typeof id === "string"))
        listener(assetIds, replace === true);
    };
    ipcRenderer.on(IPC_CHANNELS.native.addToVisualSearch, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.native.addToVisualSearch, handler);
  },
  showFileContextMenu(request: NativeFileMenuRequest): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.native.showFileContextMenu, request);
  },
};

contextBridge.exposeInMainWorld("nicegal", { backend, native, updates } satisfies NicegalBridge);
