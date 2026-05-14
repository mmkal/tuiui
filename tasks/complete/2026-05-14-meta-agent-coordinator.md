---
status: complete
size: large
---

# Meta-Agent Coordinator

Status: Superseded by the merged coordinator-agent implementation in PR #13. The normal TUI session coordinator, MCP tool boundary, session inspection tools, and authority rules shipped there. Voice routing remains a separate follow-up, now tracked outside this original broad task.

## Goal

Build a somewhat dumb meta-agent whose job is to keep an eye on other agent sessions, talk to the user about how those sessions are going, coordinate between them, and relay rough voice-directed prompts to the right session.

## Notes

The coordinator is not meant to be a deeply independent planner. It should be closer to an operations assistant for the human: maintain a live "state of the agents" view, notice stale or idle sessions, answer "what's going on?", and send user instructions to the appropriate session when the user talks through work over voice.

This probably needs a structured session summary representation that is useful to humans, agents, and the UI. It should include active and recent sessions, provider, title, cwd/repo, branch/worktree, status, last activity, current task summary, blockers, pending user decisions, PR/task links, and confidence/freshness. The representation should be cheap to update and should degrade gracefully when a provider cannot expose a rich summary.

The first useful version can be conservative: observe sessions, maintain summaries, and ask before sending prompts. Later versions can coordinate more actively, such as nudging one agent with context from another, asking a reviewer agent to inspect a PR, or suggesting follow-up work.

## Checklist

- [x] Define the session-state summary schema for active and recent agents. _Implemented through the coordinator MCP tool payloads in `src/coordinator-tools.ts`._
- [x] Identify the current sources of truth for sessions, titles, providers, status, cwd, branches, task files, and PRs. _Implemented by `listAgents`, `findClashes`, and briefing helpers in `src/coordinator-tools.ts`._
- [x] Add a backend or client-visible endpoint that returns a consolidated state-of-the-agents summary. _Implemented as coordinator MCP tools in `src/coordinator-mcp.ts` instead of another browser JSON endpoint._
- [x] Create a coordinator session type or role that can read the summary and produce concise status updates for the user. _Implemented by the coordinator launch path and command preset in PR #13._
- ~~[ ] Add a voice-routing flow where the user can roughly address an agent and the coordinator resolves the target session.~~ _Moved to the follow-up voice/coordinator task requested on 2026-05-14._
- [x] Require explicit user confirmation before the coordinator sends a prompt into another agent session in the first version. _The `promptAgent` tool contract only accepts user-authorized targets._
- ~~[ ] Add an audit trail showing what the coordinator observed, summarized, and forwarded.~~ _Left to the normal session transcript and future voice-routing work rather than blocking PR #13._
- [x] Add tests around summary freshness, target-session resolution, and prompt-forwarding confirmation. _Covered by `test/coordinator-tools.test.ts`, `test/coordinator-mcp.test.ts`, and `test/coordinator-runtime.test.ts`._
- [x] Document the coordinator's authority boundaries so future agents do not make it too autonomous by accident. _Documented in `docs/adr/0002-meta-agent-with-tools.md` and AGENTS instructions._

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
- 2026-05-14: Moved to complete after PR #13 merged. Voice routing remains a separate follow-up.
