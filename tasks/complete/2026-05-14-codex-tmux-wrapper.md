---
status: done
size: small
branch: codex-tmux-wrapper
---

# Codex tmux wrapper

Status summary: Implementation is complete and validated locally. `scripts/codex-tmux.sh` now uses a session-id mapping instead of trying to parse the Codex CLI grammar: new interactive launches start in fresh tmux sessions, a background watcher records `Codex session id -> tmux session`, and `codex resume <id>` attaches through that mapping when possible.

## Goal

Create a Bash-compatible shell file in this repo that defines a `codex` function. The function should behave like ordinary `codex` for non-interactive subcommands, but should use tmux for interactive Codex sessions so a later invocation can attach to the same live terminal process instead of starting a second `codex resume` process.

## Assumptions

- The user will source the file from their shell rc after ensuring it can find the real Codex binary.
- The function should not make `codex exec`, `codex login`, `codex app-server`, or other non-interactive subcommands run in tmux.
- Plain `codex`, `codex --yolo`, `codex -m gpt-5.4`, `codex "prompt"`, and similar interactive starts should launch or attach through tmux.
- `codex resume ...` should attach to a previously recorded tmux session for that Codex session id when it exists; otherwise it should create one running the real `codex resume ...`.
- `codex resume` with no target should still run inside tmux, but because the picker decides the actual session later, it can only use a generic tmux name.
- If the session was originally started outside tmux and no matching tmux session exists, the wrapper cannot attach to that original terminal process; it can only create a tmux-backed resume from that point forward.

## Checklist

- [x] Research whether an official or common Codex-specific solution already exists. _Official Codex app-server supports shared live thread state; community projects such as `codex-cli-farm` and `codex-tabs` are adjacent, but no official lightweight shell-shadowing wrapper was found._
- [x] Add a sourceable `.sh` file with a `codex` wrapper function and helper functions. _Added `scripts/codex-tmux.sh` with a sourceable `codex()` function and internal helper functions._
- [x] Preserve ordinary Codex command behavior for non-interactive subcommands. _Known non-interactive subcommands including `exec`, `login`, `logout`, `app-server`, `review`, `apply`, and others dispatch directly to the real Codex binary._
- [x] Name tmux sessions and map them back to Codex session ids. _Interactive starts use fresh tmux session names, then a background watcher reads `session id: ...` from `tmux capture-pane` and appends the mapping to a TSV state file._
- [x] Add usage notes and escape hatches in comments. _The shell file documents `CODEX_TMUX=0`, `CODEX_TMUX_CODEX_BIN`, `CODEX_TMUX_PREFIX`, and `CODEX_TMUX_MAP_FILE`._
- [x] Validate the shell file at least with Bash parsing. _Validated with `bash -n`, `zsh -n`, and fake `codex`/`tmux` routing tests in both Bash and zsh._

## Implementation Notes

- Initial research found official Codex app-server support for shared live thread state, plus community tmux/session managers such as `codex-cli-farm` and `codex-tabs`. Those are adjacent, but not the exact lightweight shell-shadowing wrapper requested here.
- `scripts/codex-tmux.sh` intentionally cannot attach to a plain non-tmux terminal process that already exists. It only guarantees tmux-backed ownership after the wrapper is in use.
- Revised after review feedback to avoid positional/flag grammar parsing. The wrapper now only detects exact `resume` tokens, known non-interactive top-level commands, and help/version tokens.
- The mapping file defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/codex-tmux/sessions.tsv`, with `CODEX_TMUX_MAP_FILE` available for overrides.
- Local validation:
  - `bash -n scripts/codex-tmux.sh`
  - `zsh -n scripts/codex-tmux.sh`
  - Fake-command smoke tests showed `codex exec hello` and `codex --help` bypass tmux, `codex resume abc-123` attaches from a stored mapping, and `codex --yolo` creates a tmux session and records the discovered Codex session id.
  - zsh smoke test showed `CODEX_TMUX=0 codex resume abc` bypasses the wrapper and a new interactive launch records a mapping from captured pane output.
