---
status: in-progress
size: medium
---

# Structured Session Briefs

Status: Spec commit for implementation. The branch will turn Session brief output into a provider-independent structured contract while keeping the Summary tab readable and diagnostics available.

- [ ] Define a provider-independent Session brief schema. _Likely sections: executive summary, initial user request, current state, completed work, files changed, risks/blockers, suggested next actions._
- [ ] Decide whether the wire format should be XML-style tags, YAML, JSON, or markdown with strict headings. _The format should be easy for both humans and future meta-agents to parse._
- [ ] Make Codex and Claude prompts emit the chosen schema. _These are already custom sidecar prompts, so this should be mostly prompt/schema work._
- [ ] Replace OpenCode built-in `session.summarize` with the same schema-driven sidecar approach, or wrap its result into the schema if that proves good enough. _OpenCode is the odd one out because it currently uses the provider's built-in summarizer on a fork._
- [ ] Render the structured brief in the Summary tab. _Keep diagnostics collapsed; make the primary view readable while preserving machine-readable structure somewhere obvious._
- [ ] Add tests that assert the schema is produced and reused by fork point. _Avoid brittle prose assertions; check section presence and provider-independent fields._

## Notes

- Session briefs are supervisory artifacts for someone supervising the TUI, including future meta-agents.
- The useful product contract is probably not "whatever markdown the provider returns"; it is a stable TUI UI brief format that every provider adapter fills.
- Codex and Claude already build custom summary prompts from transcript snapshots.
- OpenCode currently calls `session.fork` plus provider `session.summarize`, which is convenient but less controllable.

## Implementation Notes

- Use XML-style tags for the generated provider output in the first pass because they are easy to prompt, inspect, and parse without adding a new dependency.
- Render parsed sections as the primary Summary tab content, with the raw structured brief kept in diagnostics.
- Keep the fork-point reuse behavior unchanged.
- If OpenCode's built-in summary cannot be shaped, route OpenCode through the same sidecar prompt style as Codex/Claude.
