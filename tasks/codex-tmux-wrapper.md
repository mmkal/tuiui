---
status: in-progress
size: small
branch: codex-tmux-wrapper
---

# Codex tmux wrapper

Status summary: Spec is ready and implementation is starting. The goal is a small shell file that can be sourced to shadow `codex` and route interactive Codex starts/resumes through stable tmux sessions. Missing pieces are the wrapper implementation, lightweight validation, and PR notes.

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

- [ ] Research whether an official or common Codex-specific solution already exists.
- [ ] Add a sourceable `.sh` file with a `codex` wrapper function and helper functions.
- [ ] Preserve ordinary Codex command behavior for non-interactive subcommands.
- [ ] Name tmux sessions deterministically for interactive starts and explicit resume targets.
- [ ] Add usage notes and escape hatches in comments.
- [ ] Validate the shell file at least with Bash parsing.

## Implementation Notes

- Initial research found official Codex app-server support for shared live thread state, plus community tmux/session managers such as `codex-cli-farm` and `codex-tabs`. Those are adjacent, but not the exact lightweight shell-shadowing wrapper requested here.
