---
status: in-progress
size: small
base: nightly/2026-05-13
branch: bedtime/home-input-archive-session
---

# Home Mobile Inputs and Session Archive

Status summary: Spec is fleshed out and implementation is next. The task is expected to touch Home mobile input sizing, the session menu, and persisted session metadata. Main missing pieces are the archive endpoint/data model, menu action, and regression coverage.

- [ ] Prevent Home screen input focus zoom on mobile. _Make the launch command and cwd fields use a mobile-safe 16px font size, matching the session promptbox behavior._
- [ ] Add archive state to the local session data model. _Persist an archived marker for TUI UI sessions so "done with this session" is explicit and survives reloads._
- [ ] Add an archive API action for a session. _Expose a non-destructive endpoint that records archive state and removes/filters the session from active Home lists._
- [ ] Add an Archive button to the session hamburger menu. _Put the action alongside the existing session controls and navigate Home after a successful archive._
- [ ] Add focused regression coverage. _Cover mobile Home input font sizing and the archive action hiding an archived session from Home._

## Assumptions

- This task targets `tuiui`, not the scratch TypeScript repo where the prompt was issued; `tuiui` has the active `nightly/2026-05-13` base and matching Home/session UI.
- Archive is intentionally non-destructive. It means "hide this from my active TUI UI sessions" rather than "delete transcript", "kill provider history", or "remove provider SDK data".
- If the archived session is still backed by a live runtime process, archiving should close TUI UI's handle for that session so it disappears from active UI lists. Provider-level cleanup can remain separate.

## Implementation Notes

- Session-page textarea already avoids iOS zoom through the mobile media query. Home inputs currently inherit smaller fonts from `.command-prompt-field input` and `.cwd-field input`, so they need the same mobile treatment.
- Session metadata lives in `db/definitions.sql`, `db/sql/queries.sql`, and `src/session-store.ts`; regenerate SQL query bindings after schema/query changes.
- The current Home list is sourced from live `state.sessions`, so the archive path should both persist the archived marker and filter/drop live runtime entries.
