// lib/shard.js — Shard assignment and data scoping.
//
// Phase 1: All nodes report shards: ['all'] — every node mirrors everything.
//          Data scope is unlimited. No routing logic needed.
//
// Phase 2: Consistent-hash assignment from nodeId → specific shard slice.
//          Each node owns 3 of 8 shard types (replication factor 3).
//          The canonical node always serves all shards regardless.
//
// Shard types map to API endpoint categories:
//   CHAIN_METRICS    → /api/epoch, /api/network, /api/fees, /api/supply
//   TOKEN_ANALYTICS  → /api/token/:mint/*, /api/new-tokens, /api/scan
//   WALLET_ANALYTICS → /api/wallet/:address/*
//   POOL_DATA        → /api/pools, /api/pool/:address, /api/clmm-pools
//   ORACLE_PRICES    → /api/prices/*, /api/oracle/*
//   YIELD_DATA       → /api/farming, /api/staking/*, /api/lending/*
//   VALIDATOR_DATA   → /api/validators/*, /api/nodes
//   SWARM_DATA       → /api/swarm/*
'use strict';

const crypto = require('crypto');

const SHARD_TYPES = [
  'CHAIN_METRICS',
  'TOKEN_ANALYTICS',
  'WALLET_ANALYTICS',
  'POOL_DATA',
  'ORACLE_PRICES',
  'YIELD_DATA',
  'VALIDATOR_DATA',
  'SWARM_DATA',
];

// Endpoint prefix → shard type mapping
// Used by the lite server to decide if it can serve a request or must proxy
const ENDPOINT_SHARD_MAP = {
  '/api/epoch':       'CHAIN_METRICS',
  '/api/network':     'CHAIN_METRICS',
  '/api/fees':        'CHAIN_METRICS',
  '/api/supply':      'CHAIN_METRICS',
  '/api/inflation':   'CHAIN_METRICS',
  '/api/rent':        'CHAIN_METRICS',
  '/api/programs':    'CHAIN_METRICS',
  '/api/token':       'TOKEN_ANALYTICS',
  '/api/new-tokens':  'TOKEN_ANALYTICS',
  '/api/scan':        'TOKEN_ANALYTICS',
  '/api/wallet':      'WALLET_ANALYTICS',
  '/api/pools':       'POOL_DATA',
  '/api/pool':        'POOL_DATA',
  '/api/clmm-pools':  'POOL_DATA',
  '/api/whirlpools':  'POOL_DATA',
  '/api/prices':      'ORACLE_PRICES',
  '/api/oracle':      'ORACLE_PRICES',
  '/api/farming':     'YIELD_DATA',
  '/api/staking':     'YIELD_DATA',
  '/api/lending':     'YIELD_DATA',
  '/api/validators':  'VALIDATOR_DATA',
  '/api/nodes':       'VALIDATOR_DATA',
  '/api/swarm':       'SWARM_DATA',
};

// ── Assignment ────────────────────────────────────────────────────────────────

/**
 * Compute shard assignment for a nodeId.
 * Phase 1: always returns ['all'].
 * Phase 2: consistent hash → 3 assigned shards.
 *
 * @param {string} nodeId — base64 public key
 * @param {number} phase  — 1 or 2
 * @returns {string[]}
 */
function computeAssignment(nodeId, phase = 1) {
  if (phase === 1) return ['all'];

  const hash  = crypto.createHash('sha256').update(nodeId).digest();
  const index = hash.readUInt32BE(0) % SHARD_TYPES.length;

  // Assign 3 consecutive shards (replication factor 3)
  const assigned = [];
  for (let i = 0; i < 3; i++) {
    assigned.push(SHARD_TYPES[(index + i) % SHARD_TYPES.length]);
  }
  return assigned;
}

/**
 * Check whether this node can serve a given endpoint path.
 *
 * @param {string[]} myShards — this node's shard assignment
 * @param {string}   path     — request path (e.g. '/api/token/abc123/distribution')
 * @returns {boolean}
 */
function canServe(myShards, path) {
  // Full node serves everything
  if (myShards.includes('all')) return true;

  // Find which shard this path belongs to
  for (const [prefix, shard] of Object.entries(ENDPOINT_SHARD_MAP)) {
    if (path.startsWith(prefix)) {
      return myShards.includes(shard);
    }
  }

  // Unknown path — serve it anyway (conservative)
  return true;
}

/**
 * Find the best peer node to serve a given path.
 * Returns null if this node can serve it directly.
 *
 * @param {string[]} myShards — this node's shard assignment
 * @param {string}   path     — request path
 * @param {object[]} peers    — active peer nodes from registry
 * @returns {object|null}     — peer node record or null
 */
function findServingPeer(myShards, path, peers) {
  if (canServe(myShards, path)) return null;

  const targetShard = Object.entries(ENDPOINT_SHARD_MAP)
    .find(([prefix]) => path.startsWith(prefix))?.[1];

  if (!targetShard) return null;

  // Find an online peer that serves this shard. Guard p.shards — peer records come from the
  // registry (untrusted); one without a shards array would otherwise throw and take down the
  // /api request handler with an unhandled exception.
  const candidates = peers.filter(p =>
    p.status === 'online' &&
    p.apiPort &&
    Array.isArray(p.shards) &&
    (p.shards.includes('all') || p.shards.includes(targetShard))
  );

  if (candidates.length === 0) return null;

  // Pick randomly among candidates (simple load distribution)
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = {
  SHARD_TYPES,
  ENDPOINT_SHARD_MAP,
  computeAssignment,
  canServe,
  findServingPeer,
};
