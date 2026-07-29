// First-party agent TYPES (sealed workloads) — the shared vocabulary for what a Circuit agent IS.
//
// A sealed agent runs as a first-party WORKLOAD (`spec.workload`): trusted code the operator already
// has, launched by the node-host with a curated secret env (node-host/env.js). That is NOT a BUNDLE
// (`spec.bundle`) — user-authored, untrusted, content-addressed + owner-signed, sandboxed, and given
// zero secrets. Sealed ≠ bundled: the two paths have opposite trust models (docs/AGENT_BUNDLES.md).
//
// This module is the CONTROL PLANE's vocabulary — which type ids exist and what they are. It is
// deliberately NOT a path table: every host resolves an entry point differently (a source checkout, a
// vendored single file, a re-exec of its own compiled binary), so each host owns its own resolver map
// and ADVERTISES what it can actually launch as `caps.workloads`. The CP validates against this
// vocabulary, the node advertises the truth, and placement is the intersection of the two.
//
// Zero dependencies (like proto.js) — used by the control plane, node-host and tests.

export const DEFAULT_WORKLOAD = 'agentd';

export const WORKLOADS = {
  'agentd':        { kind: 'trader',  summary: 'reference paper-trading workload (the default)' },
  'circuit-agent': { kind: 'trader',  summary: 'production trading agent' },
  'signal-scout':  { kind: 'service', summary: 'non-trading research/signal service' },
  'nft-scout':     { kind: 'service', summary: 'non-trading NFT floor/bid opportunity service' },
};

// `kind` is descriptive today. It is the seam where per-type CUSTODY belongs — a 'service' type is
// keyless by design and has no business being provisioned a signer wallet + buy/sell policy the way a
// 'trader' is. Changing that alters provisioning for agents that already exist, so it is deliberately
// NOT bundled into this change.

export const KNOWN_WORKLOADS = Object.keys(WORKLOADS);

export const workloadOf = (spec) => spec?.workload || DEFAULT_WORKLOAD;

export const isKnownWorkload = (w) => Object.prototype.hasOwnProperty.call(WORKLOADS, w);

// Nodes that predate `caps.workloads` (node-host ≤ 2026-07-24, desktop node-client ≤ v0.1.8) advertise
// no workload list at all. They are assumed to run exactly the set that shipped in that generation, so
// existing nodes keep placing the types they genuinely can run — while a NEWER type stays honestly
// pending until some node says it can launch it, instead of silently falling through to the default
// workload on an old host (which is how a scout could start life as a paper trader).
export const LEGACY_WORKLOADS = ['agentd', 'circuit-agent', 'signal-scout'];

export function nodeWorkloads(node) {
  const w = node?.caps?.workloads;
  return Array.isArray(w) && w.length ? w : LEGACY_WORKLOADS;
}

export function nodeRunsWorkload(node, workload) {
  return nodeWorkloads(node).includes(workload);
}
