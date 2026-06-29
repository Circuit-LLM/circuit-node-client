// lib/sync.js — Data sync client stub.
//
// This module manages keeping the local node's data in sync with
// the canonical circuit-node (bare metal / circuit-indexer).
//
// Phase 1 (now): HTTP polling fallback.
//   Periodically fetches fresh data from the canonical node and
//   stores locally in data/cache/. Simple but effective.
//
// Phase 2 (circuit-geyser live): gRPC streaming.
//   Subscribes to the Yellowstone-compatible gRPC stream from the
//   validator. Receives account updates, transactions, and slot
//   notifications in real time. Replaces polling entirely.
//
// Phase 3 (full mesh): Peer sync.
//   Nodes can also sync data from peers, not just the canonical node.
//   The shard assignment determines what data each peer is authoritative for.
//
// Status tracking:
//   syncStatus = {
//     protocol:    'grpc' | 'http' | 'disconnected'
//     status:      'synced' | 'syncing' | 'lagging' | 'disconnected'
//     lagMs:       number    — ms behind canonical
//     lastSyncAt:  ISO string
//     slotHeight:  number | null
//   }
'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

// ── Sync endpoint registry ────────────────────────────────────────────────────

const SYNC_ENDPOINTS = [
  { path: '/api/epoch',            cacheKey: 'epoch',            ttlMs: 30_000,  shard: 'CHAIN_METRICS'   },
  { path: '/api/network',          cacheKey: 'network',          ttlMs: 30_000,  shard: 'CHAIN_METRICS'   },
  { path: '/api/supply',           cacheKey: 'supply',           ttlMs: 60_000,  shard: 'CHAIN_METRICS'   },
  { path: '/api/fees',             cacheKey: 'fees',             ttlMs: 15_000,  shard: 'CHAIN_METRICS'   },
  { path: '/api/inflation',        cacheKey: 'inflation',        ttlMs: 300_000, shard: 'CHAIN_METRICS'   },
  { path: '/api/rent',             cacheKey: 'rent',             ttlMs: 300_000, shard: 'CHAIN_METRICS'   },
  { path: '/api/oracle-prices',    cacheKey: 'oracle-prices',    ttlMs: 30_000,  shard: 'ORACLE_PRICES'   },
  { path: '/api/price/sol',        cacheKey: 'price_sol',        ttlMs: 30_000,  shard: 'ORACLE_PRICES'   },
  { path: '/api/market',           cacheKey: 'market',           ttlMs: 60_000,  shard: 'CHAIN_METRICS'   },
  { path: '/api/market-regime',    cacheKey: 'market-regime',    ttlMs: 120_000, shard: 'CHAIN_METRICS'   },
  { path: '/api/market-sentiment', cacheKey: 'market-sentiment', ttlMs: 120_000, shard: 'CHAIN_METRICS'   },
  { path: '/api/staking',          cacheKey: 'staking',          ttlMs: 300_000, shard: 'YIELD_DATA'      },
  { path: '/api/lending',          cacheKey: 'lending',          ttlMs: 300_000, shard: 'YIELD_DATA'      },
  { path: '/api/dex-stats',        cacheKey: 'dex-stats',        ttlMs: 120_000, shard: 'POOL_DATA'       },
  { path: '/api/trending',         cacheKey: 'trending',         ttlMs: 60_000,  shard: 'TOKEN_ANALYTICS' },
  { path: '/api/scan',             cacheKey: 'scan',             ttlMs: 60_000,  shard: 'TOKEN_ANALYTICS' },
  { path: '/api/pools',            cacheKey: 'pools',            ttlMs: 120_000, shard: 'POOL_DATA'       },
  { path: '/api/new-tokens',       cacheKey: 'new-tokens',       ttlMs: 60_000,  shard: 'TOKEN_ANALYTICS' },
  { path: '/api/protocol-fees',    cacheKey: 'protocol-fees',    ttlMs: 300_000, shard: 'CHAIN_METRICS'   },
  { path: '/api/news',             cacheKey: 'news',             ttlMs: 300_000, shard: 'CHAIN_METRICS'   },
];

let _config     = null;
let _timer      = null;
let _grpcClient = null;

let syncStatus = {
  protocol:   'disconnected',
  status:     'disconnected',
  lagMs:      null,
  lastSyncAt: null,
  slotHeight: null,
};

// Track last fetch time per cacheKey to skip endpoints whose TTL hasn't expired
const _lastFetchAt = {};

// Aggregate sync statistics
const _syncStats = {
  total:       0,
  hits:        0,
  misses:      0,
  errors:      0,
  skipped:     0,
  writeErrors: 0,   // consecutive cache-write failures (disk full / permissions)
};

// Count how many full sync cycles have run (for periodic logging)
let _syncCycles = 0;

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(config) {
  _config = config;
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  _cleanStaleTmp();   // sweep orphaned .tmp files from a previous crash mid-write

  if (config.sync?.protocol === 'grpc' && config.sync?.grpcEndpoint) {
    await _startGrpc(config);
  } else {
    _startHttpPolling(config);
  }
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_grpcClient) {
    // _grpcClient.close(); // uncomment when gRPC client is implemented
    _grpcClient = null;
  }
  syncStatus.status   = 'disconnected';
  syncStatus.protocol = 'disconnected';
}

// ── Phase 2: gRPC (stub — activates when circuit-geyser is live) ───────────────

async function _startGrpc(config) {
  // TODO Phase 2: implement Yellowstone gRPC subscription
  //
  // import { GeyserClient } from '@triton-one/yellowstone-grpc';
  //
  // _grpcClient = new GeyserClient(config.sync.grpcEndpoint, credentials);
  // const stream = _grpcClient.subscribe();
  // stream.on('data', (update) => _handleGeyserUpdate(update));
  // stream.on('error', () => _fallbackToHttp());
  //
  // For now, fall through to HTTP polling.
  console.log('[sync] gRPC endpoint configured but not yet implemented — using HTTP polling');
  _startHttpPolling(config);
}

// ── Phase 1: HTTP polling ─────────────────────────────────────────────────────

function _startHttpPolling(config) {
  if (!config.sync?.enabled) {
    console.log('[sync] Sync disabled — node will proxy all requests to canonical');
    syncStatus.protocol = 'disabled';
    syncStatus.status   = 'disabled';
    return;
  }

  syncStatus.protocol = 'http';
  syncStatus.status   = 'syncing';

  const interval = config.sync?.intervalMs ?? 5_000;

  // Immediate first poll + endpoint sync
  _pollCanonical(config).catch(() => {});
  _syncEndpoints(config).catch(() => {});

  _timer = setInterval(() => {
    _pollCanonical(config).catch(() => {});
    _syncEndpoints(config).catch(() => {});
  }, interval);
  _timer.unref();

  console.log(`[sync] HTTP polling started (interval: ${interval}ms)`);
}

async function _pollCanonical(config) {
  const base  = config.network.registryUrl;
  const start = Date.now();

  try {
    // Poll /health — free endpoint, always available, measures reachability
    const res  = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const lagMs = Date.now() - start;

    // Populate slotHeight from cached epoch data if available
    const epochCache = readCache('epoch');
    const slotHeight = epochCache?.data?.slot ?? null;

    syncStatus = {
      protocol:   'http',
      status:     lagMs < (config.sync?.maxLagMs ?? 30_000) ? 'synced' : 'lagging',
      lagMs,
      lastSyncAt: new Date().toISOString(),
      slotHeight,
    };

    // Cache the health response for dashboard display
    _writeCache('health', data);

  } catch (err) {
    syncStatus.status = 'disconnected';
    syncStatus.lagMs  = null;
    console.warn('[sync] Poll failed:', err.message);
  }
}

// ── Endpoint sync ─────────────────────────────────────────────────────────────

async function _syncEndpoints(config) {
  const base      = config.network.registryUrl;
  const myShards  = config.node?.shards ?? ['all'];

  _syncCycles++;

  for (const endpoint of SYNC_ENDPOINTS) {
    _syncStats.total++;

    // Skip if this node's shards don't include 'all' or this endpoint's shard
    if (!myShards.includes('all') && !myShards.includes(endpoint.shard)) {
      _syncStats.skipped++;
      continue;
    }

    // Skip if last fetch is still within TTL
    const lastFetch = _lastFetchAt[endpoint.cacheKey];
    if (lastFetch && (Date.now() - lastFetch) < endpoint.ttlMs) {
      _syncStats.hits++;
      continue;
    }

    // Fetch and cache
    try {
      await _fetchAndCache(base, endpoint);
      _syncStats.misses++;
    } catch (err) {
      _syncStats.errors++;
    }
  }

  // Log a summary every 10 full sync cycles
  if (_syncCycles % 10 === 0) {
    console.log(`[sync] Cache: ${_syncStats.hits} hits / ${_syncStats.total} endpoints`);
  }
}

async function _fetchAndCache(base, endpoint) {
  const res = await fetch(`${base}${endpoint.path}`, { signal: AbortSignal.timeout(10_000) });

  if (res.status === 402) {
    console.log(`[sync] ${endpoint.path} — x402 — CIRC payment required to sync this endpoint`);
    return;
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  _writeCache(endpoint.cacheKey, data);
  _lastFetchAt[endpoint.cacheKey] = Date.now();
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function _writeCache(key, data) {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    const tmp  = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ data, cachedAt: new Date().toISOString() }));
    fs.renameSync(tmp, file);
    _syncStats.writeErrors = 0;
  } catch (err) {
    // Don't swallow silently — a full disk / EACCES would otherwise let sync keep reporting
    // "synced" while persisting nothing. Throttle the log: first failure, then every 20th.
    _syncStats.writeErrors++;
    if (_syncStats.writeErrors === 1 || _syncStats.writeErrors % 20 === 0) {
      console.warn(`[sync] cache write failed for '${key}' (${_syncStats.writeErrors}×):`, err.message);
    }
  }
}

function _cleanStaleTmp() {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {} }
    }
  } catch {}
}

function readCache(key) {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function getSyncStatus() {
  return { ...syncStatus };
}

function getSyncStats() {
  return { ..._syncStats };
}

module.exports = { start, stop, readCache, getSyncStatus, getSyncStats };
