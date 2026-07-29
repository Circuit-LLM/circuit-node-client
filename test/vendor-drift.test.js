// The vendored agent-cloud is a COPY (the desktop app is a compiled binary, so the node-host and the
// sealed agents must physically ship here). A copy with no check is a copy that rots: between
// 2026-07-16 and 2026-07-24 the vendored node-host missed the Command Inbox relay and the vendored
// Signal Scout missed the agent side of it, so a scout hosted by the desktop app silently ignored every
// owner command. Nothing failed — that is the problem this test exists to make impossible.
//
// Three checks, cheapest first:
//   1. the stamp matches the files on disk (someone hand-edited a vendored file, or forgot to re-stamp)
//   2. the vendored tree has no unstamped strays (a file copied in by hand, tracked by nothing)
//   3. if a sibling source checkout is present, its content still matches what we vendored
// Check 3 is skipped where the sources aren't checked out (CI, a contributor's box) — its absence must
// never be mistaken for "verified", so it reports as skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const stamp = JSON.parse(fs.readFileSync(path.join(VENDOR, 'VENDOR.json'), 'utf8'));

test('vendor stamp matches the vendored files on disk', () => {
  const missing = [], changed = [];
  for (const [rel, want] of Object.entries(stamp.files)) {
    const p = path.join(VENDOR, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    if (sha256(fs.readFileSync(p)) !== want) changed.push(rel);
  }
  assert.deepEqual(missing, [], 'vendored file(s) missing — re-run scripts/sync-vendor.mjs');
  assert.deepEqual(changed, [], 'vendored file(s) edited in place — edit the SOURCE repo, then re-run scripts/sync-vendor.mjs');
});

test('no unstamped files in the vendored tree', () => {
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else acc.push(path.relative(VENDOR, p));
    }
    return acc;
  };
  const dir = path.join(VENDOR, 'agent-cloud');
  if (!fs.existsSync(dir)) return; // nothing vendored yet
  const strays = walk(dir).filter((f) => !stamp.files[f]);
  assert.deepEqual(strays, [], 'file(s) in vendor/ that no sync put there — add them to sync-vendor.mjs or delete them');
});

test('vendored copy still matches its source checkout', (t) => {
  const cloud = process.env.CIRCUIT_AGENT_CLOUD_DIR || path.join(os.homedir(), 'circuit-agent-cloud');
  if (!fs.existsSync(cloud)) return t.skip('no sibling circuit-agent-cloud checkout — source comparison skipped, NOT verified');

  const behind = [];
  for (const rel of Object.keys(stamp.files)) {
    if (!rel.startsWith('agent-cloud/lib/') && !rel.startsWith('agent-cloud/node-host/') && !rel.startsWith('agent-cloud/agentd/')) continue;
    const src = path.join(cloud, rel.replace(/^agent-cloud\//, ''));
    if (!fs.existsSync(src)) { behind.push(rel + ' (gone from source)'); continue; }
    if (sha256(fs.readFileSync(src)) !== stamp.files[rel]) behind.push(rel);
  }
  assert.deepEqual(behind, [], `vendored copy is behind circuit-agent-cloud — run: node scripts/sync-vendor.mjs`);

  // The sealed agents are BUILT artifacts, so their bytes can't be compared to a source file. Compare
  // provenance instead: the commit we vendored from should still be the source's HEAD.
  const head = (() => { try { return execFileSync('git', ['-C', cloud, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
  if (head) assert.equal(stamp.sources['circuit-agent-cloud'].commit, head, 'circuit-agent-cloud HEAD moved since the last vendor sync — run: node scripts/sync-vendor.mjs');
});

test('every workload the vendored host advertises has a self-exec role here', () => {
  // In the compiled desktop binary there is no system node, so the host re-execs THIS binary in the
  // workload role. Advertising a workload whose role is missing would place agents we then fail to
  // start — so the two lists have to agree.
  const host = fs.readFileSync(path.join(VENDOR, 'agent-cloud', 'node-host', 'host.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'node-client.js'), 'utf8');
  const block = host.slice(host.indexOf('const WORKLOADS = {'), host.indexOf('const SUPPORTED_WORKLOADS'));
  const workloads = [...block.matchAll(/^\s{2}'([a-z-]+)':\s*\{/gm)].map((m) => m[1]);
  assert.ok(workloads.length >= 4, `expected the vendored host to know the sealed types, got ${JSON.stringify(workloads)}`);
  // Only types with a self-exec `role` are advertised by a compiled binary (a type marked
  // selfExec:false — e.g. circuit-agent, which ships no trading runtime here — is deliberately not).
  const roles = [...block.matchAll(/role:\s*\[([^\]]+)\]/g)].map((m) => m[1].split(',')[0].trim().replace(/'/g, ''));
  assert.ok(roles.includes('signal-scout') && roles.includes('nft-scout'), `sealed scout roles missing: ${JSON.stringify(roles)}`);
  const missing = roles.filter((r) => !new RegExp(`command === '${r}'`).test(cli));
  assert.deepEqual(missing, [], 'node-client.js has no role handler for workload(s) the vendored host advertises');
});
