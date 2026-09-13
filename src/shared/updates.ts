export interface UpdateStatus {
  phase: "disabled" | "idle" | "checking" | "downloading" | "ready" | "error";
  version: string | null;
}

export interface UpdatePreferences {
  enabled: boolean;
  supported: boolean;
}

export interface UpdateBridge {
  getPreferences(): Promise<UpdatePreferences>;
  setEnabled(enabled: boolean): Promise<UpdatePreferences>;
  getStatus(): Promise<UpdateStatus>;
  onStatusChanged(listener: (status: UpdateStatus) => void): () => void;
  openReleaseNotes(): Promise<void>;
}
