---
status: needs-grilling
size: large
---

# Meta-Agent As Agent

Status: Kickoff stub. The previous coordinator-summary and factory-floor PRs have been closed as superseded. This task will be fleshed out around a new product direction: the coordinator should be an actual agent whose usable surface is a small set of coordination tools, not a bespoke summary UI.

## Starting Ask

Build a coordinator/meta-agent that can be talked to like any other agent and can coordinate other agents through tool-like capabilities:

- `listAgents()`
- `promptAgent(agent, prompt)`
- `getBriefing(agent)`
- `subscribe(agent)`

The coordinator should answer questions like "what's going on?", "what is everybody working on?", and "where are the clashes?" by using those tools and the current agent/session state.

## Implementation Log

- 2026-05-14: Created the new task branch/worktree after closing the two open superseded PRs.
