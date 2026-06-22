#!/usr/bin/env node
// gpu-node.js — Circuit GPU node entrypoint (the node-client's COMPUTE role).
//
// This is what a GPU operator runs. It detects the GPU, then joins the coordinator's
// mesh through the engine worker it supervises (lib/llm-worker.js → deploy/run-mesh.sh),
// which self-provisions the model, gets assigned a layer slice, and serves. The
// operator sets only a couple of env vars — no SSH, no manual wiring:
//
//   CIRCUIT_CONTROL_URL   coordinator control endpoint, e.g. http://1.2.3.4:18932  (required)
//   CIRCUIT_ENGINE_DIR    where the engine is baked (default /opt/circuit-engine)
//   CIRCUIT_PAYOUT_WALLET wallet earnings settle to (optional; Phase 3+)
//
// On RunPod the node self-discovers its public address; on a home/bare box set
// CIRCUIT_ADVERTISE_HOST/PORT. This is the lean compute path — the wallet/stake/
// dashboard layers of the node-client come later; joining + serving needs only this.
'use strict';

const llmWorker = require('./lib/llm-worker');

const control = process.env.CIRCUIT_CONTROL_URL;
if (!control) {
  console.error('[circuit-gpu-node] CIRCUIT_CONTROL_URL is required (the coordinator control endpoint, http://host:18932)');
  process.exit(1);
}

console.log('');
console.log('╔════════════════════════════════════════╗');
console.log('║        CIRCUIT GPU NODE                 ║');
console.log('║   joining the distributed-LLM mesh      ║');
console.log('╚════════════════════════════════════════╝');
console.log(`[circuit-gpu-node] coordinator: ${control}`);
console.log(`[circuit-gpu-node] GPU present: ${llmWorker.hasGpu()}`);

llmWorker.start({
  enabled:    true,
  engineDir:  process.env.CIRCUIT_ENGINE_DIR || '/opt/circuit-engine',
  runScript:  process.env.CIRCUIT_RUN_SCRIPT || 'deploy/run-mesh.sh',
  payoutWallet: process.env.CIRCUIT_PAYOUT_WALLET || '',
  requireGpu: true,
});

const statusEvery = setInterval(() => {
  console.log('[circuit-gpu-node] status:', JSON.stringify(llmWorker.status()));
}, 30_000);

function shutdown(sig) {
  console.log(`[circuit-gpu-node] ${sig} — stopping worker`);
  clearInterval(statusEvery);
  llmWorker.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
