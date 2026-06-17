// worker.js — Circuit LLM worker process.
//
// Runs on circuit-node-client machines. Connects to the coordinator,
// receives a layer assignment, and handles the TCP tensor forward-pass
// server for pipeline-parallel inference.
//
// Usage:
//   node worker.js                        # Start worker (config from worker.json)
//   node worker.js --coordinator <host>   # Override coordinator host
//   node worker.js --port <n>             # Override TCP listen port
//   node worker.js status                 # Print current worker status
//
// This file is standalone — copy it to any circuit-node-client installation
// to join the LLM pipeline without any other files from this repo.
'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');
const https = require('https');

// Worker-embedded logger (no dep on lib/ so this file is self-contained)
function log(level, msg, data) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  process.stdout.write(line + '\n');
}

const argv = process.argv.slice(2);
const CMD  = argv[0];

// ── Status command ─────────────────────────────────────────────────────────────
if (CMD === 'status') {
  const stateFile = path.join(__dirname, 'data', 'worker_state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    console.log(JSON.stringify(state, null, 2));
  } catch {
    console.log('No worker state found — worker may not be running');
  }
  process.exit(0);
}

// ── Load config ────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config', 'worker.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {}

// CLI overrides
const coordIdx = argv.indexOf('--coordinator');
const portIdx  = argv.indexOf('--port');
const keyIdx   = argv.indexOf('--key');

const workerPort      = portIdx  >= 0 ? parseInt(argv[portIdx  + 1] ?? '', 10) || 19210 : parseInt(cfg.port        ?? process.env.WORKER_PORT       ?? '19210', 10);
const coordinatorHost = coordIdx >= 0 ? (argv[coordIdx + 1] ?? '')                      : (cfg.coordinator ?? process.env.COORDINATOR_HOST ?? 'localhost');
const clusterKey      = keyIdx   >= 0 ? (argv[keyIdx   + 1] ?? '')                      : (cfg.clusterKey  ?? process.env.CLUSTER_KEY ?? '');

// ── Inline worker server (self-contained copy of pipeline/worker-server.js) ──
// Including it inline avoids requiring the node-client to install this package.

const net    = require('net');
const crypto = require('crypto');

// Qwen2 forward pass (loaded lazily after shard is available)
let Qwen2Worker = null;
try { ({ Qwen2Worker } = require('./lib/inference/qwen2-worker')); } catch {}

// Wire protocol constants (matches lib/pipeline/wire.js)
const MAGIC      = 0xC1CC0001;
const HEADER_LEN = 24;

const MSG = {
  PING:         0x01,
  PONG:         0x02,
  LAYER_ASSIGN: 0x10,
  LAYER_ACK:    0x11,
  TENSOR_FWD:   0x20,
  TENSOR_RET:   0x21,
  AUTH_CHALLENGE: 0x05,
  ERROR:        0xFF,
};

function djb2(buf) {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) >>> 0;
  return h;
}

function encode(msgType, payload, seqId = 0, sessionId = 0) {
  const h = Buffer.allocUnsafe(HEADER_LEN);
  h.writeUInt32LE(MAGIC,           0);
  h.writeUInt32LE(msgType,         4);
  h.writeUInt32LE(seqId,           8);
  h.writeUInt32LE(sessionId,      12);
  h.writeUInt32LE(payload.length, 16);
  h.writeUInt32LE(djb2(payload),  20);
  return Buffer.concat([h, payload]);
}

function encodePong(seqId) {
  return encode(MSG.PONG, Buffer.alloc(0), seqId);
}

function encodeLayerAck(seqId, sessionId) {
  return encode(MSG.LAYER_ACK, Buffer.alloc(0), seqId, sessionId);
}

function encodeTensorRet(data, shape, dtype, seqId, sessionId) {
  const ndim = shape.length;
  const payload = Buffer.allocUnsafe(4 + 4 + 4 * ndim + data.length);
  let off = 0;
  payload.writeUInt32LE(dtype, off); off += 4;
  payload.writeUInt32LE(ndim,  off); off += 4;
  for (const d of shape) { payload.writeUInt32LE(d, off); off += 4; }
  data.copy(payload, off);
  return encode(MSG.TENSOR_RET, payload, seqId, sessionId);
}

function decodeTensor(payload) {
  let off = 0;
  const dtype = payload.readUInt32LE(off); off += 4;
  const ndim  = payload.readUInt32LE(off); off += 4;
  const shape = [];
  for (let i = 0; i < ndim; i++) { shape.push(payload.readUInt32LE(off)); off += 4; }
  return { dtype, shape, data: payload.slice(off) };
}

class FrameParser {
  constructor(cb) { this._cb = cb; this._buf = Buffer.alloc(0); }
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= HEADER_LEN) {
      if (this._buf.readUInt32LE(0) !== MAGIC) {
        const idx = this._buf.indexOf(Buffer.from([0x01, 0x00, 0xCC, 0xC1]));
        if (idx < 0) { this._buf = Buffer.alloc(0); return; }
        this._buf = this._buf.slice(idx);
        continue;
      }
      const payLen = this._buf.readUInt32LE(16);
      const total  = HEADER_LEN + payLen;
      if (this._buf.length < total) break;
      const msgType   = this._buf.readUInt32LE(4);
      const seqId     = this._buf.readUInt32LE(8);
      const sessionId = this._buf.readUInt32LE(12);
      const csum      = this._buf.readUInt32LE(20);
      const payload   = this._buf.slice(HEADER_LEN, total);
      this._buf = this._buf.slice(total);
      if (djb2(payload) !== csum) continue; // drop corrupt frame
      try { this._cb({ msgType, seqId, sessionId, payload }); } catch {}
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let _identity    = null; // loaded from disk or generated; used by shard cache + registration
let _assignment  = null;
let _server      = null;
let _seqId       = 0;
let _qwen2       = null; // Qwen2Worker instance, created when both shard+assignment are ready
const stateFile  = path.join(__dirname, 'data', 'worker_state.json');
const PEER_RANGE = 1000; // ms between state writes

// Initialise Qwen2Worker once we have both the shard tensors and the layer assignment.
// Derives actual layer range from tensor names in the shard (robust against re-assignment drift).
function _tryInitQwen2() {
  if (_qwen2 || !Qwen2Worker || !_shardTensors) return;
  const a = (_assignment && _assignment.arch) ? _assignment.arch : {};

  // Determine actual layer range from shard tensor names
  const blkLayers = _shardTensors
    .map(t => { const m = (t.name ?? '').match(/^blk\.(\d+)\./); return m ? parseInt(m[1]) : -1; })
    .filter(n => n >= 0);
  if (blkLayers.length === 0) return; // no block tensors yet

  const shardStart = Math.min(...blkLayers);
  const shardEnd   = Math.max(...blkLayers);

  try {
    _qwen2 = new Qwen2Worker(_shardTensors, {
      hiddenDim:    a.hiddenSize  ?? 896,
      numHeads:     a.numHeads    ?? 14,
      numKvHeads:   a.numKvHeads  ?? 2,
      ffnDim:       a.ffnDim      ?? 4864,
      rmsEps:       a.rmsEps      ?? 1e-6,
      ropeFreqBase: a.ropeFreqBase ?? 1000000,
      layerStart:   shardStart,
      layerEnd:     shardEnd,
      maxSeqLen:    4096,
    });
    log('INFO', 'worker: Qwen2Worker ready', { layers: `${shardStart}-${shardEnd}` });
  } catch (err) {
    log('WARN', 'worker: Qwen2Worker init failed', { error: err.message });
  }
}

function _saveState() {
  const state = {
    running:    true,
    port:       workerPort,
    assignment: _assignment,
    ramMb:      Math.floor(os.freemem() / (1024 * 1024)),
    uptimeSec:  Math.floor(process.uptime()),
    updatedAt:  new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(stateFile + '.tmp', stateFile);
  } catch {}
}

setInterval(_saveState, PEER_RANGE).unref();

// ── Shard weight cache ────────────────────────────────────────────────────────
const SHARD_CACHE_DIR = path.join(__dirname, 'data', 'shard_cache');
fs.mkdirSync(SHARD_CACHE_DIR, { recursive: true });

let _shardLoaded  = false;
let _shardTensors = null; // Array of { name, ggmlType, dimensions, data } when loaded

function _shardCachePath() {
  const id = _identity?.nodeId?.slice(0, 12) ?? 'unknown';
  return path.join(SHARD_CACHE_DIR, `shard-${id}-p${workerPort}.bin`);
}

function _loadCachedShard() {
  const cachePath = _shardCachePath();
  if (!fs.existsSync(cachePath)) return false;
  try {
    const buf = fs.readFileSync(cachePath);
    _shardTensors = _parseShard(buf);
    _shardLoaded  = true;
    _tryInitQwen2();
    log('INFO', 'worker: shard loaded from cache', {
      tensors: _shardTensors.length,
      bytes:   buf.length,
      path:    cachePath,
    });
    return true;
  } catch (err) {
    log('WARN', 'worker: cached shard corrupt, ignoring', { error: err.message });
    return false;
  }
}

// Inline shard parser (mirrors gguf-extractor parseShard)
function _parseShard(buf) {
  const numTensors = buf.readUInt32LE(0);
  let   off        = 4;
  const tensors    = [];
  for (let i = 0; i < numTensors; i++) {
    const nameLen  = buf.readUInt16LE(off);                     off += 2;
    const name     = buf.slice(off, off + nameLen).toString();  off += nameLen;
    const ggmlType = buf.readUInt32LE(off);                     off += 4;
    const ndim     = buf.readUInt32LE(off);                     off += 4;
    const dims     = [];
    for (let d = 0; d < ndim; d++) { dims.push(buf.readUInt32LE(off)); off += 4; }
    const dataLen  = buf.readUInt32LE(off);                     off += 4;
    const data     = buf.slice(off, off + dataLen);             off += dataLen;
    tensors.push({ name, ggmlType, dimensions: dims, data });
  }
  return tensors;
}

// ── HTTP server for weight streaming ─────────────────────────────────────────
// Listens at workerPort + 1000 for shard delivery from the coordinator.
// This is separate from the TCP tensor pipeline server.
const httpWorkerPort = workerPort + 1000;
const httpServer     = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/weights') {
    // Require cluster key if one is configured
    if (clusterKey) {
      const provided = req.headers['x-cluster-key'] ?? '';
      if (provided !== clusterKey) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid cluster key' }));
        return;
      }
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body     = Buffer.concat(chunks);
        // 4-byte LE length prefix + JSON metadata + shard
        const metaLen  = body.readUInt32LE(0);
        const metaStr  = body.slice(4, 4 + metaLen).toString('utf8');
        const meta     = JSON.parse(metaStr);
        const shardBuf = body.slice(4 + metaLen);

        const parsed = _parseShard(shardBuf);
        _shardTensors = parsed;
        _shardLoaded  = true;
        _tryInitQwen2();

        // Cache to disk
        try {
          fs.writeFileSync(_shardCachePath(), shardBuf);
        } catch (err) {
          log('WARN', 'worker: shard cache write failed', { error: err.message });
        }

        // Update state with confirmed assignment
        if (meta.layerStart !== undefined) {
          _assignment = {
            layerStart:  meta.layerStart,
            layerEnd:    meta.layerEnd,
            totalLayers: meta.totalLayers ?? 24,
          };
          _saveState();
        }

        log('INFO', 'worker: shard received', {
          tensors:    _shardTensors.length,
          bytes:      shardBuf.length,
          layers:     `${meta.layerStart}–${meta.layerEnd}`,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tensors: _shardTensors.length }));
      } catch (err) {
        log('ERROR', 'worker: shard parse failed', { error: err.message });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    if (clusterKey) {
      const provided = req.headers['x-cluster-key'] ?? '';
      if (provided !== clusterKey) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid cluster key' }));
        return;
      }
    }
    // Compute actual layer range from shard tensor names
    const blkLayers = (_shardTensors ?? [])
      .map(t => { const m = (t.name ?? '').match(/^blk\.(\d+)\./); return m ? parseInt(m[1]) : -1; })
      .filter(n => n >= 0);
    const shardLayerStart = blkLayers.length ? Math.min(...blkLayers) : -1;
    const shardLayerEnd   = blkLayers.length ? Math.max(...blkLayers) : -1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      nodeId:          _identity?.nodeId ?? 'unknown',
      workerPort,
      assignment:      _assignment,
      shardLoaded:     _shardLoaded,
      shardTensors:    _shardTensors?.length ?? 0,
      shardLayerStart,
      shardLayerEnd,
      qwen2Active:     _qwen2 !== null,
      ramMb:           Math.floor(os.freemem() / (1024 * 1024)),
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(httpWorkerPort, '0.0.0.0', () => {
  log('INFO', 'worker: HTTP server ready', { port: httpWorkerPort });
});

// ── Start TCP listener ─────────────────────────────────────────────────────────
log('INFO', 'worker: starting TCP server', { port: workerPort });

_server = net.createServer(handleCoordinator);
_server.listen(workerPort, '0.0.0.0', () => {
  log('INFO', 'worker: ready for coordinator', { port: workerPort });
});
_server.on('error', err => log('ERROR', 'worker: server error', { error: err.message }));

// ── Handle coordinator connection ─────────────────────────────────────────────
function handleCoordinator(socket) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  log('INFO', 'worker: coordinator connected', { remote });
  socket.setKeepAlive(true, 5000);

  let state = 'auth';

  const parser = new FrameParser(({ msgType, seqId, sessionId, payload }) => {
    // Auth challenge
    if (msgType === MSG.AUTH_CHALLENGE && state === 'auth') {
      try {
        const { nonce } = JSON.parse(payload.toString('utf8'));
        const hmac = clusterKey
          ? crypto.createHmac('sha256', clusterKey).update(nonce).digest('hex')
          : '';
        const ramMb = Math.floor(os.freemem() / (1024 * 1024));
        const resp  = Buffer.from(JSON.stringify({ hmac, ramMb }), 'utf8');
        socket.write(encode(MSG.LAYER_ACK, resp, ++_seqId));
        state = 'assigned';
      } catch (err) {
        log('WARN', 'worker: auth parse failed', { error: err.message });
        socket.destroy();
      }
      return;
    }

    // Layer assignment
    if (msgType === MSG.LAYER_ASSIGN && state === 'assigned') {
      try {
        _assignment = JSON.parse(payload.toString('utf8'));
        log('INFO', 'worker: layers assigned', {
          start: _assignment.layerStart,
          end:   _assignment.layerEnd,
          total: _assignment.totalLayers,
        });
        _tryInitQwen2();
        socket.write(encodeLayerAck(++_seqId, sessionId));
        state = 'ready';
        _saveState();
      } catch (err) {
        log('WARN', 'worker: assignment parse failed', { error: err.message });
      }
      return;
    }

    // Ping
    if (msgType === MSG.PING) {
      socket.write(encodePong(seqId));
      return;
    }

    // Tensor forward pass
    if (msgType === MSG.TENSOR_FWD && state === 'ready') {
      // First 4 bytes = position index (LE uint32)
      const pos = payload.readUInt32LE(0);
      const { dtype, shape, data } = decodeTensor(payload.slice(4));
      log('DEBUG', 'worker: tensor received', { shape, pos, bytes: data.length, sessionId });

      if (_qwen2) {
        try {
          const hidden = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
          const result = _qwen2.forward(hidden, pos);
          const retBuf = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
          socket.write(encodeTensorRet(retBuf, shape, 0 /* f32 */, seqId, sessionId));
        } catch (err) {
          log('WARN', 'worker: forward pass error', { error: err.message });
          socket.write(encodeTensorRet(data, shape, dtype, seqId, sessionId));
        }
      } else {
        // Fallback: passthrough until Qwen2Worker is ready
        socket.write(encodeTensorRet(data, shape, dtype, seqId, sessionId));
      }
      return;
    }
  });

  socket.on('data', chunk => parser.push(chunk));
  socket.on('error', err => log('WARN', 'worker: socket error', { error: err.message }));
  socket.on('close', () => {
    log('INFO', 'worker: coordinator disconnected');
    _assignment = null;
    state       = 'auth';
    _saveState();
  });
}

// ── Registration ───────────────────────────────────────────────────────────────
// Workers register with BOTH:
//   1. The coordinator's /v1/workers/register (primary — direct HTTP registry)
//   2. The Circuit bootstrap server (secondary — public mesh discovery)

const COORDINATOR_API = cfg.coordinatorApi
  ?? process.env.COORDINATOR_API
  ?? `http://${coordinatorHost}:${parseInt(process.env.LLM_PORT ?? cfg.llmPort ?? '19200', 10)}`;
const BOOTSTRAP       = cfg.bootstrapUrl ?? process.env.BOOTSTRAP_URL ?? 'http://node.circuitllm.xyz:18500';
// Each worker gets its own identity keyed to its port so multiple workers on
// the same machine have distinct nodeIds (and appear as separate entries in
// the registry). Workers on different machines use the machine's shared identity.
const IDENTITY_FILE   = path.join(__dirname, 'data', `identity-worker-${workerPort}.json`);

// Wallet address (optional — from config or environment)
const WALLET_ADDRESS  = cfg.walletAddress ?? process.env.SOLANA_WALLET_ADDRESS ?? null;

// Load or generate identity
try {
  _identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
} catch {
  // Generate a new identity for this worker
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  _identity = {
    nodeId:        publicKey.toString('base64'),
    publicKeyB64:  publicKey.toString('base64'),
    privateKeyB64: privateKey.toString('base64'),
    createdAt:     new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(_identity, null, 2), { mode: 0o600 });
  } catch {}
}

// ── Register with coordinator HTTP registry ───────────────────────────────────
function _registerWithCoordinator() {
  const body = JSON.stringify({
    nodeId:        _identity.nodeId,
    host:          coordinatorHost === 'localhost' ? '127.0.0.1' : os.hostname(),
    workerPort,
    walletAddress: WALLET_ADDRESS,
    ramMb:         Math.floor(os.freemem() / (1024 * 1024)),
    gpuVramMb:     0,
    region:        cfg.region ?? 'us-east',
    capabilities:  ['llm-worker'],
  });

  _httpPost(COORDINATOR_API + '/v1/workers/register', body, res => {
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      log('INFO', 'worker: registered with coordinator', {
        layers:  data.worker?.layerStart >= 0
          ? `${data.worker.layerStart}–${data.worker.layerEnd}`
          : 'pending',
        message: data.message,
      });
      // Update state with layer assignment from coordinator
      if (data.worker?.layerStart >= 0) {
        _assignment = {
          layerStart:  data.worker.layerStart,
          layerEnd:    data.worker.layerEnd,
          totalLayers: data.layerCount,
        };
        _saveState();
      }
    } else {
      log('DEBUG', 'worker: coordinator register failed', { status: res.status });
    }
  });
}

// ── Heartbeat to coordinator ──────────────────────────────────────────────────
function _heartbeatCoordinator() {
  const body = JSON.stringify({
    nodeId: _identity.nodeId,
    ramMb:  Math.floor(os.freemem() / (1024 * 1024)),
  });
  _httpPost(COORDINATOR_API + '/v1/workers/heartbeat', body, () => {});
}

// ── Announce to bootstrap (secondary discovery) ───────────────────────────────
function _announceBootstrap() {
  const host = cfg.host ?? process.env.NODE_HOST ?? null;
  if (!host) {
    // Bootstrap requires host — skip until nodeAddress is configured
    return;
  }
  const body = JSON.stringify({
    nodeId:       _identity.nodeId,
    version:      '0.1.0',
    region:       cfg.region ?? 'us-east',
    capabilities: ['llm-worker'],
    workerPort,
    host,
    port:         parseInt(process.env.NODE_API_PORT ?? cfg.apiPort ?? '19000', 10),
    ramMb:        Math.floor(os.freemem() / (1024 * 1024)),
    timestamp:    Date.now(),
  });

  const parsed  = new URL(BOOTSTRAP);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port:     parsed.port,
    path:     '/nodes/announce',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  const req = lib.request(options, res => {
    log('DEBUG', 'worker: bootstrap announced', { status: res.statusCode });
  });
  req.on('error', () => {});
  req.setTimeout(5000, () => req.destroy());
  req.write(body);
  req.end();
}

// ── Generic HTTP POST helper ──────────────────────────────────────────────────
function _httpPost(url, body, cb, extraHeaders = {}) {
  try {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders };
    if (clusterKey) headers['X-Cluster-Key'] = clusterKey;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => cb({ status: res.statusCode, body: data }));
    });
    req.on('error', () => cb({ status: 0, body: '' }));
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
  } catch { cb({ status: 0, body: '' }); }
}

// ── Load cached shard from previous run (requires _identity to be set) ────────
_loadCachedShard();

// ── Start registration loops ──────────────────────────────────────────────────
// Initial attempt — coordinator may still be loading the model, so retry once
// after 10s in case the first attempt is refused.
_registerWithCoordinator();
_announceBootstrap();
setTimeout(_registerWithCoordinator, 10_000);

// Coordinator heartbeat every 30s; bootstrap every 60s
setInterval(_heartbeatCoordinator, 30_000).unref();
setInterval(_announceBootstrap,     60_000).unref();
// Re-register every 5min in case coordinator restarted
setInterval(_registerWithCoordinator, 5 * 60_000).unref();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  log('INFO', 'worker: shutting down');
  if (_server) _server.close();
  if (httpServer) httpServer.close();
  // Deregister from coordinator
  const body = JSON.stringify({ nodeId: _identity?.nodeId });
  _httpPost(COORDINATOR_API + '/v1/workers/deregister', body, () => {});
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ running: false }), 'utf8');
  } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
