# Circuit Node — desktop app

A native desktop wrapper around the **same `circuit-node-client`** the command-line install
uses. It makes running a node click-and-run: a system-tray background service, a setup wizard,
live dashboards, OS notifications, launch-on-login, and one-button updates — for the two ways a
machine can contribute:

- **CPU · Agent cloud** — lend spare CPU to host other people's agents under a budget you set.
  Any computer, no GPU, no Docker. The low-barrier path.
- **GPU · Inference mesh** — an NVIDIA GPU holds a slice of the decentralized model and serves
  inference. Heavier setup, bigger share.

The app does **not** replace the CLI. `node node-client.js start` still works exactly as before;
this is an additional, friendlier front door to the identical node.

---

## How it fits together

```
┌─────────────── Circuit Node.app (one signed bundle) ───────────────┐
│  Rust host (src-tauri)            Sidecar                Webview     │
│  • supervise sidecar      ──▶  circuit-node (bun-        (src/)      │
│  • tray · notifications        compiled, self-contained) mode picker │
│  • autostart · single-inst.    express/ws on :19000      + wizards   │
│  • node_api proxy (reqwest)  ◀── localhost API           + dashboard │
│  • manual update check                                              │
└─────────────────────────────────────────────────────────────────────┘
```

- **The webview never calls the node directly.** All node API calls go through the Rust
  `node_api` command (reqwest → `127.0.0.1:19000`), so there's no CORS to configure and the port
  / admin token never live in the frontend. Localhost is auto-trusted by the node.
- **The sidecar is the whole node-client, bun-compiled** into one self-contained binary (runtime
  + deps embedded — the user needs no Node install). It reads its two shipped assets
  (`client.example.json`, `dashboard.html`) from `CIRCUIT_NODE_ASSETS` (a read-only resource dir)
  and writes config + identity + cache to `CIRCUIT_NODE_HOME` (a writable per-user dir). That
  split is what lets the sidecar live inside a signed, read-only app bundle — see
  `../lib/home.js`.
- **Updates are manual by design.** The app detects a new release (GitHub) and shows a button;
  it never silently self-updates. Because the sidecar's code lives in the read-only bundle, an
  "update" is a new app install — the CLI keeps its own in-place `node node-client.js update`.

---

## Build

Prereqs: **Rust** (stable), **Node 22+**, **bun**, and the Tauri system deps for your OS
(<https://tauri.app/start/prerequisites/>). On Debian/Ubuntu:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Then:

```bash
cd desktop
npm install
npm run dev      # hot-run the app (builds the sidecar first via beforeDevCommand)
npm run build    # produce installers for the current OS
```

`npm run build` runs `scripts/build-sidecar.mjs` automatically (Tauri `beforeBuildCommand`),
which bun-compiles the sidecar and stages the assets, then bundles the native installer.

Regenerate the icon set after editing `icons/source.svg`:

```bash
npm run icons    # rsvg-convert → source.png → tauri icon
```

## Distribution & signing

Each OS must build on its own runner (the sidecar is compiled per-platform). See
`.github/workflows/desktop-build.yml`. Outputs:

| OS      | Installer            | Signing (required for public release)             |
|---------|----------------------|---------------------------------------------------|
| macOS   | `.dmg` (universal)   | Apple Developer ID + notarization                 |
| Windows | `.msi` / `-setup.exe`| Authenticode (EV cert avoids SmartScreen)         |
| Linux   | `.AppImage` / `.deb` | detached GPG (optional)                            |

Signing is wired through CI secrets (`APPLE_*`, `WINDOWS_CERTIFICATE*`). Unset → unsigned
artifacts, which is fine for internal testing but trips "unidentified developer" on users'
machines. **Budget the certs before a public release** (Apple $99/yr; Windows EV ~$200–400/yr).

## What needs a real machine (not buildable from a Linux box)

- **macOS `.dmg` + notarization** — needs macOS + an Apple Developer account.
- **Windows signed installer** — needs a Windows runner + an Authenticode cert.
- **GPU-mode end-to-end** — needs an NVIDIA box with Docker/the engine to exercise `/gpu/*` and
  `/dllm/worker/*`. The app wires and guides these; the engine/Docker image is provisioned
  separately (as it is for the CLI).
- **One-click CPU hosting** depends on the agent-cloud node-host being fetchable on the user's
  machine (`/setup/install/cpu`). Until that package is published, the CPU wizard falls back to a
  guided install step. Bundling the (private) node-host into the app is a deliberate later choice.
