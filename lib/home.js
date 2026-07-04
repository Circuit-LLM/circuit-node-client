// lib/home.js — resolves the node-client's WRITABLE base directory.
//
// By default config/ and data/ live next to the code (INSTALL_ROOT = one level up from
// lib/). That is exactly right for a `git clone` + `node node-client.js` install — the CLI
// path — and setting nothing keeps that behaviour byte-for-byte.
//
// When the client is bundled as a read-only sidecar inside the CIRCUIT desktop app, its
// code lives in a read-only app bundle (a signed .app on macOS, Program Files on Windows).
// Writing config/data next to that code fails. The desktop app sets CIRCUIT_NODE_HOME to a
// writable per-user directory (e.g. ~/.local/share/circuit-node) so only the WRITABLE state
// — config/client.json, data/identity.json, the admin token, caches, update history —
// relocates there. Code and shipped assets (lib/, ui/) are always read from INSTALL_ROOT.
//
// Precedence: CIRCUIT_NODE_HOME (app) → INSTALL_ROOT (CLI default). Unset = no change.
'use strict';

const path = require('path');
const fs   = require('fs');

// Where the shipped assets live (config/client.example.json, ui/dashboard.html) — read-only.
// Normally next to the code. But when the client is bun-COMPILED into a single-file sidecar,
// __dirname points inside the virtual bundle (no assets on disk there), so the desktop app sets
// CIRCUIT_NODE_ASSETS to the on-disk resource dir that ships those two files. Unset = CLI default.
const INSTALL_ROOT = process.env.CIRCUIT_NODE_ASSETS
  ? path.resolve(process.env.CIRCUIT_NODE_ASSETS)
  : path.join(__dirname, '..');

// Writable base for config/ + data/. Defaults to INSTALL_ROOT so the CLI is unchanged.
const HOME = process.env.CIRCUIT_NODE_HOME
  ? path.resolve(process.env.CIRCUIT_NODE_HOME)
  : INSTALL_ROOT;

const CONFIG_DIR = path.join(HOME, 'config');
const DATA_DIR   = path.join(HOME, 'data');

// Create the writable dirs when HOME is relocated (a fresh app install has none yet).
// A no-op when HOME === INSTALL_ROOT and the dirs already exist.
function ensureDirs() {
  for (const d of [CONFIG_DIR, DATA_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* best-effort */ }
  }
}

const relocated = HOME !== INSTALL_ROOT;

module.exports = { INSTALL_ROOT, HOME, CONFIG_DIR, DATA_DIR, ensureDirs, relocated };
