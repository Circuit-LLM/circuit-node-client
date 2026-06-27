// lib/stakepoint.js — On-chain StakePoint staking verifier.
//
// Queries the StakePoint Anchor program directly via Solana RPC.
// No StakePoint API key required — pure on-chain reads.
//
// Reverse-engineered 185-byte StakerPosition account layout:
//   [0-7]    discriminator: 96c5b01d37847095
//   [8-39]   staker_wallet: Pubkey (32 bytes)
//   [40-71]  pool:          Pubkey (32 bytes)
//   [72-79]  staked_amount: u64 LE (atomic units, 6 decimals)
//   [80-87]  lock_until:    u64 LE (unix timestamp, 0 = unlocked)
//   [88-119] staker_wallet  (repeated — Anchor PDAs often duplicate seeds)
//   [120+]   rewards / misc fields
//   [184]    bump: u8
//
// IMPORTANT: A wallet can have MULTIPLE positions in the same pool (e.g. from
// staking in multiple transactions). We sum ALL active positions. Returning
// only the first position would silently under-count a user's true stake.
//
// Zero-staked positions exist (unstaked but account not closed). Filter them.
'use strict';

const PROGRAM_ID          = 'gLHaGJsZ6G7AXZxoDL9EsSWkRbKAWhFHi73gVfNXuzK';
const STAKER_ACCOUNT_SIZE = 185;
const DISCRIMINATOR       = '96c5b01d37847095'; // first 8 bytes — Anchor account type tag
const OFFSET_WALLET       = 8;
const OFFSET_POOL         = 40;
const OFFSET_STAKED       = 72;
const OFFSET_LOCK_UNTIL   = 80;

// Read a little-endian u64 as BigInt — avoids Number precision loss for large values.
// JavaScript Number loses precision above 2^53 (~9×10^15). Some staked amounts
// exceed this, so we use BigInt for all arithmetic and only convert to Number for display.
function _readU64LE(buf, offset) {
  let v = BigInt(0);
  for (let i = 0; i < 8; i++) v |= BigInt(buf[offset + i]) << BigInt(i * 8);
  return v;
}

// Verify the Anchor discriminator. Protects against reading the wrong account type
// if the StakePoint program ever adds another 185-byte account in future.
function _verifyDiscriminator(buf) {
  return buf.slice(0, 8).toString('hex') === DISCRIMINATOR;
}

/**
 * Fetch ALL staker positions for a wallet in a specific pool.
 * Returns an empty array if no positions exist.
 * Filters out zero-staked accounts (unstaked but not yet closed on-chain).
 *
 * @param {string} walletAddress — Solana wallet base58
 * @param {string} poolAddress   — StakePoint pool account base58
 * @param {string} rpcUrl        — Solana RPC endpoint
 * @returns {Promise<Array<{positionAddress, stakedRaw, lockUntil, lockActive}>>}
 */
async function getStakePositions(walletAddress, poolAddress, rpcUrl) {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'getProgramAccounts',
      params:  [PROGRAM_ID, {
        encoding: 'base64',
        filters: [
          { dataSize: STAKER_ACCOUNT_SIZE },
          { memcmp: { offset: OFFSET_WALLET, bytes: walletAddress } },
          { memcmp: { offset: OFFSET_POOL,   bytes: poolAddress   } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const json     = await res.json();
  const accounts = json?.result ?? [];
  if (!accounts.length) return [];

  const now = Math.floor(Date.now() / 1000);
  const positions = [];

  for (const acc of accounts) {
    const buf = Buffer.from(acc.account.data[0], 'base64');

    // Discriminator check — skip any account that isn't a StakerPosition
    if (!_verifyDiscriminator(buf)) continue;

    const stakedRaw = _readU64LE(buf, OFFSET_STAKED);

    // Filter out zero-staked accounts — these are unstaked positions whose
    // on-chain accounts haven't been closed yet. Counting them would be misleading.
    if (stakedRaw === BigInt(0)) continue;

    const lockUntil = Number(_readU64LE(buf, OFFSET_LOCK_UNTIL));

    positions.push({
      positionAddress: acc.pubkey,
      stakedRaw,                               // BigInt — full precision
      lockUntil,                               // unix timestamp, 0 = no lock
      lockActive: lockUntil > 0 && lockUntil > now,
    });
  }

  return positions;
}

/**
 * Verify a wallet has at least minAmount tokens staked (summed across ALL positions).
 *
 * Staking and locking are separate in StakePoint:
 * - Staking:  depositing tokens into a pool position (determines eligibility)
 * - Locking:  voluntary time-lock for bonus rewards (not required for access)
 * Tokens remain staked until explicitly unstaked; an expired lock ≠ unstaked.
 *
 * @param {string} walletAddress
 * @param {string} poolAddress
 * @param {number} minAmount   — minimum required (in human units, e.g. 100000 for 100k CIRC)
 * @param {number} decimals    — token decimals (CIRC = 6)
 * @param {string} rpcUrl
 * @returns {Promise<{eligible, stakedAmount, stakedRaw, positionCount, lockUntil, lockActive, positions?, error?}>}
 */
async function verifyStake(walletAddress, poolAddress, minAmount, decimals, rpcUrl) {
  try {
    const positions = await getStakePositions(walletAddress, poolAddress, rpcUrl);

    if (!positions.length) {
      return {
        eligible:      false,
        stakedAmount:  0,
        stakedRaw:     '0',
        positionCount: 0,
        lockUntil:     null,
        lockActive:    false,
      };
    }

    const dec = decimals ?? 6;
    const div = Math.pow(10, dec);

    // Sum all active positions as BigInt to avoid precision loss
    const totalRaw = positions.reduce((sum, p) => sum + p.stakedRaw, BigInt(0));

    // Compare against minimum using BigInt arithmetic — round whole CIRC (safe in Number) THEN scale in
    // BigInt, so a large minimum can't overflow 2^53 in the `* div` before the BigInt cast.
    const minAmountRaw = BigInt(Math.round(minAmount ?? 0)) * BigInt(div);
    const eligible     = totalRaw >= minAmountRaw;

    // Convert to human-readable float for display only.
    // Note: values above Number.MAX_SAFE_INTEGER (~9×10^15 raw units = ~9×10^9 CIRC)
    // lose floating-point precision but the eligibility check above is exact.
    const stakedAmount = Number(totalRaw) / div;

    // Report the longest active lock period across all positions (most restrictive)
    const activeLocks = positions.filter(p => p.lockActive);
    const maxLockUntil = activeLocks.length
      ? Math.max(...activeLocks.map(p => p.lockUntil))
      : null;

    return {
      eligible,
      stakedAmount,
      stakedRaw:     totalRaw.toString(),
      positionCount: positions.length,
      lockUntil:     maxLockUntil,
      lockActive:    activeLocks.length > 0,
      positions: positions.map(p => ({
        address:      p.positionAddress,
        stakedAmount: Number(p.stakedRaw) / div,
        stakedRaw:    p.stakedRaw.toString(),
        lockUntil:    p.lockUntil || null,
        lockActive:   p.lockActive,
      })),
    };

  } catch (err) {
    return {
      eligible:      false,
      error:         err.message,
      stakedAmount:  0,
      stakedRaw:     '0',
      positionCount: 0,
      lockUntil:     null,
      lockActive:    false,
    };
  }
}

// ── Enumerate ALL stakers in a pool ───────────────────────────────────────────
// Bitcoin/Solana base58 (zero-dep — this module reads chain state with no crypto libs).
const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function _base58encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += _B58[digits[k]];
  return out;
}

/**
 * Enumerate EVERY staker in a pool in one getProgramAccounts call (filtered by pool only —
 * no per-wallet RPC). Sums all active positions per wallet, skips zero-staked accounts.
 * Used by the payout executor's "stakers" mode to pay everyone who has staked.
 *
 * @param {string} poolAddress — StakePoint pool account base58
 * @param {string} rpcUrl
 * @returns {Promise<Array<{wallet: string, stakedRaw: bigint}>>}  sorted desc by stake
 */
async function getAllStakers(poolAddress, rpcUrl) {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [PROGRAM_ID, {
        encoding: 'base64',
        filters: [
          { dataSize: STAKER_ACCOUNT_SIZE },
          { memcmp: { offset: OFFSET_POOL, bytes: poolAddress } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const json = await res.json();
  if (json?.error) throw new Error('getProgramAccounts failed: ' + JSON.stringify(json.error));
  const accounts = json?.result ?? [];

  const byWallet = new Map(); // wallet → BigInt total staked (summed across positions)
  for (const acc of accounts) {
    const buf = Buffer.from(acc.account.data[0], 'base64');
    if (!_verifyDiscriminator(buf)) continue;
    const staked = _readU64LE(buf, OFFSET_STAKED);
    if (staked === BigInt(0)) continue;                       // unstaked-but-open position
    const wallet = _base58encode(buf.slice(OFFSET_WALLET, OFFSET_WALLET + 32));
    byWallet.set(wallet, (byWallet.get(wallet) ?? BigInt(0)) + staked);
  }

  return [...byWallet.entries()]
    .map(([wallet, stakedRaw]) => ({ wallet, stakedRaw }))
    .sort((a, b) => (a.stakedRaw < b.stakedRaw ? 1 : a.stakedRaw > b.stakedRaw ? -1 : 0));
}

// ── Cached verification ───────────────────────────────────────────────────────
// Two layers of protection against RPC cost:
//
// 1. TTL cache keyed by wallet address — a staked user making 100 API calls
//    in 5 minutes triggers exactly ONE getProgramAccounts call, not 100.
//    Default TTL: 5 minutes. Unstaking takes effect within one TTL window.
//
// 2. In-flight deduplication — if two requests arrive simultaneously for the
//    same wallet before the first RPC call resolves, both wait on the same
//    Promise. Without this, a burst of requests would fire N parallel RPC calls.
//
// Size cap (1000 wallets) prevents unbounded memory growth. Simple LRU-lite:
// evict the oldest (first-inserted) entry when the cap is hit.

const CACHE_TTL_MS  = 5 * 60_000; // 5 minutes
const CACHE_MAX     = 1_000;       // max unique wallets cached at once

const _cache    = new Map(); // wallet → { result, expiresAt }
const _inflight = new Map(); // wallet → Promise (in-flight RPC calls)

function _cacheGet(wallet) {
  const entry = _cache.get(wallet);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(wallet); return null; }
  return entry.result;
}

function _cacheSet(wallet, result) {
  if (_cache.size >= CACHE_MAX) {
    // Evict oldest (Map preserves insertion order)
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(wallet, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Cached + deduplicated wrapper around verifyStake.
 * Use this in the proxy gate — NOT verifyStake directly.
 *
 * @param {string} walletAddress
 * @param {string} poolAddress
 * @param {number} minAmount
 * @param {number} decimals
 * @param {string} rpcUrl
 * @returns {Promise<verifyStake result>}
 */
async function verifyStakeCached(walletAddress, poolAddress, minAmount, decimals, rpcUrl) {
  // 1. Cache hit — no RPC call needed
  const cached = _cacheGet(walletAddress);
  if (cached !== null) return cached;

  // 2. In-flight dedup — reuse existing Promise if one is already running
  if (_inflight.has(walletAddress)) return _inflight.get(walletAddress);

  // 3. Cache miss, no inflight — fire RPC call
  const p = verifyStake(walletAddress, poolAddress, minAmount, decimals, rpcUrl)
    .then(result => {
      _cacheSet(walletAddress, result);
      _inflight.delete(walletAddress);
      return result;
    })
    .catch(err => {
      _inflight.delete(walletAddress);
      throw err;
    });

  _inflight.set(walletAddress, p);
  return p;
}

/** Expose cache stats for monitoring / health checks. */
function cacheStats() {
  return { size: _cache.size, inflight: _inflight.size, maxSize: CACHE_MAX, ttlMs: CACHE_TTL_MS };
}

module.exports = { getStakePositions, getAllStakers, verifyStake, verifyStakeCached, cacheStats, PROGRAM_ID, DISCRIMINATOR };
