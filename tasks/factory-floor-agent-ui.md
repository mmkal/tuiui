---
status: first-slice-implemented
size: large
---

# Factory Floor Agent UI

Status: First shippable slice implemented. `/factory` is a read-only coordinator-summary overview linked from the home topbar, with supervisor counters and active/recent station grids. Still missing the richer controls from the original scope: forwarding, recovery/stop affordances, inspection lane, PR media, and complete visual state coverage.

## Goal

Design and build a factory-floor-style multi-agent UI where active and recent agents are represented as workstations, production lines, bays, or machines, making it easy to see at a glance who is working, idle, blocked, waiting for the user, or done.

## Reference

Isomux is the main inspiration: https://isomux.com/

Relevant ideas from the reference are the visual office metaphor, animated characters for sleeping/typing/waiting states, mobile-friendly access, embedded terminal per agent, voice input, task board, inter-agent discovery, and completion notifications.

TUI UI should not copy the office metaphor directly. The requested direction is a factory floor: agent stations, task queues, work-in-progress lanes, supervisor controls, status lights, handoff belts, inspection/review areas, and visible bottlenecks.

## Notes

The UI should be useful before it is cute. It needs to preserve fast access to real terminals, session briefs, provider details, task files, branches, and PRs. The factory metaphor should improve scanning and coordination, not hide important operational details behind decoration.

Possible visual states:

- Agent working: station active, status light running, visible recent output/activity pulse.
- Agent idle: station quiet, completed item ready for inspection.
- Agent waiting for user: call light or blocked lane.
- Agent errored/exited: stopped machine with clear recovery action.
- Agent reviewing another agent: inspection station or quality-control lane.

The first version can be a new route or mode alongside the current list/detail UI. It should avoid a large rewrite until the state model and visual grammar prove useful.

## Bedtime Scope

Base this branch on the meta-agent coordinator branch and consume its state-of-the-agents summary endpoint. Build a new `/factory` overview route linked from the top-level UI. The route should render active and recent sessions as factory stations with status lights, lanes, and compact controls that open the real session detail. Avoid decorative art that hides operational state; density and scanability matter more than cuteness.

The first version does not need animation beyond restrained CSS states. It should include the meta-agent/coordinator as a supervisor booth when the coordinator summary is available, and it should gracefully degrade to current session/recent-session data if optional metadata is missing.

## Checklist

- [x] Audit the current session list/detail UI and the meta-agent summary endpoint for data needed by the factory overview. _Used the existing `CoordinatorSummary` model and home coordinator panel in `client/app.ts` as the data contract._
- [x] Define the factory-floor information architecture: supervisor booth, active stations, recent stations, inspection/review lane, and detail affordances. _First slice includes supervisor booth plus active/recent lanes; inspection/review remains a later lane._
- [ ] Define visual state mapping for busy, idle, waiting-for-user, exited, errored, reviewing, stale, and recoverable sessions.
- [x] Build a first responsive `/factory` overview route that shows active and recent sessions as stations. _Added `renderFactory` in `client/app.ts`, `/factory` homepage routing in `cli.ts`, and responsive factory CSS._
- [x] Preserve one-click access to the terminal/session detail for each station. _Live stations render `Open` links to `/sessions/:id`; recent stations remain read-only in this slice._
- [ ] Add compact controls for opening, recovering/resuming when available, stopping live sessions when appropriate, and sending a prompt through the coordinator flow when available.
- [x] Integrate task/branch/PR/status summary data when available, without blocking the first UI on perfect metadata. _Stations show current task, provider, branch, cwd, status, freshness, and confidence with empty fallback text._
- [x] Add mobile layout behavior that keeps the overview scannable and makes station controls touch-friendly. _Factory lanes collapse to one column under tablet/mobile breakpoints and the spec checks no horizontal document scroll._
- [x] Add Playwright coverage for the overview states. _Added a mocked coordinator-summary Playwright spec covering busy, idle, recent stations, live `Open` links, and mobile no-horizontal-scroll behavior._
- [ ] Add at least one screenshot artifact for PR review.

## Open Questions

- Should the factory floor be the default home screen or an alternate overview mode?
- Should the art direction be flat and utilitarian, or skeuomorphic with animated machines and characters?
- What is the right density for mobile: mini-map overview, list of stations, or swipeable station cards?
- Should the UI expose the meta-agent/coordinator as a supervisor booth or a normal station?
- How much of Isomux's task board idea should be adapted versus relying on this repo's `tasks/` folder?

## Implementation Log

- 2026-05-13: Captured task after reviewing Isomux's published feature list and reframing the desired UI as a factory-floor operations view for TUI UI.
- 2026-05-13: Bedtime scope set as a stacked branch on the meta-agent coordinator summary endpoint, adding a `/factory` route rather than replacing the existing home screen.
- 2026-05-13: Narrowed per user direction to a read-only first slice: `/factory` route, home topbar link, supervisor counters, active/recent station grid, live `Open` links, and one mocked Playwright spec.
