// lib/access.js — Encrypted access layer (Phase 3 stub).
//
// The Problem:
//   When a node serves the wider mesh in Phase 2+, we need access control —
//   only wallets that hold or stake CIRC should be able to decrypt responses.
//
// The Design:
//   1. Response data is encrypted with AES-256-GCM.
//   2. The encryption key is derived from: CIRC_MINT + requestor_wallet + server_epoch.
//   3. The requestor must prove CIRC ownership (balance check or x402 payment receipt).
//   4. Only then does the server share the key derivation inputs.
//   5. The client decrypts locally — the server never sees plaintext traffic on the wire
//      after encryption is enabled.
//
// This is conceptually similar to Lit Protocol's threshold encryption,
// but implemented as a simpler bilateral key agreement tied to the
// CIRC token contract rather than a separate oracle network.
//
// Phase 3 activation steps:
//   1. Implement CIRC balance verification (RPC call to check token account)
//   2. Implement key derivation (PBKDF2 from: circMint + walletAddress + epochId)
//   3. Implement encrypt()/decrypt() using derived key
//   4. Add X-Access-Proof header to API requests (signed wallet + balance proof)
//   5. Lite server wraps all non-local responses in encrypt() before sending
//   6. Agent SDK knows to call decrypt() on receipt
//
// Phase 1-2: x402 payment gate on the canonical node applies to all callers.
//            Encryption is not applied locally.
'use strict';

const crypto = require('crypto');

const CIRC_MINT      = '8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump';
const TOKEN_2022_PROG = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEFAULT_RPC     = 'https://api.mainnet-beta.solana.com';

let _rpcUrl = DEFAULT_RPC;

function configure(config) {
  _rpcUrl = config?.network?.solanaRpcUrl ?? DEFAULT_RPC;
}

const ENCRYPTION_ALGO = 'aes-256-gcm';
const KEY_ITERATIONS  = 100_000;
const KEY_LENGTH      = 32; // 256 bits
const SALT_LENGTH     = 16;
const IV_LENGTH       = 12;
const TAG_LENGTH      = 16;

// ── Phase 3: Key derivation ───────────────────────────────────────────────────

/**
 * Derive an AES-256 encryption key from CIRC token ownership context.
 *
 * @param {string} circMint     — CIRC token mint address (constant)
 * @param {string} walletAddress — requestor's Solana wallet
 * @param {string} epochId       — current rotation epoch (e.g. "2026-03-W12")
 * @param {Buffer} salt          — random salt (stored alongside ciphertext)
 * @returns {Promise<Buffer>}    — 32-byte AES key
 */
async function deriveKey(circMint, walletAddress, epochId, salt) {
  const ikm = `${circMint}:${walletAddress}:${epochId}`;
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(ikm, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha256', (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

/**
 * Current epoch ID — rotates weekly.
 * All nodes in the same week produce the same epoch string.
 */
function currentEpochId() {
  const now  = new Date();
  const year = now.getUTCFullYear();
  const week = Math.ceil(
    ((now - new Date(Date.UTC(year, 0, 1))) / 86_400_000 + 1) / 7
  );
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ── Phase 3: Encrypt / Decrypt ────────────────────────────────────────────────

/**
 * Encrypt a JSON payload with a derived key.
 * Returns a base64-encoded envelope: salt || iv || tag || ciphertext
 *
 * @param {object} data    — plain data to encrypt
 * @param {Buffer} key     — 32-byte AES key (from deriveKey)
 * @returns {string}       — base64 envelope
 */
function encrypt(data, key) {
  const iv         = crypto.randomBytes(IV_LENGTH);
  const cipher     = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv, { authTagLength: TAG_LENGTH });
  const plaintext  = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag        = cipher.getAuthTag();

  // Envelope: [iv (12)] [tag (16)] [ciphertext (n)]
  const envelope = Buffer.concat([iv, tag, ciphertext]);
  return envelope.toString('base64');
}

/**
 * Decrypt a base64 envelope produced by encrypt().
 *
 * @param {string} envelope — base64 encrypted envelope
 * @param {Buffer} key      — 32-byte AES key (from deriveKey)
 * @returns {object}        — decrypted data
 */
function decrypt(envelope, key) {
  const buf        = Buffer.from(envelope, 'base64');
  const iv         = buf.subarray(0, IV_LENGTH);
  const tag        = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ── Phase 3: CIRC staking verification ──────────────────────────────────────

/**
 * Verify that a wallet has the minimum CIRC staked in the configured StakePoint pool.
 * This is the Phase 3 access gate — stake replaces balance-holding as the unlock mechanism.
 *
 * @param {string} walletAddress
 * @param {string} poolAddress     — StakePoint pool account address (from config)
 * @param {number} minAmount       — minimum CIRC required (in token units, not atomic)
 * @param {number} decimals        — CIRC decimals (default 6)
 * @returns {Promise<{ eligible, stakedAmount, lockUntil, lockActive, error? }>}
 */
async function verifyCircStake(walletAddress, poolAddress, minAmount, decimals) {
  const { verifyStake } = require('./stakepoint');
  return verifyStake(
    walletAddress,
    poolAddress,
    minAmount ?? 100_000,
    decimals  ?? 6,
    _rpcUrl
  );
}

// ── Phase 3: CIRC balance verification (stub) ───────────────────────────────

/**
 * Verify that a wallet holds the minimum CIRC balance required for access.
 * Phase 3: implement via RPC getTokenAccountsByOwner.
 *
 * @param {string} walletAddress
 * @param {number} minBalance
 * @returns {Promise<{ eligible: boolean, balance: number|null }>}
 */
async function verifyCircBalance(walletAddress, minBalance = 100) {
  try {
    const res = await fetch(_rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'getTokenAccountsByOwner',
        params:  [
          walletAddress,
          { programId: TOKEN_2022_PROG },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const json = await res.json();
    const accounts = json?.result?.value ?? [];

    let balance = 0;
    for (const { account } of accounts) {
      const info = account?.data?.parsed?.info;
      if (info?.mint === CIRC_MINT) {
        balance += info?.tokenAmount?.uiAmount ?? 0;
      }
    }

    return { eligible: balance >= minBalance, balance, mint: CIRC_MINT };
  } catch (err) {
    console.warn('[access] verifyCircBalance failed:', err.message);
    return { eligible: false, balance: null, error: err.message };
  }
}

// ── Phase 1-2: Passthrough ────────────────────────────────────────────────────

/**
 * Determines if a request originates from localhost.
 * Used for Phase 3 encryption decisions — local requests skip encryption.
 * Note: x402 still applies at the canonical node for all data API calls.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isLocalAccess(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  deriveKey,
  currentEpochId,
  encrypt,
  decrypt,
  verifyCircBalance,
  verifyCircStake,
  isLocalAccess,
  configure,
};
