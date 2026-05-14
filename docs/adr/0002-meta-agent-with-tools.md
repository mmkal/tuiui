# ADR 0002: Meta-Agent With Deterministic Tools

## Status

Accepted, 2026-05-14.

## Context

The previous coordinator direction treated the product mostly as a summary or visual overview. The replacement direction is for a coordinator that is itself an agent: the user should be able to ask it what is happening, what everyone is working on, and where clashes are likely.

The coordination capabilities also need to be reusable later from deterministic flows. They should not only exist as prompt text inside one Codex conversation.

The installed `@openai/codex-sdk@0.129.0` can start and resume Codex threads, continue a thread with repeated `run()` calls, and pass Codex CLI config overrides. It does not expose a direct TypeScript callback-tools parameter. The official Codex docs describe MCP servers as the supported way to add tools to Codex.

## Decision

The coordinator will be a server-side Codex SDK thread, not a PTY-backed managed session.

TUI UI will implement coordination as deterministic TypeScript functions first:

- list agents
- get an agent briefing
- prompt an agent
- subscribe to an agent's idle transition
- find exact work clashes

TUI UI will expose those functions to the coordinator through MCP, using either a same-server streamable HTTP MCP endpoint or a stdio MCP command if the HTTP path proves awkward in the local SDK/CLI flow.

The browser will expose a coordinator chat route and Home entry point through the existing ORPC client surface. This slice will not add coordinator-specific legacy JSON endpoints. The coordinator will not be listed as a normal managed session because it supervises managed sessions rather than running inside one.

`promptAgent` remains a tool, but tool availability is not enough authority to write into another agent. TUI UI will add a deterministic per-turn gate: the server permits `promptAgent` only while handling a human coordinator prompt that explicitly names a promptable agent with a forwarding verb such as "tell", "ask", "prompt", "message", or "send". Broad status questions and injected idle-event turns have no prompt-forwarding authority.

## Consequences

The useful coordination logic is testable without Codex. Later deterministic automations can call the same functions directly.

The Codex coordinator can use natural language to explain the deterministic state, but exact clash detection remains auditable TypeScript set logic.

The first implementation needs explicit coordinator server state: thread id, message/audit history, a serialized run queue, subscriptions, and idle-event injection.

`promptAgent` is intentionally narrow. It forwards a user-visible prompt through existing managed-session input paths only during a server-authorized human turn. It does not grant the coordinator general shell, kill, archive, merge, or PR authority.

Subscriptions are also limited to live managed sessions. External recent Codex sessions and exited sessions can be inspected, but they cannot promise a TUI UI idle callback.
