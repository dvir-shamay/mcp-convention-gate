#!/usr/bin/env node
'use strict';

// MCP Convention Gate Server
// Enforces development convention gates — agents must register completed reviews
// before a guarded commit is allowed. Demonstrates enforceable AI conventions.

const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { GateStore } = require('./gate-store.js');

// ── Configuration ────────────────────────────────────────────────────────────

const VERSION = require('./package.json').version;

// Default required gates — can be overridden per session
const DEFAULT_REQUIRED_GATES = [
  'spec-reviewer',
  'architect',
  'code-reviewer',
  'security-auditor',
  'test-writer',
  'qa-acceptance',
  'debugger',
  'docs-writer',
  'ux-evaluator',
];

// Persistence file location: repo root by default -- can be overridden via
// MCP_GATE_STORE_PATH (e.g. a launch-config path substitution).
function findRepoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const REPO_ROOT = findRepoRoot();

// Warn (don't silently substitute) when an env-var override resolves outside
// the repo root -- mirrors hook.js's resolveContainedPath. Trusted,
// operator-configured input, not attacker input; visibility over paternalism.
function resolveContainedPath(envValue, defaultPath) {
  if (!envValue) return defaultPath;
  const resolved = path.resolve(envValue);
  const rootResolved = path.resolve(REPO_ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    process.stderr.write(`[convention-gate] WARNING: path override (${envValue}) resolves outside the repo root -- honoring it, but confirm this is intentional\n`);
  }
  return resolved;
}
const PERSIST_PATH = resolveContainedPath(process.env.MCP_GATE_STORE_PATH, path.join(REPO_ROOT, '.gate-store.json'));

// Read the SAME .gate-config.json the git hook reads, so a session created
// without an explicit required_gates list matches what the hook will
// actually check, instead of falling back to this file's own hardcoded
// constant while the hook enforces a different list. Calls findRepoRoot()
// fresh each time (not the frozen REPO_ROOT constant used for PERSIST_PATH)
// so a config edit is picked up for every new session without restarting
// the server.
function loadGateConfig() {
  try {
    const configPath = path.join(findRepoRoot(), '.gate-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) { /* fall through to built-in default */ }
  return {};
}

// Validate a required_gates source (caller's arg or .gate-config.json's
// value) is a non-empty array before accepting it -- an unvalidated empty
// array would silently create an always-passing zero-gate session.
function validRequiredGates(candidate) {
  return (Array.isArray(candidate) && candidate.length > 0) ? candidate : null;
}

// ── Initialize Store ─────────────────────────────────────────────────────────

const store = new GateStore({ persistPath: PERSIST_PATH });

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_gate_session',
    description: 'Create a new gate session for a task/sprint/PR. Returns a session ID used for subsequent gate registrations and commit checks. If required_gates is omitted, defaults to this repo\'s .gate-config.json (falling back to the built-in 9-role set if that file is absent).',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the task or sprint (e.g., "S47: harden briefing routes")',
        },
        required_gates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override the default required gates. If omitted, uses .gate-config.json\'s required_gates, or the built-in 9-agent default if that file is absent.',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'register_gate',
    description: 'Register that a review gate has been completed. Called by each agent after finishing its review. The gate result (pass/fail/warn) and any findings are recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The gate session ID (from create_gate_session)',
        },
        gate_name: {
          type: 'string',
          description: 'Name of the gate/agent (e.g., "code-reviewer", "security-auditor")',
        },
        result: {
          type: 'string',
          enum: ['pass', 'fail', 'warn'],
          description: 'Gate result: pass (no blockers), fail (blocking issues found), warn (non-blocking issues)',
        },
        agent: {
          type: 'string',
          description: 'Identity of the reviewing agent',
        },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              description: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['severity', 'description'],
          },
          description: 'List of findings from the review',
        },
        metadata: {
          type: 'object',
          description: 'Additional metadata (model used, duration, etc.)',
        },
      },
      required: ['session_id', 'gate_name', 'result'],
    },
  },
  {
    name: 'guarded_commit',
    description: 'AUDIT RECORD ONLY — call this AFTER `git commit` has already succeeded, never before. It does not perform or authorize the commit: on success it marks the session "committed" in the store, and the git pre-commit hook treats a committed session as used up. Calling this BEFORE running git commit will cause that following commit to be BLOCKED (the hook will see no eligible session). Correct flow: register_gate for every required role -> gate_status to confirm commit_allowed:true -> run the real `git commit` yourself -> optionally call guarded_commit afterward to log it.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The gate session ID to check',
        },
        commit_message: {
          type: 'string',
          description: 'The commit message of the commit that was ALREADY made (this call records it, it does not create it)',
        },
        override: {
          type: 'boolean',
          description: 'Force-record commit even with missing gates (records override in audit log, self-attested — not independently verified). Does NOT bypass the git hook itself — see GATE_BYPASS for that.',
        },
        override_reason: {
          type: 'string',
          description: 'Reason for override (required if override=true)',
        },
      },
      required: ['session_id', 'commit_message'],
    },
  },
  {
    name: 'gate_status',
    description: 'Check the current status of a gate session — which gates have been registered, which are missing, and whether commit is allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The gate session ID to check',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List all gate sessions (most recent first). Useful for auditing which tasks went through full review.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum sessions to return (default: 10)',
        },
      },
    },
  },
];

// ── Tool Handlers ────────────────────────────────────────────────────────────

function handleCreateSession(args) {
  const id = store.createSession(args.description);
  const session = store.getSession(id);
  // Config-file fallback before the hardcoded default, each validated as a
  // non-empty array before being accepted.
  const requiredGates = validRequiredGates(args.required_gates)
    || validRequiredGates(loadGateConfig().required_gates)
    || DEFAULT_REQUIRED_GATES;

  // Store required gates on the session for later checking
  session.requiredGates = requiredGates;
  store._persist();

  return {
    status: 'created',
    session_id: id,
    description: session.description,
    required_gates: requiredGates,
    message: `Gate session created. Register ${requiredGates.length} gates before committing.`,
  };
}

function handleRegisterGate(args) {
  try {
    const record = store.registerGate(args.session_id, {
      name: args.gate_name,
      agent: args.agent || args.gate_name,
      result: args.result,
      findings: args.findings || [],
      metadata: args.metadata || {},
    });

    const session = store.getSession(args.session_id);
    const required = session.requiredGates || DEFAULT_REQUIRED_GATES;
    const check = store.checkPrerequisites(args.session_id, required);

    return {
      status: 'registered',
      gate: record.name,
      result: record.result,
      findings_count: record.findings.length,
      progress: `${check.registered.length}/${required.length} gates passed`,
      remaining: check.missing,
      commit_allowed: check.allowed,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function handleGuardedCommit(args) {
  try {
    const session = store.getSession(args.session_id);
    const required = session.requiredGates || DEFAULT_REQUIRED_GATES;
    const check = store.checkPrerequisites(args.session_id, required);

    if (session.committed) {
      return {
        status: 'error',
        message: 'Session already committed. Create a new session for additional changes.',
      };
    }

    if (!check.allowed) {
      if (args.override) {
        if (!args.override_reason) {
          return {
            status: 'error',
            message: 'Override requires a reason (override_reason parameter).',
          };
        }
        // Record override in session
        session.override = {
          reason: args.override_reason,
          overriddenAt: new Date().toISOString(),
          missing: check.missing,
          failed: check.failed,
        };
        store.markCommitted(args.session_id);
        return {
          status: 'override_commit',
          warning: 'AUDIT RECORD ONLY — this does not touch git. If you have not already run `git commit --no-verify` or set GATE_BYPASS=1, the real commit is still blocked.',
          override_reason: args.override_reason,
          missing_gates: check.missing,
          failed_gates: check.failed,
          commit_message: args.commit_message,
          session_id: args.session_id,
        };
      }

      return {
        status: 'blocked',
        message: 'COMMIT BLOCKED — required gates not satisfied.',
        missing_gates: check.missing,
        failed_gates: check.failed,
        registered_gates: check.registered,
        required_total: required.length,
        action: 'Run the missing agent reviews, then retry guarded_commit.',
      };
    }

    // All gates passed — record the (already-made) commit
    store.markCommitted(args.session_id);
    return {
      status: 'allowed',
      message: 'All gates passed. Recorded as authorized — remember this call must come AFTER the real `git commit`, never before (see tool description).',
      commit_message: args.commit_message,
      session_id: args.session_id,
      gates_passed: check.registered,
      total_findings: session.gates.reduce((n, g) => n + g.findings.length, 0),
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function handleGateStatus(args) {
  try {
    const session = store.getSession(args.session_id);
    const required = session.requiredGates || DEFAULT_REQUIRED_GATES;
    const check = store.checkPrerequisites(args.session_id, required);

    return {
      session_id: args.session_id,
      description: session.description,
      created_at: session.createdAt,
      committed: session.committed,
      required_gates: required,
      registered_gates: session.gates.map(g => ({
        name: g.name,
        result: g.result,
        agent: g.agent,
        findings: g.findings.length,
        at: g.registeredAt,
      })),
      missing_gates: check.missing,
      failed_gates: check.failed,
      commit_allowed: check.allowed,
      progress: `${check.registered.length}/${required.length}`,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function handleListSessions(args) {
  const limit = args.limit || 10;
  const sessions = store.listSessions().slice(0, limit);
  return {
    sessions: sessions.map(s => ({
      id: s.id,
      description: s.description,
      created_at: s.createdAt,
      committed: s.committed,
      gates_registered: s.gates.length,
      gates_passed: s.gates.filter(g => g.result === 'pass').length,
      has_override: !!s.override,
    })),
    total: store.sessions.size,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function dispatch(toolName, args) {
  switch (toolName) {
    case 'create_gate_session': return handleCreateSession(args);
    case 'register_gate': return handleRegisterGate(args);
    case 'guarded_commit': return handleGuardedCommit(args);
    case 'gate_status': return handleGateStatus(args);
    case 'list_sessions': return handleListSessions(args);
    default: throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'mcp-convention-gate', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = dispatch(name, args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Guard main() behind require.main (matches hook.js's own pattern) and
// export the pure dispatch/handler functions + store, so this file can
// actually be unit-tested (imported + called directly) instead of only ever
// being smoke-tested by spawning it as a live stdio process.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  dispatch,
  handleCreateSession,
  handleRegisterGate,
  handleGuardedCommit,
  handleGateStatus,
  handleListSessions,
  store,
  TOOLS,
};
