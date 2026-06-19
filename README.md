<div align="center">

# circuit-node-client

**Run a node on the CIRCUIT distributed network. Serve data, power decentralized LLM inference, and earn CIRC — with a one-command setup and a built-in dashboard.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/Circuit-LLM/circuit-node-client/releases)
[![Network](https://img.shields.io/badge/network-CIRCUIT-gold)](https://circuitllm.xyz)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

[Website](https://circuitllm.xyz) · [Data API](https://api.circuitllm.xyz) · [Telegram](https://t.me/circuitllm) · [X / Twitter](https://x.com/CircuitLLM)

</div>

---

**[What it does](#what-it-does)** · **[Quick Start](#quick-start)** · **[Dashboard](#dashboard)** · **[Inference](#decentralized-llm-inference)** · **[CLI](#cli-commands)** · **[Config](#configuration)** · **[CIRC Staking](#circ-staking)** · **[Security](#security)**

---

## What it does

- **Joins the CIRCUIT data mesh** — syncs on-chain data from the canonical hub and serves it locally. In Phase 2, each node owns a dedicated shard of indexed Solana data.
- **Runs decentralized LLM inference** — holds a shard of a transformer model (Qwen2.5-0.5B) and processes pipeline steps. Earn a proportional share of CIRC inference fees for every request your node handles.
- **Free inference chat** — the dashboard's Inference tab gives you a streaming LLM chat interface, connected to the CIRCUIT decentralized network. Free for node operators running a co-located coordinator.
- **Stays current automatically** — checks GitHub releases every hour, verifies checksum + ed25519 operator signature before applying, and keeps a rollback archive so you can revert to any previous version.
- **Tracks CIRC staking** — connects your Phantom or Solflare wallet to verify your on-chain stake. Phase 3 will use stake to gate RPC access tiers.

---

## Quick Start

```bash
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install
node node-client.js
```

Open the dashboard at **`http://localhost:19000`**

On first run the node generates a permanent ed25519 keypair, announces itself to the CIRCUIT registry, and starts sending heartbeats every 60 seconds.

> **Back up `data/identity.json`** — it's your node's permanent identity on the network. Deleting it means re-registering as a new node.

---

## Requirements

- **Node.js ≥ 18** — check with `node --version`
- Internet access to reach `node.circuitllm.xyz`
- ~80MB RAM if joining the LLM inference worker pool (optional)

---

## Dashboard

Open **`http://localhost:19000`** while the node is running for full visibility from your browser.

| Tab | What you get |
|-----|-------------|
| **Overview** | Node identity, sync status, hub reachability, live activity log, uptime |
| **Keys** | Node ID (ed25519 public key), CIRC staking status and wallet connect |
| **Network** | Live node map, shard coverage, version distribution, peer list |
| **Updates** | Current vs latest version, update history, one-click rollback controls |
| **Inference** | Free streaming LLM chat via the CIRCUIT decentralized inference network |
| **Agent** | Trading stats and positions (if a `circuit-agent` is paired) |
| **Chat** | Conversation interface with a paired `circuit-agent` |

---

## Decentralized LLM Inference

### Free Chat for Node Operators

The **Inference tab** streams responses from the CIRCUIT decentralized LLM — model **Qwen2.5-0.5B-Instruct**, running distributed across the worker mesh.

Requests proxy through your node's local API at `POST /inference/chat`. When the inference coordinator is on the same machine as your node (the default for co-located setups), requests hit `localhost:19200` and bypass the x402 payment gate — **inference is completely free**.

- Streams token-by-token as the distributed pipeline processes them
- Maintains conversation context across turns (up to 12 messages)
- **CLEAR** button to reset the session

### Joining the Worker Pool (Earn CIRC)

Enable the inference worker in `config/client.json` to hold a transformer layer shard and earn a share of CIRC inference fees proportional to the layers you run:

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

> The weight-delivery HTTP port is always `port + 1000` (e.g. 19110 → weight delivery on 20110). Both ports must be reachable inbound from the coordinator.

**Resource usage:** ~80MB RAM · ~40MB model weight download on startup · CPU bursts ~1–2s per inference step

→ [Full setup and firewall guide](GUIDE.md#llm-inference-worker)

---

## Configuration

Copy the example config before first run:

```bash
cp config/client.example.json config/client.json
```

Minimum setup to get started:

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

→ [Full configuration reference](GUIDE.md#configuration)

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

## CIRC Staking

In the **Keys tab**, click **Connect Wallet** to link your Phantom or Solflare wallet. The panel queries your on-chain stake position in the CIRCUIT StakePoint pool and shows:

- Status badge — `● UNLOCKED` (stake met) or `○ STAKE REQUIRED`
- Total staked CIRC across all positions
- Progress bar toward the minimum threshold
- Lock status and expiry (if any)

Phase 3 will use CIRC stake to gate RPC tiers — higher stake = higher rate limits and routing priority. Staking is pre-staged and ready; the gate isn't active yet.

> **CIRC token CA:** `8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump`  
> **Buy on Pump.fun:** [pump.fun/coin/8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump](https://pump.fun/coin/8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump)

→ [Full staking guide](GUIDE.md#circ-staking)

---

## Network Phases

| Phase | Status | What Changes |
|-------|--------|--------------|
| **Phase 1** | **Now** | Node registers, proxies data from canonical hub, joins LLM inference pipeline |
| **Phase 2** | Upcoming | Shard specialization — each node owns a slice of indexed Solana data, served directly |
| **Phase 3** | Planned | CIRC staking gates RPC tiers — higher stake = higher rate limits and routing priority |

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

```bash
systemctl --user status circuit-node-client
journalctl --user -u circuit-node-client -f
```

---

## Updates

The node checks [GitHub releases](https://github.com/Circuit-LLM/circuit-node-client/releases) every hour and applies updates automatically. Before applying, it verifies SHA-256 checksum and ed25519 operator signature, backs up your installation, then restarts. Rollbacks are always available via the Updates tab or:

```bash
node node-client.js rollback
```

To disable auto-update:

```json
"updates": { "autoUpdate": false }
```

---

## Security

| Concern | Protection |
|---------|------------|
| Private key exposure | `data/identity.json` gitignored, never logged |
| Malicious updates | HTTPS + SHA-256 checksum + ed25519 operator signature before install |
| Node impersonation | All registry mutations are signature-verified server-side |
| Inference access | x402 CIRC payment gate on external endpoint; localhost bypass for co-located nodes |
| External chat access | WebSocket chat accepts localhost connections only |
| Cluster auth | Worker sends HMAC-SHA256 of `nodeId:timestamp` using `llmWorker.clusterKey` — must match coordinator's `CLUSTER_KEY` env var. Leave empty for localhost-only setups |
| KV cache isolation | KV state resets at position 0 of each new sequence — no bleed between sessions |
| Corrupt shards | Dequantization bounds-checked on load — truncated shards throw before inference |
| Duplicate connections | Worker skips reconnect if already connected or connecting |
| Phase 3 data access | AES-256-GCM, key derivation requires CIRC token ownership |

**Files that must never be committed:**

```
data/identity.json   ← your node private key
config/client.json   ← your local config
```

Both are in `.gitignore` by default.

---

## Docs

- [**Setup & User Guide**](GUIDE.md) — full dashboard walkthrough, LLM inference worker setup, staking, systemd, troubleshooting
- [OPS Terminal](https://circuitllm.xyz/data) — live source health, endpoint status, network stats

---

## Community

- **X / Twitter:** [@CircuitLLM](https://x.com/CircuitLLM)
- **Telegram:** [t.me/circuitllm](https://t.me/circuitllm)
- **Website:** [circuitllm.xyz](https://circuitllm.xyz)
