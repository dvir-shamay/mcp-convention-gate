#!/usr/bin/env node
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
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
});
