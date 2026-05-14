---
status: ready
size: large
branch: bedtime/factory-floor-skeuomorphism
base: nightly/2026-05-14
---

# Factory Floor Agent UI

Status: Ready for a second implementation attempt. The direction is now explicitly skeuomorphic and Isomux-inspired, but reframed as a factory floor for TUI UI. The first slice should be an alternate overview, not a replacement for the current home/session UI. It should use generated bitmap art for the room/background/characters, with interactive HTML overlays for real sessions.

## Goal

Design and build a factory-floor-style multi-agent UI where active and recent agents are represented as workstations, production lines, bays, or machines, making it easy to see at a glance who is working, idle, blocked, waiting for the user, or done.

## Reference

Isomux is the main inspiration: https://isomux.com/

Relevant ideas from the reference are the visual office metaphor, animated characters for sleeping/typing/waiting states, mobile-friendly access, embedded terminal per agent, voice input, task board, inter-agent discovery, and completion notifications.

TUI UI should not copy the office metaphor directly. The requested direction is a factory floor: agent stations, task queues, work-in-progress lanes, supervisor controls, status lights, handoff belts, inspection/review areas, and visible bottlenecks.

## Notes

The UI should be useful and cute. It needs to preserve fast access to real terminals, session briefs, provider details, task files, branches, and PRs. The factory metaphor should improve scanning and coordination, not hide important operational details behind decoration.

Isomux reference repo cloned and inspected on 2026-05-14: https://github.com/nmamano/isomux

Concrete inspiration to steal:

- An isometric room/floor scene with fixed stations.
- Per-agent nametag/status/topic floating above each station.
- Animated visual states: working, idle/sleeping, waiting for human attention, exited/error.
- Skeuomorphic wall/floor controls rather than a separate dashboard shell.
- Small environmental props that communicate state without reading every label.

Do not copy Isomux source wholesale. If source structure, geometry, or component ideas are copied closely, include an attribution comment at the top of the new source file summarizing the inspiration and modifications.

Possible visual states:

- Agent working: station active, status light running, visible recent output/activity pulse.
- Agent idle: station quiet, completed item ready for inspection.
- Agent waiting for user: call light or blocked lane.
- Agent errored/exited: stopped machine with clear recovery action.
- Agent reviewing another agent: inspection station or quality-control lane.

The first version should be a new Home mode or route alongside the current list/detail UI. It should avoid a large rewrite until the state model and visual grammar prove useful.

## Asset Direction

Use imagegen for project-bound bitmap assets:

- `public/factory-floor/background.png`: a full-bleed isometric factory floor/control room background, no text, with obvious empty station bays.
- `public/factory-floor/station-atlas.png` or separate station art: compact workbench/terminal/machine assets that fit over real session data.
- `public/factory-floor/agent-sprites.png`: small character or technician poses for idle, working, waiting, and error/exited states.

Generated assets should be treated as replaceable first-pass art. Keep overlays and hit targets in HTML/CSS so the UI remains accessible and testable.

## Checklist

- [ ] Audit the current session list/detail UI and identify the data needed for a factory-floor overview.
- [ ] Sketch the factory-floor information architecture: stations, lanes, queues, inspection area, and detail drawer. _Keep this in the task file or PR body; a lightweight implementation note is enough._
- [ ] Generate first-pass bitmap assets with imagegen and commit them under `public/factory-floor/`.
- [ ] Define visual state mapping for busy, idle, waiting-for-user, exited, errored, reviewing, and stale sessions.
- [ ] Build a first responsive overview route or mode that shows active and recent sessions as stations over the generated floor art.
- [ ] Preserve one-click access to the terminal/session detail for each station.
- [ ] Add compact controls for spawning, resuming, stopping, and sending a prompt to an agent.
- [ ] Integrate task/branch/PR/status summary data when available, without blocking the first UI on perfect metadata.
- [ ] Add mobile layout behavior that keeps the overview scannable and makes station controls touch-friendly.
- [ ] Add Playwright coverage for the overview states and at least one screenshot/video artifact for PR review.

## Open Questions

- Should the factory floor be the default home screen or an alternate overview mode?
- Should the art direction be flat and utilitarian, or skeuomorphic with animated machines and characters?
- What is the right density for mobile: mini-map overview, list of stations, or swipeable station cards?
- Should the UI expose the meta-agent/coordinator as a supervisor booth or a normal station?
- How much of Isomux's task board idea should be adapted versus relying on this repo's `tasks/` folder?

## Implementation Log

- 2026-05-13: Captured task after reviewing Isomux's published feature list and reframing the desired UI as a factory-floor operations view for TUI UI.
- 2026-05-14: Re-scoped after product feedback: make the retry visibly skeuomorphic, inspect Isomux source, and use generated bitmap assets rather than only CSS boxes.
