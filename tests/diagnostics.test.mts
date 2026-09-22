import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "nicegal-diagnostics-test-"));
const outputPath = join(directory, "nicegal-diagnostics.zip");
const dialogResult = { canceled: false, filePath: outputPath };
const calls = { flushes: 0 };
const mocks = {
  app: {
    getVersion: () => "1.2.3",
    getName: () => "Nicegal",
    getPath: () => directory,
    isPackaged: true,
  },
  dialog: {
    showSaveDialog: async () => dialogResult,
  },
};
Object.assign(globalThis, { __diagnosticMocks: mocks });
process.env["NICEGAL_STATE_DIR"] = directory;

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-diagnostics-tests",
  define: {
    __NICEGAL_FRONTEND_COMMIT__: JSON.stringify("front1234567"),
    __NICEGAL_BACKEND_COMMIT__: JSON.stringify("back12345678"),
  },
  plugins: [
    {
      name: "mock-diagnostics-electron",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0diagnostics-electron" : undefined),
      load: (id) =>
        id === "\0diagnostics-electron"
          ? `export const app = globalThis.__diagnosticMocks.app;
             export const dialog = globalThis.__diagnosticMocks.dialog;`
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});

after(async () => {
  delete process.env["NICEGAL_STATE_DIR"];
  await vite.close();
  await rm(directory, { recursive: true, force: true });
});

const diagnostics = await vite.ssrLoadModule("/src/main/diagnostics.ts");

test("collectDiagnostics saves build details and backend files in a zip", async () => {
  const privatePath = String.raw`C:\Users\someone\Pictures\private.jpg`;
  await writeFile(join(directory, "backend.log"), `${privatePath}\n`, "utf8");
  await writeFile(join(directory, "backend.log.1"), "previous log\n", "utf8");
  await writeFile(join(directory, "runtime.json"), '{"executionProvider":"cpu"}\n', "utf8");

  const savedPath = await diagnostics.collectDiagnostics(
    {},
    {
      backendStatus: { ready: true, error: null },
      flushBackendLog: async () => {
        calls.flushes += 1;
      },
    },
  );

  assert.equal(savedPath, outputPath);
  assert.equal(calls.flushes, 1);
  const zip = new AdmZip(await readFile(outputPath));
  assert.deepEqual(
    zip
      .getEntries()
      .map((entry) => entry.entryName)
      .toSorted(),
    ["backend.log", "backend.log.1", "diagnostics.json", "runtime.json"],
  );
  assert.match(zip.readAsText("backend.log"), /private\.jpg/);
  const manifest = JSON.parse(zip.readAsText("diagnostics.json"));
  assert.deepEqual(manifest.application, {
    name: "Nicegal",
    version: "1.2.3",
    packaged: true,
    frontendCommit: "front1234567",
    backendCommit: "back12345678",
  });
  assert.deepEqual(manifest.backend, { ready: true, error: null });
  assert.deepEqual(
    manifest.files.map((file: { name: string }) => file.name),
    ["backend.log", "backend.log.1", "runtime.json"],
  );
});

test("collectDiagnostics stops when the save dialog is canceled", async () => {
  dialogResult.canceled = true;
  const savedPath = await diagnostics.collectDiagnostics(
    {},
    {
      backendStatus: { ready: false, error: "offline" },
      flushBackendLog: async () => {
        calls.flushes += 1;
      },
    },
  );
  assert.equal(savedPath, null);
  assert.equal(calls.flushes, 1, "canceling does not start a second collection");
});
