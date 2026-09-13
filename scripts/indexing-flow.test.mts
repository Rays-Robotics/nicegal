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
  server: { middlewareMode: true },
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
  const f = fixture([snapshot("ocrModelLoad", "completed"), snapshot("ocrIndex", "running")]);
  await f.orchestrator.startOcrIndex("C:/photos");
  await flush();
  assert.equal(f.orchestrator.restartingIndex, true);
  assert.equal(f.requests.length, 1);
  assert.equal(storage.size, 1);
  assert.equal(f.disconnect(), true);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 2);
  assert.equal((f.requests[1].params as { root: string }).root, "C:/photos");
  assert.equal(f.orchestrator.indexing, true);
  f.orchestrator.handleTerminalJob(snapshot("ocrIndex", "completed"));
  assert.equal(f.orchestrator.indexing, false);
  assert.equal(storage.size, 0);
});

test("Stop during fallback cancels continuation and persisted intent", async () => {
  const f = fixture([snapshot("ocrModelLoad", "completed")]);
  await f.orchestrator.startOcrIndex("C:/photos");
  await flush();
  f.disconnect();
  await f.orchestrator.cancel();
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 1);
  assert.equal(f.orchestrator.indexing, false);
  assert.equal(storage.size, 0);
});

test("ordinary crashes do not automatically replay indexing", async () => {
  const f = fixture([snapshot("ocrIndex", "running")]);
  await f.orchestrator.startOcrIndex("C:/photos");
  assert.equal(f.disconnect(false), false);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 1);
});

test("repeated provider restarts cannot create an indexing retry loop", async () => {
  const f = fixture([snapshot("ocrIndex", "running"), snapshot("ocrIndex", "running")]);
  await f.orchestrator.startOcrIndex("C:/photos");
  f.disconnect();
  await f.orchestrator.backendReady();
  assert.equal(f.disconnect(), false);
  await f.orchestrator.backendReady();
  assert.equal(f.requests.length, 2);
});

test("normal updates preserve cached failures; retry-failed is explicit", async () => {
  const f = fixture([snapshot("ocrIndex", "completed"), snapshot("ocrIndex", "completed")]);
  await f.orchestrator.startOcrIndex("C:/photos");
  await f.orchestrator.startOcrIndex("C:/photos", true);
  assert.equal(
    (f.requests[0] as Extract<JobRequest, { type: "ocrIndex" }>).params.scan?.retryFailed,
    undefined,
  );
  assert.equal(
    (f.requests[1] as Extract<JobRequest, { type: "ocrIndex" }>).params.scan?.retryFailed,
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
          return snapshot("ocrIndex", "cancelled", id);
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  const tracker = new JobTracker(
    () => {},
    () => {},
    () => {},
  );
  const start = tracker.start({ type: "ocrIndex", params: { root: "C:/photos" } });
  await tracker.cancel();
  accept(snapshot("ocrIndex", "running", "accepted"));
  await start;
  assert.deepEqual(cancelled, ["accepted"]);
  assert.equal(tracker.running, false);
  tracker.dispose();
});
