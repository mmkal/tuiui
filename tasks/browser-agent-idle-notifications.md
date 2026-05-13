---
status: ready-for-review
size: medium
---

# Browser Agent Idle Notifications

Status: First client-only slice is implemented and tested. The visible opt-in control, transition tracking, duplicate suppression, native click routing for live session routes, and in-app fallback are done; only manual backgrounded Chrome notification verification remains.

## Goal

Send native browser notifications when an agent session finishes work and becomes idle, so the user can leave TUI UI open in the background and still know when an agent needs attention.

## Notes

The notification should be about agent state transitions, not every polling refresh. A session that starts busy and later returns to idle should notify once. A session already idle on first page load should not notify.

Use the browser Notification API for the first slice. Keep the implementation local to the web client unless the server needs to expose richer state. If browser notifications are blocked or unsupported, degrade to the existing in-app toast system and make the disabled state visible without noisy prompts.

The feature should work for Codex first, but the state model should be provider-neutral because TUI UI already tracks Codex, Claude, and OpenCode sessions with the same `busy`/`idle`/`exited` surface.

## Bedtime Scope

Implement this as a browser-client feature over the current session payloads. The current tab can observe sessions it has loaded or that the home overview polls; it does not need a server push channel or service worker. Store the user's opt-in locally in the browser, and never trigger the Notification permission prompt during initial page load.

When the Notification API is unavailable or denied, show one normal in-app toast for the same busy-to-idle transition. Clicking a native notification should focus or open the relevant `/sessions/:id` route when the browser allows it.

## Checklist

- [x] Identify and reuse the current client-side polling/status update paths for session detail and home/recent-session views. _Wired observation through `renderSessionPayload`, added a small busy-session idle refresh, and polls home session/recent-agent payloads in `client/app.ts`._
- [x] Add transition tracking so notifications fire only on `busy` to `idle`, never for initially idle sessions. _Implemented previous-status tracking in `client/idle-notifications.ts`._
- [x] Add an explicit browser-notification permission request flow from a visible control. _Added the `Idle alerts` toggle to home and session topbars; it only calls `Notification.requestPermission()` from click handling._
- [x] Include enough context in the notification to identify the provider/title and working directory or task. _Notification titles include provider/title, and bodies include cwd plus task/command context._
- [x] Suppress duplicate notifications across rapid polling refreshes and page reload initialization. _The helper updates status before delivery and only emits on an observed `busy` -> `idle` edge._
- [x] Fall back to an in-app toast when browser notifications are denied or unavailable. _The helper sends the same transition through `showToast` when native notifications are not granted._
- [x] Wire notification clicks to the relevant session route when possible. _Native click handlers focus/open `/sessions/:id` for live TUI sessions._
- [x] Add focused tests for transition detection, duplicate suppression, fallback behavior, and no notification on initially idle sessions. _Added `test/browser-idle-notifications.test.ts` plus a Playwright control smoke in `spec/tuiui.spec.ts`._
- [ ] Manually verify the browser notification behavior in Chrome with the TUI UI tab backgrounded if the local environment permits it.

## Open Questions

- Should this notify for every agent, or only sessions the user has marked as watched?
- Should notifications fire when an agent is waiting for user input if that is represented separately from idle later?
- Should clicking a notification focus the relevant session, and if so should this use the current URL hash/router state?
- Should the setting persist per browser, per project, or per TUI UI server instance?

## Implementation Log

- 2026-05-13: Captured task after confirming there was no active task, branch, PR, or code path for native browser notifications on idle transitions.
- 2026-05-13: Bedtime scope narrowed to an opt-in browser-client implementation over existing session payloads; service-worker/background delivery is intentionally deferred.
- 2026-05-13: Implemented the client-only notification helper, visible opt-in control, session/home observation hooks, native click routing for live sessions, and toast fallback. Verified with focused Bun tests, one Playwright permission-control smoke, one existing session-detail smoke, and typecheck.
