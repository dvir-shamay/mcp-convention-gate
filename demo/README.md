# Demo

A deterministic terminal demo of `mcp-convention-gate` enforcing a review before a commit.

![mcp-convention-gate demo](demo.gif)

## What it shows

The **same** `git commit`, twice:

1. With no review registered → the pre-commit hook **refuses** it (`COMMIT BLOCKED`, exit 1).
2. After the required review is registered → the commit **succeeds** (`✓ All 1 gates passed`).

No live model is involved, and the register step drives the **real MCP server** (`server.js`) over
stdio — the same `create_gate_session` + `register_gate` calls an agent makes — so the terminal
content is genuine tool output. The gate is a git hook + a small review store, so the scripted
sequence *is* the proof; it is fully reproducible and needs no network.

## Harness

| File | Role |
|---|---|
| `harness/flow.js` | Shared, single source of truth for the demo steps (setup repo, install gate, attempt commit, register review). |
| `harness/setup-repo.js` | Creates a fresh, gated throwaway repo in the OS temp dir and prints its path. |
| `harness/mcp-register.js` | Registers the review by driving the **real MCP server** (`server.js`) over stdio — the actual `create_gate_session` + `register_gate` tool calls — and prints the server's verbatim JSON responses. |
| `harness/verify.js` | Runs the whole flow and **asserts** the block→allow transition. Doubles as a regression guard. |
| `harness/gen-cast.js` | Runs the flow, captures the **real** output, and writes `demo.cast` for agg to render. |
| `demo.cast` | The generated asciicast the GIF is rendered from (browser-free, via agg). |
| `demo.tape` | Alternative [VHS](https://github.com/charmbracelet/vhs) script (Linux/CI) that films the same beats. |

The throwaway repo is created **outside** this package (in the OS temp dir), so the demo never
touches the surrounding repository.

## Verify the flow (no render tool needed)

```bash
node demo/harness/verify.js
```

Expected: every check `PASS`, ending with `OK — demo flow verified`.

## Regenerate the GIF

The GIF is rendered from an asciicast with [`agg`](https://github.com/asciinema/agg) — a single
browser-free binary (no headless Chromium, no `ttyd`), which is the reliable path on Windows
(`winget install asciinema.agg`). Run from the **package root**:

```bash
node demo/harness/gen-cast.js                                                    # writes demo.cast from real output
agg --font-family Consolas --font-size 20 --theme monokai demo/demo.cast demo/demo.gif
```

`gen-cast.js` runs the actual harness flow, so the terminal content in the GIF is **genuine tool
output** — only the prompt, typing, and pacing are synthesized. `demo.cast` and `demo.gif` are
committed so the README renders without a local `agg` install.

### Alternative: VHS (Linux / CI)

`demo.tape` drives the same beats through [VHS](https://github.com/charmbracelet/vhs). VHS needs
`ttyd` + a headless browser, which is unreliable on Windows; prefer it on Linux or CI (e.g.
[`charmbracelet/vhs-action`](https://github.com/charmbracelet/vhs-action)):

```bash
vhs demo/demo.tape
```
