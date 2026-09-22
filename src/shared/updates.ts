export interface UpdateStatus {
  phase: "disabled" | "idle" | "checking" | "downloading" | "ready" | "available" | "error";
  version: string | null;
}

export interface UpdatePreferences {
  enabled: boolean;
  mode: "automatic" | "notify" | "none";
}

export interface UpdateBridge {
  getPreferences(): Promise<UpdatePreferences>;
  setEnabled(enabled: boolean): Promise<UpdatePreferences>;
  getStatus(): Promise<UpdateStatus>;
  onStatusChanged(listener: (status: UpdateStatus) => void): () => void;
  openReleaseNotes(): Promise<void>;
  restartAndInstall(): Promise<void>;
}
