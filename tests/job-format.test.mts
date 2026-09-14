import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobSnapshot } from "../src/shared/backend.ts";

import { jobPhases } from "../src/renderer/src/lib/job-format.ts";

test("progress shows images before OCR and keeps image-only pruning in Images", () => {
  const job = {
    type: "ocrIndex",
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
