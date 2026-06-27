# vendor/

Bundled third-party/sibling code shipped with the node-client so features work
out-of-the-box on a fresh install.

- `node-host/` — the Circuit agent-cloud node-host (source: `circuit-agent-cloud/node-host`).
  Lets a CPU box lend capacity to the agent cloud via the dashboard "Connect CPU" flow
  (see `lib/cpu-host.js`). Self-contained (Node built-ins only, zero npm deps). Re-vendor
  from `circuit-agent-cloud/node-host` when it changes.
