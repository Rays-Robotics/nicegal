import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "electron-vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));

function readCommit(directory: string): string {
  try {
    return execFileSync("git", ["-C", directory, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const frontendCommit = process.env["NICEGAL_FRONTEND_COMMIT"] ?? readCommit(repositoryDirectory);
const backendCommit =
  process.env["NICEGAL_BACKEND_COMMIT"] ??
  readCommit(fileURLToPath(new URL("./nicegal-server", import.meta.url)));

export default defineConfig({
  main: {
    define: {
      __NICEGAL_FRONTEND_COMMIT__: JSON.stringify(frontendCommit),
      __NICEGAL_BACKEND_COMMIT__: JSON.stringify(backendCommit),
    },
    build: {
      sourcemap: true,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    build: {
      cssMinify: true,
      sourcemap: true,
    },
    plugins: [svelte()],
  },
});
