// This box lends spare capacity to OTHER owners' agents (see lib/cpu-host.js). That makes the
// node-runtime bundle path a real exposure, and the guard against it is one env var set at spawn — so
// it gets a test.
//
// The exposure: advertising SANDBOX=node only turns away 'oci' bundles. The scheduler gates a bundle on
// sandbox RANK alone, a 'node'-runtime bundle needs rank 'node', and the publisher chooses `runtime` in
// their own manifest. The workload types we advertise don't gate bundles at all. So a third-party
// publisher declaring runtime:'node' satisfies this host and would run as an unsandboxed SAME-UID
// process — able to read data/identity.json (mode 600, our uid) and sign as this node, which is the
// credential the inference gateway serves free.
//
// CIRCUIT_FIRST_PARTY_KEYS would also stop it, but it is allow-all when unset and nothing here pins it,
// so the fail-closed switch is what actually holds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CPU_HOST = path.join(__dirname, '..', 'lib', 'cpu-host.js');
const PROTO = path.join(__dirname, '..', 'vendor', 'agent-cloud', 'lib', 'proto.js');
const HOST = path.join(__dirname, '..', 'vendor', 'agent-cloud', 'node-host', 'host.js');

test('cpu-host refuses node-runtime bundles by default', () => {
  const src = fs.readFileSync(CPU_HOST, 'utf8');
  assert.match(src, /CIRCUIT_ALLOW_NODE_BUNDLES\s*=\s*'0'/,
    'lib/cpu-host.js must set CIRCUIT_ALLOW_NODE_BUNDLES=0 — without it a stranger\'s node-runtime bundle runs same-uid');
  assert.match(src, /env\.SANDBOX\s*=\s*'node'/, 'sandbox tier unchanged');
});

test('the vendored host honours the switch', () => {
  const host = fs.readFileSync(HOST, 'utf8');
  assert.match(host, /allowNodeBundles:\s*process\.env\.CIRCUIT_ALLOW_NODE_BUNDLES\s*!==\s*'0'/,
    'vendored host must read the switch');
  assert.match(host, /allowsNodeRuntimeBundle\(/, 'vendored host must consult the admission policy');

  const proto = fs.readFileSync(PROTO, 'utf8');
  assert.match(proto, /export function allowsNodeRuntimeBundle/, 'vendored proto must export the policy');
});

test('the policy fails closed for any publisher when the switch is off', async () => {
  // Import the VENDORED policy — the copy that actually ships in the binary.
  const { allowsNodeRuntimeBundle, isFirstPartyNodeRuntime } = await import(PROTO);

  for (const publisher of ['STRANGER', 'FIRST_PARTY', undefined]) {
    const v = allowsNodeRuntimeBundle({ allowNodeBundles: false, publisher, firstPartyKeys: [] });
    assert.strictEqual(v.ok, false, `must refuse a node-runtime bundle from ${publisher}`);
  }
  // And the refusal must not lean on pinning, which is allow-all here.
  assert.strictEqual(isFirstPartyNodeRuntime('STRANGER', []), true, 'unpinned = allow-all (why the switch is needed)');
});

test('hosting other owners\' built-in scouts still works', async () => {
  // The product is hosting other people's scouts. Those run OUR vendored code (the WORKLOADS table),
  // not publisher code, so they must remain placeable — the guard is only for publisher-supplied
  // node-runtime bundles.
  const { nodeSatisfies } = await import(PROTO);
  const thisNode = { caps: { sandbox: 'node', workloads: ['agentd', 'signal-scout', 'nft-scout'] } };
  assert.strictEqual(nodeSatisfies(thisNode, { spec: { workload: 'signal-scout' } }), true);
  assert.strictEqual(nodeSatisfies(thisNode, { spec: { workload: 'nft-scout' } }), true);
});
