# mcp-convention-gate

> **Enforce your process by construction — not by prompt.**
> No review, no commit.

![mcp-convention-gate demo](demo/demo.gif)

An **MCP server + git pre-commit hook** that **refuses a commit until a required review is registered.** It
enforces the step *outside* the model's prompt and discretion — so an AI coding agent can't skip it, no matter
what the instructions say.

## The problem

Rules written as text — convention files, scoped instructions, even the system prompt — don't make an AI
coding agent perform a costly, skippable step. In a controlled study across nine models, a "review before
commit" rule was **skipped in 135 of 135 trials, at every instruction layer**. The identical rule, enforced by
a gate that refuses the commit, is obeyed **0 of 135 non-compliant — by construction.**

## Requirements

- **Node.js ≥ 18** — uses the built-in test runner and modern APIs.
- **git** — the enforcement layer is a git `pre-commit` hook.
- **An MCP-capable agent/client** — VS Code + Copilot, Claude Desktop, Cursor, or any client that speaks MCP
  over stdio — to register reviews in-loop. (The git hook still enforces even without one.)

## Quickstart

In your repo:

```bash
npx mcp-convention-gate init
```

This installs a `pre-commit` hook, a `.gate-config.json` (which reviews are required), and an MCP server entry
(`.vscode/mcp.json`). From then on:

- Your AI agent registers each completed review through the MCP tools (`create_gate_session`,
  `register_gate`), checks `gate_status` until `commit_allowed` is `true`, then runs the **real** `git commit`
  itself — no MCP call authorizes it, the `pre-commit` hook enforces automatically at that point.
- **Any** commit — from the agent or from a terminal — is blocked until the required reviews are registered.
- Call `guarded_commit` only **after** that commit succeeds, purely to log it to the session's audit trail.
  Calling it *before* committing marks the session committed, and the hook will then block the commit you
  were about to make — see the `guarded_commit` row below.

```bash
npx mcp-convention-gate status   # show current gate status
npx mcp-convention-gate check    # run the pre-commit check manually
```

## How it works

Two enforcement layers, both fail-closed:

1. **Git hook level** — a `pre-commit` hook blocks `git commit` at the OS level, even from the terminal. This
   is the actual enforcement; nothing else needs to run for a commit to be blocked.
2. **MCP tool level** — `gate_status` reports whether `commit_allowed` is `true` before you commit;
   `guarded_commit` is an audit-log call for *after* a commit succeeds, not a gate you pass through to get one.

Pick which reviews are mandatory in `.gate-config.json`:

```json
{
  "enabled": true,
  "required_gates": ["security-review", "tests", "docs"]
}
```

The **default** `required_gates` is an opinionated nine-role review panel (`spec-reviewer`, `architect`,
`code-reviewer`, `security-auditor`, `test-writer`, `qa-acceptance`, `debugger`, `docs-writer`,
`ux-evaluator`) — that's a lot for a first commit. Most projects start lighter and grow into it; edit
`required_gates` to match your workflow, e.g. a single gate to begin:

```json
{ "enabled": true, "required_gates": ["code-review"] }
```

> **If `.gate-config.json` is missing or fails to parse, the gate is treated as disabled** (not enforced) —
> printed as a `WARNING` to stderr, never silently. This favors not disrupting every commit repo-wide over
> silently enforcing from a file most contributors never touch directly; fix or restore the file to configure
> gates intentionally.

> **Session overrides are honored on both layers.** If `create_gate_session` sets its own `required_gates`,
> the git hook enforces that session's list too (it checks a session's own `requiredGates` before falling back
> to `.gate-config.json`) — not just the MCP tools. Omitting `required_gates` at session creation falls back
> to `.gate-config.json` on both sides as well, so the common case (no override) stays in sync automatically.
> They can only diverge if you deliberately pass an ad hoc list to `create_gate_session` that isn't reflected
> anywhere else you track — an intentional escalation, not a footgun.

## MCP tools

The MCP server (`server.js`) exposes five tools over stdio. Your agent calls them in-loop; the `TOOLS`
definition in `server.js` is the source of truth.

| Tool | Required args | Optional args | What it does |
| --- | --- | --- | --- |
| `create_gate_session` | `description` | `required_gates[]` | Opens a session for a task/sprint/PR and returns its `session_id`. Omitting `required_gates` uses the default set. |
| `register_gate` | `session_id`, `gate_name`, `result` (`pass \| fail \| warn`) | `agent`, `findings[]`, `metadata` | Records that one review completed. Only `pass` counts toward satisfying a gate. |
| `guarded_commit` | `session_id`, `commit_message` | `override`, `override_reason` | **Call this AFTER `git commit` succeeds, never before** — it's an audit-log record, not an authorization; calling it first marks the session committed and the hook then blocks the commit you were about to make. Returns `allowed` if every required gate had passed at call time, else `blocked`. `override: true` (with a mandatory `override_reason`) records a self-attested override in the audit trail — it does not touch git; use `GATE_BYPASS` for that. |
| `gate_status` | `session_id` | — | Reports registered / missing / failed gates and whether a commit is allowed. |
| `list_sessions` | — | `limit` (default 10) | Lists sessions, most recent first, for auditing which tasks went through review. |

A `findings` entry is `{ severity: "critical"|"high"|"medium"|"low", description, file?, line? }`.

## Configuring other MCP clients

`init` writes a ready-to-use `.vscode/mcp.json` for VS Code. Other clients use the same launch command — `node`
running this package's `server.js`, with `MCP_GATE_STORE_PATH` pointed at your repo's `.gate-store.json`. The
exact server path is whatever `init` wrote into `.vscode/mcp.json` — copy it from there.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "convention-gate": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-convention-gate/server.js"],
      "env": { "MCP_GATE_STORE_PATH": "/absolute/path/to/your/repo/.gate-store.json" }
    }
  }
}
```

**Cursor** — add the same block to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

**Any MCP client** — launch `node <server.js>` over stdio and set `MCP_GATE_STORE_PATH`. The git hook enforces
independently of the client, so even a client that never reaches the server is still gated at commit time.

## Why it works — advisory vs. enforced

A prompt is a **preference the model weighs.** "Run a review first" competes with the immediate task
("edit and commit"), so a cooperative, action-oriented agent follows the nearest instruction and treats the
distant rule as optional. Nothing stops it skipping.

The gate is **code that returns failure**, not a request. The model can't decide to bypass it any more than it
can decide a locked door is open. It's a **"please knock" sign vs. a locked door** — the prompt is the sign;
the gate is the lock.

## "Isn't this just…"

- **…a Claude Code hook?** Those are vendor-locked and gate tool *calls*; they don't prove a *process step*
  happened, and don't work outside Claude. This is **model-agnostic** — any agent that speaks MCP + git.
- **…a `pre-commit` hook?** `pre-commit` checks file *content* (lint/format). This gates on *process state*
  ("was the review registered?") and exposes it to the agent over MCP so it can satisfy the gate in-loop.
- **…a guardrail?** Guardrails filter the model's *words* (safety / PII / jailbreak). This gates *your
  process*, not the model's words.

## Coverage (honest caveat)

The gate governs every commit that passes through it. An agent could still commit via a path the gate does not
mediate (e.g. a raw shell call outside the hook, or `git commit --no-verify`). Making the guarded path the only
path is a deployment step; **within its coverage, enforcement is by construction.** See
[SECURITY.md](SECURITY.md) for the full trust model and the intentional bypass paths (`GATE_BYPASS`, MCP
`override`).

## Uninstall

```bash
rm .git/hooks/pre-commit                 # remove the enforcement hook
rm .gate-config.json .gate-store.json    # optional: remove gate config + runtime state
```

If `init` backed up a previous hook it saved it as `.git/hooks/pre-commit.backup` — restore that if you had
one. Also delete the `convention-gate` entry from `.vscode/mcp.json` (and any other client config).

## Background

Built on the study *"Advisory, Not Enforceable: Text Cannot Gate Costly Process Steps in AI Coding Agents
(But an Out-of-Band Mechanism Can)."*

## License

MIT © Dvir Shamay
