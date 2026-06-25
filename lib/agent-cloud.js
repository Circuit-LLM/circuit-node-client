// lib/agent-cloud.js — reads this node's contribution to the Circuit agent cloud
// (CPU hosting). Two sources, both optional and degrade-gracefully:
//
//   1. The co-located node-host's local snapshot (`<hostDir>/status.json`, written
//      every heartbeat). Tells us whether this machine is hosting agents and which
//      ones — works with no network.
//   2. The cloud control plane (if its URL is known) for the cloud-wide view and
//      the authoritative per-agent state.
//
// The node-host (circuit-agent-cloud) holds every agent's signing key OFF-BOX in
// the signer; this node only ever runs the agents' compute. So this is read-only,
// display-only: nothing here can move funds.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FRESH_MS = 30_000; // a status.json older than this → the node-host is down

function _cfg(config) {
  const ac = config.agentCloud || config.node?.agentCloud || {};
  return {
    hostDir:      ac.hostDir      || path.join(os.homedir(), '.circuit-host'),
    controlPlane: ac.controlPlane || process.env.CIRCUIT_CONTROL_PLANE || null,
    cloudKey:     ac.cloudKey     || process.env.CIRCUIT_CLOUD_KEY     || null,
  };
}

function _readSnapshot(hostDir) {
  try { return JSON.parse(fs.readFileSync(path.join(hostDir, 'status.json'), 'utf8')); } catch { return null; }
}

async function _cp(url, p, key) {
  const r = await fetch(url.replace(/\/$/, '') + p, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal:  AbortSignal.timeout(6_000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function _agentFromHealth(a) {
  const h = a.health || {};
  return {
    id: a.id, name: a.name, workload: a.workload,
    state:   h.state ?? 'running',
    pnlPct:  h.pnlPct ?? null,
    scans:   h.scans ?? null,
    uptimeS: h.uptimeS ?? null,
    custody: h.custody ?? null,
    address: h.address ?? null,
    source:  'local',
  };
}

async function getStatus(config) {
  const cfg   = _cfg(config);
  const snap  = _readSnapshot(cfg.hostDir);
  const fresh = !!(snap && Date.now() - (snap.updatedAt || 0) < FRESH_MS);

  const hosting = {
    running:      fresh,
    nodeId:       snap?.nodeId ?? null,
    controlPlane: snap?.controlPlane ?? cfg.controlPlane,
    budget:       snap?.budget ?? null,
    agentCount:   fresh ? (snap.agents?.length ?? 0) : 0,
    updatedAt:    snap?.updatedAt ?? null,
  };

  let agents = fresh ? (snap.agents || []).map(_agentFromHealth) : [];

  // Cloud-wide view + authoritative per-node agent state (best-effort).
  let cloud = null;
  const cpUrl = hosting.controlPlane;
  if (cpUrl) {
    try {
      const [nodes, ags] = await Promise.all([
        _cp(cpUrl, '/v1/nodes',  cfg.cloudKey).then(r => r.nodes  || []),
        _cp(cpUrl, '/v1/agents', cfg.cloudKey).then(r => r.agents || []),
      ]);
      cloud = {
        reachable:     true,
        url:           cpUrl,
        nodes:         nodes.length,
        nodesUp:       nodes.filter(n => n.status === 'up').length,
        agents:        ags.length,
        agentsRunning: ags.filter(a => a.state === 'running').length,
      };
      // Enrich with the control plane's authoritative state for THIS node's agents,
      // but only when it actually has them — otherwise keep the local snapshot
      // (ground truth for what's running here) so a CP lag can't blank the list.
      if (hosting.nodeId) {
        const mine = ags.filter(a => a.nodeId === hosting.nodeId);
        if (mine.length) {
          agents = mine.map(a => ({
            id: a.id, name: a.name, workload: a.spec?.workload,
            state:   a.state,
            pnlPct:  a.health?.pnlPct ?? null,
            scans:   a.health?.scans ?? null,
            uptimeS: a.health?.uptimeS ?? null,
            custody: a.health?.custody ?? null,
            address: a.address ?? a.health?.address ?? null,
            source:  'control-plane',
          }));
          hosting.agentCount = mine.length;
        }
      }
    } catch (err) {
      cloud = { reachable: false, url: cpUrl, error: err.message };
    }
  }

  return { configured: !!(snap || cpUrl), hosting, agents, cloud };
}

module.exports = { getStatus };
