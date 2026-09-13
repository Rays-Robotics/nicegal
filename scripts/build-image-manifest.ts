import { readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { readImageSize } from "./image-size";

const projectRoot = process.cwd();
const testdataRoot = join(projectRoot, "testdata", "pink");
const manifestPath = join(projectRoot, "testdata", "pink-index.json");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface ManifestImage {
  name: string;
  path: string;
  modifiedAt: number;
  width: number;
  height: number;
}

// Windows path separators need normalizing so the manifest is portable.
function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

async function buildManifest(): Promise<void> {
  const entries = await readdir(testdataRoot, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      imageExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()),
  );

  const images: ManifestImage[] = [];
  const skipped: string[] = [];

  for (const entry of files) {
    const absolutePath = join(entry.parentPath, entry.name);
    const relativePath = toPosixPath(relative(testdataRoot, absolutePath));
    const [{ mtimeMs }, size] = await Promise.all([
      stat(absolutePath),
      readImageSize(absolutePath),
    ]);

    if (!size) {
      skipped.push(relativePath);
      console.warn(`skipping ${relativePath}: could not read image size`);
      continue;
    }

    images.push({
      name: entry.name,
      path: relativePath,
      modifiedAt: mtimeMs,
      width: size.width,
      height: size.height,
    });
  }

  images.sort((left, right) => left.modifiedAt - right.modifiedAt);

  const manifest = { root: "testdata/pink", images };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`wrote ${images.length} images to ${manifestPath}`);
  if (skipped.length > 0) {
    console.log(`skipped ${skipped.length} file(s): ${skipped.join(", ")}`);
  }
}

buildManifest();
