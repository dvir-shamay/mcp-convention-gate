#!/usr/bin/env node
'use strict';

// Generate a deterministic asciicast (.cast) of the demo, then render it to GIF
// with agg (asciinema gif generator) — a browser-free, Windows-native path that
// needs no ttyd and no headless Chromium (unlike VHS).
//
// The terminal CONTENT is real: this runs the actual harness flow and captures
// the genuine hook banner + git output. Only the prompt/typing/pacing is
// synthesized, so the animation is faithful and reproducible.
//
// Usage:
//   node demo/harness/gen-cast.js            # writes demo/demo.cast
//   agg --font-family Consolas demo/demo.cast demo/demo.gif

const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  setupRepo, installGate, writeConfig, editAndStage, attemptCommit, mcpRegister, DEMO_GATE,
} = require('./flow.js');

const COLS = 110;
const PROMPT = '\u001b[1;32mmcp-gate-demo\u001b[0m $ '; // bold-green cwd + "$ "
const TYPE_DELAY = 0.045;   // seconds per typed character
const OUT_DELAY = 0.35;     // pause before a command's output appears

// ── Capture the real demo output ─────────────────────────────────────────────

function capture() {
  const repoDir = path.join(os.tmpdir(), `mcp-gate-cast-${process.pid}`);
  try {
    setupRepo(repoDir);
    installGate(repoDir);
    writeConfig(repoDir, [DEMO_GATE]);
    editAndStage(repoDir, 'feature.js', "export const feature = () => 'hi';\n");

    const blocked = attemptCommit(repoDir, 'feat: add feature');
    const reg = mcpRegister(repoDir, DEMO_GATE);
    const ok = attemptCommit(repoDir, 'feat: add feature');

    return {
      blocked: blocked.stderr + blocked.stdout,
      register: (reg.stdout || '') + (reg.stderr || ''),
      success: ok.stderr + ok.stdout,
    };
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

// ── Build asciicast v2 events ────────────────────────────────────────────────

const events = [];
let t = 0.4;
const tty = (s) => s.replace(/\r?\n/g, '\r\n'); // programs' \n render as \r\n on a TTY
const push = (data) => events.push([Number(t.toFixed(3)), 'o', data]);

function caption(text) {           // dim, prompt-less narration line
  push(`\u001b[2m${text}\u001b[0m\r\n`);
  t += 0.9;
}
function prompt() { push(PROMPT); t += 0.25; }
function type(cmd) {
  for (const ch of cmd) { push(ch); t += TYPE_DELAY; }
  t += 0.25;
  push('\r\n');                    // Enter
}
function output(text, hold) { t += OUT_DELAY; push(tty(text)); t += hold; }

const real = capture();

caption('# This repo requires a registered code review before any commit.');
prompt(); type('git add feature.js'); t += 0.4;
prompt(); type('git commit -m "feat: add feature"'); output(real.blocked, 2.8);
caption('# The agent registers the review via the MCP server \u2014 real server.js over stdio:');
prompt(); type('node demo/harness/mcp-register.js code-review'); output(real.register, 3.2);
prompt(); type('git commit -m "feat: add feature"'); output(real.success, 3.2);

// ── Write the .cast (header line + one JSON array per event) ──────────────────

// Size the terminal to the content so the whole session shows without scrolling.
const rows = events.reduce((n, e) => n + ((e[2].match(/\n/g) || []).length), 0) + 2;
const header = { version: 2, width: COLS, height: rows, title: 'mcp-convention-gate' };
const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
const outPath = path.join(__dirname, '..', 'demo.cast');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
process.stdout.write(`wrote ${outPath} (${events.length} events, ~${t.toFixed(1)}s)\n`);
