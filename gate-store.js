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
   * Register that a gate was completed. Validates `result` against the
   * declared pass|fail|warn enum -- accepting anything else (e.g. a typo
   * like "passed") would silently satisfy neither the passed-set nor the
   * failed-set, leaving the gate permanently "missing" with no diagnostic.
   */
  registerGate(sessionId, gate) {
    const session = this._getSession(sessionId);
    const VALID_RESULTS = new Set(['pass', 'fail', 'warn']);
    if (!VALID_RESULTS.has(gate.result)) {
      throw new Error(`Invalid gate result "${gate.result}" for gate "${gate.name}" -- must be one of: pass, fail, warn`);
    }
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
   *
   * Guards session.gates (a hand-edited/legacy store entry could omit it);
   * validates requiredGates is a non-empty array (a non-array crashes
   * .filter(), an unvalidated empty array silently makes every session
   * "already passing" with zero gates registered); matches gate names
   * case-insensitively; and a gate registered result:'fail' now appears only
   * in `failed`, never also in `missing`.
   */
  checkPrerequisites(sessionId, requiredGates) {
    const session = this._getSession(sessionId);
    const required = (Array.isArray(requiredGates) && requiredGates.length > 0) ? requiredGates : [];
    const gates = session.gates || [];
    const norm = (name) => String(name).trim().toLowerCase();
    const passedNorm = new Set(gates.filter(g => g.result === 'pass').map(g => norm(g.name)));
    const failedNorm = new Set(gates.filter(g => g.result === 'fail').map(g => norm(g.name)));
    const missing = required.filter(g => !passedNorm.has(norm(g)) && !failedNorm.has(norm(g)));
    const failed = required.filter(g => failedNorm.has(norm(g)));
    return {
      allowed: missing.length === 0 && failed.length === 0,
      missing,
      failed,
      registered: [...new Set(gates.filter(g => g.result === 'pass').map(g => g.name))],
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
      // Merge with what's currently on disk before overwriting, so a second
      // concurrent GateStore instance (e.g. two editor windows open on the
      // same repo) can't silently clobber sessions the first instance
      // already wrote and this instance never loaded into memory. Per
      // session ID: one present on disk but not in this instance's memory is
      // adopted as-is; one present in both keeps THIS instance's copy (it's
      // the one that just changed -- _persist() only runs right after a
      // local mutation). Best-effort merge, not a lock: two instances racing
      // to mutate the SAME session id concurrently can still last-writer-win
      // that one session.
      if (fs.existsSync(this.persistPath)) {
        try {
          const onDisk = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
          if (Array.isArray(onDisk)) {
            for (const s of onDisk) {
              if (s && s.id && !this.sessions.has(s.id)) this.sessions.set(s.id, s);
            }
          }
        } catch (e) { /* on-disk copy unreadable -- persist in-memory state only */ }
      }
      const data = JSON.stringify([...this.sessions.values()], null, 2);
      // Atomic write: same-directory temp file + rename, so a crash or a
      // concurrent reader never observes a truncated/partial store.
      const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this.persistPath);
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
