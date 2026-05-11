---
status: in-progress
size: medium
---

# Keyboard Shortcut Chords

Status: Spec commit for implementation. This branch should inspect `../xyz`, borrow the command/chord concepts that fit TUI UI, and add binary-aware chord rendering without changing the basic stdin path.

- [ ] Clarify terminology for shortcuts, chords, rendered keys, and binary-specific behavior.
- [ ] Compare the desired feature set with `../xyz` and note which pieces should be copied or adapted.
- [ ] Add a way to create new chords, with chords allowed to be spelled out directly.
- [ ] Add an LRU-style selection system based on the binary being run, such as `codex`, `opencode`, or `claude`.
- [ ] Render the most relevant chords per binary, for example `Esc` for Codex, `Esc;Esc` for OpenCode, or `Ctrl-J` for newline where appropriate.

## Implementation Notes

- Treat **Chord** as a named sequence of one or more terminal key/text writes.
- Treat **Shortcut** as the visible UI/control that triggers a chord.
- Keep the current simple key buttons working while adding richer binary-specific presets.
- User-defined chords can start as daemon-local/browser-local state if persistent storage is too much for this pass.
- Prefer a small shared chord registry over scattering hardcoded buttons through `client/app.ts`.
