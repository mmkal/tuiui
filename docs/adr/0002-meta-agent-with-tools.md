# ADR 0002: Meta-Agent With Deterministic Tools

## Status

Accepted, 2026-05-14. Revised after product review on 2026-05-14.

## Context

The previous coordinator direction treated the product mostly as a summary or visual overview. The replacement direction is for a coordinator that is itself an agent: the user should be able to ask it what is happening, what everyone is working on, and where clashes are likely.

The coordination capabilities also need to be reusable later from deterministic flows. They should not only exist as prompt text inside one Codex conversation.

The first implementation tried a server-side Codex SDK thread with a custom browser `/coordinator` chat route. Product review rejected that shape. The coordinator is not special because it has custom UI; it is special because it has a coordination role and tools.

Installed Codex CLI help confirms that interactive Codex sessions accept config overrides with `-c`, can start with an initial prompt, and can configure streamable HTTP MCP servers with a bearer-token environment variable. That is enough to run the coordinator as a normal TUI-managed Codex process while still giving it tools.

## Decision

The coordinator is a normal PTY-backed Codex session rendered through the existing `/sessions/:id` TUI. TUI UI exposes a `coordinator` launch preset that starts `codex` with:

- a local streamable HTTP MCP server at `/mcp/coordinator`;
- `listAgents`, `getBriefing`, `promptAgent`, `subscribe`, and `findClashes` enabled;
- a coordinator role prompt as the initial Codex prompt;
- read-only sandboxing and normal interactive approval behavior.

TUI UI implements coordination as deterministic TypeScript functions first:

- list active and recent agents with status, task preview, route path, git metadata, dirty files, and best-effort PR number;
- get an agent briefing, preferring the current structured session brief and falling back to provider or terminal snapshots;
- prompt a live managed agent through the existing session input path;
- subscribe to a live managed agent's idle transition;
- find exact dirty-file, same-branch, and same-PR clashes.

The MCP endpoint is protected by a per-server bearer token. The server passes that token only to coordinator sessions through `TUIUI_COORDINATOR_MCP_TOKEN`.

`promptAgent` remains a tool, but tool availability is not enough authority to write into another agent. The server permits `promptAgent(agentId, prompt)` only when the coordinator session's latest non-empty stdin event explicitly names that `agentId` with a forwarding verb such as "tell", "ask", "prompt", "message", or "send". A successful call consumes the grant for that `(stdinEventId, agentId)` pair. One human prompt can authorize multiple target agents if it explicitly names them, but only one successful call per target.

Subscribed idle events are injected into the coordinator session through the same session input path. That means an idle event becomes the latest stdin event and intentionally revokes any older human forwarding grant. Idle events do not contain forwarding verbs, so they cannot authorize autonomous `promptAgent` calls.

## Consequences

The useful coordination logic is testable without Codex and can be reused later by deterministic automations.

The browser does not need coordinator-specific chat state, polling, ORPC get/send endpoints, custom CSS, or a fake coordinator mode. The existing session TUI is the coordinator UI.

The coordinator can use natural language to explain deterministic state, but exact clash detection remains auditable TypeScript set logic.

`promptAgent` is intentionally narrow. It forwards a user-visible prompt through existing managed-session input paths only during a server-authorized human turn. It does not grant shell, kill, archive, merge, push, PR, or history-rewrite authority.

Subscriptions are limited to live managed sessions. External recent Codex sessions and exited sessions can be inspected, but they cannot promise a TUI UI idle callback.
