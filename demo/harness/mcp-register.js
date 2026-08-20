#!/usr/bin/env node
'use strict';

// Register a completed review by driving the REAL MCP server (../../server.js)
// over stdio — the exact create_gate_session + register_gate tool calls an AI
// agent makes through MCP. No shortcut: this spawns server.js as a subprocess,
// speaks the MCP protocol to it via the official SDK client, and prints the
// server's VERBATIM JSON responses. Every value shown is the server's own output.
//
// Usage (run from inside the target repo):
//   node /path/to/demo/harness/mcp-register.js code-review

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const gate = process.argv[2] || 'code-review';
const SERVER = path.resolve(__dirname, '..', '..', 'server.js');
const storePath = process.env.MCP_GATE_STORE_PATH || path.join(process.cwd(), '.gate-store.json');

async function main() {
  // Spawn the real server exactly as an MCP client would, pointing it at this
  // repo's gate store (the same file the pre-commit hook reads).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MCP_GATE_STORE_PATH: storePath },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'demo-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const createArgs = { description: 'add feature', required_gates: [gate] };
  const created = await client.callTool({ name: 'create_gate_session', arguments: createArgs });
  process.stdout.write(`\u2192 create_gate_session ${JSON.stringify(createArgs)}\n`);
  process.stdout.write(created.content[0].text + '\n');

  const session = JSON.parse(created.content[0].text);
  const regArgs = { session_id: session.session_id, gate_name: gate, result: 'pass' };
  const registered = await client.callTool({ name: 'register_gate', arguments: regArgs });
  process.stdout.write(`\u2192 register_gate ${JSON.stringify(regArgs)}\n`);
  process.stdout.write(registered.content[0].text + '\n');

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`mcp-register failed: ${err.message}\n`);
  process.exit(1);
});
