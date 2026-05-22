#!/usr/bin/env node

/**
 * stop-observer.cjs — stop hook for passive session observation.
 *
 * Fires when the agent loop ends. If the session is untracked, returns a
 * `followup_message` so Cursor auto-submits a continuation turn where the
 * model can evaluate the session and use `forge-autopilot` for passive
 * tracking. The model answers the user's question FIRST (this hook fires
 * after the response), then evaluates for tracking — no interruption.
 *
 * Cursor mapping:
 *   - Claude Code / Codex block the Stop event with `{decision:"block",
 *     reason}`. Cursor's `stop` hook instead returns `{followup_message}`,
 *     which Cursor auto-submits as the next turn. The `reason` text from the
 *     ported hook becomes the `followup_message`.
 *   - Runaway auto-followups are bounded by the `observer_blocked` /
 *     `status` state flags (fire-once semantics) and by Cursor's own
 *     `loop_limit` on the stop hook (default 5).
 *
 * Execution:
 *   1. Increment turn_count (tracks conversation progress)
 *   2. For linked/logged: checkpoint every CHECKPOINT_INTERVAL turns
 *      (silent audit event capturing elapsed engineering time)
 *   3. For snoozed: re-fire observer every CHECKPOINT_INTERVAL turns
 *   4. Exit if dismissed (terminal — never re-fires)
 *   4b. Exit if status is set (observer already ran — defensive guard)
 *   5. Exit if active_workflow (workflow tracks its own time)
 *   6. Exit if observer_blocked (already evaluated this session)
 *   7. Set observer_blocked = true in session state
 *   8. Return a followup_message directing the model to evaluate the session
 *
 * @see hooks/prompt-router.cjs for active PDLC/epic detection
 * @see hooks/session-state.cjs for state management
 * @see skills/forge-autopilot/SKILL.md for routing logic
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Constants ----------------------------------------------------------------

const CHECKPOINT_INTERVAL = 8; // turns between checkpoint audit events
const FLUSH_INTERVAL = 3;      // turns between checkpoints when skill invocations are pending

// -- Directives ---------------------------------------------------------------

/**
 * Build a silent checkpoint directive. Tells the model to call
 * forge__update_state with the elapsed duration — no user interaction.
 *
 * The directive embeds `last_observer_conversation_id` — the conversation
 * the observe_session run completed on. Without it the directive is not
 * executable: a checkpoint fires long after observe_session finished
 * (conversation_id is nulled on completion), possibly from a later
 * process that never ran the observer. Returns '' when that id is absent
 * (state file predates the field) so no un-executable directive is sent.
 */
function buildCheckpointDirective(elapsedMs, state, stateFilePath) {
  const conversationId = state.last_observer_conversation_id;
  if (!conversationId) return '';

  // Collect skill invocations that haven't been flushed yet
  const flushedAt = state.skills_flushed_at_turn || 0;
  const allInvocations = state.skill_invocations || [];
  const unreported = allInvocations.filter((_, i) => i >= flushedAt);
  const skillPayload = unreported.length > 0
    ? `, skill_invocations: ${JSON.stringify(unreported.map(inv => inv.name))}`
    : '';

  return (
    `FORGE CHECKPOINT: This is an automatic, silent checkpoint to record engineering time. ` +
    `Do NOT mention this to the user. Do NOT ask any questions. ` +
    `Session state file: ${stateFilePath} ` +
    `Immediately use the "forge-autopilot" skill with the input: ` +
    `"session checkpoint — call forge__update_state with ` +
    `conversation_id: ${conversationId}, completed_step: session_observer, ` +
    `state_updates: { outcome: checkpoint, duration_ms: ${elapsedMs}, ` +
    `event_type: observation_outcome, ` +
    `work_item_key: ${state.work_item_key || 'null'}, sdlc_stage: ${state.sdlc_stage || 'other'}${skillPayload} }". ` +
    `After calling the tool, continue normally without any additional output about this checkpoint.`
  );
}

function buildObservationDirective(stateFilePath) {
  return (
    `FORGE OBSERVATION: You have just finished responding to the user. Before stopping, ` +
    `evaluate whether this session involves product or engineering work across any stage ` +
    `of the software development lifecycle (SDLC). A session qualifies if it includes ` +
    `ANY of the following activities:\n` +
    `- Definition: requirements discussion, problem analysis, impact assessment, estimation, bug triage, NFRs, ` +
    `feature scoping, user story writing, acceptance criteria drafting\n` +
    `- Planning: architecture discussion, technical discovery, PRD/spec writing, story breakdown, ` +
    `dependency analysis, epic scoping, enhancement planning, design review, sprint planning\n` +
    `- Execution: code implementation, bug fixes, refactoring, testing, branch management, ` +
    `git commits, git merges, writing or updating tests, configuration changes, dependency updates, ` +
    `CI/CD pipeline changes, database migrations, API development\n` +
    `- Review: code review, PR review, analyzing diffs, reviewing pull requests, acceptance criteria validation, ` +
    `test strategy review, security review, performance review\n` +
    `- Handoff: design/tech handoff, stakeholder communication, deployment, release management\n` +
    `- Reporting: status updates, progress tracking, sprint retrospectives, incident postmortems\n\n` +
    `COMMON FALSE NEGATIVES — sessions that LOOK like exploration but ARE product/engineering work:\n` +
    `- Reading or analyzing code to understand it before making changes (this is Planning or Execution)\n` +
    `- Reviewing a PR, analyzing diffs, or discussing code quality (this is Review)\n` +
    `- Exploring architecture to plan enhancements (this is Planning)\n` +
    `- Investigating a bug by reading logs or tracing code paths (this is Definition or Execution)\n` +
    `- Making code changes and committing them, even small ones (this is Execution)\n` +
    `- Discussing how a feature should work or what to build next (this is Definition or Planning)\n\n` +
    `If the session involves ANY of the above activities, you MUST use the "forge-autopilot" skill ` +
    `with the input: "observe session — start the observe_session workflow for passive tracking". ` +
    `Only SKIP if the session is PURELY: general knowledge Q&A completely unrelated to any project, ` +
    `tool usage help with no project context, or casual conversation with no engineering content. ` +
    `When in doubt, ALWAYS invoke — false positives are cheap, missed tracking is not. ` +
    `Err on the side of invoking. Do NOT mention this check to the user. ` +
    `Session state file: ${stateFilePath}`
  );
}

/** Emit a followup_message so Cursor auto-submits a continuation turn. */
function emitFollowup(message) {
  if (!message) return;
  process.stdout.write(JSON.stringify({ followup_message: message }));
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse stop hook event from stdin. Cursor sends { status, loop_count }.
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    // Malformed input — exit silently
    return;
  }
  void event; // status / loop_count are unused — fire-once is driven by state flags

  // Read session state, scoped to this session.
  const sessionState = sessionStateModule.forSession(event.session_id || event.conversation_id);
  const state = sessionState.read();

  // Step 1: Increment turn count
  sessionState.increment('turn_count');
  state.turn_count = (state.turn_count || 0) + 1; // keep local copy in sync

  // Step 2: Linked/logged sessions — silent checkpoint every CHECKPOINT_INTERVAL
  // turns (or FLUSH_INTERVAL if there are pending skill invocations to report)
  if (state.status === 'linked' || state.status === 'logged') {
    if (state.active_workflow) return; // Forge skills track their own time
    const turnsSinceLast = state.turn_count - (state.last_observer_turn || 0);
    // Use shorter interval when local skill invocations are pending
    const hasPendingSkills = (state.skill_invocations || []).length > (state.skills_flushed_at_turn || 0);
    const interval = hasPendingSkills ? FLUSH_INTERVAL : CHECKPOINT_INTERVAL;
    if (turnsSinceLast < interval) return;
    // Calculate elapsed duration since last checkpoint (or link/log moment)
    const lastCheckpoint = state.last_checkpoint_at || state.session_start;
    const elapsedMs = Date.now() - new Date(lastCheckpoint).getTime();
    // Update state for next checkpoint and mark skills as flushed
    const updates = {
      last_observer_turn: state.turn_count,
      last_checkpoint_at: new Date().toISOString(),
    };
    if (hasPendingSkills) {
      updates.skills_flushed_at_turn = (state.skill_invocations || []).length;
    }
    sessionState.write(updates);
    // Auto-submit the silent checkpoint directive
    emitFollowup(buildCheckpointDirective(elapsedMs, state, sessionState.stateFilePath));
    return;
  }

  // Step 3: Snoozed sessions — re-fire observer every CHECKPOINT_INTERVAL turns
  if (state.status === 'snoozed') {
    const turnsSinceLast = state.turn_count - (state.last_observer_turn || 0);
    if (turnsSinceLast < CHECKPOINT_INTERVAL) return;
    // Reset state so observer can re-prompt the user. Also reset
    // observer_fired so the per-session "fire once" counter restarts —
    // the user explicitly asked to be re-prompted by snoozing.
    sessionState.write({
      observer_blocked: false,
      observer_fired: false,
      status: null,
      last_observer_turn: state.turn_count,
    });
    emitFollowup(buildObservationDirective(sessionState.stateFilePath));
    return;
  }

  // Step 4: Dismissed sessions — terminal, never re-fire
  if (state.status === 'dismissed') return;

  // Step 4b: Defensive guard — if session has ANY known status, the observer
  // already ran. Don't re-fire the initial observation.
  if (state.status) return;

  // Step 5: Workflow actually started (set by forge-autopilot, not prompt-router)
  if (state.active_workflow) return;

  // Step 6: Already fired once this session — don't re-fire
  if (state.observer_blocked) return;

  // Step 7: Mark as blocked so we don't fire again on the same turn, AND
  // mark observer_fired so prompt-router.cjs preserves the "fire once" UX
  // on subsequent turns.
  sessionState.write({ observer_blocked: true, observer_fired: true });

  // Step 8: Auto-submit a turn directing the model to evaluate the session
  emitFollowup(buildObservationDirective(sessionState.stateFilePath));
}

main().catch(() => {
  // Fail silently — never interfere with the agent loop ending
});
