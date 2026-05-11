import { expect, test } from "bun:test";
import { createAcknowledgement, createReadbackText, createVoiceLoop, type VoiceRecognizer, type VoiceSpeaker } from "../client/voice.ts";

test("voice loop sends final transcripts and reads back after the session returns idle", async () => {
  let now = 1_000;
  const spoken: string[] = [];
  const sent: string[] = [];
  const recognizer = fakeRecognizer();
  const loop = createVoiceLoop({
    recognizer,
    speaker: fakeSpeaker(spoken),
    now: () => now,
    minReadbackDelayMs: 0,
    async sendTranscript(text) {
      sent.push(text);
    },
  });

  loop.startListening();
  recognizer.emit({ transcript: "what is one plus two", final: true });
  await Promise.resolve();

  expect(sent).toEqual(["what is one plus two"]);
  expect(spoken).toEqual([createAcknowledgement("what is one plus two")]);
  expect(loop.state).toMatchObject({
    status: "idle",
    transcript: "what is one plus two",
    awaitingReadback: true,
  });

  now += 100;
  loop.observePayload({
    id: "session-1",
    status: "idle",
    updatedAt: "2026-05-11T10:00:01.000Z",
    renderedText: "Ask anything\nAnswer\nthree",
    sdk: {
      summary: {
        latestAssistantText: "three",
      },
    },
  });

  expect(spoken).toEqual([
    createAcknowledgement("what is one plus two"),
    "three",
  ]);
  expect(loop.state).toMatchObject({
    status: "idle",
    awaitingReadback: false,
    message: "Readback complete",
  });
});

test("voice loop can be tested without a microphone or system speech", () => {
  const spoken: string[] = [];
  const recognizer = fakeRecognizer();
  const loop = createVoiceLoop({
    recognizer,
    speaker: fakeSpeaker(spoken),
    now: () => 1,
    minReadbackDelayMs: 0,
    async sendTranscript() {
      throw new Error("cancelled transcripts should not send");
    },
  });

  loop.startListening();
  loop.cancelListening();
  recognizer.emit({ transcript: "ignore this", final: true });

  expect(spoken).toEqual([]);
  expect(loop.state).toMatchObject({
    status: "idle",
    message: "Listening cancelled",
  });
});

test("readback prefers SDK assistant text and falls back to trailing terminal text", () => {
  expect(createReadbackText({
    id: "session-1",
    status: "idle",
    updatedAt: "2026-05-11T10:00:00.000Z",
    renderedText: "terminal fallback",
    sdk: {
      summary: {
        latestAssistantText: "provider answer",
      },
    },
  })).toBe("provider answer");

  expect(createReadbackText({
    id: "session-1",
    status: "idle",
    updatedAt: "2026-05-11T10:00:00.000Z",
    renderedText: "line one\nline two\nline three\nline four\nline five",
    sdk: {
      summary: null,
    },
  })).toBe("line two. line three. line four. line five");
});

function fakeRecognizer() {
  let handlers: Parameters<VoiceRecognizer["start"]>[0] | null = null;
  const recognizer: VoiceRecognizer & { emit: (result: { transcript: string; final: boolean }) => void } = {
    supported: true,
    start(nextHandlers) {
      handlers = nextHandlers;
    },
    stop() {
    },
    cancel() {
      handlers = null;
    },
    emit(result) {
      handlers?.onResult(result);
    },
  };
  return recognizer;
}

function fakeSpeaker(spoken: string[]): VoiceSpeaker {
  return {
    supported: true,
    speak(text) {
      spoken.push(text);
    },
    stop() {
      spoken.push("[stop]");
    },
  };
}
