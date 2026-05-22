#!/usr/bin/env node

/**
 * workflow-tracker.cjs — postToolUse hook for Forge workflow state tracking.
 *
 * Fires after every tool call. Silently exits for non-Forge tools.
 * For Forge MCP tools, updates the session state file so that other hooks
 * (stop-observer, prompt-router, workflow-guard) know whether a workflow is
 * active.
 *
 * Handles three transitions:
 *   1. Workflow start: forge__start_workflow succeeds
 *      → writes { active_workflow: true }
 *   2. Observer outcome: forge__update_state with observation_outcome event
 *      → writes { status } so stop-observer checkpoint logic can fire
 *   3. Workflow completion: forge__update_state returns a completed workflow
 *      → writes { active_workflow: false, observer_blocked: true }
 *
 * This makes workflow tracking reliable without depending on the model to
 * write the state file itself.
 *
 * @see hooks/session-state.cjs for state management
 * @see hooks/stop-observer.cjs for the stop hook that reads this state
 * @see skills/forge-autopilot/SKILL.md for the routing skill
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Forge tool detection -----------------------------------------------------
// Separator-agnostic — Cursor names MCP tools `MCP:<tool>` and the joiner is
// not guaranteed, so match the distinctive verb suffix regardless of prefix.

const WORKFLOW_START_RE  = /forge[._]*start_workflow/i;
const WORKFLOW_STATE_RE  = /forge[._]*update_state/i;
const WORKFLOW_ABANDON_RE = /forge[._]*abandon_workflow/i;

// -- Helpers ------------------------------------------------------------------

/**
 * Extract the human-readable text from a postToolUse tool output.
 *
 * MCP tool responses are a structured object — `{ content: [{ type: "text",
 * text: "…" }] }`. Cursor delivers `tool_output` as a JSON-stringified form
 * of that object; `coerceResponse` (in main) parses it back so this helper
 * receives the structured object and can pull the real text payload —
 * escaped `\n` sequences in the raw string would otherwise break the
 * line-oriented regexes below.
 */
function responseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (Array.isArray(response.content)) {
    return response.content
      .map((c) => (c && typeof c.text === 'string') ? c.text : '')
      .join('\n');
  }
  return JSON.stringify(response);
}

/**
 * Check if a tool output looks like a valid Forge workflow response.
 * Forge responses contain a "Conversation ID" line on success.
 */
function isValidWorkflowResponse(response) {
  if (!response) return false;
  return responseText(response).includes('Conversation ID');
}

/**
 * Check if a forge__update_state response indicates workflow completion.
 * Completion responses contain patterns like "(3/3)" where both numbers match,
 * or "Skill ... completed" for standalone skills.
 */
function isWorkflowComplete(response) {
  if (!response) return false;
  const text = responseText(response);

  // Pattern: "(N/N)" where both numbers are equal — all steps done
  const stepMatch = text.match(/\((\d+)\/(\d+)\)/);
  if (stepMatch && stepMatch[1] === stepMatch[2]) return true;

  // Pattern: "Skill **name** completed." — standalone skill finished
  if (/Skill \*\*\w+\*\* completed\./.test(text)) return true;

  return false;
}

/**
 * Check if a forge__abandon_workflow response indicates a successful abandon.
 * Successful abandon responses begin with "**Workflow abandoned**".
 */
function isWorkflowAbandoned(response) {
  if (!response) return false;
  return /\*\*Workflow abandoned\*\*/.test(responseText(response));
}

/**
 * Check if a forge__update_state response indicates a CHECKPOINT — the
 * same step is still running and is awaiting some form of user input.
 * Returns the step name that's pinned, or null.
 */
function extractPendingCheckpointStep(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*\*CHECKPOINT\*\*\s+—\s+"([^"]+)"\s+(?:awaiting user input|paused at confirmation gate)/);
  return match ? match[1] : null;
}

/**
 * Check if a forge__update_state response indicates a relayed-question
 * RE-ENTRY — the user's answer has flowed back and the skill is resuming.
 */
function isRelayedQuestionReentry(response) {
  if (!response) return false;
  return /\*\*RE-ENTRY\*\*\s+—\s+"[^"]+"\s+resumed with user answer/.test(responseText(response));
}

/**
 * Extract the per-step tool-permission allowlist the orchestrator publishes
 * inline as `**Tool Permissions**: cat1, cat2, cat3`. Returns an array of
 * category strings, or null if no line is present (workflow-guard fails open).
 */
function extractToolPermissions(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*\*Tool Permissions\*\*:\s*([^\n]+)/);
  if (!match) return null;
  return match[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the active step's bare skill_id from an update_state response.
 * Tries the NEXT STEP, RE-ENTRY, and CHECKPOINT markers in that order.
 */
function extractCurrentStepSkill(response) {
  if (!response) return null;
  const text = responseText(response);
  const next = text.match(/\*\*NEXT STEP\*\*:\s*"([^"]+)"/);
  if (next) return next[1];
  const reentry = text.match(/\*\*RE-ENTRY\*\*\s+—\s+"([^"]+)"/);
  if (reentry) return reentry[1];
  const checkpoint = text.match(/\*\*CHECKPOINT\*\*\s+—\s+"([^"]+)"/);
  if (checkpoint) return checkpoint[1];
  return null;
}

// Maps session_observer outcome values to local session status.
// "linked" is handled separately (observer launches a workflow → active_workflow: true).
const OUTCOME_TO_STATUS = {
  ad_hoc: 'logged',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
};

/**
 * Coerce a postToolUse tool_input / tool_output value into an object.
 * Cursor delivers these as JSON-stringified strings.
 */
function coerceJson(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

/**
 * Extract observer outcome from a forge__update_state tool input.
 * Returns the local status string if this is an observation_outcome event.
 */
function extractObserverStatus(event) {
  const input = coerceJson(event.tool_input) || {};
  const updates = input.state_updates;
  if (!updates || updates.event_type !== 'observation_outcome') return null;
  return OUTCOME_TO_STATUS[updates.outcome] || null;
}

/**
 * Extract the Forge conversation ID from a workflow response.
 * Handles both plain text and markdown-bold variants.
 */
function extractConversationId(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*?\*?Conversation ID\*?\*?:\s*`?([a-f0-9-]+)`?/i);
  return match ? match[1] : null;
}

/** Extract the workflow id from the tool input. */
function extractSkillContext(event) {
  const input = coerceJson(event.tool_input) || {};
  return input.workflow || null;
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse postToolUse event from stdin. Cursor sends
  // { tool_name, tool_input, tool_output, ...common }.
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    return; // Malformed input — exit silently
  }

  // Scope state to this session.
  const sessionState = sessionStateModule.forSession(event.session_id);

  const toolName = event.tool_name || '';
  // Cursor delivers tool_output as a JSON-stringified result; parse it back
  // so responseText() can read the structured { content: [...] } payload.
  const toolResponse = coerceJson(event.tool_output != null ? event.tool_output : event.tool_response) || '';

  // Track local skill invocations, when the runtime exposes a `Skill` tool.
  // (Cursor invokes skills via auto-discovery rather than an explicit tool
  // call, so this typically does not fire on Cursor — kept for parity and
  // for runtimes that do surface a Skill tool.)
  if (toolName === 'Skill') {
    const toolInput = coerceJson(event.tool_input) || {};
    const skillName = toolInput.skill || null;
    // Ignore forge-autopilot — that's our own routing skill, not a local skill
    if (skillName && skillName !== 'forge-autopilot') {
      const state = sessionState.read();
      const invocations = state.skill_invocations || [];
      invocations.push({ name: skillName, at: new Date().toISOString() });
      sessionState.write({ skill_invocations: invocations });
    }
    return;
  }

  // Fast path: check if this is a Forge tool at all
  const isWorkflowStart = WORKFLOW_START_RE.test(toolName);
  const isStateUpdate = WORKFLOW_STATE_RE.test(toolName);
  const isAbandon = WORKFLOW_ABANDON_RE.test(toolName);

  if (!isWorkflowStart && !isStateUpdate && !isAbandon) return; // Not a Forge tool

  // Workflow abandoned: clear local session state immediately.
  if (isAbandon && isWorkflowAbandoned(toolResponse)) {
    sessionState.write({
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      current_step_tools: null,
      current_step_skill: null,
    });
    return;
  }

  // Workflow start: mark session as active and capture context
  if (isWorkflowStart && isValidWorkflowResponse(toolResponse)) {
    const conversationId = extractConversationId(toolResponse);
    const currentSkill = extractSkillContext(event);
    const toolPermissions = extractToolPermissions(toolResponse);
    const currentStepSkill = extractCurrentStepSkill(toolResponse);
    const updates = {
      active_workflow: true,
      conversation_id: conversationId,
      current_skill: currentSkill,
      // Per-step allowlist. null when the orchestrator did not publish a
      // Tool Permissions line — workflow-guard fails open.
      current_step_tools: toolPermissions,
      current_step_skill: currentStepSkill,
    };
    // Pin the observe_session conversation id separately so the periodic
    // stop-hook checkpoint can target it after the workflow completes.
    if (currentSkill === 'observe_session') {
      updates.last_observer_conversation_id = conversationId;
    }
    sessionState.write(updates);
    return;
  }

  // Observer outcome: when session_observer completes via forge__update_state,
  // persist the status so stop-observer can use it for checkpoint logic.
  if (isStateUpdate) {
    const observerStatus = extractObserverStatus(event);
    if (observerStatus) {
      const statusUpdates = {
        status: observerStatus,
        last_checkpoint_at: new Date().toISOString(),
      };
      if (observerStatus === 'dismissed') {
        statusUpdates.observer_blocked = true;
      }
      sessionState.write(statusUpdates);
      // Don't return — still check for workflow completion below
    }

    // Relayed-question pending_checkpoint pin/clear.
    const pendingStep = extractPendingCheckpointStep(toolResponse);
    if (pendingStep) {
      sessionState.write({
        pending_checkpoint: true,
        pending_checkpoint_step: pendingStep,
        pending_checkpoint_at: new Date().toISOString(),
      });
    } else if (isRelayedQuestionReentry(toolResponse)) {
      sessionState.write({
        pending_checkpoint: false,
        pending_checkpoint_step: null,
        pending_checkpoint_at: null,
      });
    } else if (!isWorkflowComplete(toolResponse)) {
      // Normal step advance ("NEXT STEP") — clear any stale pin.
      const state = sessionState.read();
      if (state.pending_checkpoint) {
        sessionState.write({
          pending_checkpoint: false,
          pending_checkpoint_step: null,
          pending_checkpoint_at: null,
        });
      }
    }

    // Per-step tool-permission allowlist refresh. Each step transition
    // publishes a fresh `**Tool Permissions**: …` line.
    if (!isWorkflowComplete(toolResponse)) {
      const toolPermissions = extractToolPermissions(toolResponse);
      const currentStepSkill = extractCurrentStepSkill(toolResponse);
      if (toolPermissions || currentStepSkill) {
        sessionState.write({
          current_step_tools: toolPermissions,
          current_step_skill: currentStepSkill,
        });
      }
    }
  }

  // Workflow completion: deactivate workflow but keep observer blocked.
  if (isStateUpdate && isWorkflowComplete(toolResponse)) {
    sessionState.write({
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      current_step_tools: null,
      current_step_skill: null,
    });
    return;
  }
}

main().catch(() => {
  // Fail silently — never interfere with the agent's response
});
