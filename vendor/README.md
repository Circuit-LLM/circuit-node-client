# vendor/

Bundled sibling code shipped with the node-client so features work out-of-the-box on a
fresh install. This subtree is ESM (`package.json` → `"type":"module"`).

- `node-host/` + `lib/` — the Circuit agent-cloud node-host and the lib modules it imports
  (source: `circuit-agent-cloud/{node-host,lib}`). Powers the dashboard "Connect CPU" flow
  (see `lib/cpu-host.js`, which spawns `vendor/node-host/host.js`). Self-contained: Node
  built-ins only, zero npm deps. `host.js` imports `../lib/*.js`, so BOTH dirs must stay
  together. Re-vendor BOTH from `circuit-agent-cloud` when they change.
