# Forge by ShipToday for Cursor

Free, AI-powered product development lifecycle automation for Cursor.

## What it does

Describe what you want to build, fix, plan, review, or ship. Forge routes the
request through a structured PDLC workflow backed by the hosted Forge MCP
server. No trigger words needed.

```text
implement user authentication with OAuth
fix the checkout page crash on mobile
break down the notifications feature into stories
estimate story points for PROJ-123
check status of my feature
```

## What's included

- **Forge MCP server** (`mcp.json`) — connects to the hosted Forge
  orchestration engine at `https://teams.shiptoday.ai/mcp`. Exposes
  `forge__start_workflow`, `forge__update_state`, `forge__abandon_workflow`,
  `forge__get_workflow`, `forge__save_workflow`, `forge__delete_workflow`,
  and `forge__list_skills_catalog`.
- **`forge-autopilot` skill** — detects product-development intent (feature
  requests, bug reports, PR reviews, story breakdowns, status checks, tracked
  work-item keys like `PROJ-123`) and routes the request to the right Forge
  workflow.
- **`forge-workflow` skill** — conversational management for organization
  admins to author new Forge workflows or delete existing org- or team-scoped
  overrides.
- **Hooks** (`hooks/hooks.json`) — four hooks coordinate session state:
  - `beforeSubmitPrompt` → `prompt-router.cjs` (stateful routing for active
    workflows and snoozed sessions)
  - `stop` → `stop-observer.cjs` (passive session observation and silent
    checkpoints to record engineering time)
  - `preToolUse` → `workflow-guard.cjs` (per-step tool-permission enforcement
    and checkpoint gating)
  - `postToolUse` → `workflow-tracker.cjs` (tracks workflow state transitions
    and the active step's tool allowlist)

## Install

### From the Cursor Marketplace

_Coming soon — once the listing is approved:_

```
/add-plugin forge
```

### From a repository link (works today)

Open **Cursor Settings → Plugins** and paste the repository link into the
**Search or Paste Link** field:

```
https://github.com/ShipToday/forge-plugin-cursor
```

### Local development

Clone into your local plugin directory and restart Cursor — no install step
needed:

```bash
git clone https://github.com/ShipToday/forge-plugin-cursor \
  ~/.cursor/plugins/local/forge
```

### Authenticate

The Forge MCP server uses OAuth. After install, open **Cursor Settings →
Tools & MCP**, find **forge**, and click **Sign In** to complete the flow.

## Hooks

The plugin ships lifecycle hooks that power workflow guardrails and session
tracking. Review and trust them under **Cursor Settings → Hooks**. The hooks
require Node.js on your `PATH`.

> Cursor's `beforeSubmitPrompt` hook can block a prompt but cannot inject
> advisory context (unlike the equivalent hooks in the Claude Code and Codex
> plugins). `prompt-router.cjs` is ported for parity and keeps its session
> state side-effects, but its routing nudges are inert on Cursor — routing
> relies on `forge-autopilot` skill auto-discovery instead.

## License

MIT — see `LICENSE`.
