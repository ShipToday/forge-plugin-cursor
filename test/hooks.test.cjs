'use strict';

/**
 * Integration tests for the four Forge hooks — exercised as real
 * subprocesses with JSON events on stdin.
 *
 * Regression coverage for SHI-741: every hook must scope session state to
 * the `conversation_id` on its event, so the stop hook keeps firing passive
 * observation in a fresh chat even after a sibling chat in the same
 * workspace was dismissed.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Hermetic workspace root — shared with the spawned hooks via the env below.
process.env.CURSOR_PROJECT_DIR = path.join(os.tmpdir(), `forge-test-${crypto.randomUUID()}`);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const sessionState = require('../hooks/session-state.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const created = new Set();

function runHook(hookFile, event) {
  return spawnSync(process.execPath, [path.join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: process.env, // carries the hermetic CURSOR_PROJECT_DIR
  });
}

function stdoutJson(res) {
  const out = (res.stdout || '').trim();
  return out ? JSON.parse(out) : {};
}

function hookEventFor(hook, conversationId) {
  switch (hook) {
    case 'prompt-router.cjs':
      return { prompt: 'hello world', conversation_id: conversationId };
    case 'workflow-guard.cjs':
      return { tool_name: 'Read', conversation_id: conversationId };
    case 'workflow-tracker.cjs':
      return {
        tool_name: 'Skill',
        tool_input: JSON.stringify({ skill: 'some-skill' }),
        conversation_id: conversationId,
      };
    default:
      return { conversation_id: conversationId };
  }
}

test.after(() => {
  for (const fp of created) {
    try { fs.rmSync(fp, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

test('stop-observer fires the observation directive for a fresh conversation', () => {
  const id = crypto.randomUUID();
  created.add(sessionState.forSession(id).stateFilePath);
  const res = runHook('stop-observer.cjs', { status: 'completed', loop_count: 0, conversation_id: id });
  assert.equal(res.status, 0, res.stderr);
  assert.match(stdoutJson(res).followup_message || '', /FORGE OBSERVATION/);
});

test('a dismissed conversation does not suppress observation in another conversation', () => {
  const dismissed = crypto.randomUUID();
  const fresh = crypto.randomUUID();
  const dismissedSession = sessionState.forSession(dismissed);
  const freshSession = sessionState.forSession(fresh);
  created.add(dismissedSession.stateFilePath);
  created.add(freshSession.stateFilePath);

  // Conversation A is dismissed.
  dismissedSession.write({ status: 'dismissed' });

  // Conversation B (a different chat in the same workspace) must still fire.
  const resFresh = runHook('stop-observer.cjs', { status: 'completed', loop_count: 0, conversation_id: fresh });
  assert.match(stdoutJson(resFresh).followup_message || '', /FORGE OBSERVATION/,
    'a fresh conversation must fire even when a sibling conversation is dismissed');

  // Conversation A itself stays silent — dismiss is still terminal per chat.
  const resDismissed = runHook('stop-observer.cjs', { status: 'completed', loop_count: 0, conversation_id: dismissed });
  assert.equal(stdoutJson(resDismissed).followup_message || '', '',
    'a dismissed conversation must not re-fire the observer');
});

test('the stop hook embeds the per-conversation state file path in its directive', () => {
  const id = crypto.randomUUID();
  const session = sessionState.forSession(id);
  created.add(session.stateFilePath);
  const res = runHook('stop-observer.cjs', { status: 'completed', loop_count: 0, conversation_id: id });
  assert.ok((stdoutJson(res).followup_message || '').includes(session.stateFilePath),
    'directive must point at the conversation-scoped state file');
});

for (const hook of ['prompt-router.cjs', 'workflow-guard.cjs', 'workflow-tracker.cjs']) {
  test(`${hook} keys state to the conversation it was given`, () => {
    const id = crypto.randomUUID();
    const session = sessionState.forSession(id);
    created.add(session.stateFilePath);
    const res = runHook(hook, hookEventFor(hook, id));
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(session.stateFilePath),
      `${hook} must read/write the conversation-scoped state file`);
  });
}
