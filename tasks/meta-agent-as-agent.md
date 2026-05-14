---
status: ready
size: large
---

# Meta-Agent As Agent

**Status:** Spec complete, implementation in progress.

**Done:** Task spec and design decisions locked through grilling session. Branch/worktree active. Two superseded PRs (coordinator-summary, factory-floor) closed.

**Missing:** All implementation — coordinator tools, MCP server, Codex thread manager, subscription registry, CLI wiring, browser chat UI, tests.

---

## Goal

Build a Codex-only first slice where a coordinator is itself a Codex agent. TUI UI owns deterministic TypeScript coordination functions, exposes them to the coordinator as tools via a local HTTP MCP server, and gives the user a conversational surface for asking "what's going on?", "what is everybody working on?", "where are the clashes?"

The deterministic functions must also be directly reusable by future non-LLM flows (no LLM required to call them).

---

## Architecture Decisions (from grilling)

### Coordinator surface
Server-side Codex SDK thread (`@openai/codex-sdk`), not a PTY-backed managed session. A dedicated browser chat widget surfaces it as a first-class Home affordance (not mixed into the sessions list). The coordinator supervises sessions; it is not one of them.

### MCP wiring
TUI UI runs a local HTTP MCP server (Streamable HTTP transport). The Codex SDK thread is started with a config override pointing `mcp_servers.tuiui` at `http://localhost:<port>/mcp`. Fall back to stdio MCP if HTTP is awkward in tests.

### `subscribe(agent)` mechanics
Deterministic subscription registry (in-memory, keyed by agentId). When a watched agent transitions `busy/running → idle`, TUI UI injects a concise event prompt into the coordinator Codex thread via `thread.run()` (same `Thread` instance) or `resumeThread(id)` if the in-memory object was lost. The idle event updates the coordinator's answerable state and produces an audit log note — it does **not** automatically call `promptAgent` on any worker. Worker prompting is always user-initiated.

### AgentHandle / `listAgents()` shape
Tool parameters (`promptAgent`, `getBriefing`, `subscribe`) accept bare string `agentId`.

`listAgents()` returns augmented entries:
```ts
interface AgentEntry {
  id: string                  // TUI UI session id
  provider: string
  title: string
  cwd: string
  status: "busy" | "idle" | "exited"
  lifecycle: "running" | "exited"
  updatedAt: string | null
  lastOutputAt: string | null
  latestUserText: string | null
  latestAssistantText: string | null
  gitRoot: string | null       // from git rev-parse --show-toplevel
  branch: string | null        // from git rev-parse --abbrev-ref HEAD
  dirtyFiles: string[]         // from git diff --name-only (staged + unstaged)
  prNumber: number | null      // best-effort: gh pr view --json number
  routePath: string            // /sessions/<id>
}
```

`prNumber` is best-effort: return `null` on any failure (missing gh, no auth, network down).

### Clash detection: `findClashes()`
Deterministic TypeScript function, no LLM. Reports:
- **File overlaps:** agents sharing the same dirty file within the same git root
- **Branch overlaps:** multiple live agents on the same branch within the same git root  
- **PR overlaps:** multiple live agents resolving to the same PR number

No semantic "these tasks sound related" matching in this slice.

---

## Checklist

- [ ] `src/coordinator/tools.ts` — deterministic coordination functions:
  - `listAgents(): Promise<AgentEntry[]>`
  - `getBriefing(agentId: string): Promise<StructuredSessionBrief | null>`
  - `promptAgent(agentId: string, prompt: string): Promise<void>`
  - `subscribe(agentId: string): Promise<void>`
  - `findClashes(): Promise<ClashReport>`
- [ ] `src/coordinator/mcp-server.ts` — HTTP MCP server (Streamable HTTP) exposing the five tools above; also exports a stdio handler for test use
- [ ] `src/coordinator/thread.ts` — Codex SDK thread manager:
  - Holds active `Thread` object + thread ID
  - Serializes runs through a promise queue (no concurrent `run()` calls)
  - `injectEvent(prompt: string)` for idle-trigger injection
  - Persists thread ID to SQLite (`coordinator_thread` table) for recovery across server restarts
- [ ] `src/coordinator/subscription-registry.ts` — in-memory registry; `subscribe(agentId)`, `unsubscribe(agentId)`, `notify(agentId, event)` hook called from session idle transition
- [ ] `cli.ts` additions:
  - Start MCP HTTP server on startup (or lazily on first coordinator chat)
  - Wire session status transitions to subscription registry (`notify` on `busy→idle`)
  - New ORPC procedures: `coordinator.chat(message)` (streaming), `coordinator.history()`, `coordinator.status()`
- [ ] `client/` — coordinator chat widget:
  - Distinct section on Home page, below sessions list, titled "Coordinator"
  - Simple message/response chat UI (reuse existing style tokens)
  - Uses `coordinator.chat` streaming ORPC route
  - Shows audit log notes from idle-event injections
- [ ] Tests:
  - `test/coordinator-tools.test.ts` — unit tests for `listAgents`, `findClashes`, `getBriefing` against fixture sessions
  - `test/coordinator-mcp.test.ts` — MCP server tool-call round-trip (stdio transport for test isolation)
  - `test/coordinator-thread.test.ts` — thread manager promise queue and event injection (with a mock Codex thread)

---

## Out of Scope (first cut)

- Non-Codex providers for the coordinator itself
- Automatic coordinator-initiated `promptAgent` calls (user-driven only)
- Visual factory floor UI
- Semantic clash detection (LLM-inferred task overlap)
- Voice routing beyond leaving hooks for later integration
- "Where are the clashes?" semantic reasoning (coordinator narrates from deterministic `findClashes()` output)

---

## Implementation Log

- 2026-05-14: Created the new task branch/worktree after closing the two open superseded PRs.
- 2026-05-14: Full spec written after grilling session. All five design pressure points resolved.
