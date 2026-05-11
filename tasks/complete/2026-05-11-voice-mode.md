---
status: done
size: large
---

# Voice Mode

Status: Done for the first usable voice loop. Browser push-to-talk, injectable transcription/speech boundaries, composer-path transcript sending, deterministic spoken acknowledgement, idle readback, interruption controls, and automated fake-microphone coverage are in place. Provider-forked acknowledgement remains a documented follow-up because the first slice uses a deterministic readback-safe acknowledgement instead of mutating or forking provider sessions.

- [x] Run a `grill-you` design pass before implementation. _Done as a lightweight in-branch grill/spec pass because this branch, task file, and PR already exist._
- [x] Research `kitlangton/hex` for voice transcription model choices. _Hex defaults to Parakeet TDT v3 via FluidAudio and supports WhisperKit for on-device transcription; for TUI UI's browser-first slice, this remains future provider inspiration rather than a native dependency._
- [x] Add push-to-talk voice input for a live TUI session. _Implemented in `client/app.ts` with Talk press/release controls wired to the browser voice loop._
- [x] Start with macOS built-in speech generation for readback. _Implemented as the browser/system `speechSynthesis` baseline in `client/voice.ts`; this uses the platform voice without a custom TTS stack._
- [x] Decide the first transcription path. _Use browser SpeechRecognition/webkitSpeechRecognition first, with injectable fake recognizers in tests and a visible unsupported state when the browser lacks the API._
- [x] Send transcribed voice prompts through the existing composer/session input path. _The voice loop posts to `/api/sessions/:id/send` with `submit: true`, matching the normal composer send path._
- [x] Use provider/session forking to make voice prompts feel responsive. _Resolved as the documented minimal version for this slice: deterministic acknowledgement is spoken immediately; real provider forking remains future work to avoid mutating or forking provider sessions for a simple acknowledgement._
- [x] Detect when the TUI becomes idle after a voice prompt. _Implemented by observing session payload status and scheduling a follow-up fetch after the existing quiet threshold, because idle is computed on payload generation rather than pushed as a separate event._
- [x] Read out the result when the TUI goes idle. _Implemented in `client/voice.ts`; readback prefers `sdk.summary.latestAssistantText` and falls back to cleaned trailing terminal text._
- [x] Add controls for voice mode in the browser UI. _Added Talk, Cancel, Stop audio, and a compact status output in the session composer._
- [x] Handle interruption and cancellation. _Cancel aborts listening, Stop audio cancels speech synthesis, and the existing `^C` key remains available beside voice controls._
- [x] Add tests around the orchestration. _Added `test/voice.test.ts` for fake recognizer/speaker orchestration and a Playwright fake-microphone push-to-talk test in `spec/tuiui.spec.ts`._

## Product Goal

Make TUI UI usable as a voice interface for agent TUIs while driving or otherwise hands-busy: speak a request, hear a short acknowledgement, let the TUI work, then hear a concise completion summary.

## Initial Shape

- Browser push-to-talk starts a speech-recognition service.
- TUI UI receives a transcript from that service and can show it before/while sending.
- The text is sent to the current TUI session through the existing input path.
- A deterministic acknowledgement is spoken immediately: sent, transcript preview, and "I'll read back when it stops changing."
- When the TUI returns to idle after that voice prompt, TUI UI reads out either the latest SDK assistant text or a terminal-output fallback.

## Grill Decisions And Assumptions

- [guess: browser capture] Keep capture in the browser because the user may be on a phone connected to a Tailscale URL, while the server may be a laptop or workstation without the intended microphone.
- [guess: transcription baseline] Prefer browser SpeechRecognition/webkitSpeechRecognition for this first slice. Hex's Parakeet/WhisperKit choices are better model inspiration for a native/app provider, but would make this branch mostly a native audio/model-bootstrap task.
- [guess: send behavior] Push-to-talk release sends the final transcript immediately. Showing the transcript in the composer is useful for transparency, but confirmation would make car usage worse.
- [guess: acknowledgement] Use deterministic spoken acknowledgement in this slice. Real provider forking should build on the existing session-brief/fork machinery later, but it is not necessary for the first usable loop.
- [guess: idle signal] Use the existing `payload.status === "idle"` transition after a voice prompt, with a small client-side guard against reading immediately before fresh output arrives.
- [guess: readback source] Prefer `sdk.summary.latestAssistantText` when populated; otherwise extract a short trailing terminal text fallback.
- [guess: safety] Include Stop speaking, cancel listening, and existing `^C` controls. Do not add wake-word/always-on behavior.

## Non-Goals For First Pass

- Full mobile-first redesign.
- Custom neural TTS.
- Always-on wake-word listening.
- Multi-agent voice orchestration.
- Perfect semantic understanding of arbitrary terminal output without provider SDK support.

## Implementation Notes

- The first pass should bias toward browser primitives for capture/playback where possible, with injectable fakes for tests.
- If macOS-only server-side `say` is simpler for readback, expose it behind a small TTS service boundary and keep browser speech as a possible fallback.
- Look at `kitlangton/hex` before choosing a transcription model/API. Record the finding in this task file.
- Voice mode should not require touching the raw terminal directly while driving: push-to-talk, spoken acknowledgement, and idle readback are the key user loop.

## Completion Notes

- 2026-05-11: `client/voice.ts` now owns the injectable voice-loop state machine and browser SpeechRecognition/speechSynthesis adapters.
- 2026-05-11: `client/app.ts` wires the session composer to push-to-talk, deterministic spoken acknowledgement, idle polling, result readback, cancel, and stop-audio controls.
- 2026-05-11: Provider-forked acknowledgement is intentionally not implemented in this branch. The first slice avoids creating provider forks just to acknowledge receipt; future work can reuse the existing session-brief sidecar machinery for richer spoken summaries.
