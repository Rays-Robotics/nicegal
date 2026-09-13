# Nicegal

A Windows desktop gallery with fast thumbnail browsing, filename and OCR search,
semantic text search, and CLIP image similarity search. The frontend uses Electron,
Svelte 5, and TypeScript; [nicegal-server](https://github.com/nicegal/nicegal-server)
provides the Rust indexing and search backend.

## Build from source

Install Node.js 22, pnpm 11.24.0, Rust 1.98.0 with the MSVC toolchain, Visual Studio
C++ build tools, and uv. Windows x64 is the supported build target. The backend
build provisions Python 3.13 and its ONNX Runtime distributions with uv.

```powershell
git clone --recurse-submodules https://github.com/nicegal/nicegal.git
cd nicegal
pnpm install --frozen-lockfile
pnpm build:win
```

Windows ZIP and portable executable packages are written to `dist/`.
`pnpm build:unpack` produces an unpacked app for local testing.

## Development

Build the debug backend from its workspace, then start Electron:

```powershell
cd nicegal-server
.\build-server.cmd
.\dev.cmd build --locked -p nicegal-server
cd ..
pnpm dev
```

Rebuild the debug backend after Rust changes, closing the running app first.
Electron uses `nicegal-server/target/debug/nicegal-server.exe` in development.
`NICEGAL_SERVER_PATH` overrides the executable and `NICEGAL_STATE_DIR` overrides
the database directory. The default database directory is
`%APPDATA%/nicegal/nicegal-server/`.

`pnpm build` runs TypeScript/Svelte checks and builds the frontend; `pnpm lint`
runs ESLint. `pnpm dev` exposes Chrome DevTools Protocol on localhost port 9222.
The backend [API reference](nicegal-server/INTERNAL_API.md) describes the HTTP contract.

## Verify downloads

Release workflows attach GitHub build-provenance attestations to the Windows
ZIP and portable executable. Verify the downloaded file with GitHub CLI:

```powershell
gh attestation verify PATH_TO_DOWNLOADED_FILE --repo nicegal/nicegal
```

This checks the artifact's provenance against this repository. It is separate
from Windows Authenticode signing.

## License

The original frontend code is licensed under [MIT](LICENSE). The original backend
code is licensed under [PolyForm Internal Use 1.0.0](nicegal-server/LICENSE).
Modified third-party code in `nicegal-server/vendor/` remains Apache-2.0.
These terms do not replace separately identified component licenses. Downloaded
model weights are subject to their publishers' licenses. See [LICENSING](LICENSING).

The backend is source-available; its license does not grant redistribution rights.
