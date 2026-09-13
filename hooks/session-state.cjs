#!/usr/bin/env node

/**
 * session-state.js — Shared session state module for Forge plugin hooks.
 *
 * Manages a local JSON state file used by all four plugin hooks
 * (prompt-router, workflow-tracker, stop-observer, workflow-guard) to
 * coordinate active-workflow tracking and passive observation.
 *
 * State is scoped per Claude Code session. Each hook event carries a
 * `session_id`; the state file is keyed by hash(cwd + session_id) so two
 * concurrent Claude Code sessions in the same working directory each get
 * an independent workflow slot. When no session id is available (older
 * Claude Code, or the Codex/Cursor builds of this plugin), the key falls
 * back to hash(cwd) — preserving the original single-workflow-per-
 * directory behavior.
 *
 * Usage: `require('./session-state.cjs').forSession(event.session_id)`
 * returns a `{ read, write, increment, stateFilePath }` instance bound to
 * that session's file.
 *
 * State files live in {os.tmpdir()}/forge-observer/{key}.json and
 * auto-expire after 4 hours (matching Forge's server-side TTL).
 *
 * This module is deterministic — no AI, no network calls.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// -- Constants ---------------------------------------------------------------

const STATE_DIR = path.join(os.tmpdir(), 'forge-observer');
// Idle window, not a lifetime cap: state is reset once a session has gone this
// long without a WRITE (see read()). A live session refreshes its own mtime, so
// this only fires on genuine inactivity.
const TTL_MS = 4 * 60 * 60 * 1000;       // 4 hours idle
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-clean stale files
// Hooks are separate processes and PostToolUse hooks can run concurrently.
// A directory is an atomic cross-process mutex on Windows and POSIX. Keep the
// wait bounded: hooks must fail open rather than stall a host indefinitely.
const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 750;
const STALE_LOCK_MS = 5 * 1000;
const PARSE_RETRIES = 4;

function waitBriefly(ms) {
  // Atomics.wait avoids a subprocess and works in the Node main thread.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// -- Helpers -----------------------------------------------------------------

// TEMPORARY DIAGNOSTIC — remove once the cwd-change trigger is identified.
const TRACE_FILE = path.join(STATE_DIR, 'cwd-trace.jsonl');
const TRACE_MAX_BYTES = 2 * 1024 * 1024;
let tracedKey = null; // per-process: collapse repeat stateKey() calls to one line

/**
 * Record the cwd each hook process uses to key session state.
 *
 * `stateKey` mixes `process.cwd()` into the hash, so a cwd change mid-session
 * silently re-keys the state file: `active_workflow` / `status` are orphaned,
 * token capture stops (both the Stop-hook and workflow-guard paths gate on
 * them), and the guard's per-step tool allowlist fails OPEN. That has been
 * observed in the wild but the trigger is unknown — this makes it visible
 * after the fact.
 *
 * Lightweight by construction: one line per hook process (repeat calls within
 * a process are skipped), bounded by TRACE_MAX_BYTES, and fail-soft — a
 * diagnostic must never break a hook. Disable with FORGE_CWD_TRACE=0.
 */
function traceCwd(sessionId, cwd, key) {
  if (process.env.FORGE_CWD_TRACE === '0') return;
  if (tracedKey === key) return;
  tracedKey = key;
  try {
    ensureDir();
    if (fs.existsSync(TRACE_FILE) && fs.statSync(TRACE_FILE).size > TRACE_MAX_BYTES) return;
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify({
      t: new Date().toISOString(),
      hook: path.basename(process.argv[1] || '?', '.cjs'),
      pid: process.pid,
      sid: sessionId || null,
      cwd,
      key,
    })}\n`);
  } catch {
    /* diagnostics must never break a hook */
  }
}

/**
 * Compute the state file key.
 *
 * Keyed on the session id ALONE when one is available. The cwd is only a
 * fallback for the no-session case.
 *
 * It used to be `hash(cwd + ':' + sessionId)`, with the cwd there so that
 * "concurrent sessions in the same working directory get independent state" —
 * but the session id already guarantees that on its own, and mixing in a
 * MUTABLE runtime value meant the key could change underneath a live session.
 * When it did, the hook did not find the old state: it started a brand-new file
 * reporting no active workflow, which silently disabled token capture, the
 * per-step tool allowlist and the CHECKPOINT pin for the rest of the run.
 *
 * Confirmed rather than theorised: one real session produced two state files,
 * and both filenames were reproduced exactly by hashing this function's input —
 * one with the session's own worktree, one with a SECOND repository the run had
 * touched. Session id alone is stable for the session's whole life, so the key
 * no longer depends on where a hook process happens to be standing.
 */
function stateKey(sessionId) {
  const cwd = process.cwd();
  const material = sessionId || cwd;
  const key = crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
  traceCwd(sessionId, cwd, key);
  return key;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${stateKey(sessionId)}.json`);
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function freshState(sessionId) {
  return {
    session_id: sessionId || crypto.randomUUID(),
    session_start: new Date().toISOString(),
    turn_count: 0,
    nudge_shown: false,
    // null | "snoozed" | "dismissed" | "linked" | "logged".
    // SHI-907: a soft decline ("not this one") is persisted AS "snoozed" so
    // the existing re-fire path picks it up unchanged; only the audit
    // `outcome` distinguishes it from an explicit snooze. "dismissed"
    // remains terminal and means "stop asking".
    status: null,
    wake_condition: null,
    // SHI-907: set when the user softly declines the observer offer. NOT
    // cleared by the snooze re-fire, so a returning offer can acknowledge
    // the earlier "no" instead of repeating itself verbatim (AC4).
    declined_once: false,
    // SHI-906: HEAD sha (or ref name) seen when this session was first
    // observed inside a repository. The git-milestone eligibility route in
    // stop-observer.cjs seeds it on first sight and advances it whenever a
    // milestone is consumed; null until then, and forever outside a repo.
    git_head_baseline: null,
    routing_emitted: false,
    active_workflow: false,
    observer_blocked: false,
    last_observer_turn: null,
    last_checkpoint_at: null,
    conversation_id: null,   // Forge conversation ID for active workflow
    // Forge conversation ID of the observe_session run, kept after that
    // workflow completes (conversation_id above is nulled on completion).
    // The periodic Stop-hook checkpoint targets this so it works even
    // from a later process that never ran observe_session itself.
    // Only cleared by the 4h session-state TTL reset.
    last_observer_conversation_id: null,
    current_skill: null,     // Active skill_id or workflow type
    skill_invocations: [],   // Local skills invoked this session [{ name, at }]
    skills_flushed_at_turn: 0, // Turn count at last skill invocation flush
    // Relayed-question pin: set when forge__update_state returns a
    // **CHECKPOINT** response (skill is awaiting user input via
    // AskUserQuestion). Cleared on **RE-ENTRY** (answer flowed back),
    // normal step advance, workflow completion, or abandonment.
    // The workflow-guard PreToolUse hook reads this to deny tool calls
    // other than AskUserQuestion / forge__update_state /
    // forge__abandon_workflow until the user has answered.
    pending_checkpoint: false,
    pending_checkpoint_step: null,    // Skill id pinned for input
    pending_checkpoint_at: null,      // ISO timestamp the pin was set
    // Optional wire metadata parsed from a CHECKPOINT response. Older servers
    // do not publish it; callers must retain the conservative fallback.
    pending_checkpoint_question_id: null,
    pending_checkpoint_response_field: null,
    // Per-step tool-permission allowlist (V2 enforcement).
    //   - current_step_tools: array of category strings the orchestrator
    //     published in the latest **Tool Permissions** line, or null when
    //     unknown (workflow-guard fails open).
    //   - current_step_skill: bare skill_id of the active step, used in
    //     deny messages so the model knows which step is gating.
    current_step_tools: null,
    current_step_skill: null,
    // ── R1 active-time: step_active_since ───────────────────────────────
    // ISO timestamp marking when the CURRENT workflow step began (the
    // client-side analog of the server's `stepStartedAt`). Set by
    // workflow-tracker.cjs on workflow start and on every genuine NEXT STEP
    // advance; NOT advanced on relayed-question CHECKPOINT/RE-ENTRY (the step
    // does not advance there). workflow-guard.cjs reads it as the lower bound
    // of the active-time window it stamps onto forge__update_state's
    // duration_ms. null until the first step begins.
    step_active_since: null,
    // ── observation gate contract: forge_observation_enabled ───────────
    // Per-Claude-Code-session cache of the org-admin's observation
    // toggle (Clerk publicMetadata.forgeObservationEnabled, surfaced
    // on the MCP side as context.org_settings.forgeObservationEnabled).
    // Three-valued semantics:
    //   - `null` (default) — cache miss. The stop-observer hook
    //     proceeds with the normal FORGE OBSERVATION directive; the
    //     MCP-side session_observer skill will read Clerk on the
    //     first Stop in this session and the gated path will write
    //     `false` here if the admin has disabled observation.
    //   - `false` — admin has disabled observation for this org.
    //     stop-observer.cjs exits silently on subsequent Stops
    //     without invoking session_observer again (zero MCP
    //     round-trips for the steady state).
    //   - `true` — admin has explicitly enabled (also the implicit
    //     default when no toggle is set). Same behavior as `null`
    //     for the hook: normal directive on every Stop.
    // Cache TTL is the session lifetime — no timestamp / invalidation
    // logic on either side. Admin toggles take effect at the next
    // Claude Code session start (which begins with a fresh state file).
    // Field name shared verbatim with the Cursor stop-observer.cjs
    // (parity) — do NOT rename without coordinating both halves.
    forge_observation_enabled: null,
  };
}

/**
 * Remove state files older than CLEANUP_AGE_MS.
 * Runs on every read() — cheap because the directory is small.
 */
function cleanupStale() {
  try {
    const files = fs.readdirSync(STATE_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(STATE_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > CLEANUP_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // Best-effort cleanup — never block
  }
}

// -- Public API --------------------------------------------------------------

/**
 * Build a session-scoped state accessor. Pass the `session_id` from the
 * hook event; a falsy value yields the cwd-only fallback file.
 *
 * @param {string|undefined} sessionId — Claude Code session id
 * @returns {{ read: Function, write: Function, increment: Function, stateFilePath: string }}
 */
function forSession(sessionId) {
  const fp = statePath(sessionId);

  function withLock(action) {
    ensureDir();
    const lockPath = `${fp}.lock`;
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    while (true) {
      try {
        fs.mkdirSync(lockPath);
        break;
      } catch (error) {
        if (error && error.code !== 'EEXIST') throw error;
        // A crashed hook can leave a lock behind. Recover only a clearly stale
        // lock, and only after checking its mtime; never delete an active lock.
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Another process may have released it between exists/stat calls.
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out acquiring Forge session-state lock');
        }
        waitBriefly(LOCK_RETRY_MS);
      }
    }
    try {
      return action();
    } finally {
      try { fs.rmdirSync(lockPath); } catch { /* best effort lock cleanup */ }
    }
  }

  function writeRaw(state) {
    ensureDir();
    const temp = `${fp}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
      // rename is atomic on the same volume. Windows can transiently reject a
      // replacement while another hook has just closed the old file.
      let lastError;
      for (let i = 0; i < PARSE_RETRIES; i += 1) {
        try {
          fs.renameSync(temp, fp);
          return;
        } catch (error) {
          lastError = error;
          if (!error || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || i === PARSE_RETRIES - 1) throw error;
          waitBriefly(LOCK_RETRY_MS);
        }
      }
      throw lastError;
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  function parseExisting(strict) {
    if (!fs.existsSync(fp)) return null;
    let lastError;
    for (let i = 0; i < PARSE_RETRIES; i += 1) {
      try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (error) {
        lastError = error;
        waitBriefly(LOCK_RETRY_MS);
      }
    }
    if (strict) throw new Error(`Forge session state is unreadable; refusing to overwrite it: ${lastError?.message || 'parse failure'}`);
    return null;
  }

  // The write path reads under the lock, bypassing read(), so it must apply the
  // same idle expiry. Otherwise the first hook write after the idle window
  // merges into the dead session and refreshes its mtime, reviving the
  // active_workflow, CHECKPOINT pin and per-step allowlist that read() had
  // already reported gone. An expired file is replaced even when unreadable:
  // nothing is still writing a file that has been idle that long.
  function readForWrite() {
    try {
      if (Date.now() - fs.statSync(fp).mtimeMs > TTL_MS) return freshState(sessionId);
    } catch {
      // No file yet — parseExisting reports that as null.
    }
    return parseExisting(true) || freshState(sessionId);
  }

  /**
   * Read this session's state.
   * Returns a fresh state if the file doesn't exist or the session has been
   * IDLE longer than TTL_MS. Also triggers cleanup of files older than
   * CLEANUP_AGE_MS.
   *
   * Pure read — never persists. A read that materialised state made "never
   * seen this session" indistinguishable from "seen it, and it says no
   * workflow is running": a hook firing under a new key did not merely miss the
   * state, it wrote a decoy that then looked like a legitimate fresh session.
   * That is what made a re-key silently disable token capture and the guard's
   * per-step allowlist rather than surfacing as an error. The file is now
   * created by the first write() instead, so an absent file means exactly
   * that, and callers can tell the two apart.
   */
  function read() {
    ensureDir();
    cleanupStale();

    if (!fs.existsSync(fp)) return freshState(sessionId);

    try {
      const state = parseExisting(false);
      if (!state) return freshState(sessionId);

      // Staleness is measured from the last WRITE (file mtime), not from
      // session_start — a sliding idle window rather than an absolute cap.
      //
      // The absolute form reset a session purely for having lasted a long time,
      // which is not what the TTL is for: its job is session-boundary detection
      // ("you left overnight, start fresh"), and that is an IDLE concept. The
      // old form silently wiped active_workflow, current_step_tools,
      // pending_checkpoint, step_active_since and the checkpoint baseline in the
      // middle of any run past the cap — observed on a 5.5h workflow, where it
      // disarmed the CHECKPOINT pin and the per-step allowlist and stopped the
      // engineering-time checkpoint from ever firing again.
      //
      // Sliding needs no touch-on-read: prompt-router writes turn_count on every
      // user turn and workflow-tracker writes on every PostToolUse, so any live
      // session refreshes its own mtime continuously, while a genuinely idle one
      // still ages out on schedule. Deliberately NOT "never expire while
      // active_workflow" — a workflow abandoned without the hook observing it
      // (crash, force-quit, model never calls abandon) would pin the state
      // forever and leave a stale allowlist enforcing indefinitely.
      let lastTouchedMs;
      try {
        lastTouchedMs = fs.statSync(fp).mtimeMs;
      } catch {
        lastTouchedMs = new Date(state.session_start).getTime();
      }
      if (Date.now() - lastTouchedMs > TTL_MS) return freshState(sessionId);

      return state;
    } catch {
      // Corrupted file — start fresh (still without persisting).
      return freshState(sessionId);
    }
  }

  /**
   * Merge updates into this session's state and persist.
   * @param {Object} updates — fields to merge (shallow)
   */
  function write(updates) {
    return withLock(() => {
      // Read after acquiring the lock. This is the read-modify-write boundary:
      // independent hook updates (counters, arrays and unrelated fields) are
      // merged with the latest durable state instead of clobbering each other.
      const state = readForWrite();
      Object.assign(state, updates);
      writeRaw(state);
      return state;
    });
  }

  /**
   * Increment a numeric field by 1 and persist.
   * @param {string} field — the field name to increment
   */
  function increment(field) {
    return withLock(() => {
      const state = readForWrite();
      state[field] = (state[field] || 0) + 1;
      writeRaw(state);
      return state;
    });
  }

  return { read, write, increment, stateFilePath: fp };
}

module.exports = { forSession };
