import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobSnapshot } from "../src/shared/backend.ts";

import { jobPhases, jobRateText } from "../src/renderer/src/lib/job-format.ts";

test("cataloging and indexing show valid backend phase rates, including zero", () => {
  for (const phase of [
    "cataloging",
    "scanning",
    "ocr",
    "imageEmbedding",
    "textEmbedding",
  ] as const) {
    const job = { status: "running", phase, progress: { itemsPerSecond: 12.5 } } as JobSnapshot;
    assert.equal(
      jobRateText(job),
      `${(12.5).toLocaleString(undefined, { maximumFractionDigits: 1 })} items/s`,
    );
    job.progress.itemsPerSecond = 0;
    assert.equal(jobRateText(job), "0 items/s");
    for (const rate of [undefined, null, NaN, Infinity, -1]) {
      job.progress.itemsPerSecond = rate;
      assert.equal(jobRateText(job), "");
    }
    job.progress.itemsPerSecond = 12;
    job.status = "completed";
    assert.equal(jobRateText(job), "");
    job.status = "running";
    job.phase = "loadingModels";
    assert.equal(jobRateText(job), "");
  }
});

test("progress shows images before OCR and keeps image-only pruning in Images", () => {
  const job = {
    type: "libraryIndex",
    indexStages: { ocr: false, image: true, text: false },
  } as JobSnapshot;
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "Images", "Done"],
  );
  assert.ok(jobPhases(job)[1].backendPhases.includes("pruning"));
  job.indexStages = { ocr: true, image: false, text: true };
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "OCR", "Text", "Done"],
  );
  delete job.indexStages;
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "Images", "OCR", "Text", "Done"],
  );
});
