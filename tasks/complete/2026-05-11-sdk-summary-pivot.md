---
status: complete
size: medium
---

# SDK-Based TUI Summary Pivot

Status: Done and moved to complete on 2026-05-11. Provider parity is in place for OpenCode, Codex, and Claude. The Summary tab presents a human/agent-facing session brief first, keeps provider snapshot YAML collapsed as diagnostics, reuses completed briefs when the fork point has not changed, and now includes an inline tuishot of the current terminal view.

- [x] Stop treating ASCII/box parsing as the main path for summarization. _The browser now defaults to TTY and exposes Summary instead of Blocks; block parsing remains in code only as a lower-level diagnostic._
- [x] Launch OpenCode TUIs with a deterministic local server port so TUI UI can connect to the same server the TUI is using. _`prepareSessionSdk` appends/normalizes `opencode --hostname 127.0.0.1 --port <free-port>` in `cli.ts`._
- [x] Add an SDK/provider summary model to the session payload. _`SessionSdkPayload` carries provider, base URL, provider session ID, status, errors, transcript, and diff counts._
- [x] Implement OpenCode as the first provider using its server SDK/API. _`refreshSessionSdk` reads provider data and `summarizeSessionWithSdk` calls OpenCode `session.fork` followed by `session.summarize` via `@opencode-ai/sdk/client`; prompt input stays on the PTY path for now._
- [x] Add a browser view/action for summary data. _The session toolbar now has a Summary tab with Refresh snapshot and Get session brief actions, with read-only YAML kept in collapsed diagnostics._
- [x] Cover the behavior with an integration spec. _`spec/tuiui.spec.ts` drives fake OpenCode, verifies the provider snapshot includes the prompt and response, then clicks Get session brief._
- [x] Add Codex adapter. _`src/codex-sdk.ts` resolves Codex threads from `~/.codex/state_5.sqlite`, parses rollout JSONL into transcript summaries, and `summarizeCodexSessionWithSdk` creates a separate Codex SDK thread for the summary._
- [x] Add Claude adapter. _`src/claude-sdk.ts` uses the Claude Agent SDK to list/read sessions and generate sidecar summaries through forked queries._
- [x] Design non-mutating AI summaries. _The current OpenCode path forks the source provider session, summarizes the fork, tracks it under top-level YAML `forks`, and leaves the live TUI session unchanged._
- [x] Present session briefs as the primary Summary tab output. _`client/app.ts` renders the selected brief as monospace markdown and keeps CodeMirror YAML inside a collapsed Diagnostics disclosure._
- [x] Reuse completed session briefs by fork point. _`summarizeSessionWithSdk` refreshes the provider snapshot first, then reuses a completed fork whose provider, source provider session ID, and fork point match._

## Implementation Notes

- OpenCode docs say the TUI starts a server, and `--hostname`/`--port` can make that server address deterministic. Its SDK exposes session, message, status, diff, summarize, and TUI-control APIs.
- Codex has a TypeScript SDK that resumes persisted threads by ID, but tying a running TUI to the thread ID looks like a separate adapter after this OpenCode slice.
- Claude has session resume/structured-output SDK APIs, but the current CLI surface makes OpenCode the easiest proof first.
- 2026-05-08: First pass keeps parser files/tests around because they are still useful diagnostics, but removes Blocks from the main browser toolbar. TTY is now the default route.
- 2026-05-08: Session IDs are now `tuiui_` plus a hyphenless UUID so provider/test scratch space is easier to identify. The Summary tab exposes `sidecarSummary` as YAML.
- 2026-05-08: Sidecar summaries now fork before compacting. `providerData` stays pinned to the original OpenCode session while top-level YAML `forks` records the fork session ID, status, result, and fork-side summary.
- 2026-05-08: Codex support uses the local Codex state database plus rollout JSONL for read-only refreshes. The sidecar summary action starts a separate Codex SDK thread with the source transcript in the prompt, rather than mutating the live TUI thread.
- 2026-05-11: Claude parity added. The Summary tab language is being pivoted from "SDK summary YAML" to "Session brief" plus collapsed diagnostics.
- 2026-05-11: Session briefs are now keyed by provider/source/fork point and the main Summary tab only shows the latest applicable brief; stale and diagnostic records remain in YAML.
