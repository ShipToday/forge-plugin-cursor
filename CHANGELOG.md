# Changelog

All notable changes to the Forge by ShipToday plugin for Cursor are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
