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

[Unreleased]: https://github.com/univercitylake/mcp-convention-gate/commits/main
[0.1.0]: https://github.com/univercitylake/mcp-convention-gate/releases/tag/v0.1.0
