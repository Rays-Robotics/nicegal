import { spawn } from "node:child_process";
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executable JavaScript cannot carry TypeScript return annotations. */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "..", "..");
const backendRepository = join(repository, "nicegal-server");
const executableName = process.platform === "win32" ? "nicegal-server.exe" : "nicegal-server";
const executable = process.argv[2] ?? join(backendRepository, "target", "debug", executableName);
const corpus = await realpath(process.argv[3] ?? join(repository, "testdata"));
const casesPath = process.argv[4] ?? join(scriptDirectory, "vector-search-cases.json");
const cases = JSON.parse(await readFile(casesPath, "utf8"));

if (!Array.isArray(cases) || cases.length === 0)
  throw new Error("evaluation cases must be a non-empty array");

const temporaryDirectory = await mkdtemp(join(tmpdir(), `nicegal-vector-eval-${process.pid}-`));
const token = randomBytes(32).toString("hex");
const child = spawn(
  executable,
  [
    "--asset-database",
    join(temporaryDirectory, "assets.db"),
    "--ocr-database",
    join(temporaryDirectory, "ocr.db"),
    "--thumbnail-database",
    join(temporaryDirectory, "thumbnails.db"),
  ],
  {
    cwd: backendRepository,
    env: {
      ...process.env,
      NICEGAL_RPC_TOKEN: token,
      TESSDATA_PREFIX: join(backendRepository, ".tessdata"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  const ready = await readReadyMessage(child);
  const endpoint = ready.endpoint;

  await runJob(endpoint, token, {
    type: "ocrIndex",
    params: {
      root: corpus,
      scan: { recursive: true, cleanup: false },
      indexer: { type: "tesseract" },
    },
  });
  const embedding = await runJob(endpoint, token, { type: "embed", params: { root: corpus } });
  if (embedding.progress.embedded === 0)
    throw new Error("the corpus produced no OCR-text embeddings");

  const resolvedCases = await Promise.all(
    cases.map(async (testCase) => ({
      ...testCase,
      assetIds: await Promise.all(
        testCase.relevant.map(async (path) => {
          const response = await request(
            endpoint,
            token,
            `/v1/assets?path=${encodeURIComponent(join(corpus, path))}`,
          );
          return String(response.assetId);
        }),
      ),
    })),
  );

  const results = [];
  for (const testCase of resolvedCases) {
    const response = await request(
      endpoint,
      token,
      `/v1/search?q=${encodeURIComponent(testCase.query)}&type=vector&root=${encodeURIComponent(corpus)}&limit=5`,
    );
    const rank =
      response.results.findIndex((result) => testCase.assetIds.includes(String(result.assetId))) +
      1;
    results.push({ query: testCase.query, relevant: testCase.relevant, rank: rank || null });
  }

  const missed = results.filter((result) => result.rank === null);
  const reciprocalRank =
    results.reduce((total, result) => total + (result.rank ? 1 / result.rank : 0), 0) /
    results.length;
  const recallAt = (limit) =>
    results.filter((result) => result.rank !== null && result.rank <= limit).length /
    results.length;
  const report = {
    corpus,
    indexed: embedding.progress.discovered,
    embedded: embedding.progress.embedded,
    cases: results,
    metrics: {
      recallAt1: recallAt(1),
      recallAt5: recallAt(5),
      meanReciprocalRank: reciprocalRank,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (missed.length) {
    throw new Error(
      `${missed.length} vector-search case(s) did not retrieve an expected asset in the top five`,
    );
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await once(child, "exit");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function request(endpoint, token, path, method = "GET", body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(value)}`);
  return value;
}

async function runJob(endpoint, token, requestBody) {
  const created = await request(endpoint, token, "/v1/jobs", "POST", requestBody);
  while (true) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
    const job = await request(endpoint, token, `/v1/jobs/${created.jobId}`);
    if (!["completed", "cancelled", "failed"].includes(job.status)) continue;
    if (job.status !== "completed")
      throw new Error(`${job.type} job ${job.status}: ${job.error ?? stderr}`);
    return job;
  }
}

function readReadyMessage(childProcess) {
  const lines = createInterface({ input: childProcess.stdout });
  return new Promise((resolveReady, rejectReady) => {
    const cleanup = () => {
      lines.close();
      childProcess.off("error", onError);
      childProcess.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(
        new Error(
          `nicegal-server exited before readiness: code=${code} signal=${signal}\n${stderr}`,
        ),
      );
    };
    childProcess.once("error", onError);
    childProcess.once("exit", onExit);
    lines.once("line", (line) => {
      cleanup();
      try {
        const ready = JSON.parse(line);
        if (ready.apiVersion !== 1 || typeof ready.endpoint !== "string")
          throw new Error("invalid readiness payload");
        resolveReady(ready);
      } catch (error) {
        rejectReady(new Error(`invalid readiness payload: ${line}`, { cause: error }));
      }
    });
  });
}
