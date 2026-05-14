---
status: in-progress
size: medium
branch: codex-lease-wrapper
---

# Codex lease wrapper

Status summary: Spec started; implementation is not yet done. The intended direction is a non-tmux Codex wrapper that preserves the normal terminal experience while recording enough local process ownership to avoid two live processes driving the same Codex session.

## Goal

Add a first-class `tuiui codex` command that can be aliased over `codex` without running Codex inside tmux. It should execute the real Codex CLI directly in the user's current terminal, record a lease mapping from Codex session id to the child process group, and terminate any known active lease before starting `codex resume <session-id>`.

## Assumptions

- Users will capture the real Codex executable before shadowing `codex`, for example `export REALCODEX="$(command -v codex)"`.
- The wrapper can only manage sessions started through the wrapper. Plain pre-existing `codex` processes have no reliable documented session-id-to-PID mapping.
- Killing a known active owner before `resume` is better than allowing split-brain. The laptop user can continue by running `codex resume <session-id>` after the old owner exits.
- The registry should be local, simple, and independent of tuiui's daemon/session database.
- The implementation should use `trpc-cli` for the package command entrypoint, but Codex arguments remain pass-through.

## Checklist

- [ ] Add package `bin` metadata and a `trpc-cli` entrypoint for `tuiui codex`.
- [ ] Execute the real Codex binary directly, without tmux or terminal emulation.
- [ ] Record leases for wrapper-started Codex sessions, including session id, PID/process group, cwd, tty, command, and timestamps.
- [ ] Discover the Codex session id from normal Codex output well enough to support the alias workflow.
- [ ] On `codex resume <session-id>`, terminate any active wrapper-owned lease for that session before starting the new Codex process.
- [ ] Clean stale leases when the owning process no longer exists.
- [ ] Add focused tests with fake Codex processes to verify lease recording and resume-triggered termination.
- [ ] Validate typecheck and focused tests.

## Implementation Notes

- This is an alternative to the tmux wrapper PR, not a stacked dependency on it.
- The confirmation workflow should be reproducible with two terminals:
  - terminal A: `codex`
  - terminal B: `codex resume <session-id-from-A>`
  - terminal A's wrapper-owned Codex process should be terminated before terminal B starts the resume.
