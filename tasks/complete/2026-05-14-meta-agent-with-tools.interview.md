# Meta-Agent With Tools Interview

## Q1 - coordinator surface - 2026-05-14T07:46:00+01:00

**Question 1: Coordinator surface — managed PTY session vs. server-side SDK thread**

Two options:

**A — Managed session (PTY):** TUI UI spawns `codex` as a terminal session (same as any other agent). It lands in the sessions list, gets briefs, goes idle, etc. The existing `sendSessionPayload` path feeds it user messages. MCP config points at a TUI UI tool server.

**B — Server-side SDK thread:** TUI UI drives `@openai/codex-sdk` programmatically from within the server process. A minimal browser chat widget (new ORPC route + thin client component) handles the conversational back-and-forth directly, no PTY involved.

**Recommendation from grill:** B. The "just talk to it" use case is a chat conversation, not a terminal session. The Codex SDK is already installed. Building a thin streaming chat route on top of ORPC keeps the coordinator logically separate from the agents it supervises.

## A1 - 2026-05-14T07:48:00+01:00

Agree with B, with one product caveat. The coordinator should not be a managed PTY session in the first cut. It should be a server-side Codex SDK thread owned by TUI UI, and the browser should expose it as a coordinator chat surface. That preserves the "actual agent" requirement without forcing it through terminal rendering.

The deterministic TypeScript functions remain the real product boundary. The coordinator gets them through MCP because that is the supported Codex tool path in the current docs/SDK: Codex config can declare `mcp_servers`, and the SDK can pass config overrides when starting a thread. [guess: implementation route] Use an HTTP MCP endpoint on the same TUI UI server if the SDK/CLI accepts local streamable HTTP cleanly; fall back to a stdio MCP command if HTTP is awkward in tests.

The coordinator should still be visible as a first-class Home affordance, but not mixed into the managed session list. It supervises sessions; it is not one of the PTY-backed sessions.

---

## Q2 - subscribe mechanics - 2026-05-14T07:53:00+01:00

**Question 2: `subscribe(agent)` mechanics — how does push work in a request/response tool world?**

Options:

**A — TUI UI event injection:** `subscribe(agent)` writes a subscription record in TUI UI state. When a watched agent transitions to idle, TUI UI sends a new message into the coordinator's Codex SDK thread saying "agent X is now idle; brief attached."

**B — Polling loop the coordinator drives:** `subscribe(agent)` returns a subscription token. The coordinator calls `poll(token)` on a loop until an event arrives.

**C — Defer to later; first cut omits `subscribe`.**

**Recommendation from grill:** A for the first cut, with only one concrete trigger: idle transition.

## A2 - 2026-05-14T07:55:00+01:00

Agree with A. Implement `subscribe(agent)` now as a deterministic registry plus one trigger: busy/running to idle. Do not add a polling tool for this slice.

The SDK supports continuing a thread by calling `run()` repeatedly on the same `Thread` instance, and `resumeThread(id)` exists if the in-memory object is lost. So the coordinator state should hold the active thread object and its id, serialize runs through a promise queue, and inject a concise event prompt when a watched agent transitions to idle.

[guess: scope control] The idle event should not automatically call `promptAgent` on another worker. It should wake the coordinator with context so it can update its answerable state and, at most, produce a note visible in the coordinator chat/audit log. Actual worker prompting should remain tied to the user asking the coordinator to tell an agent something.

---

## Q3 - agent handles - 2026-05-14T08:00:00+01:00

**Question 3: `AgentHandle` shape — what does `listAgents()` return, and what do tool parameters accept?**

Recommendation from grill:

- Tool parameters should accept bare string ids.
- `listAgents()` should return augmented entries rather than only the current `RecentAgentSession` shape, adding cheap branch/PR metadata so the coordinator can answer clash questions without full briefings for every agent.

## A3 - 2026-05-14T08:02:00+01:00

Agree with bare string ids for `promptAgent(agentId, prompt)`, `getBriefing(agentId)`, and `subscribe(agentId)`.

Agree with augmented `listAgents()`, but include changed-file metadata as the first deterministic clash signal. Branch and PR are helpful, but "where are the clashes?" is really about overlapping work. The first-cut agent entry should include:

- stable `id`, with managed TUI UI sessions using their session id
- provider, title, cwd, status, lifecycle, updated/last-output times
- latest user/assistant previews when known
- `gitRoot`, `branch`, `dirtyFiles`, and `prNumber` when cheaply available
- `routePath` for browser links

[guess: PR metadata] `prNumber` should be best-effort only. Use `gh pr view --json number` when available and fast enough, but return `null` on any failure. Do not make `listAgents()` fragile because GitHub CLI auth or network is missing.

---

## Q4 - clash detection - 2026-05-14T08:06:00+01:00

**Question 4: Clash detection — deterministic tool or LLM inference?**

Recommendation from grill: add a deterministic `findClashes()` tool that computes file-set intersections server-side and returns structured clash records. The coordinator can narrate or enrich the result, but it should not do exact set intersection itself.

## A4 - 2026-05-14T08:08:00+01:00

Agree with deterministic `findClashes()`. This is exactly the kind of logic that should be reusable without an LLM later.

For the first cut, `findClashes()` should report:

- exact dirty-file overlaps within the same git root
- multiple live agents on the same branch in the same git root
- best-effort PR overlap if multiple agents resolve to the same PR number

It should not attempt semantic "these tasks sound related" matching yet. The coordinator can infer and explain that qualitatively from briefings, but the tool's structured output should stay auditable.

---
