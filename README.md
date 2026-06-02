# CIRCUIT Node Client

Run a node on the CIRCUIT distributed data network. Get a Solana RPC key, join the mesh, and power the decentralized infrastructure.

## What is a CIRCUIT Node?

CIRCUIT is a Solana-native data network. The canonical node (`node.circuitllm.xyz`) aggregates on-chain data — token prices, wallet analytics, pool data, validator stats — and serves it through a paid API (x402 CIRC token gate). All participants, including node operators, pay x402 for data API calls.

**What running a node gives you:**

- A permanent `pnk_` Solana RPC key derived from your node identity — use it to connect your dApp or agent to the CIRCUIT RPC endpoint
- Participation in the distributed data mesh as it grows toward Phase 2 and Phase 3

**Roadmap — CIRC staking model:**

Stake CIRC into your node client to earn and maintain RPC access for yourself and your agents. The more CIRC staked, the higher your RPC tier. This replaces the need to hold a standing x402 balance for RPC calls specifically — data API calls remain x402-gated for all participants.

**Network phases:**

- **Phase 1 (now)** — Your node registers on the network, gets a `pnk_` RPC key, and acts as a local proxy to canonical for data requests.
- **Phase 2** — Shard specialization. Each node owns a slice of indexed data, synchronized via gRPC from circuit-geyser. Nodes serve their assigned shards directly.
- **Phase 3** — CIRC staking for RPC access. Stake CIRC → maintain RPC credentials for you and your agents. Data is AES-256-GCM encrypted; key derivation requires CIRC ownership.

## Quick Start

```bash
# Install
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install

# Start
node node-client.js

# Dashboard
open http://localhost:19000
```

## Requirements

- Node.js ≥ 18
- Internet access (to reach the CIRCUIT network registry)
- (Optional) systemd or PM2 for persistence

## Configuration

Edit `config/client.json` before first run:

```json
{
  "network": {
    "registryUrl": "https://node.circuitllm.xyz",
    "bootstrapPort": 18500
  },
  "node": {
    "version": "0.1.0",
    "region": "us-east",
    "apiPort": 19000,
    "agentEnabled": false,
    "shards": ["all"]
  }
}
```

### Region codes
`us-east`, `us-west`, `eu-west`, `eu-central`, `ap-southeast`, `ap-northeast`

## CLI Commands

```bash
node node-client.js                    # Start the node (default)
node node-client.js setup              # Interactive setup wizard
node node-client.js status             # Check node + network status
node node-client.js update             # Check GitHub for updates and apply
node node-client.js rollback           # List available rollback targets
node node-client.js rollback <version> # Roll back to a specific version
node node-client.js deregister         # Remove from network and exit
```

## Dashboard

The node serves a dashboard at `http://localhost:19000/` with five tabs:

| Tab | Contents |
|-----|----------|
| **Overview** | Node identity, sync status, network at a glance, activity log |
| **RPC Key** | Your deterministic `pnk_…` API key, node ID, usage examples |
| **Network** | Live node map, shard coverage, version distribution, peer list |
| **Updates** | Current + latest version, update history, rollback controls |
| **Agent** | Agent stats (if `agentEnabled: true`) |
| **Chat** | LLM chat interface (if `chat.enabled: true` + API key set) |

## Node Identity

On first run, the node generates an ed25519 keypair stored in `data/identity.json`.

- Your **public key** is your `nodeId` — the permanent identity on the network
- All registry communications (announce, heartbeat, deregister) are signed with your private key
- **Never delete `data/identity.json`** — you can't recover your nodeId without it

```
data/identity.json  ← KEEP THIS. Add to backup. Never commit.
```

## RPC Key

Your RPC key is derived deterministically from your nodeId:

```
pnk_ + first 40 alphanumeric characters of your base64 nodeId
```

No storage required — it regenerates from your identity on every start. Visible in the dashboard **RPC Key** tab.

Use it to point any Solana dApp or agent at the CIRCUIT RPC endpoint:

```
https://rpc.circuitllm.xyz/?key=pnk_your_key_here
```

This is the primary benefit of running a node. The `pnk_` key is your credential for Solana JSON-RPC access — standard-compatible, drop-in replacement for any `new Connection(url)`.

## Network Architecture

### Shard Types

| Shard | Data |
|-------|------|
| `CHAIN_METRICS` | TPS, slot timing, epoch progress |
| `TOKEN_ANALYTICS` | Token prices, volume, momentum |
| `WALLET_ANALYTICS` | Wallet scores, transaction history |
| `POOL_DATA` | DEX pool stats, liquidity |
| `ORACLE_PRICES` | Price feed aggregates |
| `YIELD_DATA` | Staking yields, lending rates |
| `VALIDATOR_DATA` | Validator performance, stake distribution |
| `SWARM_DATA` | Agent signal feed |

Phase 1 nodes serve `all` shards as a proxy. Phase 2 assigns 3 of 8 shards via consistent hash of your nodeId.

### Node Authentication

Every mutating registry request is signed:

```
X-Node-Id:        base64 ed25519 public key (= nodeId)
X-Node-Signature: base64 ed25519 signature over canonical payload
X-Node-Timestamp: unix ms (must be within ±5 min)
```

### Peer Discovery

Nodes announce to the registry at `POST /api/network/nodes/announce` and send heartbeats every 60s. Nodes that miss 3 consecutive heartbeats are marked offline.

## Chat Feature

When a `circuit-agent` is paired, an LLM chat interface is available in the dashboard and via WebSocket:

```
ws://localhost:19000/chat
```

The chat speaks as your trading agent — it has full context of open positions, trade history, session strategy, and learned patterns.

**Enable it:**

1. Point the node at your agent's data directory in `config/client.json`:
```json
"node": {
  "agentEnabled": true,
  "agentDataPath": "../circuit-agent/data"
}
```

2. The chat automatically uses your agent's `llm.openrouterKey` (set in `circuit-agent/config/agent.local.json`). No separate LLM key needed in the node config.

If you want to override the key via environment:
```bash
OPENROUTER_API_KEY=your-key node node-client.js start
```

Get an OpenRouter key at [openrouter.ai](https://openrouter.ai).

## Updates

The node-client checks the [Circuit-LLM/circuit-node-client](https://github.com/Circuit-LLM/circuit-node-client) GitHub releases page every hour and applies updates automatically when a newer version is available.

**Update flow:**
1. Poll GitHub Releases API every 60 minutes
2. Compare latest release tag to local `package.json` version
3. If newer: backup current installation (preserves `data/` and `node_modules/`)
4. Pull via `git pull --ff-only` if the directory is a git clone (fastest path)
5. Fallback: download release tarball from GitHub
6. `npm install` for any new dependencies
7. `process.exit(0)` → systemd/PM2 restarts with new code

Updates and rollback history are visible in the dashboard **Updates** tab.

**Disable auto-update:**
```json
"updates": { "autoUpdate": false }
```

**Manual update or rollback:**
```bash
node node-client.js update             # Pull latest now
node node-client.js rollback <version> # Restore a previous backup
```

## Run as a Service (systemd)

```bash
# Copy unit file
cp deploy/circuit-node-client.service ~/.config/systemd/user/
# Edit WorkingDirectory and ExecStart paths in the unit file
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client
systemctl --user status circuit-node-client

# Enable linger so it starts at boot without login
loginctl enable-linger $USER
```

## Security Model

| Concern | Protection |
|---------|-----------|
| Private key exposure | `data/identity.json` chmod 600, gitignored |
| Malicious updates | Updates pulled from GitHub via HTTPS — only the repo owner can publish releases |
| Node impersonation | All registry mutations are signature-verified |
| External chat access | WebSocket only accepts localhost connections |
| Phase 3 data access | AES-256-GCM, key requires CIRC token ownership |

**Files that must never be committed:**
```
data/identity.json     ← your node private key
```

This file is in `.gitignore`.

## Publishing Updates (Maintainers)

Create a new GitHub release with a semver tag (e.g. `v0.2.0`). All running node-clients will detect it within their next hourly check and auto-apply if `autoUpdate: true`.

## Directory Structure

```
circuit-node-client/
├── node-client.js          Entry point + CLI
├── config/
│   └── client.example.json Configuration template (copy to client.json)
├── lib/
│   ├── identity.js         ed25519 keypair management
│   ├── registry.js         Network registry client (announce/heartbeat)
│   ├── shard.js            Shard assignment + routing
│   ├── sync.js             Data sync (Phase 1: HTTP polling, Phase 2: gRPC)
│   ├── access.js           Local access bypass + Phase 3 encryption stub
│   ├── server.js           Lite API server (Express + WebSocket)
│   ├── agent.js            Local monitoring loop (when agentEnabled)
│   ├── circuit-agent.js    Reader for paired circuit-agent data files
│   ├── chat.js             WebSocket chat bridge to circuit-agent
│   └── updater.js          Signed update management
├── ui/
│   └── dashboard.html      Single-page dashboard
├── deploy/
│   ├── generate-signing-key.js   One-time operator key setup
│   ├── publish-update.js         Operator update publisher
│   └── circuit-node-client.service systemd unit template
├── data/                   Runtime data (gitignored)
│   ├── identity.json       Node keypair (KEEP PRIVATE)
│   ├── cache/              Sync'd data slices
│   ├── backups/            Pre-update backups
│   └── update-history.json Update log
└── .gitignore
```

## License

MIT
