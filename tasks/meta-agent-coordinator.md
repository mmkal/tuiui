---
status: ready-for-implementation
size: large
---

# Meta-Agent Coordinator

Status: Ready for a first coordinator slice. The bedtime implementation should create a deterministic "meta-agent" surface: a consolidated state-of-the-agents summary, a compact supervisor panel, and a confirmation-gated prompt forwarding flow. It should not make the coordinator autonomous or introduce a new LLM/provider yet.

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

- [ ] Define the provider-neutral state-of-the-agents summary schema for active and recent agents.
- [ ] Identify the current sources of truth for sessions, titles, providers, status, cwd, branches, task files, PRs, recovery commands, and session briefs.
- [ ] Add a backend endpoint that returns a consolidated state-of-the-agents summary.
- [ ] Render a supervisor/coordinator client surface that can answer "what is going on?" from that summary without a new LLM call.
- [ ] Add a typed prompt-routing flow where the user chooses or resolves a target session.
- [ ] Require explicit user confirmation before the coordinator sends a prompt into another agent session.
- [ ] Add an audit trail in the UI showing what the coordinator observed and forwarded during the page session.
- [ ] Add tests around summary freshness, target-session resolution, and prompt-forwarding confirmation.
- [ ] Document the coordinator's authority boundaries so future agents do not make it too autonomous by accident.

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
