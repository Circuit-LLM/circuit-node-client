// lib/circuit-agent.js — Reads state from a co-located circuit-agent process.
//
// The circuit-agent is a separate trading bot that can be paired with this node
// by setting agentDataPath in config. The node serves it (free local API access,
// chat interface) but does not own or control it.
//
// This is the single module that knows how to read agent data files.
// server.js, chat.js, and lib/agent.js all import from here — no duplication.
//
// Expected file layout (relative to agentDataPath):
//   agent.pid                — PID written by circuit-agent on startup
//   agent-identity.json      — { agentId, address }
//   positions.json           — { [mint]: positionRecord }
//   trade_history.json       — tradeRecord[]
//   session_strategy.json    — { mode, goal, reasoning, expiresAt, ... }
//   agent-notes.json         — noteRecord[]  (learned patterns)
//   conversation_summary.md  — rolling LLM session summary
//
// Config layout (relative to agentDataPath/../config/):
//   agent.json               — base config
//   agent.local.json         — local overrides (merged on top, optional)
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Process state ─────────────────────────────────────────────────────────────

/**
 * Check whether the circuit-agent process is alive via its PID file.
 * Cheap: one file read + kill(pid, 0).
 *
 * @param {string} dataPath — absolute path to agent data directory
 * @returns {boolean}
 */
function isAlive(dataPath) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(dataPath, 'agent.pid'), 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0); // throws ESRCH if process is gone
    return true;
  } catch {
    return false;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Read and merge agent.json + agent.local.json.
 * Local overrides base — same pattern as circuit-node-client's own config.
 *
 * @param {string} dataPath — absolute path to agent data directory
 * @returns {object|null}   — merged config, or null if base config is missing
 */
function readConfig(dataPath) {
  const root = path.join(dataPath, '..');
  try {
    const base  = JSON.parse(fs.readFileSync(path.join(root, 'config', 'agent.json'),  'utf8'));
    let   local = {};
    try { local = JSON.parse(fs.readFileSync(path.join(root, 'config', 'agent.local.json'), 'utf8')); } catch {}
    return _deepMerge(base, local);
  } catch {
    return null;
  }
}

// ── Data files ────────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file from the agent data directory.
 * Returns null on any error (missing, malformed, permissions).
 *
 * @param {string} dataPath
 * @param {string} file — filename relative to dataPath
 * @returns {*|null}
 */
function readJson(dataPath, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dataPath, file), 'utf8')); } catch { return null; }
}

/**
 * Read a text file from the agent data directory.
 * Returns null on any error.
 *
 * @param {string} dataPath
 * @param {string} file — filename relative to dataPath
 * @returns {string|null}
 */
function readText(dataPath, file) {
  try { return fs.readFileSync(path.join(dataPath, file), 'utf8'); } catch { return null; }
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Build the full agent status object used by /agent/status and the dashboard.
 * Reads positions, trade history, and identity files.
 *
 * @param {string} dataPath — absolute path to agent data directory
 * @returns {object}
 */
function getStatus(dataPath) {
  const identity  = readJson(dataPath, 'agent-identity.json');
  const positions = readJson(dataPath, 'positions.json') ?? {};
  const history   = readJson(dataPath, 'trade_history.json') ?? [];

  const openPositions = Object.values(positions);
  // unrealizedPnlSol is only present if watcher enriches positions.json
  const pnlSol = openPositions.reduce((sum, p) => sum + (p.unrealizedPnlSol ?? 0), 0);
  const recent = Array.isArray(history) ? history.slice(-10).reverse() : [];

  return {
    alive:         isAlive(dataPath),
    agentId:       identity?.agentId ?? null,
    address:       identity?.address ?? null,
    openPositions: openPositions.length,
    pnlSol:        parseFloat(pnlSol.toFixed(4)),
    positions: openPositions.map(p => ({
      mint:       p.mint,
      symbol:     p.symbol     ?? '?',
      entryPrice: p.entryPrice ?? null,
      entryTime:  p.entryTime  ?? null,
      pnlPct:     p.pnlPct     ?? null,
    })),
    recentTrades: recent.map(t => ({
      ts:     t.exitTime ?? t.closedAt ?? t.entryTime ?? null,
      symbol: t.symbol ?? '?',
      side:   t.exitTime ? 'sell' : (t.side ?? 'buy'),
      pnlSol: t.pnlSol ?? null,
    })),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _deepMerge(base, override) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = _deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { isAlive, readConfig, readJson, readText, getStatus };
