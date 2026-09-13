# Nicegal

A Windows and Linux desktop gallery with fast thumbnail browsing, filename and OCR search,
semantic text search, and CLIP image similarity search. The frontend uses Electron,
Svelte 5, and TypeScript; [nicegal-server](https://github.com/bruh20059234802020490/nicegal-server)
provides the Rust indexing and search backend.

## Build from source

Install Node.js 22, pnpm 11.24.0, Rust 1.98.0 with the MSVC toolchain, Visual Studio
C++ build tools, and uv for Windows x64. The backend
build provisions Python 3.13 and its ONNX Runtime distributions with uv.

```powershell
git clone --recurse-submodules https://github.com/bruh20059234802020490/nicegal.git
cd nicegal
pnpm install --frozen-lockfile
pnpm build:win
```

Windows NSIS (`-setup.exe`), ZIP, and portable executable packages are written to
`dist/`. The installer defaults to the current user under `%LOCALAPPDATA%/Programs/`.
`pnpm build:unpack` produces an unpacked app for local testing.

### Windows installation and future updates

Upgrade by running a newer NSIS installer. Gallery databases remain in
`%APPDATA%/nicegal/nicegal-server/` outside the installation directory.

Automatic updates are not enabled yet. NSIS is the intended future
[electron-updater](https://www.electron.build/auto-update.html) path;
ZIP and portable builds will continue to use manual updates. The Windows build
already embeds the public `nicegal/nicegal` GitHub Releases destination and emits
`latest.yml` plus the NSIS blockmap. CI publishes these with the matching installer
and provenance in one release. Local builds use `--publish never`.

Keep `appId` and the NSIS identity stable across releases.
CI stamps increasing `0.0.N` versions; `0.0.0` is only a local placeholder.
Before enabling updates, add the runtime updater dependency and user-facing update
controls, configure Authenticode signing and publisher verification, and test
upgrade/restart/rollback behavior with the Rust backend shutdown. Current GitHub
releases are prereleases with numeric versions: the future updater must explicitly
opt into prereleases (or releases must become stable) and use the `latest` metadata
channel. Test with two published versions before enabling checks for users.

### Linux (x64)

Build on Ubuntu 24.04 with Node.js 22, pnpm 11.24.0, Rust 1.98.0, and uv:

```bash
sudo apt-get install build-essential pkg-config libssl-dev libclang-dev cmake nasm
pnpm install --frozen-lockfile
pnpm build:linux
```

AppImage and Debian packages are written to `dist/`. The backend build provisions
Python 3.13 in `nicegal-server/.venv-openvino` and bundles the wheel's ONNX Runtime
and OpenVINO shared libraries. Python is not required on the installed machine.
Linux defaults to OpenVINO with CPU fallback. GPU/NPU use requires suitable host
drivers; the package does not install them.

For WSL builds, keep a separate checkout on the Linux filesystem rather than
sharing Windows `node_modules` or Cargo output. Launch `dist/linux-unpacked/nicegal`
through WSLg to test the packaged app. If its Wayland window is not visible, use
`env -u WAYLAND_DISPLAY dist/linux-unpacked/nicegal --ozone-platform=x11`.
For development, run
`./dev.sh build --locked -p nicegal-server --no-default-features --features regex,ort-openvino`
inside `nicegal-server` after the first backend release build, then `pnpm dev`.

The desktop workflow builds Windows and Linux on separate native runners and
collects both sets of packages before publishing one release. This allows release
immutability to be enabled without either platform uploading to an already locked release.

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

The desktop workflow attaches GitHub build-provenance attestations to the Windows
NSIS, ZIP, portable executable, and update metadata, plus Linux AppImage and
Debian packages. Verify a downloaded file with GitHub CLI:

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
