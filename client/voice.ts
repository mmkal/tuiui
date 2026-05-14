export type VoiceSessionPayload = {
  id: string;
  status: "busy" | "idle" | "exited";
  updatedAt: string;
  renderedText: string;
  sdk: {
    provider: "" | "opencode" | "codex" | "claude";
    summary: null | {
      latestUserText?: string;
      latestAssistantText: string;
      transcript?: VoiceTranscriptMessage[];
    };
  };
};

export type VoiceTranscriptMessage = {
  role: string;
  createdAt: string;
  text: string;
};

export type VoiceRecognitionResult = {
  transcript: string;
  final: boolean;
};

export type VoiceRecognizer = {
  supported: boolean;
  label?: string;
  start: (handlers: {
    onResult: (result: VoiceRecognitionResult) => void;
    onError: (message: string) => void;
    onEnd: () => void;
  }) => void;
  stop: () => void;
  cancel: () => void;
};

export type VoiceSpeaker = {
  supported: boolean;
  speak: (text: string) => void;
  stop: () => void;
};

export type VoiceLoopState = {
  status: "unsupported" | "idle" | "listening" | "transcribing" | "speaking" | "error";
  transcript: string;
  message: string;
  providerLabel: string;
  awaitingReadback: boolean;
};

export type VoiceLoop = {
  state: VoiceLoopState;
  startListening: () => void;
  stopListening: () => void;
  cancelListening: () => void;
  stopSpeaking: () => void;
  observePayload: (payload: VoiceSessionPayload) => void;
  subscribe: (listener: (state: VoiceLoopState) => void) => () => void;
};

export function createVoiceLoop(input: {
  recognizer: VoiceRecognizer;
  speaker: VoiceSpeaker;
  sendTranscript: (text: string) => Promise<void>;
  now: () => number;
  minReadbackDelayMs: number;
}) {
  const listeners = new Set<(state: VoiceLoopState) => void>();
  const providerLabel = input.recognizer.label || "browser";
  const state: VoiceLoopState = {
    status: input.recognizer.supported && input.speaker.supported ? "idle" : "unsupported",
    transcript: "",
    providerLabel,
    message: input.recognizer.supported && input.speaker.supported
      ? `Voice ready (${providerLabel})`
      : "Voice is not supported in this browser",
    awaitingReadback: false,
  };
  let pendingSessionId = "";
  let promptSentAt = 0;
  let promptPayloadUpdatedAt = "";
  let readbackSpokenFor = "";
  let cancelled = false;

  function emit() {
    for (const listener of listeners) {
      listener({ ...state });
    }
  }

  async function acceptTranscript(transcript: string) {
    const text = transcript.trim();
    if (!text || cancelled) {
      state.status = "idle";
      state.message = text ? "Listening cancelled" : "No speech detected";
      emit();
      return;
    }
    state.status = "speaking";
    state.transcript = text;
    state.message = "Sending voice prompt";
    state.awaitingReadback = true;
    pendingSessionId = "";
    promptSentAt = input.now();
    promptPayloadUpdatedAt = "";
    readbackSpokenFor = "";
    emit();
    await input.sendTranscript(text);
    input.speaker.speak(createAcknowledgement(text));
    state.status = "idle";
    state.message = "Voice prompt sent";
    emit();
  }

  const loop: VoiceLoop = {
    state,
    startListening() {
      if (!input.recognizer.supported || !input.speaker.supported) {
      state.status = "unsupported";
      state.message = "Voice is not supported in this browser";
      emit();
        return;
      }
      cancelled = false;
      state.status = "listening";
      state.transcript = "";
      state.message = `Listening (${providerLabel})`;
      emit();
      input.recognizer.start({
        onResult(result) {
          state.transcript = result.transcript;
          state.status = result.final ? "transcribing" : "listening";
          state.message = result.final ? "Transcribing" : `Listening (${providerLabel})`;
          emit();
          if (result.final) {
            void acceptTranscript(result.transcript).catch((error) => {
              state.status = "error";
              state.message = String(error instanceof Error ? error.message : error);
              state.awaitingReadback = false;
              emit();
            });
          }
        },
        onError(message) {
          state.status = "error";
          state.message = message;
          state.awaitingReadback = false;
          emit();
        },
        onEnd() {
          if (state.status === "listening") {
            state.status = "idle";
            state.message = `Voice ready (${providerLabel})`;
            emit();
          }
        },
      });
    },
    stopListening() {
      input.recognizer.stop();
      if (state.status === "listening") {
        state.status = "transcribing";
        state.message = "Transcribing";
        emit();
      }
    },
    cancelListening() {
      cancelled = true;
      input.recognizer.cancel();
      state.status = "idle";
      state.message = "Listening cancelled";
      emit();
    },
    stopSpeaking() {
      input.speaker.stop();
      if (state.status === "speaking") {
        state.status = "idle";
      }
      state.message = "Speech stopped";
      emit();
    },
    observePayload(payload) {
      if (!state.awaitingReadback) {
        return;
      }
      if (!pendingSessionId) {
        pendingSessionId = payload.id;
        promptPayloadUpdatedAt = payload.updatedAt;
      }
      if (payload.id !== pendingSessionId) {
        return;
      }
      if (payload.status !== "idle" || input.now() - promptSentAt < input.minReadbackDelayMs) {
        return;
      }
      if (payload.updatedAt === promptPayloadUpdatedAt && !payload.sdk.summary?.latestAssistantText) {
        return;
      }
      const text = createReadbackText(payload, {
        promptSentAt,
        promptText: state.transcript,
      });
      if (!text || readbackSpokenFor === `${payload.updatedAt}:${text}`) {
        return;
      }
      readbackSpokenFor = `${payload.updatedAt}:${text}`;
      state.awaitingReadback = false;
      state.status = "speaking";
      state.message = "Reading result";
      emit();
      input.speaker.speak(text);
      state.status = "idle";
      state.message = "Readback complete";
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return loop;
}

export function createBrowserVoiceRecognizer(): VoiceRecognizer {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let recognition: any = null;
  return {
    supported: Boolean(SpeechRecognition),
    label: "browser",
    start(handlers) {
      if (!SpeechRecognition) {
        handlers.onError("Speech recognition is not supported in this browser");
        return;
      }
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event: any) => {
        let transcript = "";
        let final = false;
        for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          transcript += String(result?.[0]?.transcript || "");
          final = final || Boolean(result?.isFinal);
        }
        handlers.onResult({ transcript, final });
      };
      recognition.onerror = (event: any) => {
        handlers.onError(String(event.error || "Speech recognition failed"));
      };
      recognition.onend = () => {
        handlers.onEnd();
      };
      recognition.start();
    },
    stop() {
      recognition?.stop();
    },
    cancel() {
      recognition?.abort();
      recognition = null;
    },
  };
}

export function createPreferredBrowserVoiceRecognizer(): VoiceRecognizer {
  return createFallbackVoiceRecognizer(
    createRealtimeTranscriptionVoiceRecognizer({
      endpoint: "/api/voice/realtime-transcription/sdp",
      fetchImpl: window.fetch.bind(window),
      mediaDevices: navigator.mediaDevices,
      PeerConnection: window.RTCPeerConnection,
    }),
    createBrowserVoiceRecognizer(),
  );
}

export function createFallbackVoiceRecognizer(primary: VoiceRecognizer, fallback: VoiceRecognizer): VoiceRecognizer {
  let active: VoiceRecognizer = primary.supported ? primary : fallback;
  return {
    supported: primary.supported || fallback.supported,
    label: primary.supported && fallback.supported ? `${primary.label || "primary"}, ${fallback.label || "fallback"} fallback` : active.label,
    start(handlers) {
      if (!primary.supported) {
        active = fallback;
        fallback.start(handlers);
        return;
      }
      active = primary;
      let emittedResult = false;
      primary.start({
        onResult(result) {
          emittedResult = true;
          handlers.onResult(result);
        },
        onError(message) {
          if (!emittedResult && fallback.supported) {
            active = fallback;
            fallback.start(handlers);
            return;
          }
          handlers.onError(message);
        },
        onEnd() {
          handlers.onEnd();
        },
      });
    },
    stop() {
      active.stop();
    },
    cancel() {
      active.cancel();
    },
  };
}

export function createRealtimeTranscriptionVoiceRecognizer(input: {
  endpoint: string;
  fetchImpl: typeof fetch;
  mediaDevices: MediaDevices | undefined;
  PeerConnection: typeof RTCPeerConnection | undefined;
}): VoiceRecognizer {
  let session: RealtimeTranscriptionBrowserSession | null = null;
  const supported = Boolean(input.PeerConnection && input.mediaDevices?.getUserMedia);
  return {
    supported,
    label: "Realtime",
    start(handlers) {
      const mediaDevices = input.mediaDevices;
      const PeerConnection = input.PeerConnection;
      if (!supported || !PeerConnection || !mediaDevices) {
        handlers.onError("Realtime transcription is not supported in this browser");
        return;
      }
      const nextSession: RealtimeTranscriptionBrowserSession = {
        cancelled: false,
        transcript: "",
        stream: null,
        pc: null,
        dc: null,
      };
      session = nextSession;
      void startRealtimeTranscription({
        endpoint: input.endpoint,
        fetchImpl: input.fetchImpl,
        mediaDevices,
        PeerConnection,
      }, nextSession, handlers).catch((error) => {
        closeRealtimeTranscriptionSession(nextSession);
        if (!nextSession.cancelled) {
          handlers.onError(String(error instanceof Error ? error.message : error));
        }
      });
    },
    stop() {
      if (!session) {
        return;
      }
      if (session.dc?.readyState === "open") {
        session.dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
      for (const track of session.stream?.getTracks() || []) {
        track.stop();
      }
    },
    cancel() {
      if (!session) {
        return;
      }
      session.cancelled = true;
      closeRealtimeTranscriptionSession(session);
      session = null;
    },
  };
}

type RealtimeTranscriptionBrowserSession = {
  cancelled: boolean;
  transcript: string;
  stream: MediaStream | null;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
};

async function startRealtimeTranscription(
  input: {
    endpoint: string;
    fetchImpl: typeof fetch;
    mediaDevices: MediaDevices;
    PeerConnection: typeof RTCPeerConnection;
  },
  session: RealtimeTranscriptionBrowserSession,
  handlers: Parameters<VoiceRecognizer["start"]>[0],
) {
  const pc = new input.PeerConnection();
  session.pc = pc;
  session.stream = await input.mediaDevices.getUserMedia({ audio: true });
  for (const track of session.stream.getTracks()) {
    pc.addTrack(track, session.stream);
  }
  const dc = pc.createDataChannel("oai-events");
  session.dc = dc;
  dc.addEventListener("message", (event) => {
    handleRealtimeTranscriptionEvent(session, handlers, String(event.data || ""));
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const offerSdp = offer.sdp || pc.localDescription?.sdp || "";
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
    },
    body: offerSdp,
  });
  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(answerSdp || `Realtime transcription setup failed (${response.status})`);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

function handleRealtimeTranscriptionEvent(
  session: RealtimeTranscriptionBrowserSession,
  handlers: Parameters<VoiceRecognizer["start"]>[0],
  rawEvent: string,
) {
  const event = parseRealtimeEvent(rawEvent);
  if (!event || session.cancelled) {
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    session.transcript += String(event.delta || "");
    handlers.onResult({ transcript: session.transcript, final: false });
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const transcript = String(event.transcript || session.transcript).trim();
    handlers.onResult({ transcript, final: true });
    closeRealtimeTranscriptionSession(session);
    handlers.onEnd();
    return;
  }
  if (event.type === "error") {
    closeRealtimeTranscriptionSession(session);
    handlers.onError(String(event.error?.message || "Realtime transcription failed"));
  }
}

function parseRealtimeEvent(rawEvent: string): any {
  try {
    return JSON.parse(rawEvent);
  } catch {
    return null;
  }
}

function closeRealtimeTranscriptionSession(session: RealtimeTranscriptionBrowserSession) {
  for (const track of session.stream?.getTracks() || []) {
    track.stop();
  }
  session.stream = null;
  session.dc?.close();
  session.dc = null;
  session.pc?.close();
  session.pc = null;
}

export function createBrowserVoiceSpeaker(): VoiceSpeaker {
  return {
    supported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    speak(text) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    },
    stop() {
      window.speechSynthesis.cancel();
    },
  };
}

export function createAcknowledgement(transcript: string) {
  const preview = transcript.trim().replace(/\s+/g, " ").slice(0, 90);
  return `Sent: ${preview}. I'll read back when the session is idle.`;
}

export function createReadbackText(
  payload: VoiceSessionPayload,
  freshness?: { promptSentAt: number; promptText: string },
) {
  const sdkText = createSdkReadbackText(payload, freshness);
  if (sdkText) {
    return sdkText;
  }
  if (payload.sdk.provider) {
    return "";
  }
  const visible = payload.renderedText
    .split("\n")
    .map(cleanTerminalReadbackLine)
    .filter(Boolean)
    .slice(-4)
    .join(". ");
  return shortenForSpeech(visible);
}

function createSdkReadbackText(
  payload: VoiceSessionPayload,
  freshness?: { promptSentAt: number; promptText: string },
) {
  const summary = payload.sdk.summary;
  if (!summary) {
    return "";
  }
  const summaryText = cleanProviderReadbackText(summary.latestAssistantText);
  if (!summaryText) {
    return "";
  }
  if (!freshness) {
    return shortenForSpeech(summaryText);
  }

  const assistant = freshAssistantMessageForPrompt(summary.transcript || [], freshness);
  return assistant ? shortenForSpeech(cleanProviderReadbackText(assistant.text)) : "";
}

function freshAssistantMessageForPrompt(
  transcript: VoiceTranscriptMessage[],
  freshness: { promptSentAt: number; promptText: string },
) {
  const prompt = normalizeFreshnessText(freshness.promptText);
  if (!prompt) {
    return null;
  }

  const latestPromptIndex = transcript.findLastIndex((message) => {
    return message.role === "user" && normalizeFreshnessText(message.text) === prompt;
  });
  if (latestPromptIndex < 0) {
    return null;
  }

  const user = transcript[latestPromptIndex]!;
  const assistantIndex = transcript.findLastIndex((message, index) => {
    return index > latestPromptIndex && message.role === "assistant" && Boolean(message.text.trim());
  });
  if (assistantIndex < 0) {
    return null;
  }

  const assistant = transcript[assistantIndex]!;
  if (!messageTimestampMakesSense(user, assistant, freshness.promptSentAt)) {
    return null;
  }
  return assistant;
}

function messageTimestampMakesSense(
  user: VoiceTranscriptMessage,
  assistant: VoiceTranscriptMessage,
  promptSentAt: number,
) {
  const userMs = Date.parse(user.createdAt);
  const assistantMs = Date.parse(assistant.createdAt);
  if (!Number.isFinite(userMs) || !Number.isFinite(assistantMs)) {
    return false;
  }

  const timestampToleranceMs = 1_500;
  return userMs >= promptSentAt - timestampToleranceMs
    && assistantMs >= userMs - timestampToleranceMs;
}

function normalizeFreshnessText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanProviderReadbackText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^\[(step-start|step-finish|reasoning)\]$/i.test(line))
    .join("\n")
    .trim();
}

function cleanTerminalReadbackLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^[╭╮╯╰─│┌┐└┘═║╔╗╚╝\s]+$/.test(trimmed)) {
    return "";
  }
  return trimmed
    .replace(/^[│║]\s*/, "")
    .replace(/\s*[│║]$/, "")
    .trim();
}

function shortenForSpeech(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 420) {
    return normalized;
  }
  return `${normalized.slice(0, 417).trim()}...`;
}
