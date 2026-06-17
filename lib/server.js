// lib/server.js — Lite API server for user nodes.
//
// Serves a local proxy API and the node dashboard.
// Phase 1: proxies all data API requests to the canonical node.
//          x402 applies at the canonical node for all callers including local agents.
//          /health is always served locally at no cost.
// Phase 2: serves data from local shard cache (populated by sync.js).
//          Mesh requests for shards this node doesn't own are proxied to a peer.
// Phase 3: non-local responses are encrypted before delivery (access.js).
//          CIRC staking determines RPC access tier.
//
// Port: config.node.apiPort (default 19000)
'use strict';

const http    = require('http');
const path    = require('path');
const express = require('express');
const chat       = require('./chat');
const circuitAgent = require('./circuit-agent');
const llmWorker  = require('./llm-worker');
const updater                       = require('./updater');
const { isLocalAccess }             = require('./access');
const { canServe, findServingPeer } = require('./shard');
const { readCache }                 = require('./sync');
const identity                      = require('./identity');

function _agentStatus(config) {
  const dataPath = config.node?.agentDataPath;
  if (!dataPath) return null;
  return circuitAgent.getStatus(path.resolve(dataPath));
}

const DASHBOARD_HTML = path.join(__dirname, '..', 'ui', 'dashboard.html');

let _server = null;
let _config = null;
let _peers  = [];

// ── Start ─────────────────────────────────────────────────────────────────────

function start(config, getPeers = async () => []) {
  _config = config;
  require('./access').configure(_config);
  const port  = config.node?.apiPort ?? 19000;
  const app   = express();

  app.use(express.json({ limit: '1mb' }));

  // ── Dashboard UI ─────────────────────────────────────────────────────────────
  // Served at / — accessible from any browser on the local machine
  app.get('/', (req, res) => res.sendFile(DASHBOARD_HTML));

  // Health check — always served locally, no x402
  app.get('/health', (req, res) => {
    const { getSyncStatus } = require('./sync');
    const agentSt  = _agentStatus(config);
    const workerSt = config.llmWorker?.enabled ? llmWorker.status() : null;
    res.json({
      status:       'ok',
      nodeId:       identity.nodeId.slice(0, 16) + '…',
      version:      config.node?.version ?? '0.1.0',
      sync:         getSyncStatus(),
      uptime:       process.uptime(),
      agentRunning: agentSt ? agentSt.alive : (config.node?.agentEnabled ?? false),
      llmWorker:    workerSt,
    });
  });

  // Node identity info (full — used by dashboard)
  app.get('/node', (req, res) => {
    const agentSt  = _agentStatus(config);
    const workerSt = config.llmWorker?.enabled ? llmWorker.status() : null;
    res.json({
      nodeId:       identity.nodeId,
      version:      config.node?.version,
      shards:       config.node?.shards ?? ['all'],
      region:       config.node?.region ?? 'unknown',
      apiPort:      config.node?.apiPort ?? 19000,
      agentRunning: agentSt ? agentSt.alive : (config.node?.agentEnabled ?? false),
      llmWorker:    workerSt,
    });
  });

  // LLM worker status — direct endpoint for monitoring
  app.get('/llm/status', (req, res) => {
    if (!config.llmWorker?.enabled) {
      return res.json({ enabled: false, reason: 'llmWorker.enabled not set in config' });
    }
    res.json({ enabled: true, ...llmWorker.status() });
  });

  // Agent status — reads co-located circuit-agent data files (if agentDataPath configured)
  app.get('/agent/status', (req, res) => {
    const status = _agentStatus(config);
    if (!status) return res.json({ connected: false, reason: 'agentDataPath not configured' });
    res.json({ connected: true, ...status });
  });

  // Stake verification — checks a wallet's CIRC stake in the configured StakePoint pool.
  // wallet param is optional: omit to fetch pool config only (used by dashboard on load).
  app.get('/stake/check', async (req, res) => {
    const wallet      = req.query.wallet ?? null;
    const poolAddress = config.access?.stakingPool ?? null;
    const minAmount   = config.access?.minStakeCirc  ?? 100_000;
    const decimals    = config.access?.circDecimals  ?? 6;
    const poolId      = config.access?.stakingPoolId ?? poolAddress;
    const poolUrl     = poolAddress ? `https://stakepoint.app/pool/${poolId}` : 'https://stakepoint.app';

    if (!poolAddress) {
      return res.json({ configured: false, wallet, poolUrl, minRequired: minAmount,
        message: 'Staking gate not configured. Set access.stakingPool in config/client.json.' });
    }

    if (!wallet) {
      return res.json({ configured: true, poolAddress, poolUrl, minRequired: minAmount });
    }

    if (typeof wallet !== 'string' || wallet.length < 32) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const { verifyCircStake } = require('./access');
    const result = await verifyCircStake(wallet, poolAddress, minAmount, decimals);
    return res.json({ configured: true, wallet, poolAddress, poolUrl, minRequired: minAmount, ...result });
  });

  // ── Update management ─────────────────────────────────────────────────────
  // Update management — localhost only.
  // These endpoints trigger node restarts and expose operator config — never allow remote access.
  // The dashboard is served at localhost so this gate is transparent to normal use.
  app.get('/update/status', async (req, res) => {
    if (!isLocalAccess(req.ip || req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Admin endpoint — localhost only' });
    }
    try {
      const status = await updater.getUpdateStatus(_config);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /update/apply — trigger update in background; node restarts when done.
  // Returns 202 immediately; caller should watch for the node to come back online.
  app.post('/update/apply', async (req, res) => {
    if (!isLocalAccess(req.ip || req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Admin endpoint — localhost only' });
    }
    res.status(202).json({ triggered: true, message: 'Update applying — node will restart shortly' });
    setImmediate(async () => {
      try {
        const status = await updater.getUpdateStatus(_config);
        if (!status.updateAvailable || !status.latest) {
          console.log('[server] Manual update: already up to date');
          return;
        }
        await updater.applyUpdate(_config, status.latest, status.tarballUrl);
      } catch (err) {
        console.error('[server] Manual update failed:', err.message);
      }
    });
  });

  // POST /update/rollback — restore a previous backup version.
  app.post('/update/rollback', (req, res) => {
    if (!isLocalAccess(req.ip || req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Admin endpoint — localhost only' });
    }
    const { version } = req.body ?? {};
    if (!version || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format' });
    }
    const ok = updater.rollback(version);
    if (!ok) return res.status(404).json({ error: `No backup found for v${version}` });
    res.json({ triggered: true, version });
  });

  // Canonical hub status — fetched server-side to avoid CORS issues
  app.get('/network/hub', async (req, res) => {
    const url = `${config.network.registryUrl}/health`;
    try {
      const r    = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const data = await r.json();
      res.json({ reachable: true, url: config.network.registryUrl, ...data });
    } catch (err) {
      res.json({ reachable: false, url: config.network.registryUrl, error: err.message });
    }
  });

  // All API traffic — x402 data API, no staking bypass.
  // Agents pay CIRC per call regardless of stake status.
  // Staking unlocks the RPC pipe (/rpc below), not the data API.
  app.use('/api', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress;
    const isLocal  = isLocalAccess(clientIp);
    const myShards = config.node?.shards ?? ['all'];
    const fullPath = req.path;

    // Shard routing (Phase 2)
    if (!canServe(myShards, '/api' + fullPath)) {
      const peer = findServingPeer(myShards, '/api' + fullPath, _peers);
      if (peer?.apiPort) return _proxyTo(`http://localhost:${peer.apiPort}`, req, res);
    }

    // Local cache (Phase 2 — populated by sync.js)
    const cacheKey = fullPath.replace(/\//g, '_').replace(/^_/, '');
    const cached   = readCache(cacheKey);
    if (cached?.data) {
      res.setHeader('X-Cache',   'HIT');
      res.setHeader('X-Node-Id', identity.nodeId.slice(0, 16));
      if (_config?.access?.encryptionEnabled && !isLocal) {
        return _sendEncrypted(req, res, cached.data, _config);
      }
      return res.json(cached.data);
    }

    const dataBase = config.network.dataApiUrl || config.network.registryUrl;
    return _proxyTo(dataBase, req, res);
  });

  // ── RPC pipe — stake-gated Solana JSON-RPC ────────────────────────────────
  // Staking CIRC unlocks free access to the Circuit RPC aggregator.
  // This is what operators offer node runners: stake → access the pipe.
  // Unstaked wallets get 402. No wallet header = 401 (must identify yourself).
  // Localhost always has access — local tools and agents are free.
  app.use('/rpc', async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress;
    const isLocal  = isLocalAccess(clientIp);

    // Local access: always allowed, no stake check
    if (isLocal) {
      return _proxyRpc(config, req, res);
    }

    const wallet      = req.headers['x-wallet-address'];
    const poolAddress = config.access?.stakingPool;
    const minStake    = config.access?.minStakeCirc ?? 100_000;

    // KNOWN LIMITATION (Phase 3): X-Wallet-Address is trusted without proof-of-possession.
    // A caller who knows any staked wallet address can claim it and bypass the gate.
    // Phase 3 will add a challenge-response: GET /rpc/challenge returns a server-issued nonce;
    // the client signs it with their ed25519 keypair; /rpc verifies the signature before
    // calling verifyStakeCached. Until then, the stake check limits spoofing to on-chain
    // staked wallets only — callers cannot fabricate stake they don't hold on-chain.

    // No wallet header = can't check stake
    if (!wallet) {
      return res.status(401).json({
        error:   'Wallet address required',
        message: 'Include X-Wallet-Address: <your_solana_wallet> to access the RPC pipe.',
        stake:   { pool: poolAddress || null, minRequired: minStake },
      });
    }

    // Pool not configured = RPC is open (no staking gate active yet)
    if (!poolAddress) {
      return _proxyRpc(config, req, res);
    }

    // Verify stake — cached, deduplicated
    let eligible = false;
    let stakedAmount = 0;
    try {
      const { verifyStakeCached } = require('./stakepoint');
      const rpc    = config.network?.solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com';
      const result = await verifyStakeCached(wallet, poolAddress, minStake, 6, rpc);
      eligible     = result.eligible;
      stakedAmount = result.stakedAmount;
    } catch {
      // Fail closed: an attacker could induce RPC errors to force a fail-open bypass.
      // Return 503 so legitimate users retry when the RPC recovers, rather than granting
      // unverified access.
      return res.status(503).json({
        error:   'Stake verification temporarily unavailable',
        message: 'Could not verify your CIRC stake. Please retry in a moment.',
      });
    }

    if (!eligible) {
      return res.status(402).json({
        error:        'Stake Required',
        message:      `Stake at least ${minStake.toLocaleString()} CIRC in the Circuit pool to access the RPC pipe.`,
        stake: {
          pool:        poolAddress,
          minRequired: minStake,
          yourStake:   stakedAmount,
          shortfall:   Math.max(0, minStake - stakedAmount),
          stakeUrl:    config.access?.stakingPoolId
            ? `https://stakepoint.app/pool/${config.access.stakingPoolId}`
            : 'https://stakepoint.app',
        },
      });
    }

    // Staked — forward to the Circuit RPC aggregator
    res.setHeader('X-Stake-Verified', 'true');
    res.setHeader('X-Staked-Amount',  String(Math.floor(stakedAmount)));
    return _proxyRpc(config, req, res);
  });

  _server = http.createServer(app);

  // Start WebSocket chat server (active when agent is connected via agentDataPath)
  chat.start(_server, config);

  _server.listen(port, '0.0.0.0', () => {
    console.log(`[server] Lite API listening on port ${port}`);
    console.log(`[server] Local agent can connect at http://localhost:${port}/api/...`);
  });

  // Refresh peer list every 5 min
  setInterval(async () => {
    try { _peers = await getPeers(); } catch {}
  }, 5 * 60_000).unref();
}

function stop() {
  if (_server) { _server.close(); _server = null; }
}

// ── Proxy helper ──────────────────────────────────────────────────────────────

// Proxy a data API request to the upstream (circuit-data-api or canonical node).
// No bypass key — agents always pay x402 for data regardless of stake status.
async function _proxyTo(baseUrl, req, res) {
  const url = `${baseUrl}/api${req.path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

  try {
    const proxyRes = await fetch(url, {
      method:  req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['x-payment-signature'] ? { 'X-Payment-Signature': req.headers['x-payment-signature'] } : {}),
      },
      body:    req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
      signal:  AbortSignal.timeout(15_000),
    });

    const data = await proxyRes.json();
    res.setHeader('X-Cache',   'MISS');
    res.setHeader('X-Proxied', 'canonical');
    res.setHeader('X-Node-Id', identity.nodeId.slice(0, 16));
    res.status(proxyRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Upstream unavailable', detail: err.message });
  }
}

// Proxy a Solana JSON-RPC request to the Circuit RPC aggregator.
// The aggregator handles provider selection, failover, and caching.
// rpcBase defaults to the registryUrl (circuit-node) which exposes POST /rpc.
async function _proxyRpc(config, req, res) {
  const rpcBase = config.network?.rpcUrl || config.network?.registryUrl;
  const url     = `${rpcBase}/rpc`;

  try {
    const body = req.method === 'GET' ? undefined : JSON.stringify(req.body);
    const proxyRes = await fetch(url, {
      method:  req.method === 'GET' ? 'POST' : req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(20_000),
    });

    const data = await proxyRes.json();
    res.setHeader('X-Node-Id', identity.nodeId.slice(0, 16));
    res.status(proxyRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'RPC upstream unavailable', detail: err.message });
  }
}

// ── Phase 3: Encrypted response helper ───────────────────────────────────────

async function _sendEncrypted(req, res, data, config) {
  const { deriveKey, currentEpochId, encrypt, verifyCircBalance } = require('./access');
  const walletAddress = req.headers['x-wallet-address'];
  if (!walletAddress) {
    return res.status(401).json({ error: 'X-Wallet-Address header required for encrypted access' });
  }
  const { eligible, balance } = await verifyCircBalance(
    walletAddress,
    config.access?.minCircBalance ?? 100
  );
  if (!eligible) {
    return res.status(403).json({ error: 'Insufficient CIRC balance', balance, required: config.access?.minCircBalance ?? 100 });
  }
  const salt     = require('crypto').randomBytes(16);
  const key      = await deriveKey(config.access?.circMint ?? '8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump', walletAddress, currentEpochId(), salt);
  const envelope = encrypt(data, key);
  res.setHeader('X-Encrypted', 'aes-256-gcm');
  res.setHeader('X-Epoch-Id',  currentEpochId());
  res.setHeader('X-Salt',      salt.toString('base64'));
  res.json({ encrypted: true, envelope });
}

module.exports = { start, stop };
