// lib/agent.js — Local node agent.
//
// When config.node.agentEnabled = true, this module starts a lightweight
// monitoring loop that runs on the same machine as the node.
//
// The agent has free access to the local API (localhost bypass) and uses
// cached data — no x402 payments needed.
//
// Current capabilities (Phase 1):
//   - Monitors local cache freshness + sync status
//   - Logs network health snapshots
//   - Reports agent heartbeat to registry via node's /health endpoint
//
// Future capabilities:
//   - Trading: scan → score → buy/sell via Jupiter Ultra
//   - Swarm: publish signals + consensus votes
//   - Tasks: claim + submit work from /api/swarm/tasks
'use strict';

const AGENT_INTERVAL_MS = 60_000; // 1 minute

let _config  = null;
let _timer   = null;
let _apiBase = null;
let _cycles  = 0;

async function start(config) {
  _config  = config;
  _apiBase = `http://localhost:${config.node?.apiPort ?? 19000}`;

  console.log('[agent] Starting local agent loop');
  console.log(`[agent] Local API: ${_apiBase}`);
  console.log(`[agent] Cycle interval: ${AGENT_INTERVAL_MS / 1000}s`);

  // Run immediately then on interval
  await _cycle().catch(err => console.warn('[agent] Cycle error:', err.message));

  _timer = setInterval(async () => {
    await _cycle().catch(err => console.warn('[agent] Cycle error:', err.message));
  }, AGENT_INTERVAL_MS);

  _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  console.log('[agent] Stopped');
}

async function _cycle() {
  _cycles++;
  const start = Date.now();

  try {
    // 1. Check local node health
    const health = await _get('/health');
    const sync   = health?.sync ?? {};

    // 2. Log snapshot every 5 cycles
    if (_cycles % 5 === 1) {
      console.log(`[agent] Cycle ${_cycles} — sync:${sync.status ?? '?'} lag:${sync.lagMs ?? '?'}ms uptime:${Math.round(health?.uptime ?? 0)}s`);
    }

    // 3. Pull market regime from cache (free via local API)
    const regime = await _get('/api/market-regime').catch(() => null);
    if (regime?.regime && _cycles % 5 === 1) {
      console.log(`[agent] Market: ${regime.regime} | SOL $${regime.solPrice?.toFixed(2) ?? '?'}`);
    }

    // 4. Future hooks (uncomment + implement when ready):
    // await _tradingCycle(health, regime);
    // await _swarmCycle();
    // await _taskCycle();

  } catch (err) {
    console.warn('[agent] _cycle failed:', err.message);
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function _get(path) {
  const res = await fetch(`${_apiBase}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

module.exports = { start, stop };
