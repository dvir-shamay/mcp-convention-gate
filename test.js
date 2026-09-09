#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GateStore } = require('./gate-store.js');
const { findReadySession } = require('./hook.js');

describe('GateStore', () => {
  let store;

  beforeEach(() => {
    store = new GateStore(); // no persistence for tests
  });

  describe('createSession', () => {
    it('creates a session with unique ID', () => {
      const id = store.createSession('Test sprint');
      assert.match(id, /^gate_\d+_[0-9a-f]{8}$/);
    });

    it('stores description', () => {
      const id = store.createSession('S47: harden routes');
      const session = store.getSession(id);
      assert.equal(session.description, 'S47: harden routes');
    });

    it('initializes with empty gates', () => {
      const id = store.createSession('test');
      const session = store.getSession(id);
      assert.deepEqual(session.gates, []);
      assert.equal(session.committed, false);
    });
  });

  describe('registerGate', () => {
    it('records gate with all fields', () => {
      const id = store.createSession('test');
      const record = store.registerGate(id, {
        name: 'code-reviewer',
        agent: 'claude-opus',
        result: 'pass',
        findings: [{ severity: 'low', description: 'minor style issue' }],
        metadata: { model: 'claude-opus-4' },
      });
      assert.equal(record.name, 'code-reviewer');
      assert.equal(record.result, 'pass');
      assert.equal(record.findings.length, 1);
    });

    it('throws for unknown session', () => {
      assert.throws(
        () => store.registerGate('bogus_id', { name: 'x', result: 'pass' }),
        /Session not found/
      );
    });

    it('accumulates multiple gates', () => {
      const id = store.createSession('test');
      store.registerGate(id, { name: 'architect', result: 'pass' });
      store.registerGate(id, { name: 'security-auditor', result: 'pass' });
      const session = store.getSession(id);
      assert.equal(session.gates.length, 2);
    });
  });

  describe('checkPrerequisites', () => {
    it('returns allowed=true when all gates pass', () => {
      const id = store.createSession('test');
      const required = ['code-reviewer', 'architect'];
      store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
      store.registerGate(id, { name: 'architect', result: 'pass' });
      const check = store.checkPrerequisites(id, required);
      assert.equal(check.allowed, true);
      assert.deepEqual(check.missing, []);
      assert.deepEqual(check.failed, []);
    });

    it('returns allowed=false with missing gates', () => {
      const id = store.createSession('test');
      const required = ['code-reviewer', 'architect', 'test-writer'];
      store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
      const check = store.checkPrerequisites(id, required);
      assert.equal(check.allowed, false);
      assert.deepEqual(check.missing, ['architect', 'test-writer']);
    });

    it('returns allowed=false when a gate fails', () => {
      const id = store.createSession('test');
      const required = ['code-reviewer', 'security-auditor'];
      store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
      store.registerGate(id, { name: 'security-auditor', result: 'fail' });
      const check = store.checkPrerequisites(id, required);
      assert.equal(check.allowed, false);
      assert.deepEqual(check.failed, ['security-auditor']);
    });

    it('warn does not count as pass', () => {
      const id = store.createSession('test');
      store.registerGate(id, { name: 'architect', result: 'warn' });
      const check = store.checkPrerequisites(id, ['architect']);
      assert.equal(check.allowed, false);
      assert.deepEqual(check.missing, ['architect']);
    });
  });

  describe('markCommitted', () => {
    it('marks session as committed', () => {
      const id = store.createSession('test');
      store.markCommitted(id);
      const session = store.getSession(id);
      assert.equal(session.committed, true);
      assert.ok(session.committedAt);
    });
  });

  describe('listSessions', () => {
    it('returns all created sessions', () => {
      const id1 = store.createSession('first');
      const id2 = store.createSession('second');
      const list = store.listSessions();
      assert.equal(list.length, 2);
      const ids = list.map(s => s.id);
      assert.ok(ids.includes(id1));
      assert.ok(ids.includes(id2));
    });
  });
});

describe('Integration: full gate workflow', () => {
  it('blocks commit with missing gates, allows after all pass', () => {
    const store = new GateStore();
    const id = store.createSession('S47: harden routes');
    const required = ['spec-reviewer', 'code-reviewer', 'test-writer'];

    // Attempt commit before any gates
    let check = store.checkPrerequisites(id, required);
    assert.equal(check.allowed, false);
    assert.equal(check.missing.length, 3);

    // Register partial
    store.registerGate(id, { name: 'spec-reviewer', result: 'pass' });
    store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
    check = store.checkPrerequisites(id, required);
    assert.equal(check.allowed, false);
    assert.deepEqual(check.missing, ['test-writer']);

    // Complete all
    store.registerGate(id, { name: 'test-writer', result: 'pass' });
    check = store.checkPrerequisites(id, required);
    assert.equal(check.allowed, true);
  });

  it('blocks commit when any gate fails even if all registered', () => {
    const store = new GateStore();
    const id = store.createSession('test');
    const required = ['code-reviewer', 'security-auditor'];

    store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
    store.registerGate(id, { name: 'security-auditor', result: 'fail', findings: [
      { severity: 'critical', description: 'SQL injection in user input' },
    ] });

    const check = store.checkPrerequisites(id, required);
    assert.equal(check.allowed, false);
    assert.deepEqual(check.failed, ['security-auditor']);
  });
});

describe('Hook: findReadySession', () => {
  const REQUIRED = ['code-reviewer', 'architect'];

  it('finds a session with all gates passed', () => {
    const sessions = [{
      id: 'gate_1', gates: [
        { name: 'code-reviewer', result: 'pass' },
        { name: 'architect', result: 'pass' },
      ],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { allowed, missing } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, true);
    assert.deepEqual(missing, []);
  });

  it('rejects a session with missing gates', () => {
    const sessions = [{
      id: 'gate_1', gates: [
        { name: 'code-reviewer', result: 'pass' },
      ],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { allowed, missing } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, false);
    assert.deepEqual(missing, ['architect']);
  });

  it('skips committed sessions', () => {
    const sessions = [{
      id: 'gate_1', gates: [
        { name: 'code-reviewer', result: 'pass' },
        { name: 'architect', result: 'pass' },
      ],
      committed: true, createdAt: new Date().toISOString(),
    }];
    const { allowed, session } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, false);
    assert.equal(session, null);
  });

  it('rejects when a gate failed', () => {
    const sessions = [{
      id: 'gate_1', gates: [
        { name: 'code-reviewer', result: 'pass' },
        { name: 'architect', result: 'fail' },
      ],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { allowed, failed } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, false);
    assert.deepEqual(failed, ['architect']);
  });

  it('returns null session when no sessions exist', () => {
    const { allowed, session, missing } = findReadySession([], REQUIRED);
    assert.equal(allowed, false);
    assert.equal(session, null);
    assert.deepEqual(missing, REQUIRED);
  });

  it('finds an older fully-passing session even when a newer session is not ready', () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    const sessions = [
      { id: 'gate_older', gates: [{ name: 'code-reviewer', result: 'pass' }, { name: 'architect', result: 'pass' }], committed: false, createdAt: older },
      { id: 'gate_newer', gates: [], committed: false, createdAt: newer },
    ];
    const { allowed, session } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, true, 'a fully-reviewed older session must not be ignored just because a newer session also exists');
    assert.equal(session.id, 'gate_older');
  });

  it('honors a session-level requiredGates override instead of always using the repo-wide default', () => {
    const sessions = [{
      id: 'gate_strict',
      requiredGates: ['code-reviewer', 'security-auditor'], // stricter than REQUIRED
      gates: [{ name: 'code-reviewer', result: 'pass' }],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { allowed, missing } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, false, "the session's own stricter requirement must still block even though REQUIRED alone would be satisfied");
    assert.deepEqual(missing, ['security-auditor']);
  });

  it('matches gate names case-insensitively', () => {
    const sessions = [{
      id: 'gate_case',
      gates: [{ name: 'Code-Reviewer', result: 'pass' }, { name: 'ARCHITECT', result: 'pass' }],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { allowed } = findReadySession(sessions, REQUIRED);
    assert.equal(allowed, true);
  });

  it('lists a failed gate only under `failed`, never also under `missing`', () => {
    const sessions = [{
      id: 'gate_failed',
      gates: [{ name: 'code-reviewer', result: 'fail' }, { name: 'architect', result: 'pass' }],
      committed: false, createdAt: new Date().toISOString(),
    }];
    const { failed, missing } = findReadySession(sessions, REQUIRED);
    assert.deepEqual(failed, ['code-reviewer']);
    assert.deepEqual(missing, [], 'a registered-but-failed gate must not also be reported as never-registered');
  });
});

describe('GateStore: additional guards', () => {
  it('registerGate rejects an invalid result value', () => {
    const store = new GateStore();
    const id = store.createSession('enum test');
    assert.throws(
      () => store.registerGate(id, { name: 'code-reviewer', result: 'passed' }), // typo
      /Invalid gate result/
    );
    assert.doesNotThrow(() => store.registerGate(id, { name: 'code-reviewer', result: 'pass' }));
  });

  it('checkPrerequisites guards a session with no gates array', () => {
    const store = new GateStore();
    const id = store.createSession('guard test');
    delete store.getSession(id).gates; // simulate a legacy/hand-edited record
    const result = store.checkPrerequisites(id, ['code-reviewer']);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ['code-reviewer']);
  });

  it('checkPrerequisites matches case-insensitively', () => {
    const store = new GateStore();
    const id = store.createSession('case test');
    store.registerGate(id, { name: 'code-reviewer', result: 'pass' });
    const result = store.checkPrerequisites(id, ['Code-Reviewer']);
    assert.equal(result.allowed, true);
  });

  it('_persist merges with on-disk state so a second concurrent instance does not clobber sessions it never loaded', () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-store-concurrency-')), '.gate-store.json');
    const storeA = new GateStore({ persistPath: storePath });
    const idA = storeA.createSession('created by A'); // persists immediately

    const storeB = new GateStore({ persistPath: storePath }); // loads A's session
    const idB = storeB.createSession('created by B'); // persists A's + B's

    storeA.registerGate(idA, { name: 'x', result: 'pass' }); // A only knows about idA

    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const ids = onDisk.map((s) => s.id);
    assert.ok(ids.includes(idA));
    assert.ok(ids.includes(idB), "B's session must survive A's later persist, not be silently clobbered");
  });
});

describe('hook.js main(): process-level integration', () => {
  const HOOK = path.join(__dirname, 'hook.js');

  function makeTempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-hook-test-'));
    fs.writeFileSync(path.join(dir, '.git'), ''); // marker only -- findRepoRoot() just checks existence
    return dir;
  }

  function runHook(dir, env = {}) {
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: dir,
      env: { ...process.env, GATE_BYPASS: '', NO_COLOR: '1', ...env },
      encoding: 'utf8',
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('missing .gate-config.json: treated as disabled (fail-open), with a warning', () => {
    const dir = makeTempRepo();
    const result = runHook(dir);
    assert.equal(result.code, 0, 'an absent config must never silently start enforcing');
    assert.match(result.stderr, /WARNING/);
    assert.match(result.stderr, /not found/);
  });

  it('malformed .gate-config.json: treated as disabled (fail-open), with a warning', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), '{ enabled: true, not valid json');
    const result = runHook(dir);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /WARNING/);
    assert.match(result.stderr, /failed to parse/);
  });

  it('required_gates as a non-array: falls back to the built-in default instead of crashing', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: 'code-reviewer' }));
    const result = runHook(dir);
    assert.equal(result.code, 1); // still blocks (no session) -- must not crash
    assert.ok(!/TypeError|is not a function/.test(result.stderr));
  });

  it('required_gates: [] falls back to the built-in default, not an always-passing session', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: [] }));
    fs.writeFileSync(path.join(dir, '.gate-store.json'), JSON.stringify([
      { id: 'gate_empty', description: 'empty-gates session', createdAt: new Date().toISOString(), committed: false, gates: [] },
    ]));
    const result = runHook(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /spec-reviewer/);
  });

  it('MCP_GATE_STORE_PATH outside the repo is honored, but loudly warned about', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: false }));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-outside-'));
    const result = runHook(dir, { MCP_GATE_STORE_PATH: path.join(outsideDir, '.gate-store.json') });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /WARNING.*resolves outside the repo root/);
  });

  it('a session description containing "COMMIT BLOCKED" literally is not itself colorized', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: ['code-reviewer'] }));
    fs.writeFileSync(path.join(dir, '.gate-store.json'), JSON.stringify([
      { id: 'gate_literal', description: 'not a real COMMIT BLOCKED banner', createdAt: new Date().toISOString(), committed: false,
        gates: [{ name: 'code-reviewer', result: 'pass', registeredAt: new Date().toISOString(), findings: [] }] },
    ]));
    const result = runHook(dir, { FORCE_COLOR: '1' });
    assert.equal(result.code, 0);
    assert.ok(!result.stderr.includes('\u001b['), 'the success line carries no ANSI, so the description text must not have been colorized either');
  });

  it('registering the same gate name as pass twice does not inflate the reported gate count', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: ['code-reviewer'] }));
    fs.writeFileSync(path.join(dir, '.gate-store.json'), JSON.stringify([
      { id: 'gate_dup', description: 'dup', createdAt: new Date().toISOString(), committed: false,
        gates: [
          { name: 'code-reviewer', result: 'pass', registeredAt: new Date().toISOString(), findings: [] },
          { name: 'code-reviewer', result: 'pass', registeredAt: new Date().toISOString(), findings: [] },
        ] },
    ]));
    const result = runHook(dir);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /All 1 gates passed/);
  });

  it('GATE_BYPASS=1 durably logs the bypass, not just to stderr', () => {
    const dir = makeTempRepo();
    fs.writeFileSync(path.join(dir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: ['code-reviewer'] }));
    const result = runHook(dir, { GATE_BYPASS: '1' });
    assert.equal(result.code, 0);
    assert.match(fs.readFileSync(path.join(dir, '.gate-bypass.log'), 'utf8'), /GATE_BYPASS=1/);
  });
});

describe('server.js: MCP tool handlers', () => {
  let server;
  let tempStorePath;

  before(() => {
    tempStorePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-server-test-')), '.gate-store.json');
    process.env.MCP_GATE_STORE_PATH = tempStorePath;
    server = require('./server.js'); // module-level store is created once, using the env var above
  });

  after(() => {
    delete process.env.MCP_GATE_STORE_PATH;
    try { fs.rmSync(path.dirname(tempStorePath), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('create_gate_session rejects a non-array or empty required_gates override, falling back to the default', () => {
    const bad1 = server.handleCreateSession({ description: 'bad', required_gates: 'not-an-array' });
    assert.equal(bad1.required_gates.length, 9);
    const bad2 = server.handleCreateSession({ description: 'empty', required_gates: [] });
    assert.equal(bad2.required_gates.length, 9);
  });

  it('register_gate -> gate_status: progress and commit_allowed track registrations', () => {
    const created = server.handleCreateSession({ description: 'progress', required_gates: ['a', 'b'] });
    server.handleRegisterGate({ session_id: created.session_id, gate_name: 'a', result: 'pass' });
    let status = server.handleGateStatus({ session_id: created.session_id });
    assert.equal(status.commit_allowed, false);
    server.handleRegisterGate({ session_id: created.session_id, gate_name: 'b', result: 'pass' });
    status = server.handleGateStatus({ session_id: created.session_id });
    assert.equal(status.commit_allowed, true);
  });

  it('guarded_commit: blocked while missing, allowed once satisfied, rejects a second call on the same session', () => {
    const created = server.handleCreateSession({ description: 'guarded', required_gates: ['solo'] });
    assert.equal(server.handleGuardedCommit({ session_id: created.session_id, commit_message: 'wip' }).status, 'blocked');
    server.handleRegisterGate({ session_id: created.session_id, gate_name: 'solo', result: 'pass' });
    assert.equal(server.handleGuardedCommit({ session_id: created.session_id, commit_message: 'wip' }).status, 'allowed');
    assert.equal(server.handleGuardedCommit({ session_id: created.session_id, commit_message: 'again' }).status, 'error');
  });

  it('guarded_commit override never claims to authorize the real git commit', () => {
    const created = server.handleCreateSession({ description: 'override', required_gates: ['unreg'] });
    const withReason = server.handleGuardedCommit({ session_id: created.session_id, commit_message: 'x', override: true, override_reason: 'hotfix' });
    assert.equal(withReason.status, 'override_commit');
    assert.match(withReason.warning, /does not touch git/i);
  });

  it('.gate-config.json fallback: omitting required_gates reads the repo config, not the hardcoded default', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-server-config-'));
    fs.writeFileSync(path.join(repoDir, '.git'), '');
    fs.writeFileSync(path.join(repoDir, '.gate-config.json'), JSON.stringify({ enabled: true, required_gates: ['from-repo-config'] }));
    const prevCwd = process.cwd();
    try {
      process.chdir(repoDir);
      const created = server.handleCreateSession({ description: 'config fallback' });
      assert.deepEqual(created.required_gates, ['from-repo-config']);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
