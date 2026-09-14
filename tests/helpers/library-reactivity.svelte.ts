import assert from "node:assert/strict";
import { flushSync } from "svelte";

import { createApplication } from "../../src/renderer/src/lib/application.svelte";
import { emptyLayout } from "../../src/renderer/src/lib/gallery/types";
import {
  createLibraryViewController,
  type LibraryViewController,
} from "../../src/renderer/src/lib/library-view.svelte";

const app = createApplication();
const { catalog, ocrSearch } = app.services;
catalog.selectedRoot = "library";
catalog.libraries = [{ root: "library", displayName: "Library", query: "", scrollTop: 0 }];
catalog.loading = false;
catalog.backendStatus = { ready: true, error: null };
const row = {
  cataloged: 0,
  indexed: 0,
  embedded: 0,
  pending: 0,
  lastIndexedAt: null,
  loading: false,
  error: null,
};
catalog.libraryStatuses.set("library", row);
let schedules = 0;
ocrSearch.schedule = () => {
  schedules++;
};
let view!: LibraryViewController;
const stop = $effect.root(() => {
  view = createLibraryViewController(app, () => {});
});
flushSync();
assert.equal(schedules, 1);
for (let offset = 100; offset <= 500; offset += 100) {
  catalog.updateLibraryViewState("library", { scrollTop: offset });
  catalog.libraryStatuses.set("library", { ...row });
  flushSync();
}
assert.equal(schedules, 1, "scroll saves and unchanged row snapshots must not restart search");
catalog.libraryStatuses.set("library", { ...row, loading: true });
flushSync();
catalog.libraryStatuses.set("library", { ...row, error: "Temporary status failure" });
flushSync();
assert.equal(schedules, 1, "transient status states must not toggle search engines");
view.handleGalleryScroll({ scrollTop: 900, layout: emptyLayout() });
flushSync();
assert.equal(schedules, 1);
ocrSearch.query = "cats";
flushSync();
assert.equal(schedules, 2, "query changes still search");
catalog.libraryStatuses.set("library", { ...row, indexed: 1 });
flushSync();
assert.equal(schedules, 3, "new OCR data enables text search");
const selection = view.gallerySelection;
selection.select("1", ["1"], { toggle: false, extend: false });
view.toggleSection("visual");
flushSync();
assert.equal(schedules, 3, "collapse does not schedule search");
ocrSearch.query = "dogs";
assert.notEqual(view.gallerySelection, selection, "selection resets synchronously for a new query");
flushSync();
assert.equal(schedules, 4);
view.dispose();
stop();
console.log("Library reactivity checks passed");
