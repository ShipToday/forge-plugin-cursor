# Changelog

All notable changes to the Forge by ShipToday plugin for Cursor are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
