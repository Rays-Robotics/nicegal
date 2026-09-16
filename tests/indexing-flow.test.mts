import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { JobOrchestrator as Orchestrator } from "../src/renderer/src/lib/job-orchestrator.svelte.ts";
import type { JobTracker } from "../src/renderer/src/lib/job-tracker.svelte.ts";
import type { JobRequest, JobSnapshot } from "../src/shared/backend.ts";

// Compile the actual rune module with the project's existing Svelte/Vite tools. Middleware mode
// opens no listening socket and never connects to Electron or the user's backend.
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-indexing-tests",
  plugins: [svelte()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { JobOrchestrator } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/job-orchestrator.svelte.ts",
)) as { JobOrchestrator: typeof Orchestrator };
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

function snapshot(
  type: JobSnapshot["type"],
  status: JobSnapshot["status"],
  jobId = "1",
): JobSnapshot {
  return {
    jobId,
    type,
    status,
    phase: status === "completed" ? "finished" : "queued",
    errors: [],
    progress: {} as JobSnapshot["progress"],
  };
}

function fixture(
  responses: JobSnapshot[],
  restartRequired = true,
): {
  orchestrator: Orchestrator;
  requests: JobRequest[];
  disconnect: (planned?: boolean) => boolean;
} {
  storage.clear();
  const requests: JobRequest[] = [];
  const jobs = {
    running: false,
    error: "",
    active: null as JobSnapshot | null,
    async start(request: JobRequest): Promise<JobSnapshot> {
      requests.push(request);
      const result = responses.shift();
      assert.ok(result, "unexpected extra job request");
      this.active = result;
      this.running = result.status === "running";
      if (result.status === "completed" || result.status === "failed")
        orchestrator.handleTerminalJob(result);
      return result;
    },
    async cancel(): Promise<void> {
      this.running = false;
    },
  };
  globalThis.window = {
    nicegal: {
      backend: {
        getRuntimeStatus: async () => ({
          restartRequired,
          activeExecutionProvider: "directml",
          configuredExecutionProvider: "openvino",
        }),
      },
    },
  } as unknown as Window & typeof globalThis;
  const orchestrator = new JobOrchestrator(
    jobs as unknown as JobTracker,
    () => "C:/other-library",
    async () => {},
    () => {},
  );
  return {
    orchestrator,
    requests,
    disconnect(planned = true): boolean {
      jobs.running = false;
      return orchestrator.backendDisconnected(planned);
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("model preparation persists index intent and waits for planned fallback before resuming the original root", async () => {
  const f = fixture([snapshot("ocrModelLoad", "completed"), snapshot("libraryIndex", "running")]);
  await f.orchestrator.startLibraryIndex("C:/photos");
  await flush();
  assert.equal(f.orchestrator.restartingIndex, true);
  assert.equal(f.requests.length, 1);
  assert.equal(storage.size, 1);
  assert.equal(f.disconnect(), true);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 2);
  assert.equal((f.requests[1].params as { root: string }).root, "C:/photos");
  assert.equal(f.orchestrator.indexing, true);
  f.orchestrator.handleTerminalJob(snapshot("libraryIndex", "completed"));
  assert.equal(f.orchestrator.indexing, false);
  assert.equal(storage.size, 0);
});

test("Stop during fallback cancels continuation and persisted intent", async () => {
  const f = fixture([snapshot("ocrModelLoad", "completed")]);
  await f.orchestrator.startLibraryIndex("C:/photos");
  await flush();
  f.disconnect();
  await f.orchestrator.cancel();
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 1);
  assert.equal(f.orchestrator.indexing, false);
  assert.equal(storage.size, 0);
});

test("ordinary crashes do not automatically replay indexing", async () => {
  const f = fixture([snapshot("libraryIndex", "running")]);
  await f.orchestrator.startLibraryIndex("C:/photos");
  assert.equal(f.disconnect(false), false);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 1);
});

test("repeated provider restarts cannot create an indexing retry loop", async () => {
  const f = fixture([snapshot("libraryIndex", "running"), snapshot("libraryIndex", "running")]);
  await f.orchestrator.startLibraryIndex("C:/photos");
  f.disconnect();
  await f.orchestrator.backendReady();
  assert.equal(f.disconnect(), false);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 2);
});

test("normal updates preserve cached failures; retry-failed is explicit", async () => {
  const f = fixture([snapshot("libraryIndex", "completed"), snapshot("libraryIndex", "completed")]);
  await f.orchestrator.startLibraryIndex("C:/photos");
  await f.orchestrator.startLibraryIndex("C:/photos", true);
  assert.equal(
    (f.requests[0] as Extract<JobRequest, { type: "libraryIndex" }>).params.scan?.retryFailed,
    undefined,
  );
  assert.equal(
    (f.requests[1] as Extract<JobRequest, { type: "libraryIndex" }>).params.scan?.retryFailed,
    true,
  );
  assert.equal(storage.size, 0);
});

test("Stop before the start response cancels the accepted backend job", async () => {
  const { JobTracker } = (await vite.ssrLoadModule(
    "/src/renderer/src/lib/job-tracker.svelte.ts",
  )) as { JobTracker: new (...args: unknown[]) => JobTracker };
  let accept!: (job: JobSnapshot) => void;
  const cancelled: string[] = [];
  globalThis.window = {
    nicegal: {
      backend: {
        startJob: () =>
          new Promise<JobSnapshot>((resolve) => {
            accept = resolve;
          }),
        subscribeJob: () => () => {},
        cancelJob: async (id: string) => {
          cancelled.push(id);
          return snapshot("libraryIndex", "cancelled", id);
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  const tracker = new JobTracker(
    () => {},
    () => {},
    () => {},
  );
  const start = tracker.start({ type: "libraryIndex", params: { root: "C:/photos" } });
  await tracker.cancel();
  accept(snapshot("libraryIndex", "running", "accepted"));
  await start;
  assert.deepEqual(cancelled, ["accepted"]);
  assert.equal(tracker.running, false);
  tracker.dispose();
});

for (const rejected of [false, true]) {
  test(`old cancellation ${rejected ? "failure" : "response"} cannot affect a restarted job`, async () => {
    const { JobTracker } = await vite.ssrLoadModule("/src/renderer/src/lib/job-tracker.svelte.ts");
    const reply = Promise.withResolvers<JobSnapshot>();
    const listeners: Array<(job: JobSnapshot) => void> = [];
    const connections: Array<(error: string | null) => void> = [];
    globalThis.window = {
      nicegal: {
        backend: {
          startJob: async () => snapshot("libraryIndex", "running"),
          subscribeJob: (
            _id: string,
            listener: (job: JobSnapshot) => void,
            connection: (error: string | null) => void,
          ) => {
            listeners.push(listener);
            connections.push(connection);
            return () => {};
          },
          cancelJob: () => reply.promise,
        },
      },
    } as unknown as Window & typeof globalThis;
    const tracker = new JobTracker(
      () => {},
      () => {},
      () => {},
    );
    await tracker.start({ type: "libraryIndex", params: { root: "C:/photos" } });
    const cancelling = tracker.cancel();
    tracker.backendDisconnected(true);
    await tracker.start({ type: "libraryIndex", params: { root: "C:/photos" } });
    listeners[0](snapshot("libraryIndex", "cancelled"));
    connections[0]("old connection failed");
    if (rejected) reply.reject(new Error("old cancellation failed"));
    else reply.resolve(snapshot("libraryIndex", "cancelled"));
    await cancelling;
    assert.equal(tracker.running, true);
    assert.equal(tracker.active?.status, "running");
    assert.equal(tracker.error, "");
    assert.equal(tracker.connectionError, null);
    listeners[1](snapshot("libraryIndex", "cancelled"));
    assert.equal(tracker.running, false, "current subscription still works");
    tracker.dispose();
  });
}

for (const loaded of [null, { executionProvider: "cpu" }]) {
  test(`Stop during model-state lookup prevents preparation (loaded=${Boolean(loaded)})`, async () => {
    const f = fixture([]);
    const reply = Promise.withResolvers<unknown>();
    Object.assign(window.nicegal.backend, { getOcrModels: () => reply.promise });
    const preparing = f.orchestrator.prepareSearchModels();
    await f.orchestrator.cancel();
    reply.resolve({ loaded });
    await preparing;
    assert.deepEqual(f.requests, []);
    assert.equal(f.orchestrator.preparingSearchModels, false);
  });
}

test("catalog polling detects an insertion during a row load", async () => {
  const { CatalogController } = await vite.ssrLoadModule("/src/renderer/src/lib/catalog.svelte.ts");
  let revision = "1";
  let lists = 0;
  const asset = {
    id: "1",
    displayName: "new.jpg",
    modifiedNs: "1000000",
    sourceSize: "1",
    mediaKind: "image",
    width: 1,
    height: 1,
  };
  globalThis.window = {
    nicegal: {
      backend: {
        getCatalogRevision: async () => revision,
        listAssets: async () => {
          lists++;
          if (lists === 1) {
            revision = "2"; // This insertion happened after the first list's snapshot.
            return [];
          }
          return [asset];
        },
        getImageEmbeddingCoverage: async () => ({}),
      },
    },
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
  const catalog = new CatalogController();
  catalog.selectedRoot = "C:/photos";
  catalog.backendStatus = { ready: true, error: null };
  await catalog.refresh();
  assert.equal(catalog.items.length, 0);
  await catalog.pollRevision();
  assert.equal(lists, 2);
  assert.equal(catalog.items[0]?.id, "1");
  await catalog.pollRevision();
  assert.equal(lists, 2, "a stable revision does not reload again");
  catalog.dispose();
});

for (const selection of [
  { ocr: true, image: false },
  { ocr: false, image: true },
]) {
  test(`index selection ${JSON.stringify(selection)} survives model preparation and fallback`, async () => {
    const f = fixture([snapshot("ocrModelLoad", "completed"), snapshot("libraryIndex", "running")]);
    await f.orchestrator.startLibraryIndex("C:/photos", true, selection);
    await flush();
    assert.equal(f.disconnect(), true);
    await f.orchestrator.backendReady();
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.equal(request.type, "libraryIndex");
      const params = (request as Extract<JobRequest, { type: "libraryIndex" }>).params;
      assert.equal(params.ocr, selection.ocr);
      assert.equal(params.image, selection.image);
      assert.equal(params.scan?.retryFailed, true);
    }
  });
  test(`index selection ${JSON.stringify(selection)} survives app restart`, async () => {
    const f = fixture([snapshot("libraryIndex", "running"), snapshot("libraryIndex", "running")]);
    await f.orchestrator.startLibraryIndex("C:/other-library", false, selection);
    f.disconnect(false);
    await f.orchestrator.resumeInterruptedJob();
    assert.equal(f.requests.length, 2);
    const params = (f.requests[1] as Extract<JobRequest, { type: "libraryIndex" }>).params;
    assert.equal(params.ocr, selection.ocr);
    assert.equal(params.image, selection.image);
  });
}

test("no selected search types cannot start a job", async () => {
  const f = fixture([]);
  await f.orchestrator.startLibraryIndex("C:/photos", false, { ocr: false, image: false });
  assert.equal(f.requests.length, 0);
  assert.equal(f.orchestrator.indexing, false);
});

for (const status of ["completed", "failed", "cancelled"] as const) {
  test(`immediately ${status} thumbnail job clears the resume record`, async () => {
    const f = fixture([snapshot("thumbnailGenerate", status)]);
    const request = { type: "thumbnailGenerate", params: { root: "C:/photos" } } as const;
    storage.set("nicegal.jobResume.v1", JSON.stringify({ root: "C:/photos", request }));
    await f.orchestrator.startResumableJob("C:/photos", request);
    assert.equal(storage.has("nicegal.jobResume.v1"), false);
  });
}

test("running thumbnail job remains resumable until its terminal snapshot", async () => {
  const f = fixture([snapshot("thumbnailGenerate", "running")]);
  await f.orchestrator.startResumableJob("C:/photos", {
    type: "thumbnailGenerate",
    params: { root: "C:/photos" },
  });
  assert.equal(storage.has("nicegal.jobResume.v1"), true);
  f.orchestrator.handleTerminalJob(snapshot("thumbnailGenerate", "completed"));
  assert.equal(storage.has("nicegal.jobResume.v1"), false);
});

test("automatic catalog refresh and coverage polling remain available", async () => {
  const { CatalogController } = await vite.ssrLoadModule("/src/renderer/src/lib/catalog.svelte.ts");
  let lists = 0;
  let revisions = 0;
  let coverage = 0;
  globalThis.window = {
    nicegal: {
      backend: {
        listAssets: async () => {
          lists++;
          return [];
        },
        getCatalogRevision: async () => {
          revisions++;
          return "1";
        },
        getImageEmbeddingCoverage: async () => {
          coverage++;
          return { total: 0, indexed: 0 };
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
  const catalog = new CatalogController();
  catalog.selectedRoot = "C:/photos";
  catalog.backendStatus = { ready: true, error: null };
  catalog.scheduleRefresh(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await catalog.pollRevision();
  assert.deepEqual([lists, revisions, coverage], [1, 2, 1]);
  await catalog.refresh();
  assert.deepEqual([lists, revisions, coverage], [2, 3, 1]);
  catalog.scheduleRefresh(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lists, 3);
  await catalog.pollRevision();
  assert.equal(coverage, 2);
  catalog.dispose();
});
