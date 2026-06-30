// lib/identity.js — Node keypair identity.
//
// Each node has a persistent ed25519 keypair. The public key IS the nodeId.
// The private key never leaves this machine. All outbound requests to the
// registry are signed with this key so the server can verify authenticity.
//
// Key storage: data/identity.json (chmod 600, never commit)
// First run: generates a new keypair automatically.
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const IDENTITY_FILE = path.join(__dirname, '..', 'data', 'identity.json');

let _identity = null;

// ── Key generation ────────────────────────────────────────────────────────────

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKeyB64:  publicKey.toString('base64'),
    privateKeyB64: privateKey.toString('base64'),
  };
}

// ── Load or create identity ───────────────────────────────────────────────────

function loadIdentity() {
  if (_identity) return _identity;

  const dir = path.dirname(IDENTITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
      _identity = JSON.parse(raw);
      console.log(`[identity] Loaded node ID: ${_identity.nodeId.slice(0, 16)}…`);
      return _identity;
    } catch (err) {
      console.error('[identity] Failed to load identity file — regenerating', err.message);
    }
  }

  // Generate new identity
  const { publicKeyB64, privateKeyB64 } = generateKeypair();
  _identity = {
    nodeId:         publicKeyB64,  // public key = identity
    publicKeyB64,
    privateKeyB64,
    createdAt:      new Date().toISOString(),
  };

  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(_identity, null, 2), { mode: 0o600 });
  console.log(`[identity] Generated new node ID: ${_identity.nodeId.slice(0, 16)}…`);
  console.log(`[identity] Identity saved to ${IDENTITY_FILE}`);
  return _identity;
}

// ── Request signing ───────────────────────────────────────────────────────────

/**
 * Sign a request body and return auth headers.
 * Include these headers on all mutating requests to the registry.
 *
 * @param {object} body — request body (will be signed)
 * @returns {object} headers — { 'X-Node-Id', 'X-Node-Signature', 'X-Node-Timestamp' }
 */
function signRequest(body) {
  const identity  = loadIdentity();
  const timestamp = Date.now();
  const payload   = canonicalPayload(identity.nodeId, timestamp, body);

  const privKeyDer = Buffer.from(identity.privateKeyB64, 'base64');
  const privKey    = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
  const signature  = crypto.sign(null, Buffer.from(payload), privKey).toString('base64');

  return {
    'X-Node-Id':        identity.nodeId,
    'X-Node-Signature': signature,
    'X-Node-Timestamp': String(timestamp),
    'Content-Type':     'application/json',
  };
}

function canonicalPayload(nodeId, timestamp, body) {
  const clean = { ...body };
  delete clean.signature;
  delete clean.timestamp;
  return JSON.stringify({ nodeId, timestamp: Number(timestamp), body: stableStringify(clean) });
}

function stableStringify(obj) {
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  // Skip undefined-valued keys so the signed canonical matches the JSON sent on the wire
  // (JSON.stringify drops undefined). Without this, any undefined field breaks the signature.
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  loadIdentity,
  signRequest,
  get nodeId() { return loadIdentity().nodeId; },
};
