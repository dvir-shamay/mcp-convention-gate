#!/usr/bin/env node
'use strict';

// Prepare a fresh, gated throwaway repo for the demo and print its path.
//
// The repo is created OUTSIDE this package (default: <os-temp>/mcp-gate-demo) so
// git operations never touch this repo. It is seeded with an initial commit,
// then the gate is installed (`mcp-convention-gate init`) and narrowed to a
// single required review so the demo stays legible. Re-running wipes and
// recreates it, so the demo is fully reproducible with no live model.
//
// Usage:
//   node demo/harness/setup-repo.js [targetDir]

const os = require('os');
const path = require('path');
const { setupRepo, installGate, writeConfig, DEMO_GATE } = require('./flow.js');

const target = process.argv[2] || path.join(os.tmpdir(), 'mcp-gate-demo');

setupRepo(target);
installGate(target);
writeConfig(target, [DEMO_GATE]);

process.stdout.write(target + '\n');
