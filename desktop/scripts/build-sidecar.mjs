#!/usr/bin/env node
// build-sidecar.mjs — package the node-client as a Tauri sidecar.
//
// Two outputs, both consumed by tauri.conf.json:
//   1. src-tauri/binaries/circuit-node-<target-triple>[.exe]
//        the whole node-client bun-COMPILED into one self-contained executable
//        (runtime + deps embedded — no Node, no node_modules on the user's machine).
//   2. src-tauri/resources/node-client-assets/{config,ui}/
//        the two files the client reads from disk at runtime — the example config it
//        seeds client.json from, and the dashboard HTML. The compiled binary can't read
//        these from its virtual bundle, so the Rust host points CIRCUIT_NODE_ASSETS here.
//
// The compiled binary writes NOTHING next to itself: config/ and data/ go to
// CIRCUIT_NODE_HOME (a writable per-user dir the Rust host sets). That is what lets the
// sidecar live inside a read-only, signed app bundle.
//
// Usage: node scripts/build-sidecar.mjs [--triple <target-triple>]
'use strict';

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP    = path.resolve(__dirname, '..');
const REPO       = path.resolve(DESKTOP, '..');
const BIN_DIR    = path.join(DESKTOP, 'src-tauri', 'binaries');
const ASSET_DIR  = path.join(DESKTOP, 'src-tauri', 'resources', 'node-client-assets');

// Fail with a clear, actionable message when a required build tool is missing, instead of a raw
// `spawnSync <tool> ENOENT` stack trace. The compile needs bun; a host build also needs rustc.
function requireTool(cmd, name, hint) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`\n[sidecar] ${name} ("${cmd}") was not found on your PATH — it is required to build the desktop app.`);
    console.error(`[sidecar] Install it:  ${hint}`);
    console.error('[sidecar] Then REOPEN your terminal (so PATH refreshes) and run the build again.\n');
    process.exit(1);
  }
}

const BUN_HINT = 'https://bun.sh  —  Windows: powershell -c "irm bun.sh/install.ps1 | iex"  ·  macOS/Linux: curl -fsSL https://bun.sh/install | bash';

// ── Resolve the Rust target triple (Tauri names sidecars <name>-<triple>) ──────
function hostTriple() {
  requireTool('rustc', 'Rust (rustc)', 'https://rustup.rs');
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error('could not read host triple from `rustc -vV`');
  return m[1];
}
const tripleArg = process.argv.indexOf('--triple');
const triple    = tripleArg > -1 ? process.argv[tripleArg + 1] : hostTriple();
// bun cannot emit a universal (fat) binary, and lipo-ing two bun executables corrupts their
// embedded payloads. Fail loudly rather than silently shipping an x64-only sidecar in a
// "universal" bundle — build per-arch instead (aarch64-apple-darwin AND x86_64-apple-darwin).
if (triple.includes('universal')) {
  throw new Error('universal-apple-darwin is unsupported for the sidecar — build each macOS arch separately');
}
const isWin     = triple.includes('windows');
const exe       = isWin ? '.exe' : '';

// ── 1. Compile the sidecar binary ──────────────────────────────────────────────
mkdirSync(BIN_DIR, { recursive: true });
const outBin = path.join(BIN_DIR, `circuit-node-${triple}${exe}`);
requireTool('bun', 'Bun', BUN_HINT);

// The compile bundles node-client's runtime deps (express/qrcode/ws), so they must be present in the
// repo root. In CI only desktop/ installs its own deps, so the root node_modules is absent and bun
// fails with "Could not resolve: express". Install the root deps when missing (self-heals dev + CI).
if (!existsSync(path.join(REPO, 'node_modules', 'express'))) {
  console.log('[sidecar] installing node-client runtime deps (root node_modules missing)…');
  // Use bun (not npm): bun's binary resolves via execFileSync on every OS, whereas npm is npm.cmd on
  // Windows and fails with spawnSync ENOENT. bun install reads package.json → installs express/qrcode/ws.
  execFileSync('bun', ['install'], { cwd: REPO, stdio: 'inherit' });
}

console.log(`[sidecar] bun compile → ${path.relative(REPO, outBin)}`);
// --target lets a CI runner cross-compile the bun binary for the release triple.
const bunTarget = bunTargetFor(triple);
const args = ['build', '--compile', '--minify', 'node-client.js', '--outfile', outBin];
if (bunTarget) args.push(`--target=${bunTarget}`);
execFileSync('bun', args, { cwd: REPO, stdio: 'inherit' });
console.log(`[sidecar] ✓ ${(statSync(outBin).size / 1e6).toFixed(0)} MB`);

// ── 2. Stage the on-disk runtime assets (CIRCUIT_NODE_ASSETS) ───────────────────
rmSync(ASSET_DIR, { recursive: true, force: true });
mkdirSync(path.join(ASSET_DIR, 'config'), { recursive: true });
mkdirSync(path.join(ASSET_DIR, 'ui'),     { recursive: true });
copyFileSync(path.join(REPO, 'config', 'client.example.json'), path.join(ASSET_DIR, 'config', 'client.example.json'));
copyFileSync(path.join(REPO, 'ui', 'dashboard.html'),          path.join(ASSET_DIR, 'ui', 'dashboard.html'));
console.log('[sidecar] ✓ staged config/ui assets → resources/node-client-assets');

// Map a Rust target triple to the matching `bun --target`. Returns null to let bun use
// its host default (correct when building natively on each CI runner).
function bunTargetFor(t) {
  if (t.includes('windows'))              return 'bun-windows-x64';
  if (t.includes('darwin') && t.includes('aarch64')) return 'bun-darwin-arm64';
  if (t.includes('darwin'))               return 'bun-darwin-x64';
  if (t.includes('linux')  && t.includes('aarch64')) return 'bun-linux-arm64';
  if (t.includes('linux'))                return 'bun-linux-x64';
  return null;
}
