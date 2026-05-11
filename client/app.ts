import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vsCodeDark } from "@fsegurai/codemirror-theme-bundle";
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { basicSetup } from "codemirror";
import {
  detectChordBinary,
  parseChordSteps,
  presetsForBinary,
  type ChordBinary,
} from "../src/chords.ts";
import { stringify as stringifyYaml } from "yaml";
import { showToast } from "./toast.ts";

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
  blocks: TerminalBlockModel;
  semantic: SemanticScreen;
  sdk: SessionSdkPayload;
  stdinEvents: Array<{ id: number; text: string; createdAt: string }>;
  stdoutEvents: Array<{ id: number; chunk: string; displayText: string; createdAt: string }>;
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
    transcript: Array<{ id: string; role: string; createdAt: string; text: string }>;
    diffs: Array<{ file: string; additions: number; deletions: number }>;
  };
};

type SidecarSummaryState = {
  implemented: boolean;
  status: "idle" | "running" | "completed" | "error";
  method: "" | "opencode.session.fork+summarize" | "codex.startThread+summary" | "claude.query+forkSession";
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
  messageCount: number;
  command: string;
  args: string[];
};

type LaunchSessionInput = {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  fakeAgent: string;
};

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
let renderer = readRendererPreference();
let dataEditorView: EditorView | null = null;
let dataEditorKind: "" | "sdk-yaml" | "blocks-json" = "";
let dataEditorDoc = "";
let eventsPaused = false;
let terminalResizeObserver: ResizeObserver | null = null;
let terminalResizeTimer: number | null = null;
let lastTerminalResizeKey = "";
let xterm: XtermTerminal | null = null;
let xtermFit: FitAddon | null = null;
let xtermReady: Promise<XtermTerminal> | null = null;
let xtermSessionId = "";
let xtermLastStdoutEventId = 0;
let xtermInputQueue = Promise.resolve();
let xtermSyncQueue = Promise.resolve();
let terminalScrollAnimationFrame: number | null = null;

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

async function renderRoute() {
  events?.close();
  events = null;
  eventsPaused = false;
  stopTerminalAutoResize();
  destroyXterm();
  activeSession = null;
  destroyDataEditor();

  const sessionMatch = location.pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    try {
      await renderSession(sessionMatch[1]!);
    } catch (error) {
      renderMissingSession(String(error instanceof Error ? error.message : error));
    }
    return;
  }

  await renderHome();
}

function renderMissingSession(message: string) {
  destroyDataEditor();
  app.innerHTML = `
    <main class="layout home-layout">
      <header class="topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted">session unavailable</span>
      </header>
      <section class="launcher missing-session" aria-label="Missing session">
        <strong>Session not found</strong>
        <p>${escapeHtml(message)}</p>
        <a href="/">Launch a new session</a>
      </section>
    </main>
  `;
}

function readRendererPreference() {
  const saved = localStorage.getItem("tuiui-renderer") || "";
  return ["terminal", "sdk", "semantic"].includes(saved) ? saved : "terminal";
}

async function renderHome() {
  const [cwd, sessions, commands, recentAgentSessions] = await Promise.all([
    api<{ cwd: string }>("/api/cwd"),
    api<any[]>("/api/sessions"),
    api<CommandPreset[]>("/api/commands"),
    api<RecentAgentSession[]>("/api/agent-sessions/recent"),
  ]);
  const quickLaunchRows = [
    { label: "Real", commands: commands.filter((command) => command.id !== "custom" && !command.fakeAgent) },
    { label: "Fake", commands: commands.filter((command) => Boolean(command.fakeAgent)) },
  ].filter((row) => row.commands.length);

  app.innerHTML = `
    <main class="layout home-layout">
      <header class="topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted" data-testid="session-count">${sessions.length} sessions</span>
      </header>
      <section class="launcher" aria-label="Launch session">
        <form id="launch-form" class="launch-form">
          <div class="quick-launch" role="group" aria-label="Quick launch">
            ${quickLaunchRows.map((row) => `
              <div class="quick-launch-row" role="group" aria-label="${escapeAttr(`${row.label} presets`)}">
                <span class="quick-launch-label">${escapeHtml(row.label)}</span>
                <div class="quick-launch-buttons">
                  ${row.commands.map((command) => `
                    <button
                      type="button"
                      class="preset-button"
                      data-preset-id="${escapeAttr(command.id)}"
                      aria-label="${escapeAttr(command.label)}"
                      title="${escapeAttr([command.command, ...command.args].join(" "))}"
                    >${escapeHtml(row.label === "Fake" ? command.label.replace(/^Fake /, "") : command.label)}</button>
                  `).join("")}
                </div>
              </div>
            `).join("")}
          </div>
          <label>
            <span>Command</span>
            <input name="command" aria-label="Command" autocomplete="off" required />
          </label>
          <label>
            <span>Args</span>
            <input name="args" aria-label="Arguments" autocomplete="off" />
          </label>
          <label class="wide">
            <span>Working directory</span>
            <input name="cwd" aria-label="Working directory" autocomplete="off" required value="${escapeAttr(cwd.cwd)}" />
          </label>
          <label>
            <span>Columns</span>
            <input name="cols" aria-label="Columns" type="number" min="60" max="220" value="120" required />
          </label>
          <button type="submit">Launch</button>
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
                <strong>
                  <span class="provider-pill" data-provider="${escapeAttr(session.provider)}">${escapeHtml(providerLabel(session.provider))}</span>
                  <span>${escapeHtml(session.title || session.id)}</span>
                </strong>
                <span>${escapeHtml(session.lastMessageText || "No message text")}</span>
                <code>${escapeHtml(formatAgentSessionMeta(session))}</code>
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
  const commandInput = form.elements.namedItem("command") as HTMLInputElement;
  const argsInput = form.elements.namedItem("args") as HTMLInputElement;
  const presets = new Map(commands.map((command) => [command.id, command]));
  const recentAgentSessionsByKey = new Map(recentAgentSessions.map((session) => [`${session.provider}:${session.id}`, session]));

  for (const button of form.querySelectorAll<HTMLButtonElement>("[data-preset-id]")) {
    button.addEventListener("click", async () => {
      const preset = presets.get(button.dataset.presetId || "");
      if (!preset) {
        return;
      }
      commandInput.value = preset.command;
      argsInput.value = preset.args.join(" ");
      await launchSession({
        command: preset.command,
        args: preset.args,
        cwd: currentLaunchCwd(),
        cols: currentLaunchCols(),
        fakeAgent: preset.fakeAgent,
      });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-agent-session-id]")) {
    button.addEventListener("click", async () => {
      const session = recentAgentSessionsByKey.get(button.dataset.agentSessionId || "");
      if (!session) {
        return;
      }
      commandInput.value = session.command;
      argsInput.value = session.args.join(" ");
      await launchSession({
        command: session.command,
        args: session.args,
        cwd: session.cwd || currentLaunchCwd(),
        cols: currentLaunchCols(),
        fakeAgent: "",
      });
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await launchSession({
      command: commandInput.value,
      args: parseArgs(argsInput.value),
      cwd: currentLaunchCwd(),
      cols: currentLaunchCols(),
      fakeAgent: "",
    });
  });

  function currentLaunchCwd() {
    const data = new FormData(form);
    return String(data.get("cwd") || "");
  }

  function currentLaunchCols() {
    const data = new FormData(form);
    return Number(data.get("cols") || 120);
  }

  async function launchSession(input: LaunchSessionInput) {
    const result = await api<{ id: string; url: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        cols: input.cols,
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
          <div class="menu-panel">
            <div class="menu-fact">
              <span>CWD</span>
              <code>${escapeHtml(payload.cwd)}</code>
            </div>
            <div class="toolbar" role="group" aria-label="Renderer">
              <button type="button" class="icon-button" data-renderer="terminal" aria-pressed="${renderer === "terminal"}">TTY</button>
              <button type="button" class="icon-button" data-renderer="sdk" aria-pressed="${renderer === "sdk"}">Summary</button>
              <button type="button" class="icon-button" data-renderer="semantic" aria-pressed="${renderer === "semantic"}">HTML</button>
              <button type="button" class="icon-button" data-action="pause-events" aria-pressed="false">Pause events</button>
              <button type="button" class="icon-button" data-action="logs" aria-expanded="false">Logs</button>
              <button type="button" class="icon-button danger" data-action="kill">Stop</button>
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
        <aside id="logs" class="logs" hidden>
          <section>
            <h2>stdin</h2>
            <pre data-testid="stdin-log"></pre>
          </section>
          <section>
            <h2>stdout</h2>
            <pre data-testid="stdout-log"></pre>
          </section>
        </aside>
      </section>
      <section class="composer" aria-label="Session input">
        <textarea id="stdin" aria-label="Send stdin" rows="3" spellcheck="false"></textarea>
        <div class="chord-shortcuts" role="group" aria-label="Shortcut chords" data-chord-binary="${escapeAttr(binary)}">
          ${renderChordShortcuts(binary)}
        </div>
        <form id="chord-form" class="chord-panel" aria-label="Create chord" hidden>
          <div class="chord-panel-input-row">
            ${["ctrl+", "shift+", "alt+", "/", "tab", "esc", ";enter", "backspace", "up", "down", "left", "right"].map((insert) => `
              <button type="button" class="secondary-button" data-chord-insert="${escapeAttr(insert)}">${escapeHtml(formatChordHelper(insert))}</button>
            `).join("")}
          </div>
          <div class="chord-panel-send-row">
            <input name="label" aria-label="Chord label" autocomplete="off" placeholder="Label" />
            <input name="sequence" aria-label="Chord sequence" autocomplete="off" placeholder="esc;esc or /model;enter" required />
            <button type="submit">Save + Send</button>
            <button type="button" class="secondary-button" data-action="cancel-chord">Cancel</button>
          </div>
        </form>
        <div class="composer-actions">
          <div class="keys" role="group" aria-label="Keys">
            ${renderKeyButton("esc", "Esc")}
            ${renderKeyButton("tab", "Tab")}
            ${renderKeyButton("up", "↑")}
            ${renderKeyButton("down", "↓")}
            ${renderKeyButton("left", "←", "overflow-key")}
            ${renderKeyButton("right", "→", "overflow-key")}
            ${renderKeyButton("ctrl+c", "^C", "overflow-key")}
            <details class="key-overflow">
              <summary class="icon-button key-more" role="button" aria-label="More keys">...</summary>
              <div class="key-overflow-panel">
                ${renderKeyButton("left", "←")}
                ${renderKeyButton("right", "→")}
                ${renderKeyButton("ctrl+c", "^C")}
              </div>
            </details>
          </div>
          <button type="button" class="secondary-button" data-action="toggle-chord" aria-expanded="false">Chord</button>
          <button type="button" id="send" aria-label="Send" title="Send">
            <span aria-hidden="true">↵</span>
          </button>
        </div>
      </section>
    </main>
  `;

  bindSessionControls(sessionId);
  renderSessionPayload(payload);
  subscribe(sessionId);
}

function bindSessionControls(sessionId: string) {
  const textarea = document.getElementById("stdin") as HTMLTextAreaElement;
  const sendButton = document.getElementById("send") as HTMLButtonElement;
  const chordForm = document.getElementById("chord-form") as HTMLFormElement;
  const chordToggle = document.querySelector<HTMLButtonElement>("[data-action='toggle-chord']")!;

  sendButton.addEventListener("click", () => {
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

  document.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      textarea.blur();
      void sendKey(sessionId, button.dataset.key || "");
    });
  });

  chordToggle.addEventListener("click", () => {
    const nextHidden = !chordForm.hidden;
    chordForm.hidden = nextHidden;
    chordToggle.setAttribute("aria-expanded", String(!nextHidden));
    if (!nextHidden) {
      const sequenceInput = chordForm.elements.namedItem("sequence") as HTMLInputElement;
      sequenceInput.focus();
    }
  });

  document.querySelector<HTMLButtonElement>("[data-action='cancel-chord']")?.addEventListener("click", () => {
    chordForm.hidden = true;
    chordToggle.setAttribute("aria-expanded", "false");
  });

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
    refreshChordShortcuts(binary);
    labelInput.value = "";
    sequenceInput.value = "";
    chordForm.hidden = true;
    chordToggle.setAttribute("aria-expanded", "false");
    void sendChordSequence(sessionId, chord.sequence, chord.id);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-chord-sequence]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      textarea.blur();
      void sendChordSequence(sessionId, button.dataset.chordSequence || "", button.dataset.chordId || "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-renderer]").forEach((button) => {
    button.addEventListener("click", () => {
      renderer = button.dataset.renderer || "semantic";
      localStorage.setItem("tuiui-renderer", renderer);
      renderSessionPayload(activeSession);
      closeSessionMenu();
    });
  });

  document.querySelector<HTMLButtonElement>("[data-action='logs']")?.addEventListener("click", (event) => {
    const logs = document.getElementById("logs")!;
    logs.hidden = !logs.hidden;
    (event.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(!logs.hidden));
    closeSessionMenu();
  });

  document.querySelector<HTMLButtonElement>("[data-action='pause-events']")?.addEventListener("click", () => {
    setEventsPaused(sessionId, !eventsPaused);
    closeSessionMenu();
  });

  document.querySelector<HTMLButtonElement>("[data-action='kill']")?.addEventListener("click", () => {
    void api(`/api/sessions/${sessionId}/kill`, { method: "POST" });
    closeSessionMenu();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      scrollTerminalByStep(Number(button.dataset.terminalScroll || 0));
    });
  });
}

function closeSessionMenu() {
  document.querySelector<HTMLDetailsElement>(".session-menu")?.removeAttribute("open");
}

async function sendComposer(sessionId: string) {
  const textarea = document.getElementById("stdin") as HTMLTextAreaElement;
  const text = textarea.value;
  textarea.value = "";
  await api(`/api/sessions/${sessionId}/send`, {
    method: "POST",
    body: JSON.stringify({ text, submit: true }),
  });
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

function refreshChordShortcuts(binary: ChordBinary) {
  const container = document.querySelector<HTMLElement>("[aria-label='Shortcut chords']");
  if (!container) {
    return;
  }
  container.innerHTML = renderChordShortcuts(binary);
  document.querySelectorAll<HTMLButtonElement>("[data-chord-sequence]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      document.getElementById("stdin")?.blur();
      void sendChordSequence(activeSession?.id || "", button.dataset.chordSequence || "", button.dataset.chordId || "");
    });
  });
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

function renderSessionPayload(payload: SessionPayload | null) {
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
  } else {
    stopTerminalAutoResize();
    destroyXterm();
    destroyDataEditor();
    screen.className = "screen semantic-screen";
    screen.innerHTML = renderSemanticScreen(payload.semantic);
  }

  const stdinLog = document.querySelector<HTMLElement>("[data-testid='stdin-log']");
  if (stdinLog) {
    stdinLog.textContent = payload.stdinEvents.map((event) => `[${formatTime(event.createdAt)}] ${event.text}`).join("\n");
  }
  const stdoutLog = document.querySelector<HTMLElement>("[data-testid='stdout-log']");
  if (stdoutLog) {
    stdoutLog.textContent = payload.stdoutEvents.map((event) => event.displayText ? `[${formatTime(event.createdAt)}] ${event.displayText}` : "").filter(Boolean).join("\n\n");
  }
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
      </div>
    `;
  }

  const snapshot = screen.querySelector<HTMLElement>(".terminal-text-snapshot");
  if (snapshot) {
    snapshot.textContent = payload.renderedText;
  }
  xtermSyncQueue = xtermSyncQueue.then(() => syncXterm(payload)).catch(() => undefined);
  startTerminalAutoResize(payload.id);
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
  if (xtermLastStdoutEventId === 0 || newestId < xtermLastStdoutEventId) {
    term.reset();
    if (payload.renderedAnsi) {
      await writeXterm(term, payload.renderedAnsi);
      xtermLastStdoutEventId = newestId;
      return;
    }
    await writeXterm(term, payload.renderedText.replaceAll("\n", "\r\n"));
    xtermLastStdoutEventId = newestId;
    return;
  }

  if (newestId === xtermLastStdoutEventId) {
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
      <section class="sdk-panel unavailable" data-testid="sdk-summary">
        <header>
          <strong>No SDK adapter</strong>
          <span>This session is only available through the terminal stream.</span>
        </header>
        ${renderTuishotPreviewMarkup()}
      </section>
    `;
    updateTuishotPreview(screen, payload);
    return;
  }

  const yamlDoc = stringifyYaml(buildSdkYamlData(payload), null, { lineWidth: 0 });
  const existingEditorHost = screen.querySelector("#sdk-yaml-editor");
  if (!existingEditorHost || dataEditorKind !== "sdk-yaml") {
    destroyDataEditor();
    screen.innerHTML = `
      <section class="sdk-panel" data-testid="sdk-summary">
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
        <section class="session-brief" data-testid="session-brief" data-brief-state="empty">
          <header>
            <strong>Session brief</strong>
            <span data-session-brief-state></span>
          </header>
          <pre data-session-brief-markdown></pre>
        </section>
        <details class="sdk-diagnostics">
          <summary>Diagnostics</summary>
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
    screen.querySelector<HTMLDetailsElement>(".sdk-diagnostics")?.addEventListener("toggle", () => {
      dataEditorView?.requestMeasure();
    });
    mountYamlEditor("sdk-yaml-editor", yamlDoc);
  } else {
    updateDataEditorDoc(yamlDoc);
  }
  updateSdkChrome(screen, payload);
  updateTuishotPreview(screen, payload);
  updateSessionBrief(screen, payload);
}

function renderTuishotPreviewMarkup() {
  return `
    <section class="tuishot-preview" data-testid="tuishot-preview">
      <header>
        <strong>Tuishot</strong>
        <span data-tuishot-meta></span>
      </header>
      <div class="tuishot-frame">
        <img data-tuishot-image alt="Current terminal view" />
      </div>
    </section>
  `;
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
  const image = screen.querySelector<HTMLImageElement>("[data-tuishot-image]");
  const meta = screen.querySelector<HTMLElement>("[data-tuishot-meta]");
  if (!image || !meta) {
    return;
  }
  const src = `/api/sessions/${payload.id}/tuishot.svg?updated=${encodeURIComponent(payload.updatedAt)}`;
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
  const markdown = screen.querySelector<HTMLElement>("[data-session-brief-markdown]");
  if (!container || !state || !markdown) {
    return;
  }

  container.dataset.briefState = brief.state;
  state.textContent = brief.label;
  markdown.textContent = brief.markdown;
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
      markdown: current.summary.latestAssistantText,
    };
  }
  const stale = completed[0];
  if (stale?.summary?.latestAssistantText) {
    return {
      state: "stale",
      label: "stale",
      markdown: stale.summary.latestAssistantText,
    };
  }
  if (sdk.sidecarSummary.status === "running") {
    return {
      state: "running",
      label: "running",
      markdown: "Getting session brief...",
    };
  }
  if (sdk.sidecarSummary.status === "error") {
    return {
      state: "error",
      label: "error",
      markdown: sdk.sidecarSummary.error || "Session brief failed.",
    };
  }
  return {
    state: "empty",
    label: "none",
    markdown: "No session brief yet.",
  };
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
  const payload = await api<SessionPayload>(`/api/sessions/${sessionId}/sdk-refresh`, { method: "POST" });
  renderSessionPayload(payload);
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

function formatAgentSessionMeta(session: RecentAgentSession) {
  const cwd = session.cwd.split("/").filter(Boolean).at(-1) || session.cwd || "/";
  const time = new Date(session.lastMessageAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${time} - ${cwd} - ${session.messageCount} messages`;
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

function renderKeyButton(key: string, label: string, className = "") {
  const classes = ["icon-button", "key-button", className].filter(Boolean).join(" ");
  return `<button type="button" class="${escapeAttr(classes)}" data-key="${escapeAttr(key)}" aria-label="${escapeAttr(key)}">${escapeHtml(label)}</button>`;
}

function renderChordShortcuts(binary: ChordBinary) {
  const userChords = readStoredChords()
    .filter((chord) => chord.binary === binary)
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, 5);
  const userSequences = new Set(userChords.map((chord) => chord.sequence.toLowerCase()));
  const presetChords = presetsForBinary(binary).filter((preset) => !userSequences.has(preset.sequence.toLowerCase())).slice(0, 8);
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
  return buttons.join("");
}

function renderChordButton(input: { id: string; label: string; sequence: string; userDefined: boolean }) {
  const classes = ["secondary-button", "chord-button", input.userDefined ? "user-chord" : "preset-chord"].join(" ");
  return `
    <button
      type="button"
      class="${escapeAttr(classes)}"
      data-chord-id="${escapeAttr(input.id)}"
      data-chord-sequence="${escapeAttr(input.sequence)}"
      title="${escapeAttr(input.sequence)}"
    >${escapeHtml(input.label)}</button>
  `;
}

function formatChordHelper(value: string) {
  switch (value) {
    case ";enter":
      return "Enter";
    case "backspace":
      return "Back";
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

function parseArgs(input: string) {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json() as T;
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
