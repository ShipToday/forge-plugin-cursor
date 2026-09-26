#!/usr/bin/env node

/**
 * workflow-guard.cjs — PreToolUse hook for Forge workflow enforcement.
 *
 * Fires before every tool call. Reads session state and decides whether the
 * tool may proceed. Two layers of enforcement:
 *
 *   1. CHECKPOINT enforcement (V1, #518): when the orchestrator has emitted
 *      a relayed-question CHECKPOINT and the workflow-tracker hook has set
 *      `pending_checkpoint: true`, only AskUserQuestion / forge__update_state
 *      / forge__abandon_workflow / read-only inspection may proceed.
 *
 *   2. The write lock (SHI-966): while an Always-asks step's write plan is
 *      unapproved, tools on the write list are held. The server decides the
 *      lock; the workflow-tracker hook records it.
 *
 * A step's `**Tool Permissions**` are NOT enforced here. They are the step's
 * declared scope, which the model follows from its instructions — the same
 * way it follows them for shell. Enforcing them meant keeping a map from every
 * connector's tool names to categories beside the server's declarations, and
 * each gap in that map refused work a step was told to do.
 *
 * Defensive defaults:
 *   - If no workflow is active, allow.
 *   - A tool the read-only rules or the write list do not know is allowed.
 *     Unknown tools (custom MCP connectors, future built-ins) should not be
 *     blocked by a closed-world list.
 *   - Shell tools (Bash, PowerShell, Shell, Monitor, and Cursor's
 *     WriteShellStdin) are never checked: not by
 *     the write lock, not while a question is pending. This hook does not read
 *     commands. Which commands a step should run is left to the step's
 *     instructions and the AI client; parsing shell to prove a command safe
 *     meant modelling every host's shell dialect, and each gap refused
 *     legitimate work.
 *
 * Token stamping: for forge__update_state in any TRACKED session
 * (an active workflow, or a logged/linked observer session) this hook ALSO
 * rewrites the tool input via `updatedInput`, stamping a cumulative token
 * snapshot onto state_updates.token_usage. This is the client-side analog of
 * the server-side duration_ms stamp — the Forge server makes no Anthropic
 * calls so it cannot measure token usage, and a PreToolUse rewrite lands the
 * tokens on the SAME call that already records duration. The orchestrator
 * persists them as a separate token_usage row (on the server). It
 * replaces the fragile legacy path where the model had to RELAY the Stop-hook
 * directive's token_usage by hand (which it silently dropped — leaving null
 * token columns on ad_hoc/checkpoint rows).
 *
 * Hook contract: PreToolUse hooks may emit a JSON payload on stdout —
 * `{hookSpecificOutput: {permissionDecision: "deny", permissionDecisionReason: "..."}}`
 * to refuse the tool, or
 * `{hookSpecificOutput: {permissionDecision: "allow", updatedInput: {…}}}`
 * to rewrite the tool input (Claude Code >= 2.0.10). Anything else (silence,
 * exit code 0) allows the call to proceed unchanged.
 *
 * ── Cursor build localization ──
 * Cursor exposes no per-session model token usage to plugin hooks (the
 * upstream feature request is open with no ship date), so the token stamp
 * would never have anything to deliver — and `updatedInput`-style input
 * rewrites have no verified support in Cursor's hook protocol. This build
 * therefore never emits input rewrites (SUPPORTS_UPDATED_INPUT below):
 * token capture stays honest-null, and `duration_ms` keeps the server's
 * wall-clock fallback.
 *
 * Cursor's preToolUse contract differs from Claude Code's, and this build
 * follows Cursor's:
 *   - The shell tool is `Shell` (`tool_input.command`), `WriteShellStdin`
 *     types into a running shell, a file deletion is `Delete`, and an MCP tool
 *     arrives as `MCP:<tool name>` with no server segment.
 *   - A denial is the flat `{permission: "deny", user_message}` reply. The
 *     agent is shown `user_message`; `agent_message` on its own is not shown.
 *     Cursor also translates the nested `hookSpecificOutput` form, but only
 *     when no flat field is present, so deny() sends both with one reason.
 *     A top-level `decision` is ignored.
 *   - On Windows the payload arrives through a PowerShell pipeline that
 *     prefixes a UTF-8 byte-order mark, and exit codes do not survive the
 *     wrapper. The event is parsed after stripping the mark, and denials are
 *     never expressed through the exit code.
 *   - Cursor's question tool, `AskQuestion`, is not among the tools Cursor
 *     runs hooks for, so workflow-tracker never sees it and cannot record it as
 *     proof a pinned question reached the user. On Cursor that proof
 *     is the user's next message, which prompt-router records. The deny
 *     guidance below therefore asks for the question in the reply, as numbered
 *     choices, and never for an AskQuestion answer — that answer is refused.
 * Keep the checkpoint, re-sync hold and write-lock enforcement otherwise
 * identical to the Claude Code source on every plugin sync (/shiptoday-plugin).
 *
 * @see plugin/hooks/token-usage.cjs for the transcript-parsing capture adapters
 * @see plugin/hooks/workflow-tracker.cjs for the state writes this hook reads
 * @see plugin/hooks/session-state.cjs for state management
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');
const { resolveSessionRecords, captureTokenUsageFromResolved } = require('./token-usage.cjs');
const { activeMsFromEvent, activeMsFromResolved } = require('./active-time.cjs');

// Cursor build: never rewrite tool inputs — there is no token usage to stamp
// on Cursor and rewrite support is unverified in Cursor's hook protocol (see
// the header). Flipping this to true re-enables the source's stamp paths
// verbatim if a future Cursor release supports both.
const SUPPORTS_UPDATED_INPUT = false;

// -- Universal allowlist ----------------------------------------------------
// Always-allowed tools regardless of active step. Forge orchestration,
// Claude Code primitives that cannot mutate state, and the user-question
// relay path.

const ALWAYS_ALLOWED_BARE_NAMES = new Set([
  // Forge orchestration — model needs these to advance / exit / recover
  'forge__update_state',
  'forge__abandon_workflow',
  'forge__start_workflow',
  'forge__get_workflow_state', // Read-only recovery channel; safe to call mid-CHECKPOINT
  // Feedback delivery — the bundled forge-feedback skill, which the user
  // starts and confirms, calls this (SHI-968: the session_feedback workflow step
  // only points the user to it and never sends anything itself). It is a
  // Forge-owned tool that posts feedback to ShipToday (no user-domain mutation),
  // so it must never be blocked by a CHECKPOINT. Without this it was only
  // permitted by the unknown-tool fail-open path, which breaks the moment it's
  // called mid-checkpoint.
  'forge__send_feedback',
  // Question relay — the only way for the model to talk to the user mid-step
  'AskUserQuestion',
  'AskQuestion', // Cursor's question tool
  'request_user_input',
  'request_user_input_async',
  'functions.request_user_input',
  'functions.request_user_input_async',
  // Claude Code primitives — read-only or local-only, cannot mutate external state
  'Read',
  'Grep',
  'Glob',
  'List', 'ReadLints', // Cursor's read-only directory listing and lint read
  'TodoWrite',
  'mark_chapter',
  // Deferred Forge discovery and local recovery/coordination. This is a
  // narrow host-tool list, not permission for connector writes.
  'ToolSearch', 'Skill', 'ScheduleWakeup', 'TaskOutput', 'ListAgents',
  'Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  // Internal session tooling
  'spawn_task',
]);

// Read-only MCP tool name prefixes (always-allowed during workflow time).
const READONLY_PREFIXES = ['list_', 'get_', 'search_', 'query_', 'fetch_', 'read_', 'notion-search', 'notion-fetch', 'notion-get-'];
// The same rule for connectors that name tools in camelCase (Atlassian:
// getJiraIssue, searchConfluenceUsingCql, lookupJiraAccountId), so a Jira or
// Confluence read passes while a question is pending just as a Linear or Notion
// read does. Every Atlassian write starts with create/edit/add/update/
// transition, so none of them matches.
const READONLY_CAMEL_CASE = /^(?:get|search|lookup|fetch)[A-Z]/;
// And for Slack, which puts every tool behind `slack_`, so its reads matched no
// prefix above. The same read verbs, inside Slack's namespace; every Slack
// write starts with send/schedule/create/update/add/complete.
const READONLY_SLACK = /^slack_(?:read|search|list|get)_/;
const READONLY_EXTRA_NAMES = new Set(['atlassianUserInfo']);

// -- Write classification (SHI-966) ------------------------------------------
//
// Which TOOLS write — what the write lock and the re-sync hold hold back.
// Matched against the bare tool name, after the `mcp__<uuid>__` prefix is
// stripped. Anything not listed here is NOT treated as a write — the guard
// stays fail-open for tools it cannot classify, so a connector shipping a new
// verb degrades to today's behaviour rather than blocking work nobody asked it
// to block.
const WRITE_PATTERNS = [
  // Tracker — Linear, including its review/release surface, and GitHub/Jira below.
  /^save_issue$/, /^create_issue$/, /^update_issue$/,
  /^save_comment$/, /^create_comment$/, /^delete_comment$/,
  /^save_milestone$/, /^save_project$/, /^save_document$/,
  /^create_attachment$/, /^create_attachment_from_upload$/, /^delete_attachment$/, /^upload_attachments$/,
  /^create_issue_label$/, /^save_issue_label$/, /^save_project_label$/,
  /^retire_issue_label$/, /^retire_project_label$/, /^restore_issue_label$/, /^restore_project_label$/,
  /^merge_diff$/, /^update_diff$/, /^save_diff_comment$/, /^delete_diff_comment$/,
  /^submit_diff_review$/, /^resolve_diff_thread$/,
  /^save_status_update$/, /^delete_status_update$/, /^save_release$/, /^save_release_note$/,
  /^share_issue$/, /^unshare_issue$/,
  // Atlassian (Rovo MCP): the Jira and Confluence write verbs it exposes.
  /^createJiraIssue$/, /^editJiraIssue$/, /^updateJiraIssue$/, /^addCommentToJiraIssue$/,
  /^transitionJiraIssue$/, /^createConfluencePage$/, /^updateConfluencePage$/,
  /^createConfluenceFooterComment$/, /^createConfluenceInlineComment$/,
  // GitHub MCP.
  /^create_pull_request$/, /^merge_pull_request$/, /^update_pull_request(?:_branch)?$/,
  /^create_pull_request_review$/, /^push_files$/, /^create_or_update_file$/, /^delete_file$/,
  /^add_issue_comment$/, /^create_branch$/, /^create_repository$/, /^fork_repository$/,
  /^create_label$/, /^create_draft$/,

  // Docs — Notion writes, Claude Docs (batch/update/create/delete), Google
  // Drive. Artifact and ArtifactData are told apart by action, below.
  /^notion-create-/, /^notion-update-/, /^notion-move-/, /^notion-duplicate-/, /^notion-upload-/,
  /^batch$/, /^update$/, /^create$/, /^delete$/,
  /^create_file$/, /^update_file$/, /^gdrive_upload$/,

  // Messaging — the sending half of `messaging`; reads stay allowed.
  /^slack_send_message$/, /^slack_send_message_draft$/, /^slack_schedule_message$/,
  /^slack_create_/, /^slack_update_/, /^slack_add_/, /^slack_complete_file_upload$/,
  /^send_message$/,

  // Calendar — the mutating half of `calendar`.
  /^create_event$/, /^update_event$/, /^delete_event$/, /^respond_to_event$/,

  // Design — the mutating half of `design`.
  /^create_new_file$/, /^upload_assets$/, /^add_code_connect_map$/,
  /^send_code_connect_mappings$/, /^create_design_system_rules$/,

  // Local code. Cursor: a file deletion is `Delete`.
  /^Edit$/, /^MultiEdit$/, /^Write$/, /^NotebookEdit$/, /^Delete$/, /^(?:functions\.)?apply_patch$/,
];

// Tools whose one name covers reads and writes, told apart by `action`. An
// absent action is the tool's default, which publishes. Reading an artifact
// while locked is exactly the kind of denial that teaches people to work
// around the guard, so the read actions pass.
const ACTION_CLASSIFIED = {
  Artifact: new Set(['read', 'list', 'open', 'quickstart']),
  ArtifactData: new Set(['get', 'list', 'query']),
};

/** true/false for an action-classified tool, null when the tool is not one. */
function actionWrites(bare, event) {
  const reads = ACTION_CLASSIFIED[bare];
  if (!reads) return null;
  const input = event && event.tool_input;
  const action = input && typeof input === 'object' && typeof input.action === 'string' ? input.action : null;
  return !(action && reads.has(action));
}

// Tools that run a command. The guard never checks them — see the header.
// Cursor: `Shell` runs commands and `WriteShellStdin` types into a running one.
const SHELL_TOOLS = /^(?:Bash|PowerShell|Shell|Monitor|WriteShellStdin)$/;

/**
 * Does this call write somewhere the write lock is meant to hold?
 *
 * Unclassified tools return false by design (fail-open) — see WRITE_PATTERNS.
 * Shell tools never reach here; they are allowed before any layer runs.
 */
function isWriteTool(bare, event) {
  const byAction = actionWrites(bare, event);
  if (byAction !== null) return byAction;
  return WRITE_PATTERNS.some((re) => re.test(bare));
}

// -- Helpers ----------------------------------------------------------------

/**
 * Strip the `mcp__<uuid>__` prefix from an MCP tool name, returning the
 * bare tool name. Non-MCP tool names are returned as-is.
 */
function bareName(toolName) {
  if (!toolName) return '';
  // Non-greedy server segment so server names containing UNDERSCORES are
  // stripped too — not just hyphenated connector UUIDs. The Forge plugin
  // exposes tools under `mcp__plugin_forge_forge__forge__update_state` (and
  // Linear under `mcp__plugin_linear_linear__…`); the old
  // `mcp__[^_]+(?:-[^_]+)*__` pattern stopped at the first underscore and
  // failed to strip the prefix, so `bare` stayed the full name → forge tools
  // were neither token-stamped nor recognized as universally-allowed (they
  // would be DENIED mid-checkpoint). The first `__` after `mcp__` is the
  // server/tool delimiter; the tool itself may contain `__`
  // (e.g. `forge__update_state`), which the greedy trailing group preserves.
  // Cursor names MCP tools `MCP:<tool name>` (`MCP:forge__update_state`).
  const m = toolName.match(/^mcp__.+?__(.+)$/) || toolName.match(/^MCP:(.+)$/);
  return m ? m[1] : toolName;
}

function isUniversallyAllowed(bare) {
  if (ALWAYS_ALLOWED_BARE_NAMES.has(bare)) return true;
  for (const prefix of READONLY_PREFIXES) {
    if (bare.startsWith(prefix)) return true;
  }
  return READONLY_CAMEL_CASE.test(bare) || READONLY_SLACK.test(bare) || READONLY_EXTRA_NAMES.has(bare);
}

function buildCheckpointDenyReason(state, toolName) {
  // SHI-973: name the field the pending question actually uses. The tracker
  // records it from the server's answer line; when it is unknown, say which
  // field fits which kind of question rather than guess. The old fixed
  // `gate_answer` default was wrong for every relayed question.
  const field = state.pending_checkpoint_response_field;
  const questionId = state.pending_checkpoint_question_id;
  const withId = questionId ? ` with question_id "${questionId}"` : '';
  const answerHow = field
    ? `set state_updates.${field}${withId}`
    : `use the field the pending question names — user_answer for a question, gate_answer for a step gate${withId}`;
  const conversationId = state.conversation_id || '<conversation_id>';
  const lines = [
    `Forge workflow is at a CHECKPOINT awaiting user input (skill="${state.pending_checkpoint_step || 'unknown'}").`,
    `Tool "${toolName}" cannot proceed until the user has answered.`,
    ``,
    'You have four options:',
    '  1. Ask the pending question in your reply — numbered choices when it offers options — and end your turn. On Cursor, Forge accepts the answer from the user\'s next message; an answer gathered with AskQuestion cannot be verified and is refused.',
    `  2. Call forge__update_state with the user's answer (${answerHow}).`,
    `  3. If Forge's last reply did not arrive in full (for example the host saved it to a file instead of showing it), re-sync: call forge__get_workflow_state(conversation_id: "${conversationId}", instruction_chunk_bytes: 20000). When no question is pending, its reply releases this lock.`,
    '  4. Call forge__abandon_workflow with a meaningful reason ONLY if the workflow itself no longer applies (wrong workflow, user redirected).',
    '     Never abandon to skip the remaining steps: if the user asks to stop, call forge__update_state with state_updates.stop_run: true — the run ends with its recap.',
    ``,
    'Do NOT silently bypass the workflow. The audit trail is how the team learns when workflows misroute.',
  ];
  return lines.join('\n');
}

/**
 * SHI-966: the step is set to Always asks and writes, and its write plan has
 * not been approved yet. Name the one move that releases the lock.
 */
function buildWriteLockDenyReason(state, toolName) {
  const step = (state.write_lock && state.write_lock.step_id) || state.current_step_skill || 'the active step';
  return [
    `Forge step "${step}" is set to Always asks: nothing is written until its write plan is approved.`,
    `Tool "${toolName}" writes, so it cannot run yet.`,
    '',
    'Show the user ONE write plan for this step — what it will write, where, and a preview of the content — and ask them to approve it. Post their answer with forge__update_state; the approval releases the lock for the writes in that plan.',
    'Skip and Keep as draft are valid answers: they complete the step with nothing written.',
    '',
    'Do NOT work around this by writing through a different tool. The lock is the control the admin chose.',
  ].join('\n');
}

/**
 * SHI-966 approval authenticity. A relayed question is the USER's to answer:
 * an answer may be posted only after the host question tool was called or the
 * user took a turn, both recorded against the pin (workflow-tracker and
 * prompt-router). Returns the deny reason when an answer is being posted with
 * neither, null when the call may proceed. Fail-open on anything unparseable
 * and on a pin that carries no timestamp (an older state file).
 */
const ANSWER_FIELDS = ['user_answer', 'gate_answer'];

function answerWithoutAsking(state, event) {
  if (!state.active_workflow || !state.pending_checkpoint || !state.pending_checkpoint_at) return null;
  let toolInput = event.tool_input || {};
  if (typeof toolInput === 'string') {
    try { toolInput = JSON.parse(toolInput); } catch { return null; }
  }
  const updates = toolInput && typeof toolInput === 'object' && toolInput.state_updates && typeof toolInput.state_updates === 'object'
    ? toolInput.state_updates
    : null;
  if (!updates) return null;
  // A stop writes nothing; an outcome without an answer (a dismissal, a
  // delivery receipt, a resume request) answers nothing.
  if (updates.stop_run === true) return null;
  const answers = ANSWER_FIELDS.some((f) => updates[f] !== undefined)
    || (updates.question_response && typeof updates.question_response === 'object' && updates.question_response.kind === 'decision');
  if (!answers) return null;
  const pinnedAt = Date.parse(state.pending_checkpoint_at);
  if (!Number.isFinite(pinnedAt)) return null;
  const askedAt = Date.parse(state.pending_checkpoint_asked_at || '');
  const userTurnAt = Date.parse(state.pending_checkpoint_user_turn_at || '');
  if ((Number.isFinite(askedAt) && askedAt >= pinnedAt) || (Number.isFinite(userTurnAt) && userTurnAt >= pinnedAt)) return null;
  return buildUnaskedAnswerDenyReason(state);
}

function buildUnaskedAnswerDenyReason(state) {
  const step = state.pending_checkpoint_step || state.current_step_skill || 'the active step';
  return [
    `Forge step "${step}" is waiting for the USER's answer, and no question has reached them since it was asked.`,
    'An answer posted now would be yours, not theirs — and a write it approves would be recorded as approved by the user.',
    '',
    'Do ONE of these first:',
    '  1. Present the question in your reply — numbered choices when it offers options — and STOP; post the user\'s actual answer with forge__update_state after they reply.',
    '     On Cursor, Forge can confirm an answer only from the user\'s next message: an answer gathered with AskQuestion cannot be verified, and posting it is refused.',
    '  2. If the user asked to stop, call forge__update_state with state_updates.stop_run: true.',
    '',
    'If you did ask before this question was recorded (a reply lost and recovered with forge__get_workflow_state), ask again — Forge accepts only answers given after the question it recorded.',
    'Never answer a relayed question on the user\'s behalf, and never convert silence, a dismissal or an acknowledgment into an answer.',
  ].join('\n');
}

// Cursor applies the flat fields and shows the agent `user_message`;
// `agent_message` travels with it for hosts that forward it separately. The
// nested form carries the same reason for Cursor's Claude-compatible parser.
function deny(reason) {
  process.stdout.write(JSON.stringify({
    permission: 'deny', user_message: reason, agent_message: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

function buildResyncDenyReason(state, toolName) {
  const conversationId = state.conversation_id || '<conversation_id>';
  return [
    'Forge could not read which step the workflow moved to from its last reply, so the active step\'s write lock is unknown.',
    `Tool "${toolName}" can write, so it is held until the step is confirmed. Reading is unaffected.`,
    '',
    `Call forge__get_workflow_state(conversation_id: "${conversationId}", instruction_chunk_bytes: 20000). Its reply names the active step and restores its write lock — or reports that the run has ended — and this hold lifts.`,
    '',
    'Do NOT work around this by writing through a different tool.',
  ].join('\n');
}

// -- Main -------------------------------------------------------------------

async function main() {
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    // Cursor on Windows prefixes the payload with a UTF-8 byte-order mark;
    // trim() removes it (U+FEFF is whitespace to JavaScript) with the CRLF.
    event = JSON.parse(input.trim());
  } catch {
    return; // Malformed input — fail open
  }

  const toolName = event.tool_name || '';
  if (!toolName) return; // Nothing to gate

  // Scope state to this Claude Code session.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();
  const bare = bareName(toolName);

  // Stamp cumulative token usage onto Forge's own
  // forge__update_state call — the deterministic analog of the server-side
  // duration_ms stamp. Fires on EVERY forge__update_state, with NO session-state
  // precondition. Runs BEFORE the active_workflow guard below, because
  // observer-checkpoint calls happen with active_workflow=false (the
  // observe_session workflow has already completed), and the legacy #657 path —
  // which relies on the MODEL relaying the Stop-hook directive's token_usage —
  // drops them (observed: an ad_hoc session whose model never relayed, leaving
  // null token columns). The updatedInput rewrite makes capture independent of
  // the model.
  //
  // Deliberately STATELESS. This used to require
  // `active_workflow || status === 'logged' || status === 'linked'`, which made
  // capture inherit every failure mode of the session-state file: a cwd change
  // re-keyed the state mid-session, and the TTL reset it, and in both cases the
  // freshly-created state reported no workflow — so capture silently stopped for
  // the rest of the run. Observed in the wild: a 5.5h session recorded 21
  // workflow steps and zero token rows.
  //
  // The precondition also bought nothing. Reaching this line already means the
  // model is calling forge__update_state, so a Forge conversation exists by
  // construction — that IS the "tracked session" signal, and it comes from the
  // event rather than from disk. Everything the capture needs (`event`, the
  // transcript, `event.session_id`) is likewise event-derived, so nothing here
  // can be lost to a re-key or an expiry. The active-time stamp further down
  // still reads state and keeps its own guard.
  //
  // captureTokenUsage parses the local transcript (main + sub-agent files)
  // into a CUMULATIVE raw-component snapshot; the orchestrator writes it to a
  // separate `event_type: token_usage` row keyed by the Forge conversation
  // (the workflow conversation, or the observe_session conversation for
  // observer sessions) with work_item_key nullable — linked AND unlinked both
  // captured. The snapshot is cumulative and the read side takes
  // latest-per-session, so re-stamping never double-counts and a skipped call
  // never under-counts.
  //
  // updatedInput requires Claude Code >= 2.0.10; older clients ignore it
  // (graceful no-capture, no breakage). Fail-soft: any parse/IO error leaves
  // the call unchanged — token capture must never block forge__update_state.
  if (bare === 'forge__update_state') {
    // SHI-966 approval authenticity — before any stamping, because a refusal
    // must not also rewrite the input. See answerWithoutAsking.
    const unasked = answerWithoutAsking(state, event);
    if (unasked) {
      deny(unasked);
      return;
    }
    // Cursor build: the approval check above always runs; only the input
    // rewrite below is switched off (SUPPORTS_UPDATED_INPUT).
    if (!SUPPORTS_UPDATED_INPUT) return;
    try {
      let toolInput = event.tool_input || {};
      if (typeof toolInput === 'string') toolInput = JSON.parse(toolInput);
      const stateUpdates = { ...(toolInput.state_updates || {}) };
      // Resolve the session log ONCE per invocation — token capture and the
      // active-time stamp below consume the same parsed records instead of
      // each re-reading multi-MiB transcript files (review #10).
      const resolved = resolveSessionRecords(event);
      const tokens = captureTokenUsageFromResolved(resolved);
      // Track whether we enriched state_updates at all. Three independent stamps
      // can fire on the SAME tracked update_state, and the rewrite must be
      // emitted if ANY did:
      //   - token_usage (only when capture succeeds),
      //   - client_session_id (the Claude coding-session id, stamped on EVERY
      //     tracked update_state so the read side can collapse this session's
      //     rows across all its Forge conversations — this workflow + the
      //     observer — instead of counting one per conversation), and
      //   - duration_ms (R1 idle-excluded active time; active-workflow steps only).
      let changed = false;
      // Never clobber a token_usage the caller already set (defensive — the
      // model does not set it today, but a future client might).
      if (tokens && !stateUpdates.token_usage) {
        // Stamp one component bag PER model so the orchestrator
        // writes a per-model token_usage row — a delegated session (Opus main +
        // Sonnet sub-agent) is then weighted per model at read. Fall back to the
        // combined single bag if an adapter lacks byModel.
        const models = Array.isArray(tokens.byModel) && tokens.byModel.length
          ? tokens.byModel
          : [tokens];
        stateUpdates.token_usage = models.map((m) => ({
          input: m.input,
          cache_read: m.cacheRead,
          cache_creation_5m: m.cacheCreation5m,
          cache_creation_1h: m.cacheCreation1h,
          cache_creation_flat: m.cacheCreationFlat,
          output: m.output,
          model_name: m.modelName,
        }));
        changed = true;
      }
      // Stamp the Claude coding-session id on every tracked update_state. Don't
      // clobber an existing one (a future client might set it itself).
      if (!stateUpdates.client_session_id && event.session_id) {
        stateUpdates.client_session_id = event.session_id;
        changed = true;
      }

      // R1 active-time: stamp duration_ms with idle-excluded ACTIVE time for an
      // active-workflow step (window = [step_active_since, now]). The server
      // prefers state_updates.duration_ms over its wall-clock fallback,
      // so this replaces wall-clock with active time on
      // the SAME call that already carries the tokens — the client-side analog
      // of the server's duration stamp. Scoped to active workflows: observer
      // (logged/linked) checkpoint duration is owned by the stop-observer
      // directive, so we don't double-source it here. `== null` guards both
      // null and undefined so a caller-set value (incl. 0) is never clobbered;
      // activeMsFromEvent returns null when no session log is available (Cursor
      // / unreadable transcript) → we leave the server's wall-clock fallback.
      if (state.active_workflow && state.step_active_since && stateUpdates.duration_ms == null) {
        const activeMs = activeMsFromResolved(resolved, Date.parse(state.step_active_since));
        if (Number.isFinite(activeMs)) {
          stateUpdates.duration_ms = activeMs;
          changed = true;
        }
      }

      // updatedInput REPLACES the tool input (Claude Code does not merge), so
      // echo the complete object back with the enriched state_updates — but only
      // when we added something (token_usage, client_session_id, and/or duration_ms).
      if (changed) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...toolInput, state_updates: stateUpdates },
          },
        }));
        return;
      }
    } catch {
      // Fall through — allow the call unchanged.
    }
    return; // forge__update_state is universally allowed regardless.
  }

  // R1 active-time on the ABANDON exit. forge__abandon_workflow carries no
  // state_updates, so without a stamp the server's __abandoned__ audit row
  // falls back to wall-clock (now − stepStartedAt) — and abandon is the exit
  // most correlated with walking away (start a step, pause 3h, come back and
  // abandon → 3h of idle banked as engineering time, the exact inflation R1
  // removes on update_state). Stamp the idle-excluded active time of the
  // in-flight step as a top-level `duration_ms` input field; the tool handler
  // threads it into the audit row on the server. Same
  // guards as the update_state stamp: never clobber a caller-set value, and
  // a null capture (Cursor / unreadable transcript) leaves the call unchanged
  // so the server keeps its wall-clock fallback.
  if (SUPPORTS_UPDATED_INPUT && bare === 'forge__abandon_workflow') {
    try {
      let toolInput = event.tool_input || {};
      if (typeof toolInput === 'string') toolInput = JSON.parse(toolInput);
      const updated = { ...toolInput };
      let changed = false;
      // Stamp the Claude coding-session id so the synthetic
      // `__abandoned__` audit row joins the rest of its coding session. Without
      // it the row writes client_session_id = NULL and fragments off its own
      // session under COALESCE(client_session_id, session_id) — orphaning its
      // time on the Token Intelligence drilldown. Always stamp it (not gated on
      // active_workflow): event.session_id is the only reliable source and the
      // stamp is harmless. Don't clobber a caller-set value.
      if (updated.client_session_id == null && event.session_id) {
        updated.client_session_id = event.session_id;
        changed = true;
      }
      // R1 active-time (idle-excluded) for the in-flight step — only meaningful
      // while a step is active. Same guards as the update_state stamp.
      if (updated.duration_ms == null && state.active_workflow && state.step_active_since) {
        const activeMs = activeMsFromEvent(event, Date.parse(state.step_active_since));
        if (Number.isFinite(activeMs)) {
          updated.duration_ms = activeMs;
          changed = true;
        }
      }
      if (changed) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: updated,
          },
        }));
        return;
      }
    } catch {
      // Fall through — allow the call unchanged.
    }
    return; // abandon_workflow is universally allowed regardless.
  }

  // Beyond token stamping (above), the guard layers below apply only while a
  // workflow is active. A logged/linked observer session that reaches here on
  // a non-update_state tool has no question or lock to hold it.
  if (!state.active_workflow) return; // No active workflow — allow.

  // Universals always pass — Forge orchestration, AskUserQuestion, read-only.
  if (isUniversallyAllowed(bare)) return;

  // Shell always passes, before every layer: a pending question, a re-sync
  // hold and the write lock never look at a command.
  // Whether a command fits the step is the step's instructions and the AI
  // client's call, not this hook's.
  if (SHELL_TOOLS.test(bare)) return;

  // Layer 1: CHECKPOINT enforcement.
  if (state.pending_checkpoint) {
    deny(buildCheckpointDenyReason(state, bare));
    return;
  }

  // The tracker could not read which step the last reply moved to, so this
  // step's lock is unknown; the previous step's would fail open. Hold anything
  // that can write until a re-sync names the step.
  if (state.step_resync_required && isWriteTool(bare, event)) {
    deny(buildResyncDenyReason(state, bare));
    return;
  }

  // The step's tool_permissions are not enforced here. They are the step's
  // declared scope, published to the model, which follows them the same way it
  // follows them for shell. Matching tool names to categories meant keeping a
  // second, hand-written map of every connector's tools beside the server's
  // declarations, and each gap in it refused work a step was told to do.

  // Layer 2: the write lock (SHI-966). Only an Always-asks step that writes
  // carries one, and only while its plan is unapproved — the server decides
  // both and publishes the verdict as a single **Write Lock** line, which
  // workflow-tracker records. No lock recorded means no lock: an older server
  // never sends the line, and this plugin must not invent enforcement it was
  // not told about.
  if (state.write_lock && state.write_lock.state === 'on' && isWriteTool(bare, event)) {
    deny(buildWriteLockDenyReason(state, bare));
    return;
  }

  // Otherwise allow — no question pending, no re-sync hold, no lock holding a write.
}

main().catch(() => {
  // Fail open — never block the user's tool call due to a hook error.
  // The rest of the enforcement (workflow-tracker logging, audit trail)
  // continues to operate even if this hook is partially broken.
});
