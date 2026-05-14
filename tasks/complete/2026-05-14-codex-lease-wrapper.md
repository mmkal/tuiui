---
status: done
size: medium
branch: codex-lease-wrapper
---

# Codex lease wrapper

Status summary: Implementation is complete and validated locally. `tuiui codex` now runs the real Codex CLI directly, records wrapper-owned process owners in tuiui's SQLite state DB, and terminates any active owner whose stored recovery command exactly matches `codex resume <session-id>`.

## Goal

Add a first-class `tuiui codex` command that can be aliased over `codex` without running Codex inside tmux. It should execute the real Codex CLI directly in the user's current terminal, record a lease mapping from Codex session id to the child process group, and terminate any known active lease before starting `codex resume <session-id>`.

## Assumptions

- Users will capture the real Codex executable before shadowing `codex`, for example `export REALCODEX="$(command -v codex)"`.
- The wrapper can only manage sessions started through the wrapper. Plain pre-existing `codex` processes have no reliable documented session-id-to-PID mapping.
- Killing a known active owner before `resume` is better than allowing split-brain. The laptop user can continue by running `codex resume <session-id>` after the old owner exits.
- Process ownership should use tuiui's existing SQLite state DB instead of a separate registry file.
- The implementation should use `trpc-cli` for the package command entrypoint, but Codex arguments remain pass-through.

## Checklist

- [x] Add package `bin` metadata and a `trpc-cli` entrypoint for `tuiui codex`. _Added `bin/tuiui.ts`, package `bin` metadata, and direct `trpc-cli` dependency._
- [x] Execute the real Codex binary directly, without tmux or terminal emulation. _`src/codex-lease.ts` spawns `REALCODEX`/`CODEX_LEASE_CODEX_BIN`/`command -v codex` with `stdio: "inherit"`._
- [x] Record process owners for wrapper-started Codex sessions without duplicating durable recovery metadata. _The normalized `session_process_owners` table stores session id, child PID, and timestamps; `cwd`, launch command, and recovery command come from `sessions` and `session_recovery`._
- [x] Discover the Codex session id from normal Codex output well enough to support the alias workflow. _Discovery reads Codex rollout `session_meta` files from `CODEX_HOME` or `~/.codex` so stdout stays attached to the terminal._
- [x] On `codex resume <session-id>`, terminate any active wrapper-owned lease for that session before starting the new Codex process. _Resume formats the attempted command as `codex resume <id>`, finds matching `session_recovery.recovery_command` rows, sends `SIGTERM`, waits briefly, then escalates to `SIGKILL` if needed before spawning the new Codex process._
- [x] Clean stale leases when the owning process no longer exists. _SQLite owner cleanup deletes rows whose PIDs are no longer alive._
- [x] Add focused tests with fake Codex processes to verify lease recording and resume-triggered termination. _`test/codex-lease-cli.test.ts` starts a fake long-lived Codex process, waits for the lease, then verifies `resume` terminates it before launching the resumed fake Codex._
- [x] Validate typecheck and focused tests. _Validated with Node syntax checks, focused Bun tests, and `bun run typecheck`._

## Implementation Notes

- This is an alternative to the tmux wrapper PR, not a stacked dependency on it.
- The confirmation workflow should be reproducible with two terminals:
  - terminal A: `codex`
  - terminal B: `codex resume <session-id-from-A>`
  - terminal A's wrapper-owned Codex process should be terminated before terminal B starts the resume.
- `session_process_owners` intentionally keeps only volatile process-owner facts. Durable resume data remains in `sessions` and `session_recovery`.
- The wrapper and tuiui daemon use the same state DB path: `TUIUI_STATE_DB`, otherwise `$XDG_STATE_HOME/tuiui/tuiui.sqlite` or `~/.local/state/tuiui/tuiui.sqlite`.
- Local validation:
  - `node --check bin/tuiui.ts && node --check src/codex-lease.ts`
  - `node bin/tuiui.ts --help`
  - `bun test test/codex-lease-cli.test.ts test/session-store.test.ts`
  - `bun test test`
  - `bun run typecheck`
