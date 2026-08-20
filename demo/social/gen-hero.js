#!/usr/bin/env node
'use strict';

// Generate the polished "hero" asciicast + a timing manifest.
//
// Same REAL harness flow (flow.js) — genuine hook / git / MCP output — laid out
// as three cleared scenes (blocked -> register -> pass). No in-terminal comments:
// the polished lower-third caption (added at composite time) does the narration,
// and the manifest tells it exactly when each beat starts/ends so it can switch
// the caption the moment the gate passes.
//
//   node demo/social/gen-hero.js --cols 64 --rows 18 --out demo/social/hero.cast

const os = require('os');
const fs = require('fs');
const path = require('path');
const flow = require('../harness/flow.js');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const COLS = parseInt(arg('cols', '64'), 10);
const ROWS = parseInt(arg('rows', '18'), 10);
const OUT = arg('out', path.join(__dirname, 'hero.cast'));

const PROMPT = '\u001b[1;32m$\u001b[0m ';
const TYPE = 0.05;

function parseJsonBlocks(text) {
  const objs = []; let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { if (--depth === 0 && start >= 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (_) {} start = -1; } }
  }
  return objs;
}

function capture() {
  const repo = path.join(os.tmpdir(), `mcp-hero-${process.pid}`);
  try {
    flow.setupRepo(repo);
    flow.installGate(repo);
    flow.writeConfig(repo, [flow.DEMO_GATE]);
    flow.editAndStage(repo, 'feature.js', "export const feature = () => 'hi';\n");
    const blocked = flow.attemptCommit(repo, 'feat: add feature', { FORCE_COLOR: '1' });
    const reg = flow.mcpRegister(repo, flow.DEMO_GATE);
    const ok = flow.attemptCommit(repo, 'feat: add feature', { FORCE_COLOR: '1' });
    const [created, registered] = parseJsonBlocks((reg.stdout || '') + (reg.stderr || '')).filter((o) => o && o.status);
    return { blocked: blocked.stderr + blocked.stdout, created, registered, success: ok.stderr + ok.stdout };
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

const real = capture();

// Blocked banner + pass line come pre-colored from the REAL hook (captured with
// FORCE_COLOR=1 above). The MCP compact view is our own 3-line rendering of the
// server's real values, tinted with the same palette so the beats read together.
const C = { cyn: '\u001b[36m', grn: '\u001b[92m', yel: '\u001b[93m', b: '\u001b[1m', r: '\u001b[0m' };
const mcp =
  `${C.cyn}\u2192${C.r} create_gate_session      ${C.cyn}\u2190${C.r} status: ${C.yel}${real.created.status}${C.r}\n` +
  `${C.cyn}\u2192${C.r} register_gate  code-review = ${C.grn}pass${C.r}\n` +
  `${C.cyn}\u2190${C.r} commit_allowed: ${C.grn}${C.b}${real.registered.commit_allowed}${C.r}   (${real.registered.progress})\n`;

const events = [];
let t = 0;
const beats = [];
const tty = (s) => s.replace(/\r?\n/g, '\r\n');
const push = (d) => events.push([Number(t.toFixed(3)), 'o', d]);
const prompt = () => { push(PROMPT); t += 0.2; };
const type = (c) => { for (const ch of c) { push(ch); t += TYPE; } t += 0.2; push('\r\n'); };
const out = (s, hold) => { t += 0.3; push(tty(s)); t += hold; };
const scene = (name, body) => { const start = t; body(); beats.push({ name, start: Number(start.toFixed(2)), end: Number(t.toFixed(2)) }); };

scene('blocked', () => {
  prompt(); t += 0.6; type('git add feature.js');  // hold the opening prompt as the poster frame
  prompt(); type('git commit -m "feat: add feature"'); out(real.blocked, 2.6);
});
scene('register', () => {
  prompt(); type('node mcp-register.js code-review'); out(mcp, 2.6);
});
scene('passed', () => {
  prompt(); type('git commit -m "feat: add feature"'); out(real.success, 3.2);
});

const header = { version: 2, width: COLS, height: ROWS, title: 'mcp-convention-gate' };
fs.writeFileSync(OUT, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
fs.writeFileSync(OUT.replace(/\.cast$/, '.manifest.json'), JSON.stringify({ duration: Number(t.toFixed(2)), beats }, null, 2) + '\n');
process.stdout.write(`wrote ${OUT}  (${COLS}x${ROWS}, ${events.length} events, ~${t.toFixed(1)}s)\n`);
process.stdout.write(`beats: ${beats.map((b) => `${b.name} ${b.start}-${b.end}`).join('  |  ')}\n`);
