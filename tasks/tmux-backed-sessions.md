---
status: in-progress
size: medium
---

# Tmux-Backed Sessions

Status: Spec commit for implementation. Build tmux as an optional backend first, not a replacement for Bun PTY, so the existing fast/default path remains stable while tmux-backed sessions can be tested.

- [ ] Document the current Bun PTY session lifecycle and what breaks when the TUI UI server exits.
- [ ] Decide whether tmux should replace Bun PTY or be an optional backend.
- [ ] Define session naming, cwd, environment, resize, input, output capture, and cleanup behavior for tmux sessions.
- [ ] Preserve browser terminal streaming and existing SDK summary behavior.
- [ ] Add integration coverage for launching, sending input, resizing, and reconnecting to an existing tmux-backed session.

## Implementation Notes

- Add an explicit backend option rather than switching every session to tmux.
- A first useful target is `TUIUI_SESSION_BACKEND=tmux` or a launch flag/body field, with Bun PTY remaining the default.
- Tmux sessions should use deterministic names derived from the TUI UI session id.
- Capture output via `tmux capture-pane` polling or a pipe-pane strategy; prefer the simplest reliable approach first.
- The browser should still see the same `SessionPayload` shape.
- Reconnect should mean: if a tmux session with the stored name exists after the server restarts, TUI UI can reconstruct enough state to view/send input.
