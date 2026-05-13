---
status: ready-for-implementation
size: medium
---

# Browser Agent Idle Notifications

Status: Ready for a bedtime implementation pass. The first slice should ship opt-in native browser notifications for live TUI UI sessions when they transition from busy to idle, with duplicate suppression and an in-app toast fallback. Out of scope for this pass: service workers, notifications after the browser tab is closed, and a global watchlist for agents outside this TUI UI server.

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

- [ ] Identify and reuse the current client-side polling/status update paths for session detail and home/recent-session views.
- [ ] Add transition tracking so notifications fire only on `busy` to `idle`, never for initially idle sessions.
- [ ] Add an explicit browser-notification permission request flow from a visible control.
- [ ] Include enough context in the notification to identify the provider/title and working directory or task.
- [ ] Suppress duplicate notifications across rapid polling refreshes and page reload initialization.
- [ ] Fall back to an in-app toast when browser notifications are denied or unavailable.
- [ ] Wire notification clicks to the relevant session route when possible.
- [ ] Add focused tests for transition detection, duplicate suppression, fallback behavior, and no notification on initially idle sessions.
- [ ] Manually verify the browser notification behavior in Chrome with the TUI UI tab backgrounded if the local environment permits it.

## Open Questions

- Should this notify for every agent, or only sessions the user has marked as watched?
- Should notifications fire when an agent is waiting for user input if that is represented separately from idle later?
- Should clicking a notification focus the relevant session, and if so should this use the current URL hash/router state?
- Should the setting persist per browser, per project, or per TUI UI server instance?

## Implementation Log

- 2026-05-13: Captured task after confirming there was no active task, branch, PR, or code path for native browser notifications on idle transitions.
- 2026-05-13: Bedtime scope narrowed to an opt-in browser-client implementation over existing session payloads; service-worker/background delivery is intentionally deferred.
