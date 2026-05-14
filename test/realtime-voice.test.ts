import { expect, test } from "bun:test";
import {
  createRealtimeTranscriptionSdpAnswer,
  realtimeTranscriptionSdpResponse,
  realtimeTranscriptionSessionConfig,
} from "../src/realtime-voice.ts";

test("builds a transcription-only realtime session config", () => {
  expect(realtimeTranscriptionSessionConfig()).toMatchObject({
    type: "transcription",
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24_000,
        },
        transcription: {
          model: "gpt-realtime-whisper",
          language: "en",
        },
        turn_detection: {
          type: "server_vad",
        },
      },
    },
  });
});

test("exchanges browser offer SDP for an OpenAI realtime answer", async () => {
  const calls: Array<{ url: string; authorization: string; form: FormData }> = [];
  const answer = await createRealtimeTranscriptionSdpAnswer({
    sdp: "v=0\r\no=- offer\r\n",
    apiKey: "test-key",
    fetchImpl: (async (url, init) => {
      calls.push({
        url: String(url),
        authorization: String((init?.headers as any).Authorization),
        form: init?.body as FormData,
      });
      return new Response("v=0\r\no=- answer\r\n");
    }) as typeof fetch,
  });

  expect(answer).toBe("v=0\r\no=- answer\r\n");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "https://api.openai.com/v1/realtime/calls",
    authorization: "Bearer test-key",
  });
  expect(calls[0].form.get("sdp")).toBe("v=0\r\no=- offer");
  expect(JSON.parse(String(calls[0].form.get("session")))).toMatchObject({
    type: "transcription",
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
        },
      },
    },
  });
});

test("does not expose realtime setup without an OpenAI API key", async () => {
  const response = await realtimeTranscriptionSdpResponse({
    request: new Request("http://tuiui.test/api/voice/realtime-transcription/sdp", {
      method: "POST",
      body: "v=0",
    }),
    env: {},
    fetchImpl: (async () => {
      throw new Error("should not fetch without a key");
    }) as unknown as typeof fetch,
  });

  expect(response).toMatchObject({
    status: 501,
  });
  expect(await response.json()).toMatchObject({
    error: "OPENAI_API_KEY is not configured",
  });
});
