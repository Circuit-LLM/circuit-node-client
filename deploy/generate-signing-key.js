#!/usr/bin/env node
// deploy/generate-signing-key.js — One-time Circuit LLM signing key setup.
//
// Run ONCE on the Circuit LLM VPS. Never run again (it would replace the key
// and break signature verification on all existing clients).
//
// Output:
//   data/signing-key.json  — KEEP PRIVATE. Never commit. Add to .gitignore.
//   Prints the public key  — embed this in config/client.json before shipping.
//
// Usage:
//   node deploy/generate-signing-key.js
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const KEY_FILE  = path.join(__dirname, '..', 'data', 'signing-key.json');
const DATA_DIR  = path.dirname(KEY_FILE);

if (fs.existsSync(KEY_FILE)) {
  console.error('Signing key already exists at', KEY_FILE);
  console.error('Delete it manually if you really want to regenerate (this will break existing clients).');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding:  { type: 'spki',  format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

const publicKeyB64  = publicKey.toString('base64');
const privateKeyB64 = privateKey.toString('base64');

fs.writeFileSync(KEY_FILE, JSON.stringify({ publicKeyB64, privateKeyB64 }, null, 2), { mode: 0o600 });

console.log('\n✓ Circuit LLM signing key generated\n');
console.log('Private key saved to:', KEY_FILE);
console.log('(chmod 600, never commit this file)\n');
console.log('─────────────────────────────────────────────────────────');
console.log('PUBLIC KEY (add to config/client.json before shipping):');
console.log('─────────────────────────────────────────────────────────');
console.log(publicKeyB64);
console.log('─────────────────────────────────────────────────────────');
console.log('\nIn config/client.json, set:');
console.log(JSON.stringify({ updates: { signingPublicKey: publicKeyB64 } }, null, 2));
