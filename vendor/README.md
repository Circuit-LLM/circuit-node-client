# vendor/

Sibling code **copied** into this repo so the node-client works on a fresh install. The copy is not a
convenience — the desktop app is a bun-compiled single binary, so it cannot import the agent-cloud at
runtime. The node-host and the sealed agents have to physically be here.

This subtree is ESM (`package.json` → `"type":"module"`). The sealed agents are `.cjs`, which runs as
CommonJS regardless of that setting — deliberate, because an ESM build breaks `@solana/web3.js`'s
`require('buffer')` under esbuild's require shim.

## What's here

- `agent-cloud/node-host/` + `agent-cloud/lib/` + `agent-cloud/agentd/` — the node-host, exactly the
  modules it imports, and the two things it *spawns* (agentd, the egress sidecar). Source:
  `circuit-agent-cloud`. Powers the dashboard "Connect CPU" flow (`lib/cpu-host.js`).
  Control-plane-only libs are **not** vendored: they were once, they went stale, and nothing here could
  ever have loaded them.
- `agent-cloud/signal-agent/agent.cjs`, `agent-cloud/nft-agent/agent.cjs` — the sealed non-trading agent
  types, each built by its own repo's `build.mjs` into one self-contained file (deps bundled in, so no
  `node_modules` is needed on an operator's box).

## Never hand-edit anything under `agent-cloud/`

Edit the **source** repo, then re-sync:

```
node scripts/sync-vendor.mjs          # sibling checkouts in ~, rebuilds the scout bundles
node scripts/sync-vendor.mjs --no-build --agent-cloud /path/to/circuit-agent-cloud
```

The sync writes `VENDOR.json`: the source commit per repo (flagged if dirty), the SDK version each
sealed agent was built against, and a sha256 per artifact. `npm test` then fails if the stamp and the
files disagree, if a stray file appears here, if a sibling checkout has moved past what we vendored, or
if the host advertises a workload `node-client.js` has no role handler for.

## Why the check exists

Between 2026-07-16 and 2026-07-24 this copy silently fell a release behind. The vendored node-host
missed the Command Inbox relay and the vendored Signal Scout missed the agent side of it, so a scout
hosted by the desktop app quietly ignored every owner command. Nothing errored — it just didn't work.
The stamp plus the test turns that class of rot into a failing build.

## Shipping a change

A repo pull does **not** update anyone's desktop app; it's a built GitHub release. After syncing, bump
`desktop/package.json` + `src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}`, commit, and push a
`desktop-vX.Y.Z` tag — CI matrix-builds mac/win/linux and publishes the installers.
