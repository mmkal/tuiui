# Coordinator Managed Session Pivot Grill

## Q1 - shared stdin authorization - 2026-05-14

`coordinatorLatestPromptAgentAuthorization` scans the coordinator session's `stdinEvents` in reverse for the latest non-empty event. Human-entered text and system-injected idle-event prompts both flow through `sendToSession`, so an idle-event prompt can deliberately replace a prior human authorization.

**Question:** Is the shared `stdinEvents` array the right place to carry both human authorization and system event injection, given that a late-arriving idle event will revoke a still-valid human authorization?

**Recommended answer:** Yes. If an unrelated idle event has fired since the human gave the instruction, the coordinator should not act on a stale grant. Any forwarding after an idle interruption requires the human to re-issue the instruction.

**Decision:** Yes. `promptAgent` authorization comes only from the latest thing the coordinator session received. That makes the stdin stream the ordering boundary for the normal TUI session.

## Q2 - grant consumption - 2026-05-14

The first managed-session version authorized `promptAgent` by reading `stdinEvents`, but did not consume a successful grant. That allowed repeated sends to the same agent until another stdin event arrived.

**Question:** Should a successful `promptAgent` call consume the authorization, or may the coordinator make multiple calls to the same target within one human turn?

**Recommended answer:** Leave it unconsumed for the first cut, because the LLM may split one instruction into two calls.

**Decision:** Disagree with the recommendation. Successful `promptAgent` calls consume the grant for the `(stdinEventId, agentId)` pair. This matches the earlier server-side gate and is safer for a tool that writes into a live worker. One human prompt may authorize multiple target agents if it explicitly names them, but only one successful call per target per latest stdin event.

## Resolved Shape

- Coordinator rendering: normal session TUI, no custom `/coordinator` route.
- Coordination abilities: deterministic TypeScript functions over MCP.
- Authorization source: latest non-empty stdin event, whether human-entered or injected.
- Idle event effect: replaces prior human authorization and blocks `promptAgent` because it has no forwarding verb.
- Grant consumption: consumed per `(stdinEventId, agentId)` after first successful call.
- Multi-target prompt: allowed; each target has an independent grant.
- Autonomous forwarding on idle: blocked by design.
