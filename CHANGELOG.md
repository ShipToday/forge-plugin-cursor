# Changelog

All notable changes to the Forge by ShipToday plugin for Cursor are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
