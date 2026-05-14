---
status: in-progress
size: large
---

# Meta-Agent With Tools

Status: Pivoting after product review. The reusable coordination tools and MCP wrapper are still the right foundation. The browser-specific coordinator chat route, server-side SDK thread, fake coordinator mode, and coordinator-specific UI are being removed. The coordinator should launch as a normal managed Codex session in the existing TUI, with MCP tools wired into that Codex process.

## Goal

Build a coordinator that is an actual Codex agent with TUI UI coordination tools, not a bespoke deterministic summary renderer or a bespoke browser chat UI. The coordinator should be something the user can talk to in the same TUI surface as any other agent:

- "what's going on?"
- "what's everybody working on?"
- "where are the clashes?"
- "tell the docs agent to look at the API change"

The coordination abilities must exist as reusable TypeScript functions first. Codex gets access to those functions through the supported tool mechanism, which is MCP in the current Codex CLI surface.

## Product Shape

The coordinator is a PTY-backed Codex session like any other managed agent. The existing session route is the UI. The only special pieces are:

- a coordinator launch preset that starts Codex with TUI UI's coordinator MCP tools enabled;
- a coordinator system prompt explaining the role and boundaries;
- server-side MCP handlers for deterministic tools;
- subscription plumbing that can wake the coordinator session when watched agents go idle.

The first slice is Codex-only. It should understand live TUI UI managed sessions and recent Codex sessions where practical, but it does not need Claude/OpenCode parity.

## Tool Surface

Implement deterministic TypeScript functions and expose them through MCP tools:

- `listAgents()`: return active/recent agent handles with status, task previews, cwd, route path, git metadata, dirty files, and best-effort PR number.
- `getBriefing(agentId)`: return the best available supervisory briefing for an agent, preferring an existing current session brief and falling back to provider snapshot/latest-message context.
- `promptAgent(agentId, prompt)`: send a prompt through the existing managed-session input path for live TUI UI sessions, with a deterministic authority check.
- `subscribe(agentId)`: register interest in one agent; when it transitions from busy to idle, TUI UI injects an event prompt into the coordinator's managed Codex session.
- `findClashes()`: return deterministic overlap records for dirty-file conflicts, same-branch live-agent conflicts, and best-effort same-PR conflicts.

Tool parameters should use bare string agent ids. Rich agent objects are returned by `listAgents()` and `getBriefing()`.

## Authority Boundary

The coordinator may inspect, brief, subscribe, and send prompts to managed sessions. It should not kill, archive, rebase, merge, push, close PRs, or run arbitrary shell commands through the coordination tools in this slice.

`promptAgent` should be described to Codex as a user-visible prompt forwarder. The coordinator should use it when the human explicitly asks it to tell an agent something, not as an autonomous idle-event reaction. Because the coordinator is now a normal session, the deterministic gate should derive authority from the coordinator session's latest human-entered stdin instead of from a custom chat route.

## Checklist

- [x] Close the two open superseded coordinator/factory-floor PRs. _Closed GitHub PR #9 and #8 with comments pointing to the new meta-agent-with-tools direction._
- [x] Create a fresh bedtime branch/worktree and capture the kickoff task. _Created `bedtime/meta-agent-with-tools` in `../worktrees/tuiui/meta-agent-as-agent` and committed the initial task stub._
- [x] Grill the main architecture decisions before implementation. _Recorded the grill transcript in `tasks/meta-agent-with-tools.interview.md`; the final recovery turn wedged, but the core decisions through coordinator surface, subscribe mechanics, agent handles, and clash detection are captured._
- [x] Add reusable TypeScript coordination functions for listing agents, reading briefings, prompting agents, subscriptions, and clash detection. _Added `src/coordinator-tools.ts` with augmented agent handles, briefing selection, reusable git metadata, prompt/subscription result types, and deterministic clash detection._
- [x] Expose the coordination functions as MCP tools. _Added `src/coordinator-mcp.ts` with MCP tools `listAgents`, `getBriefing`, `promptAgent`, `subscribe`, and `findClashes`._
- [ ] Replace the custom browser coordinator route with a normal coordinator launch preset. _Remove `/coordinator`, coordinator ORPC get/send state, fake coordinator replies, and bespoke coordinator CSS; launch Codex into `/sessions/:id` with MCP config instead._
- [ ] Protect the coordinator MCP endpoint. _Use a per-server bearer token passed only to the coordinator Codex session, so a LAN client cannot directly call `promptAgent`._
- [ ] Gate `promptAgent` from the coordinator session's latest human prompt. _The server should reject forwarded prompts unless the last coordinator stdin explicitly named the target agent with a forwarding verb._
- [ ] Wire subscribed busy-to-idle transitions to the managed coordinator session. _Subscribed managed sessions schedule an idle check and inject an event prompt into the coordinator session on a busy-to-idle transition._
- [ ] Replace server/ORPC coordinator tests with managed-session MCP tests. _Exercise MCP auth, list/brief/clash tools, prompt forwarding, and idle-event injection through normal session APIs._
- [ ] Replace the Playwright coordinator-route spec with normal session launch coverage. _The browser proof should show the existing TUI route launching a coordinator session, not a bespoke coordinator page._
- [ ] Run typecheck, unit tests, Playwright specs, and update PR media/body. _The PR body needs fresh screenshots or video of the normal TUI coordinator flow plus the Tailscale demo link._
- [ ] Move this task back to `tasks/complete/` once the PR branch is complete. _Keep it open until the pivot is implemented and verified._

## Guesses And Assumptions

- [guess: implementation route] Use an HTTP MCP endpoint on the same TUI UI server because installed `codex mcp add --help` supports streamable HTTP MCP servers with `--url` and bearer token env vars.
- [guess: scope control] Idle-event injection should wake the coordinator session and record a visible note, but should not automatically call `promptAgent` on another worker.
- [guess: authority] The latest coordinator stdin event is the right deterministic source for `promptAgent` forwarding authority because it preserves the normal TUI surface without giving idle-event injections write authority.
- [guess: PR metadata] `prNumber` should be best-effort only. `gh pr view --json number` can fail because GitHub CLI auth, network, or branch state is unavailable; `listAgents()` should still succeed.

## Out Of Scope

- Reopening or building on the two closed PRs.
- Full Claude/OpenCode parity.
- A factory-floor visual overview.
- A custom coordinator browser page.
- Voice routing beyond the existing session promptbox.
- Autonomous destructive actions.
- Semantic conflict inference as a deterministic tool. The first `findClashes()` is exact, auditable metadata only.

## Implementation Notes

- Official Codex SDK docs describe the TypeScript SDK as a way to control Codex programmatically.
- Installed `codex --help` supports `-c key=value` config overrides, `--sandbox read-only`, `--ask-for-approval on-request`, and an initial prompt argument for the interactive TUI.
- Installed `codex mcp add --help` supports streamable HTTP MCP servers with `--url` and `--bearer-token-env-var`, which is the mechanism this pivot uses through config overrides.
- The existing TUI UI session brief contract is already the right source for `getBriefing(agentId)` where available.
- 2026-05-14: Implemented the first section and verified with `bun run typecheck` plus `bun test test/coordinator-tools.test.ts test/coordinator-mcp.test.ts`.
- 2026-05-14: Added server/ORPC and browser route coverage. The ORPC test intentionally uses `git status --porcelain=v1 --untracked-files=all` so deterministic dirty-file clashes report exact untracked paths instead of only the parent directory.
- 2026-05-14: Full verification passed with `bun run typecheck`, `bun test test`, and `bun run spec`. While running the full Playwright suite, nudged the mobile toast offset below the session appbar.
- 2026-05-14: Post-review cleanup removed the new coordinator legacy JSON routes entirely. The browser coordinator talks to ORPC directly, and the server coverage lives in `test/coordinator-orpc.test.ts`.
- 2026-05-14: Post-review authority hardening added a deterministic per-turn `promptAgent` gate. The server only permits a `promptAgent` tool call during a coordinator turn when the human prompt explicitly names a promptable agent with verbs like "tell" or "ask"; event turns and broad status questions have no forwarding authority.
- 2026-05-14: Product review rejected the custom coordinator UI. The next pass treats the coordinator as a normal Codex session rendered through the existing TUI, with only its tools and role prompt made special.
