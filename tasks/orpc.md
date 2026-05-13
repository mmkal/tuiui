---
status: ready-for-implementation
size: large
---

# Move JSON API To ORPC

Status: Implementation complete for the first ORPC slice. The ORPC router is mounted at `/rpc`, the browser `api()` helper now routes straightforward JSON calls through a typed ORPC client, and legacy `/api/*` JSON routes still share the same backend handlers. Remaining migration work is intentionally deferred for SSE, stdout polling, attachments, and SVG responses.

## Goal

Move the browser-facing JSON API surface toward ORPC so the client and server share a typed procedure model instead of a pile of stringly-typed fetch paths.

## Bedtime Scope

Use `@orpc/server` and `@orpc/client` from the published npm packages. Add a server router for normal JSON procedures and mount it under `/rpc`. Add a typed browser client that calls the router through `RPCLink`.

Migrate the current client calls that are plain JSON request/response calls to the ORPC client where it is straightforward:

- config, cwd, commands
- recent agent sessions
- session list and create
- session read
- session recovery and recover
- session send, key, resize, kill
- sdk refresh and summarize

Keep these endpoints on the current REST-style `/api/*` handlers for now because they are not a good first ORPC migration target:

- session events SSE
- stdout event polling if it is tightly coupled to the existing event flow
- attachments upload
- tuishot SVG/image responses

The old `/api/*` JSON paths should keep working in this PR. Prefer routing both ORPC and legacy handlers through the same underlying functions so the behavior cannot drift.

## Checklist

- [x] Add ORPC dependencies and a small router/client structure that fits the current Bun server. _Added published `@orpc/server`, `@orpc/client`, and `zod`; `cli.ts` now defines the ORPC router and `client/orpc-client.ts` defines the browser client._
- [x] Extract reusable JSON endpoint handlers from `cli.ts` so ORPC procedures and legacy `/api/*` routes share behavior. _Shared helpers now back config, cwd, commands, sessions, recovery, send/key/resize/kill, and SDK refresh/summarize._
- [x] Mount the ORPC `RPCHandler` under `/rpc`. _`startServer` creates an `RPCHandler` and checks `/rpc` before falling back to legacy `/api/*` handling._
- [x] Add a typed browser ORPC client. _`client/orpc-client.ts` exports a typed ORPC path adapter using `RouterClient<AppRouter>` and `RPCLink`._
- [x] Migrate straightforward JSON client calls away from manual `api<T>(path)` fetches. _`client/app.ts` sends recognized JSON API paths through `callOrpcJsonApi` before falling back to fetch._
- [x] Keep streaming, attachments, and SVG endpoints on legacy handlers with clear comments. _Unmapped API paths intentionally fall through to legacy fetch; the fallback comment names SSE, stdout, uploads, and SVG._
- [x] Add tests proving ORPC procedures work and legacy `/api/*` compatibility still works. _`test/orpc-api.test.ts` starts the Bun server, calls `/rpc` through an ORPC client, and compares legacy `/api` behavior._
- [x] Run typecheck and focused browser coverage. _Ran `bun run typecheck`, `bun test test/orpc-api.test.ts`, `bun test test/session-recovery.test.ts`, `bun build client/app.ts`, and focused Playwright coverage._

## Notes

Official ORPC docs used for this implementation:

- https://orpc.dev/docs/getting-started
- https://orpc.dev/docs/rpc-handler
- https://orpc.dev/docs/client/client-side

The ORPC docs recommend `@orpc/server` plus `@orpc/client`, with `RPCHandler` mounted under a prefix such as `/rpc` and browser clients created with `RPCLink`.

## Implementation Log

- 2026-05-13: Task fleshed out after coordination correction: stack is `main -> nightly/2026-05-13 -> ORPC implementation -> other bedtime branches`.
- 2026-05-13: Implemented ORPC JSON route layer and browser client adapter while preserving legacy endpoints for compatibility and non-JSON surfaces.
