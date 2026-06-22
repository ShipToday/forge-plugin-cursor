# Changelog

All notable changes to the Forge by ShipToday plugin for Cursor are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-06-21

### Fixed
- **`stop-observer.cjs` / `workflow-tracker.cjs` — a Forge step no longer
  stalls when a local skill runs mid-workflow (SHI-787).** When a workflow
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
- **`token-usage.cjs` (new) — per-session token-capture adapters
  (SHI-378 / SHI-724).** Shared library deriving a cumulative raw-component
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
  concise form (SHI-760).** The `stop` hook previously emitted a
  ~30-line block enumerating the full SDLC activity taxonomy and a
  false-negative checklist. That taxonomy now lives server-side in the
  `session_observer` skill, so the hook carries only the short
  invoke/skip decision. This matters on Cursor in particular: Cursor
  surfaces the `stop` hook's block reason to the user verbatim, where
  the long block read as noise.

### Fixed
- **`workflow-tracker.cjs` — `observation_disabled` gate no longer maps
  to `logged`.** The 1.1.5 backstop routed the `observation_disabled`
  outcome (org-admin opted out of observation, SHI-758/SHI-759) through
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
- **`session-state.cjs` — per-session observation gate cache (SHI-759).**
  A new `forge_observation_enabled` field stores the org-admin's
  observation toggle for the session. When `false`, `stop-observer.cjs`
  short-circuits silently on subsequent Stops so the observer doesn't
  re-invoke `session_observer` — zero MCP round-trips for the steady
  state. Field name is shared verbatim with the Cursor stop-observer
  for parity.
- **`stop-observer.cjs` — Step 3b gate (SHI-759).** Reads the new
  `forge_observation_enabled` cache flag before the snoozed-session
  re-fire path. Exits silently when the admin has opted out of
  observation for the org. Placed AFTER the linked/logged checkpoint
  branch so engineering-time tracking on already-tracked sessions
  continues independently of the observation toggle.
- **`workflow-tracker.cjs` — `observation_disabled` outcome backstop.**
  The `OUTCOME_TO_STATUS` map now recognises the
  `observation_disabled` outcome (org-admin gate fired,
  SHI-758/SHI-759), maps it to `logged`, and pins the per-session
  `forge_observation_enabled: false` cache flag so the SHI-759
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
  belongs to a different organization). SHI-749 broadens admin
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
