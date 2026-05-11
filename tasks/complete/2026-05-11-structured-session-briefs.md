---
status: done
size: medium
---

# Structured Session Briefs

Status: Complete. Session briefs now use a shared XML-style `tuiui.sessionBrief.v1` contract across Codex, Claude, and OpenCode; the Summary tab renders parsed sections and diagnostics keep the raw structured response. Fork-point reuse is unchanged and covered by the existing e2e path.

- [x] Define a provider-independent Session brief schema. _Implemented as `StructuredSessionBrief` in `src/session-brief.ts` with executive summary, initial request, current state, completed work, files changed, risks/blockers, and next actions._
- [x] Decide whether the wire format should be XML-style tags, YAML, JSON, or markdown with strict headings. _Chose XML-style tags via `tuiui.sessionBrief.v1`; tags are promptable, inspectable, and parsed without another dependency._
- [x] Make Codex and Claude prompts emit the chosen schema. _`createCodexSummaryPrompt` and `createClaudeSummaryPrompt` now delegate to the shared structured prompt and sidecar builders parse the response._
- [x] Replace OpenCode built-in `session.summarize` with the same schema-driven sidecar approach, or wrap its result into the schema if that proves good enough. _OpenCode now forks and calls `session.prompt` with the shared prompt instead of `session.summarize`._
- [x] Render the structured brief in the Summary tab. _`client/app.ts` renders parsed structured sections first; malformed or legacy responses fall back to raw text, and diagnostics include `sessionBrief` plus the raw response._
- [x] Add tests that assert the schema is produced and reused by fork point. _Added parser/provider prompt tests and updated the Playwright OpenCode sidecar flow to verify parsed section rendering plus existing fork-point reuse._

## Notes

- Session briefs are supervisory artifacts for someone supervising the TUI, including future meta-agents.
- The useful product contract is probably not "whatever markdown the provider returns"; it is a stable TUI UI brief format that every provider adapter fills.
- Codex and Claude already build custom summary prompts from transcript snapshots.
- OpenCode previously called `session.fork` plus provider `session.summarize`, which was convenient but less controllable.

## Implementation Notes

- Use XML-style tags for the generated provider output in the first pass because they are easy to prompt, inspect, and parse without adding a new dependency.
- Render parsed sections as the primary Summary tab content, with the raw structured brief kept in diagnostics.
- Keep the fork-point reuse behavior unchanged.
- If OpenCode's built-in summary cannot be shaped, route OpenCode through the same sidecar prompt style as Codex/Claude.

## Implementation Log

- Added `src/session-brief.ts` for the shared XML prompt contract and parser.
- Added `sessionBrief` to provider summaries so UI and diagnostics can consume a provider-independent structure.
- Swapped OpenCode sidecar brief generation from built-in compaction to fork-plus-prompt.
- Verified with `bun run typecheck`, `bun test test`, and `bun run spec`.
