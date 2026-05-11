---
status: done
size: medium
---

# Keyboard Shortcut Chords

Status: Done. The session composer now keeps the existing key buttons and stdin behavior, adds binary-aware chord presets, and supports browser-local user chords. The main missing piece is durable cross-browser/daemon persistence, which was intentionally left out for this first pass.

- [x] Clarify terminology for shortcuts, chords, rendered keys, and binary-specific behavior. _Implemented in `src/chords.ts`: chord strings parse into terminal write steps, shortcuts are the rendered buttons, and binary detection chooses preset ordering._
- [x] Compare the desired feature set with `../xyz` and note which pieces should be copied or adapted. _Borrowed xyz's semicolon-separated chord spelling, modifier parsing, helper buttons, and command-scoped recency idea; adapted persistence to browser-local state instead of xyz's SQLite hotkeys._
- [x] Add a way to create new chords, with chords allowed to be spelled out directly. _Added the composer Chord panel with label/sequence fields and helpers such as `ctrl+`, `esc`, and `;enter`; saved chords live in `localStorage`._
- [x] Add an LRU-style selection system based on the binary being run, such as `codex`, `opencode`, or `claude`. _User-defined chords are scoped by detected binary and sorted by `lastUsedAt`; presets are selected by `detectChordBinary`._
- [x] Render the most relevant chords per binary, for example `Esc` for Codex, `Esc;Esc` for OpenCode, or `Ctrl-J` for newline where appropriate. _Codex shows `Esc`/`Ctrl-J`, OpenCode leads with `Esc Esc`/`Ctrl-J`, Claude includes `Esc`/`Shift-Tab`/`Ctrl-J`, followed by common key presets._

## Implementation Notes

- Treat **Chord** as a named sequence of one or more terminal key/text writes.
- Treat **Shortcut** as the visible UI/control that triggers a chord.
- Keep the current simple key buttons working while adding richer binary-specific presets.
- User-defined chords can start as daemon-local/browser-local state if persistent storage is too much for this pass.
- Prefer a small shared chord registry over scattering hardcoded buttons through `client/app.ts`.

## Implementation Log

- Added `src/chords.ts` for binary detection, shared key resolution, chord parsing, and preset selection.
- Reused the existing `/send` and `/key` paths: normal composer submits still use the old stdin behavior, while chord buttons send parsed write steps with `submit: false`.
- Added `test/chords.test.ts` plus Playwright coverage for user-created chords and binary-aware preset ordering.
- Verified with `bun test test`, `bun run spec`, and `bun run typecheck`.
