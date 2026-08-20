#!/usr/bin/env node
'use strict';

// MCP Convention Gate Server
// Enforces development convention gates — agents must register completed reviews
// before a guarded commit is allowed. Demonstrates enforceable AI conventions.

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

// Persistence file location (in user's home or CWD)
const PERSIST_PATH = process.env.MCP_GATE_STORE_PATH ||
  path.join(process.cwd(), '.gate-store.json');

// ── Initialize Store ─────────────────────────────────────────────────────────

const store = new GateStore({ persistPath: PERSIST_PATH });

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_gate_session',
    description: 'Create a new gate session for a task/sprint/PR. Returns a session ID used for subsequent gate registrations and commit checks.',
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
          description: 'Override the default required gates. If omitted, uses the 9-agent default set.',
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
    description: 'Attempt a guarded commit. Checks that all required gates have been registered with passing results. Returns ERROR with missing/failed gates if prerequisites are not met. Returns OK with commit authorization if all gates passed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The gate session ID to check',
        },
        commit_message: {
          type: 'string',
          description: 'Proposed commit message',
        },
        override: {
          type: 'boolean',
          description: 'Force commit even with missing gates (records override in audit log). Requires explicit user authorization.',
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
  const requiredGates = args.required_gates || DEFAULT_REQUIRED_GATES;

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
          warning: 'COMMIT ALLOWED VIA OVERRIDE — audit trail recorded.',
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

    // All gates passed — allow commit
    store.markCommitted(args.session_id);
    return {
      status: 'allowed',
      message: 'All gates passed. Commit authorized.',
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

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
