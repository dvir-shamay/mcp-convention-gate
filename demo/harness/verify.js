#!/usr/bin/env node
'use strict';

// End-to-end proof that the demo sequence is deterministic and real.
//
// Runs the exact flow the GIF shows and ASSERTS the block/allow transition:
//   1. install the gate into a fresh repo
//   2. `git commit` with no review    -> MUST be blocked (non-zero, hook banner)
//   3. register the required review
//   4. `git commit` again            -> MUST succeed (zero, commit created)
//
// No live model, no network. Exits non-zero on any deviation, so it doubles as a
// regression guard for the demo. Run: `node demo/harness/verify.js`.

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  setupRepo, installGate, writeConfig, editAndStage, attemptCommit, mcpRegister, DEMO_GATE,
} = require('./flow.js');

const repoDir = path.join(os.tmpdir(), `mcp-gate-verify-${process.pid}`);
let failures = 0;

function check(label, cond) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!cond) failures++;
}

try {
  // 1. Fresh repo + gate installed the way a user would.
  setupRepo(repoDir);
  const init = installGate(repoDir);
  check('gate installs cleanly', init.status === 0);
  check('pre-commit hook written', fs.existsSync(path.join(repoDir, '.git', 'hooks', 'pre-commit')));

  // Require a single review, so the demo stays legible.
  writeConfig(repoDir, [DEMO_GATE]);

  // 2. Agent edits a file and tries to commit — no review yet.
  editAndStage(repoDir, 'feature.js', "export const feature = () => 'hi';\n");
  const blocked = attemptCommit(repoDir, 'feat: add feature');
  check('commit BLOCKED before review', blocked.blocked === true);
  check('block is non-zero exit', blocked.code !== 0);
  check('block shows the gate banner', /COMMIT BLOCKED/.test(blocked.stderr));

  // 3. Register the required review through the real MCP server (server.js over stdio).
  const reg = mcpRegister(repoDir, DEMO_GATE);
  check('review registers via MCP', reg.status === 0);

  // 4. Same commit — now allowed, by construction.
  const allowed = attemptCommit(repoDir, 'feat: add feature');
  check('commit SUCCEEDS after review', allowed.code === 0);

  const log = require('child_process')
    .spawnSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf8' }).stdout || '';
  check('commit landed in history', /add feature/.test(log));
} catch (err) {
  process.stdout.write(`FAIL  unexpected error: ${err.message}\n`);
  failures++;
} finally {
  fs.rmSync(repoDir, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? 'OK — demo flow verified' : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
