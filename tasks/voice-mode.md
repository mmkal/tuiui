---
status: ready
size: large
---

# Voice Mode

Status: Lightweight grill/spec pass complete. The first usable slice will keep microphone/transcription/readback in the browser, send accepted transcripts through the existing `/send` composer path, read back a concise browser/system speech message when the session idles, and expose provider acknowledgements as deterministic metadata for now rather than adding a second sidecar/forking API.

- [x] Run a `grill-you` design pass before implementation. _Done as a lightweight in-branch grill/spec pass because this branch, task file, and PR already exist._
- [x] Research `kitlangton/hex` for voice transcription model choices. _Hex defaults to Parakeet TDT v3 via FluidAudio and supports WhisperKit for on-device transcription; for TUI UI's browser-first slice, this remains future provider inspiration rather than a native dependency._
- [ ] Add push-to-talk voice input for a live TUI session. _Goal: speak from a car and have the TUI receive a sensible text prompt without fiddly keyboard interaction._
- [ ] Start with macOS built-in speech generation for readback. _Use browser `speechSynthesis` as the accessible system/browser baseline; keep a server-side `say` adapter out of this first slice unless browser support blocks manual use._
- [x] Decide the first transcription path. _Use browser SpeechRecognition/webkitSpeechRecognition first, with injectable fake recognizers in tests and a visible unsupported state when the browser lacks the API._
- [ ] Send transcribed voice prompts through the existing composer/session input path. _The TUI should still receive normal stdin text/key events so voice mode does not fork the input model._
- [ ] Use provider/session forking to make voice prompts feel responsive. _First pass may document a deterministic acknowledgement if real provider forking is too large; do not mutate the live provider session just to say "sent"._
- [ ] Detect when the TUI becomes idle after a voice prompt. _Use existing session status/idle tracking as the first signal, then refine if needed._
- [ ] Read out the result when the TUI goes idle. _First pass should read the latest concise assistant/status text derived from the SDK summary when present, otherwise a short terminal-output fallback._
- [ ] Add controls for voice mode in the browser UI. _Probably push-to-talk, stop speaking, mute/unmute, and a compact “listening/transcribing/speaking” state._
- [ ] Handle interruption and cancellation. _The user should be able to stop TTS, cancel listening, and send a terminal interrupt/chord without reaching for a keyboard._
- [ ] Add tests around the orchestration. _Use injectable fake transcription/TTS services; avoid depending on real microphone or macOS voices in automated tests._

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
