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
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const chat       = require('./chat');
const circuitAgent = require('./circuit-agent');
const agentCloud   = require('./agent-cloud');
const llmWorker  = require('./llm-worker');
const cpuHost    = require('./cpu-host');
const gpuHost    = require('./gpu-host');
const updater                       = require('./updater');
const { isLocalAccess }             = require('./access');
const { canServe, findServingPeer } = require('./shard');
const { readCache }                 = require('./sync');
const identity                      = require('./identity');
const home                          = require('./home');

function _agentStatus(config) {
  const dataPath = config.node?.agentDataPath;
  if (!dataPath) return null;
  return circuitAgent.getStatus(path.resolve(dataPath));
}

// Solana base58 pubkey shape — reject junk before it reaches an on-chain / RPC call so a
// malformed (but long) wallet can't be forwarded verbatim to the operator's keyed RPC.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isValidWallet(w) { return typeof w === 'string' && BASE58_ADDRESS.test(w); }

// ── Admin token ───────────────────────────────────────────────────────────────
// Guards the routes that spawn processes / run docker / self-update / expose operator
// secrets. The server binds 0.0.0.0, so an IP-only gate breaks behind a reverse proxy
// (req.ip → 127.0.0.1 for everyone). A token is proxy-safe. Localhost (incl. SSH tunnels)
// stays auto-trusted so same-box / `ssh -L` access needs no token.
const ADMIN_TOKEN_FILE = path.join(home.DATA_DIR, 'admin-token');
let _adminToken = null;

function _loadAdminToken() {
  if (process.env.CIRCUIT_ADMIN_TOKEN) { _adminToken = process.env.CIRCUIT_ADMIN_TOKEN.trim(); return _adminToken; }
  try { if (fs.existsSync(ADMIN_TOKEN_FILE)) _adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!_adminToken) {
    _adminToken = crypto.randomBytes(24).toString('hex');
    try {
      const dir = path.dirname(ADMIN_TOKEN_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ADMIN_TOKEN_FILE, _adminToken, { mode: 0o600 });
    } catch (err) { console.warn('[server] could not persist admin token:', err.message); }
  }
  return _adminToken;
}
// Returns the token, loading/generating on first call (so `node-client.js status` can print it).
function adminToken() { return _adminToken || _loadAdminToken(); }

function _cookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Admin gate: valid token (X-Admin-Token header or circuit_admin cookie, constant-time) OR a
// direct localhost connection. Uses req.socket.remoteAddress (the real peer), not req.ip, so a
// spoofed X-Forwarded-For can't pass; dashboard.behindProxy disables localhost auto-trust for
// intentional reverse-proxy deployments (token required there).
function _adminAuth(req, res) {
  const provided = req.get('X-Admin-Token') || _cookie(req, 'circuit_admin');
  if (provided && _adminToken && Buffer.byteLength(provided) === Buffer.byteLength(_adminToken) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(_adminToken))) {
    return true;
  }
  if (!_config?.dashboard?.behindProxy && isLocalAccess(req.socket?.remoteAddress)) return true;
  res.status(401).json({
    error: 'admin token required',
    hint:  'open the dashboard from localhost or an SSH tunnel, or paste the admin token (RPC Key tab → Admin Access; find it via `node node-client.js status` or the node startup log)',
  });
  return false;
}

const DASHBOARD_HTML = path.join(home.INSTALL_ROOT, 'ui', 'dashboard.html');   // shipped asset (read-only ok)

// Staking-gate defaults. These are the REAL live values, used as fallbacks so the gate works
// out-of-the-box even on an older client.json that predates the access block (client.json is
// gitignored, so `git pull` never adds new fields to it). config.access.* overrides either.
//   - pool: the Circuit StakePoint pool on mainnet
//   - min:  the NET minimum after StakePoint's 2% staking fee (stake ~5,000,000 gross to clear it)
const DEFAULT_STAKING_POOL   = '2E87KFdwyVE2cZR3s6cBrTyHyuGJvhQhHkYv5VbVUg3M'; // on-chain pool ACCOUNT (stake verification)
const DEFAULT_STAKING_POOL_ID = 'cmqssahza0000jp04gd108qq1';                   // stakepoint.app web id (the LINK) — NOT the address
const DEFAULT_MIN_STAKE_CIRC = 4_900_000;

// The stakepoint.app pool URL. The web id is a short cuid; if a config still has the on-chain ADDRESS
// in stakingPoolId (the old example), it's the wrong value for a link — detect that and use the real id
// so a stale client.json can't produce a dead URL.
function _stakePoolUrl(config) {
  const id = config?.access?.stakingPoolId;
  const ok = id && !BASE58_ADDRESS.test(id); // not a base58 address → treat as a web id
  return `https://stakepoint.app/pool/${ok ? id : DEFAULT_STAKING_POOL_ID}`;
}

let _server = null;
let _config = null;
let _peers  = [];

// ── Start ─────────────────────────────────────────────────────────────────────

function start(config, getPeers = async () => []) {
  _config = config;
  require('./access').configure(_config);
  _loadAdminToken();
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

  // Agent cloud (CPU hosting) — this node's contribution + the cloud-wide view.
  // Read-only: the node-host holds no keys (custody is off-box in the signer).
  app.get('/cloud/status', async (req, res) => {
    try { res.json(await agentCloud.getStatus(config)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Stake verification — checks a wallet's CIRC stake in the configured StakePoint pool.
  // wallet param is optional: omit to fetch pool config only (used by dashboard on load).
  app.get('/stake/check', async (req, res) => {
    const wallet      = req.query.wallet ?? null;
    const poolAddress = config.access?.stakingPool ?? DEFAULT_STAKING_POOL;
    const minAmount   = config.access?.minStakeCirc  ?? DEFAULT_MIN_STAKE_CIRC;
    const decimals    = config.access?.circDecimals  ?? 6;
    const poolUrl     = _stakePoolUrl(config);

    if (!poolAddress) {
      return res.json({ configured: false, wallet, poolUrl, minRequired: minAmount,
        message: 'Staking gate not configured. Set access.stakingPool in config/client.json.' });
    }

    if (!wallet) {
      return res.json({ configured: true, poolAddress, poolUrl, minRequired: minAmount });
    }

    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address' });
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
    if (!_adminAuth(req, res)) return;
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
    if (!_adminAuth(req, res)) return;
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
    if (!_adminAuth(req, res)) return;
    const { version } = req.body ?? {};
    if (!version || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version format' });
    }
    const ok = updater.rollback(version);
    if (!ok) return res.status(404).json({ error: `No backup found for v${version}` });
    res.json({ triggered: true, version });
  });

  // ── Inference chat proxy ──────────────────────────────────────────────────
  // Order: localhost:19200 (free for a co-located coordinator) → the configured coordinatorUrl
  // → the public gateway. On the public gateway, inference is FREE for a live node: we attach this
  // node's X-Node signature (lib/identity) and the gateway serves it without x402 (no wallet, no
  // payment — running the node-client is the credential). Falls back to the paywall only if the
  // node isn't recognised as live.

  const INFER_LOCALHOST = 'http://localhost:19200';
  const INFER_PUBLIC    = 'https://inference.circuitllm.xyz';
  const _inferUrls = () => {
    const cfgUrl = _config?.llmWorker?.coordinatorUrl;
    return [...new Set([INFER_LOCALHOST, cfgUrl || INFER_PUBLIC])].filter(Boolean);
  };
  const _isLocalCoord = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);

  app.get('/inference/status', async (req, res) => {
    const urls = _inferUrls();
    for (const url of urls) {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          // Report the REAL model the coordinator is serving (don't hardcode) — ask /v1/models.
          let model = null;
          try {
            const m = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
            if (m.ok) { const j = await m.json(); model = j?.data?.[0]?.id ?? j?.model ?? null; }
          } catch {}
          return res.json({ available: true, endpoint: url, model: model || 'unknown' });
        }
      } catch {}
    }
    res.status(503).json({ available: false, error: 'coordinator_unavailable' });
  });

  // ── Network map proxy ─────────────────────────────────────────────────────
  // The dashboard polls /api/network/nodes/* same-origin; forward it to the registry so the
  // "network at a glance" stats populate (was 404 → empty). Read-only GET passthrough.
  // NB: express 5 / path-to-regexp v8 — optional segment is `{/:sub}`, not `:sub?`.
  app.get('/api/network/nodes{/:sub}', async (req, res) => {
    const base = _config?.network?.registryUrl;
    if (!base) return res.status(503).json({ error: 'no registry configured' });
    // encodeURIComponent so a crafted segment (e.g. '..', encoded slashes) can't manipulate
    // the upstream path — nodeIds are base64url/hex, which survive encoding unchanged.
    const sub = req.params.sub ? `/${encodeURIComponent(req.params.sub)}` : '';
    try {
      const r = await fetch(`${base}/api/network/nodes${sub}`, { signal: AbortSignal.timeout(6000) });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch (e) { res.status(502).json({ error: 'registry unreachable', detail: e.message }); }
  });

  // ── DLLM info — one call for the DLLM tab: the model + endpoint this node talks to, the live
  // mesh topology (nodes/coverage/layers), and THIS node's worker contribution (if it runs one). ──
  app.get('/dllm/info', async (req, res) => {
    const out = { connected: false, model: null, endpoint: null, mesh: null, worker: null };
    const urls = [INFER_LOCALHOST];
    const cfgUrl = _config?.llmWorker?.coordinatorUrl;
    if (cfgUrl && cfgUrl !== INFER_LOCALHOST) urls.push(cfgUrl);
    for (const url of urls) {
      try {
        const m = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (m.ok) { const j = await m.json(); out.connected = true; out.endpoint = url;
          out.model = j?.data?.[0]?.id ?? j?.model ?? null; break; }
      } catch {}
    }
    // Live mesh (coverage + holders) from the DLLM coordinator control plane (/topology).
    try {
      const ctl = _config?.network?.dllmControl || 'https://node.circuitllm.xyz';
      const t = await fetch(`${ctl}/topology`, { signal: AbortSignal.timeout(5000) });
      if (t.ok) out.mesh = await t.json();
    } catch {}
    // This node's own GPU worker, if enabled.
    out.worker = _config?.llmWorker?.enabled ? llmWorker.status() : { enabled: false };
    out.settings = {
      coordinatorUrl: _config?.llmWorker?.coordinatorUrl || null,
      advertiseHost:  _config?.llmWorker?.advertiseHost || _config?.node?.advertiseHost || null,
      payoutWallet:   _config?.llmWorker?.payoutWallet || _config?.node?.payoutWallet || null,
    };
    res.json(out);
  });

  // ── DLLM worker control (localhost only — same gate as update mgmt; server binds 0.0.0.0, so a
  // public stop endpoint would let anyone knock the node offline). Operators of remote nodes reach
  // these via an SSH tunnel. STOP a sole slot-holder = mesh coverage gap, so the UI warns first. ──
  // Admin gate for worker/host/gpu control — token OR localhost (see _adminAuth above).
  function _adminLocal(req, res) { return _adminAuth(req, res); }
  const _workerStartCfg = () => ({ ...(_config?.llmWorker || {}), nodeApiPort: _config?.node?.apiPort ?? 19000 });

  // Persist a config patch to config/client.json AND the in-memory _config, so a Connect
  // from the dashboard survives a node-client restart. Deep-merge (objects), atomic write.
  const CONFIG_PATH = path.join(home.CONFIG_DIR, 'client.json');
  function _deepMerge(dst, src) {
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
        dst[k] = _deepMerge(dst[k] && typeof dst[k] === 'object' ? dst[k] : {}, src[k]);
      } else dst[k] = src[k];
    }
    return dst;
  }
  function _saveConfig(patch) {
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first write */ }
    const merged = _deepMerge(disk, patch);
    fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(merged, null, 2));
    fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
    _deepMerge(_config, patch); // keep the running process in sync
    return merged;
  }

  // ── Detection + machine specs for the Connect UI (presets are scaled to THIS box) ──
  app.get('/setup/status', (req, res) => {
    if (!_adminAuth(req, res)) return;
    const gi = llmWorker.gpuInfo();
    res.json({
      gpu: {
        present:       llmWorker.hasGpu(),
        info:          gi,                                   // { name, vramMb } or null
        enginePresent: llmWorker.enginePresent(_config?.llmWorker),
        presets:       llmWorker.presets(gi?.vramMb),        // light/balanced/max capacity-layers
        connected:     !!_config?.llmWorker?.enabled,
        worker:        _config?.llmWorker?.enabled ? llmWorker.status() : { enabled: false },
        payoutWallet:  _config?.llmWorker?.payoutWallet || _config?.node?.payoutWallet || null,
      },
      cpu: {
        hostPresent:   cpuHost.hostPresent(_config),
        presets:       cpuHost.presets(),                    // light/balanced/max + machine {cores,ramMb}
        connected:     !!(_config?.agentCloud?.enabled),
        host:          cpuHost.status(),
        controlPlane:  _config?.agentCloud?.controlPlane || 'https://agents.circuitllm.xyz',
        payoutWallet:  _config?.agentCloud?.payoutWallet || _config?.node?.payoutWallet || null,
      },
    });
  });

  // Guided 1-click setup for the CPU node-host: vendor it from a local circuit-agent-cloud
  // checkout if present, else report what's needed. (The heavy GPU-engine provision is a
  // separate follow-up — the UI links to it.)
  app.post('/setup/install/cpu', (req, res) => {
    if (!_adminLocal(req, res)) return;
    if (cpuHost.hostPresent(_config)) return res.json({ ok: true, present: true });
    try {
      const cloudRoot = path.join(require('os').homedir(), 'circuit-agent-cloud');
      const destBase = path.join(__dirname, '..', 'vendor');
      if (fs.existsSync(path.join(cloudRoot, 'node-host', 'host.js'))) {
        // The node-host needs its siblings to actually RUN a hosted agent: ../lib (host deps) and
        // ../agentd (the reference workload). Vendoring only node-host leaves agents stuck "scheduled".
        fs.cpSync(path.join(cloudRoot, 'node-host'), path.join(destBase, 'node-host'), { recursive: true });
        for (const d of ['lib', 'agentd']) {
          const s = path.join(cloudRoot, d);
          if (fs.existsSync(s)) fs.cpSync(s, path.join(destBase, d), { recursive: true });
        }
        return res.json({ ok: true, vendored: true, present: cpuHost.hostPresent(_config) });
      }
      res.status(409).json({ ok: false, error: 'node-host source not found',
        hint: 'Bundle circuit-agent-cloud/{node-host,lib,agentd} into the node-client (vendor/) to enable one-click CPU hosting.' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/dllm/worker/start', (req, res) => {
    if (!_adminLocal(req, res)) return;
    const spec = req.body || {};
    if (!llmWorker.hasGpu())                  return res.status(409).json({ error: 'no-gpu', message: 'No NVIDIA GPU detected on this box.' });
    if (!llmWorker.enginePresent(_config?.llmWorker)) return res.status(409).json({ error: 'engine-missing', setup: 'gpu', message: 'The inference engine is not installed on this box yet.' });
    try {
      const gi = llmWorker.gpuInfo();
      const p  = llmWorker.presets(gi?.vramMb);
      const capacityLayers = Math.max(1, Number(spec.capacityLayers) || p[spec.preset] || p.balanced);
      const payoutWallet   = (spec.payoutWallet || '').trim();
      // Persist so the contribution survives a restart: enable + dynamic-mesh script + size.
      _saveConfig({ llmWorker: { enabled: true, runScript: 'deploy/run-mesh.sh', capacityLayers,
        ...(payoutWallet ? { payoutWallet } : {}) } });
      llmWorker.start(_workerStartCfg());
      res.json({ ok: true, status: llmWorker.status(), capacityLayers });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/dllm/worker/stop', (req, res) => {
    if (!_adminLocal(req, res)) return;
    try { llmWorker.stop(); _saveConfig({ llmWorker: { enabled: false } }); res.json({ ok: true, status: llmWorker.status() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/dllm/worker/restart', (req, res) => {
    if (!_adminLocal(req, res)) return;
    try {
      llmWorker.stop();
      // wait for the old process to release its port before respawning
      setTimeout(() => { try { llmWorker.start(_workerStartCfg()); } catch {} }, 4000);
      res.json({ ok: true, restarting: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GPU node (the circuit-gpu-node Docker container) — status + start/stop/logs ──
  // The GPU node is a Docker container the `join` installer started (usually in WSL). We drive
  // `docker` against it so the operator manages it from the dashboard instead of a terminal.
  app.get('/gpu/status', (req, res) => { if (!_adminAuth(req, res)) return; try { res.json(gpuHost.status()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/gpu/start', (req, res) => {
    if (!_adminLocal(req, res)) return;
    try { res.json({ ok: true, status: gpuHost.start() }); } catch (e) { res.status(500).json({ error: e.message, cmd: gpuHost.cmd('start') }); }
  });
  app.post('/gpu/stop', (req, res) => {
    if (!_adminLocal(req, res)) return;
    try { res.json({ ok: true, status: gpuHost.stop() }); } catch (e) { res.status(500).json({ error: e.message, cmd: gpuHost.cmd('stop') }); }
  });
  app.get('/gpu/logs', async (req, res) => {
    if (!_adminAuth(req, res)) return;
    try { res.json(await gpuHost.logs(Number(req.query.tail) || 80)); } catch (e) { res.status(500).json({ error: e.message, cmd: gpuHost.cmd('logs') }); }
  });

  // ── CPU agent-cloud hosting control (localhost only, same gate) ──────────────
  app.post('/cloud/host/start', (req, res) => {
    if (!_adminLocal(req, res)) return;
    if (!cpuHost.hostPresent(_config)) return res.status(409).json({ error: 'node-host-missing', setup: 'cpu' });
    try {
      const body = req.body || {};
      // Default to the public control plane; an advanced user can point at their own. Persist it so
      // the node reconnects to the same cloud after a restart and the status reader agrees.
      const controlPlane = (body.controlPlane || '').trim() || _config?.agentCloud?.controlPlane || 'https://agents.circuitllm.xyz';
      const spec = { preset: body.preset, maxAgents: body.maxAgents, maxCpu: body.maxCpu,
        maxMemoryMb: body.maxMemoryMb, payoutWallet: (body.payoutWallet || '').trim() || _config?.agentCloud?.payoutWallet };
      const budget = cpuHost.resolveBudget(spec);
      _saveConfig({ agentCloud: { enabled: true, controlPlane, maxAgents: budget.maxAgents, maxCpu: budget.maxCpu,
        maxMemoryMb: budget.maxMemoryMb, ...(spec.payoutWallet ? { payoutWallet: spec.payoutWallet } : {}) } });
      // _saveConfig deep-merged controlPlane into _config, so cpuHost.start now sees the URL.
      const r = cpuHost.start(_config, spec);
      if (!r.ok) return res.status(500).json({ error: r.error || 'start-failed' });
      res.json({ ok: true, status: cpuHost.status(), budget });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/cloud/host/stop', (req, res) => {
    if (!_adminLocal(req, res)) return;
    try { cpuHost.stop(); _saveConfig({ agentCloud: { enabled: false } }); res.json({ ok: true, status: cpuHost.status() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/cloud/host/status', (req, res) => { if (!_adminAuth(req, res)) return; res.json(cpuHost.status()); });

  // ── QR code (themed SVG) — for wallet addresses, the join command, etc. ──────
  app.get('/qr', async (req, res) => {
    const data = String(req.query.data || '').slice(0, 512);
    if (!data) return res.status(400).send('missing data');
    try {
      const svg = await require('qrcode').toString(data, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#0c0c0c', light: '#d9a441' },   // dark modules on amber — themed + scannable
      });
      res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
    } catch (e) { res.status(500).send('qr error'); }
  });

  // ── Earnings — this node's payout wallet: current CIRC balance + recent payouts received. ────
  app.get('/earnings', async (req, res) => {
    const wallet = String(req.query.wallet || '').trim();
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'valid Solana wallet required' });
    // Raw JSON-RPC (no @solana/web3.js dependency — keeps the node-client lean; that module isn't
    // installed, which crashed this route). fetch is global on Node 18+.
    const MINT   = _config?.access?.circMint || '8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump';
    const rpcUrl = _config?.network?.solanaRpcUrl || 'https://api.mainnet-beta.solana.com';
    const rpc = async (method, params) => {
      const r = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    };
    try {
      // CIRC balance = the wallet's token account(s) for the CIRC mint. The mint filter works for
      // Token-2022 without deriving the ATA or knowing the token program.
      const accs = await rpc('getTokenAccountsByOwner', [wallet, { mint: MINT }, { encoding: 'jsonParsed' }]);
      let balance = 0, tokenAcct = null;
      for (const a of (accs?.value || [])) {
        balance += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
        if (!tokenAcct) tokenAcct = a.pubkey;
      }
      // recent payouts = recent inbound CIRC transfers to that token account (best-effort, capped)
      const payouts = [];
      if (tokenAcct) {
        try {
          const sigs = (await rpc('getSignaturesForAddress', [tokenAcct, { limit: 6 }])) || [];
          for (const s of sigs) {
            const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
            const pre  = (tx?.meta?.preTokenBalances || []).find(b => b.mint === MINT && b.owner === wallet);
            const post = (tx?.meta?.postTokenBalances || []).find(b => b.mint === MINT && b.owner === wallet);
            const delta = Number(post?.uiTokenAmount?.uiAmount || 0) - Number(pre?.uiTokenAmount?.uiAmount || 0);
            if (delta > 0) payouts.push({ amount: delta, ts: (s.blockTime || 0) * 1000, sig: s.signature });
          }
        } catch { /* RPC limits — return balance only */ }
      }
      res.json({ wallet, balance, payouts, received: payouts.reduce((a, p) => a + p.amount, 0) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/inference/chat', async (req, res) => {
    const { messages = [], max_tokens = 1024, temperature = 0.7 } = req.body ?? {};
    // Qwen2.5 (the served model) drifts into Chinese with nothing steering it. Prepend an
    // English-enforcing system prompt unless the caller already supplied a system message.
    const SYS = 'You are Circuit, the assistant for Circuit LLM — a decentralized AI network served across a mesh of GPUs. Always respond in English unless the user explicitly writes to you in another language. Be brief and direct: answer in 1–3 short sentences, or a few short bullets for a list. Lead with the answer; skip preamble, restating the question, and section headers. Only write a long, structured response if the user explicitly asks for detail or a step-by-step.';
    const msgs = Array.isArray(messages) && messages.some((m) => m?.role === 'system')
      ? messages
      : [{ role: 'system', content: SYS }, ...messages];
    // The exact body object we sign + send. Signing covers this object, so the gateway verifies the
    // signature over the identical request (sign locally — no payment, no round-trip).
    const bodyObj = { messages: msgs, max_tokens, temperature, stream: true };
    const payload = JSON.stringify(bodyObj);
    const urls = _inferUrls();

    for (const url of urls) {
      // For a remote coordinator, attach this node's identity signature → free inference for a live
      // node. Local coordinator needs no auth (it's our own box).
      const headers = _isLocalCoord(url)
        ? { 'Content-Type': 'application/json' }
        : identity.signRequest(bodyObj);
      let upstream;
      try {
        upstream = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(90_000),
        });
      } catch { continue; }

      if (upstream.status === 402) {
        if (url === urls[urls.length - 1]) {
          return res.status(402).json({
            error: 'payment_required',
            message: 'This node is not recognised as live on the network yet, so inference is paywalled. Make sure the node-client is registered (it announces on start); free inference resumes once it is online.',
          });
        }
        continue;
      }
      if (!upstream.ok) {
        const body = await upstream.json().catch(() => ({}));
        return res.status(upstream.status).json({ error: 'Coordinator error', ...body });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(dec.decode(value, { stream: true }));
        }
      } finally { res.end(); }
      return;
    }
    res.status(503).json({ error: 'coordinator_unavailable', message: 'Could not reach any inference coordinator.' });
  });

  // Canonical hub status — fetched server-side to avoid CORS issues
  app.get('/network/hub', async (req, res) => {
    const base = config.network.registryUrl;
    // Reachability = can we reach the registry the node actually registers with? That lives under
    // /api/network/* (announce/ping). On the PUBLIC host (node.circuitllm.xyz) a bare /health routes
    // via nginx to a different upstream, so the old /health probe reported a false "unreachable"
    // even while registration worked. Probe /api/network/nodes for the truth; pull version/service
    // from /health only as best-effort metadata (works when registryUrl points straight at circuit-node).
    let reachable = false, error;
    try {
      const r = await fetch(`${base}/api/network/nodes`, { signal: AbortSignal.timeout(6_000) });
      reachable = r.ok;
      if (!r.ok) error = `registry HTTP ${r.status}`;
    } catch (err) { error = err.message; }

    let meta = {};
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4_000) });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        meta = { version: d.version, service: d.service, rpc: d.rpc };
        reachable = true;          // direct circuit-node /health works → definitely reachable
      }
    } catch { /* public host /health may 502 — non-fatal, reachability already decided above */ }

    res.json({ reachable, url: base, ...(reachable ? meta : { error }) });
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

    // SECURITY LOCKDOWN (2026-06-20): remote /rpc is disabled until proof-of-
    // possession exists. The stake gate below trusts a client-supplied
    // X-Wallet-Address with no signature — and with no stakingPool configured it
    // falls through to a fully OPEN proxy (see below) — so any remote caller could
    // use the RPC pipe. Restrict to localhost until the GET /rpc/challenge ->
    // ed25519-signed-nonce flow is built. The stake code below is kept
    // (unreachable) as the basis for that work.
    return res.status(403).json({
      error:   'Remote RPC access disabled',
      message: 'The /rpc pipe is restricted to localhost until signature-based wallet verification (proof-of-possession) is enabled.',
    });

    const wallet      = req.headers['x-wallet-address'];
    const poolAddress = config.access?.stakingPool ?? DEFAULT_STAKING_POOL;
    const minStake    = config.access?.minStakeCirc ?? DEFAULT_MIN_STAKE_CIRC;

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
          stakeUrl:    _stakePoolUrl(config),
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

  // Resume CPU agent-cloud hosting if the operator left it ON — the toggle survives restarts.
  if (_config?.agentCloud?.enabled && cpuHost.hostPresent(_config)) {
    const ac = _config.agentCloud;
    const r = cpuHost.start(_config, { maxAgents: ac.maxAgents, maxCpu: ac.maxCpu, maxMemoryMb: ac.maxMemoryMb, payoutWallet: ac.payoutWallet });
    console.log(`[server] resumed CPU hosting → ${ac.controlPlane || 'default cloud'}${r.ok ? '' : ' (' + r.error + ')'}`);
  }

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

module.exports = { start, stop, adminToken };
