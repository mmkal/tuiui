---
status: complete
size: large
---

# Meta-Agent With Tools

Status: Done. The deterministic coordination functions, MCP wrapper, server coordinator state/routes, idle-event subscription hook, browser coordinator route, ORPC coverage, and Playwright route coverage are in place. Full typecheck, Bun tests, and Playwright specs are green.

## Goal

Build a coordinator that is an actual Codex agent with TUI UI coordination tools, not a bespoke deterministic summary renderer. The coordinator should be something the user can talk to:

- "what's going on?"
- "what's everybody working on?"
- "where are the clashes?"
- "tell the docs agent to look at the API change"

The coordination abilities must exist as reusable TypeScript functions first. Codex gets access to those functions through the supported tool mechanism, which is MCP in the current Codex SDK/CLI surface.

## Product Shape

The coordinator is a server-side Codex SDK thread, not a PTY-backed managed session. It should appear as a first-class Home affordance and a `/coordinator` route, but it should not be mixed into the managed session list.

The first slice is Codex-only. It should understand live TUI UI managed sessions and recent Codex sessions where practical, but it does not need Claude/OpenCode parity.

## Tool Surface

Implement deterministic TypeScript functions and expose them through MCP tools:

- `listAgents()`: return active/recent agent handles with status, task previews, cwd, route path, git metadata, dirty files, and best-effort PR number.
- `getBriefing(agentId)`: return the best available supervisory briefing for an agent, preferring an existing current session brief and falling back to provider snapshot/latest-message context.
- `promptAgent(agentId, prompt)`: send a prompt through the existing managed-session input path for live TUI UI sessions, with an audit entry.
- `subscribe(agentId)`: register interest in one agent; when it transitions from busy to idle, TUI UI injects an event prompt into the coordinator thread.
- `findClashes()`: return deterministic overlap records for dirty-file conflicts, same-branch live-agent conflicts, and best-effort same-PR conflicts.

Tool parameters should use bare string agent ids. Rich agent objects are returned by `listAgents()` and `getBriefing()`.

## Authority Boundary

The coordinator may inspect, brief, subscribe, and send prompts to managed sessions. It should not kill, archive, rebase, merge, push, close PRs, or run arbitrary shell commands through the coordination tools in this slice.

`promptAgent` should be described to Codex as a user-visible prompt forwarder. The coordinator should use it when the human explicitly asks it to tell an agent something, not as an autonomous idle-event reaction.

## Checklist

- [x] Close the two open superseded coordinator/factory-floor PRs. _Closed GitHub PR #9 and #8 with comments pointing to the new meta-agent-with-tools direction._
- [x] Create a fresh bedtime branch/worktree and capture the kickoff task. _Created `bedtime/meta-agent-with-tools` in `../worktrees/tuiui/meta-agent-as-agent` and committed the initial task stub._
- [x] Grill the main architecture decisions before implementation. _Recorded the grill transcript in `tasks/meta-agent-with-tools.interview.md`; the final recovery turn wedged, but the core decisions through coordinator surface, subscribe mechanics, agent handles, and clash detection are captured._
- [x] Add reusable TypeScript coordination functions for listing agents, reading briefings, prompting agents, subscriptions, and clash detection. _Added `src/coordinator-tools.ts` with augmented agent handles, briefing selection, reusable git metadata, prompt/subscription result types, and deterministic clash detection._
- [x] Expose the coordination functions as MCP tools that Codex can use from the SDK thread. _Added `src/coordinator-mcp.ts` with MCP tools `listAgents`, `getBriefing`, `promptAgent`, `subscribe`, and `findClashes`._
- [x] Add coordinator server state, ORPC endpoints, and a serialized run queue for user prompts and idle-event injections. _`cli.ts` now owns coordinator thread/message/audit/subscription state, ORPC coordinator routes, `/mcp/coordinator`, and a queued Codex SDK runner with fake mode for tests._
- [x] Add a browser `/coordinator` chat surface and Home entry point. _`client/app.ts` and `client/styles.css` add a Home coordinator entry and a responsive coordinator chat/sidebar route._
- [x] Wire subscribed busy-to-idle transitions to coordinator event injection without auto-prompting worker agents. _Subscribed managed sessions schedule an idle check and inject an event prompt into the coordinator queue on a busy-to-idle transition._
- [x] Add unit tests for deterministic coordination functions and clash detection. _Added `test/coordinator-tools.test.ts` and `test/coordinator-mcp.test.ts`; both pass._
- [x] Add server/ORPC tests for coordinator prompting, audit history, and subscription idle injection. _Added `test/coordinator-orpc.test.ts`, which starts a fake coordinator server, creates two managed agents, exercises ORPC coordinator prompting, calls the MCP `subscribe` tool, and verifies the subscribed idle event/audit._
- [x] Add a focused Playwright spec for the coordinator route with fake agents. _Added `spec/tuiui.spec.ts` coverage for `/coordinator`, the managed-agent sidebar, clash panel, and fake Codex coordinator replies._
- [x] Run typecheck, unit tests, and relevant Playwright specs. _Verified with `bun run typecheck`, `bun test test`, `bun run spec`, and the focused coordinator commands `bun test test/coordinator-orpc.test.ts test/coordinator-tools.test.ts test/coordinator-mcp.test.ts` plus `bun run spec --grep "shows the coordinator chat"`._
- [x] Move this task to `tasks/complete/` once the PR branch is complete and update the PR body. _Moved the task and grill transcript to `tasks/complete/` with a 2026-05-14 date prefix; PR body update is the final GitHub housekeeping step after this commit._

## Guesses And Assumptions

- [guess: implementation route] Use an HTTP MCP endpoint on the same TUI UI server if the SDK/CLI accepts local streamable HTTP cleanly; fall back to a stdio MCP command if HTTP is awkward in tests.
- [guess: scope control] Idle-event injection should wake the coordinator and record a visible note, but should not automatically call `promptAgent` on another worker.
- [guess: PR metadata] `prNumber` should be best-effort only. `gh pr view --json number` can fail because GitHub CLI auth, network, or branch state is unavailable; `listAgents()` should still succeed.

## Out Of Scope

- Reopening or building on the two closed PRs.
- Full Claude/OpenCode parity.
- A factory-floor visual overview.
- Voice routing beyond leaving the coordinator chat shape compatible with later voice input.
- Autonomous destructive actions.
- Semantic conflict inference as a deterministic tool. The first `findClashes()` is exact, auditable metadata only.

## Implementation Notes

- Official Codex SDK docs describe the TypeScript SDK as a way to control Codex programmatically.
- Official Codex MCP/config docs describe MCP servers in `config.toml` or project `.codex/config.toml`, including stdio and streamable HTTP server entries.
- The installed `@openai/codex-sdk@0.129.0` exposes `Codex.startThread`, `Codex.resumeThread`, repeated `Thread.run()`, config overrides, and MCP tool-call stream items, but not direct TypeScript callback tools.
- The existing TUI UI session brief contract is already the right source for `getBriefing(agentId)` where available.
- 2026-05-14: Implemented the first section and verified with `bun run typecheck` plus `bun test test/coordinator-tools.test.ts test/coordinator-mcp.test.ts`.
- 2026-05-14: Added server/ORPC and browser route coverage. The ORPC test intentionally uses `git status --porcelain=v1 --untracked-files=all` so deterministic dirty-file clashes report exact untracked paths instead of only the parent directory.
- 2026-05-14: Full verification passed with `bun run typecheck`, `bun test test`, and `bun run spec`. While running the full Playwright suite, nudged the mobile toast offset below the session appbar.
- 2026-05-14: Post-review cleanup removed the new coordinator legacy JSON routes entirely. The browser coordinator talks to ORPC directly, and the server coverage lives in `test/coordinator-orpc.test.ts`.
- 2026-05-14: Post-review authority hardening added a deterministic per-turn `promptAgent` gate. The server only permits a `promptAgent` tool call during a coordinator turn when the human prompt explicitly names a promptable agent with verbs like "tell" or "ask"; event turns and broad status questions have no forwarding authority.
