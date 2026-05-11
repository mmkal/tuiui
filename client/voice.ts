export type VoiceSessionPayload = {
  id: string;
  status: "busy" | "idle" | "exited";
  updatedAt: string;
  renderedText: string;
  sdk: {
    summary: null | {
      latestAssistantText: string;
    };
  };
};

export type VoiceRecognitionResult = {
  transcript: string;
  final: boolean;
};

export type VoiceRecognizer = {
  supported: boolean;
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
  const state: VoiceLoopState = {
    status: input.recognizer.supported && input.speaker.supported ? "idle" : "unsupported",
    transcript: "",
    message: input.recognizer.supported && input.speaker.supported
      ? "Voice ready"
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
      state.message = "Listening";
      emit();
      input.recognizer.start({
        onResult(result) {
          state.transcript = result.transcript;
          state.status = result.final ? "transcribing" : "listening";
          state.message = result.final ? "Transcribing" : "Listening";
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
            state.message = "Voice ready";
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
      const text = createReadbackText(payload);
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

export function createReadbackText(payload: VoiceSessionPayload) {
  const sdkText = payload.sdk.summary?.latestAssistantText.trim();
  if (sdkText) {
    return shortenForSpeech(sdkText);
  }
  const visible = payload.renderedText
    .split("\n")
    .map(cleanTerminalReadbackLine)
    .filter(Boolean)
    .slice(-4)
    .join(". ");
  return shortenForSpeech(visible);
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
