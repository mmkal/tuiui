---
status: in-progress
size: large
---

# Voice Mode

Status: Spec commit before the required `grill-you` pass. The implementation goal is a first usable voice loop for talking to a TUI from a car, with browser push-to-talk, transcription, macOS/system speech readback, and fork/sidecar help for acknowledgements and concise readouts.

- [ ] Run a `grill-you` design pass before implementation. _The open questions are large enough that the first implementation task should be generated from a grilled spec rather than this rough sketch._
- [ ] Research `kitlangton/hex` for voice transcription model choices. _Use it as inspiration for model/provider selection, latency expectations, and local-vs-cloud tradeoffs._
- [ ] Add push-to-talk voice input for a live TUI session. _Goal: speak from a car and have the TUI receive a sensible text prompt without fiddly keyboard interaction._
- [ ] Start with macOS built-in speech generation for readback. _No custom TTS stack is required for the first pass; use the system voice as the pragmatic baseline._
- [ ] Decide the first transcription path. _Likely candidates: browser Web Speech API, native macOS dictation hooks, or a server-side transcription model inspired by Hex._
- [ ] Send transcribed voice prompts through the existing composer/session input path. _The TUI should still receive normal stdin text/key events so voice mode does not fork the input model._
- [ ] Use provider/session forking to make voice prompts feel responsive. _When the user issues a voice prompt, fork or sidecar the provider session to generate a short spoken acknowledgement such as “OK, I’ll work on that; I expect this to take about N minutes.”_
- [ ] Detect when the TUI becomes idle after a voice prompt. _Use existing session status/idle tracking as the first signal, then refine if needed._
- [ ] Read out the result when the TUI goes idle. _First pass can read the last assistant message; better pass may fork/sidecar a short spoken summary to avoid reading huge output verbatim._
- [ ] Add controls for voice mode in the browser UI. _Probably push-to-talk, stop speaking, mute/unmute, and a compact “listening/transcribing/speaking” state._
- [ ] Handle interruption and cancellation. _The user should be able to stop TTS, cancel listening, and send a terminal interrupt/chord without reaching for a keyboard._
- [ ] Add tests around the orchestration. _Use injectable fake transcription/TTS services; avoid depending on real microphone or macOS voices in automated tests._

## Product Goal

Make TUI UI usable as a voice interface for agent TUIs while driving or otherwise hands-busy: speak a request, hear a short acknowledgement, let the TUI work, then hear a concise completion summary.

## Initial Shape

- Browser records or captures a voice utterance.
- TUI UI transcribes it into text.
- The text is sent to the current TUI session through the existing input path.
- A sidecar/forked provider session generates a short spoken acknowledgement and rough time estimate.
- When the TUI returns to idle, TUI UI reads out either the last assistant message or a sidecar-shortened version.

## Open Questions For Grilling

- Should voice capture live entirely in the browser, or should the server own microphone/transcription plumbing?
- Which transcription model/provider should be the first implementation target after looking at `kitlangton/hex`?
- Should spoken acknowledgements be generated from the provider SDK, from a generic model, or from a deterministic template?
- What counts as “idle enough” for readback: TUI output quiet for N seconds, provider SDK status, or explicit session state?
- Should voice prompts always send immediately, or should the transcript be shown for confirmation first?
- What safety affordances are needed for car usage without making the workflow too slow?

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
