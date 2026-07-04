// test/home.test.js — guards the CIRCUIT_NODE_HOME seam that lets the desktop app run the
// client as a read-only bundled sidecar while keeping the CLI (`node node-client.js`) byte-for-byte.
//
// home.js reads CIRCUIT_NODE_HOME once at require() time, so each case runs in a child process
// with a fresh module registry — the only way to exercise both the default and relocated paths.
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const REPO = path.join(__dirname, '..');
const run  = (env, code) =>
  execFileSync(process.execPath, ['-e', code], { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

test('default (CLI): config/data resolve next to the code, relocated=false', () => {
  const out = run({ CIRCUIT_NODE_HOME: '' }, `
    const h = require('./lib/home');
    process.stdout.write(JSON.stringify({ relocated: h.relocated, config: h.CONFIG_DIR, data: h.DATA_DIR }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.relocated, false);
  assert.equal(r.config, path.join(REPO, 'config'));
  assert.equal(r.data,   path.join(REPO, 'data'));
});

test('relocated (app): CIRCUIT_NODE_HOME moves config/data and ensureDirs creates them', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-node-home-'));
  try {
    const out = run({ CIRCUIT_NODE_HOME: homeDir }, `
      const h = require('./lib/home'); h.ensureDirs();
      const fs = require('fs');
      process.stdout.write(JSON.stringify({
        relocated: h.relocated,
        configUnder: h.CONFIG_DIR.startsWith(process.env.CIRCUIT_NODE_HOME),
        configExists: fs.existsSync(h.CONFIG_DIR),
        dataExists: fs.existsSync(h.DATA_DIR),
      }));
    `);
    const r = JSON.parse(out);
    assert.equal(r.relocated, true);
    assert.equal(r.configUnder, true);
    assert.equal(r.configExists, true);
    assert.equal(r.dataExists, true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('relocated: identity + admin token write under the home, not the repo', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circuit-node-home-'));
  try {
    run({ CIRCUIT_NODE_HOME: homeDir }, `require('./lib/identity').loadIdentity();`);
    assert.ok(fs.existsSync(path.join(homeDir, 'data', 'identity.json')), 'identity.json lands in the relocated home');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
