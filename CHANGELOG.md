# Changelog

All notable changes to `mcp-convention-gate` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org).

## [Unreleased]

_Nothing yet._

## [0.1.0] — unreleased

First public release. Not yet published to npm.

### Added

- **MCP server** (`server.js`) exposing five tools over stdio: `create_gate_session`, `register_gate`,
  `guarded_commit`, `gate_status`, `list_sessions`.
- **Git `pre-commit` hook** (`hook.js`) that blocks `git commit` until the required gates pass — enforcing at
  the OS level, even for commits made from a terminal.
- **CLI** (`cli.js`): `init` (install the hook, `.gate-config.json`, and a `.vscode/mcp.json` server entry),
  `status`, and `check`.
- **Configurable requirements** via `.gate-config.json` `required_gates`; a `GATE_BYPASS` environment-variable
  escape hatch; and an MCP `override` (with mandatory reason + audit trail) on `guarded_commit`.
- Documentation: `README.md` (requirements, quickstart, MCP-tool reference, multi-client setup, uninstall),
  `SECURITY.md` (trust model, coverage caveat, intentional bypass paths), and `CONTRIBUTING.md`.

### Notes

- The default `required_gates` is an opinionated nine-role review panel. It is configurable — see the README
  for how to start with a single lighter gate and grow into the full panel.

### Fixed

Found by a security/architecture/correctness review pass before first release; all in the same still-unreleased
0.1.0, not a separate version, since nothing had shipped yet.

- **`findReadySession` only ever checked the single newest session.** An older, fully-reviewed session was
  silently ignored whenever a newer, not-yet-reviewed session also existed in the store — an ordinary
  workflow (starting a new session before finishing the previous one). It now searches every uncommitted
  session.
- **The git hook never enforced a session's own `requiredGates` override.** `server.js` already honored a
  per-session override (set via `create_gate_session`) in `register_gate`/`guarded_commit`/`gate_status`, but
  `hook.js` — the actual OS-level enforcement — always used the repo-wide `.gate-config.json` list regardless,
  which could authorize a commit a session's own stricter requirement never actually satisfied.
- **Two unguarded `session.gates.filter()` calls crashed on a session missing its `gates` array** (a
  hand-edited or legacy store record), with no banner and a bare stack trace instead of a clean block.
- **`required_gates` was never validated as a non-empty array.** A typo'd string (e.g. `"required_gates":
  "code-reviewer"` instead of `["code-reviewer"]`) crashed `.filter()` with no banner ever printed, blocking
  every commit repo-wide; an empty array (`[]`) silently produced an always-passing zero-gate session. Both
  `hook.js` and `server.js` now validate and fall back to the built-in default.
- **A missing or corrupted `.gate-config.json` silently enabled full enforcement** with the 9-role default,
  with zero diagnostic — likely surprising for a file most adopters never touch. Both cases are now treated
  as disabled, but with a loud warning, never silently either way.
- **`server.js`'s persistence path used a bare `process.cwd()`**, unlike `hook.js`'s repo-root walk — if the
  MCP server were ever launched from a non-root working directory, it would silently persist to a different
  file than the hook reads, making the gate silently, permanently ineffective. Both now resolve the same way.
- **Gate names are now matched case-insensitively** (e.g. `QA-Acceptance` vs `qa-acceptance`), which also
  fixes a failed gate being listed under both "MISSING" and "FAILED" in the banner simultaneously.
- **`GateStore.registerGate` didn't validate the `pass|fail|warn` enum** — a typo'd result (e.g. `"passed"`)
  silently satisfied neither the passed-set nor the failed-set, leaving the gate permanently "missing" with
  no diagnostic anywhere.
- **`GateStore._persist()` could silently lose sessions written by a second concurrent instance** (e.g. two
  editor windows open on the same repo) — it now merges with on-disk state before overwriting.
- **`GATE_BYPASS` env-var and log-file path overrides had no containment check** — an out-of-repo path is now
  honored (this is trusted, operator-configured input, not attacker input) but loudly flagged if it resolves
  outside the repo root, rather than resolved silently either way.
- **`process.exit()` immediately after several `stderr.write()` calls risked a truncated banner** when stderr
  is a non-TTY pipe (Node does not guarantee async writes flush before an abrupt exit). `hook.js` now sets
  `process.exitCode` and returns, letting the event loop drain naturally.
- Minor: the success banner's gate count is now deduped by name (registering the same gate twice no longer
  inflates the count); `paint()` no longer risks colorizing a free-text description that happens to contain
  the literal substring "COMMIT BLOCKED".
- `server.js` gained a `require.main` guard and `module.exports` (previously ran unconditionally with nothing
  exported), so its handlers can actually be unit-tested — it had zero direct test coverage before this pass.
  21 new tests added across `hook.js`, `GateStore`, and `server.js` (40 total, up from 19).

[Unreleased]: https://github.com/univercitylake/mcp-convention-gate/commits/main
[0.1.0]: https://github.com/univercitylake/mcp-convention-gate/releases/tag/v0.1.0
