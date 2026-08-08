# Changelog

All notable changes to the Forge by ShipToday plugin for Cursor are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.1] - 2026-08-07

### Fixed
- **Token capture no longer goes silently dark when session state is lost.**
  A long session could run its whole length recording nothing, even though the
  transcripts were complete the entire time — every capture path sat behind
  session state that had quietly been discarded. Two independent causes, both
  fixed: the state file was keyed on the working directory as well as the
  session, so touching a second repository mid-session re-keyed it and orphaned
  everything written so far (it now keys on the session alone); and staleness
  was measured from session start, so a session that simply ran longer than the
  expiry had its in-flight workflow state wiped mid-run (expiry now measures
  from the last write, which is what session-boundary detection actually means).
- **Usage stamping no longer inherits those failure modes.** Recording usage no
  longer requires a tracked-session flag to have survived in state — by the time
  that code runs a Forge conversation exists by construction, and everything the
  capture needs comes from the event itself.
- **Engineering-time checkpoints now work for organizations with observation
  disabled.** The checkpoint was gated behind a status those organizations never
  reach, so it never fired for them.

## [1.14.0] - 2026-07-31

### Added
- **Workflow authoring now proposes an SDLC stage for the workflow itself.**
  Forge already asked for a stage on each new skill; the workflow it belonged to
  had none, so the dashboard reconstructed one from the workflow name — which
  could never be right for a workflow you authored, because it is in no list of
  built-in names. A workflow you create now carries a real stage from the start,
  and shows its true badge, group and filter position instead of falling into
  "Other". The guidance is explicit that the stage follows the workflow's
  PURPOSE rather than a tally of its steps: scaffolding steps like handoff and
  session feedback appear in workflows of every kind, so counting them reliably
  mislabels the result.

## [1.13.1] - 2026-07-29

### Fixed
- **Progress markers are rendered again, unconditionally.** 1.13.0 told the
  routing skill to stand down whenever a display hook claimed to have shown a
  block already. On Claude's desktop client that claim was false — the hook's
  output lands in the transcript rather than on screen — so the preflight brief
  and every "Step N of M" marker vanished for a whole run. The rule is now the
  other way round: always render, because a duplicate is untidy while a missing
  marker leaves you with no view of the run at all. Cursor was never affected —
  it ships no `must-display` hook, and its routing skill already says the model
  is the only display channel here. This release carries the version bump only,
  so the plugin stays in step across platforms.

## [1.13.0] - 2026-07-28

### Changed
- **Progress markers are readable markdown instead of ASCII art.** The
  "what to expect" preflight brief and the per-step "Step N of M" marker were
  wrapped in a pair of 60-character `+====+` rules. Cursor renders markdown,
  so that showed up as literal punctuation — noise rather than structure. The
  marker is now a proper heading with the next/then trail beneath it, closed
  by a `---` break: bigger on screen, navigable by a screen reader, and a
  fraction of the size on the wire.
- **The routing skill now defers to a display hook when one exists.** On
  clients where Forge's `must-display` hook renders these blocks itself, it
  returns a notice saying so, and the skill is told not to render them a
  second time. Cursor ships no `must-display` hook, so nothing changes here in
  practice — the model remains the only display channel and continues to
  render the blocks itself, as it should.

## [1.12.0] - 2026-07-26

### Added
- **Must-display blocks are now an explicit contract.** Forge marks content
  meant for *you* — the "what to expect" preflight brief and the per-step
  "Step N of M" progress marker — by wrapping it in a
  `<<<FORGE_DISPLAY_VERBATIM>>>` relay envelope. The routing skill now
  documents that contract directly: render the block verbatim, before
  anything else in the turn, and never fold it into a delegated sub-agent
  prompt. A dogfooding run found these markers were being dropped silently,
  leaving no visible sign of how far a multi-step run had progressed.
- **`admin_only` visibility guidance for workflow authoring.** The workflow
  authoring skill now treats `admin_only` as an explicit either/or question
  rather than something to infer, and spells out how it differs from
  `default_roles` (a recommendation, not a restriction) and why omitting the
  field is not the same as sending `false`.

### Changed
- **Delegation now states who owns the content above the delimiter.**
  Everything above `---DELEGATE BELOW---` is addressed to the parent, not the
  sub-agent — previously only the *below*-delimiter half was described, which
  left must-display blocks belonging to nobody on a delegated step.

### Note for Cursor
Other Forge clients ship a `postToolUse` hook that surfaces must-display blocks
automatically as a backstop. Cursor's `postToolUse` has no user-visible output
channel — its output is agent-facing context — so that hook is intentionally
**not** included here. On Cursor the assistant rendering the block is the only
mechanism, which is why the guidance above is stated explicitly in the skill.

## [1.11.0] - 2026-07-18

### Added
- **Admission proposal — workflows are validated before they activate.** A
  post-classification `forge__start_workflow` call now returns a server-resolved
  workflow *proposal* instead of immediately creating an active conversation.
  The assistant compares the proposed entry step, missing inputs, configured
  path, and potential side effects against the full conversation before
  confirming with the returned `admission_token` and `start_confirmed: true`.
  When the proposal does not fit, nothing has started — so there is no workflow
  to abandon and no token is spent on a run the user did not want.

### Changed
- **Client-side catalog routing contract.** Forge now returns the enabled
  workflow catalog for the current user and organization and lets the client
  choose among it, rather than routing server-side. If one workflow clearly
  matches, the assistant re-calls with that explicit catalog workflow id and
  `classification_complete: true`; if several are plausible, it presents only
  the relevant catalog workflows and re-calls after the user picks. Inventing a
  workflow, surfacing a server-side skill id as an option, or setting
  `classification_complete: true` without an explicit `workflow` are all now
  explicitly disallowed.
- **Continuation boundary — Forge stays out of already-scoped coding work.**
  The assistant now reads the whole conversation, not just the latest sentence,
  to tell a new SDLC outcome from continuation of work already scoped. Applying
  review comments, resolving a merge conflict, editing known files, adding
  already-specified tests, and committing/pushing/updating a PR are handled
  normally without starting a workflow. A tracked work item key that appears
  only in earlier turns no longer pulls the request back into Forge — the
  distinction is the requested outcome: *review this PR* is workflow-shaped,
  *apply these review changes and update the PR* is coding continuation.
- **`follow_up` chaining generalized to every workflow.** Reading the
  `follow_up` object on completion was previously documented as a
  session-observer behaviour; status reports and observer outcomes now share
  one structured handoff contract, so any workflow that returns a non-null
  `follow_up` chains before the original request resumes.
- **Workflow authoring carries over observed friction instead of re-asking.**
  When a Forge run recap ends with a friction insight and the admin takes it up
  ("customize my workflow"), the authoring flow no longer asks its opening
  intake question — the insight already answered it. It states what it is
  carrying over so the inference is visible rather than silent, and proceeds.
  Absence of an insight is the ordinary case, never an error or a blocker.

## [1.10.0] - 2026-07-17

### Fixed
- **`workflow-tracker.cjs` — the session observer no longer re-nudges on every
  turn after a session is linked to an already-complete work item.** The hook
  derived the local tracking status only from its outcome map, which
  deliberately omits `linked`/`created` on the assumption that those always
  launch a follow-up workflow (which sets `active_workflow`). When the Link
  path sets `follow_up: null` — linking to an item that needs no further work —
  no workflow launches, so the status stayed `null` and `stop-observer.cjs`
  re-fired the tracking nudge on every subsequent stop. The hook now prefers
  the status the observer skill already declares in `final_session_state.status`,
  validated against the known set (`logged`, `linked`, `snoozed`, `dismissed`),
  and falls back to the outcome map only for older payloads that carry no
  `final_session_state`. The `ad_hoc`, `snoozed`, and `dismissed` outcomes are
  unchanged, and a bare `linked` with no declared final state still resolves to
  `null` as before.

### Changed
- **`forge-autopilot` — the documented model-routing example now names the
  GPT-5.6 family.** OpenAI shipped GPT-5.6 (Sol/Terra/Luna) on 2026-07-09 and
  Forge's tier map was retargeted to it, but the skill's illustrative
  `**Model Routing**` line still showed the superseded `gpt-5.4`. This updates
  the documented example only — tier selection, model recognition, and pricing
  are all resolved on the server, so the routing signal itself was already
  current.

## [1.9.0] - 2026-07-02

### Changed
- **`forge-workflow` skill — authored workflows now always close with a
  `session_feedback` step.** The workflow-authoring guidance instructs the
  AI author to append (or move) `session_feedback` to the final step and
  surface it in the proposal, so custom org/team workflows end with the same
  end-of-session recap every Forge default workflow uses. This release also
  brings the skill's team-scope wording (an org admin can target any team in
  the org) and the `example_invocation` `forge, ` wake-word guidance in line
  with the current Forge source.

## [1.8.0] - 2026-06-23

### Fixed
- **`workflow-guard.cjs` — `forge__abandon_workflow` now stamps
  `client_session_id` so the `__abandoned__` audit row joins its coding
  session.** When a workflow was abandoned, the audit row wrote
  `client_session_id = NULL`, which fragmented it off its coding session on the
  read side (`COALESCE(client_session_id, session_id)`) and stranded the step's
  time in the Token Intelligence drilldown's "no measured AI spend" footnote.
  The abandon branch now stamps the coding-session id (from the stop event's
  session id) regardless of whether a workflow step is active, mirroring the
  Claude Code source. **On Cursor this stays dormant** — the build emits no
  input rewrites (`SUPPORTS_UPDATED_INPUT = false`), so abandon rows keep the
  server's wall-clock fallback; the gated code is kept in sync so it lights up
  automatically if a future Cursor release supports input rewrites.

## [1.7.0] - 2026-06-21

### Fixed
- **`stop-observer.cjs` / `workflow-tracker.cjs` — a Forge step no longer
  stalls when a local skill runs mid-workflow.** When a workflow
  step invoked a local skill (e.g. a required security review) whose prompt
  said "reply with only its output", the model could end its turn without
  calling `forge__update_state`, leaving the step silently incomplete.
  `workflow-tracker.cjs` now arms a continuation backstop whenever a local
  skill runs while a workflow is active, and clears it on any
  `forge__update_state`. If the turn ends with the backstop still armed (and
  the session is not paused at a legitimate question/confirmation checkpoint),
  `stop-observer.cjs` blocks the stop **once** and directs the model to relay
  the skill's findings and call `forge__update_state` — a skill's "nothing
  else" instruction governs its output format, not the workflow turn boundary.
  The single-fire guard means it can never loop.

### Changed
- **`forge-autopilot` routing now recognizes architecture-mapping work.** The
  skill description was sharpened so requests to map or document system
  architecture, reconstruct an architecture estate, or build an architecture
  atlas route into Forge.

## [1.6.0] - 2026-06-18

### Fixed
- **`workflow-tracker.cjs` — the observer's classified SDLC stage is now
  persisted, so engineering-time checkpoints stop defaulting to "Other".** The
  session observer classifies each session's SDLC stage (e.g. design,
  implementation) once at observe time, but that value was only stamped on the
  single observation audit row — it was never written to the per-session state.
  `stop-observer.cjs` builds its periodic engineering-time checkpoint with
  `sdlc_stage` read from that state, defaulting to `other` when absent, so every
  checkpoint heartbeat fell back to "Other". Since checkpoints carry the bulk of
  a session's banked engineering time, the ShipToday dashboard's per-stage time
  charts attributed almost all of a session's time to "Other" even when it was
  classified otherwise. The tracker now persists the classified stage alongside
  the status it already writes (without letting a heartbeat's own `other`
  fallback clobber a previously persisted stage). Go-forward only; totals, the
  linked/unlinked split, and work-item lifecycle state are unchanged.

## [1.5.0] - 2026-06-17

### Fixed
- **`workflow-tracker.cjs` — the passive observer no longer fires during a
  workflow preflight prompt.** When `forge__start_workflow` returns a
  clarification prompt (disambiguation, team selection, key/name confirmation,
  recommendation, or intent classification) instead of starting a workflow,
  the response carries no `Conversation ID`. The tracker previously left the
  session looking untracked, so the next `stop` hook fired the session
  observer — stacking a "track this work?" nudge on top of the clarification
  the user was still answering. This was especially jarring on Cursor, which
  surfaces the `stop` hook's block reason to the user verbatim. The tracker
  now treats any `forge__start_workflow` response without a `Conversation ID`
  as a preflight and blocks the observer for that turn; the per-turn re-arm
  still lets it fire later if the user abandons the preflight.
- **`workflow-tracker.cjs` — the namespaced routing skill id is ignored in
  the local-skill audit.** The `forge-autopilot` ignore-guard compared the
  bare id only, so a namespaced form (`<namespace>:forge-autopilot`) slipped
  through and recorded the router itself into `skill_invocations`. The guard
  now compares the bare id after stripping any namespace prefix.

## [1.4.0] - 2026-06-15

### Changed
- **Model-routing guidance — delegate when it pays for itself, not
  reflexively.** The `forge-autopilot` routing skill now carries a per-step
  **Worth-it check**: when the remaining work is only replaying content
  already computed and stored in workflow state (a pre-computed post, no new
  generation), the step runs inline on the current model instead of
  delegating to another tier — spawning a separate agent for a pure replay
  just adds a round-trip. Genuine off-tier work still delegates up for
  stronger reasoning or down to save cost.

### Fixed
- **`forge__send_feedback` is never blocked mid-workflow.** The workflow
  guard now always allows the `forge__send_feedback` tool, so the in-workflow
  feedback step and the `forge-feedback` skill can deliver feedback even
  during a checkpoint or when a step's tool allowlist would otherwise gate it.
  Previously it was permitted only by the fail-open path for unknown tools,
  which broke the moment it was called mid-checkpoint.

## [1.3.0] - 2026-06-13

### Added
- **`forge-feedback` skill (new) — in-session feedback to the ShipToday
  team.** Lets the user send feedback from inside a Cursor session: the skill
  runs a short conversation to capture the feedback, gathers and **sanitizes**
  relevant session context, shows the exact payload for review, lets the user
  revise it, and sends only after explicit confirmation by calling the
  `forge__send_feedback` MCP tool. No feedback content is persisted. The
  delivery path is the shared Forge MCP feedback backend (the same one the
  dashboard feedback form uses). The Cursor build localizes the confirmation
  step to a structured user-input tool where available, matching the other
  Cursor skills.

## [1.2.0] - 2026-06-10

### Added
- **`token-usage.cjs` (new) — per-session token-capture adapters.**
  Shared library deriving a cumulative raw-component
  token snapshot (input / cache reads / cache creation / output, attributed
  per model) from a local AI-client session log. **On Cursor this always
  resolves to `null` by design:** Cursor exposes no per-session model token
  usage to plugin hooks (the only token-bearing payload, `preCompact`'s
  `context_tokens`, is context-window occupancy rather than billing usage,
  and Cursor staff describe the local `state.vscdb` `tokenCount` as
  best-effort and unreliable). Forge records no token rows for Cursor
  sessions rather than fabricating numbers — the ShipToday dashboard
  reports Cursor as not measured. The library ships so the other hooks stay
  source-identical and capture lights up automatically if a future Cursor
  release exposes usage.
- **`active-time.cjs` (new) — idle-excluded engineering time (R1).** Sums
  gaps between session-log records, capping idle gaps at 5 minutes, so a
  long pause is not banked as engineering time. With no readable session
  log on Cursor it returns `null` and checkpoints keep the wall-clock
  delta — same behavior as before, now an explicit documented fallback.

### Changed
- **`stop-observer.cjs` — checkpoint directives now carry `token_usage`
  (when capturable — never on Cursor, see above) and `client_session_id`
  (when the `stop` event carries a session id), and bank idle-excluded
  active time where a session log exists.** On Cursor the engineering-time
  delta remains wall-clock.
- **`workflow-guard.cjs` — Cursor build never emits `preToolUse` input
  rewrites.** The Claude Code and Codex builds stamp token usage,
  `client_session_id`, and active `duration_ms` onto `forge__update_state`
  by rewriting the tool input (`hookSpecificOutput.updatedInput`). On
  Cursor there is nothing to stamp and `updatedInput` support in Cursor's
  hook protocol is unverified, so this build keeps the checkpoint and
  per-step permission enforcement and skips the rewrite path entirely
  (`SUPPORTS_UPDATED_INPUT = false`).
- **`workflow-guard.cjs` — MCP server-name prefix stripping now handles
  underscore-named servers** (e.g.
  `mcp__plugin_forge_forge__forge__update_state`), so Forge's own tools are
  always recognized as universally allowed instead of being denied
  mid-CHECKPOINT.
- **`workflow-tracker.cjs` / `session-state.cjs` — per-step activity
  boundary (`step_active_since`) and checkpoint-baseline advances on
  workflow completion/abandon**, preventing a tracked session's next
  checkpoint from re-banking the workflow's own span (anti-double-count).

## [1.1.7] - 2026-05-30

### Fixed
- **`stop-observer.cjs` — engineering-time checkpoints now fire on a
  wall-clock time floor, not turn count alone.** The `stop` hook
  previously banked elapsed engineering time only every
  `CHECKPOINT_INTERVAL` turns. Turns are a poor proxy for elapsed
  time: a handful of long research/implementation turns could leave a
  large un-banked gap (an unbroken 92.8-minute delta was observed in
  the wild). A checkpoint now fires when EITHER the turn interval OR a
  10-minute wall-clock floor (`TIME_FLOOR_MS`) is reached — whichever
  comes first. The checkpoint baseline advances at directive-emit time
  (not on the confirmed `forge__update_state` write), so consecutive
  deltas never overlap or double-count engineering time. Because Cursor
  exposes no model-driving session-end event, no final flush can be
  forced at exit; the residual un-banked tail on a clean exit is now
  bounded by the time floor rather than being effectively unbounded.

## [1.1.6] - 2026-05-28

### Changed
- **`stop-observer.cjs` — `FORGE OBSERVATION` directive trimmed to a
  concise form.** The `stop` hook previously emitted a
  ~30-line block enumerating the full SDLC activity taxonomy and a
  false-negative checklist. That taxonomy now lives server-side in the
  `session_observer` skill, so the hook carries only the short
  invoke/skip decision. This matters on Cursor in particular: Cursor
  surfaces the `stop` hook's block reason to the user verbatim, where
  the long block read as noise.

### Fixed
- **`workflow-tracker.cjs` — `observation_disabled` gate no longer maps
  to `logged`.** The 1.1.5 backstop routed the `observation_disabled`
  outcome (org-admin opted out of observation) through
  `OUTCOME_TO_STATUS` to `logged`. Marking a disabled org as `logged`
  made `stop-observer.cjs` treat the session as tracked and fire
  periodic engineering-time checkpoints for it. The gate is now
  detected separately — keyed off the `observation_disabled` outcome
  rather than its event type — and maps to no tracking status. Its only
  effect is pinning the per-session `forge_observation_enabled: false`
  cache flag so subsequent Stops short-circuit without an MCP
  round-trip.

## [1.1.5] - 2026-05-28

### Added
- **`session-state.cjs` — per-session observation gate cache.**
  A new `forge_observation_enabled` field stores the org-admin's
  observation toggle for the session. When `false`, `stop-observer.cjs`
  short-circuits silently on subsequent Stops so the observer doesn't
  re-invoke `session_observer` — zero MCP round-trips for the steady
  state. Field name is shared verbatim with the Cursor stop-observer
  for parity.
- **`stop-observer.cjs` — Step 3b gate.** Reads the new
  `forge_observation_enabled` cache flag before the snoozed-session
  re-fire path. Exits silently when the admin has opted out of
  observation for the org. Placed AFTER the linked/logged checkpoint
  branch so engineering-time tracking on already-tracked sessions
  continues independently of the observation toggle.
- **`workflow-tracker.cjs` — `observation_disabled` outcome backstop.**
  The `OUTCOME_TO_STATUS` map now recognises the
  `observation_disabled` outcome (org-admin gate fired),
  maps it to `logged`, and pins the per-session
  `forge_observation_enabled: false` cache flag so the
  stop-observer Step 3b read can short-circuit subsequent Stops
  without an MCP round-trip. Backstop for the documented
  gated-payload state write — if the AI parent forgets, this hook
  makes the steady-state still cheap.

### Changed
- **`forge-autopilot` skill — envelope detection accepts envelopes
  without `bytes=N`.** The parser now accepts the envelope on
  **sentinels + token** alone. When `bytes=N` is absent (a common
  smaller-model paraphrase mode — the agent keeps the sentinel shape
  but drops the byte count as "boring metadata"), trust the envelope
  without a state fetch. The fetch fallback still fires on missing /
  restructured sentinels or on a declared-bytes mismatch.

## [1.1.4] - 2026-05-26

### Added
- **`forge-autopilot` skill — envelope detection for sub-agent
  returns.** The orchestrator now wraps next-step instructions in a
  `<<<FORGE_NEXT_STEP token="…" bytes=N>>>` … `<<<END FORGE_NEXT_STEP>>>`
  envelope. After every sub-agent return, the parent agent scans for
  the envelope (presence + byte-length match) and falls through to
  `forge__get_workflow_state(conversation_id)` if it's missing or
  truncated. The state fetch is the designed recovery channel —
  read-only, owner-checked, and idempotent — and preserves any
  `display_text` the sub-agent populated as a `## Findings` block.
- **`forge-workflow` skill — `display_text` findings preservation
  guidance.** When drafting a custom skill's `instructions`, the skill
  now teaches admins to populate `display_text` whenever the skill
  produces analytical output before pausing (Pattern A: pre-gate
  payload; Pattern B: `needs_input` payload). The orchestrator caps
  `display_text` at 8 KB and surfaces it above the CHECKPOINT body so
  findings survive the sub-agent boundary.
- **`forge-workflow` skill — Step 9a soft warnings on save.** When
  `forge__save_workflow` returns a `warnings: [...]` array, the skill
  surfaces each entry inline with the success message. The first
  warning code, `missing_display_text_guidance`, flags custom-skill
  instructions that emit `needs_input` without mentioning
  `display_text`.

### Changed
- **`workflow-guard.cjs` — `forge__get_workflow_state` added to the
  universal allowlist.** The read-only recovery channel is safe to
  call mid-CHECKPOINT, so the workflow guard no longer denies it.

## [1.1.3] - 2026-05-25

### Changed
- **`forge-autopilot` skill — sub-agent step-token relay now requires
  verbatim response forwarding.** When a step is delegated to a sub-agent,
  the orchestrator's `forge__update_state` response (carrying the new
  `step_token` and the next step's instructions) is delivered to the
  sub-agent, not the parent. The sub-agent MUST return that response
  verbatim so the parent can extract the new token before its next
  `forge__update_state` call — a summarized relay leaves the parent
  with a stale token and the next call fails with a token-mismatch
  error. The guidance applies to Cursor sub-agent delegation as well
  as to Claude Code's Agent tool and Codex's `spawn_agent`.
- **`forge-workflow` skill — team-scope error code renamed.** The
  `team_membership_required` error code (caller not a member of the
  target team) has been replaced with `team_not_in_org` (target team
  belongs to a different organization). This broadens admin
  authority over team-scoped workflow overrides so org admins can
  manage any team in their own org, regardless of personal team
  membership. The error tables in both the Create path and Delete
  path now reflect the new code.

## [1.1.2] - 2026-05-23

### Changed
- **`forge-autopilot` skill — local-skill detection broadened to a
  relevance-based filter.** Clients now declare every locally available skill
  that is relevant to product development or the SDLC (brainstorming,
  planning, code review, debugging, etc.), not only project-specific ones. A
  Forge workflow step that declares a general-purpose skill via
  `required_local_skills` no longer comes back with
  `required_local_skills_missing`.
- **`forge-autopilot` skill — model routing guidance is now
  environment-aware.** The model-routing section now reads the
  `guidance=claude_code_model_map | codex_model_map | model_agnostic_tier`
  signal from the orchestrator and picks the matching tool-available model
  rather than hard-coding a specific model family.

## [1.1.1] - 2026-05-21

### Fixed
- **Passive observation now scopes per conversation on Cursor.** The session
  hooks keyed observer/workflow state by workspace alone, so dismissing,
  snoozing, or linking observation in one chat suppressed the `stop` hook for
  every other chat in the same workspace until the 4-hour TTL reset. The hooks
  now derive the state key from `event.session_id || event.conversation_id`,
  and Cursor supplies `conversation_id`, so each chat is tracked independently.

## [1.1.0] - 2026-05-21

Version alignment with the Forge 1.1.0 plugin release. No Cursor-facing
functional changes.

### Changed
- Session-state hooks refactored onto the upstream `forSession()` accessor
  (per-session workflow isolation). Cursor hook events carry no session id,
  so workflow state stays scoped per workspace exactly as before.

## [1.0.1] - 2026-05-21

Initial public release.

### Added
- **Forge MCP server** (`mcp.json`) connecting to the hosted Forge orchestration
  engine at `https://teams.shiptoday.ai/mcp`. Exposes `forge__start_workflow`,
  `forge__update_state`, `forge__abandon_workflow`, `forge__get_workflow`,
  `forge__save_workflow`, `forge__delete_workflow`, and
  `forge__list_skills_catalog`.
- **`forge-autopilot` skill** that detects product-development intent (feature
  requests, bug reports, PR reviews, story breakdowns, status checks, and
  tracked work-item keys like `PROJ-123`) and routes the request to the right
  Forge workflow.
- **`forge-workflow` skill** for organization admins to author new Forge
  workflows or delete existing org- or team-scoped overrides conversationally.
- **Lifecycle hooks** (`hooks/hooks.json`) coordinating session state:
  `beforeSubmitPrompt`, `stop`, `preToolUse`, and `postToolUse`.
- Plugin marketplace metadata and logo for the Cursor Marketplace listing.

### Known limitations
- Cursor's `beforeSubmitPrompt` hook can block a prompt but cannot inject
  advisory context, so `prompt-router.cjs` routing nudges are inert on Cursor;
  routing relies on `forge-autopilot` skill auto-discovery instead.
