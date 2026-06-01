// lib/registry.js — Registration and heartbeat with the CIRCUIT network registry.
//
// Responsibilities:
//   - Announce this node on startup (POST /api/network/nodes/announce)
//   - Send heartbeat every heartbeat.intervalMs (POST /api/network/nodes/ping)
//   - Deregister on clean shutdown (DELETE /api/network/nodes/:nodeId)
//   - Reconnect with backoff if registry is unreachable
//
// All requests are signed via lib/identity.js so the registry can verify
// that only this node can update its own record.
'use strict';

const identity = require('./identity');

const ANNOUNCE_PATH = '/api/network/nodes/announce';
const PING_PATH     = '/api/network/nodes/ping';
const NODES_PATH    = '/api/network/nodes';

let _config   = null;
let _timer    = null;
let _missedPings = 0;

// ── Announce ──────────────────────────────────────────────────────────────────

/**
 * Register this node with the canonical registry.
 * Returns the registered node record on success.
 */
async function announce(config, extraFields = {}) {
  _config = config;
  const body = {
    nodeId:       identity.nodeId,
    version:      config.node.version,
    shards:       config.node.shards ?? ['all'],
    region:       config.node.region ?? 'unknown',
    agentRunning: config.node.agentEnabled ?? false,
    apiPort:      config.node.apiPort ?? null,
    ...extraFields,
  };

  const headers = identity.signRequest(body);
  const url     = `${config.network.registryUrl}${ANNOUNCE_PATH}`;

  try {
    const res  = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    console.log(`[registry] Announced — nodeId: ${identity.nodeId.slice(0, 16)}… status: ${data.node?.status}`);
    return data.node;
  } catch (err) {
    const cause = err.cause?.message ?? err.cause ?? '';
    console.error('[registry] Announce failed:', err.message, cause ? `(${cause})` : '');
    return null;
  }
}

// ── Heartbeat loop ────────────────────────────────────────────────────────────

/**
 * Start the heartbeat loop. Call once after successful announce.
 * @param {object} config
 * @param {function} getStatus — async fn returning { agentRunning, syncStatus }
 */
function startHeartbeat(config, getStatus = async () => ({})) {
  if (_timer) clearInterval(_timer);
  _missedPings = 0;

  _timer = setInterval(async () => {
    try {
      const status = await getStatus();
      await ping(config, status);
    } catch (err) {
      console.error('[registry] Heartbeat error:', err.message);
    }
  }, config.heartbeat?.intervalMs ?? 60_000);

  _timer.unref();
  console.log(`[registry] Heartbeat started (interval: ${config.heartbeat?.intervalMs ?? 60_000}ms)`);
}

async function ping(config, update = {}) {
  const body    = { nodeId: identity.nodeId, ...update };
  const headers = identity.signRequest(body);
  const url     = `${config.network.registryUrl}${PING_PATH}`;

  try {
    const res  = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    _missedPings = 0;
    return data;
  } catch (err) {
    _missedPings++;
    const cause = err.cause?.message ?? err.cause ?? '';
    console.warn(`[registry] Ping failed (missed: ${_missedPings}):`, err.message, cause ? `(${cause})` : '');

    // Re-announce if we've missed too many pings (node may have been evicted)
    const maxMissed = config.heartbeat?.maxMissed ?? 3;
    if (_missedPings >= maxMissed) {
      console.log('[registry] Too many missed pings — re-announcing');
      _missedPings = 0;
      await announce(config);
    }
    return null;
  }
}

// ── Deregister ────────────────────────────────────────────────────────────────

async function deregister(config) {
  if (_timer) { clearInterval(_timer); _timer = null; }

  const headers = identity.signRequest({});
  const url     = `${config.network.registryUrl}${NODES_PATH}/${encodeURIComponent(identity.nodeId)}`;

  try {
    const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) });
    const data = await res.json();
    console.log('[registry] Deregistered:', data.message);
  } catch (err) {
    console.warn('[registry] Deregister failed (server will evict via TTL):', err.message);
  }
}

// ── Peer discovery ────────────────────────────────────────────────────────────

/**
 * Fetch the list of active peer nodes from the registry.
 * Used for mesh routing — find nodes that serve a specific shard.
 */
async function getPeers(config, filters = {}) {
  const params = new URLSearchParams(filters).toString();
  const url    = `${config.network.registryUrl}${NODES_PATH}${params ? '?' + params : ''}`;

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const data = await res.json();
    return data.nodes ?? [];
  } catch (err) {
    console.warn('[registry] getPeers failed:', err.message);
    return [];
  }
}

module.exports = { announce, startHeartbeat, deregister, getPeers, ping };
