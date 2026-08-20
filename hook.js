#!/usr/bin/env node
'use strict';

// Git pre-commit hook for mcp-convention-gate.
// Reads .gate-store.json, checks that an active session has all required gates
// passed. Blocks commit if not. This is OS-level enforcement — even raw
// `git commit` from terminal gets blocked.
//
// Install: copy to .git/hooks/pre-commit (or run `npx mcp-convention-gate init`)

const fs = require('fs');
const path = require('path');

// ── Terminal color ───────────────────────────────────────────────────────────
// Emit ANSI color ONLY for a real interactive terminal or an explicit
// FORCE_COLOR / CLICOLOR_FORCE (and never when NO_COLOR is set). On the non-TTY
// path the harness captures (piped stderr, no FORCE_COLOR) paint() is the
// identity function, so the emitted bytes are unchanged.
const useColor = !process.env.NO_COLOR &&
  Boolean(process.stderr.isTTY || process.env.FORCE_COLOR || process.env.CLICOLOR_FORCE);
const ANSI = { red: '\u001b[31m', bred: '\u001b[91m', grn: '\u001b[92m', bold: '\u001b[1m', reset: '\u001b[0m' };
function paint(s) {
  if (!useColor) return s;
  return s
    .replace(/COMMIT BLOCKED/g, ANSI.bold + ANSI.bred + 'COMMIT BLOCKED' + ANSI.reset)
    .replace(/(\u2713 All \d+ gates passed)/, ANSI.grn + ANSI.bold + '$1' + ANSI.reset)
    .replace(/([\u2550-\u256c]+)/g, ANSI.red + '$1' + ANSI.reset);
}
function emit(s) { process.stderr.write(paint(s)); }

// ── Configuration ────────────────────────────────────────────────────────────

// Walk up from .git/hooks/ to find the repo root
function findRepoRoot() {
  // When run as a git hook, CWD is the repo root
  // But __dirname is .git/hooks/ if the hook is there
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // fallback
}

const REPO_ROOT = findRepoRoot();

// Gate store path: configurable via env, defaults to .gate-store.json in repo root
const STORE_PATH = process.env.MCP_GATE_STORE_PATH ||
  path.join(REPO_ROOT, '.gate-store.json');

// Config file for per-repo gate requirements
const CONFIG_PATH = path.join(REPO_ROOT, '.gate-config.json');

const DEFAULT_REQUIRED_GATES = [
  'spec-reviewer', 'architect', 'code-reviewer', 'security-auditor',
  'test-writer', 'qa-acceptance', 'debugger', 'docs-writer', 'ux-evaluator',
];

// ── Load config ──────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) { /* use defaults */ }
  return {};
}

function getRequiredGates(config) {
  return config.required_gates || DEFAULT_REQUIRED_GATES;
}

// ── Check gate store ─────────────────────────────────────────────────────────

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function findReadySession(sessions, requiredGates) {
  // Find the most recent uncommitted session where all gates pass
  const candidates = sessions
    .filter(s => !s.committed)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  for (const session of candidates) {
    const passed = new Set(
      (session.gates || [])
        .filter(g => g.result === 'pass')
        .map(g => g.name)
    );
    const failed = (session.gates || [])
      .filter(g => g.result === 'fail')
      .map(g => g.name);
    const missing = requiredGates.filter(g => !passed.has(g));

    if (missing.length === 0 && failed.length === 0) {
      return { session, allowed: true, missing: [], failed: [] };
    }

    // Return the best candidate even if not ready (for error message)
    if (candidates.indexOf(session) === 0) {
      return { session, allowed: false, missing, failed };
    }
  }

  return { session: null, allowed: false, missing: requiredGates, failed: [] };
}

// ── Hook bypass ──────────────────────────────────────────────────────────────

function shouldBypass() {
  // Allow bypass via env var (for CI, automation, or explicit user override)
  if (process.env.GATE_BYPASS === '1') return 'GATE_BYPASS=1 env var';
  if (process.env.GATE_BYPASS === 'true') return 'GATE_BYPASS=true env var';

  // Allow bypass with --no-verify (git native, already skips hooks)
  // This is handled by git itself, not by us

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const bypass = shouldBypass();
  if (bypass) {
    process.stderr.write(`[convention-gate] BYPASSED: ${bypass}\n`);
    process.stderr.write(`[convention-gate] WARNING: commit proceeding without gate check\n`);
    process.exit(0);
  }

  const config = loadConfig();

  // Check if gate enforcement is enabled
  if (config.enabled === false) {
    process.exit(0); // gates disabled for this repo
  }

  const requiredGates = getRequiredGates(config);
  const sessions = loadStore();

  if (sessions.length === 0) {
    emit('\n');
    emit('╔══════════════════════════════════════════════════════════╗\n');
    emit('║  COMMIT BLOCKED — No gate session found                 ║\n');
    emit('╠══════════════════════════════════════════════════════════╣\n');
    emit('║                                                          ║\n');
    emit('║  Create a gate session and register required reviews     ║\n');
    emit('║  before committing. Use the MCP convention-gate tools:   ║\n');
    emit('║                                                          ║\n');
    emit('║    1. create_gate_session({ description: "..." })        ║\n');
    emit('║    2. register_gate({ session_id, gate_name, result })   ║\n');
    emit('║    3. git commit (this hook checks automatically)        ║\n');
    emit('║                                                          ║\n');
    emit('║  To bypass: GATE_BYPASS=1 git commit                     ║\n');
    emit('╚══════════════════════════════════════════════════════════╝\n');
    emit('\n');
    process.exit(1);
  }

  const { session, allowed, missing, failed } = findReadySession(sessions, requiredGates);

  if (allowed) {
    // All gates passed — allow commit
    const gateCount = session.gates.filter(g => g.result === 'pass').length;
    emit(`[convention-gate] ✓ All ${gateCount} gates passed (session: ${session.description})\n`);
    process.exit(0);
  }

  // Commit blocked
  emit('\n');
  emit('╔══════════════════════════════════════════════════════════╗\n');
  emit('║  COMMIT BLOCKED — Required gates not satisfied          ║\n');
  emit('╠══════════════════════════════════════════════════════════╣\n');

  if (session) {
    emit(`║  Session: ${(session.description || '').substring(0, 45).padEnd(45)}║\n`);
    const passedGates = session.gates.filter(g => g.result === 'pass').map(g => g.name);
    emit(`║  Passed:  ${passedGates.join(', ').substring(0, 45).padEnd(45)}║\n`);
  }

  if (missing.length > 0) {
    emit('║                                                          ║\n');
    emit('║  MISSING gates (not yet registered):                     ║\n');
    for (const g of missing) {
      emit(`║    ✗ ${g.padEnd(50)}║\n`);
    }
  }

  if (failed.length > 0) {
    emit('║                                                          ║\n');
    emit('║  FAILED gates (must fix and re-review):                  ║\n');
    for (const g of failed) {
      emit(`║    ✗ ${g.padEnd(50)}║\n`);
    }
  }

  emit('║                                                          ║\n');
  emit('║  To bypass: GATE_BYPASS=1 git commit -m "..."            ║\n');
  emit('╚══════════════════════════════════════════════════════════╝\n');
  emit('\n');
  process.exit(1);
}

// Run if executed directly (as git hook) or via CLI
if (require.main === module) {
  main();
}

module.exports = { main, findReadySession, loadStore, shouldBypass };
