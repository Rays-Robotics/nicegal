Run `pnpm test` from the frontend root to run all Node tests in this directory.
Use `pnpm test:watch` during development, or `node --test tests/indexing-flow.test.mts`
for one file. Tests use Node’s built-in runner and the existing Vite/Svelte compiler;
no separate test package is required. IPC and lifecycle tests mock Electron and do not
connect to the running app or its catalog.

Rust tests remain with the backend crate. From `nicegal-server`, use
`./dev.cmd test -p nicegal-server -- --test-threads=1` on Windows or
`./dev.sh test -p nicegal-server -- --test-threads=1` on Linux. The existing API fixture
loads BGE and the active CLIP model's image/text towers, not every CLIP option.
Serial execution avoids loading duplicate sessions concurrently. Run it separately
from model benchmarks so test inference does not distort benchmark timings.

`library-reactivity.test.mjs` runs the real library controller with Svelte's client runtime
in an isolated Node process. Its local loader compiles `.svelte.ts` runes without a DOM shim.
It checks that scroll persistence and unchanged/loading/failed status snapshots do not
restart searches, while query changes and new OCR data do. `all-search.test.mts` also
covers malformed and deferred section responses and collapsed layouts in all three modes.
