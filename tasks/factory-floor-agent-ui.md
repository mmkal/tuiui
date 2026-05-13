---
status: ready-for-implementation
size: large
---

# Factory Floor Agent UI

Status: Ready for a first stacked UI pass based on the meta-agent coordinator summary. The bedtime implementation should add an alternate factory-floor overview route that visualizes agents as stations and preserves direct access to real sessions. It should complement the current home/detail UI rather than replace it.

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

- [ ] Audit the current session list/detail UI and the meta-agent summary endpoint for data needed by the factory overview.
- [ ] Define the factory-floor information architecture: supervisor booth, active stations, recent stations, inspection/review lane, and detail affordances.
- [ ] Define visual state mapping for busy, idle, waiting-for-user, exited, errored, reviewing, stale, and recoverable sessions.
- [ ] Build a first responsive `/factory` overview route that shows active and recent sessions as stations.
- [ ] Preserve one-click access to the terminal/session detail for each station.
- [ ] Add compact controls for opening, recovering/resuming when available, stopping live sessions when appropriate, and sending a prompt through the coordinator flow when available.
- [ ] Integrate task/branch/PR/status summary data when available, without blocking the first UI on perfect metadata.
- [ ] Add mobile layout behavior that keeps the overview scannable and makes station controls touch-friendly.
- [ ] Add Playwright coverage for the overview states and at least one screenshot artifact for PR review.

## Open Questions

- Should the factory floor be the default home screen or an alternate overview mode?
- Should the art direction be flat and utilitarian, or skeuomorphic with animated machines and characters?
- What is the right density for mobile: mini-map overview, list of stations, or swipeable station cards?
- Should the UI expose the meta-agent/coordinator as a supervisor booth or a normal station?
- How much of Isomux's task board idea should be adapted versus relying on this repo's `tasks/` folder?

## Implementation Log

- 2026-05-13: Captured task after reviewing Isomux's published feature list and reframing the desired UI as a factory-floor operations view for TUI UI.
- 2026-05-13: Bedtime scope set as a stacked branch on the meta-agent coordinator summary endpoint, adding a `/factory` route rather than replacing the existing home screen.
