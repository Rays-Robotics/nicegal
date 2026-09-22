import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveProtocolAssetPath } from "../src/main/protocol-path.ts";

const rendererDirectory = resolve("out", "renderer");

test("protocol assets resolve beneath the renderer output", () => {
  assert.equal(
    resolveProtocolAssetPath(rendererDirectory, "/index.html"),
    join(rendererDirectory, "index.html"),
  );
  assert.equal(
    resolveProtocolAssetPath(rendererDirectory, "/assets/index.js"),
    join(rendererDirectory, "assets", "index.js"),
  );
});

test("protocol assets reject malformed and escaping paths", () => {
  for (const pathname of [
    "",
    "/",
    "index.html",
    "/../main/index.js",
    "/%2e%2e/main/index.js",
    "/assets/%5c..%5c..%5cmain/index.js",
    "/assets/%E0%A4%A",
    "/assets/index.js%00.html",
  ]) {
    assert.equal(resolveProtocolAssetPath(rendererDirectory, pathname), null, pathname);
  }
});
