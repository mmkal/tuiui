---
status: complete
size: large
---

# Meta-Agent With Tools

Status: Done. The coordinator is now a normal managed Codex session rendered through the existing TUI, backed by deterministic TypeScript coordination tools exposed over a token-protected MCP endpoint. The custom `/coordinator` browser UI, server-side SDK thread, fake coordinator mode, and coordinator-specific ORPC chat state have been removed. Full typecheck, Bun tests, and Playwright specs are green; fresh PR media and the Tailscale demo link are in the PR body.

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

`promptAgent` should be described to Codex as a user-visible prompt forwarder. The coordinator should use it when the human explicitly asks it to tell an agent something, not as an autonomous idle-event reaction. Because the coordinator is now a normal session, the deterministic gate derives authority from the coordinator session's latest stdin event instead of from a custom chat route. A successful forward consumes the grant for that `(stdinEventId, agentId)` pair.

## Checklist

- [x] Close the two open superseded coordinator/factory-floor PRs. _Closed GitHub PR #9 and #8 with comments pointing to the new meta-agent-with-tools direction._
- [x] Create a fresh bedtime branch/worktree and capture the kickoff task. _Created `bedtime/meta-agent-with-tools` in `../worktrees/tuiui/meta-agent-as-agent` and committed the initial task stub._
- [x] Grill the main architecture decisions before implementation. _Recorded the grill transcript in `tasks/meta-agent-with-tools.interview.md`; the final recovery turn wedged, but the core decisions through coordinator surface, subscribe mechanics, agent handles, and clash detection are captured._
- [x] Add reusable TypeScript coordination functions for listing agents, reading briefings, prompting agents, subscriptions, and clash detection. _Added `src/coordinator-tools.ts` with augmented agent handles, briefing selection, reusable git metadata, prompt/subscription result types, and deterministic clash detection._
- [x] Expose the coordination functions as MCP tools. _Added `src/coordinator-mcp.ts` with MCP tools `listAgents`, `getBriefing`, `promptAgent`, `subscribe`, and `findClashes`._
- [x] Replace the custom browser coordinator route with a normal coordinator launch preset. _Removed `/coordinator`, coordinator ORPC get/send state, fake coordinator replies, and bespoke coordinator CSS; Home now launches a `coordinator` Codex preset into `/sessions/:id` with MCP config._
- [x] Protect the coordinator MCP endpoint. _`/mcp/coordinator` now requires a per-server bearer token, and coordinator sessions receive that token through `TUIUI_COORDINATOR_MCP_TOKEN`._
- [x] Gate `promptAgent` from the coordinator session's latest human prompt. _The server rejects forwarded prompts unless the latest coordinator stdin explicitly names the target agent with a forwarding verb._
- [x] Wire subscribed busy-to-idle transitions to the managed coordinator session. _Subscribed managed sessions now schedule an idle check and inject an event prompt into the coordinator session on a busy-to-idle transition._
- [x] Replace server/ORPC coordinator tests with managed-session MCP tests. _Added `test/coordinator-runtime.test.ts`, which exercises MCP auth, list/brief/clash tools, prompt forwarding, and idle-event injection through normal session APIs._
- [x] Replace the Playwright coordinator-route spec with normal session launch coverage. _Updated `spec/tuiui.spec.ts` so the browser proof launches a coordinator session through the existing TUI route, not a bespoke coordinator page._
- [x] Grill and document the managed-session authority decision. _Captured the pivot grill in `tasks/meta-agent-with-tools.pivot-grill.md` and revised `docs/adr/0002-meta-agent-with-tools.md` to record the normal-session architecture plus consumed prompt grants._
- [x] Run typecheck, unit tests, Playwright specs, and update PR media/body. _Full verification passed with `bun run typecheck`, `bun test test`, and `bun run spec`; fresh normal-session screenshot/video assets were captured from the coordinator launch spec for the PR body._
- [x] Move this task back to `tasks/complete/` once the PR branch is complete. _Moved back to `tasks/complete/2026-05-14-meta-agent-with-tools.md` after the pivot and verification were complete._

## Guesses And Assumptions

- [guess: implementation route] Use an HTTP MCP endpoint on the same TUI UI server because installed `codex mcp add --help` supports streamable HTTP MCP servers with `--url` and bearer token env vars.
- [guess: scope control] Idle-event injection should wake the coordinator session and record a visible note, but should not automatically call `promptAgent` on another worker.
- [guess: authority] The latest coordinator stdin event is the right deterministic source for `promptAgent` forwarding authority because it preserves the normal TUI surface without giving idle-event injections write authority.
- [guess: authority] A successful `promptAgent` call should consume the grant for one target so a model cannot repeatedly write to the same worker from one human instruction.
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
- 2026-05-14: Replaced the server-side SDK thread and custom browser route with a coordinator launch preset. Focused verification passed with `bun run typecheck` and `bun test test/coordinator-runtime.test.ts test/coordinator-tools.test.ts test/coordinator-mcp.test.ts`.
- 2026-05-14: Ran the requested grill-you pass for the managed-session authority model. The resulting hardening consumes one `promptAgent` grant per target per latest coordinator stdin event.
- 2026-05-14: Final verification passed with `bun run typecheck`, `bun test test`, and `bun run spec`. Captured fresh PR media from `VIDEO_MODE=1 bun run spec --grep "launches the coordinator"` and trimmed it with `bun spec/plugins/video-mode.ts trim`.
