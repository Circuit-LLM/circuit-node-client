#!/usr/bin/env node
// Refresh vendor/agent-cloud/ from its source repos and STAMP what was copied.
//
// Why this exists. The node-client cannot import the agent-cloud at runtime: the desktop app is a
// bun-compiled single binary, so the node-host and the sealed agents have to be physically present in
// this repo. That copy is unavoidable — what IS avoidable is the copy silently falling behind, which is
// exactly what happened between 2026-07-16 and 2026-07-24 (the vendored host missed the Command Inbox
// relay, and the vendored Signal Scout missed the matching agent-side support, so a scout hosted by the
// desktop app quietly ignored every owner command).
//
// So: one command does the whole sync, and it writes vendor/VENDOR.json recording the source commit and
// a sha256 per artifact. test/vendor-drift.test.js then fails the build when the stamp and the files
// disagree, or when a sibling checkout has moved past what we vendored.
//
// Usage:
//   node scripts/sync-vendor.mjs                 # sibling checkouts in ~, rebuild the scout bundles
//   node scripts/sync-vendor.mjs --no-build      # copy only; reuse each scout's existing build output
//   node scripts/sync-vendor.mjs --agent-cloud /path/to/circuit-agent-cloud
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'agent-cloud');

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const HOME = os.homedir();
const SRC = {
  'circuit-agent-cloud': flag('agent-cloud', path.join(HOME, 'circuit-agent-cloud')),
  'circuit-signal-agent': flag('signal', path.join(HOME, 'circuit-signal-agent')),
  'circuit-nft-agent': flag('nft', path.join(HOME, 'circuit-nft-agent')),
};
const BUILD = !argv.includes('--no-build');

// Exactly what the node-host needs — traced from its import graph plus the two things it SPAWNS
// (agentd, the egress sidecar). Control-plane-only libs are deliberately not vendored: they were, they
// went stale, and nothing here could ever have loaded them.
const AGENT_CLOUD_FILES = [
  'lib/agent-types.js', 'lib/bundle-store.js', 'lib/bundle.js', 'lib/ed25519.js',
  'lib/netguard.js', 'lib/node-auth.js', 'lib/proto.js',
  'node-host/host.js', 'node-host/env.js', 'node-host/oci.js',
  'node-host/egress-proxy.js', 'node-host/egress-proxy-main.js',
  'agentd/agentd.js',
];
// Sealed agent types shipped as one self-contained file each (built by the scout's own build.mjs).
const SEALED_AGENTS = [
  { repo: 'circuit-signal-agent', dir: 'signal-agent', workload: 'signal-scout' },
  { repo: 'circuit-nft-agent', dir: 'nft-agent', workload: 'nft-scout' },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };

function requireDir(label, dir) {
  if (!fs.existsSync(dir)) { console.error(`✗ ${label} not found at ${dir} — pass --${label.replace('circuit-', '').replace('-agent', '')} <path>`); process.exit(1); }
}
for (const [label, dir] of Object.entries(SRC)) requireDir(label, dir);

const stamp = { syncedAt: new Date().toISOString(), sources: {}, files: {} };

// 1. source provenance — a dirty source is recorded, not silently blessed
for (const [name, dir] of Object.entries(SRC)) {
  const dirty = !!git(dir, ['status', '--porcelain']);
  stamp.sources[name] = { commit: git(dir, ['rev-parse', 'HEAD']), dirty };
  if (dirty) console.warn(`⚠ ${name} has uncommitted changes — vendoring them anyway, recorded as dirty`);
}

// 2. copy the agent-cloud files
const cloud = SRC['circuit-agent-cloud'];
for (const rel of AGENT_CLOUD_FILES) {
  const from = path.join(cloud, rel);
  if (!fs.existsSync(from)) { console.error(`✗ missing in source: ${rel}`); process.exit(1); }
  const to = path.join(VENDOR, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const bytes = fs.readFileSync(from);
  fs.writeFileSync(to, bytes);
  stamp.files['agent-cloud/' + rel] = sha256(bytes);
}
console.log(`✓ agent-cloud: ${AGENT_CLOUD_FILES.length} files`);

// 3. build + copy each sealed agent's self-contained entry
for (const a of SEALED_AGENTS) {
  const repo = SRC[a.repo];
  if (BUILD) {
    process.stdout.write(`  building ${a.repo}… `);
    execFileSync('node', ['build.mjs'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log('ok');
  }
  const built = path.join(repo, 'build', 'stage', 'agent.cjs');
  if (!fs.existsSync(built)) { console.error(`✗ ${a.repo}: no build output at ${built} — drop --no-build`); process.exit(1); }
  const to = path.join(VENDOR, a.dir, 'agent.cjs');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const bytes = fs.readFileSync(built);
  fs.writeFileSync(to, bytes);
  stamp.files[`agent-cloud/${a.dir}/agent.cjs`] = sha256(bytes);
  // The SDK version the bundle was built against — the drift that made the vendored scout miss the
  // Command Inbox was an SDK bump the vendored copy never picked up.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    stamp.sources[a.repo].sdk = pkg.dependencies?.['@circuit-llm/agent'] || null;
    stamp.sources[a.repo].workload = a.workload;
  } catch { /* provenance is best-effort */ }
  console.log(`✓ ${a.workload}: ${(bytes.length / 1024).toFixed(0)}kb`);
}

fs.writeFileSync(path.join(ROOT, 'vendor', 'VENDOR.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`\n✓ wrote vendor/VENDOR.json — ${Object.keys(stamp.files).length} artifacts stamped`);
console.log('  next: npm test (vendor-drift), then bump + tag desktop-vX.Y.Z to ship it');
