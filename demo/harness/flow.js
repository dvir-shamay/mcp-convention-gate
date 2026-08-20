'use strict';

// Shared, deterministic demo flow helpers for mcp-convention-gate.
//
// This is the single source of truth for the demo sequence:
//   fresh throwaway repo -> install the gate -> git commit is BLOCKED ->
//   register the required review -> git commit SUCCEEDS.
//
// No live model is involved: the gate is a git hook + a small store, so a
// scripted terminal sequence IS the proof. `verify.js` runs this end to end and
// asserts the block/allow transition; `demo.tape` (VHS) films the same beats.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Root of the mcp-convention-gate package (two levels up from demo/harness/).
const GATE_DIR = path.resolve(__dirname, '..', '..');
const CLI = path.join(GATE_DIR, 'cli.js');

// The single review this demo requires. A real repo lists as many as it wants
// in .gate-config.json; one keeps the demo legible.
const DEMO_GATE = 'code-review';

// ── Small process helpers ─────────────────────────────────────────────────────

function git(repoDir, args, env) {
  return spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
}

function node(scriptArgs, opts) {
  return spawnSync(process.execPath, scriptArgs, {
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, ...((opts && opts.env) || {}) },
  });
}

// ── Flow steps ─────────────────────────────────────────────────────────────────

// Create a clean throwaway git repo with one initial commit. Idempotent: any
// existing directory at `repoDir` is removed first, so every run is identical.
function setupRepo(repoDir) {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });

  git(repoDir, ['init', '-q', '-b', 'main']);
  // Local identity + no signing, so the demo needs no global git config.
  git(repoDir, ['config', 'user.email', 'demo@example.com']);
  git(repoDir, ['config', 'user.name', 'Demo']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.gate-store.json\n.vscode/\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo repo\n');
  git(repoDir, ['add', '.gitignore', 'README.md']);
  // Seeded before the gate is installed, so no bypass is needed here.
  git(repoDir, ['commit', '-q', '-m', 'chore: initial commit']);

  return repoDir;
}

// Install the gate into `repoDir` exactly the way a user would: `mcp-convention-gate init`.
function installGate(repoDir) {
  return node([CLI, 'init'], { cwd: repoDir });
}

// Narrow the required reviews to `gates` (default: just the one demo review).
function writeConfig(repoDir, gates) {
  const config = { enabled: true, required_gates: gates || [DEMO_GATE] };
  fs.writeFileSync(
    path.join(repoDir, '.gate-config.json'),
    JSON.stringify(config, null, 2) + '\n'
  );
}

// Stage a source edit an agent would make.
function editAndStage(repoDir, file, contents) {
  fs.writeFileSync(path.join(repoDir, file), contents);
  return git(repoDir, ['add', file]);
}

// Attempt a commit. Returns { code, stdout, stderr, blocked }.
// `env` is merged into the git — and therefore the hook's — environment; the demo
// hero passes FORCE_COLOR=1 so the captured hook output carries real TTY color.
function attemptCommit(repoDir, message, env) {
  const r = git(repoDir, ['commit', '-m', message], env);
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    blocked: /COMMIT BLOCKED|convention-gate/i.test(out) && r.status !== 0,
  };
}

// Register a completed review by driving the REAL MCP server (server.js) over stdio.
function mcpRegister(repoDir, gateName) {
  return node([path.join(__dirname, 'mcp-register.js'), gateName || DEMO_GATE], {
    cwd: repoDir,
  });
}

module.exports = {
  GATE_DIR,
  CLI,
  DEMO_GATE,
  git,
  node,
  setupRepo,
  installGate,
  writeConfig,
  editAndStage,
  attemptCommit,
  mcpRegister,
};
