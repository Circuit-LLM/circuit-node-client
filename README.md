# CIRCUIT Node Client

Run a node on the CIRCUIT distributed data and inference network. Join the mesh, contribute compute, and earn CIRC.

## What is a CIRCUIT Node?

CIRCUIT is a Solana-native data network. The canonical node (`node.circuitllm.xyz`) aggregates on-chain data — token prices, wallet analytics, pool data, validator stats — and serves it through a paid API (x402 CIRC token gate).

**What running a node gives you:**

- Participation in the distributed data mesh as it grows toward Phase 2 and Phase 3
- **LLM inference earnings** — opt in to the decentralized inference network, run a transformer layer shard, and earn a share of CIRC inference fees proportional to the layers you handle
- A path to staked RPC access in Phase 3 (CIRC staking → RPC tier, coming soon)

**Network phases:**

- **Phase 1 (now)** — Your node registers on the network and acts as a local proxy to canonical for data requests. Optionally join the LLM inference worker pool.
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

Copy the example config and edit it:

```bash
cp config/client.example.json config/client.json
```

Key fields:

```json
{
  "network": {
    "registryUrl": "https://node.circuitllm.xyz",
    "bootstrapPort": 18500
  },
  "node": {
    "region": "us-east",
    "apiPort": 19000
  }
}
```

### Region codes
`us-east`, `us-west`, `eu-west`, `eu-central`, `ap-southeast`, `ap-northeast`

### LLM Worker (optional)

To join the decentralized LLM inference network and earn CIRC for compute:

```json
"llmWorker": {
  "enabled": true,
  "port": 19110,
  "coordinatorUrl": "https://inference.circuitllm.xyz",
  "walletAddress": "YourSolanaWalletForCircPayouts"
}
```

Your node will receive a transformer layer shard of Qwen2.5-0.5B and process inference pipeline steps. CIRC payments are attributed proportionally to the layers you run. The HTTP weight-delivery port is `port + 1000` (e.g. 20110) — make sure both are accessible from the coordinator.

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

The node serves a dashboard at `http://localhost:19000/` with tabs:

| Tab | Contents |
|-----|----------|
| **Overview** | Node identity, sync status, network at a glance, activity log |
| **Keys** | Node ID (public key), usage examples |
| **Network** | Live node map, shard coverage, version distribution, peer list |
| **Updates** | Current + latest version, update history, rollback controls |
| **Agent** | Agent stats (if `agentEnabled: true`) |
| **Chat** | LLM chat interface (if agent connected + API key set) |

## Node Identity

On first run, the node generates an ed25519 keypair stored in `data/identity.json`.

- Your **public key** is your `nodeId` — the permanent identity on the network
- All registry communications (announce, heartbeat, deregister) are signed with your private key
- **Never delete `data/identity.json`** — you can't recover your nodeId without it

```
data/identity.json  ← KEEP THIS. Add to backup. Never commit.
```

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

## Chat Feature

When a `circuit-agent` is paired, an LLM chat interface is available in the dashboard and via WebSocket:

```
ws://localhost:19000/chat
```

**Enable it:**

```json
"node": {
  "agentEnabled": true,
  "agentDataPath": "../circuit-agent/data"
}
```

The chat uses your agent's `llm.openrouterKey` automatically. No separate key needed in the node config.

## Updates

The node-client checks [GitHub releases](https://github.com/Circuit-LLM/circuit-node-client) every hour and applies updates automatically.

**Update flow:**
1. Poll GitHub Releases API every 60 minutes
2. Compare latest release tag to local `package.json` version
3. If newer: backup current installation, pull new code, `npm install`, restart

**Disable auto-update:**
```json
"updates": { "autoUpdate": false }
```

## Run as a Service (systemd)

```bash
cp deploy/circuit-node-client.service ~/.config/systemd/user/
# Edit WorkingDirectory and ExecStart paths
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client
loginctl enable-linger $USER
```

## Security Model

| Concern | Protection |
|---------|-----------|
| Private key exposure | `data/identity.json` gitignored, never logged |
| Malicious updates | Updates pulled from GitHub via HTTPS; signed releases |
| Node impersonation | All registry mutations are signature-verified |
| External chat access | WebSocket only accepts localhost connections |
| Phase 3 data access | AES-256-GCM, key requires CIRC token ownership |

**Files that must never be committed:**
```
data/identity.json     ← your node private key
config/client.json     ← your local config (may contain wallet address)
```

Both are in `.gitignore`.

## Directory Structure

```
circuit-node-client/
├── node-client.js          Entry point + CLI
├── worker.js               LLM inference worker (spawned by llm-worker.js)
├── config/
│   └── client.example.json Configuration template (copy to client.json)
├── lib/
│   ├── identity.js         ed25519 keypair management
│   ├── registry.js         Network registry client (announce/heartbeat)
│   ├── shard.js            Shard assignment + routing
│   ├── sync.js             Data sync (Phase 1: HTTP polling, Phase 2: gRPC)
│   ├── access.js           Local access bypass + Phase 3 encryption stub
│   ├── server.js           API server (Express + WebSocket)
│   ├── llm-worker.js       LLM inference worker process manager
│   ├── inference/          GGML dequantization + Qwen2 forward pass
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
└── data/                   Runtime data (gitignored)
    ├── identity.json       Node keypair (KEEP PRIVATE)
    ├── cache/              Sync'd data slices
    ├── backups/            Pre-update backups
    └── update-history.json Update log
```

## License

MIT
