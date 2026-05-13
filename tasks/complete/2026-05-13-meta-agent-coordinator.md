---
status: implemented
size: large
---

# Meta-Agent Coordinator

Status: Implemented for the first deterministic coordinator slice. The branch now has a provider-neutral summary model/API, a compact home-page supervisor panel, and confirmation-gated prompt forwarding into exact selected live TUI session ids. Missing pieces are intentionally future-scoped: no autonomous provider/LLM behavior and no factory-floor visualization.

## Goal

Build a somewhat dumb meta-agent whose job is to keep an eye on other agent sessions, talk to the user about how those sessions are going, coordinate between them, and relay rough voice-directed prompts to the right session.

## Notes

The coordinator is not meant to be a deeply independent planner. It should be closer to an operations assistant for the human: maintain a live "state of the agents" view, notice stale or idle sessions, answer "what's going on?", and send user instructions to the appropriate session when the user talks through work over voice.

This probably needs a structured session summary representation that is useful to humans, agents, and the UI. It should include active and recent sessions, provider, title, cwd/repo, branch/worktree, status, last activity, current task summary, blockers, pending user decisions, PR/task links, and confidence/freshness. The representation should be cheap to update and should degrade gracefully when a provider cannot expose a rich summary.

The first useful version can be conservative: observe sessions, maintain summaries, and ask before sending prompts. Later versions can coordinate more actively, such as nudging one agent with context from another, asking a reviewer agent to inspect a PR, or suggesting follow-up work.

## Bedtime Scope

Build the meta-agent as product/system behavior before making it a real AI agent. The first slice should expose a provider-neutral session summary from the backend, render it as a supervisor/coordinator view in the client, and let the user choose a target session for a forwarded prompt. Sending into another session must require an explicit confirmation click.

The summary should use data TUI UI already has: live sessions, persisted session recovery metadata when available, recent provider sessions, cwd, title, provider, status, lifecycle, last activity, branch/worktree hints if cheaply discoverable, and available session brief/status text. If a field cannot be known cheaply, return an empty value with freshness/confidence metadata rather than blocking the endpoint.

Voice can be represented by the same routing model as typed coordinator input in this first pass. The existing voice code can be wired later to fill the coordinator prompt box; the important piece tonight is the target resolution and confirmation boundary.

## Checklist

- [x] Define the provider-neutral state-of-the-agents summary schema for active and recent agents. _Implemented as `tuiui.coordinatorSummary.v1` in `src/meta-agent-coordinator.ts`._
- [x] Identify the current sources of truth for sessions, titles, providers, status, cwd, branches, task files, PRs, recovery commands, and session briefs. _Mapped live runtime payloads, provider recent-session readers, git cwd metadata, recovery commands, and structured session briefs in `cli.ts` and the summary model._
- [x] Add a backend endpoint that returns a consolidated state-of-the-agents summary. _Added `GET /api/coordinator/summary` in `cli.ts`._
- [x] Render a supervisor/coordinator client surface that can answer "what is going on?" from that summary without a new LLM call. _Added the home-page Coordinator panel in `client/app.ts` and `client/styles.css`._
- [x] Add a typed prompt-routing flow where the user chooses or resolves a target session. _Added live-session target selection in the Coordinator panel and deterministic target resolution in `resolveCoordinatorTarget`._
- [x] Require explicit user confirmation before the coordinator sends a prompt into another agent session. _Added staged UI confirmation and `POST /api/coordinator/forward` rejection unless `confirmed: true`._
- [x] Add an audit trail in the UI showing what the coordinator observed and forwarded during the page session. _Added page-session audit entries for observations, successes, and forwarding failures in `client/app.ts`._
- [x] Add tests around summary freshness, target-session resolution, and prompt-forwarding confirmation. _Added `test/meta-agent-coordinator.test.ts` and a focused Playwright spec in `spec/tuiui.spec.ts`._
- [x] Document the coordinator's authority boundaries so future agents do not make it too autonomous by accident. _Documented boundaries in the task status and in the summary API `authority` payload._

## Open Questions

- Should the meta-agent itself be a normal Codex/Claude/OpenCode session, or a dedicated deterministic coordinator with optional LLM calls?
- What is the minimal summary that can be generated reliably across Codex, Claude, and OpenCode?
- How should it identify "who is working on what" when the session title is vague or stale?
- Should it read task files, git branches, PR metadata, process state, browser state, or all of those?
- How should voice commands disambiguate between several plausible target agents?
- Can the coordinator send prompts to agents running outside TUI UI, or only sessions that TUI UI owns?
- What should it do when two agents are about to edit the same files or otherwise conflict?

## Implementation Log

- 2026-05-13: Captured task from the request for a dumb coordinating meta-agent that can track separate sessions and relay rough voice prompts.
- 2026-05-13: Bedtime scope narrowed to deterministic coordination: expose a state summary, render a supervisor surface, and forward prompts only after explicit confirmation.
- 2026-05-13: Implemented `GET /api/coordinator/summary` and `POST /api/coordinator/forward`, plus the home-page supervisor UI and page-session audit trail.
- 2026-05-13: Verified with `bun test test/meta-agent-coordinator.test.ts`, `bun run spec --grep "coordinator summary"`, and `bun run typecheck`.
- 2026-05-13: Review fix: tightened `POST /api/coordinator/forward` to exact `targetSessionId` only, cached recent-provider and workspace metadata reads, and verified fuzzy forwarding rejection.
