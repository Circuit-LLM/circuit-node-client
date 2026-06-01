#!/usr/bin/env node
// deploy/publish-update.js — Circuit LLM update publisher.
//
// Run this from the circuit-node-client directory when you want to push
// an update to the network. Only Circuit LLM (you) can run this —
// it requires the signing private key.
//
// Usage:
//   node deploy/publish-update.js
//
// Prerequisites:
//   1. Run `node deploy/generate-signing-key.js` once to create the keypair
//   2. Add the public key to config/client.json under updates.signingPublicKey
//      and ship that in the package so clients can verify
//   3. Keep the private key in data/signing-key.json (never commit this)
//
// What it does:
//   1. Creates a tar.gz of the current directory (excluding data/, node_modules/)
//   2. Computes SHA-256 checksum
//   3. Signs the package metadata with Circuit LLM's private key
//   4. Uploads the archive (or you can serve it from circuit-node directly)
//   5. Publishes the signed package info to POST /api/network/updates/publish
//
// Clients will pick it up within their next check interval (default: 1h).
// For immediate delivery, bump checkIntervalMs or restart the client.
'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

const APP_ROOT      = path.join(__dirname, '..');
const PKG           = require('../package.json');
const SIGNING_KEY   = path.join(APP_ROOT, 'data', 'signing-key.json');
const DIST_DIR      = path.join(APP_ROOT, 'data', 'dist');

// ── Config ────────────────────────────────────────────────────────────────────

// The canonical node URL — where the update will be published and served from
const REGISTRY_URL  = process.env.REGISTRY_URL  || 'https://node.circuitllm.xyz';
const INTERNAL_KEY  = process.env.INTERNAL_KEY;

if (!INTERNAL_KEY) {
  console.error('Error: INTERNAL_KEY environment variable is required.');
  console.error('Usage: REGISTRY_URL=https://node.circuitllm.xyz INTERNAL_KEY=<key> node deploy/publish-update.js');
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCIRCUIT Node Client — Publish Update`);
  console.log(`Version: ${PKG.version}\n`);

  // Load signing key
  if (!fs.existsSync(SIGNING_KEY)) {
    console.error(`Signing key not found at ${SIGNING_KEY}`);
    console.error('Run: node deploy/generate-signing-key.js');
    process.exit(1);
  }

  const { privateKeyB64, publicKeyB64 } = JSON.parse(fs.readFileSync(SIGNING_KEY, 'utf8'));
  console.log(`Signing key loaded (public: ${publicKeyB64.slice(0, 20)}…)`);

  // Create dist directory
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Build archive
  const archiveName = `circuit-node-client-${PKG.version}.tar.gz`;
  const archivePath = path.join(DIST_DIR, archiveName);

  console.log(`\nBuilding archive: ${archiveName}`);
  execSync(
    `tar -czf "${archivePath}" \
      --exclude=./data \
      --exclude=./node_modules \
      --exclude=./.git \
      --exclude=./deploy/publish-update.js \
      -C "${APP_ROOT}" .`,
    { stdio: 'inherit' }
  );

  const archiveBuffer = fs.readFileSync(archivePath);
  const sizeKb = (archiveBuffer.length / 1024).toFixed(1);
  console.log(`Archive size: ${sizeKb} KB`);

  // Compute checksum
  const checksum = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
  console.log(`SHA-256: ${checksum}`);

  // Build the download URL
  // The archive is served directly from circuit-node static or a CDN.
  // For now: serve from circuit-node at /api/network/updates/download/<version>
  const downloadUrl = `${REGISTRY_URL}/api/network/updates/download/${PKG.version}`;

  // Sign the package metadata
  const timestamp = Date.now();
  const payload   = JSON.stringify({
    version:   PKG.version,
    checksum,
    url:       downloadUrl,
    timestamp,
  });

  const privKeyDer = Buffer.from(privateKeyB64, 'base64');
  const privKey    = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
  const signature  = crypto.sign(null, Buffer.from(payload), privKey).toString('base64');

  const pkg = { version: PKG.version, checksum, url: downloadUrl, timestamp, signature };
  console.log('\nPackage signed OK');

  // Store the archive where circuit-node can serve it
  const serveDir  = path.join(APP_ROOT, '..', 'circuit-node', 'data', 'client-updates');
  const servePath = path.join(serveDir, archiveName);
  fs.mkdirSync(serveDir, { recursive: true });
  fs.copyFileSync(archivePath, servePath);
  console.log(`Archive copied to circuit-node → data/client-updates/${archiveName}`);

  // Publish to registry
  console.log(`\nPublishing to ${REGISTRY_URL}…`);
  try {
    const res = await fetch(`${REGISTRY_URL}/api/network/updates/publish`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Internal-Key': INTERNAL_KEY,
      },
      body: JSON.stringify(pkg),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    console.log(`\n✓ Published v${PKG.version} to network`);
    console.log(`  Clients will pick it up within their next check interval`);
    console.log(`  To notify immediately: POST /api/network/updates/notify (coming soon)`);
  } catch (err) {
    console.error('Publish failed:', err.message);
    console.log('\nPackage details (publish manually if needed):');
    console.log(JSON.stringify(pkg, null, 2));
    process.exit(1);
  }

  // Save package info locally
  fs.writeFileSync(
    path.join(DIST_DIR, `${PKG.version}.json`),
    JSON.stringify(pkg, null, 2)
  );
  console.log(`\nPackage info saved to data/dist/${PKG.version}.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
