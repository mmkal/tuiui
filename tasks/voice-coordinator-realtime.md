---
status: ready
size: large
branch: bedtime/voice-coordinator-realtime
base: nightly/2026-05-14
---

# Voice Coordinator Realtime

Status: Spec fleshed out for bedtime implementation. The task is about making voice useful for the coordinator first: talk to the coordinator, let the coordinator inspect and route to other agents under its existing authorization rules, and improve speech capture beyond the browser Web Speech API. No code is implemented yet.

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

- [ ] Add an explicit "Talk to coordinator" path from Home that launches or focuses the normal coordinator session. _First implementation should reuse the existing coordinator command preset rather than inventing a special route._
- [ ] Add a server endpoint for creating short-lived Realtime transcription credentials/config when `OPENAI_API_KEY` is present. _Use the official ephemeral/session pattern; never expose the real API key to the browser._
- [ ] Add a Realtime-backed `VoiceRecognizer` implementation that satisfies the existing `client/voice.ts` interface. _It should emit interim/final transcripts and surface connection/mic errors as normal voice-loop errors._
- [ ] Add a user-visible provider/status control so it is clear whether voice is using Realtime, browser speech recognition, or is unsupported.
- [ ] Fall back to the existing browser recognizer when Realtime config is missing, denied, or fails before capture starts.
- [ ] Keep deterministic acknowledgement/readback behavior unless a better readback can be implemented without giving Realtime independent tool authority.
- [ ] Add tests for provider selection, Realtime fallback, transcript forwarding to coordinator, and preservation of `promptAgent` authorization semantics.
- [ ] Update the task file with implementation notes and move it to `tasks/complete/` when the PR is ready.

## Non-Goals

- Wake-word activation. Keep `tasks/wake-word-voice-mode.md` for that separate always-listening problem.
- Full speech-to-speech coordinator agent with its own tool calls.
- Letting voice directly target other agents without a coordinator prompt.
- Paid third-party wake-word services.

## Implementation Log

- 2026-05-14: Created bedtime spec after merging the normal coordinator session and lease wrapper PRs.
