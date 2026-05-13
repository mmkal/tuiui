---
status: ready-for-implementation
size: large
---

# Move JSON API To ORPC

Status: Ready for a first implementation pass above `nightly/2026-05-13`. The goal is to introduce an ORPC router and typed client for TUI UI's ordinary JSON API calls while preserving existing `/api/*` routes as compatibility shims. Streaming, file upload, and SVG endpoints stay on the current hand-written handlers for this slice.

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

- [ ] Add ORPC dependencies and a small router/client structure that fits the current Bun server.
- [ ] Extract reusable JSON endpoint handlers from `cli.ts` so ORPC procedures and legacy `/api/*` routes share behavior.
- [ ] Mount the ORPC `RPCHandler` under `/rpc`.
- [ ] Add a typed browser ORPC client.
- [ ] Migrate straightforward JSON client calls away from manual `api<T>(path)` fetches.
- [ ] Keep streaming, attachments, and SVG endpoints on legacy handlers with clear comments.
- [ ] Add tests proving ORPC procedures work and legacy `/api/*` compatibility still works.
- [ ] Run typecheck and focused browser coverage.

## Notes

Official ORPC docs used for this implementation:

- https://orpc.dev/docs/getting-started
- https://orpc.dev/docs/rpc-handler
- https://orpc.dev/docs/client/client-side

The ORPC docs recommend `@orpc/server` plus `@orpc/client`, with `RPCHandler` mounted under a prefix such as `/rpc` and browser clients created with `RPCLink`.

## Implementation Log

- 2026-05-13: Task fleshed out after coordination correction: stack is `main -> nightly/2026-05-13 -> ORPC implementation -> other bedtime branches`.
