---
status: done
size: small
branch: codex-tmux-wrapper
---

# Codex tmux wrapper

Status summary: Implementation is complete and validated locally. `scripts/codex-tmux.sh` is now a tiny shim into `scripts/codex-tmux.ts`; the TypeScript wrapper starts Codex in tmux, records the Codex session id on the tmux session via `@codex-session-id`, and later attaches `codex resume <id>` to the matching live tmux session.

## Goal

Create a sourceable wrapper that defines a `codex` function. The function should make normal Codex invocations tmux-backed so a later `codex resume <id>` can attach to the same live terminal process instead of starting a second Codex process for that session.

## Assumptions

- The user will source the file from their shell rc after ensuring it can find the real Codex binary.
- The function can run all Codex commands inside tmux by default; `CODEX_TMUX=0` is the explicit bypass.
- Plain `codex`, `codex --yolo`, `codex -m gpt-5.4`, `codex "prompt"`, `codex --help`, and similar invocations should launch through tmux.
- `codex resume ...` should attach to a tmux session whose `@codex-session-id` matches the Codex session id when it exists; otherwise it should create one running the real `codex resume ...`.
- If the session was originally started outside tmux and no matching tmux session exists, the wrapper cannot attach to that original terminal process; it can only create a tmux-backed resume from that point forward.

## Checklist

- [x] Research whether an official or common Codex-specific solution already exists. _Official Codex app-server supports shared live thread state; community projects such as `codex-cli-farm` and `codex-tabs` are adjacent, but no official lightweight shell-shadowing wrapper was found._
- [x] Add a sourceable `.sh` file with a `codex` wrapper function. _Added `scripts/codex-tmux.sh` as a small shim that invokes `node scripts/codex-tmux.ts`._
- [x] Keep the implementation small and avoid Codex CLI grammar parsing. _The TypeScript wrapper only looks for an exact `resume` token with a following id; otherwise it starts a tmux-backed Codex process._
- [x] Name tmux sessions and map them back to Codex session ids. _New sessions use fresh tmux names, then a background watcher reads `session id: ...` from `tmux capture-pane` and stores it on the tmux session as `@codex-session-id`._
- [x] Add usage notes and escape hatches in comments. _The shell file documents `CODEX_TMUX=0`; the TypeScript wrapper also honors `CODEX_TMUX_CODEX_BIN` and `CODEX_TMUX_PREFIX`._
- [x] Validate the shell shim and TypeScript implementation. _Validated with `bash -n`, `zsh -n`, `node --check`, and fake `codex`/`tmux` routing tests._

## Implementation Notes

- Initial research found official Codex app-server support for shared live thread state, plus community tmux/session managers such as `codex-cli-farm` and `codex-tabs`. Those are adjacent, but not the exact lightweight shell-shadowing wrapper requested here.
- `scripts/codex-tmux.ts` intentionally cannot attach to a plain non-tmux terminal process that already exists. It only guarantees tmux-backed ownership after the wrapper is in use.
- Revised after review feedback to avoid duplicating tuiui's persistence concerns. The wrapper now uses tmux user options as the live registry, especially `@codex-session-id`.
- The TypeScript wrapper starts a detached session plus `switch-client` when already inside tmux, and uses foreground `tmux new-session` outside tmux so short-lived commands like `codex --help` still have a chance to display output.
- Local validation:
  - `bash -n scripts/codex-tmux.sh`
  - `zsh -n scripts/codex-tmux.sh`
  - `node --check scripts/codex-tmux.ts`
  - Fake-command smoke tests showed `codex resume abc-123` attaches by scanning tmux `@codex-session-id`, `codex --yolo` creates a tmux session and records the discovered Codex session id on that session, foreground creation is used outside tmux, and zsh sourcing plus `CODEX_TMUX=0` bypass work.
  - `bun run typecheck` was attempted but this worktree has no `node_modules`, so TypeScript stopped on missing `bun-types`.
