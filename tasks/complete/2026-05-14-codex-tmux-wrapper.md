---
status: done
size: small
branch: codex-tmux-wrapper
---

# Codex tmux wrapper

Status summary: Implementation is complete and validated locally. `scripts/codex-tmux.sh` defines the sourceable wrapper, routes interactive starts/resumes/forks through deterministic tmux sessions, and preserves passthrough behavior for non-interactive Codex subcommands. Missing piece is only final PR body cleanup after review.

## Goal

Create a Bash-compatible shell file in this repo that defines a `codex` function. The function should behave like ordinary `codex` for non-interactive subcommands, but should use tmux for interactive Codex sessions so a later invocation can attach to the same live terminal process instead of starting a second `codex resume` process.

## Assumptions

- The user will source the file from their shell rc after ensuring it can find the real Codex binary.
- The function should not make `codex exec`, `codex login`, `codex app-server`, or other non-interactive subcommands run in tmux.
- Plain `codex`, `codex --yolo`, `codex -m gpt-5.4`, `codex "prompt"`, and similar interactive starts should launch or attach through tmux.
- `codex resume ...` should attach to a deterministic tmux session for that resume target when it exists; otherwise it should create one running the real `codex resume ...`.
- `codex resume` with no target should still run inside tmux, but because the picker decides the actual session later, it can only use a generic tmux name.
- If the session was originally started outside tmux and no matching tmux session exists, the wrapper cannot attach to that original terminal process; it can only create a tmux-backed resume from that point forward.

## Checklist

- [x] Research whether an official or common Codex-specific solution already exists. _Official Codex app-server supports shared live thread state; community projects such as `codex-cli-farm` and `codex-tabs` are adjacent, but no official lightweight shell-shadowing wrapper was found._
- [x] Add a sourceable `.sh` file with a `codex` wrapper function and helper functions. _Added `scripts/codex-tmux.sh` with a sourceable `codex()` function and internal helper functions._
- [x] Preserve ordinary Codex command behavior for non-interactive subcommands. _Known non-interactive subcommands including `exec`, `login`, `logout`, `app-server`, `review`, `apply`, and others dispatch directly to the real Codex binary._
- [x] Name tmux sessions deterministically for interactive starts and explicit resume targets. _Interactive starts are keyed by cwd; explicit resumes use the resume target, producing names like `codex-resume-123-3c6221fbc9e3`._
- [x] Add usage notes and escape hatches in comments. _The shell file documents `CODEX_TMUX=0`, `CODEX_TMUX_CODEX_BIN`, `CODEX_TMUX_SESSION_NAME`, and `CODEX_TMUX_PREFIX`._
- [x] Validate the shell file at least with Bash parsing. _Validated with `bash -n`, `zsh -n`, and fake `codex`/`tmux` routing tests in both Bash and zsh._

## Implementation Notes

- Initial research found official Codex app-server support for shared live thread state, plus community tmux/session managers such as `codex-cli-farm` and `codex-tabs`. Those are adjacent, but not the exact lightweight shell-shadowing wrapper requested here.
- `scripts/codex-tmux.sh` intentionally cannot attach to a plain non-tmux terminal process that already exists. It only guarantees tmux-backed ownership after the wrapper is in use.
- The wrapper treats `codex fork` as interactive and tmux-backed too, even though the intended workflow is resume/start. That keeps the "interactive Codex stays in tmux" rule consistent without encouraging fork as the main path.
- Local validation:
  - `bash -n scripts/codex-tmux.sh`
  - `zsh -n scripts/codex-tmux.sh`
  - Fake-command smoke test showed `codex exec hello` and `codex --help` bypass tmux, while `codex --yolo` and `codex resume 123` route through tmux.
  - zsh smoke test showed an existing resume session attaches and `CODEX_TMUX=0 codex resume 123` bypasses the wrapper.
