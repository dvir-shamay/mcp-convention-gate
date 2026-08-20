# demo.tape — VHS script for mcp-convention-gate.
# Render from the package root:  vhs demo/demo.tape   (writes demo/demo.gif)
#
# Fully deterministic — NO live model. The gate is a git pre-commit hook + a
# small review store, so the scripted terminal sequence is itself the proof:
# the same `git commit` is refused with no review and succeeds once one is
# registered. The hidden block prepares a fresh, gated throwaway repo.

Output demo/demo.gif

Require git
Require node
Require pwsh

Set Shell "pwsh"
Set FontSize 16
Set Width 1120
Set Height 1240
Set Padding 22
Set TypingSpeed 45ms

# ── Hidden setup: fresh gated throwaway repo + an `mcp-register` helper ──────
Hide
Type "$GATE = $PWD.Path" Enter
Type "function mcp-register { node ""$GATE\demo\harness\mcp-register.js"" @args }" Enter
Type "$DEMO = (node ""$GATE\demo\harness\setup-repo.js"").Trim()" Enter
Type "Set-Location $DEMO" Enter
Type "Clear-Host" Enter
Show

# ── The setup, in one line of context ───────────────────────────────────────
Type "# This repo requires a registered code review before any commit." Enter
Sleep 1200ms

# ── The agent edits a file and tries to commit — no review yet ──────────────
Type "Set-Content feature.js ""export const feature = () => 'hi'""" Enter
Type "git add feature.js" Enter
Sleep 500ms
Type "git commit -m ""feat: add feature""" Enter
Sleep 3200ms

# ── Register the review through the real MCP server (create_gate_session + register_gate)
Type "# The agent registers the review via the MCP server (real server.js over stdio)." Enter
Sleep 900ms
Type "mcp-register code-review" Enter
Sleep 3200ms

# ── The same commit — now allowed, by construction ──────────────────────────
Type "git commit -m ""feat: add feature""" Enter
Sleep 3600ms
