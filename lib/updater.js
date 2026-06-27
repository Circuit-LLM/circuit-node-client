// lib/updater.js — GitHub-based update manager.
//
// Checks Circuit-LLM/circuit-node-client releases on GitHub for newer versions.
// On startup (30s delay) and hourly: compares package.json version to latest tag.
//
// Apply flow:
//   1. Backup current install (excludes data/ and node_modules/)
//   2. Try git pull --ff-only (fast, works for any git clone)
//   3. Fallback: download tarball from GitHub release assets
//   4. npm install --omit=dev
//   5. process.exit(0) — systemd/PM2 restarts with new code
//
// Every applied/rejected update is logged to data/update-history.json.
// Auto-apply can be disabled via config.updates.autoApply = false.
'use strict';

const fs                         = require('fs');
const path                       = require('path');
const crypto                     = require('crypto');
const { execFileSync } = require('child_process');

const APP_ROOT        = path.join(__dirname, '..');
const UPDATE_HISTORY  = path.join(APP_ROOT, 'data', 'update-history.json');
const CURRENT_VERSION = require('../package.json').version;
const GITHUB_REPO     = 'Circuit-LLM/circuit-node-client';
const GITHUB_API      = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

let _timer      = null;
let _lastStatus = null; // cached from most recent check

// ── Semver (no external dep) ──────────────────────────────────────────────────
const semver = {
  parse(v) {
    const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  },
  gt(a, b) {
    const [ma, mia, pa] = semver.parse(a);
    const [mb, mib, pb] = semver.parse(b);
    if (ma !== mb) return ma > mb;
    if (mia !== mib) return mia > mib;
    return pa > pb;
  },
};

// ── Start / Stop ──────────────────────────────────────────────────────────────

function start(config) {
  // Initial check after 30s so node finishes startup first
  setTimeout(() => checkForUpdate(config).catch(() => {}), 30_000);

  if (!config.updates?.autoUpdate) {
    console.log('[updater] Auto-update disabled');
    return;
  }

  const interval = config.updates?.checkIntervalMs ?? 3_600_000;
  _timer = setInterval(() => checkForUpdate(config).catch(err => {
    console.warn('[updater] Check failed:', err.message);
  }), interval);
  _timer.unref();
  console.log(`[updater] Watching GitHub releases (every ${Math.round(interval / 60_000)} min)`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── GitHub release fetch ──────────────────────────────────────────────────────

async function _fetchLatestRelease(config) {
  const token = config.updates?.githubToken ?? null;
  const headers = {
    'Accept':     'application/vnd.github.v3+json',
    'User-Agent': `circuit-node-client/${CURRENT_VERSION}`,
  };
  if (token) headers['Authorization'] = `token ${token}`;

  const res = await fetch(GITHUB_API, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

// ── Check for update ──────────────────────────────────────────────────────────

async function checkForUpdate(config) {
  let release;
  try {
    release = await _fetchLatestRelease(config);
  } catch (err) {
    console.warn('[updater] GitHub unreachable:', err.message);
    _lastStatus = { current: CURRENT_VERSION, latest: null, updateAvailable: false, error: err.message, checkedAt: new Date().toISOString() };
    return;
  }

  if (!release?.tag_name) {
    _lastStatus = { current: CURRENT_VERSION, latest: null, updateAvailable: false, checkedAt: new Date().toISOString() };
    return;
  }

  const latest          = release.tag_name.replace(/^v/, '');
  const updateAvailable = semver.gt(latest, CURRENT_VERSION);

  _lastStatus = {
    current:       CURRENT_VERSION,
    latest,
    updateAvailable,
    publishedAt:   release.published_at ?? null,
    releaseUrl:    release.html_url ?? null,
    releaseNotes:  (release.body ?? '').slice(0, 400),
    tarballUrl:    release.tarball_url ?? null,
    checkedAt:     new Date().toISOString(),
  };

  if (!updateAvailable) {
    console.log(`[updater] Up to date (v${CURRENT_VERSION})`);
    return;
  }

  console.log(`[updater] New version available: v${CURRENT_VERSION} → v${latest}`);

  if (!config.updates?.autoApply) {
    console.log('[updater] autoApply disabled — use dashboard or: node node-client.js update');
    return;
  }

  await applyUpdate(config, latest, release.tarball_url);
}

// ── getUpdateStatus (used by server.js dashboard endpoint) ────────────────────
// Returns cached status if fresh (< 5 min), otherwise triggers a new check.

async function getUpdateStatus(config) {
  const staleMs = 5 * 60_000;
  const isFresh = _lastStatus && (Date.now() - new Date(_lastStatus.checkedAt).getTime()) < staleMs;
  if (!isFresh) await checkForUpdate(config).catch(() => {});

  return {
    ...(_lastStatus ?? { current: CURRENT_VERSION, latest: null, updateAvailable: false, checkedAt: new Date().toISOString() }),
    githubRepo:      GITHUB_REPO,
    autoUpdate:      config?.updates?.autoUpdate  ?? false,
    autoApply:       config?.updates?.autoApply   ?? false,
    checkIntervalMs: config?.updates?.checkIntervalMs ?? 3_600_000,
    history:         getHistory().slice(-10),
    backups:         getBackups(),
  };
}

// ── Apply update ──────────────────────────────────────────────────────────────

async function applyUpdate(config, newVersion, tarballUrl) {
  console.log(`[updater] Applying v${newVersion}…`);

  // Backup before touching anything
  const BACKUP_DIR = path.join(APP_ROOT, 'data', 'backups', CURRENT_VERSION);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    execFileSync('tar', [
      '-czf', path.join(BACKUP_DIR, 'backup.tar.gz'),
      '--exclude=./data', '--exclude=./node_modules',
      '-C', APP_ROOT, '.',
    ], { stdio: 'pipe' });
    console.log(`[updater] Backup saved → data/backups/${CURRENT_VERSION}/`);
  } catch (err) {
    console.warn('[updater] Backup warning (continuing):', err.message);
  }

  // Primary: git pull (works for any git clone, no auth needed if public)
  if (_applyViaGit()) {
    _logHistory({ version: newVersion, status: 'applied', method: 'git-pull' });
    console.log(`[updater] v${newVersion} applied — restarting`);
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Fallback: tarball download from GitHub release
  if (tarballUrl) {
    const ok = await _applyViaTarball(config, newVersion, tarballUrl);
    if (ok) {
      _logHistory({ version: newVersion, status: 'applied', method: 'tarball' });
      console.log(`[updater] v${newVersion} applied via tarball — restarting`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
  }

  console.error('[updater] All apply methods failed');
  _logHistory({ version: newVersion, status: 'failed', reason: 'git-pull and tarball both failed' });
}

function _applyViaGit() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: APP_ROOT, stdio: 'pipe' });
    console.log('[updater] Pulling from GitHub…');
    execFileSync('git', ['pull', '--ff-only'], { cwd: APP_ROOT, stdio: 'pipe' });
    execFileSync('npm', ['install', '--omit=dev', '--quiet'], { cwd: APP_ROOT, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.warn('[updater] git pull failed:', err.stderr?.toString()?.trim() || err.message);
    return false;
  }
}

// Fetch the publisher's signed update manifest { version, checksum, url, timestamp, signature }.
async function _fetchSignedManifest(config) {
  const base = String(config.registryUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('no registryUrl configured');
  const res = await fetch(`${base}/api/network/updates/latest`, {
    headers: { 'User-Agent': `circuit-node-client/${CURRENT_VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return res.json();
}

// Verify the Ed25519 signature over the EXACT payload the publisher signed (same key order).
function _verifyManifestSig(m, signingPublicKeyB64) {
  const payload = JSON.stringify({ version: m.version, checksum: m.checksum, url: m.url, timestamp: m.timestamp });
  const pub = crypto.createPublicKey({ key: Buffer.from(signingPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(payload), pub, Buffer.from(String(m.signature), 'base64'));
}

async function _applyViaTarball(config, newVersion, tarballUrl) {
  const STAGE_DIR = path.join(APP_ROOT, 'data', 'staging', newVersion);
  const ARCHIVE   = path.join(STAGE_DIR, 'update.tar.gz');

  // ── INTEGRITY GATE (supply-chain) — never apply unverified code. Fail CLOSED. ──
  const signKey = config.updates?.signingPublicKey;
  if (!signKey) {
    console.error('[updater] refusing auto-update: no updates.signingPublicKey configured — set it (deploy/generate-signing-key.js) to enable verified updates');
    return false;
  }
  let manifest;
  try {
    manifest = await _fetchSignedManifest(config);
    if (manifest.version !== newVersion) throw new Error(`manifest version ${manifest.version} != ${newVersion}`);
    if (!_verifyManifestSig(manifest, signKey)) throw new Error('manifest signature is invalid');
  } catch (err) {
    console.error('[updater] refusing update — manifest verification failed:', err.message);
    return false;
  }

  // Download from the SIGNED url (not GitHub's tarball_url) and verify the sha256 against the manifest.
  console.log('[updater] Downloading verified update package…');
  try {
    const res = await fetch(manifest.url, { headers: { 'User-Agent': `circuit-node-client/${CURRENT_VERSION}` }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const checksum = crypto.createHash('sha256').update(buf).digest('hex');
    if (checksum !== manifest.checksum) throw new Error(`checksum mismatch (${checksum.slice(0, 12)}… != ${String(manifest.checksum).slice(0, 12)}…)`);
    console.log(`[updater] Downloaded + verified ${(buf.length / 1024).toFixed(1)} KB`);
    fs.mkdirSync(STAGE_DIR, { recursive: true });
    fs.writeFileSync(ARCHIVE, buf);
  } catch (err) {
    console.error('[updater] verified download failed:', err.message);
    _cleanup(STAGE_DIR);
    return false;
  }

  try {
    execFileSync('tar', ['-xzf', ARCHIVE, '-C', STAGE_DIR], { stdio: 'pipe' });
  } catch (err) {
    console.error('[updater] Extract failed:', err.message);
    _cleanup(STAGE_DIR);
    return false;
  }

  const root = _findRoot(STAGE_DIR);
  if (!root) {
    console.error('[updater] Invalid package — node-client.js not found in archive');
    _cleanup(STAGE_DIR);
    return false;
  }

  try {
    try {
      execFileSync('rsync', ['-a', '--exclude=data/', '--exclude=node_modules/', root + '/', APP_ROOT + '/'], { stdio: 'pipe' });
    } catch {
      execFileSync('cp', ['-r', root + '/.', APP_ROOT + '/'], { stdio: 'pipe' });
    }
    execFileSync('npm', ['install', '--omit=dev', '--quiet'], { cwd: APP_ROOT, stdio: 'pipe' });
  } catch (err) {
    console.error('[updater] Swap/install failed:', err.message);
    _cleanup(STAGE_DIR);
    return false;
  }

  _cleanup(STAGE_DIR);
  return true;
}

// ── Rollback ──────────────────────────────────────────────────────────────────

function rollback(targetVersion) {
  const archive = path.join(APP_ROOT, 'data', 'backups', targetVersion, 'backup.tar.gz');
  if (!fs.existsSync(archive)) {
    console.error(`[updater] No backup for v${targetVersion}`);
    return false;
  }
  console.log(`[updater] Rolling back to v${targetVersion}…`);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', APP_ROOT], { stdio: 'pipe' });
    execFileSync('npm', ['install', '--omit=dev', '--quiet'], { cwd: APP_ROOT, stdio: 'pipe' });
    _logHistory({ version: targetVersion, status: 'rolled-back' });
    console.log('[updater] Rollback complete — restarting');
    setTimeout(() => process.exit(0), 500);
    return true;
  } catch (err) {
    console.error('[updater] Rollback failed:', err.message);
    return false;
  }
}

// ── History + Backups ─────────────────────────────────────────────────────────

function getHistory() {
  try {
    if (!fs.existsSync(UPDATE_HISTORY)) return [];
    return JSON.parse(fs.readFileSync(UPDATE_HISTORY, 'utf8'));
  } catch { return []; }
}

function getBackups() {
  const dir = path.join(APP_ROOT, 'data', 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(v => fs.existsSync(path.join(dir, v, 'backup.tar.gz')))
    .sort((a, b) => semver.gt(a, b) ? -1 : 1); // newest first
}

function _logHistory(entry) {
  try {
    const dir = path.dirname(UPDATE_HISTORY);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const history = getHistory();
    history.push({ ...entry, at: new Date().toISOString() });
    if (history.length > 50) history.splice(0, history.length - 50);
    fs.writeFileSync(UPDATE_HISTORY, JSON.stringify(history, null, 2));
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _findRoot(stageDir) {
  if (fs.existsSync(path.join(stageDir, 'node-client.js'))) return stageDir;
  for (const entry of fs.readdirSync(stageDir)) {
    const full = path.join(stageDir, entry);
    if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'node-client.js'))) {
      return full;
    }
  }
  return null;
}

function _cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { start, stop, checkForUpdate, applyUpdate, getUpdateStatus, rollback, getHistory, getBackups, semver, GITHUB_REPO };
