#!/usr/bin/env node

/**
 * workflow-guard.cjs — preToolUse hook for Forge workflow enforcement.
 *
 * Fires before every tool call. Reads session state and decides whether the
 * tool may proceed. Two layers of enforcement:
 *
 *   1. CHECKPOINT enforcement: when the orchestrator has emitted a
 *      relayed-question CHECKPOINT and the workflow-tracker hook has set
 *      `pending_checkpoint: true`, only the user-question relay /
 *      forge__update_state / forge__abandon_workflow / read-only inspection
 *      may proceed.
 *
 *   2. Per-step tool_permissions enforcement: when a workflow is active but
 *      no checkpoint is pending, the orchestrator publishes a
 *      `**Tool Permissions**: cat1, cat2, …` line on every step transition.
 *      The workflow-tracker hook mirrors that into `current_step_tools`.
 *      We deny tools whose category is not in the allowlist for the active
 *      step. Universal tools (Forge orchestration, read-only inspection,
 *      the user-question relay) are always allowed regardless of step.
 *
 * Defensive defaults:
 *   - If no workflow is active, allow.
 *   - If `current_step_tools` is null, fail open — only CHECKPOINT runs.
 *   - If the tool name does not map to any known category, allow. Unknown
 *     tools (custom MCP connectors, future built-ins) should not be blocked
 *     by a closed-world allowlist.
 *
 * Cursor hook contract: preToolUse hooks emit `{ "permission": "deny",
 * "agent_message": "...", "user_message": "..." }` on stdout to refuse a
 * tool. `{ "permission": "allow" }` or no output lets the call proceed.
 *
 * @see hooks/workflow-tracker.cjs for the state writes this hook reads
 * @see hooks/session-state.cjs for state management
 */

'use strict';

const sessionState = require('./session-state.cjs');

// -- Universal allowlist ----------------------------------------------------
// Always-allowed tools regardless of active step. Forge orchestration,
// read-only primitives, and the user-question relay path.

const ALWAYS_ALLOWED_BARE_NAMES = new Set([
  // Forge orchestration — model needs these to advance / exit
  'forge__update_state',
  'forge__abandon_workflow',
  'forge__start_workflow',
  // Question relay — the way for the model to talk to the user mid-step
  'AskUserQuestion',
  // Read-only or local-only primitives — cannot mutate external state
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
]);

// Separator-agnostic match for Forge orchestration tools. Cursor names MCP
// tools `MCP:<tool>` and the exact server/tool joiner is not guaranteed, so
// this catches `forge__update_state`, `forge.update_state`, `forge_update_state`,
// etc. — the Forge orchestration tools must never be denied.
const FORGE_ORCHESTRATION_RE =
  /forge[._]*(start_workflow|update_state|abandon_workflow|get_workflow|save_workflow|delete_workflow|list_skills_catalog)/i;

// Read-only MCP tool name prefixes (always-allowed during workflow time).
const READONLY_PREFIXES = ['list_', 'get_', 'search_', 'query_', 'fetch_', 'read_', 'notion-search', 'notion-fetch', 'notion-get-'];

// -- Category → tool patterns ----------------------------------------------
// Maps the abstract categories the orchestrator publishes into concrete
// tool name regexes. Each entry is checked against the bare tool name
// (after stripping the `MCP:` / `mcp__<uuid>__` prefix).
//
// The categories are deliberately coarse — the goal is to catch silent
// bypass (e.g., Write during readiness_check), not to micromanage every
// connector.

const CATEGORY_PATTERNS = {
  read_code:    [/^Read$/, /^Grep$/, /^Glob$/],
  ask_user:     [/^AskUserQuestion$/],
  web:          [/^WebFetch$/, /^WebSearch$/],

  tracker_read: [
    /^list_issues$/, /^get_issue$/, /^get_issue_status$/, /^list_issue_statuses$/,
    /^list_issue_labels$/, /^list_project_labels$/, /^list_comments$/,
    /^list_projects$/, /^get_project$/, /^list_milestones$/, /^get_milestone$/,
    /^list_documents$/, /^get_document$/, /^search_documentation$/,
    /^list_users$/, /^get_user$/, /^list_teams$/, /^get_team$/,
    /^list_cycles$/, /^get_attachment$/, /^extract_images$/,
    /^searchJiraIssuesUsingJql$/, /^getJiraIssue$/,
    /^searchConfluenceUsingCql$/, /^getConfluencePage$/,
    /^search_threads$/, /^get_thread$/, /^list_drafts$/, /^list_labels$/,
  ],
  tracker_write: [
    /^save_issue$/, /^create_issue$/, /^update_issue$/,
    /^save_comment$/, /^create_comment$/, /^delete_comment$/,
    /^save_milestone$/, /^save_project$/, /^save_document$/,
    /^create_attachment$/, /^delete_attachment$/, /^upload_attachments$/,
    /^create_issue_label$/,
    /^createJiraIssue$/, /^updateJiraIssue$/,
    /^create_label$/, /^create_draft$/,
  ],

  docs_read:    [
    /^notion-search$/, /^notion-fetch$/, /^notion-get-comments$/,
    /^notion-get-teams$/, /^notion-get-users$/,
  ],
  docs_write:   [
    /^notion-create-/, /^notion-update-/, /^notion-move-/, /^notion-duplicate-/,
  ],

  messaging:    [/^slack_/, /^send_message$/],
  calendar:     [
    /^list_calendars$/, /^list_events$/, /^get_event$/, /^create_event$/,
    /^update_event$/, /^delete_event$/, /^respond_to_event$/, /^suggest_time$/,
  ],
  design:       [
    /^get_design_context$/, /^get_screenshot$/, /^get_metadata$/, /^get_figjam$/,
    /^get_libraries$/, /^get_variable_defs$/, /^use_figma$/,
    /^add_code_connect_map$/, /^get_code_connect_map$/, /^get_code_connect_suggestions$/,
    /^get_context_for_code_connect$/, /^send_code_connect_mappings$/,
    /^create_design_system_rules$/, /^search_design_system$/,
    /^upload_assets$/, /^create_new_file$/, /^generate_diagram$/, /^whoami$/,
  ],
  meetings:     [
    /^search_meetings$/, /^get_meeting_transcript$/, /^get_meetings$/,
    /^list_meetings$/, /^list_meeting_folders$/, /^query_granola_meetings$/,
    /^get_account_info$/,
  ],

  // Cursor's shell tool is `Shell`; Bash/PowerShell kept for cross-tool parity.
  code_edit:    [/^Edit$/, /^Write$/, /^NotebookEdit$/, /^apply_patch$/],
  shell:        [/^Shell$/, /^Bash$/, /^PowerShell$/],
};

// -- Helpers ----------------------------------------------------------------

/**
 * Strip an MCP prefix from a tool name, returning the bare tool name.
 * Handles Cursor's `MCP:<tool>` form and the Claude Code / Codex
 * `mcp__<server>__<tool>` form. Non-MCP tool names are returned as-is.
 */
function bareName(toolName) {
  if (!toolName) return '';
  let name = String(toolName);
  // Cursor: MCP tool calls arrive as "MCP:<tool_name>".
  if (name.startsWith('MCP:')) name = name.slice(4);
  // Claude Code / Codex: "mcp__<server-uuid>__<tool>".
  const m = name.match(/^mcp__[^_]+(?:-[^_]+)*__(.+)$/);
  if (m) name = m[1];
  return name;
}

function isUniversallyAllowed(bare) {
  if (ALWAYS_ALLOWED_BARE_NAMES.has(bare)) return true;
  if (FORGE_ORCHESTRATION_RE.test(bare)) return true;
  for (const prefix of READONLY_PREFIXES) {
    if (bare.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Does the bare tool name match any pattern in the allowed categories?
 * Returns the matching category or null. If null, the tool either belongs
 * to a category not in the allowlist (deny) or to no known category (allow,
 * fail-open).
 */
function categoryFor(bare) {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(bare)) return category;
    }
  }
  return null;
}

function buildCheckpointDenyReason(state, toolName) {
  const lines = [
    `Forge workflow is at a CHECKPOINT awaiting user input (skill="${state.pending_checkpoint_step || 'unknown'}").`,
    `Tool "${toolName}" cannot proceed until the user has answered.`,
    ``,
    'You have three options:',
    '  1. Ask the user the pending question and wait for their answer.',
    '  2. Call forge__update_state with the user\'s answer (set state_updates.user_answer).',
    '  3. Call forge__abandon_workflow with a meaningful reason if the workflow no longer applies.',
    ``,
    'Do NOT silently bypass the workflow. The audit trail is how the team learns when workflows misroute.',
  ];
  return lines.join('\n');
}

function buildStepPermissionDenyReason(state, toolName, category) {
  const skill = state.current_step_skill || state.current_skill || 'the active step';
  const allowed = (state.current_step_tools || []).join(', ') || '(none)';
  const lines = [
    `Forge workflow step "${skill}" does not allow tool category "${category}".`,
    `Tool "${toolName}" is in category "${category}". This step's allowed categories: ${allowed}.`,
    ``,
    'Likely you are trying to do work that belongs to a later step. Options:',
    '  1. Continue the current step and call forge__update_state to advance — the next step may allow this tool.',
    '  2. Ask the user if they need to make a decision before this step can complete.',
    '  3. Call forge__abandon_workflow with a meaningful reason if the workflow no longer applies.',
    ``,
    'Do NOT silently bypass the workflow. The audit trail is how the team learns when workflows misroute.',
  ];
  return lines.join('\n');
}

/** Emit a Cursor preToolUse deny decision. */
function deny(agentMessage, userMessage) {
  process.stdout.write(JSON.stringify({
    permission: 'deny',
    agent_message: agentMessage,
    user_message: userMessage,
  }));
}

// -- Main -------------------------------------------------------------------

async function main() {
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    return; // Malformed input — fail open
  }

  const toolName = event.tool_name || '';
  if (!toolName) return; // Nothing to gate

  // Read session state, scoped to this Cursor conversation.
  const state = sessionState.forSession(event.conversation_id).read();
  if (!state.active_workflow) return; // No workflow active — allow

  const bare = bareName(toolName);

  // Universals always pass — Forge orchestration, user-question relay, read-only.
  if (isUniversallyAllowed(bare)) return;

  // Layer 1: CHECKPOINT enforcement.
  if (state.pending_checkpoint) {
    deny(
      buildCheckpointDenyReason(state, bare),
      'Forge workflow is at a checkpoint — answer the pending question before continuing.',
    );
    return;
  }

  // Layer 2: per-step tool_permissions enforcement.
  if (Array.isArray(state.current_step_tools) && state.current_step_tools.length > 0) {
    const category = categoryFor(bare);
    if (category && !state.current_step_tools.includes(category)) {
      deny(
        buildStepPermissionDenyReason(state, bare, category),
        `Forge workflow step does not allow "${category}" tools — advance the workflow first.`,
      );
      return;
    }
  }

  // Otherwise allow — no checkpoint pin, no per-step allowlist (or tool is
  // not in any known category, or its category is allowed).
}

main().catch(() => {
  // Fail open — never block the user's tool call due to a hook error.
});
