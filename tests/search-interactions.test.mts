import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { OcrSearchController as Controller } from "../src/renderer/src/lib/ocr-search.svelte.ts";
import type { SearchRequest } from "../src/shared/backend.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-search-tests",
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { OcrSearchController } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/ocr-search.svelte.ts",
)) as { OcrSearchController: typeof Controller };

test("visual search waits for image coverage, then runs the unchanged query when ready", async () => {
  const { search, requests } = fixture();
  search.query = "like: cat";
  search.schedule("C:/pictures", [], "modified", true, false, false);
  await pause();
  assert.equal(requests.length, 0);
  assert.equal(search.imageSetupRequired, true);
  assert.match(search.indexNotice, /not ready/);
  search.schedule("C:/pictures", [], "modified", true, false, true);
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "image");
  assert.equal(search.imageSetupRequired, false);
  search.dispose();
});

test("adding a library starts one backend image index without enabling OCR", async () => {
  const { createApplication } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/application.svelte.ts",
  );
  const requests: unknown[] = [];
  globalThis.window = {
    nicegal: {
      backend: {
        startJob: async (request: unknown) => {
          requests.push(request);
          return {
            jobId: "automatic-images",
            type: "libraryIndex",
            status: "running",
            phase: "loadingModels",
            progress: { cataloged: 0, thumbnailsGenerated: 0 },
            errors: [],
          };
        },
        subscribeJob: () => () => {},
      },
    },
  } as unknown as Window & typeof globalThis;
  const app = createApplication();
  await app.commands.syncNewLibrary("C:/new-pictures");
  assert.deepEqual(requests, [
    {
      type: "libraryIndex",
      params: {
        root: "C:/new-pictures",
        ocr: false,
        image: true,
        scan: { recursive: true, cleanup: false },
      },
    },
  ]);
  await app.commands.syncNewLibrary("C:/another-folder");
  assert.equal(requests.length, 1, "do not queue another index while one is running");
  app.services.jobs.dispose();
  app.services.ocrSearch.dispose();
});
const photo = { id: "1", displayName: "cat.jpg" };
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

test("visual file picker results belong to the search session that opened it", async () => {
  const { chooseVisualFile } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/visual-search-input.ts",
  );
  const { search } = fixture();
  search.query = "like: cat";
  let resolvePicker!: (value: { displayName: string; bytesBase64: string }) => void;
  window.nicegal.native = {
    chooseVisualSearchImage: () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  } as typeof window.nicegal.native;
  const pending = chooseVisualFile(search);
  search.query = "name: dog";
  resolvePicker({ displayName: "example.jpg", bytesBase64: "aW1hZ2U=" });
  await pending;
  assert.equal(search.query, "name: dog");
  assert.equal(
    search.visualReferences.length,
    0,
    "late picker results cannot reopen visual search",
  );

  search.query = "like:";
  const current = chooseVisualFile(search);
  resolvePicker({ displayName: "example.jpg", bytesBase64: "aW1hZ2U=" });
  await current;
  assert.equal(search.visualReferences.length, 1);
  search.dispose();
});

function fixture(): { search: Controller; requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  globalThis.window = {
    nicegal: {
      backend: {
        getTextEmbeddingCoverage: async () => ({ indexed: 1, embedded: 1 }),
        searchOcr: async (request: SearchRequest) => {
          requests.push(request);
          assert.ok(
            request.query.trim() || request.imageQuery?.components.length,
            "never submit an empty search",
          );
          return { results: [], total: 0 };
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  return { search: new OcrSearchController(), requests };
}

test("adding images activates Looks like, opens the composer, and deduplicates repeated additions", () => {
  const { search } = fixture();
  search.query = "name: cat during:2026";
  search.addLibraryReferences([photo]);
  assert.equal(search.query, "like: cat during:2026");
  assert.equal(search.composerOpen, true);
  search.composerOpen = false;
  search.addLibraryReferences([photo]);
  assert.equal(search.visualReferences.length, 1);
  assert.equal(search.composerOpen, true);
});

test("closing preserves terms; clearing and every nonvisual scope discard images and open state", () => {
  for (const query of ["", " ", "name:", "ocr:", "meaning:", "cat"]) {
    const { search } = fixture();
    search.addLibraryReferences([photo]);
    search.composerOpen = false;
    assert.equal(search.visualReferences.length, 1);
    search.composerOpen = true;
    const revision = search.visualSessionRevision;
    search.query = query;
    assert.equal(search.visualReferences.length, 0, query);
    assert.equal(search.composerOpen, false, query);
    assert.ok(search.visualSessionRevision > revision);
    search.query = "like:";
    assert.equal(search.composerOpen, false);
    assert.equal(search.visualReferences.length, 0);
  }
});

test("Search Like This Image replaces descriptions, dates, weights and old image examples", () => {
  const { search } = fixture();
  search.query = "like: 2:cat - dog during:2026";
  search.addLibraryReferences([photo]);
  search.setVisualReferences(
    search.visualReferences.map((reference) => ({ ...reference, polarity: "less", strength: 3 })),
  );
  search.addLibraryReferences([photo], true);
  assert.equal(search.query, "like:");
  assert.equal(search.visualReferences.length, 1);
  assert.equal(search.visualReferences[0].polarity, "more");
  assert.equal(search.visualReferences[0].strength, 1);
  assert.equal(search.composerOpen, true);
});

test("clear and scope changes cancel a queued image search without sending empty text requests", async () => {
  for (const query of ["", "name:", "ocr:", "meaning:", "like:"]) {
    const { search, requests } = fixture();
    search.addLibraryReferences([photo]);
    search.schedule("library", [], "modified");
    search.query = query;
    if (query === "like:") search.setVisualReferences([]);
    search.schedule("library", [], "modified");
    await pause();
    assert.deepEqual(requests, [], query);
    assert.equal(search.pending, false);
    assert.equal(search.error, "");
    search.dispose();
  }
});

test("image-only searches submit components; removing the final row keeps the editor open without searching", async () => {
  const { search, requests } = fixture();
  search.addLibraryReferences([photo]);
  search.schedule("library", [], "modified");
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "image");
  assert.deepEqual(requests[0].imageQuery?.components, [{ assetId: 1, weight: 1 }]);
  search.setVisualReferences([]);
  search.schedule("library", [], "modified");
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(search.composerOpen, true);
  assert.equal(search.error, "");
  search.dispose();
});

test("partial weighted expressions do not send empty compositions", async () => {
  const { search, requests } = fixture();
  search.query = "like: 2:";
  search.schedule("library", [], "modified");
  await pause();
  assert.deepEqual(requests, []);
  assert.equal(search.pending, false);
  search.dispose();
});
