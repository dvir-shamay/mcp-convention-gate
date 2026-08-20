# Security Policy

## Trust model

`mcp-convention-gate` is a **local developer tool**. When you run `npx mcp-convention-gate init`, it:

- installs a git `pre-commit` hook into `.git/hooks/pre-commit` in the current repository,
- writes `.gate-config.json` (which reviews are required) and `.vscode/mcp.json` (an MCP server entry),
- adds `.gate-store.json` to your `.gitignore`.

The gate runs **entirely on your machine**. It reads and writes only local files (`.gate-config.json`,
`.gate-store.json`) and **sends no data anywhere** — no telemetry, no network calls, no phone-home. The MCP
server communicates over local stdio with your MCP client only.

Because `init` installs a git hook, only run it in repositories you trust and review the generated
`pre-commit` hook if your project has policies about git hooks.

## Coverage caveat

The gate governs **every commit that passes through the installed hook**. It is not a sandbox. An actor (or an
agent) with local shell access can still create a commit via a path the hook does not mediate, for example:

- committing with `git commit --no-verify` (git's native hook-skip flag),
- deleting or editing `.git/hooks/pre-commit`,
- writing objects with lower-level git plumbing that bypasses the hook.

Making the guarded path the only path (e.g. restricting who can push, or enforcing the check again in CI /
server-side) is a **deployment decision**. Within its coverage, enforcement is by construction; outside it, the
gate makes no guarantee.

## Intentional bypass paths

These exist by design so the gate never becomes an unrecoverable lock. Both are auditable:

- **`GATE_BYPASS=1` (or `GATE_BYPASS=true`) environment variable** — the pre-commit hook prints a `BYPASSED`
  warning to stderr and allows the commit. Intended for CI, automation, or an explicit human override.
- **MCP `guarded_commit` `override`** — passing `override: true` with an `override_reason` records the override
  (reason, timestamp, missing/failed gates) on the session and authorizes the commit. The reason is mandatory.

If you need to guarantee these cannot be used in a given environment, enforce the gate again outside the
developer's machine (server-side hook or CI check).

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead, report it privately via the
repository's security advisories page or by contacting the maintainer. Include steps to reproduce and the
affected version. You can expect an acknowledgement and, where applicable, a fix or documented mitigation.
