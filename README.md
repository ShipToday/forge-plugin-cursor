# Forge by ShipToday for Cursor

Free, AI-powered product development lifecycle automation for Cursor.

## What it does

Ask Forge by name — include `forge` or `@forge` in your message — and it
routes your request through a structured PDLC workflow backed by the hosted
Forge MCP server:

```text
forge, implement user authentication with OAuth
@forge fix the checkout page crash on mobile
forge, break down the notifications feature into stories
forge, estimate story points for PROJ-123
@forge check status of my feature
```

Forge runs only when you ask for it. If your message only mentions Forge in
passing, the agent asks whether you meant Forge before starting anything. A
message that doesn't name Forge gets a normal response, even when it's about
planning or shipping work or mentions a ticket like `PROJ-123`.

## What's included

- **Forge MCP server** (`mcp.json`) — connects to the hosted Forge
  orchestration engine at `https://teams.shiptoday.ai/mcp`. Exposes
  `forge__start_workflow`, `forge__update_state`, `forge__abandon_workflow`,
  `forge__get_workflow_state`, `forge__get_workflow`, `forge__save_workflow`,
  `forge__delete_workflow`, `forge__list_skills_catalog`, and
  `forge__send_feedback`.
- **`forge-autopilot` skill** — when you ask Forge by name, routes your
  request (feature requests, bug reports, PR reviews, story breakdowns,
  status checks) to the right Forge workflow.
- **`forge-workflow` skill** — conversational management for organization
  admins to author new Forge workflows or delete existing org- or team-scoped
  overrides.
- **`forge-feedback` skill** — sends feedback to the ShipToday team from
  inside a session. It shows you the exact message first and sends only
  after you confirm.
- **Hooks** (`hooks/hooks.json`) — four hooks coordinate session state:
  - `beforeSubmitPrompt` → `prompt-router.cjs` (stateful routing for active
    workflows and snoozed sessions; it never reads your message to decide
    anything)
  - `stop` → `stop-observer.cjs` (passive session observation and silent
    checkpoints to record engineering time)
  - `preToolUse` → `workflow-guard.cjs` (holds tools while a question is
    waiting for you or a write is waiting for your approval)
  - `postToolUse` → `workflow-tracker.cjs` (tracks workflow state transitions
    and the active step's tool allowlist)

  The hook scripts make no network calls. They keep session state in local
  files and pass instructions to the agent.

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
> state side-effects — including recording that you replied to a question
> Forge asked — but its routing nudges are inert on Cursor. Forge starts when
> you name it, through `forge-autopilot` skill auto-discovery.

> On Cursor, Forge asks its questions in the chat — as numbered choices — and
> waits for your reply. Cursor's question tool is not visible to plugin hooks,
> so Forge cannot confirm that an answer given there came from you, and it
> does not accept one.

> Cursor also exposes no per-session model token usage to plugin hooks, so
> Forge's token capture (available in the Claude Code and Codex plugins) is
> unavailable on Cursor: Forge records no token data for Cursor sessions and
> the ShipToday dashboard reports them as not measured. Engineering-time
> checkpoints use wall-clock deltas on Cursor (no session log is available
> for idle exclusion).

## License

MIT — see `LICENSE`.
