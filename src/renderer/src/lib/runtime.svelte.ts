import type {
  ExecutionProviderId,
  RuntimeStatus,
  ImageModelStatus,
  SearchModelsResponse,
} from "../../../shared/backend";

import { errorMessage } from "./errors";

/**
 * The ONNX Runtime execution provider nicegal-server is running with, and the switcher's
 * pending state while a change is in flight. One instance is shared by `App.svelte` so the
 * Indexing Options switcher and the status bar's provider segment never disagree.
 */
export class RuntimeController {
  status = $state<RuntimeStatus | null>(null);
  loading = $state(true);
  /** True while a `setExecutionProvider` call is in flight. The server persists the setting with
   * a fixed temp-file path, so two overlapping writes can race each other's rename — serialize
   * from this side rather than let a fast double-click reach the server at all. */
  saving = $state(false);
  error = $state<string | null>(null);
  models = $state<SearchModelsResponse | null>(null);
  modelError = $state<string | null>(null);
  get imageModel(): ImageModelStatus | null {
    return this.status?.imageModel ?? null;
  }
  get supportsImageTextQueries(): boolean {
    return this.imageModel?.supportsTextQueries ?? true;
  }
  imageModelSaving = $state(false);
  imageModelError = $state<string | null>(null);
  ocrLoaded = $state(false);
  /**
   * The provider OCR models actually compiled onto, from `GET /v1/ocr/models`'s `loaded` field —
   * null until models have loaded this session. `status.activeExecutionProvider` is only the
   * provider the process was *launched* with; a model load can silently fall back further (e.g.
   * DirectML failing on hardware without a compatible GPU falls through to CPU), and that fallback
   * never updates `activeExecutionProvider`. This is the one place that reflects what's really
   * running, so callers should prefer it over `status.activeExecutionProvider` once it's set.
   */
  actualExecutionProvider = $state<string | null>(null);
  private statusGeneration = 0;
  private actualProviderGeneration = 0;
  private modelGeneration = 0;

  reset(): void {
    this.statusGeneration += 1;
    this.actualProviderGeneration += 1;
    this.modelGeneration += 1;
    this.status = null;
    this.models = null;
    this.actualExecutionProvider = null;
    this.ocrLoaded = false;
    this.loading = true;
    this.error = null;
    this.modelError = null;
  }

  /** What's actually running OCR inference right now: the real loaded-model provider once known,
   * else the process's launch-time provider as a best guess before any model has loaded. */
  get activeProvider(): string | null {
    return this.actualExecutionProvider ?? this.status?.activeExecutionProvider ?? null;
  }

  async refresh(): Promise<void> {
    // A read started during a provider write can return the old configuration and win the race.
    if (this.saving || this.imageModelSaving) return;
    const generation = ++this.statusGeneration;
    this.loading = true;
    this.error = null;
    try {
      const status = await window.nicegal.backend.getRuntimeStatus();
      if (generation === this.statusGeneration) this.status = status;
    } catch (error) {
      if (generation === this.statusGeneration) this.error = errorMessage(error);
    } finally {
      if (generation === this.statusGeneration) this.loading = false;
    }
  }

  /** Refreshes `actualExecutionProvider` from the OCR model-load state. Call after any
   * `ocrModelLoad` job completes, and once at startup in case models are already loaded from a
   * prior operation. A failed read is reported in Search settings. */
  async refreshActualProvider(): Promise<void> {
    const generation = ++this.actualProviderGeneration;
    try {
      const models = await window.nicegal.backend.getOcrModels();
      if (generation === this.actualProviderGeneration) {
        this.actualExecutionProvider = models.loaded?.executionProvider ?? null;
        this.ocrLoaded = Boolean(models.loaded);
      }
    } catch (error) {
      if (generation === this.actualProviderGeneration) this.modelError = errorMessage(error);
    }
  }

  async refreshModels(): Promise<void> {
    const generation = ++this.modelGeneration;
    try {
      const models = await window.nicegal.backend.getSearchModels();
      if (generation !== this.modelGeneration) return;
      this.models = models;
      this.modelError = null;
      await this.refreshActualProvider();
    } catch (error) {
      if (generation === this.modelGeneration) this.modelError = errorMessage(error);
    }
  }

  async setImageModel(model: string): Promise<void> {
    if (this.imageModelSaving || this.saving) return;
    this.imageModelSaving = true;
    this.imageModelError = null;
    try {
      this.status = await window.nicegal.backend.setImageModel(model);
      await this.refreshModels();
    } catch (error) {
      this.imageModelError = errorMessage(error);
    } finally {
      this.imageModelSaving = false;
      this.loading = false;
    }
  }

  async setExecutionProvider(executionProvider: ExecutionProviderId): Promise<void> {
    if (this.saving || this.imageModelSaving) return;
    this.statusGeneration += 1;
    this.saving = true;
    this.error = null;
    try {
      this.status = await window.nicegal.backend.setExecutionProvider(executionProvider);
      await this.refreshModels();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.saving = false;
      this.loading = false;
    }
  }
}
