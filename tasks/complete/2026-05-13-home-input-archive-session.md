---
status: complete
size: small
base: nightly/2026-05-13
branch: bedtime/home-input-archive-session
---

# Home Mobile Inputs and Session Archive

Status summary: Complete. Home launch inputs now use mobile-safe font sizing, sessions can be archived from the hamburger menu, and archived sessions are persisted and hidden from the active Home list. Local typecheck, unit tests, and Playwright specs pass.

- [x] Prevent Home screen input focus zoom on mobile. _`client/styles.css` gives Home command and cwd inputs 16px font size under the mobile media query._
- [x] Add archive state to the local session data model. _`db/definitions.sql`, generated SQL bindings, and `src/session-store.ts` now persist `archived_at_ms`._
- [x] Add an archive API action for a session. _`POST /api/sessions/:id/archive` records the archive timestamp, removes live sessions from `state.sessions`, and blocks archived-session reconnects._
- [x] Add an Archive button to the session hamburger menu. _`client/app.ts` adds the menu action and navigates back Home after successful archive._
- [x] Add focused regression coverage. _`spec/tuiui.spec.ts` covers mobile Home input sizing and archiving from the menu; `test/session-store.test.ts` covers persisted archive metadata._

## Assumptions

- This task targets `tuiui`, not the scratch TypeScript repo where the prompt was issued; `tuiui` has the active `nightly/2026-05-13` base and matching Home/session UI.
- Archive is intentionally non-destructive. It means "hide this from my active TUI UI sessions" rather than "delete transcript", "kill provider history", or "remove provider SDK data".
- If the archived session is still backed by a live runtime process, archiving should close TUI UI's handle for that session so it disappears from active UI lists. Provider-level cleanup can remain separate.

## Implementation Notes

- Session-page textarea already avoids iOS zoom through the mobile media query. Home inputs currently inherit smaller fonts from `.command-prompt-field input` and `.cwd-field input`, so they need the same mobile treatment.
- Session metadata lives in `db/definitions.sql`, `db/sql/queries.sql`, and `src/session-store.ts`; regenerate SQL query bindings after schema/query changes.
- The current Home list is sourced from live `state.sessions`, so the archive path should both persist the archived marker and filter/drop live runtime entries.
- 2026-05-13: Added a small pre-existing spec stabilization in the voice Playwright test: it now checks stdin through the session payload instead of Debug-only log DOM.
- Verification: `bun run typecheck`, `bun test test`, and `bun run spec`.
