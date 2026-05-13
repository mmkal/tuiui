---
status: expanding-skeuomorphic-demo
size: large
---

# Factory Floor Agent UI

Status: First slice exists, but the requested direction has moved much further toward a full skeuomorphic demo. Next work should replace the flat station-grid feel with an isometric factory floor: robot workers, cwd-based factory areas, speech bubbles, and click-through inspection details. Controls can stay modest until the visual/data model proves out.

## Goal

Design and build a factory-floor-style multi-agent UI where active and recent agents are represented as workstations, production lines, bays, or machines, making it easy to see at a glance who is working, idle, blocked, waiting for the user, or done.

## Reference

Isomux is the main inspiration: https://isomux.com/

Relevant ideas from the reference are the visual office metaphor, animated characters for sleeping/typing/waiting states, mobile-friendly access, embedded terminal per agent, voice input, task board, inter-agent discovery, and completion notifications.

TUI UI should not copy the office metaphor directly. The requested direction is a factory floor: agent stations, task queues, work-in-progress lanes, supervisor controls, status lights, handoff belts, inspection/review areas, and visible bottlenecks.

Second-pass direction after review: go much harder on skeuomorphism. The `/factory` route should feel like a miniature operations floor, not a dashboard dressed up with labels. Isomux-specific inspiration worth adapting: an isometric room, visible anthropomorphized workers, stateful poses, nametags/topics, clickable figures, and environmental props that carry information.

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

## Expanded Demo Scope

Build a richer demo on the same PR rather than starting a separate branch. It should remain useful from real coordinator data, but it can introduce a small, reviewable data-model addition if that makes the floor easier to render.

Assumptions:

- CWD is the right first grouping key for "factory areas".
- A "robot worker" can be CSS/HTML/SVG built in this repo; do not vendor Isomux artwork.
- Clicking a robot should open an in-page detail inspector first; the existing session link remains one click from there.
- Speech bubbles should use existing summaries/tasks and truncate cleanly rather than invent text.
- The demo should still pass mobile no-horizontal-scroll checks.

## Checklist

- [x] Audit the current session list/detail UI and the meta-agent summary endpoint for data needed by the factory overview. _Used the existing `CoordinatorSummary` model and home coordinator panel in `client/app.ts` as the data contract._
- [x] Define the factory-floor information architecture: supervisor booth, active stations, recent stations, inspection/review lane, and detail affordances. _First slice includes supervisor booth plus active/recent lanes; inspection/review remains a later lane._
- [ ] Define visual state mapping for busy, idle, waiting-for-user, exited, errored, reviewing, stale, and recoverable sessions.
- [x] Build a first responsive `/factory` overview route that shows active and recent sessions as stations. _Added `renderFactory` in `client/app.ts`, `/factory` homepage routing in `cli.ts`, and responsive factory CSS._
- [ ] Add cwd-based factory areas to the coordinator summary or derived UI model.
- [ ] Replace the flat station cards with a skeuomorphic factory floor surface: walls/floor, belts, machines, area signs, and robot workers.
- [ ] Render robots with stateful poses or indicators for busy, idle, blocked/stale, and exited/recent.
- [ ] Add speech bubbles showing each worker's current task/summary.
- [ ] Add a click detail inspector for a robot with status, cwd, branch, PR/task links, freshness/confidence, blocker text, and session open affordance.
- [x] Preserve one-click access to the terminal/session detail for each station. _Live stations render `Open` links to `/sessions/:id`; recent stations remain read-only in this slice._
- [ ] Add compact controls for opening, recovering/resuming when available, stopping live sessions when appropriate, and sending a prompt through the coordinator flow when available.
- [x] Integrate task/branch/PR/status summary data when available, without blocking the first UI on perfect metadata. _Stations show current task, provider, branch, cwd, status, freshness, and confidence with empty fallback text._
- [x] Add mobile layout behavior that keeps the overview scannable and makes station controls touch-friendly. _Factory lanes collapse to one column under tablet/mobile breakpoints and the spec checks no horizontal document scroll._
- [x] Add Playwright coverage for the overview states. _Added a mocked coordinator-summary Playwright spec covering busy, idle, recent stations, live `Open` links, and mobile no-horizontal-scroll behavior._
- [ ] Add at least one screenshot artifact for PR review.
- [ ] Replace/update PR media after the skeuomorphic demo lands.

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
- 2026-05-13: Expanded scope after review: go much harder on skeuomorphic Isomux-inspired factory-floor visuals, robot workers, cwd areas, speech bubbles, and click inspection details.
