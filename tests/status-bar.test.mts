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

test("live indexing rate remains visible without a saved OCR count", () => {
  for (const status of [
    empty,
    undefined,
    { ...empty, loading: true },
    { ...empty, error: "Status unavailable" },
  ]) {
    const html = statusMarkup(status, 12.5);
    assert.match(html, /index-status/);
    assert.match(html, /12[.,]5 images\/s/);
  }
  assert.match(statusMarkup(empty, 0), /0 images\/s/);
});

test("idle empty libraries stay quiet; completed coverage remains visible", () => {
  assert.doesNotMatch(statusMarkup(empty, null, false), /index-status/);
  assert.doesNotMatch(statusMarkup(empty, 12.5, false), /images\/s/);
  const html = statusMarkup({ ...empty, indexed: 25 }, null, false);
  assert.match(html, /25 \/ 100 with text/);
});
