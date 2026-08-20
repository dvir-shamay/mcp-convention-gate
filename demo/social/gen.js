#!/usr/bin/env node
'use strict';

// Parameterized asciicast generator for social-format demo variants.
// Reuses the SAME real harness flow (flow.js) — genuine hook/git/MCP output —
// and lays it out as scenes (clear between beats) sized for a small feed.
//
//   node demo/social/gen.js --mcp compact|verbose --cols N --rows N --out file.cast
//
// Every terminal line is real tool output; only prompt/typing/pacing/layout is ours.

const os = require('os');
const fs = require('fs');
const path = require('path');
const flow = require('../harness/flow.js');

// ── args ─────────────────────────────────────────────────────────────────────
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const MCP = arg('mcp', 'compact');            // compact | verbose
const COLS = parseInt(arg('cols', '64'), 10);
const ROWS = parseInt(arg('rows', '20'), 10);
const OUT = arg('out', path.join(__dirname, 'out.cast'));

const PROMPT = '\u001b[1;32m$\u001b[0m ';
const TYPE = 0.05;

// ── capture the REAL output ──────────────────────────────────────────────────
function parseJsonBlocks(text) {
  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { if (--depth === 0 && start >= 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (_) {} start = -1; } }
  }
  return objs;
}

function capture() {
  const repo = path.join(os.tmpdir(), `mcp-social-${process.pid}`);
  try {
    flow.setupRepo(repo);
    flow.installGate(repo);
    flow.writeConfig(repo, [flow.DEMO_GATE]);
    flow.editAndStage(repo, 'feature.js', "export const feature = () => 'hi';\n");
    const blocked = flow.attemptCommit(repo, 'feat: add feature');
    const reg = flow.mcpRegister(repo, flow.DEMO_GATE);
    const ok = flow.attemptCommit(repo, 'feat: add feature');
    const transcript = (reg.stdout || '') + (reg.stderr || '');
    const [created, registered] = parseJsonBlocks(transcript).filter((o) => o && o.status);
    return { blocked: blocked.stderr + blocked.stdout, transcript, created, registered, success: ok.stderr + ok.stdout };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const real = capture();

// Real MCP values, laid out compactly for small screens (values straight from the server).
const mcpCompact =
  `\u2192 create_gate_session      \u2190 status: ${real.created.status}\n` +
  `\u2192 register_gate  code-review = pass\n` +
  `\u2190 commit_allowed: ${real.registered.commit_allowed}   (${real.registered.progress})\n`;
const mcpBlock = MCP === 'verbose' ? real.transcript : mcpCompact;

// ── build events (scenes: clear between beats) ───────────────────────────────
const events = [];
let t = 0.3;
const tty = (s) => s.replace(/\r?\n/g, '\r\n');
const push = (d) => events.push([Number(t.toFixed(3)), 'o', d]);
const clear = () => { push('\u001b[H\u001b[2J\u001b[3J'); t += 0.35; };
const caption = (s) => { push(`\u001b[2m${s}\u001b[0m\r\n`); t += 0.7; };
const prompt = () => { push(PROMPT); t += 0.2; };
const type = (c) => { for (const ch of c) { push(ch); t += TYPE; } t += 0.2; push('\r\n'); };
const out = (s, hold) => { t += 0.3; push(tty(s)); t += hold; };

// Scene 1 — blocked
caption('# a commit with no review is refused');
prompt(); type('git add feature.js');
prompt(); type('git commit -m "feat: add feature"'); out(real.blocked, 2.4);
clear();

// Scene 2 — register via the real MCP server
caption('# register the review via the real MCP server');
prompt(); type('node mcp-register.js code-review'); out(mcpBlock, 2.6);
clear();

// Scene 3 — allowed
caption('# the same commit is now allowed');
prompt(); type('git commit -m "feat: add feature"'); out(real.success, 3.0);

// ── write cast ───────────────────────────────────────────────────────────────
const header = { version: 2, width: COLS, height: ROWS, title: 'mcp-convention-gate' };
fs.writeFileSync(OUT, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
process.stdout.write(`wrote ${OUT}  (${MCP}, ${COLS}x${ROWS}, ${events.length} events, ~${t.toFixed(1)}s)\n`);
