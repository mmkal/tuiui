import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vsCodeDark } from "@fsegurai/codemirror-theme-bundle";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ILinkHandler, Terminal as XtermTerminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import {
  detectChordBinary,
  parseChordSteps,
  presetsForBinary,
  type ChordBinary,
} from "../src/chords.ts";
import { parseCommandLine } from "../src/command-line.ts";
import { stringify as stringifyYaml } from "yaml";
import { attachmentUploadName, dedupeClipboardImageFiles, type AttachmentSource } from "./attachments.ts";
import { callOrpcJsonApi } from "./orpc-client.ts";
import { showToast } from "./toast.ts";
import {
  createBrowserVoiceRecognizer,
  createBrowserVoiceSpeaker,
  createVoiceLoop,
  type VoiceLoop,
  type VoiceRecognizer,
  type VoiceSpeaker,
} from "./voice.ts";

type SessionPayload = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  updatedAt: string;
  lifecycle: "running" | "exited";
  status: "busy" | "idle" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
  renderedText: string;
  renderedHtml: string;
  renderedAnsi?: string;
  screenVersion: number;
  snapshotEventId: number;
  redrawActive: boolean;
  blocks: TerminalBlockModel;
  semantic: SemanticScreen;
  sdk: SessionSdkPayload;
  stdinEvents: Array<{ id: number; text: string; createdAt: string }>;
  stdoutEvents: Array<{ id: number; chunk: string; displayText: string; createdAt: string }>;
};

type SessionRecoveryPayload = {
  id: string;
  cwd: string;
  launchCommand: string;
  createdAtMs: number;
  recoveryCommand: string | null;
  recoveryCreatedAtMs: number | null;
  recoverable: boolean;
};

type ClientConfig = {
  pageLoadToasts: boolean;
};

type SessionSdkPayload = {
  provider: "" | "opencode" | "codex" | "claude";
  state: "unavailable" | "ready" | "connected" | "not-found" | "error";
  baseUrl: string;
  externalSessionId: string;
  status: string;
  updatedAt: string;
  error: string;
  sidecarSummary: SidecarSummaryState;
  forks: SidecarSummaryFork[];
  summary: null | {
    provider: "opencode" | "codex" | "claude";
    title: string;
    forkPoint: string;
    messageCount: number;
    diffCount: number;
    additions: number;
    deletions: number;
    latestUserText: string;
    latestAssistantText: string;
    sessionBrief: StructuredSessionBrief | null;
    transcript: Array<{ id: string; role: string; createdAt: string; text: string }>;
    diffs: Array<{ file: string; additions: number; deletions: number }>;
  };
};

type StructuredSessionBrief = {
  format: "tuiui.sessionBrief.v1";
  executiveSummary: string;
  initialUserRequest: string;
  currentState: string;
  completedWork: string[];
  filesChanged: Array<{ path: string; summary: string }>;
  risksBlockers: string[];
  suggestedNextActions: string[];
  raw: string;
  parseErrors: string[];
};

type SidecarSummaryState = {
  implemented: boolean;
  status: "idle" | "running" | "completed" | "error";
  method: "" | "opencode.session.fork+prompt" | "codex.startThread+summary" | "claude.query+forkSession";
  sourceSessionId: string;
  forkSessionId: string;
  forkPoint: string;
  updatedAt: string;
  result: boolean | null;
  error: string;
  note: string;
};

type SidecarSummaryFork = {
  provider: "opencode" | "codex" | "claude";
  purpose: "sidecarSummary";
  sourceSessionId: string;
  forkSessionId: string;
  forkPoint: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "summarized" | "error";
  result: boolean | null;
  error: string;
  summary: SessionSdkPayload["summary"];
};

type SemanticScreen = {
  title: string;
  status: string;
  prompt: string;
  rawText: string;
  sections: SemanticSection[];
};

type SemanticSection = {
  id: string;
  kind: string;
  title: string;
  text: string;
  lines: string[];
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
};

type TerminalBlockModel = {
  coordinateSystem: {
    origin: "top-left";
    x1: "exclusive";
    y1: "exclusive";
  };
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  rawText: string;
  blocks: TerminalBlock[];
};

type TerminalBlock = {
  id: string;
  kind: string;
  bounds: { x0: number; y0: number; x1: number; y1: number; width: number; height: number };
  text: string;
  lines: string[];
  border: null | { style: string; title: string };
  colors: { foregrounds: string[]; backgrounds: string[]; flags: string[] };
  confidence: number;
};

type CommandPreset = {
  id: string;
  label: string;
  command: string;
  args: string[];
  fakeAgent: string;
};

type RecentAgentSession = {
  provider: "opencode" | "codex" | "claude";
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessageText: string;
  initialUserText: string;
  latestUserText: string;
  userMessageCount: number;
  latestAssistantText: string;
  messageCount: number;
  status: "busy" | "idle";
  command: string;
  args: string[];
};

type LaunchSessionInput = {
  command: string;
  args: string[];
  cwd: string;
  fakeAgent: string;
};

type AttachmentUpload = {
  path: string;
  name: string;
  originalName: string;
  type: string;
  size: number;
};

type ComposerAttachment = AttachmentUpload & {
  id: string;
  previewUrl: string;
};

declare global {
  interface Window {
    __tuiuiVoiceTest?: {
      recognizer?: VoiceRecognizer;
      speaker?: VoiceSpeaker;
      minReadbackDelayMs?: number;
      now?: () => number;
    };
  }
}

type StoredChord = {
  id: string;
  binary: ChordBinary;
  label: string;
  sequence: string;
  lastUsedAt: string;
};

const app = document.getElementById("app")!;
let events: EventSource | null = null;
let activeSession: SessionPayload | null = null;
let renderer: "terminal" | "sdk" = "terminal";
let dataEditorView: EditorView | null = null;
let dataEditorKind: "" | "sdk-yaml" | "blocks-json" = "";
let dataEditorDoc = "";
let briefEditorView: EditorView | null = null;
let briefEditorDoc = "";
let eventsPaused = false;
let terminalResizeObserver: ResizeObserver | null = null;
let terminalResizeTimer: number | null = null;
let lastTerminalResizeKey = "";
let xterm: XtermTerminal | null = null;
let xtermFit: FitAddon | null = null;
let xtermReady: Promise<XtermTerminal> | null = null;
let xtermSessionId = "";
let xtermLastStdoutEventId = 0;
let xtermScreenVersion = -1;
let xtermInputQueue = Promise.resolve();
let xtermSyncQueue = Promise.resolve();
let terminalScrollAnimationFrame: number | null = null;
let voiceLoop: VoiceLoop | null = null;
let unsubscribeVoiceLoop: (() => void) | null = null;
let voiceReadbackTimer: number | null = null;
let composerAttachments: ComposerAttachment[] = [];

const terminalHttpLinkHandler: ILinkHandler = {
  activate(event, uri) {
    openTerminalHttpLink(event, uri);
  },
  allowNonHttpProtocols: false,
};

void boot();

window.addEventListener("popstate", () => {
  void renderRoute();
});

async function boot() {
  const config = await loadClientConfig();
  if (config.pageLoadToasts) {
    showPageLoadToast();
  }
  await renderRoute();
}

async function loadClientConfig(): Promise<ClientConfig> {
  try {
    return await api<ClientConfig>("/api/config");
  } catch {
    return { pageLoadToasts: false };
  }
}

function showPageLoadToast() {
  const count = incrementPageLoadCount();
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const kind = navigation && navigation.type ? navigation.type : "load";
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  showToast({
    id: "page-load",
    title: `Page loaded #${count}`,
    message: `${kind} at ${time}`,
    durationMs: 8_000,
    testId: "page-load-toast",
  });
}

function incrementPageLoadCount() {
  const key = "tuiui-page-load-count";
  try {
    const next = Number(localStorage.getItem(key) || "0") + 1;
    localStorage.setItem(key, String(next));
    return next;
  } catch {
    return 1;
  }
}

function setupPromptboxState(sessionId: string, promptbox: HTMLTextAreaElement) {
  const state = useLocalStorageState(promptboxStorageKey(sessionId), "");
  promptbox.value = state.getValue();
  promptbox.addEventListener("input", () => {
    state.setValue(promptbox.value);
  });
}

function setPromptboxValue(promptbox: HTMLTextAreaElement, value: string) {
  promptbox.value = value;
  promptbox.dispatchEvent(new Event("input", { bubbles: true }));
}

function useLocalStorageState(key: string, initialValue: string) {
  let value = initialValue;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      value = stored;
    }
  } catch {
  }

  return {
    getValue() {
      return value;
    },
    setValue(nextValue: string) {
      value = nextValue;
      try {
        if (nextValue) {
          localStorage.setItem(key, nextValue);
        } else {
          localStorage.removeItem(key);
        }
      } catch {
      }
    },
  };
}

function promptboxStorageKey(sessionId: string) {
  return `tuiui-promptbox-${encodeURIComponent(sessionId)}`;
}

async function renderRoute() {
  events?.close();
  events = null;
  eventsPaused = false;
  stopTerminalAutoResize();
  destroyXterm();
  activeSession = null;
  destroyDataEditor();
  unsubscribeVoiceLoop?.();
  unsubscribeVoiceLoop = null;
  voiceLoop = null;
  clearVoiceReadbackTimer();

  const sessionMatch = location.pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    try {
      await renderSession(sessionMatch[1]!);
    } catch (error) {
      await renderMissingSession(sessionMatch[1]!, String(error instanceof Error ? error.message : error));
    }
    return;
  }

  await renderHome();
}

async function renderMissingSession(sessionId: string, message: string) {
  destroyDataEditor();
  const recovery = await fetchSessionRecovery(sessionId);
  app.innerHTML = `
    <main class="layout home-layout">
      <header class="topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted">session unavailable</span>
      </header>
      <section class="launcher missing-session" aria-label="Missing session">
        <strong>${escapeHtml(message)}</strong>
        ${recovery?.recoveryCommand ? `
          <button type="button" class="primary-button recovery-command-button" data-action="recover-session">
            <code>${escapeHtml(recovery.recoveryCommand)}</code>
          </button>
          <code class="missing-session-cwd">${escapeHtml(recovery.cwd)}</code>
        ` : ""}
      </section>
    </main>
  `;
  document.querySelector<HTMLButtonElement>("[data-action='recover-session']")?.addEventListener("click", async () => {
    const result = await api<{ id: string; url: string }>(`/api/sessions/${sessionId}/recover`, { method: "POST" });
    history.pushState({}, "", `/sessions/${result.id}`);
    await renderRoute();
  });
}

async function fetchSessionRecovery(sessionId: string) {
  try {
    return await api<SessionRecoveryPayload>(`/api/sessions/${sessionId}/recovery`);
  } catch {
    return null;
  }
}

async function renderHome() {
  const [cwd, sessions, commands, recentAgentSessions] = await Promise.all([
    api<{ cwd: string; homeDir?: string; homeDirs?: string[] }>("/api/cwd"),
    api<any[]>("/api/sessions"),
    api<CommandPreset[]>("/api/commands"),
    api<RecentAgentSession[]>("/api/agent-sessions/recent"),
  ]);
  const displayHomeDirs = homeDirsForDisplay(cwd);
  const launchCwdState = useLocalStorageState("tuiui-launch-cwd", cwd.cwd);
  const launchCommandOrder = ["codex", "claude", "opencode"];
  const quickLaunchCommands = launchCommandOrder
    .map((id) => commands.find((command) => command.id === id && !command.fakeAgent))
    .filter((command): command is CommandPreset => Boolean(command));

  app.innerHTML = `
    <main class="layout home-layout">
      <header class="topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted" data-testid="session-count">${sessions.length} sessions</span>
      </header>
      <section class="launcher" aria-label="Launch session">
        <form id="launch-form" class="launch-form">
          <div class="launch-command-row">
            <label class="command-prompt-field">
              <span class="command-prompt-glyph" aria-hidden="true">&gt;</span>
              <input name="commandLine" aria-label="Command" autocomplete="off" required placeholder="codex --foo-bar" />
            </label>
            <label class="cwd-field">
              <span aria-hidden="true">cwd</span>
              <input name="cwd" aria-label="Working directory" autocomplete="off" required value="${escapeAttr(launchCwdState.getValue() || cwd.cwd)}" />
            </label>
          </div>
          <div class="quick-launch-row" role="group" aria-label="Shortcuts">
            <div class="quick-launch-buttons">
              ${quickLaunchCommands.map((command) => `
                <button
                  type="button"
                  class="preset-button"
                  data-preset-id="${escapeAttr(command.id)}"
                  aria-label="${escapeAttr(command.command)}"
                  title="${escapeAttr(command.command)}"
                >${escapeHtml(command.command)}</button>
              `).join("")}
            </div>
            <label class="fakeagent-toggle">
              <input name="fakeagent" type="checkbox" aria-label="fakeagent" />
              <span>fakeagent</span>
            </label>
          </div>
        </form>
      </section>
      ${recentAgentSessions.length ? `
        <section class="recent-agents" aria-label="Recent agent sessions">
          <header>
            <strong>Recent Sessions</strong>
            <span>${recentAgentSessions.length} active in 24h</span>
          </header>
          <div class="recent-agents-list">
            ${recentAgentSessions.map((session) => `
              <button
                type="button"
                class="agent-session-button"
                data-agent-session-id="${escapeAttr(`${session.provider}:${session.id}`)}"
                aria-label="${escapeAttr(`Resume ${providerLabel(session.provider)} session ${session.title}`)}"
                title="${escapeAttr([session.command, ...session.args].join(" "))}"
              >
                ${renderRecentSessionTitle(session)}
                ${renderRecentUserPreviewRows(session)}
                <span class="agent-session-preview">
                  <span class="agent-session-preview-label">assistant</span>
                  <span>${escapeHtml(formatRecentSessionLine(session.latestAssistantText, "No assistant message"))}</span>
                </span>
                <span class="agent-session-card-footer">
                  <code>${escapeHtml(formatAgentSessionMeta(session, displayHomeDirs))}</code>
                  <span class="agent-session-card-badges">
                    <span class="agent-session-status" data-state="${escapeAttr(formatRecentSessionStatus(session))}" aria-label="${escapeAttr(`Session ${formatRecentSessionStatus(session)}`)}">
                      <span class="status-dot" data-state="${escapeAttr(formatRecentSessionStatus(session))}" aria-hidden="true"></span>
                      ${escapeHtml(formatRecentSessionStatus(session))}
                    </span>
                    <span class="provider-pill" data-provider="${escapeAttr(session.provider)}">${escapeHtml(providerLabel(session.provider))}</span>
                  </span>
                </span>
              </button>
            `).join("")}
          </div>
        </section>
      ` : ""}
      <section class="sessions" aria-label="Sessions">
        ${sessions.length ? sessions.map(renderSessionLink).join("") : `<p class="empty">No sessions</p>`}
      </section>
    </main>
  `;

  const form = document.getElementById("launch-form") as HTMLFormElement;
  const commandInput = form.elements.namedItem("commandLine") as HTMLInputElement;
  const cwdInput = form.elements.namedItem("cwd") as HTMLInputElement;
  const fakeAgentInput = form.elements.namedItem("fakeagent") as HTMLInputElement;
  const presets = new Map(commands.map((command) => [command.id, command]));
  const recentAgentSessionsByKey = new Map(recentAgentSessions.map((session) => [`${session.provider}:${session.id}`, session]));

  cwdInput.addEventListener("input", () => {
    launchCwdState.setValue(cwdInput.value);
  });
  commandInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void submitLaunchForm();
  });

  for (const button of form.querySelectorAll<HTMLButtonElement>("[data-preset-id]")) {
    button.addEventListener("click", async () => {
      const preset = presets.get(button.dataset.presetId || "");
      if (!preset) {
        return;
      }
      commandInput.value = [preset.command, ...preset.args].join(" ");
      await launchSession({
        command: preset.command,
        args: preset.args,
        cwd: currentLaunchCwd(),
        fakeAgent: fakeAgentForCommand(preset.command),
      });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-agent-session-id]")) {
    button.addEventListener("click", async () => {
      const session = recentAgentSessionsByKey.get(button.dataset.agentSessionId || "");
      if (!session) {
        return;
      }
      commandInput.value = [session.command, ...session.args].join(" ");
      setLaunchCwd(session.cwd || currentLaunchCwd());
      await launchSession({
        command: session.command,
        args: session.args,
        cwd: session.cwd || currentLaunchCwd(),
        fakeAgent: "",
      });
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitLaunchForm();
  });

  async function submitLaunchForm() {
    const commandLine = parseCommandLine(commandInput.value);
    if (!commandLine.command) {
      return;
    }
    await launchSession({
      command: commandLine.command,
      args: commandLine.args,
      cwd: currentLaunchCwd(),
      fakeAgent: fakeAgentForCommand(commandLine.command),
    });
  }

  function currentLaunchCwd() {
    launchCwdState.setValue(cwdInput.value);
    return cwdInput.value;
  }

  function setLaunchCwd(value: string) {
    cwdInput.value = value;
    launchCwdState.setValue(value);
  }

  function fakeAgentForCommand(command: string) {
    if (!fakeAgentInput.checked) {
      return "";
    }
    const binary = command.split(/[\\/]/).pop() || command;
    const fakeCommand = commands.find((candidate) => candidate.fakeAgent && candidate.command === binary);
    return fakeCommand ? fakeCommand.fakeAgent : "";
  }

  async function launchSession(input: LaunchSessionInput) {
    const result = await api<{ id: string; url: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        cols: 120,
        rows: 42,
        env: {},
        fakeAgent: input.fakeAgent,
      }),
    });
    history.pushState({}, "", `/sessions/${result.id}`);
    await renderRoute();
  }
}

async function renderSession(sessionId: string) {
  if (activeSession?.id !== sessionId) {
    renderer = "terminal";
  }
  const payload = await api<SessionPayload>(`/api/sessions/${sessionId}`);
  activeSession = payload;
  const binary = detectChordBinary(payload.command, payload.args, payload.sdk.provider);

  app.innerHTML = `
    <main class="layout session-layout">
      <header class="topbar session-appbar">
        <a class="brand" href="/">tuiui</a>
        <code class="command app-title" title="${escapeAttr([payload.command, ...payload.args].join(" "))}" data-testid="session-command">${escapeHtml(payload.title || payload.command)}</code>
        <span class="status-pill" data-state="${payload.status}" data-testid="session-status">${payload.status}</span>
        <details class="session-menu">
          <summary class="menu-button" role="button" aria-label="Session menu">☰</summary>
          <div class="floating-overlay session-menu-overlay">
            <button type="button" class="floating-overlay-backdrop" data-action="close-session-menu" aria-label="Close session menu"></button>
            <div class="floating-overlay-card menu-panel" role="dialog" aria-label="Session menu">
              <div class="menu-fact">
                <span>CWD</span>
                <code>${escapeHtml(payload.cwd)}</code>
              </div>
              <div class="toolbar" role="group" aria-label="Session controls">
                <button type="button" class="icon-button" data-renderer="terminal" aria-pressed="${renderer === "terminal"}">TTY</button>
                <button type="button" class="icon-button" data-renderer="sdk" aria-pressed="${renderer === "sdk"}">Debug</button>
                <button type="button" class="icon-button" data-action="pause-events" aria-pressed="false">Pause events</button>
                <button type="button" class="icon-button" data-action="relayout">Relayout</button>
              </div>
            </div>
          </div>
        </details>
      </header>
      <section class="main-surface">
        <section id="screen" class="screen" data-testid="semantic-screen"></section>
        <div class="terminal-scroll-controls" aria-label="Terminal scroll controls">
          <button type="button" class="terminal-scroll-button" data-terminal-scroll="-1" aria-label="Scroll terminal up">↑</button>
          <button type="button" class="terminal-scroll-button" data-terminal-scroll="1" aria-label="Scroll terminal down">↓</button>
        </div>
      </section>
      <section class="composer" aria-label="Session input">
        <div id="attachment-preview" class="attachment-preview" data-testid="attachment-preview" aria-live="polite" hidden></div>
        <dialog id="attachment-dialog" class="attachment-dialog" data-testid="attachment-dialog">
          <form method="dialog">
            <button type="submit" class="icon-button attachment-dialog-close" aria-label="Close attachment preview">×</button>
            <div class="attachment-dialog-media">
              <img data-attachment-dialog-image alt="" />
              <span data-attachment-dialog-file hidden>file</span>
            </div>
            <strong data-attachment-dialog-name></strong>
            <code data-attachment-dialog-path></code>
            <div class="attachment-dialog-actions">
              <button type="button" class="secondary-button" data-action="insert-attachment-path">Insert path</button>
              <button type="submit" class="secondary-button">Close</button>
            </div>
          </form>
        </dialog>
        <div class="composer-input-row">
          <textarea id="stdin" data-label="promptbox" aria-label="Send stdin" rows="3" spellcheck="false"></textarea>
          <input id="attachment-file" class="attachment-file-input" type="file" multiple />
          <button type="button" id="attach" class="icon-button composer-attach" aria-label="Attach file" title="Attach file">
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              <path d="M8.5 12.5 14 7a3.2 3.2 0 0 1 4.5 4.5l-7.2 7.2a5 5 0 0 1-7.1-7.1l8.1-8.1a6.8 6.8 0 0 1 9.6 9.6l-8.4 8.4" />
            </svg>
          </button>
        </div>
        <div class="chord-shortcuts" role="group" aria-label="Shortcut chords" data-chord-binary="${escapeAttr(binary)}">
          ${renderChordShortcuts(binary)}
        </div>
        <form id="chord-form" class="floating-overlay chord-panel" aria-label="Add chord" role="dialog" aria-modal="true" hidden>
          <button type="button" class="floating-overlay-backdrop chord-panel-backdrop" data-action="cancel-chord" aria-label="Close add chord"></button>
          <div class="floating-overlay-card chord-panel-card">
            <div class="chord-panel-input-row">
              ${["ctrl+", "shift+", "alt+", "/", "tab", "esc", "backspace", "up", "down", "left", "right"].map((insert) => `
                <button type="button" class="secondary-button" data-chord-insert="${escapeAttr(insert)}">${escapeHtml(formatChordHelper(insert))}</button>
              `).join("")}
            </div>
            <div class="chord-panel-send-row">
              <input name="label" aria-label="Chord label" autocomplete="off" placeholder="Label" />
              <input name="sequence" aria-label="Chord sequence" autocomplete="off" placeholder="esc;esc or /model;enter" required />
              <button type="submit">Save + Send</button>
              <button type="button" class="secondary-button" data-action="cancel-chord">Cancel</button>
            </div>
          </div>
        </form>
        <div class="composer-actions">
          <div class="voice-controls" role="group" aria-label="Voice mode">
            <button type="button" id="voice-talk" class="icon-button voice-talk" aria-label="Push to talk" data-voice-status="idle">Talk</button>
            <button type="button" id="voice-cancel" class="icon-button" aria-label="Cancel listening">Cancel</button>
            <button type="button" id="voice-stop" class="icon-button" aria-label="Cancel speech playback">Audio</button>
            <output id="voice-status" class="voice-status" data-testid="voice-status">Voice ready</output>
          </div>
        </div>
      </section>
    </main>
  `;

  bindSessionControls(sessionId);
  renderSessionPayload(payload);
  subscribe(sessionId);
  refreshSdkForSessionTitle(sessionId, payload);
}

function refreshSdkForSessionTitle(sessionId: string, payload: SessionPayload) {
  if (!payload.sdk.provider) {
    return;
  }
  void refreshSdkPayload(sessionId)
    .then((nextPayload) => {
      if (activeSession?.id === sessionId) {
        renderSessionPayload(nextPayload);
      }
    })
    .catch(() => {
    });
}

function bindSessionControls(sessionId: string) {
  const textarea = document.getElementById("stdin") as HTMLTextAreaElement;
  const sendButton = document.getElementById("send") as HTMLButtonElement;
  const chordForm = document.getElementById("chord-form") as HTMLFormElement;
  setupPromptboxState(sessionId, textarea);
  setupVoiceControls(sessionId, textarea);
  setupAttachmentControls(sessionId, textarea);

  sendButton.addEventListener("click", () => {
    if (!textarea.value) {
      void sendChordSequence(sessionId, "enter", "common-enter");
      return;
    }
    void sendComposer(sessionId);
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      void sendComposer(sessionId);
      return;
    }

    if (textarea.value || textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
      return;
    }

    const key = keyNameFromKeyboardEvent(event);
    if (!key) {
      return;
    }
    event.preventDefault();
    void sendKey(sessionId, key);
  });

  bindChordShortcutControls(sessionId, chordForm);

  document.querySelector<HTMLButtonElement>("[data-action='close-session-menu']")?.addEventListener("click", () => {
    closeSessionMenu();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action='cancel-chord']").forEach((button) => button.addEventListener("click", () => {
    setChordFormOpen(chordForm, false);
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-chord-insert]").forEach((button) => {
    button.addEventListener("click", () => {
      const sequenceInput = chordForm.elements.namedItem("sequence") as HTMLInputElement;
      sequenceInput.value += button.dataset.chordInsert || "";
      sequenceInput.focus();
    });
  });

  chordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const binary = detectChordBinary(activeSession?.command || "", activeSession?.args || [], activeSession?.sdk.provider || "");
    const labelInput = chordForm.elements.namedItem("label") as HTMLInputElement;
    const sequenceInput = chordForm.elements.namedItem("sequence") as HTMLInputElement;
    const sequence = sequenceInput.value.trim();
    if (!sequence) {
      return;
    }
    const chord = saveStoredChord(binary, labelInput.value, sequence);
    refreshChordShortcuts(binary, false);
    labelInput.value = "";
    sequenceInput.value = "";
    setChordFormOpen(chordForm, false);
    void sendChordSequence(sessionId, chord.sequence, chord.id);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-renderer]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextRenderer = button.dataset.renderer;
      renderer = nextRenderer === "sdk" ? "sdk" : "terminal";
      renderSessionPayload(activeSession);
      if (renderer === "sdk") {
        void refreshSdk(sessionId).catch((error) => {
          showRequestErrorToast("Refresh snapshot failed", error, "sdk-refresh-error-toast");
        });
      }
      closeSessionMenu();
    });
  });

  document.querySelector<HTMLButtonElement>("[data-action='pause-events']")?.addEventListener("click", () => {
    setEventsPaused(sessionId, !eventsPaused);
    closeSessionMenu();
  });

  document.querySelector<HTMLButtonElement>("[data-action='relayout']")?.addEventListener("click", () => {
    relayoutTerminal(sessionId);
    closeSessionMenu();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      scrollTerminalByStep(Number(button.dataset.terminalScroll || 0));
    });
  });
}

function setupAttachmentControls(sessionId: string, textarea: HTMLTextAreaElement) {
  const input = document.getElementById("attachment-file") as HTMLInputElement | null;
  const button = document.getElementById("attach") as HTMLButtonElement | null;
  const preview = document.getElementById("attachment-preview") as HTMLElement | null;
  const dialog = document.getElementById("attachment-dialog") as HTMLDialogElement | null;
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!input || !button || !preview || !dialog || !composer) {
    return;
  }

  clearComposerAttachments(preview);
  bindAttachmentDialog(dialog, textarea);

  button.addEventListener("click", () => {
    input.click();
  });

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    void uploadComposerAttachments(sessionId, textarea, preview, button, files, "file");
  });

  textarea.addEventListener("paste", (event) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    void uploadComposerAttachments(sessionId, textarea, preview, button, files, "paste");
  });

  preview.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const remove = target.closest<HTMLElement>("[data-attachment-remove]");
    if (remove) {
      removeComposerAttachment(remove.dataset.attachmentRemove || "", textarea, preview);
      return;
    }
    const open = target.closest<HTMLElement>("[data-attachment-open]");
    if (open) {
      openAttachmentDialog(open.dataset.attachmentOpen || "", dialog);
    }
  });

  composer.addEventListener("dragover", (event) => {
    if (!dragEventHasFiles(event)) {
      return;
    }
    event.preventDefault();
    composer.dataset.attachmentDragging = "true";
  });

  composer.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && composer.contains(event.relatedTarget)) {
      return;
    }
    delete composer.dataset.attachmentDragging;
  });

  composer.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    delete composer.dataset.attachmentDragging;
    void uploadComposerAttachments(sessionId, textarea, preview, button, files, "drop");
  });
}

async function uploadComposerAttachments(
  sessionId: string,
  textarea: HTMLTextAreaElement,
  preview: HTMLElement,
  button: HTMLButtonElement,
  files: File[],
  source: AttachmentSource,
) {
  button.disabled = true;
  try {
    for (const file of files) {
      const upload = await uploadAttachment(sessionId, file, source);
      const attachment: ComposerAttachment = {
        ...upload,
        id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        previewUrl: upload.type.startsWith("image/") ? URL.createObjectURL(file) : "",
      };
      composerAttachments.push(attachment);
      insertAttachmentPath(textarea, attachment.path);
    }
    renderAttachmentPreview(preview, composerAttachments);
  } catch (error) {
    showToast({
      title: "Attachment upload failed",
      message: String(error instanceof Error ? error.message : error),
      tone: "error",
      testId: "attachment-upload-error-toast",
    });
  } finally {
    button.disabled = false;
  }
}

async function uploadAttachment(sessionId: string, file: File, source: AttachmentSource) {
  const body = new FormData();
  body.append("file", file, attachmentUploadName(file, source));
  const response = await fetch(`/api/sessions/${sessionId}/attachments`, {
    method: "POST",
    body,
  });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 404 && message.trim() === "not found") {
      throw new Error("Attachment endpoint is missing on this server. Restart tuiui so the backend route is loaded.");
    }
    throw new Error(message);
  }
  return await response.json() as AttachmentUpload;
}

function renderAttachmentPreview(preview: HTMLElement, attachments: ComposerAttachment[]) {
  preview.hidden = attachments.length === 0;
  preview.innerHTML = attachments.map((attachment) => {
    const label = attachment.originalName || attachment.name;
    if (attachment.previewUrl) {
      return `
        <figure class="attachment-preview-item" data-attachment-id="${escapeAttr(attachment.id)}">
          <button type="button" class="attachment-preview-open" data-attachment-open="${escapeAttr(attachment.id)}" aria-label="Preview ${escapeAttr(label)}">
            <img src="${escapeAttr(attachment.previewUrl)}" alt="${escapeAttr(label)}">
            <figcaption title="${escapeAttr(attachment.path)}">${escapeHtml(label)}</figcaption>
          </button>
          <button type="button" class="attachment-preview-remove" data-attachment-remove="${escapeAttr(attachment.id)}" aria-label="Remove ${escapeAttr(label)}">
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </figure>
      `;
    }

    return `
      <div class="attachment-preview-item file-preview" title="${escapeAttr(attachment.path)}" data-attachment-id="${escapeAttr(attachment.id)}">
        <button type="button" class="attachment-preview-open" data-attachment-open="${escapeAttr(attachment.id)}" aria-label="Preview ${escapeAttr(label)}">
          <span aria-hidden="true">file</span>
          <strong>${escapeHtml(label)}</strong>
        </button>
        <button type="button" class="attachment-preview-remove" data-attachment-remove="${escapeAttr(attachment.id)}" aria-label="Remove ${escapeAttr(label)}">
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
      </div>
    `;
  }).join("");
}

function bindAttachmentDialog(dialog: HTMLDialogElement, textarea: HTMLTextAreaElement) {
  dialog.querySelector<HTMLButtonElement>("[data-action='insert-attachment-path']")?.addEventListener("click", () => {
    const attachment = composerAttachments.find((candidate) => candidate.id === dialog.dataset.attachmentId);
    if (!attachment) {
      return;
    }
    insertAttachmentPath(textarea, attachment.path);
    dialog.close();
  });
}

function openAttachmentDialog(attachmentId: string, dialog: HTMLDialogElement) {
  const attachment = composerAttachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) {
    return;
  }
  const label = attachment.originalName || attachment.name;
  const image = dialog.querySelector<HTMLImageElement>("[data-attachment-dialog-image]");
  const file = dialog.querySelector<HTMLElement>("[data-attachment-dialog-file]");
  const name = dialog.querySelector<HTMLElement>("[data-attachment-dialog-name]");
  const filePath = dialog.querySelector<HTMLElement>("[data-attachment-dialog-path]");
  if (!image || !file || !name || !filePath) {
    return;
  }
  dialog.dataset.attachmentId = attachment.id;
  image.hidden = !attachment.previewUrl;
  image.src = attachment.previewUrl || "";
  image.alt = attachment.previewUrl ? label : "";
  file.hidden = Boolean(attachment.previewUrl);
  name.textContent = label;
  filePath.textContent = attachment.path;
  if (dialog.open) {
    return;
  }
  dialog.showModal();
}

function removeComposerAttachment(id: string, textarea: HTMLTextAreaElement, preview: HTMLElement) {
  const attachment = composerAttachments.find((candidate) => candidate.id === id);
  if (!attachment) {
    return;
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
  composerAttachments = composerAttachments.filter((candidate) => candidate.id !== id);
  setPromptboxValue(textarea, removeAttachmentPathFromText(textarea.value, attachment.path));
  renderAttachmentPreview(preview, composerAttachments);
}

function clearComposerAttachments(preview = document.getElementById("attachment-preview") as HTMLElement | null) {
  for (const attachment of composerAttachments) {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
  composerAttachments = [];
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = "";
  }
  const dialog = document.getElementById("attachment-dialog") as HTMLDialogElement | null;
  if (dialog?.open) {
    dialog.close();
  }
  if (dialog) {
    delete dialog.dataset.attachmentId;
  }
}

function insertAttachmentPath(textarea: HTMLTextAreaElement, filePath: string) {
  if (textarea.value.includes(filePath)) {
    textarea.focus();
    return;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const insertion = `${prefix}${filePath}${suffix}`;
  setPromptboxValue(textarea, `${before}${insertion}${after}`);
  const cursor = before.length + insertion.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.focus();
}

function removeAttachmentPathFromText(text: string, filePath: string) {
  return text
    .replaceAll(filePath, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/g, "");
}

function imageFilesFromClipboard(data: DataTransfer | null) {
  if (!data) {
    return [];
  }

  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  const itemFiles = Array.from(data.items)
    .map((item) => item.kind === "file" ? item.getAsFile() : null)
    .filter((file): file is File => Boolean(file))
    .filter((file) => file.type.startsWith("image/"));

  return dedupeClipboardImageFiles([...files, ...itemFiles]);
}

function dragEventHasFiles(event: DragEvent) {
  const transfer = event.dataTransfer;
  if (!transfer) {
    return false;
  }
  return Array.from(transfer.types).includes("Files");
}

function setupVoiceControls(sessionId: string, textarea: HTMLTextAreaElement) {
  unsubscribeVoiceLoop?.();
  voiceLoop = createVoiceLoop({
    recognizer: window.__tuiuiVoiceTest?.recognizer || createBrowserVoiceRecognizer(),
    speaker: window.__tuiuiVoiceTest?.speaker || createBrowserVoiceSpeaker(),
    now: window.__tuiuiVoiceTest?.now || (() => Date.now()),
    minReadbackDelayMs: Number(window.__tuiuiVoiceTest?.minReadbackDelayMs || 700),
    async sendTranscript(text) {
      setPromptboxValue(textarea, text);
      await api(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        body: JSON.stringify({ text, submit: true }),
      });
      setPromptboxValue(textarea, "");
    },
  });
  unsubscribeVoiceLoop = voiceLoop.subscribe(updateVoiceControls);

  const talk = document.getElementById("voice-talk") as HTMLButtonElement | null;
  const cancel = document.getElementById("voice-cancel") as HTMLButtonElement | null;
  const stop = document.getElementById("voice-stop") as HTMLButtonElement | null;
  if (!talk || !cancel || !stop) {
    return;
  }
  talk.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    voiceLoop?.startListening();
  });
  talk.addEventListener("pointerup", (event) => {
    event.preventDefault();
    voiceLoop?.stopListening();
  });
  talk.addEventListener("pointercancel", () => {
    voiceLoop?.cancelListening();
  });
  talk.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      voiceLoop?.startListening();
    }
  });
  talk.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      voiceLoop?.stopListening();
    }
  });
  cancel.addEventListener("click", () => {
    voiceLoop?.cancelListening();
  });
  stop.addEventListener("click", () => {
    voiceLoop?.stopSpeaking();
  });
}

function updateVoiceControls(state: VoiceLoop["state"]) {
  const controls = document.querySelector<HTMLElement>(".voice-controls");
  const talk = document.getElementById("voice-talk") as HTMLButtonElement | null;
  const cancel = document.getElementById("voice-cancel") as HTMLButtonElement | null;
  const stop = document.getElementById("voice-stop") as HTMLButtonElement | null;
  const status = document.getElementById("voice-status") as HTMLOutputElement | null;
  if (controls) {
    controls.hidden = state.status === "unsupported";
    const actions = controls.closest<HTMLElement>(".composer-actions");
    if (actions) {
      actions.dataset.voiceUnsupported = String(state.status === "unsupported");
    }
  }
  if (talk) {
    talk.disabled = state.status === "unsupported";
    talk.dataset.voiceStatus = state.status;
    talk.setAttribute("aria-pressed", String(state.status === "listening" || state.status === "transcribing"));
  }
  if (cancel) {
    cancel.disabled = state.status !== "listening" && state.status !== "transcribing";
  }
  if (stop) {
    stop.disabled = state.status === "unsupported";
  }
  if (status) {
    status.value = state.transcript ? `${state.message}: ${state.transcript}` : state.message;
    status.textContent = status.value;
  }
}

function closeSessionMenu() {
  document.querySelector<HTMLDetailsElement>(".session-menu")?.removeAttribute("open");
}

async function sendComposer(sessionId: string) {
  const textarea = document.getElementById("stdin") as HTMLTextAreaElement;
  const text = textarea.value;
  setPromptboxValue(textarea, "");
  await api(`/api/sessions/${sessionId}/send`, {
    method: "POST",
    body: JSON.stringify({ text, submit: true }),
  });
  clearComposerAttachments();
  scheduleTerminalResize(sessionId);
}

async function sendKey(sessionId: string, key: string) {
  await api(`/api/sessions/${sessionId}/key`, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

async function sendChordSequence(sessionId: string, sequence: string, chordId: string) {
  const steps = parseChordSteps(sequence);
  for (const step of steps) {
    await api(`/api/sessions/${sessionId}/send`, {
      method: "POST",
      body: JSON.stringify({ text: step.text, submit: step.submit }),
    });
  }
  if (chordId.startsWith("user-")) {
    markStoredChordUsed(chordId);
  }
}

function refreshChordShortcuts(binary: ChordBinary, formOpen: boolean) {
  const container = document.querySelector<HTMLElement>("[aria-label='Shortcut chords']");
  if (!container) {
    return;
  }
  container.innerHTML = renderChordShortcuts(binary);
  const chordForm = document.getElementById("chord-form") as HTMLFormElement | null;
  if (!chordForm) {
    return;
  }
  bindChordShortcutControls(activeSession?.id || "", chordForm);
  setChordFormOpen(chordForm, formOpen);
}

function bindChordShortcutControls(sessionId: string, chordForm: HTMLFormElement) {
  const chordToggle = document.querySelector<HTMLButtonElement>("[data-action='toggle-chord']");
  chordToggle?.addEventListener("click", () => {
    const open = chordForm.hidden;
    setChordFormOpen(chordForm, open);
    if (open && shouldAutoFocusChordInput()) {
      const sequenceInput = chordForm.elements.namedItem("sequence") as HTMLInputElement;
      sequenceInput.focus();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-chord-sequence]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      document.getElementById("stdin")?.blur();
      if (!chordForm.hidden && button.dataset.chordUserDefined === "true") {
        const label = button.dataset.chordLabel || button.textContent || "this chord";
        if (window.confirm(`Delete chord "${label}"?`)) {
          deleteStoredChord(button.dataset.chordId || "");
          const binary = detectChordBinary(activeSession?.command || "", activeSession?.args || [], activeSession?.sdk.provider || "");
          refreshChordShortcuts(binary, true);
        }
        return;
      }
      void sendChordSequence(sessionId, button.dataset.chordSequence || "", button.dataset.chordId || "");
    });
  });
}

function setChordFormOpen(chordForm: HTMLFormElement, open: boolean) {
  chordForm.hidden = !open;
  if (open) {
    const composer = document.querySelector<HTMLElement>(".composer");
    if (composer) {
      chordForm.style.bottom = `${Math.max(0, Math.round(window.innerHeight - composer.getBoundingClientRect().top))}px`;
    }
  } else {
    chordForm.style.bottom = "";
  }
  document.querySelector<HTMLButtonElement>("[data-action='toggle-chord']")?.setAttribute("aria-expanded", String(open));
  const container = document.querySelector<HTMLElement>("[aria-label='Shortcut chords']");
  if (container) {
    container.dataset.managingChords = String(open);
  }
}

function subscribe(sessionId: string) {
  events?.close();
  if (eventsPaused) {
    updatePauseEventsButton();
    return;
  }
  events = new EventSource(`/api/sessions/${sessionId}/events`);
  events.addEventListener("session", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as SessionPayload;
    renderSessionPayload(payload);
  });
  updatePauseEventsButton();
}

function setEventsPaused(sessionId: string, paused: boolean) {
  eventsPaused = paused;
  if (paused) {
    events?.close();
    events = null;
    updatePauseEventsButton();
    return;
  }
  subscribe(sessionId);
}

function updatePauseEventsButton() {
  const button = document.querySelector<HTMLButtonElement>("[data-action='pause-events']");
  if (!button) {
    return;
  }
  button.setAttribute("aria-pressed", String(eventsPaused));
  button.textContent = eventsPaused ? "Resume events" : "Pause events";
}

function renderSessionPayload(
  payload: SessionPayload | null,
  options: { voiceReadbackSnapshotFresh?: boolean } = {},
) {
  if (!payload) {
    return;
  }
  activeSession = payload;
  document.title = `${payload.title || payload.command} · TUI UI`;

  const status = document.querySelector<HTMLElement>("[data-testid='session-status']");
  if (status) {
    status.textContent = payload.status;
    status.dataset.state = payload.status;
  }
  const command = document.querySelector<HTMLElement>("[data-testid='session-command']");
  if (command) {
    command.textContent = payload.title || payload.command;
    command.title = [payload.command, ...payload.args].join(" ");
  }
  document.querySelectorAll<HTMLButtonElement>("[data-renderer]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.renderer === renderer));
  });
  const mainSurface = document.querySelector<HTMLElement>(".main-surface");
  if (mainSurface) {
    mainSurface.dataset.renderer = renderer;
  }

  const screen = document.getElementById("screen")!;
  if (renderer === "terminal") {
    destroyDataEditor();
    renderTerminalScreen(screen, payload);
  } else if (renderer === "sdk") {
    stopTerminalAutoResize();
    destroyXterm();
    renderSdkScreen(screen, payload);
  }

  const stdinLog = document.querySelector<HTMLElement>("[data-testid='stdin-log']");
  if (stdinLog) {
    stdinLog.textContent = payload.stdinEvents.map((event) => `[${formatTime(event.createdAt)}] ${event.text}`).join("\n");
  }
  const stdoutLog = document.querySelector<HTMLElement>("[data-testid='stdout-log']");
  if (stdoutLog) {
    stdoutLog.textContent = payload.stdoutEvents.map((event) => event.displayText ? `[${formatTime(event.createdAt)}] ${event.displayText}` : "").filter(Boolean).join("\n\n");
  }
  if (!shouldDeferVoiceReadbackForProviderRefresh(payload, options)) {
    voiceLoop?.observePayload(payload);
  }
  scheduleVoiceReadbackCheck(payload);
}

function shouldDeferVoiceReadbackForProviderRefresh(
  payload: SessionPayload,
  options: { voiceReadbackSnapshotFresh?: boolean },
) {
  return Boolean(
    voiceLoop?.state.awaitingReadback
      && payload.lifecycle === "running"
      && payload.status === "idle"
      && payload.sdk.provider
      && !options.voiceReadbackSnapshotFresh,
  );
}

function scheduleVoiceReadbackCheck(payload: SessionPayload) {
  if (!voiceLoop?.state.awaitingReadback || payload.lifecycle !== "running") {
    clearVoiceReadbackTimer();
    return;
  }
  if (voiceReadbackTimer !== null) {
    return;
  }
  voiceReadbackTimer = window.setTimeout(() => {
    voiceReadbackTimer = null;
    void refreshVoiceReadbackPayload(payload)
      .catch(() => undefined);
  }, payload.status === "idle" ? 350 : 1_100);
}

async function refreshVoiceReadbackPayload(payload: SessionPayload) {
  if (payload.status === "idle" && payload.sdk.provider) {
    const nextPayload = await refreshSdkPayload(payload.id);
    renderSessionPayload(nextPayload, { voiceReadbackSnapshotFresh: true });
    return;
  }

  const nextPayload = await api<SessionPayload>(`/api/sessions/${payload.id}`);
  renderSessionPayload(nextPayload);
}

function clearVoiceReadbackTimer() {
  if (voiceReadbackTimer === null) {
    return;
  }
  window.clearTimeout(voiceReadbackTimer);
  voiceReadbackTimer = null;
}

function scrollTerminalByStep(direction: number) {
  if (!direction) {
    return;
  }
  if (xterm) {
    smoothScrollXterm(direction * 8);
    return;
  }

  const fallback = document.querySelector<HTMLElement>(".xterm-viewport, .terminal-html");
  if (!fallback) {
    return;
  }
  fallback.scrollBy({
    top: direction * fallback.clientHeight * 0.22,
    behavior: "smooth",
  });
}

function smoothScrollXterm(totalLines: number) {
  cancelTerminalScrollAnimation();
  const direction = Math.sign(totalLines);
  const lineCount = Math.abs(totalLines);
  const durationMs = 170;
  const startedAt = performance.now();
  let appliedLines = 0;

  function tick(now: number) {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    const targetLines = Math.round(lineCount * progress);
    const delta = targetLines - appliedLines;
    if (delta && xterm) {
      xterm.scrollLines(direction * delta);
      appliedLines = targetLines;
    }
    if (progress < 1 && appliedLines < lineCount) {
      terminalScrollAnimationFrame = window.requestAnimationFrame(tick);
      return;
    }
    terminalScrollAnimationFrame = null;
  }

  terminalScrollAnimationFrame = window.requestAnimationFrame(tick);
}

function relayoutTerminal(sessionId: string) {
  if (!activeSession) {
    return;
  }
  renderer = "terminal";
  lastTerminalResizeKey = "";
  destroyXterm();
  renderSessionPayload({
    ...activeSession,
    redrawActive: true,
  });
  scheduleTerminalResize(sessionId);
  window.setTimeout(() => {
    if (activeSession?.id !== sessionId || renderer !== "terminal") {
      return;
    }
    renderSessionPayload({
      ...activeSession,
      redrawActive: false,
    });
  }, 750);
}

function renderTerminalScreen(screen: HTMLElement, payload: SessionPayload) {
  screen.className = "screen terminal-screen";
  if (payload.renderedAnsi === undefined && payload.renderedHtml) {
    destroyXterm();
    screen.innerHTML = `<div class="terminal-html" data-testid="rendered-terminal">${trimTerminalHtmlToRows(payload.renderedHtml, payload.rows)}</div>`;
    startTerminalAutoResize(payload.id);
    return;
  }

  if (!screen.querySelector("#xterm-terminal")) {
    destroyXterm();
    screen.innerHTML = `
      <div class="terminal-xterm-wrap" data-testid="rendered-terminal">
        <div id="xterm-terminal" class="terminal-host"></div>
        <pre class="terminal-text-snapshot" aria-hidden="true"></pre>
        <div class="terminal-redraw-overlay" data-testid="terminal-redraw-overlay" hidden>
          <div class="terminal-redraw-pill" role="status" aria-live="polite">
            <span class="terminal-redraw-spinner" aria-hidden="true"></span>
            <span>Restoring terminal...</span>
          </div>
        </div>
      </div>
    `;
  }

  updateTerminalRedrawOverlay(screen, payload.redrawActive);
  const snapshot = screen.querySelector<HTMLElement>(".terminal-text-snapshot");
  if (snapshot) {
    snapshot.textContent = payload.renderedText;
  }
  xtermSyncQueue = xtermSyncQueue.then(() => syncXterm(payload)).catch(() => undefined);
  startTerminalAutoResize(payload.id);
}

function updateTerminalRedrawOverlay(screen: HTMLElement, active: boolean) {
  const overlay = screen.querySelector<HTMLElement>(".terminal-redraw-overlay");
  if (!overlay) {
    return;
  }
  overlay.hidden = !active;
  overlay.setAttribute("aria-hidden", String(!active));
}

function openTerminalHttpLink(event: MouseEvent, uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }
  event.preventDefault();
  window.open(url.href, "_blank", "noopener,noreferrer");
}

async function ensureXterm(payload: SessionPayload) {
  const host = document.getElementById("xterm-terminal");
  if (!host) {
    return null;
  }
  if (xterm && xtermSessionId === payload.id) {
    return xterm;
  }
  destroyXterm();
  xtermSessionId = payload.id;
  xtermReady = import("@xterm/xterm").then(({ Terminal }) => {
    const term = new Terminal({
      cols: payload.cols,
      rows: payload.rows,
      convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.18,
      theme: {
        background: "#0a0a0a",
        foreground: "#d6deeb",
      },
      allowTransparency: false,
      scrollback: 5000,
      linkHandler: terminalHttpLinkHandler,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(openTerminalHttpLink));
    term.open(host);
    xtermFit = fit;
    term.onData((text) => {
      if (!xtermSessionId) {
        return;
      }
      const sessionId = xtermSessionId;
      xtermInputQueue = xtermInputQueue
        .then(() => api(`/api/sessions/${sessionId}/send`, {
          method: "POST",
          body: JSON.stringify({ text, submit: false }),
        }))
        .then(() => undefined)
        .catch(() => undefined);
    });
    xterm = term;
    return term;
  });
  return await xtermReady;
}

async function syncXterm(payload: SessionPayload) {
  const term = await ensureXterm(payload);
  if (!term || xtermSessionId !== payload.id) {
    return;
  }

  term.resize(payload.cols, payload.rows);
  const newestEvent = payload.stdoutEvents[payload.stdoutEvents.length - 1];
  const newestId = newestEvent ? newestEvent.id : 0;
  if (payload.screenVersion !== xtermScreenVersion) {
    term.reset();
    if (payload.renderedAnsi) {
      await writeXterm(term, payload.renderedAnsi);
    } else {
      await writeXterm(term, payload.renderedText.replaceAll("\n", "\r\n"));
    }
    xtermLastStdoutEventId = payload.snapshotEventId || newestId;
    xtermScreenVersion = payload.screenVersion;
    return;
  }

  if (newestId === 0 || newestId === xtermLastStdoutEventId) {
    return;
  }

  if (newestId < xtermLastStdoutEventId) {
    return;
  }

  const visibleEvents = payload.stdoutEvents.filter((event) => event.id > xtermLastStdoutEventId);
  const events = visibleEvents.length
    ? visibleEvents
    : (await fetchStdoutEvents(payload.id, xtermLastStdoutEventId).catch(() => ({ events: [] }))).events;
  if (xtermSessionId !== payload.id) {
    return;
  }
  for (const event of events) {
    await writeXterm(term, event.chunk);
    xtermLastStdoutEventId = event.id;
  }
}

async function writeXterm(term: XtermTerminal, text: string) {
  await new Promise<void>((resolve) => {
    term.write(text, () => resolve());
  });
}

async function fetchStdoutEvents(sessionId: string, after: number) {
  return await api<{ events: SessionPayload["stdoutEvents"] }>(`/api/sessions/${sessionId}/stdout?after=${after}`);
}

function trimTerminalHtmlToRows(html: string, rows: number) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const wrapper = template.content.querySelector("pre > div");
  if (!wrapper) {
    return html;
  }

  const rowElements = [...wrapper.children];
  const removeCount = Math.max(0, rowElements.length - rows);
  for (const row of rowElements.slice(0, removeCount)) {
    row.remove();
  }

  const pre = template.content.querySelector("pre");
  return pre ? pre.outerHTML : template.innerHTML;
}

function destroyXterm() {
  cancelTerminalScrollAnimation();
  xterm?.dispose();
  xterm = null;
  xtermFit = null;
  xtermReady = null;
  xtermSessionId = "";
  xtermLastStdoutEventId = 0;
  xtermScreenVersion = -1;
  xtermInputQueue = Promise.resolve();
  xtermSyncQueue = Promise.resolve();
}

function cancelTerminalScrollAnimation() {
  if (terminalScrollAnimationFrame === null) {
    return;
  }
  window.cancelAnimationFrame(terminalScrollAnimationFrame);
  terminalScrollAnimationFrame = null;
}

function startTerminalAutoResize(sessionId: string) {
  const screen = document.getElementById("screen");
  if (!screen || terminalResizeObserver) {
    scheduleTerminalResize(sessionId);
    return;
  }
  if (typeof ResizeObserver !== "undefined") {
    terminalResizeObserver = new ResizeObserver(() => {
      scheduleTerminalResize(sessionId);
    });
    terminalResizeObserver.observe(screen);
  } else {
    window.addEventListener("resize", handleWindowTerminalResize);
  }
  scheduleTerminalResize(sessionId);
}

function stopTerminalAutoResize() {
  terminalResizeObserver?.disconnect();
  terminalResizeObserver = null;
  lastTerminalResizeKey = "";
  window.removeEventListener("resize", handleWindowTerminalResize);
  if (terminalResizeTimer !== null) {
    window.clearTimeout(terminalResizeTimer);
    terminalResizeTimer = null;
  }
}

function handleWindowTerminalResize() {
  if (activeSession && renderer === "terminal") {
    scheduleTerminalResize(activeSession.id);
  }
}

function scheduleTerminalResize(sessionId: string) {
  if (renderer !== "terminal") {
    return;
  }
  if (terminalResizeTimer !== null) {
    window.clearTimeout(terminalResizeTimer);
  }
  terminalResizeTimer = window.setTimeout(() => {
    terminalResizeTimer = null;
    void resizeTerminalToScreen(sessionId);
  }, 120);
}

async function resizeTerminalToScreen(sessionId: string) {
  if (composerAttachments.length > 0) {
    return;
  }
  const screen = document.getElementById("screen");
  const terminal = screen?.querySelector<HTMLElement>(".terminal-xterm-wrap, .terminal-html");
  if (!screen || !terminal) {
    return;
  }
  const grid = measureTerminalGrid(screen, terminal);
  if (!grid) {
    return;
  }
  const resizeKey = `${grid.cols}x${grid.rows}`;
  if (resizeKey === lastTerminalResizeKey) {
    return;
  }
  lastTerminalResizeKey = resizeKey;
  await api(`/api/sessions/${sessionId}/resize`, {
    method: "POST",
    body: JSON.stringify(grid),
  });
}

function measureTerminalGrid(screen: HTMLElement, terminal: HTMLElement) {
  const dimensions = xtermFit?.proposeDimensions();
  if (dimensions) {
    return {
      cols: dimensions.cols,
      rows: dimensions.rows,
    };
  }

  const screenStyles = getComputedStyle(screen);
  const terminalStyles = getComputedStyle(terminal);
  const horizontalPadding = parsePixel(screenStyles.paddingLeft) + parsePixel(screenStyles.paddingRight)
    + parsePixel(terminalStyles.paddingLeft) + parsePixel(terminalStyles.paddingRight);
  const verticalPadding = parsePixel(screenStyles.paddingTop) + parsePixel(screenStyles.paddingBottom)
    + parsePixel(terminalStyles.paddingTop) + parsePixel(terminalStyles.paddingBottom);

  const measure = document.createElement("span");
  measure.textContent = "MMMMMMMMMM";
  measure.style.position = "absolute";
  measure.style.visibility = "hidden";
  measure.style.whiteSpace = "pre";
  measure.style.font = terminalStyles.font;
  measure.style.lineHeight = terminalStyles.lineHeight;
  terminal.append(measure);
  const box = measure.getBoundingClientRect();
  measure.remove();

  const cellWidth = box.width / 10;
  const cellHeight = box.height;
  if (!cellWidth || !cellHeight) {
    return null;
  }

  return {
    cols: Math.floor((screen.clientWidth - horizontalPadding) / cellWidth),
    rows: Math.floor((screen.clientHeight - verticalPadding) / cellHeight),
  };
}

function parsePixel(value: string) {
  return Number.parseFloat(value) || 0;
}

function renderSdkScreen(screen: HTMLElement, payload: SessionPayload) {
  screen.className = "screen sdk-screen";

  const sdk = payload.sdk;
  if (!sdk.provider) {
    destroyDataEditor();
    screen.innerHTML = `
      <section class="sdk-panel unavailable" data-testid="sdk-debug">
        <header>
          <strong>No SDK adapter</strong>
          <span>This session is only available through the terminal stream.</span>
        </header>
        ${renderTuishotPreviewMarkup()}
        ${renderDebugHtmlMarkup()}
        ${renderDebugLogsMarkup()}
      </section>
    `;
    updateTuishotPreview(screen, payload);
    updateDebugHtml(screen, payload);
    return;
  }

  const yamlDoc = stringifyYaml(buildSdkYamlData(payload), null, { lineWidth: 0 });
  const existingEditorHost = screen.querySelector("#sdk-yaml-editor");
  if (!existingEditorHost || dataEditorKind !== "sdk-yaml") {
    destroyDataEditor();
    screen.innerHTML = `
      <section class="sdk-panel" data-testid="sdk-debug">
        <header>
          <div>
            <strong><span data-sdk-provider></span> SDK</strong>
            <span data-sdk-base-url></span>
          </div>
          <span class="sdk-state" data-sdk-state></span>
          <button type="button" class="secondary-button" data-action="sdk-refresh">Refresh snapshot</button>
          <button type="button" class="secondary-button" data-action="sdk-summarize">Get session brief</button>
        </header>
        <p class="sdk-error" data-sdk-error hidden></p>
        ${renderTuishotPreviewMarkup()}
        <details class="session-brief" data-testid="session-brief" data-brief-state="empty">
          <summary>
            <span class="sdk-details-summary-row">
              <strong>Session brief</strong>
              <span data-session-brief-state></span>
            </span>
          </summary>
          <div class="session-brief-tabs" role="tablist" aria-label="Session brief view">
            <button type="button" role="tab" class="secondary-button" data-brief-view="rendered" aria-selected="true">Rendered</button>
            <button type="button" role="tab" class="secondary-button" data-brief-view="raw" aria-selected="false">Raw</button>
          </div>
          <div class="session-brief-content" data-session-brief-rendered></div>
          <div class="session-brief-raw" data-session-brief-raw hidden>
            <div id="session-brief-editor" data-testid="session-brief-raw"></div>
          </div>
        </details>
        ${renderDebugHtmlMarkup()}
        ${renderDebugLogsMarkup()}
        <details class="sdk-diagnostics">
          <summary>
            <span class="sdk-details-summary-row">
              <strong>Diagnostics</strong>
            </span>
          </summary>
          <section class="sdk-yaml-panel" aria-label="Provider snapshot diagnostics YAML panel">
            <div id="sdk-yaml-editor" data-testid="sdk-yaml"></div>
          </section>
        </details>
      </section>
    `;

    screen.querySelector<HTMLButtonElement>("[data-action='sdk-refresh']")?.addEventListener("click", () => {
      void refreshSdk(payload.id).catch((error) => {
        showRequestErrorToast("Refresh snapshot failed", error, "sdk-refresh-error-toast");
      });
    });
    screen.querySelector<HTMLButtonElement>("[data-action='sdk-summarize']")?.addEventListener("click", () => {
      void summarizeSdk(payload.id).catch((error) => {
        showRequestErrorToast("Get session brief failed", error, "sdk-summarize-error-toast");
      });
    });
    screen.querySelectorAll<HTMLDetailsElement>(".sdk-panel details").forEach((details) => {
      details.addEventListener("toggle", () => {
        if (details.classList.contains("sdk-diagnostics")) {
          requestAnimationFrame(() => dataEditorView?.requestMeasure());
        }
        if (details.classList.contains("session-brief")) {
          requestAnimationFrame(() => briefEditorView?.requestMeasure());
        }
      });
    });
    bindSessionBriefTabs(screen);
    mountYamlEditor("sdk-yaml-editor", yamlDoc);
  } else {
    updateDataEditorDoc(yamlDoc);
  }
  updateSdkChrome(screen, payload);
  updateTuishotPreview(screen, payload);
  updateSessionBrief(screen, payload);
  updateDebugHtml(screen, payload);
}

function renderTuishotPreviewMarkup() {
  return `
    <details class="tuishot-preview" data-testid="tuishot-preview">
      <summary>
        <span class="sdk-details-summary-row">
          <strong>Tuishot</strong>
          <span data-tuishot-meta></span>
        </span>
      </summary>
      <div class="tuishot-frame">
        <a data-tuishot-link target="_blank" rel="noopener noreferrer" aria-label="Open Tuishot in a new tab">
          <img data-tuishot-image alt="Current terminal view" />
        </a>
      </div>
    </details>
  `;
}

function renderDebugHtmlMarkup() {
  return `
    <details class="debug-html" data-testid="debug-html">
      <summary>
        <span class="sdk-details-summary-row">
          <strong>HTML</strong>
          <span>semantic</span>
        </span>
      </summary>
      <div class="debug-html-content" data-debug-html-rendered></div>
    </details>
  `;
}

function renderDebugLogsMarkup() {
  return `
    <details class="debug-logs" data-testid="debug-logs">
      <summary>
        <span class="sdk-details-summary-row">
          <strong>Logs</strong>
        </span>
      </summary>
      <div class="logs">
        <section>
          <h2>stdin</h2>
          <pre data-testid="stdin-log"></pre>
        </section>
        <section>
          <h2>stdout</h2>
          <pre data-testid="stdout-log"></pre>
        </section>
      </div>
    </details>
  `;
}

function updateDebugHtml(screen: HTMLElement, payload: SessionPayload) {
  const container = screen.querySelector<HTMLElement>("[data-debug-html-rendered]");
  if (!container) {
    return;
  }
  container.innerHTML = renderSemanticScreen(payload.semantic);
}

function updateSdkChrome(screen: HTMLElement, payload: SessionPayload) {
  const sdk = payload.sdk;
  const provider = screen.querySelector<HTMLElement>("[data-sdk-provider]");
  if (provider) {
    provider.textContent = sdk.provider;
  }
  const baseUrl = screen.querySelector<HTMLElement>("[data-sdk-base-url]");
  if (baseUrl) {
    baseUrl.textContent = sdk.baseUrl || "";
  }
  const state = screen.querySelector<HTMLElement>("[data-sdk-state]");
  if (state) {
    state.textContent = sdk.state;
    state.dataset.state = sdk.state;
  }
  const summarize = screen.querySelector<HTMLButtonElement>("[data-action='sdk-summarize']");
  if (summarize) {
    summarize.disabled = sdk.sidecarSummary.status === "running";
  }
  const error = screen.querySelector<HTMLElement>("[data-sdk-error]");
  if (error) {
    error.hidden = !sdk.error;
    error.textContent = sdk.error;
  }
}

function updateTuishotPreview(screen: HTMLElement, payload: SessionPayload) {
  const link = screen.querySelector<HTMLAnchorElement>("[data-tuishot-link]");
  const image = screen.querySelector<HTMLImageElement>("[data-tuishot-image]");
  const meta = screen.querySelector<HTMLElement>("[data-tuishot-meta]");
  if (!link || !image || !meta) {
    return;
  }
  const src = `/api/sessions/${payload.id}/tuishot.svg?updated=${encodeURIComponent(payload.updatedAt)}`;
  if (link.getAttribute("href") !== src) {
    link.href = src;
  }
  if (image.getAttribute("src") !== src) {
    image.src = src;
  }
  image.alt = `Current terminal view for ${payload.title || payload.command}`;
  meta.textContent = `${payload.cols}x${payload.rows}`;
}

function updateSessionBrief(screen: HTMLElement, payload: SessionPayload) {
  const brief = selectSessionBrief(payload.sdk);
  const container = screen.querySelector<HTMLElement>("[data-testid='session-brief']");
  const state = screen.querySelector<HTMLElement>("[data-session-brief-state]");
  const rendered = screen.querySelector<HTMLElement>("[data-session-brief-rendered]");
  if (!container || !state || !rendered) {
    return;
  }

  container.dataset.briefState = brief.state;
  state.textContent = brief.label;
  rendered.innerHTML = renderSessionBriefContent(brief);
  updateSessionBriefEditor(brief.text);
}

function bindSessionBriefTabs(screen: HTMLElement) {
  screen.querySelectorAll<HTMLButtonElement>("[data-brief-view]").forEach((button) => {
    button.addEventListener("click", () => {
      setSessionBriefView(screen, button.dataset.briefView === "raw" ? "raw" : "rendered");
    });
  });
}

function setSessionBriefView(screen: HTMLElement, view: "rendered" | "raw") {
  const rendered = screen.querySelector<HTMLElement>("[data-session-brief-rendered]");
  const raw = screen.querySelector<HTMLElement>("[data-session-brief-raw]");
  if (!rendered || !raw) {
    return;
  }
  rendered.hidden = view !== "rendered";
  raw.hidden = view !== "raw";
  screen.querySelectorAll<HTMLButtonElement>("[data-brief-view]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.briefView === view));
  });
  if (view === "raw") {
    requestAnimationFrame(() => briefEditorView?.requestMeasure());
  }
}

function buildSdkYamlData(payload: SessionPayload) {
  return {
    tuiui: {
      sessionId: payload.id,
      title: payload.title,
      command: [payload.command, ...payload.args].join(" "),
      cwd: payload.cwd,
      lifecycle: payload.lifecycle,
      status: payload.status,
      exitCode: payload.exitCode,
    },
    sdk: {
      provider: payload.sdk.provider || null,
      state: payload.sdk.state,
      baseUrl: payload.sdk.baseUrl || null,
      providerSessionId: payload.sdk.externalSessionId || null,
      providerStatus: payload.sdk.status || null,
      updatedAt: payload.sdk.updatedAt || null,
      error: payload.sdk.error || null,
    },
    sidecarSummary: payload.sdk.sidecarSummary,
    forks: payload.sdk.forks,
    providerData: payload.sdk.summary ? {
      title: payload.sdk.summary.title,
      forkPoint: payload.sdk.summary.forkPoint,
      messageCount: payload.sdk.summary.messageCount,
      diffCount: payload.sdk.summary.diffCount,
      additions: payload.sdk.summary.additions,
      deletions: payload.sdk.summary.deletions,
      latestUserText: payload.sdk.summary.latestUserText,
      latestAssistantText: payload.sdk.summary.latestAssistantText,
      sessionBrief: payload.sdk.summary.sessionBrief,
      transcript: payload.sdk.summary.transcript,
      diffs: payload.sdk.summary.diffs,
    } : null,
  };
}

function selectSessionBrief(sdk: SessionSdkPayload) {
  const currentForkPoint = sdk.summary?.forkPoint || sdk.summary?.transcript.at(-1)?.id || "";
  const completed = sdk.forks
    .filter((fork) => {
      return fork.status === "summarized" &&
        fork.provider === sdk.provider &&
        fork.sourceSessionId === sdk.externalSessionId &&
        Boolean(fork.summary?.latestAssistantText);
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const current = completed.find((fork) => {
    return fork.provider === sdk.provider &&
      fork.sourceSessionId === sdk.externalSessionId &&
      fork.forkPoint === currentForkPoint;
  });
  if (current?.summary?.latestAssistantText) {
    return {
      state: "current",
      label: "current",
      text: current.summary.latestAssistantText,
      structured: current.summary.sessionBrief,
    };
  }
  const stale = completed[0];
  if (stale?.summary?.latestAssistantText) {
    return {
      state: "stale",
      label: "stale",
      text: stale.summary.latestAssistantText,
      structured: stale.summary.sessionBrief,
    };
  }
  if (sdk.sidecarSummary.status === "running") {
    return {
      state: "running",
      label: "running",
      text: "Getting session brief...",
      structured: null,
    };
  }
  if (sdk.sidecarSummary.status === "error") {
    return {
      state: "error",
      label: "error",
      text: sdk.sidecarSummary.error || "Session brief failed.",
      structured: null,
    };
  }
  return {
    state: "empty",
    label: "none",
    text: "No session brief yet.",
    structured: null,
  };
}

function renderSessionBriefContent(brief: ReturnType<typeof selectSessionBrief>) {
  const structured = brief.structured;
  if (!structured || structured.parseErrors.length) {
    return `<pre>${escapeHtml(brief.text)}</pre>`;
  }

  return `
    <div class="brief-section brief-section-primary">
      <strong>Executive summary</strong>
      <p>${escapeHtml(structured.executiveSummary || "No summary provided.")}</p>
    </div>
    <div class="brief-grid">
      ${renderBriefTextSection("Initial request", structured.initialUserRequest)}
      ${renderBriefTextSection("Current state", structured.currentState)}
      ${renderBriefListSection("Completed work", structured.completedWork)}
      ${renderBriefFilesSection(structured.filesChanged)}
      ${renderBriefListSection("Risks / blockers", structured.risksBlockers)}
      ${renderBriefListSection("Suggested next actions", structured.suggestedNextActions)}
    </div>
  `;
}

function renderBriefTextSection(title: string, text: string) {
  return `
    <section class="brief-section">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(text || "None.")}</p>
    </section>
  `;
}

function renderBriefListSection(title: string, items: string[]) {
  return `
    <section class="brief-section">
      <strong>${escapeHtml(title)}</strong>
      ${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>None.</p>"}
    </section>
  `;
}

function renderBriefFilesSection(files: StructuredSessionBrief["filesChanged"]) {
  return `
    <section class="brief-section">
      <strong>Files changed</strong>
      ${files.length ? `<ul>${files.map((file) => `
        <li><code>${escapeHtml(file.path || "(unknown)")}</code>${file.summary ? ` ${escapeHtml(file.summary)}` : ""}</li>
      `).join("")}</ul>` : "<p>None.</p>"}
    </section>
  `;
}

function updateSessionBriefEditor(doc: string) {
  const host = document.getElementById("session-brief-editor");
  if (!host) {
    return;
  }
  if (!briefEditorView) {
    briefEditorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          vsCodeDark,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Session brief raw text" }),
          editorTheme(),
        ],
      }),
    });
    briefEditorDoc = doc;
    return;
  }
  if (briefEditorDoc === doc) {
    return;
  }
  const scrollTop = briefEditorView.scrollDOM.scrollTop;
  const scrollLeft = briefEditorView.scrollDOM.scrollLeft;
  briefEditorView.dispatch({
    changes: {
      from: 0,
      to: briefEditorView.state.doc.length,
      insert: doc,
    },
  });
  briefEditorView.scrollDOM.scrollTop = scrollTop;
  briefEditorView.scrollDOM.scrollLeft = scrollLeft;
  briefEditorDoc = doc;
}

function mountYamlEditor(hostId: string, doc: string) {
  const host = document.getElementById(hostId);
  if (!host) {
    return;
  }
  dataEditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        vsCodeDark,
        yaml(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": "Provider snapshot diagnostics YAML" }),
        editorTheme(),
      ],
    }),
  });
  dataEditorKind = "sdk-yaml";
  dataEditorDoc = doc;
}

function updateDataEditorDoc(doc: string) {
  if (!dataEditorView || dataEditorDoc === doc) {
    return;
  }
  const scrollTop = dataEditorView.scrollDOM.scrollTop;
  const scrollLeft = dataEditorView.scrollDOM.scrollLeft;
  dataEditorView.dispatch({
    changes: {
      from: 0,
      to: dataEditorView.state.doc.length,
      insert: doc,
    },
  });
  dataEditorView.scrollDOM.scrollTop = scrollTop;
  dataEditorView.scrollDOM.scrollLeft = scrollLeft;
  dataEditorDoc = doc;
}

async function refreshSdk(sessionId: string) {
  const payload = await refreshSdkPayload(sessionId);
  renderSessionPayload(payload);
}

async function refreshSdkPayload(sessionId: string) {
  return await api<SessionPayload>(`/api/sessions/${sessionId}/sdk-refresh`, { method: "POST" });
}

async function summarizeSdk(sessionId: string) {
  const payload = await api<SessionPayload>(`/api/sessions/${sessionId}/sdk-summarize`, { method: "POST" });
  renderSessionPayload(payload);
}

function showRequestErrorToast(title: string, error: unknown, testId: string) {
  showToast({
    id: testId,
    title,
    message: String(error instanceof Error ? error.message : error),
    tone: "error",
    durationMs: 10_000,
    testId,
  });
}

function renderBlocksScreen(screen: HTMLElement, model: TerminalBlockModel) {
  destroyDataEditor();
  screen.className = "screen blocks-screen";
  screen.innerHTML = `
    <div class="blocks-layout">
      <section class="blocks-summary" aria-label="Parsed blocks summary">
        <header>
          <strong>${model.blocks.length} blocks</strong>
          <span>${model.cols}x${model.rows} · cursor ${model.cursor.x},${model.cursor.y}</span>
        </header>
        <div class="blocks-list">
          ${model.blocks.map((block) => `
            <article class="block-row" data-kind="${escapeAttr(block.kind)}" data-testid="block-row">
              <strong>${escapeHtml(block.id)}</strong>
              <span>${escapeHtml(block.kind)}</span>
              <code>${block.bounds.x0},${block.bounds.y0} → ${block.bounds.x1},${block.bounds.y1}</code>
              <p>${escapeHtml(block.border?.title || firstLine(block.text) || "(empty)")}</p>
            </article>
          `).join("")}
        </div>
      </section>
      <section class="blocks-json-panel" aria-label="Parsed blocks JSON panel">
        <div id="blocks-json-editor" data-testid="blocks-json"></div>
      </section>
    </div>
  `;

  const host = document.getElementById("blocks-json-editor");
  if (!host) {
    return;
  }
  const jsonDoc = JSON.stringify(model, null, 2);
  dataEditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: jsonDoc,
      extensions: [
        basicSetup,
        vsCodeDark,
        json(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": "Parsed blocks JSON" }),
        editorTheme(),
      ],
    }),
  });
  dataEditorKind = "blocks-json";
  dataEditorDoc = jsonDoc;
}

function editorTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "#0d1014",
      color: "#eef2f7",
      fontSize: "10px",
      lineHeight: "1.35",
    },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    ".cm-content": {
      padding: "6px 0",
    },
    ".cm-line": {
      lineHeight: "1.35",
      padding: "0 8px",
    },
    ".cm-gutters": {
      backgroundColor: "#11161d",
      color: "#748293",
      borderRightColor: "#2c333d",
      lineHeight: "1.35",
    },
    ".cm-gutterElement": {
      lineHeight: "1.35",
      paddingTop: "0 !important",
      paddingBottom: "0 !important",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      minWidth: "32px",
      paddingLeft: "7px !important",
      paddingRight: "7px !important",
    },
    ".cm-foldGutter .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "18px",
    },
    ".cm-foldGutter span": {
      display: "inline-flex",
      alignItems: "center",
      height: "1.35em",
      lineHeight: "1",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#18202a",
    },
    ".cm-activeLine": {
      backgroundColor: "#151d26",
    },
  });
}

function destroyDataEditor() {
  dataEditorView?.destroy();
  dataEditorView = null;
  dataEditorKind = "";
  dataEditorDoc = "";
  briefEditorView?.destroy();
  briefEditorView = null;
  briefEditorDoc = "";
}

function renderSemanticScreen(screen: SemanticScreen) {
  const sections = screen.sections.length
    ? screen.sections
    : [{ id: "raw", kind: "plain", title: "Output", text: screen.rawText, lines: screen.rawText.split("\n"), confidence: 0.3, bounds: { x: 0, y: 0, width: 1, height: 1 } }];

  return `
    <div class="semantic-grid">
      ${sections.map((section) => `
        <article class="semantic-section kind-${escapeAttr(section.kind)}" data-kind="${escapeAttr(section.kind)}" data-testid="semantic-section">
          <header>
            <strong>${escapeHtml(section.title || section.kind)}</strong>
            <span>${escapeHtml(section.kind)}</span>
          </header>
          <pre>${escapeHtml(section.text || section.lines.join("\n"))}</pre>
        </article>
      `).join("")}
    </div>
  `;
}

function formatAgentSessionMeta(session: RecentAgentSession, homeDirs: string[]) {
  const cwd = formatPathForDisplay(session.cwd, homeDirs);
  const time = new Date(session.lastMessageAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${time} - ${cwd} - ${session.messageCount} messages`;
}

function homeDirsForDisplay(input: { cwd: string; homeDir?: string; homeDirs?: string[] }) {
  return [...new Set([
    ...(Array.isArray(input.homeDirs) ? input.homeDirs : []),
    input.homeDir || "",
    inferHomeDir(input.cwd),
  ].filter(Boolean))];
}

function inferHomeDir(value: string) {
  const match = value.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  return match?.[1] || "";
}

function formatPathForDisplay(value: string, homeDirs: string[]) {
  const path = value || "/";
  for (const candidate of homeDirs) {
    const home = candidate.replace(/\/+$/g, "");
    if (path === home) {
      return "~";
    }
    if (path.startsWith(`${home}/`)) {
      return `~${path.slice(home.length)}`;
    }
  }
  return path;
}

function renderRecentSessionTitle(session: RecentAgentSession) {
  const title = session.title || session.id;
  if (!title || textIsBasicallySame(title, session.initialUserText)) {
    return "";
  }
  return `<strong class="agent-session-title">${escapeHtml(title)}</strong>`;
}

function renderRecentUserPreviewRows(session: RecentAgentSession) {
  if (session.userMessageCount > 1 && formatRecentSessionLine(session.latestUserText, "")) {
    return `
      <span class="agent-session-preview">
        <span class="agent-session-preview-label">user (first)</span>
        <span>${escapeHtml(formatRecentSessionLine(session.initialUserText, "No user message"))}</span>
      </span>
      <span class="agent-session-preview">
        <span class="agent-session-preview-label">user (last)</span>
        <span>${escapeHtml(formatRecentSessionLine(session.latestUserText, "No user message"))}</span>
      </span>
    `;
  }
  return `
    <span class="agent-session-preview">
      <span class="agent-session-preview-label">user</span>
      <span>${escapeHtml(formatRecentSessionLine(session.initialUserText || session.latestUserText, "No user message"))}</span>
    </span>
  `;
}

function textIsBasicallySame(left: string, right: string) {
  const leftText = normalizeComparableText(formatRecentSessionLine(left, ""));
  const rightText = normalizeComparableText(formatRecentSessionLine(right, ""));
  if (!leftText || !rightText) {
    return false;
  }
  if (leftText === rightText) {
    return true;
  }
  const shorter = leftText.length < rightText.length ? leftText : rightText;
  const longer = leftText.length < rightText.length ? rightText : leftText;
  return shorter.length >= 24 && longer.startsWith(shorter);
}

function normalizeComparableText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatRecentSessionLine(text: string, empty: string) {
  const firstParagraph = text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean) || "";
  const previewText = firstParagraph
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!previewText) {
    return empty;
  }
  return previewText;
}

function providerLabel(provider: RecentAgentSession["provider"]) {
  if (provider === "opencode") {
    return "OpenCode";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return "Claude";
}

function formatRecentSessionStatus(session: RecentAgentSession) {
  if (session.status === "busy" || session.status === "idle") {
    return session.status;
  }
  const latestAssistant = formatRecentSessionLine(session.latestAssistantText, "");
  const latestUser = formatRecentSessionLine(session.latestUserText, "");
  const lastMessage = formatRecentSessionLine(session.lastMessageText, "");
  return !latestAssistant || lastMessage === latestUser ? "busy" : "idle";
}

function renderSessionLink(session: any) {
  return `
    <a class="session-link" href="/sessions/${escapeAttr(session.id)}">
      <span class="status-dot" data-state="${escapeAttr(session.status)}"></span>
      <span>
        <strong>${escapeHtml(session.title || session.command)}</strong>
        <code>${escapeHtml([session.command, ...session.args].join(" "))}</code>
      </span>
      <time>${escapeHtml(new Date(session.updatedAt).toLocaleTimeString())}</time>
    </a>
  `;
}

function renderChordShortcuts(binary: ChordBinary) {
  const userChords = readStoredChords()
    .filter((chord) => chord.binary === binary)
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, 5);
  const userSequences = new Set(userChords.map((chord) => chord.sequence.toLowerCase()));
  const presetChords = presetsForBinary(binary).filter((preset) => !userSequences.has(preset.sequence.toLowerCase())).slice(0, 9);
  const buttons = [
    ...userChords.map((chord) => renderChordButton({
      id: chord.id,
      label: chord.label,
      sequence: chord.sequence,
      userDefined: true,
    })),
    ...presetChords.map((preset) => renderChordButton({
      id: preset.id,
      label: preset.label,
      sequence: preset.sequence,
      userDefined: false,
    })),
  ];
  return `
    <div class="chord-scroll" data-chord-scroll>
      ${buttons.join("")}
    </div>
    <div class="chord-fixed">
      ${renderChordToggle()}
      ${renderFixedEnterChordButton()}
    </div>
  `;
}

function renderChordButton(input: { id: string; label: string; sequence: string; userDefined: boolean }) {
  const classes = ["secondary-button", "chord-button", input.userDefined ? "user-chord" : "preset-chord"].join(" ");
  const renderedLabel = formatChordButtonLabel(input.label);
  return `
    <button
      type="button"
      class="${escapeAttr(classes)}"
      data-chord-id="${escapeAttr(input.id)}"
      data-chord-sequence="${escapeAttr(input.sequence)}"
      data-chord-label="${escapeAttr(input.label)}"
      data-chord-user-defined="${input.userDefined ? "true" : "false"}"
      aria-label="${escapeAttr(input.label)}"
      title="${escapeAttr(`${input.label}: ${input.sequence}`)}"
    >${escapeHtml(renderedLabel)}</button>
  `;
}

function renderChordToggle() {
  return `<button type="button" class="secondary-button chord-toggle" data-action="toggle-chord" aria-label="Chord" title="Chord" aria-expanded="false">🎹</button>`;
}

function renderFixedEnterChordButton() {
  return `
    <button
      type="button"
      id="send"
      class="chord-button chord-enter"
      aria-label="Send"
      title="Enter"
    >${escapeHtml(formatChordButtonLabel("Enter"))}</button>
  `;
}

function shouldAutoFocusChordInput() {
  return !window.matchMedia("(pointer: coarse), (max-width: 640px)").matches;
}

function formatChordButtonLabel(label: string) {
  return label
    .replace(/\bCtrl[-+ ]?/gi, "^")
    .replace(/\bControl[-+ ]?/gi, "^")
    .replace(/\bShift[-+ ]?/gi, "⇧")
    .replace(/\bAlt[-+ ]?/gi, "⌥")
    .replace(/\bOpt[-+ ]?/gi, "⌥")
    .replace(/\bCmd[-+ ]?/gi, "⌘")
    .replace(/\bMeta[-+ ]?/gi, "⌘")
    .replace(/\bEsc(?:ape)?\b/gi, "esc")
    .replace(/\bTab\b/gi, "⇥")
    .replace(/\bUp\b/gi, "↑")
    .replace(/\bDown\b/gi, "↓")
    .replace(/\bLeft\b/gi, "←")
    .replace(/\bRight\b/gi, "→")
    .replace(/\bEnter\b|\bReturn\b/gi, "↵")
    .replace(/\bBackspace\b|\bBack\b/gi, "⌫");
}

function formatChordHelper(value: string) {
  switch (value) {
    case "ctrl+":
      return "^";
    case "shift+":
      return "⇧";
    case "alt+":
      return "⌥";
    case ";enter":
      return "↵";
    case "tab":
      return "⇥";
    case "esc":
      return "esc";
    case "backspace":
      return "⌫";
    case "up":
      return "↑";
    case "down":
      return "↓";
    case "left":
      return "←";
    case "right":
      return "→";
    default:
      return value;
  }
}

function readStoredChords() {
  try {
    const parsed = JSON.parse(localStorage.getItem("tuiui-user-chords") || "[]") as Partial<StoredChord>[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((chord): chord is StoredChord => {
        return typeof chord.id === "string"
          && isChordBinary(chord.binary)
          && typeof chord.label === "string"
          && typeof chord.sequence === "string"
          && typeof chord.lastUsedAt === "string";
      })
      .slice(0, 50);
  } catch {
    return [];
  }
}

function writeStoredChords(chords: StoredChord[]) {
  localStorage.setItem("tuiui-user-chords", JSON.stringify(chords.slice(0, 50)));
}

function saveStoredChord(binary: ChordBinary, label: string, sequence: string) {
  const now = new Date().toISOString();
  const normalizedSequence = sequence.trim();
  const normalizedLabel = (label.trim() || normalizedSequence).slice(0, 40);
  const existing = readStoredChords().filter((chord) => {
    return !(chord.binary === binary && chord.sequence.toLowerCase() === normalizedSequence.toLowerCase());
  });
  const chord = {
    id: `user-${binary || "common"}-${Date.now().toString(36)}`,
    binary,
    label: normalizedLabel,
    sequence: normalizedSequence,
    lastUsedAt: now,
  };
  writeStoredChords([chord, ...existing]);
  return chord;
}

function markStoredChordUsed(id: string) {
  const chords = readStoredChords();
  const chord = chords.find((item) => item.id === id);
  if (!chord) {
    return;
  }
  chord.lastUsedAt = new Date().toISOString();
  writeStoredChords(chords.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)));
}

function deleteStoredChord(id: string) {
  writeStoredChords(readStoredChords().filter((chord) => chord.id !== id));
}

function isChordBinary(value: unknown): value is ChordBinary {
  return value === "" || value === "codex" || value === "opencode" || value === "claude";
}

function firstLine(text: string) {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function keyNameFromKeyboardEvent(event: KeyboardEvent) {
  if (event.key === "Escape") return "esc";
  if (event.key === "Tab") return "tab";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowLeft") return "left";
  if (event.key === "ArrowRight") return "right";
  if (event.key === "Backspace") return "backspace";
  if (event.ctrlKey && event.key.toLowerCase() === "c") return "ctrl+c";
  return "";
}

async function api<T>(path: string, init: RequestInit = {}) {
  const orpcResult = await callOrpcJsonApi<T>(path, init);
  if (orpcResult.handled) {
    return orpcResult.value;
  }

  // SSE, stdout polling, uploads, and SVG responses stay on the legacy handlers for now.
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const message = await apiErrorMessage(response);
    throw new Error(message);
  }
  return await response.json() as T;
}

async function apiErrorMessage(response: Response) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
  } catch {
  }
  return text;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string) {
  return escapeHtml(value);
}
