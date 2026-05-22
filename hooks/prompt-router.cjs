#!/usr/bin/env node

/**
 * prompt-router.cjs — beforeSubmitPrompt hook for the ShipToday Forge plugin.
 *
 * Mostly stateful routing — content-based pattern matching for SDLC
 * vocabulary (PRD, story breakdown, tech handoff, etc.) has been removed.
 * The model decides whether to use `forge-autopilot` for those cases via
 * its SKILL.md description.
 *
 * The hook fires for two things the model cannot reliably decide on its own:
 *
 *   1. **Epic key references** (e.g. "explore architecture of SHI-615").
 *      Skill discovery is a soft signal and the model can choose to bypass
 *      Forge when it has alternative tools (Linear MCP, Read, Grep) that
 *      look usable. A regex match on a tracked work item id is a strong
 *      structural signal and gets an ADVISORY routing directive.
 *
 *   2. **Stateful routing** for things stored on disk by other hooks:
 *      - active workflow continuation (workflow-tracker writes this)
 *      - snoozed wake check (session_observer writes this)
 *
 * Cursor caveat — degraded by design:
 *   Cursor's `beforeSubmitPrompt` hook has no context-injection channel. Its
 *   only output is `{ continue, user_message }` — it can BLOCK a prompt but
 *   cannot AUGMENT the turn with advisory context, unlike the Claude Code /
 *   Codex `UserPromptSubmit` hook this is ported from. The routing directives
 *   below are retained verbatim for parity across the three Forge plugins,
 *   but they are inert on Cursor (see `emitDirective`). What still runs and
 *   still matters: the session-state side-effects (observer re-arm,
 *   `routing_emitted`). Routing itself relies on `forge-autopilot` skill
 *   auto-discovery; the stop / preToolUse / postToolUse hooks carry
 *   observation, guarding, and tracking.
 *
 * Execution order (first match wins):
 *   1. Linked → silent (already tracked, no directive needed)
 *   2. Active workflow → emit continuation directive (inert on Cursor)
 *   3. Epic key in prompt → emit epic-key routing directive (inert on Cursor)
 *   4. Snoozed → emit wake check (inert on Cursor)
 *   5. Otherwise → silent (let the model decide via SKILL.md description)
 *
 * @see hooks/session-state.cjs for state management
 * @see hooks/stop-observer.cjs for passive observation
 * @see skills/forge-autopilot/SKILL.md for routing logic
 */

'use strict';

const sessionState = require('./session-state.cjs');

// -- Detection patterns ------------------------------------------------------

// Tracked work item key pattern (e.g. SHI-448, PROJ-123, BUG-42). Purely
// structural — no vocabulary, no workflow knowledge. Matches any sequence
// "<UPPERCASE letters>-<digits>" anywhere in the prompt.
const EPIC_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

// -- Directive sink ----------------------------------------------------------

/**
 * Advisory-directive sink.
 *
 * On Claude Code / Codex the UserPromptSubmit hook's stdout is injected into
 * the turn as advisory context. Cursor's `beforeSubmitPrompt` hook has no
 * such channel — emitting these directives on stdout would only produce a
 * payload Cursor cannot parse (fail-open). So this funnel is intentionally
 * INERT on Cursor: the directive builders below are kept for parity with the
 * sibling Forge plugins, but their text is never delivered. The hook's value
 * on Cursor is its session-state side-effects, not these directives.
 */
function emitDirective(_text) {
  // Intentionally inert on Cursor — see the note above and the file header.
}

// -- Directive builders ------------------------------------------------------

function emitWakeConditionCheck(wakeCondition) {
  emitDirective(
    `FORGE ROUTING: This session is snoozed. ` +
    `Wake condition: "${wakeCondition}". ` +
    `Evaluate if the user's current message signals readiness. ` +
    `If yes, you MUST use the "forge-autopilot" skill BEFORE responding ` +
    `with the input: "observe session — start the observe_session workflow for passive tracking". ` +
    `If no, continue normally and do NOT mention this check to the user.`
  );
}

function emitEpicKeyRouting(key) {
  emitDirective(
    `FORGE ROUTING (advisory): The user's message references work item "${key}". ` +
    `Consider using the "forge-autopilot" skill — Forge orchestrates ` +
    `the SDLC actions (planning, implementation, review, status) for tracked work items, ` +
    `and routing through it keeps the audit trail intact. ` +
    `If you fetch the ticket via Linear/Jira/etc. directly, prefer doing so as part of a ` +
    `Forge workflow rather than ad-hoc; the workflow's first step typically does the fetch ` +
    `and threads the result into the rest of the journey. ` +
    `Pass the user's full message as the input to the skill. ` +
    `If the user's intent clearly does NOT match an SDLC workflow (e.g., they're asking what a ` +
    `ticket reference means in a doc, not acting on it), use your judgment and skip Forge.`
  );
}

function emitWorkflowContinuation(conversationId, currentSkill) {
  const parts = ['FORGE ROUTING: A Forge workflow is active and waiting for user input.'];
  if (currentSkill) parts.push(`The active skill is "${currentSkill}".`);
  if (conversationId) parts.push(`The Forge conversation ID is "${conversationId}".`);
  parts.push(
    'The user\'s message is a response to the workflow\'s last question.',
    'You MUST continue the active Forge workflow — do NOT start a new workflow or treat this as a fresh request.',
    'Pass the user\'s full message as the answer to the pending checkpoint.',
    'If the user has clearly redirected to unrelated work and the workflow no longer applies,',
    'call `forge__abandon_workflow` with a meaningful reason to cleanly close the conversation.',
    'Do NOT silently bypass the workflow — silent bypass leaves the audit trail blind.'
  );
  emitDirective(parts.join(' '));
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse prompt from stdin. Cursor's beforeSubmitPrompt sends
  // { prompt, attachments, conversation_id, ...common }.
  let prompt = '';
  let conversationId;
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    const event = JSON.parse(input);
    prompt = event.prompt || event.message || event.content || '';
    conversationId = event.conversation_id;
  } catch {
    prompt = input.trim();
  }

  // Read session state, scoped to this Cursor conversation.
  const session = sessionState.forSession(conversationId);
  const state = session.read();

  // Re-arm the session observer on each new turn when it's safe to do so.
  //
  // `observer_blocked` is intended as a "this turn only" gate — it prevents
  // the Stop hook from re-firing the observer immediately after a workflow
  // completes on the same turn (workflow-tracker.cjs writes the flag on
  // workflow completion). Without this clear, the flag persists across
  // turns and the observer never fires again for the rest of the session.
  //
  // Only clear when:
  //   - active_workflow is false       (no workflow mid-flight)
  //   - status is null                  (observer has not produced any outcome yet —
  //                                      preserves dismissed/logged/linked/snoozed)
  //   - observer_fired is not true      (observer hasn't already shown its prompt
  //                                      this session — preserves "fire once" UX
  //                                      for the case where the user ignored the
  //                                      first observer prompt)
  if (
    !state.active_workflow
    && !state.status
    && state.observer_blocked
    && !state.observer_fired
  ) {
    session.write({ observer_blocked: false });
    state.observer_blocked = false; // keep local copy in sync for downstream checks
  }

  // Step 1: Linked sessions need no directives — already tracked
  if (state.status === 'linked') return;

  // Step 2: Active workflow → continuation directive (inert on Cursor)
  if (state.active_workflow) {
    emitWorkflowContinuation(state.conversation_id, state.current_skill);
    return;
  }

  // Step 3: Epic key in prompt → routing directive (inert on Cursor). The
  // `routing_emitted` side-effect is still recorded for downstream hooks.
  if (prompt) {
    const keyMatch = prompt.match(EPIC_KEY_RE);
    if (keyMatch) {
      session.write({ routing_emitted: true });
      emitEpicKeyRouting(keyMatch[0]);
      return;
    }
  }

  // Step 4: Snoozed → wake-condition re-evaluation directive (inert on Cursor)
  if (state.status === 'snoozed') {
    const wake = state.wake_condition || 'user signals readiness to move forward';
    emitWakeConditionCheck(wake);
    return;
  }

  // Step 5: No state worth acting on → silent. The model reads the
  // forge-autopilot SKILL.md description and decides whether to use it.
  // stop-observer.cjs handles passive observation after the response.
}

main().catch(() => {
  // Fail silently — never block the user's prompt
});
