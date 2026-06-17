# CIRCUIT Node Client

> Run a node on the CIRCUIT distributed network. Serve data, power decentralized LLM inference, earn CIRC.

[![Version](https://img.shields.io/badge/version-v0.1.0-ffe000?style=flat-square&labelColor=0a0900&color=c9a800)](https://github.com/Circuit-LLM/circuit-node-client/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-ffe000?style=flat-square&labelColor=0a0900)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=flat-square&labelColor=0a0900)](https://nodejs.org)
[![Network](https://img.shields.io/badge/network-CIRCUIT-c9a800?style=flat-square&labelColor=0a0900)](https://circuitllm.xyz)

---

## What Is a CIRCUIT Node?

CIRCUIT is a Solana-native distributed network with two layers:

- **Data mesh** — aggregates on-chain data (token prices, wallet analytics, DEX pools, validator stats) and serves it through a paid API gated by x402 CIRC micropayments
- **Decentralized LLM inference** — a pipeline of worker nodes that each hold a shard of a transformer model, cooperating to run inference across the network

Running a node gives you access to both layers — and lets you contribute to both.

### What You Get

| Benefit | Details |
|---------|---------|
| **Inference earnings** | Hold transformer layer shards, earn a share of CIRC inference fees proportional to layers you run |
| **Free inference chat** | Chat with the CIRCUIT decentralized LLM for free from your node's dashboard |
| **Data mesh participation** | Phase 1: proxy canonical data. Phase 2: own and serve a dedicated data shard |
| **Staked RPC access** | Phase 3: stake CIRC to unlock RPC tier access for you and your agents |

### Network Phases

| Phase | Status | What Changes |
|-------|--------|--------------|
| **Phase 1** | **Now** | Node registers, proxies data from canonical hub, joins LLM inference pipeline |
| **Phase 2** | Upcoming | Shard specialization — each node owns a slice of indexed Solana data, served directly |
| **Phase 3** | Planned | CIRC staking gates RPC tiers — higher stake = higher rate limits and routing priority |

---

## Quick Start

```bash
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install
node node-client.js
```

Open the dashboard at **`http://localhost:19000`**

---

## Requirements

- **Node.js ≥ 18** — check with `node --version`
- Internet access to reach `node.circuitllm.xyz`
- ~80MB RAM if joining the LLM inference worker pool (optional)

---

## Configuration

Copy the example config and edit it before first run:

```bash
cp config/client.example.json config/client.json
```

Minimum config to get started:

```json
{
  "network": {
    "registryUrl": "https://node.circuitllm.xyz"
  },
  "node": {
    "region":  "us-east",
    "apiPort": 19000
  }
}
```

**Region codes:** `us-east` · `us-west` · `eu-west` · `eu-central` · `ap-southeast` · `ap-northeast`

If you skip this step, the node auto-creates `client.json` from the example on first launch.

---

## Dashboard

The node serves a terminal-style dashboard at `http://localhost:19000`. It has seven tabs:

| Tab | Contents |
|-----|----------|
| **Overview** | Node identity, sync status, network at a glance, live activity log |
| **Keys** | Node ID (ed25519 public key), CIRC staking status and wallet connect |
| **Network** | Live node map, shard coverage, version distribution, peer list |
| **Updates** | Current vs latest version, update history, one-click rollback |
| **Inference** | Free LLM chat via the CIRCUIT decentralized inference network |
| **Agent** | Trading agent stats (if a `circuit-agent` is paired) |
| **Chat** | Conversation interface with a paired circuit-agent |

---

## Decentralized LLM Inference

### Inference Chat (Free for Node Operators)

The **Inference tab** in the dashboard gives you a streaming chat interface connected to the CIRCUIT decentralized LLM at `inference.circuitllm.xyz`. The model is **Qwen2.5-0.5B-Instruct**, running distributed across the node worker mesh.

Requests are proxied through your node's local API at `POST /inference/chat`. When the inference coordinator is running on the same machine as your node client, requests hit `localhost:19200` and bypass the x402 payment gate — **inference is completely free**.

Responses stream token-by-token as the distributed pipeline processes them. The chat maintains conversation context across turns (up to 12 messages) and includes a clear button to reset the session.

### Joining the Worker Pool (Earn CIRC)

Your node can hold a transformer layer shard and process inference pipeline steps, earning a proportional share of CIRC inference fees.

Enable it in `config/client.json`:

```json
"llmWorker": {
  "enabled":        true,
  "port":           19110,
  "coordinatorUrl": "https://inference.circuitllm.xyz",
  "walletAddress":  "YourSolanaWalletForCircPayouts"
}
```

| Field | Description |
|-------|-------------|
| `port` | TCP port the coordinator connects to for tensor pipeline traffic |
| `coordinatorUrl` | The inference coordinator URL — do not change |
| `walletAddress` | Your Solana wallet address for CIRC earnings attribution |

> The weight-delivery HTTP port is always `port + 1000` (e.g. 19110 → weight delivery on 20110). Both ports must be reachable from the coordinator.

**Resource usage:** ~80MB RAM · ~40MB model weight download · CPU bursts ~1–2s during inference steps

**What happens at startup:**
1. Worker process starts on the configured port
2. Registers with the coordinator and receives its layer assignment (e.g. layers 4–7 of 24)
3. Coordinator streams the model weight shard for those layers (~40MB)
4. Node joins the live inference pipeline

---

## CLI Commands

```bash
node node-client.js                    # Start the node (default)
node node-client.js setup              # Show identity and current config
node node-client.js status             # Check node + network status
node node-client.js update             # Check GitHub for updates and apply
node node-client.js rollback           # List available rollback targets
node node-client.js rollback <version> # Roll back to a specific version
node node-client.js deregister         # Remove from network and exit cleanly
```

---

## Node Identity

On first run the node generates a permanent ed25519 keypair stored in `data/identity.json`.

- Your **public key** is your `nodeId` — your permanent identity on the CIRCUIT network
- All registry communications (announce, heartbeat, deregister) are signed with the private key
- **Back up `data/identity.json`** — you cannot recover your nodeId without it

```
data/identity.json  ←  YOUR NODE IDENTITY. BACK THIS UP. NEVER COMMIT.
```

---

## Updates

The node checks [GitHub releases](https://github.com/Circuit-LLM/circuit-node-client/releases) every hour and applies updates automatically. Before applying, the node:

1. Downloads the release archive
2. Verifies SHA-256 checksum
3. Verifies ed25519 operator signature (if `signingPublicKey` is set)
4. Backs up your current installation
5. Applies the update and restarts

To disable auto-update:

```json
"updates": { "autoUpdate": false }
```

Rollbacks are always available via the Updates tab or `node node-client.js rollback`.

---

## Run as a Service (systemd)

For a server or always-on machine, run the node as a systemd user service:

```bash
cp deploy/circuit-node-client.service ~/.config/systemd/user/
# Edit WorkingDirectory and ExecStart to match your install path
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client
loginctl enable-linger $USER   # start at boot without login
```

Check status and logs:

```bash
systemctl --user status circuit-node-client
journalctl --user -u circuit-node-client -f
```

---

## Network Architecture

### Shard Types (Phase 2)

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

Phase 1 nodes serve `all` shards via proxy. Phase 2 will assign 3 of 8 shards per node via consistent hash of the nodeId — you can see your Phase 2 assignment now in the Network tab.

### Node Authentication

Every mutating registry request is signed:

```
X-Node-Id:        base64 ed25519 public key (= nodeId)
X-Node-Signature: base64 ed25519 signature over canonical payload
X-Node-Timestamp: unix ms (must be within ±5 min of server time)
```

---

## Security

| Concern | Protection |
|---------|------------|
| Private key exposure | `data/identity.json` gitignored, never logged |
| Malicious updates | HTTPS download + SHA-256 checksum + optional ed25519 signature |
| Node impersonation | All registry mutations are signature-verified server-side |
| Inference access | x402 CIRC payment gate on external endpoint; localhost bypass for co-located nodes |
| External chat access | WebSocket chat accepts localhost connections only |
| Phase 3 data access | AES-256-GCM, key derivation requires CIRC token ownership |

**Files that must never be committed:**

```
data/identity.json   ← your node private key
config/client.json   ← your local config (may contain your wallet address)
```

Both are in `.gitignore` by default.

---

## Directory Structure

```
circuit-node-client/
├── node-client.js          Entry point + CLI
├── worker.js               LLM inference worker (spawned when llmWorker.enabled = true)
├── config/
│   └── client.example.json Configuration template — copy to client.json before editing
├── lib/
│   ├── identity.js         ed25519 keypair generation and signing
│   ├── registry.js         Network registry client (announce, heartbeat, deregister)
│   ├── server.js           Express API server + inference chat SSE proxy
│   ├── llm-worker.js       LLM inference worker child-process manager
│   ├── inference/          GGML dequantization + Qwen2 transformer forward pass
│   ├── shard.js            Shard assignment and request routing
│   ├── sync.js             Data sync (Phase 1: HTTP poll, Phase 2: gRPC)
│   ├── access.js           CIRC balance/stake verification + Phase 3 encryption stub
│   ├── stakepoint.js       On-chain StakePoint position query module
│   ├── agent.js            circuit-agent monitoring loop
│   ├── circuit-agent.js    Paired circuit-agent data file reader
│   ├── chat.js             WebSocket chat bridge (agent-paired chat)
│   └── updater.js          Signed update download, verify, and apply
├── ui/
│   └── dashboard.html      Single-page dashboard (7 tabs, terminal aesthetic)
├── deploy/
│   ├── generate-signing-key.js   Operator: generate ed25519 signing key
│   ├── publish-update.js         Operator: sign and publish a release
│   └── circuit-node-client.service  systemd unit template
└── data/                   Runtime state (gitignored — back this up)
    ├── identity.json        ← YOUR NODE IDENTITY. BACK THIS UP.
    ├── cache/               Sync'd data cache slices
    └── backups/             Pre-update snapshots (used for rollback)
```

---

## License

MIT
