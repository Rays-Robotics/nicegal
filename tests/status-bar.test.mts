import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { LibraryRowStatus } from "../src/renderer/src/lib/catalog.svelte.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-status-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { render } = await vite.ssrLoadModule("svelte/server");
const { default: StatusBar } = await vite.ssrLoadModule(
  "/src/renderer/src/components/StatusBar.svelte",
);
const empty: LibraryRowStatus = {
  cataloged: 100,
  indexed: 0,
  embedded: 0,
  pending: 0,
  lastIndexedAt: null,
  loading: false,
  error: null,
};
function statusMarkup(
  status: LibraryRowStatus | undefined,
  indexRate: number | null,
  indexingRunning = true,
): string {
  return render(StatusBar, {
    props: {
      libraryName: "Library",
      libraryRoot: "library",
      hasLibrary: true,
      matchedCount: 100,
      totalCount: 100,
      filtering: false,
      searching: false,
      selectedCount: 0,
      status,
      message: undefined,
      backendReady: true,
      backendError: null,
      runtime: {},
      indexingRunning,
      indexRate,
      onsettings: () => {},
    },
  }).body;
}

test("unknown image coverage does not show OCR counts or throughput", () => {
  for (const status of [
    empty,
    undefined,
    { ...empty, loading: true },
    { ...empty, error: "Status unavailable" },
  ]) {
    const html = statusMarkup(status, 12.5);
    assert.doesNotMatch(html, /index-status/);
    assert.doesNotMatch(html, /images\/s/);
  }
  assert.doesNotMatch(statusMarkup({ ...empty, indexed: 100 }, 0), /index-status/);
});

test("image coverage is independent of OCR and uses the image denominator", () => {
  const html = statusMarkup({ ...empty, imageCoverage: { indexed: 25, total: 80 } }, 12.5);
  assert.match(html, /25 \/ 80 indexed/);
  assert.doesNotMatch(html, /index-status[^>]*title=|images\/s|with text/);
});

test("complete image coverage collapses to one number, including zero", () => {
  for (const count of [0, 80]) {
    const html = statusMarkup(
      { ...empty, imageCoverage: { indexed: count, total: count } },
      null,
      false,
    );
    assert.match(html, new RegExp(`>${count} indexed<`));
    assert.doesNotMatch(html, /index-status[^>]*title=/);
  }
  assert.match(
    statusMarkup({ ...empty, imageCoverage: { indexed: 0, total: 80 } }, null),
    /0 \/ 80 indexed/,
  );
});
