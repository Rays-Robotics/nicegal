/** Small app-level values persisted outside the gallery settings blob, plus anything else that
 * deserves one obvious home instead of being inlined at its call site (future update-server
 * URLs, etc). */

/** Legacy single-library root. Migrated to `LIBRARIES_STORAGE_KEY` by `CatalogController`. */
export const LIBRARY_ROOT_STORAGE_KEY = "nicegal.libraryRoot.v1";

/** Versioned multi-library registry, including the selected root and per-library view state. */
export const LIBRARIES_STORAGE_KEY = "nicegal.libraries.v2";

/** The persisted `GallerySettings` blob (see `lib/settings.svelte.ts`). */
export const SETTINGS_STORAGE_KEY = "nicegal.settings.v1";

/** Set after the first-start orientation splash has been dismissed. */
export const ONBOARDING_DISMISSED_STORAGE_KEY = "nicegal.onboardingDismissed.v1";

/** Pending resumable-job intent (see `lib/job-resume.ts`), so an interrupted index/backfill
 * picks back up on the next launch instead of silently stopping when the app exits mid-job. */
export const JOB_RESUME_STORAGE_KEY = "nicegal.jobResume.v1";
