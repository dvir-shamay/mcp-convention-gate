'use strict';

// Gate Store — in-memory registry of completed gates with optional file persistence.
// Each gate registration records: gate name, agent, result (pass/fail), timestamp, metadata.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class GateStore {
  constructor(opts = {}) {
    // sessions keyed by session ID
    this.sessions = new Map();
    this.persistPath = opts.persistPath || null;
    this._load();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Start a new gate session (one per sprint/task/PR).
   * Returns a session ID for subsequent gate registrations.
   */
  createSession(description) {
    const id = `gate_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.sessions.set(id, {
      id,
      description: description || 'unnamed session',
      createdAt: new Date().toISOString(),
      gates: [],
      committed: false,
    });
    this._persist();
    return id;
  }

  /**
   * Register that a gate was completed.
   */
  registerGate(sessionId, gate) {
    const session = this._getSession(sessionId);
    const record = {
      name: gate.name,
      agent: gate.agent || 'unknown',
      result: gate.result, // 'pass' | 'fail' | 'warn'
      findings: gate.findings || [],
      registeredAt: new Date().toISOString(),
      metadata: gate.metadata || {},
    };
    session.gates.push(record);
    this._persist();
    return record;
  }

  /**
   * Check whether all required gates have passed for a session.
   * Returns { allowed: bool, missing: string[], failed: string[] }
   */
  checkPrerequisites(sessionId, requiredGates) {
    const session = this._getSession(sessionId);
    const passed = new Set(
      session.gates
        .filter(g => g.result === 'pass')
        .map(g => g.name)
    );
    const failed = session.gates
      .filter(g => g.result === 'fail')
      .map(g => g.name);
    const missing = requiredGates.filter(g => !passed.has(g));
    return {
      allowed: missing.length === 0 && failed.length === 0,
      missing,
      failed,
      registered: [...passed],
    };
  }

  /**
   * Mark session as committed (post-commit record).
   */
  markCommitted(sessionId) {
    const session = this._getSession(sessionId);
    session.committed = true;
    session.committedAt = new Date().toISOString();
    this._persist();
  }

  /**
   * Get session details.
   */
  getSession(sessionId) {
    return this._getSession(sessionId);
  }

  /**
   * List all sessions (most recent first).
   */
  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  _persist() {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = JSON.stringify([...this.sessions.values()], null, 2);
      fs.writeFileSync(this.persistPath, data, 'utf8');
    } catch (e) {
      // Silent — persistence is optional
    }
  }

  _load() {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        if (s && s.id) this.sessions.set(s.id, s);
      }
    } catch (e) {
      // Start fresh
    }
  }
}

module.exports = { GateStore };
