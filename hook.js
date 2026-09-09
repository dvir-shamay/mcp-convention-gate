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
// Strip control/escape characters (incl. raw ANSI) from any free-text value
// before it is interpolated into the banner -- a crafted session description
// or gate name could otherwise spoof/obscure the banner for a human deciding
// whether to bypass. The box-drawing/ANSI the banner itself emits is added
// afterward by paint(), so this only ever removes bytes that didn't
// originate in this file.
function sanitize(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
function emit(s) { process.stderr.write(paint(s)); }

// Durably log GATE_BYPASS use, in addition to the stderr line below -- stderr
// alone is not retrievable once the terminal scrolls or output isn't captured.
function logBypass(reason) {
  try {
    const logPath = resolveContainedPath(process.env.MCP_GATE_BYPASS_LOG, path.join(REPO_ROOT, '.gate-bypass.log'));
    const user = sanitize(process.env.USERNAME || process.env.USER || 'unknown');
    const line = `${new Date().toISOString()}\t${reason}\tuser=${user}\tcwd=${process.cwd()}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (e) { /* best-effort; never block a commit on log-write failure */ }
}

// Gate names are compared case-insensitively -- a project's own documentation
// may capitalize a role name differently than its .gate-config.json does
// (e.g. "QA-Acceptance" vs "qa-acceptance") and both should match. Original
// casing is kept for anything actually displayed in the banner.
function normalizeGateName(name) { return String(name).trim().toLowerCase(); }

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

// Warn (don't silently substitute) when an env-var path override resolves
// outside the repo root. This is trusted, operator-configured input (e.g. a
// launch-config path substitution), not attacker input -- silently
// redirecting an explicit override to a different file would be its own
// surprise. The point is visibility, not paternalism.
function resolveContainedPath(envValue, defaultPath) {
  if (!envValue) return defaultPath;
  const resolved = path.resolve(envValue);
  const rootResolved = path.resolve(REPO_ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    process.stderr.write(`[convention-gate] WARNING: path override (${envValue}) resolves outside the repo root -- honoring it, but confirm this is intentional\n`);
  }
  return resolved;
}

// Gate store path: configurable via env, defaults to .gate-store.json in repo root
const STORE_PATH = resolveContainedPath(process.env.MCP_GATE_STORE_PATH, path.join(REPO_ROOT, '.gate-store.json'));

// Config file for per-repo gate requirements
const CONFIG_PATH = path.join(REPO_ROOT, '.gate-config.json');

const DEFAULT_REQUIRED_GATES = [
  'spec-reviewer', 'architect', 'code-reviewer', 'security-auditor',
  'test-writer', 'qa-acceptance', 'debugger', 'docs-writer', 'ux-evaluator',
];

// ── Load config ──────────────────────────────────────────────────────────────

// Distinguish "config absent/unparseable" from "config present and
// explicitly enabled:false" -- returning `{}` for both (as a naive
// try/catch would) makes config.enabled `undefined` rather than `=== false`,
// so a missing or corrupted config file would silently ENABLE full
// enforcement with the 9-role default, repo-wide, with zero diagnostic --
// the opposite of what most adopters would expect from a file they never
// touched or that got corrupted by an unrelated merge conflict. Both cases
// are treated as disabled here, but LOUDLY, never silently; if your project
// wants missing-config to mean "fully enforce," set that explicitly instead
// of relying on absence.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { enabled: false, _fallbackReason: '.gate-config.json not found' };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { enabled: false, _fallbackReason: `.gate-config.json failed to parse (${e.message})` };
  }
}

// Validate required_gates is a non-empty array. An unvalidated non-array
// (e.g. a typo'd string) crashes .filter() with no banner ever printed,
// blocking every commit with a bare stack trace; an unvalidated empty array
// silently produces an always-passing zero-gate session.
function getRequiredGates(config) {
  if (Array.isArray(config.required_gates) && config.required_gates.length > 0) {
    return config.required_gates;
  }
  return DEFAULT_REQUIRED_GATES;
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

// A required gate registered result:'fail' now appears only in `failed`,
// never also in `missing` (a naive "missing = anything not passed" filter
// lists a failed gate under BOTH headings in the banner, which reads as a
// contradiction: it was reviewed AND it's unreviewed?). Matching is
// case-insensitive (see normalizeGateName); display always uses the
// session's/config's original casing.
function computeSessionStatus(session, fallbackRequiredGates) {
  const requiredGates = (Array.isArray(session.requiredGates) && session.requiredGates.length > 0)
    ? session.requiredGates
    : fallbackRequiredGates;
  const gates = session.gates || [];
  const passedNorm = new Set(gates.filter(g => g.result === 'pass').map(g => normalizeGateName(g.name)));
  const failedNorm = new Set(gates.filter(g => g.result === 'fail').map(g => normalizeGateName(g.name)));
  const missing = requiredGates.filter(g => {
    const n = normalizeGateName(g);
    return !passedNorm.has(n) && !failedNorm.has(n);
  });
  const failed = requiredGates.filter(g => failedNorm.has(normalizeGateName(g)));
  return { allowed: missing.length === 0 && failed.length === 0, missing, failed };
}

// Searches EVERY uncommitted session, not just the newest. Returning on the
// first loop iteration unconditionally (ready or not) makes a multi-
// candidate search dead past i=0: a fully-reviewed OLDER session would be
// silently ignored whenever a newer, not-yet-reviewed session also exists in
// the store -- an ordinary workflow (starting a new session before finishing
// the previous one). Also honors a session's OWN requiredGates override (set
// via create_gate_session) instead of always using the repo-wide
// .gate-config.json list -- the MCP layer (server.js) already honors a
// per-session override in register_gate/guarded_commit/gate_status; this
// git-hook is the actual OS-level enforcement, so it must not silently use a
// different, looser list for a session that was deliberately given a
// stricter or different one.
function findReadySession(sessions, requiredGates) {
  const candidates = sessions
    .filter(s => !s.committed)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  for (const session of candidates) {
    const status = computeSessionStatus(session, requiredGates);
    if (status.allowed) return { session, allowed: true, missing: [], failed: [] };
  }

  // Nothing ready -- report the most recent candidate's status for the banner.
  if (candidates.length > 0) {
    const newest = candidates[0];
    const status = computeSessionStatus(newest, requiredGates);
    return { session: newest, allowed: false, missing: status.missing, failed: status.failed };
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
    logBypass(bypass);
    process.stderr.write(`[convention-gate] BYPASSED: ${bypass}\n`);
    process.stderr.write(`[convention-gate] WARNING: commit proceeding without gate check\n`);
    process.exitCode = 0;
    return;
  }

  const config = loadConfig();
  if (config._fallbackReason) {
    emit(`[convention-gate] WARNING: ${config._fallbackReason} -- treating as disabled (fail-open) rather than silently enforcing. Fix or restore the file to configure gates intentionally.\n`);
  }

  // Check if gate enforcement is enabled
  if (config.enabled === false) {
    process.exitCode = 0; // gates disabled for this repo
    return;
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
    process.exitCode = 1;
    return;
  }

  const { session, allowed, missing, failed } = findReadySession(sessions, requiredGates);

  if (allowed) {
    // All gates passed — allow commit. Dedupe by (normalized) name: the
    // same gate registered 'pass' twice must not inflate the count. paint()
    // is called ONLY on the fixed phrase, before the free-text description
    // is appended, so a description containing "COMMIT BLOCKED" literally
    // can never get colorized (paint() never sees it).
    const gateCount = new Set((session.gates || []).filter(g => g.result === 'pass').map(g => normalizeGateName(g.name))).size;
    const header = paint(`[convention-gate] ✓ All ${gateCount} gates passed`);
    process.stderr.write(`${header} (session: ${sanitize(session.description)})\n`);
    process.exitCode = 0;
    return;
  }

  // Commit blocked
  emit('\n');
  emit('╔══════════════════════════════════════════════════════════╗\n');
  emit('║  COMMIT BLOCKED — Required gates not satisfied          ║\n');
  emit('╠══════════════════════════════════════════════════════════╣\n');

  if (session) {
    emit(`║  Session: ${sanitize(session.description || '').substring(0, 45).padEnd(45)}║\n`);
    const passedGates = (session.gates || []).filter(g => g.result === 'pass').map(g => sanitize(g.name));
    emit(`║  Passed:  ${passedGates.join(', ').substring(0, 45).padEnd(45)}║\n`);
  }

  if (missing.length > 0) {
    emit('║                                                          ║\n');
    emit('║  MISSING gates (not yet registered):                     ║\n');
    for (const g of missing) {
      emit(`║    ✗ ${sanitize(g).padEnd(50)}║\n`);
    }
  }

  if (failed.length > 0) {
    emit('║                                                          ║\n');
    emit('║  FAILED gates (must fix and re-review):                  ║\n');
    for (const g of failed) {
      emit(`║    ✗ ${sanitize(g).padEnd(50)}║\n`);
    }
  }

  emit('║                                                          ║\n');
  emit('║  To bypass: GATE_BYPASS=1 git commit -m "..."            ║\n');
  emit('╚══════════════════════════════════════════════════════════╝\n');
  emit('\n');
  process.exitCode = 1;
}

// Run if executed directly (as git hook) or via CLI
if (require.main === module) {
  main();
}

module.exports = { main, findReadySession, loadStore, shouldBypass };
