'use strict';

/**
 * Tests for session-state.cjs — per-conversation state scoping.
 *
 * Regression coverage for SHI-741: the Cursor plugin keyed session state
 * per-workspace, so a `dismissed` status in one chat suppressed observation
 * in every chat in that workspace. State must be keyed per conversation.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Hermetic workspace root — keep test state files isolated from any real
// plugin state and from each other. session-state.cjs reads this lazily.
process.env.CURSOR_PROJECT_DIR = path.join(os.tmpdir(), `forge-test-${crypto.randomUUID()}`);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sessionState = require('../hooks/session-state.cjs');

const created = new Set();
function track(session) {
  created.add(session.stateFilePath);
  return session;
}

test.after(() => {
  for (const fp of created) {
    try { fs.rmSync(fp, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

test('exposes a forSession factory', () => {
  assert.equal(typeof sessionState.forSession, 'function');
});

test('forSession returns a read/write/increment/stateFilePath accessor', () => {
  const session = track(sessionState.forSession(crypto.randomUUID()));
  assert.equal(typeof session.read, 'function');
  assert.equal(typeof session.write, 'function');
  assert.equal(typeof session.increment, 'function');
  assert.equal(typeof session.stateFilePath, 'string');
});

test('distinct conversation ids resolve to distinct state files', () => {
  const a = track(sessionState.forSession(crypto.randomUUID()));
  const b = track(sessionState.forSession(crypto.randomUUID()));
  assert.notEqual(a.stateFilePath, b.stateFilePath);
});

test('the same conversation id resolves to the same state file', () => {
  const id = crypto.randomUUID();
  const a = track(sessionState.forSession(id));
  const b = track(sessionState.forSession(id));
  assert.equal(a.stateFilePath, b.stateFilePath);
});

test('a missing conversation id falls back to a stable workspace-scoped file', () => {
  const fallback = track(sessionState.forSession(undefined));
  const scoped = track(sessionState.forSession(crypto.randomUUID()));
  assert.equal(typeof fallback.stateFilePath, 'string');
  assert.notEqual(fallback.stateFilePath, scoped.stateFilePath);
  // Fallback key is stable regardless of how the absent id is expressed.
  assert.equal(sessionState.forSession(null).stateFilePath, fallback.stateFilePath);
});

test('read returns a fresh state with the documented shape', () => {
  const session = track(sessionState.forSession(crypto.randomUUID()));
  const state = session.read();
  assert.equal(state.status, null);
  assert.equal(state.turn_count, 0);
  assert.equal(state.observer_blocked, false);
  assert.equal(state.active_workflow, false);
});

test('a dismissed status in one conversation does not leak into another', () => {
  const a = track(sessionState.forSession(crypto.randomUUID()));
  const b = track(sessionState.forSession(crypto.randomUUID()));
  a.write({ status: 'dismissed' });
  assert.equal(a.read().status, 'dismissed');
  assert.equal(b.read().status, null, "conversation B must not inherit conversation A's dismissed status");
});

test('increment persists per conversation', () => {
  const session = track(sessionState.forSession(crypto.randomUUID()));
  session.increment('turn_count');
  session.increment('turn_count');
  assert.equal(session.read().turn_count, 2);
});
