/** Legacy single-library root. Migrated to `LIBRARIES_STORAGE_KEY` by `CatalogController`. */
export const LIBRARY_ROOT_STORAGE_KEY = "nicegal.libraryRoot.v1";

/** Versioned multi-library registry, including the selected root and per-library view state. */
export const LIBRARIES_STORAGE_KEY = "nicegal.libraries.v2";

/** The persisted gallery settings blob. */
export const SETTINGS_STORAGE_KEY = "nicegal.settings.v1";

/** Set after the first-start orientation splash has been dismissed. */
export const ONBOARDING_DISMISSED_STORAGE_KEY = "nicegal.onboardingDismissed.v1";

/** Pending resumable-job intent, retained across an interrupted indexing job. */
export const JOB_RESUME_STORAGE_KEY = "nicegal.jobResume.v1";

/** Marks that the one-time `file:` to `app:` origin migration has run for this profile. */
export const STORAGE_ORIGIN_MIGRATION_KEY = "nicegal.storageOriginMigration.v1";

export const PERSISTED_RENDERER_STORAGE_KEYS = [
  LIBRARY_ROOT_STORAGE_KEY,
  LIBRARIES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  ONBOARDING_DISMISSED_STORAGE_KEY,
  JOB_RESUME_STORAGE_KEY,
] as const;

export type PersistedRendererStorageKey = (typeof PERSISTED_RENDERER_STORAGE_KEYS)[number];
