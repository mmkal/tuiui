---
status: complete
size: large
branch: bedtime/voice-coordinator-realtime
base: nightly/2026-05-14
---

# Voice Coordinator Realtime

Status: Complete for the first coordinator voice slice. Home now has a Talk to coordinator path, the voice loop can prefer Realtime transcription over browser speech recognition, server-side SDP relay keeps the OpenAI API key private, and fallback/browser behavior remains covered. Full speech-to-speech coordinator reasoning and wake-word activation remain out of scope.

## Goal

Let the user use voice as an operations interface: speak to the coordinator, ask what agents are doing, and explicitly ask it to tell or ask another agent something. The coordinator remains the authority boundary; voice should produce user-visible coordinator prompts, not bypass `promptAgent` authorization.

## Bedtime Scope

Implement the smallest useful slice that improves voice quality and coordinator ergonomics without replacing the coordinator with a separate realtime agent:

- Add a home/session affordance to launch or focus the coordinator and use voice there.
- Add a pluggable Realtime transcription recognizer behind the current voice loop, using the current `gpt-realtime` Realtime transcription/WebRTC path when `OPENAI_API_KEY` is configured.
- Keep the existing Web Speech recognizer as fallback when Realtime is unavailable, disabled, or fails.
- Send final transcripts through the same session input path as typed coordinator prompts.
- Preserve the coordinator's existing `promptAgent` guard: a spoken phrase like "tell agent X ..." becomes the latest human prompt in the coordinator session, and only then may the coordinator call `promptAgent` for X.
- Do not implement full speech-to-speech coordinator reasoning in this slice. That can come later if the transcript-first flow feels too slow or brittle.

## Research Notes

Official OpenAI docs checked on 2026-05-14:

- Realtime overview: https://platform.openai.com/docs/guides/realtime/overview
- Realtime WebRTC: https://platform.openai.com/docs/guides/realtime-webrtc
- Realtime transcription: https://platform.openai.com/docs/guides/realtime-transcription
- `gpt-realtime` model: https://developers.openai.com/api/docs/models/gpt-realtime
- Voice agents: https://platform.openai.com/docs/guides/voice-agents

The docs recommend WebRTC for browser realtime apps and describe server-minted ephemeral credentials. For TUI UI, the safer first slice is transcription-only Realtime: it improves capture/VAD while leaving agent coordination in the existing Codex coordinator session.

## Checklist

- [x] Add an explicit "Talk to coordinator" path from Home that launches or focuses the normal coordinator session. _Added a Home shortcut that reuses the normal coordinator preset and opens an existing running coordinator when possible._
- [x] Add a server endpoint for creating short-lived Realtime transcription credentials/config when `OPENAI_API_KEY` is present. _Added `/api/voice/realtime-transcription/sdp`, which relays browser SDP to OpenAI's unified Realtime calls endpoint with a transcription-only session config._
- [x] Add a Realtime-backed `VoiceRecognizer` implementation that satisfies the existing `client/voice.ts` interface. _Added `createRealtimeTranscriptionVoiceRecognizer`, which listens for Realtime transcription delta/completed events._
- [x] Add a user-visible provider/status control so it is clear whether voice is using Realtime, browser speech recognition, or is unsupported. _Voice status now includes the recognizer label, for example `Voice ready (Realtime, browser fallback)`._
- [x] Fall back to the existing browser recognizer when Realtime config is missing, denied, or fails before capture starts. _Added `createFallbackVoiceRecognizer` and kept the browser recognizer as the fallback path._
- [x] Keep deterministic acknowledgement/readback behavior unless a better readback can be implemented without giving Realtime independent tool authority. _Realtime only supplies transcription; acknowledgements/readback still come from the existing voice loop and session payloads._
- [x] Add tests for provider selection, Realtime fallback, transcript forwarding to coordinator, and preservation of `promptAgent` authorization semantics. _Added Realtime unit tests, fallback recognizer coverage, and a Playwright Talk to coordinator launch spec; coordinator authorization remains enforced by the existing runtime tests._
- [x] Update the task file with implementation notes and move it to `tasks/complete/` when the PR is ready. _Moved this task to complete on this branch._

## Non-Goals

- Wake-word activation. Keep `tasks/wake-word-voice-mode.md` for that separate always-listening problem.
- Full speech-to-speech coordinator agent with its own tool calls.
- Letting voice directly target other agents without a coordinator prompt.
- Paid third-party wake-word services.

## Implementation Log

- 2026-05-14: Created bedtime spec after merging the normal coordinator session and lease wrapper PRs.
- 2026-05-14: Implemented the Realtime transcription SDP relay, browser recognizer fallback chain, Talk to coordinator shortcut, and focused tests. Verified with `bun run typecheck`, `bun test test/realtime-voice.test.ts test/voice.test.ts`, and `bun run spec --grep "coordinator|push-to-talk|voice"`.
