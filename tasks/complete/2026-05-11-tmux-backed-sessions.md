---
status: done
size: medium
---

# Tmux-Backed Sessions

Status: Implemented. Bun PTY remains the default backend; tmux is available as an explicit opt-in through `TUIUI_SESSION_BACKEND=tmux`, `--backend tmux`, or POST `/api/sessions` body `backend: "tmux"`. Browser payloads, stdin, resize, tuishot, logs, and SDK summary surfaces still use the existing `SessionPayload` shape. Reconnect is intentionally small: if the TUI UI server dies without graceful shutdown, reopening `/sessions/:id` reconstructs a runtime session from the deterministic tmux session name and metadata, seeds the terminal from `capture-pane`, and resumes input/output streaming.

- [x] Document the current Bun PTY session lifecycle and what breaks when the TUI UI server exits. _Bun PTY remains process-local: `cli.ts` owns the PTY handle and graceful shutdown kills it, so server exit normally ends live sessions._
- [x] Decide whether tmux should replace Bun PTY or be an optional backend. _Implemented tmux as an optional backend; `resolveSessionBackend` keeps Bun PTY as the default._
- [x] Define session naming, cwd, environment, resize, input, output capture, and cleanup behavior for tmux sessions. _`src/tmux-backend.ts` derives tmux names from TUI UI session ids, launches in the requested cwd/env, sends keys through `tmux send-keys`, resizes with `resize-window`, streams live output with `pipe-pane`, and kills sessions explicitly._
- [x] Preserve browser terminal streaming and existing SDK summary behavior. _`cli.ts` routes Bun PTY and tmux through the same runtime session payload/update path, leaving `SessionPayload` and SDK refresh/summarize responses unchanged._
- [x] Add integration coverage for launching, sending input, resizing, and reconnecting to an existing tmux-backed session. _`test/tmux-backend.test.ts` launches a tmux-backed fixture, sends input, resizes, SIGKILLs/restarts the server, reconnects by id, and sends input again._

## Implementation Notes

- Bun PTY lifecycle before this change: `createSession` created a Bun PTY process, stored it in memory, pushed all PTY output through xterm/headless, and the server's graceful shutdown path killed every runtime session. That remains the default behavior.
- Tmux launch opt-ins:
  - Server default for all launches: `TUIUI_SESSION_BACKEND=tmux bun run cli.ts`
  - Direct CLI launch: `bun run cli.ts --backend tmux <command> ...`
  - API launch body: `{ "command": "...", "backend": "tmux" }`
- Tmux session names are deterministic from the TUI UI session id via `tmuxSessionNameForId`; metadata is stored on the tmux session in `@tuiui-metadata`.
- Live tmux output uses `tmux pipe-pane -O` into a FIFO so existing stdout event/browser streaming behavior remains incremental while the server is alive.
- Reconnect after a hard server stop rehydrates command/cwd/size/createdAt from tmux metadata and seeds xterm state from `tmux capture-pane`; it then reattaches `pipe-pane` for future output and `send-keys` for future input.
- Remaining honest gaps:
  - Tmux reconnect does not recover the exact historical `stdoutEvents`/`stdinEvents` arrays; it reconstructs the visible terminal from pane capture and resumes new events from that point.
  - Tmux cannot currently report the child process's exact exit code after reconnect; ended sessions are marked exited when the tmux session disappears.
  - Fakeagent-backed tmux sessions are not restart-resilient because the fakeagent service is process-local to the original TUI UI server.

## Implementation Log

- Added `src/tmux-backend.ts` with backend resolution, deterministic session naming, tmux launch, input, resize, kill, metadata, and reconnect helpers.
- Updated `cli.ts` to select Bun PTY or tmux from env/CLI/API body while preserving the existing runtime session payload path.
- Added `test/tmux-backend.test.ts` coverage for backend selection and tmux launch/send/resize/reconnect.
- Verified with `bun run typecheck`, `bun test test`, and `bun run spec`.
