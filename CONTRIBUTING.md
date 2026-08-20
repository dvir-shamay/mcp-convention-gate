# Contributing to mcp-convention-gate

Thanks for your interest! This is a small, focused tool — a git `pre-commit` hook plus an MCP server that
refuses a commit until the required reviews are registered. Contributions that keep it small, honest, and
dependency-light are very welcome.

## Development setup

```bash
git clone https://github.com/univercitylake/mcp-convention-gate.git
cd mcp-convention-gate
npm ci
```

Requirements: **Node.js ≥ 18** and **git**.

## Running the checks

```bash
npm test                     # unit tests (node --test test.js)
node demo/harness/verify.js  # end-to-end proof of the block → allow flow (8/8, no network, no model)
npm pack --dry-run           # MUST list exactly 7 files (see "Packaging invariant" below)
```

All three must pass before a change is ready.

## Packaging invariant

The published tarball ships **only** the runtime core: `cli.js`, `server.js`, `hook.js`, `gate-store.js`
(npm adds `package.json`, `README.md`, `LICENSE`) — **7 files total**. This is enforced by the `files`
allowlist in `package.json`. Never widen `files` to include research artifacts, evaluation harnesses, demo
assets, or internal notes. If you add a runtime file, add it to `files` and confirm `npm pack --dry-run` is
still a clean list.

## Code style

- Vanilla Node.js, CommonJS (`'use strict'`), no build step, no runtime dependencies beyond
  `@modelcontextprotocol/sdk`.
- Keep the enforcement fail-closed: when in doubt, block the commit rather than allow it.
- Prefer clarity over cleverness; this code guards other people's commits.

## Pull requests

1. Open an issue describing the change first for anything non-trivial.
2. Include or update tests for behavior changes; bug fixes should add a regression test.
3. Keep the diff focused — one logical change per PR.
4. Make sure the three checks above pass.

## Versioning

This project follows [Semantic Versioning](https://semver.org). While the version is `0.x`, minor releases may
include breaking changes and patch releases are fixes; from `1.0.0` onward, breaking changes bump the major
version. For semver purposes the **public surface** is: the CLI commands and flags, the five MCP tool names and
their input schemas, the `.gate-config.json` shape, and the `GATE_BYPASS` / `MCP_GATE_STORE_PATH` environment
variables. Releases are tagged `vX.Y.Z` on this repository. See [CHANGELOG.md](CHANGELOG.md).

## License

By contributing you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
