export type RealtimeTranscriptionSdpInput = {
  sdp: string;
  apiKey: string;
  fetchImpl: typeof fetch;
};

const realtimeCallsUrl = "https://api.openai.com/v1/realtime/calls";

export function realtimeTranscriptionSessionConfig() {
  return {
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
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    },
  };
}

export async function createRealtimeTranscriptionSdpAnswer(input: RealtimeTranscriptionSdpInput) {
  const sdp = input.sdp.trim();
  if (!sdp) {
    throw new Error("missing realtime offer SDP");
  }
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(realtimeTranscriptionSessionConfig()));
  const response = await input.fetchImpl(realtimeCallsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI realtime transcription failed: ${text || response.status}`);
  }
  return text;
}

export async function realtimeTranscriptionSdpResponse(input: {
  request: Request;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}) {
  const apiKey = input.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return Response.json({
      error: "OPENAI_API_KEY is not configured",
    }, { status: 501 });
  }
  const answer = await createRealtimeTranscriptionSdpAnswer({
    sdp: await input.request.text(),
    apiKey,
    fetchImpl: input.fetchImpl,
  });
  return new Response(answer, {
    headers: {
      "Content-Type": "application/sdp",
    },
  });
}
