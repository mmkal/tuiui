import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { githubDark, vsCodeDark } from "@fsegurai/codemirror-theme-bundle";
import jsonata from "@mmkal/jsonata/sync";
import { FileTree } from "@pierre/trees";
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
import { clientApi } from "./orpc-client.ts";
import {
  BrowserIdleNotifications,
  type IdleNotificationNativeApi,
  type IdleNotificationSession,
} from "./idle-notifications.ts";
import { showToast } from "./toast.ts";
import {
  createPreferredBrowserVoiceRecognizer,
  createBrowserVoiceRecognizer,
  createBrowserVoiceSpeaker,
  createVoiceLoop,
  type VoiceLoop,
  type VoiceRecognizer,
  type VoiceSpeaker,
} from "./voice.ts";
import {
  factoryRecentSessionKey,
  renderFactoryFloorOverview,
  type FactoryFloorRecentSession,
} from "./factory-floor.ts";

type SessionPayload = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  archivedAtMs: number | null;
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
  archivedAtMs: number | null;
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
  coordinator?: boolean;
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

type RecentSessionGroupDefinition = {
  expression: string;
  lineNumber: number;
  compiled: {
    evaluate(input: any): any;
  };
};

type RecentSessionGroupParseResult = {
  definitions: RecentSessionGroupDefinition[];
  error: string;
};

type RecentSessionGroupRenderResult = {
  html: string;
  error: string;
};

type RecentSessionGroup = {
  name: string;
  sessions: RecentAgentSession[];
  children: RecentSessionGroup[];
};

type SessionListItem = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  updatedAt: string;
  lifecycle: "running" | "exited";
  status: "busy" | "idle" | "exited";
};

type LaunchSessionInput = {
  command: string;
  args: string[];
  cwd: string;
  fakeAgent: string;
  coordinator?: boolean;
};

type SessionFileTreePayload = {
  cwd: string;
  paths: string[];
  truncated: boolean;
  entryCount: number;
  maxEntries: number;
  ignoredNames: string[];
};

type SessionFileContentPayload = {
  cwd: string;
  path: string;
  name: string;
  kind: "text" | "binary" | "too-large";
  content: string;
  size: number;
  limit: number;
  updatedAt: string;
  message: string;
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
let dataEditorKind: "" | "sdk-yaml" | "blocks-json" | "file-text" = "";
let dataEditorDoc = "";
let fileEditorLanguageKey = "";
let briefEditorView: EditorView | null = null;
let briefEditorDoc = "";
let ideFileTree: FileTree | null = null;
let ideFileTreeCwd = "";
let ideFileTreeLoadingCwd = "";
let ideSelectedFilePath = "";
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
let sessionIdleRefreshTimer: number | null = null;
let homeIdleNotificationPollTimer: number | null = null;
let homeIdleNotificationDisplayDirs: string[] = [];

const terminalFontSizeStorageKey = "tuiui-terminal-font-size";
const terminalFontSizeSteps = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const recentSessionGroupStorageKey = "tuiui-recent-session-groups";
let terminalFontSize = readTerminalFontSize();

const idleNotifications = new BrowserIdleNotifications({
  storage: window.localStorage,
  notifications: nativeIdleNotificationApi(),
  showToast,
  openRoute: openIdleNotificationRoute,
});

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
  applyTerminalFontSize();
  const config = await loadClientConfig();
  if (config.pageLoadToasts) {
    showPageLoadToast();
  }
  await renderRoute();
}

async function loadClientConfig(): Promise<ClientConfig> {
  try {
    return await clientApi.config();
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

function nativeIdleNotificationApi(): IdleNotificationNativeApi | null {
  if (!("Notification" in window) || !window.Notification) {
    return null;
  }
  return {
    get permission() {
      return window.Notification.permission;
    },
    async requestPermission() {
      return await window.Notification.requestPermission();
    },
    create(title: string, options: NotificationOptions) {
      return new window.Notification(title, options);
    },
  };
}

function openIdleNotificationRoute(path: string) {
  window.focus();
  if (!path || location.pathname === path) {
    return;
  }
  history.pushState({}, "", path);
  void renderRoute();
}

function bindClientRouteLink(link: HTMLAnchorElement, path: string) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (location.pathname === path) {
      return;
    }
    history.pushState({}, "", path);
    void renderRoute();
  });
}

function renderIdleNotificationControl() {
  const state = idleNotifications.getControlState();
  return `
    <button
      type="button"
      class="idle-notification-toggle"
      data-action="toggle-idle-notifications"
      data-testid="idle-notification-toggle"
      data-notification-permission="${escapeAttr(state.permission)}"
      aria-pressed="${state.enabled}"
      aria-label="${escapeAttr(state.label)}"
      title="${escapeAttr(state.description)}"
    >${idleNotificationControlIcon(state.enabled)}</button>
  `;
}

function idleNotificationControlIcon(enabled: boolean) {
  return enabled ? "🔔" : "🔕";
}

function bindIdleNotificationControls() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action='toggle-idle-notifications']")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const current = idleNotifications.getControlState();
        const next = current.enabled && current.permission !== "default"
          ? disableIdleNotifications()
          : await enableIdleNotificationsFromControl();
        updateIdleNotificationControls();
        showIdleNotificationControlToast(next);
      } finally {
        button.disabled = false;
      }
    });
  }
  updateIdleNotificationControls();
}

async function enableIdleNotificationsFromControl() {
  const next = await idleNotifications.enableFromUserGesture();
  await primeIdleNotificationSnapshotForCurrentRoute();
  startIdleNotificationPollingForCurrentRoute();
  return next;
}

function disableIdleNotifications() {
  const next = idleNotifications.disable();
  stopHomeIdleNotificationPolling();
  clearSessionIdleRefreshTimer();
  return next;
}

function updateIdleNotificationControls() {
  const state = idleNotifications.getControlState();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action='toggle-idle-notifications']")) {
    button.textContent = idleNotificationControlIcon(state.enabled);
    button.title = state.description;
    button.dataset.notificationPermission = state.permission;
    button.setAttribute("aria-pressed", String(state.enabled));
    button.setAttribute("aria-label", state.label);
  }
}

function showIdleNotificationControlToast(state: ReturnType<BrowserIdleNotifications["getControlState"]>) {
  showToast({
    id: "idle-notification-control",
    title: state.enabled ? "Idle alerts enabled" : "Idle alerts disabled",
    message: state.description,
    durationMs: 4_000,
  });
}

function observeHomeIdleNotificationSessions(
  sessions: SessionListItem[],
  recentAgentSessions: RecentAgentSession[],
  displayHomeDirs: string[],
) {
  idleNotifications.observe([
    ...sessions.map((session) => sessionListItemIdleNotification(session, displayHomeDirs)),
    ...recentAgentSessions.map((session) => recentAgentSessionIdleNotification(session, displayHomeDirs)),
  ]);
}

function startHomeIdleNotificationPolling(displayHomeDirs: string[]) {
  stopHomeIdleNotificationPolling();
  if (!idleNotifications.isEnabled()) {
    return;
  }
  homeIdleNotificationPollTimer = window.setInterval(() => {
    void pollHomeIdleNotificationSessions(displayHomeDirs);
  }, 5_000);
}

function stopHomeIdleNotificationPolling() {
  if (homeIdleNotificationPollTimer === null) {
    return;
  }
  window.clearInterval(homeIdleNotificationPollTimer);
  homeIdleNotificationPollTimer = null;
}

async function pollHomeIdleNotificationSessions(displayHomeDirs: string[]) {
  if (!idleNotifications.isEnabled()) {
    stopHomeIdleNotificationPolling();
    return;
  }
  try {
    const [sessions, recentAgentSessions] = await Promise.all([
      clientApi.sessions.list(),
      clientApi.agentSessions.recent(),
    ]);
    observeHomeIdleNotificationSessions(sessions, recentAgentSessions, displayHomeDirs);
  } catch {
  }
}

function scheduleSessionIdleRefresh(payload: SessionPayload) {
  clearSessionIdleRefreshTimer();
  if (!idleNotifications.isEnabled() || payload.lifecycle !== "running" || payload.status !== "busy") {
    return;
  }
  sessionIdleRefreshTimer = window.setTimeout(() => {
    sessionIdleRefreshTimer = null;
    if (!idleNotifications.isEnabled() || activeSession?.id !== payload.id) {
      return;
    }
    void clientApi.sessions.get({ sessionId: payload.id })
      .then((nextPayload) => {
        if (eventsPaused) {
          idleNotifications.observeOne(sessionPayloadIdleNotification(nextPayload));
          scheduleSessionIdleRefresh(nextPayload);
          return;
        }
        renderSessionPayload(nextPayload);
      })
      .catch(() => undefined);
  }, 1_250);
}

async function primeIdleNotificationSnapshotForCurrentRoute() {
  if (activeSession) {
    idleNotifications.primeOne(sessionPayloadIdleNotification(activeSession));
    return;
  }
  if (location.pathname !== "/" && location.pathname !== "/sessions" && location.pathname !== "/factory-floor") {
    return;
  }
  try {
    const [sessions, recentAgentSessions] = await Promise.all([
      clientApi.sessions.list(),
      clientApi.agentSessions.recent(),
    ]);
    idleNotifications.prime([
      ...sessions.map((session) => sessionListItemIdleNotification(session, homeIdleNotificationDisplayDirs)),
      ...recentAgentSessions.map((session) => recentAgentSessionIdleNotification(session, homeIdleNotificationDisplayDirs)),
    ]);
  } catch {
  }
}

function startIdleNotificationPollingForCurrentRoute() {
  if (!idleNotifications.isEnabled()) {
    return;
  }
  if (activeSession) {
    scheduleSessionIdleRefresh(activeSession);
    return;
  }
  if (location.pathname === "/" || location.pathname === "/sessions" || location.pathname === "/factory-floor") {
    startHomeIdleNotificationPolling(homeIdleNotificationDisplayDirs);
  }
}

function clearSessionIdleRefreshTimer() {
  if (sessionIdleRefreshTimer === null) {
    return;
  }
  window.clearTimeout(sessionIdleRefreshTimer);
  sessionIdleRefreshTimer = null;
}

function sessionPayloadIdleNotification(payload: SessionPayload): IdleNotificationSession {
  const displayHomeDirs = homeDirsForDisplay({ cwd: payload.cwd });
  return {
    key: `tuiui:${payload.id}`,
    providerLabel: providerLabelForCommand(payload.sdk.provider, payload.command),
    title: payload.title || payload.command,
    cwd: formatPathForDisplay(payload.cwd, displayHomeDirs),
    task: payload.sdk.summary?.latestUserText || payload.semantic.prompt || [payload.command, ...payload.args].join(" "),
    status: payload.status,
    routePath: `/sessions/${payload.id}`,
  };
}

function sessionListItemIdleNotification(session: SessionListItem, displayHomeDirs: string[]): IdleNotificationSession {
  return {
    key: `tuiui:${session.id}`,
    providerLabel: providerLabelForCommand("", session.command),
    title: session.title || session.command,
    cwd: formatPathForDisplay(session.cwd, displayHomeDirs),
    task: [session.command, ...session.args].join(" "),
    status: session.status,
    routePath: `/sessions/${session.id}`,
  };
}

function recentAgentSessionIdleNotification(
  session: RecentAgentSession,
  displayHomeDirs: string[],
): IdleNotificationSession {
  return {
    key: `agent:${session.provider}:${session.id}`,
    providerLabel: providerLabel(session.provider),
    title: session.title || session.id,
    cwd: formatPathForDisplay(session.cwd, displayHomeDirs),
    task: session.latestUserText || session.initialUserText || session.command,
    status: formatRecentSessionStatus(session),
    routePath: "",
  };
}

function providerLabelForCommand(provider: string, command: string) {
  const value = `${provider} ${command}`.toLowerCase();
  if (value.includes("opencode")) {
    return "OpenCode";
  }
  if (value.includes("claude")) {
    return "Claude";
  }
  if (value.includes("codex")) {
    return "Codex";
  }
  return "Agent";
}

function setupPromptboxState(sessionId: string, promptbox: HTMLTextAreaElement) {
  const state = useLocalStorageState(promptboxStorageKey(sessionId), "");
  promptbox.value = state.getValue();
  collapsePromptbox(promptbox);
  promptbox.addEventListener("input", () => {
    state.setValue(promptbox.value);
    resizePromptboxIfFocused(promptbox);
  });
  promptbox.addEventListener("focus", () => {
    resizePromptbox(promptbox);
  });
  promptbox.addEventListener("blur", () => {
    collapsePromptbox(promptbox);
  });
}

function resizePromptboxIfFocused(promptbox: HTMLTextAreaElement) {
  if (document.activeElement === promptbox) {
    resizePromptbox(promptbox);
    return;
  }
  collapsePromptbox(promptbox);
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
  clearSessionIdleRefreshTimer();
  stopHomeIdleNotificationPolling();
  destroyXterm();
  destroyIdeFileTree();
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

  if (location.pathname === "/ide") {
    await renderIdeRoute();
    return;
  }

  if (location.pathname === "/factory-floor") {
    await renderFactoryFloorHome();
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
    const result = await clientApi.sessions.recover({ sessionId });
    history.pushState({}, "", `/sessions/${result.id}`);
    await renderRoute();
  });
}

async function fetchSessionRecovery(sessionId: string) {
  try {
    return await clientApi.sessions.recovery({ sessionId });
  } catch {
    return null;
  }
}

async function renderIdeRoute() {
  const url = new URL(location.href);
  const requestedCwd = url.searchParams.get("cwd") || "";
  const cwd = requestedCwd || (await clientApi.cwd()).cwd;
  if (!requestedCwd) {
    history.replaceState({}, "", `/ide?cwd=${encodeURIComponent(cwd)}`);
  }
  const displayCwd = formatPathForDisplay(cwd, homeDirsForDisplay({ cwd }));
  document.title = `${displayCwd} · IDE · TUI UI`;
  app.innerHTML = `
    <main class="layout ide-route-layout">
      <header class="topbar ide-route-topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted">IDE</span>
        <code class="command app-title" title="${escapeAttr(cwd)}" data-testid="ide-cwd">${escapeHtml(displayCwd)}</code>
      </header>
      <section id="screen" class="screen ide-screen" data-testid="semantic-screen"></section>
    </main>
  `;
  const screen = document.getElementById("screen")!;
  renderIdeScreenForCwd(screen, cwd);
}

async function renderHome() {
  const [cwd, sessions, commands] = await Promise.all([
    clientApi.cwd(),
    clientApi.sessions.list(),
    clientApi.commands(),
  ]);
  const displayHomeDirs = homeDirsForDisplay(cwd);
  homeIdleNotificationDisplayDirs = displayHomeDirs;
  observeHomeIdleNotificationSessions(sessions, [], displayHomeDirs);
  const launchCwdState = useLocalStorageState("tuiui-launch-cwd", cwd.cwd);
  const launchCwdValue = launchCwdState.getValue() || cwd.cwd;
  const recentSessionGroupState = useLocalStorageState(recentSessionGroupStorageKey, "");
  const launchCommandOrder = ["codex", "claude", "opencode"];
  const quickLaunchCommands = launchCommandOrder
    .map((id) => commands.find((command) => command.id === id && !command.fakeAgent))
    .filter((command): command is CommandPreset => Boolean(command));
  let loadedRecentAgentSessions: RecentAgentSession[] | null = null;

  app.innerHTML = `
    <main class="layout home-layout">
      <header class="topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted" data-testid="session-count">${sessions.length} sessions</span>
        <a class="view-switch-link" href="/" data-action="open-coordinator">Coordinator</a>
        <a class="view-switch-link" href="/factory-floor" data-action="open-factory-floor" aria-label="Factory floor">🏭</a>
        ${renderIdleNotificationControl()}
      </header>
      <section class="launcher" aria-label="Launch session">
        <form id="launch-form" class="launch-form">
          <div class="launch-command-row">
            <label class="command-prompt-field">
              <span class="command-prompt-glyph" aria-hidden="true">&gt;</span>
              <input name="commandLine" aria-label="Command" autocomplete="off" required placeholder="codex --yolo" />
            </label>
            <label class="cwd-field">
              <span aria-hidden="true">cwd</span>
              <input name="cwd" aria-label="Working directory" autocomplete="off" required value="${escapeAttr(formatPathForDisplay(launchCwdValue, displayHomeDirs))}" />
            </label>
          </div>
          <div class="quick-launch-row" role="group" aria-label="Shortcuts">
            <div class="quick-launch-buttons">
              ${quickLaunchCommands.map((command) => `
                <button
                  type="button"
                  class="preset-button"
                  data-preset-id="${escapeAttr(command.id)}"
                  aria-label="${escapeAttr(command.coordinator ? "coordinator" : command.command)}"
                  title="${escapeAttr(command.command)}"
                >${escapeHtml(command.command.toLowerCase())}</button>
              `).join("")}
            </div>
            <label class="fakeagent-toggle">
              <input name="fakeagent" type="checkbox" aria-label="fakeagent" />
              <span>fakeagent</span>
            </label>
          </div>
        </form>
      </section>
      <section class="recent-agents" aria-label="Recent agent sessions" data-testid="recent-agents">
        <header>
          <details class="recent-session-group-config" data-testid="recent-session-group-config">
            <summary><strong>Recent Sessions</strong></summary>
            <textarea
              data-recent-session-groups-input
              data-testid="recent-session-group-input"
              aria-label="Recent session groups"
              rows="3"
              spellcheck="false"
              placeholder="cwd"
            >${escapeHtml(recentSessionGroupState.getValue())}</textarea>
          </details>
          <span data-testid="recent-agent-count">Loading</span>
        </header>
        <p class="recent-session-group-error" data-testid="recent-session-group-error" hidden></p>
        <div class="recent-agents-list" data-testid="recent-agent-list">
          <p class="empty">Loading recent sessions</p>
        </div>
      </section>
      <section class="sessions" aria-label="Sessions">
        ${sessions.length ? sessions.map(renderSessionLink).join("") : `<p class="empty">No sessions</p>`}
      </section>
    </main>
  `;
  bindIdleNotificationControls();
  startHomeIdleNotificationPolling(displayHomeDirs);
  const factoryFloorLink = app.querySelector<HTMLAnchorElement>("[data-action='open-factory-floor']");
  if (factoryFloorLink) {
    bindClientRouteLink(factoryFloorLink, "/factory-floor");
  }

  const form = document.getElementById("launch-form") as HTMLFormElement;
  const recentSessionGroupInput = document.querySelector<HTMLTextAreaElement>("[data-recent-session-groups-input]")!;
  const commandInput = form.elements.namedItem("commandLine") as HTMLInputElement;
  const cwdInput = form.elements.namedItem("cwd") as HTMLInputElement;
  const fakeAgentInput = form.elements.namedItem("fakeagent") as HTMLInputElement;
  const presets = new Map(commands.map((command) => [command.id, command]));

  recentSessionGroupInput.addEventListener("input", () => {
    recentSessionGroupState.setValue(recentSessionGroupInput.value);
    if (!loadedRecentAgentSessions) {
      return;
    }
    renderRecentAgentSessions(loadedRecentAgentSessions);
    bindRecentAgentSessionButtons(loadedRecentAgentSessions);
  });

  cwdInput.addEventListener("input", () => {
    launchCwdState.setValue(resolveLaunchCwd(cwdInput.value));
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
        coordinator: Boolean(preset.coordinator),
      });
    });
  }

  app.querySelector<HTMLAnchorElement>("[data-action='open-coordinator']")?.addEventListener("click", async (event) => {
    event.preventDefault();
    await openOrLaunchCoordinator();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitLaunchForm();
  });

  void loadRecentAgentSessions();

  async function loadRecentAgentSessions() {
    try {
      const recentAgentSessions = await clientApi.agentSessions.recent();
      if (!form.isConnected) {
        return;
      }
      loadedRecentAgentSessions = recentAgentSessions;
      observeHomeIdleNotificationSessions(sessions, recentAgentSessions, displayHomeDirs);
      renderRecentAgentSessions(recentAgentSessions);
      bindRecentAgentSessionButtons(recentAgentSessions);
    } catch {
      renderRecentAgentSessionFailure();
    }
  }

  function renderRecentAgentSessions(recentAgentSessions: RecentAgentSession[]) {
    const count = document.querySelector<HTMLElement>("[data-testid='recent-agent-count']");
    const list = document.querySelector<HTMLElement>("[data-testid='recent-agent-list']");
    if (!count || !list) {
      return;
    }
    const rendered = renderRecentAgentSessionContent(
      recentAgentSessions,
      displayHomeDirs,
      recentSessionGroupState.getValue(),
    );
    count.textContent = recentAgentSessions.length ? `${recentAgentSessions.length} active in 24h` : "None";
    list.innerHTML = rendered.html;
    renderRecentSessionGroupError(rendered.error);
  }

  function renderRecentAgentSessionFailure() {
    const count = document.querySelector<HTMLElement>("[data-testid='recent-agent-count']");
    const list = document.querySelector<HTMLElement>("[data-testid='recent-agent-list']");
    if (!count || !list) {
      return;
    }
    count.textContent = "Unavailable";
    list.innerHTML = `<p class="empty">Recent sessions unavailable</p>`;
    renderRecentSessionGroupError("");
  }

  function bindRecentAgentSessionButtons(recentAgentSessions: RecentAgentSession[]) {
    const recentAgentSessionsByKey = new Map(recentAgentSessions.map((session) => [`${session.provider}:${session.id}`, session]));
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
          coordinator: false,
        });
      });
    }
  }

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
      coordinator: false,
    });
  }

  function currentLaunchCwd() {
    const value = resolveLaunchCwd(cwdInput.value);
    launchCwdState.setValue(value);
    return value;
  }

  function setLaunchCwd(value: string) {
    const resolved = resolveLaunchCwd(value);
    cwdInput.value = formatPathForDisplay(resolved, displayHomeDirs);
    launchCwdState.setValue(resolved);
  }

  function resolveLaunchCwd(value: string) {
    return expandDisplayPath(value, displayHomeDirs);
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
    const result = await clientApi.sessions.create({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      cols: 120,
      rows: 42,
      env: {},
      fakeAgent: input.fakeAgent,
      coordinator: Boolean(input.coordinator),
    });
    history.pushState({}, "", `/sessions/${result.id}`);
    await renderRoute();
  }

  async function openOrLaunchCoordinator() {
    const existing = sessions.find((session) => isCoordinatorSession(session) && session.lifecycle === "running");
    if (existing) {
      history.pushState({}, "", `/sessions/${existing.id}`);
      await renderRoute();
      return;
    }
    const coordinator = presets.get("coordinator");
    if (!coordinator) {
      showToast({
        id: "coordinator-voice-missing",
        title: "Coordinator unavailable",
        message: "No coordinator launch preset is available.",
        durationMs: 5_000,
      });
      return;
    }
    await launchSession({
      command: coordinator.command,
      args: coordinator.args,
      cwd: currentLaunchCwd(),
      fakeAgent: fakeAgentForCommand(coordinator.command),
      coordinator: true,
    });
  }
}

function isCoordinatorSession(session: SessionListItem) {
  const title = normalizeComparableText(session.title);
  const args = session.args.join(" ");
  return title === "coordinator"
    || args.includes("/mcp/coordinator")
    || (title.includes("tui ui") && title.includes("coordinator agent"));
}

async function renderFactoryFloorHome() {
  const [cwd, sessions, commands] = await Promise.all([
    clientApi.cwd(),
    clientApi.sessions.list(),
    clientApi.commands(),
  ]);
  const displayHomeDirs = homeDirsForDisplay(cwd);
  homeIdleNotificationDisplayDirs = displayHomeDirs;
  observeHomeIdleNotificationSessions(sessions, [], displayHomeDirs);
  const launchCwdState = useLocalStorageState("tuiui-launch-cwd", cwd.cwd);
  const launchCwdValue = launchCwdState.getValue() || cwd.cwd;
  const launchCommandOrder = ["codex", "claude", "opencode"];
  const quickLaunchCommands = launchCommandOrder
    .map((id) => commands.find((command) => command.id === id && !command.fakeAgent))
    .filter((command): command is CommandPreset => Boolean(command));
  let loadedRecentAgentSessions: RecentAgentSession[] | null = null;

  app.innerHTML = `
    <main class="layout factory-floor-layout">
      <header class="topbar factory-floor-topbar">
        <a class="brand" href="/">tuiui</a>
        <span class="muted" data-testid="session-count">${sessions.length} sessions</span>
        <a class="view-switch-link" href="/" data-action="open-list-view">List view</a>
        ${renderIdleNotificationControl()}
      </header>
      <section class="launcher factory-launcher" aria-label="Launch session">
        <form id="factory-launch-form" class="launch-form">
          <div class="launch-command-row">
            <label class="command-prompt-field">
              <span class="command-prompt-glyph" aria-hidden="true">&gt;</span>
              <input name="commandLine" aria-label="Command" autocomplete="off" required placeholder="codex --yolo" />
            </label>
            <label class="cwd-field">
              <span aria-hidden="true">cwd</span>
              <input name="cwd" aria-label="Working directory" autocomplete="off" required value="${escapeAttr(formatPathForDisplay(launchCwdValue, displayHomeDirs))}" />
            </label>
          </div>
          <div class="quick-launch-row" role="group" aria-label="Shortcuts">
            <div class="quick-launch-buttons">
              ${quickLaunchCommands.map((command) => `
                <button
                  type="button"
                  class="preset-button"
                  data-preset-id="${escapeAttr(command.id)}"
                  aria-label="${escapeAttr(command.coordinator ? "coordinator" : command.command)}"
                  title="${escapeAttr(command.command)}"
                >${escapeHtml(command.command.toLowerCase())}</button>
              `).join("")}
            </div>
            <label class="fakeagent-toggle">
              <input name="fakeagent" type="checkbox" aria-label="fakeagent" />
              <span>fakeagent</span>
            </label>
          </div>
        </form>
      </section>
      <div data-factory-floor-mount>
        ${renderFactoryFloorOverview({
          sessions,
          recentAgentSessions: null,
          displayHomeDirs,
          nowMs: Date.now(),
        })}
      </div>
    </main>
  `;
  bindIdleNotificationControls();
  startHomeIdleNotificationPolling(displayHomeDirs);
  const listViewLink = app.querySelector<HTMLAnchorElement>("[data-action='open-list-view']");
  if (listViewLink) {
    bindClientRouteLink(listViewLink, "/");
  }

  const form = document.getElementById("factory-launch-form") as HTMLFormElement;
  const commandInput = form.elements.namedItem("commandLine") as HTMLInputElement;
  const cwdInput = form.elements.namedItem("cwd") as HTMLInputElement;
  const fakeAgentInput = form.elements.namedItem("fakeagent") as HTMLInputElement;
  const presets = new Map(commands.map((command) => [command.id, command]));

  cwdInput.addEventListener("input", () => {
    launchCwdState.setValue(resolveLaunchCwd(cwdInput.value));
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
        coordinator: Boolean(preset.coordinator),
      });
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitLaunchForm();
  });

  bindFactoryFloorStationControls([]);
  void loadRecentAgentSessions();

  async function loadRecentAgentSessions() {
    try {
      const recentAgentSessions = await clientApi.agentSessions.recent();
      if (!form.isConnected) {
        return;
      }
      loadedRecentAgentSessions = recentAgentSessions;
      observeHomeIdleNotificationSessions(sessions, recentAgentSessions, displayHomeDirs);
      renderFactoryFloor(recentAgentSessions, "");
    } catch {
      renderFactoryFloor([], "Recent sessions unavailable");
    }
  }

  function renderFactoryFloor(recentAgentSessions: RecentAgentSession[], error: string) {
    const mount = document.querySelector<HTMLElement>("[data-factory-floor-mount]");
    if (!mount) {
      return;
    }
    mount.innerHTML = `
      ${renderFactoryFloorOverview({
        sessions,
        recentAgentSessions,
        displayHomeDirs,
        nowMs: Date.now(),
      })}
      ${error ? `<p class="factory-floor-error" data-testid="factory-floor-error">${escapeHtml(error)}</p>` : ""}
    `;
    bindFactoryFloorStationControls(recentAgentSessions);
  }

  function bindFactoryFloorStationControls(recentAgentSessions: RecentAgentSession[]) {
    const recentAgentSessionsByKey = new Map(
      recentAgentSessions.map((session) => [factoryRecentSessionKey(session as FactoryFloorRecentSession), session]),
    );
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action='factory-resume-agent-session']")) {
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
          coordinator: false,
        });
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action='factory-archive-session']")) {
      button.addEventListener("click", async () => {
        const sessionId = button.dataset.sessionId || "";
        if (!sessionId) {
          return;
        }
        button.disabled = true;
        try {
          await clientApi.sessions.archive({ sessionId });
          await renderRoute();
        } catch (error) {
          button.disabled = false;
          showRequestErrorToast("Stop station failed", error, "factory-stop-error-toast");
        }
      });
    }
    for (const promptForm of document.querySelectorAll<HTMLFormElement>("[data-action='factory-prompt-form']")) {
      promptForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = promptForm.elements.namedItem("text") as HTMLInputElement;
        const text = input.value.trim();
        const sessionId = promptForm.dataset.sessionId || "";
        if (!text || !sessionId) {
          return;
        }
        input.disabled = true;
        try {
          await clientApi.sessions.send({ sessionId, text, submit: true });
          input.value = "";
          showToast({
            title: "Prompt sent",
            message: "Station input was sent to the terminal.",
            durationMs: 2_500,
          });
        } catch (error) {
          showRequestErrorToast("Send station prompt failed", error, "factory-send-error-toast");
        } finally {
          input.disabled = false;
        }
      });
    }
  }

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
      coordinator: false,
    });
  }

  function currentLaunchCwd() {
    const value = resolveLaunchCwd(cwdInput.value);
    launchCwdState.setValue(value);
    return value;
  }

  function setLaunchCwd(value: string) {
    const resolved = resolveLaunchCwd(value);
    cwdInput.value = formatPathForDisplay(resolved, displayHomeDirs);
    launchCwdState.setValue(resolved);
  }

  function resolveLaunchCwd(value: string) {
    return expandDisplayPath(value, displayHomeDirs);
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
    const result = await clientApi.sessions.create({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      cols: 120,
      rows: 42,
      env: {},
      fakeAgent: input.fakeAgent,
      coordinator: Boolean(input.coordinator),
    });
    history.pushState({}, "", `/sessions/${result.id}`);
    await renderRoute();
  }
}

function renderRecentSessionGroupError(message: string) {
  const error = document.querySelector<HTMLElement>("[data-testid='recent-session-group-error']");
  if (!error) {
    return;
  }
  error.textContent = message;
  error.hidden = !message;
}

function renderRecentAgentSessionContent(
  recentAgentSessions: RecentAgentSession[],
  displayHomeDirs: string[],
  groupInput: string,
): RecentSessionGroupRenderResult {
  const parsed = parseRecentSessionGroupDefinitions(groupInput);
  if (!recentAgentSessions.length) {
    return { html: `<p class="empty">No recent sessions</p>`, error: parsed.error };
  }
  if (parsed.error || !parsed.definitions.length) {
    return {
      html: renderRecentAgentSessionCards(recentAgentSessions, displayHomeDirs),
      error: parsed.error,
    };
  }

  try {
    return {
      html: renderRecentSessionGroups(
        groupRecentAgentSessions(recentAgentSessions, parsed.definitions, displayHomeDirs, 0),
        displayHomeDirs,
        0,
      ),
      error: "",
    };
  } catch (error) {
    return {
      html: renderRecentAgentSessionCards(recentAgentSessions, displayHomeDirs),
      error: formatRecentSessionGroupError(error),
    };
  }
}

function parseRecentSessionGroupDefinitions(input: string): RecentSessionGroupParseResult {
  const definitions: RecentSessionGroupDefinition[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const expression = lines[index]!.trim();
    if (!expression) {
      continue;
    }

    try {
      definitions.push({ expression, lineNumber: index + 1, compiled: jsonata(expression) });
    } catch (error) {
      return {
        definitions: [],
        error: `Line ${index + 1}: ${formatRecentSessionGroupError(error)}`,
      };
    }
  }
  return { definitions, error: "" };
}

function groupRecentAgentSessions(
  sessions: RecentAgentSession[],
  definitions: RecentSessionGroupDefinition[],
  displayHomeDirs: string[],
  definitionIndex: number,
): RecentSessionGroup[] {
  if (definitionIndex >= definitions.length) {
    return [];
  }

  const definition = definitions[definitionIndex]!;
  const groups: RecentSessionGroup[] = [];
  const groupsByKey = new Map<string, RecentSessionGroup>();
  for (const session of sessions) {
    let rawValue: any;
    try {
      rawValue = definition.compiled.evaluate(recentSessionForJsonata(session, displayHomeDirs));
    } catch (error) {
      throw new Error(`Line ${definition.lineNumber}: ${formatRecentSessionGroupError(error)}`);
    }
    const name = formatRecentSessionGroupValue(rawValue, displayHomeDirs);
    const key = recentSessionGroupValueKey(rawValue);
    let group = groupsByKey.get(key);
    if (!group) {
      group = { name, sessions: [], children: [] };
      groupsByKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }
  for (const group of groups) {
    group.children = groupRecentAgentSessions(group.sessions, definitions, displayHomeDirs, definitionIndex + 1);
  }
  return groups;
}

function recentSessionForJsonata(session: RecentAgentSession, displayHomeDirs: string[]) {
  return {
    ...session,
    cwd: formatPathForDisplay(session.cwd, displayHomeDirs),
  };
}

function renderRecentSessionGroups(
  groups: RecentSessionGroup[],
  displayHomeDirs: string[],
  depth: number,
): string {
  return `
    <div class="recent-session-groups" data-depth="${depth}">
      ${groups.map((group) => `
        <details class="recent-session-group" data-depth="${depth}"${depth === 0 && groups.length === 1 ? " open" : ""}>
          <summary>
            <span class="recent-session-group-title">
              <code>${escapeHtml(group.name)}</code>
            </span>
            <span class="recent-session-group-count">${group.sessions.length} ${group.sessions.length === 1 ? "session" : "sessions"}</span>
          </summary>
          ${group.children.length
            ? renderRecentSessionGroups(group.children, displayHomeDirs, depth + 1)
            : renderRecentAgentSessionCards(group.sessions, displayHomeDirs)}
        </details>
      `).join("")}
    </div>
  `;
}

function formatRecentSessionGroupValue(value: any, displayHomeDirs: string[]) {
  if (value === undefined) {
    return "(undefined)";
  }
  if (value === null) {
    return "(null)";
  }
  if (typeof value === "string") {
    return value ? formatPathForDisplay(value, displayHomeDirs) : "(empty)";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return stringifyRecentSessionGroupValue(value);
}

function recentSessionGroupValueKey(value: any) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value}:${String(value)}`;
  }
  return `json:${stringifyRecentSessionGroupValue(value)}`;
}

function stringifyRecentSessionGroupValue(value: any) {
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

function formatRecentSessionGroupError(error: unknown) {
  const details = error as { code?: string; message?: string; position?: number; token?: string };
  const message = details && details.message ? details.message : String(error);
  const code = details && details.code ? `${details.code}: ` : "";
  const position = details && typeof details.position === "number" ? ` at position ${details.position}` : "";
  return `${code}${message}${position}`;
}

function renderRecentAgentSessionCards(recentAgentSessions: RecentAgentSession[], displayHomeDirs: string[]) {
  return recentAgentSessions.map((session) => `
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
  `).join("");
}

async function renderSession(sessionId: string) {
  if (activeSession?.id !== sessionId) {
    renderer = "terminal";
  }
  const payload = await clientApi.sessions.get({ sessionId });
  activeSession = payload;
  const binary = detectChordBinary(payload.command, payload.args, payload.sdk.provider);

  app.innerHTML = `
    <main class="layout session-layout">
      <header class="topbar session-appbar">
        <a class="brand" href="/">tuiui</a>
        <code class="command app-title" title="${escapeAttr([payload.command, ...payload.args].join(" "))}" data-testid="session-command">${escapeHtml(payload.title || payload.command)}</code>
        <span class="status-pill" data-state="${payload.status}" data-testid="session-status">${payload.status}</span>
        ${renderIdleNotificationControl()}
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
                <button type="button" class="icon-button" data-action="open-ide-view">IDE</button>
                <button type="button" class="icon-button" data-renderer="sdk" aria-pressed="${renderer === "sdk"}">Debug</button>
                <button type="button" class="icon-button" data-action="pause-events" aria-pressed="false">Pause events</button>
                <button type="button" class="icon-button" data-action="relayout">Relayout</button>
                <button type="button" class="icon-button" data-action="archive-session">Archive</button>
              </div>
              <div class="terminal-zoom-control" role="group" aria-label="Terminal zoom">
                <button type="button" class="icon-button" data-terminal-zoom="-1" aria-label="Zoom terminal out" title="Zoom terminal out">−</button>
                <output data-terminal-zoom-value aria-label="Terminal font size">${terminalFontSize}px</output>
                <button type="button" class="icon-button" data-terminal-zoom="1" aria-label="Zoom terminal in" title="Zoom terminal in">+</button>
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
          ${renderVoiceToggleButton("terminal-scroll-button terminal-voice-button")}
          <button type="button" class="terminal-scroll-button terminal-attach-button" data-action="attach-file" aria-label="Attach file" title="Attach file">
            ${renderAttachIcon()}
          </button>
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
          <div class="promptbox-shell">
            <textarea id="stdin" data-label="promptbox" aria-label="Send stdin" rows="1" spellcheck="false"></textarea>
          </div>
          <input id="attachment-file" class="attachment-file-input" type="file" multiple />
          <button type="button" id="attach" class="icon-button composer-attach" data-action="attach-file" aria-label="Attach file" title="Attach file">
            ${renderAttachIcon()}
          </button>
          ${renderVoiceToggleButton("icon-button composer-voice-button")}
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
        <output id="voice-status" class="visually-hidden" data-testid="voice-status" aria-live="polite">Voice ready</output>
      </section>
    </main>
  `;

  bindIdleNotificationControls();
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
      if (usesTextareaReturnForNewline()) {
        return;
      }
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

  document.querySelector<HTMLButtonElement>("[data-action='open-ide-view']")?.addEventListener("click", () => {
    const cwd = activeSession?.cwd || "";
    if (!cwd) {
      return;
    }
    history.pushState({}, "", `/ide?cwd=${encodeURIComponent(cwd)}`);
    closeSessionMenu();
    void renderRoute();
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

  document.querySelector<HTMLButtonElement>("[data-action='archive-session']")?.addEventListener("click", () => {
    void archiveSession(sessionId);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      changeTerminalFontSize(sessionId, Number(button.dataset.terminalZoom || 0));
    });
  });
  updateTerminalZoomControls();

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      scrollTerminalByStep(Number(button.dataset.terminalScroll || 0));
    });
  });
}

function setupAttachmentControls(sessionId: string, textarea: HTMLTextAreaElement) {
  const input = document.getElementById("attachment-file") as HTMLInputElement | null;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-action='attach-file']")];
  const preview = document.getElementById("attachment-preview") as HTMLElement | null;
  const dialog = document.getElementById("attachment-dialog") as HTMLDialogElement | null;
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!input || !buttons.length || !preview || !dialog || !composer) {
    return;
  }

  clearComposerAttachments(preview);
  bindAttachmentDialog(dialog, textarea);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      input.click();
    });
  }

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    void uploadComposerAttachments(sessionId, textarea, preview, buttons, files, "file");
  });

  textarea.addEventListener("paste", (event) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    void uploadComposerAttachments(sessionId, textarea, preview, buttons, files, "paste");
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
    void uploadComposerAttachments(sessionId, textarea, preview, buttons, files, "drop");
  });
}

async function uploadComposerAttachments(
  sessionId: string,
  textarea: HTMLTextAreaElement,
  preview: HTMLElement,
  buttons: HTMLButtonElement[],
  files: File[],
  source: AttachmentSource,
) {
  for (const button of buttons) {
    button.disabled = true;
  }
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
    for (const button of buttons) {
      button.disabled = false;
    }
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
    recognizer: window.__tuiuiVoiceTest?.recognizer || createSessionVoiceRecognizer(),
    speaker: window.__tuiuiVoiceTest?.speaker || createBrowserVoiceSpeaker(),
    now: window.__tuiuiVoiceTest?.now || (() => Date.now()),
    minReadbackDelayMs: Number(window.__tuiuiVoiceTest?.minReadbackDelayMs || 700),
    async sendTranscript(text) {
      setPromptboxValue(textarea, text);
      await clientApi.sessions.send({ sessionId, text, submit: true });
      setPromptboxValue(textarea, "");
    },
  });
  unsubscribeVoiceLoop = voiceLoop.subscribe(updateVoiceControls);

  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action='voice-toggle']"));
  if (!buttons.length) {
    return;
  }
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const status = voiceLoop?.state.status;
      if (status === "listening" || status === "transcribing") {
        voiceLoop?.cancelListening();
        return;
      }
      voiceLoop?.startListening();
    });
  }
}

function createSessionVoiceRecognizer() {
  const createPreferred = createPreferredBrowserVoiceRecognizer || createBrowserVoiceRecognizer;
  return createPreferred();
}

function updateVoiceControls(state: VoiceLoop["state"]) {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action='voice-toggle']"));
  const status = document.getElementById("voice-status") as HTMLOutputElement | null;
  const active = state.status === "listening" || state.status === "transcribing";
  const label = state.status === "unsupported"
    ? state.message
    : active
      ? "Cancel voice input"
      : "Start voice input";
  const statusText = state.transcript ? `${state.message}: ${state.transcript}` : state.message;
  for (const button of buttons) {
    button.disabled = state.status === "unsupported";
    button.dataset.voiceStatus = state.status;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", statusText);
    button.innerHTML = active ? renderVoiceCancelIcon() : renderMicIcon();
  }
  if (status) {
    status.value = statusText;
    status.textContent = status.value;
  }
}

function closeSessionMenu() {
  document.querySelector<HTMLDetailsElement>(".session-menu")?.removeAttribute("open");
}

function resizePromptbox(promptbox: HTMLTextAreaElement) {
  const styles = getComputedStyle(promptbox);
  const baseHeight = parsePixel(styles.getPropertyValue("--promptbox-base-height")) || promptbox.clientHeight || 48;
  const maxHeightRatio = parsePixel(styles.getPropertyValue("--promptbox-max-height-ratio")) || 3;
  const maxHeight = baseHeight * maxHeightRatio;
  promptbox.style.height = `${baseHeight}px`;
  const nextHeight = Math.min(maxHeight, Math.max(baseHeight, promptbox.scrollHeight));
  promptbox.style.height = `${Math.ceil(nextHeight)}px`;
  promptbox.dataset.overflowing = String(promptbox.scrollHeight > nextHeight + 1);
  promptbox.dataset.expanded = String(nextHeight > baseHeight + 1);
}

function collapsePromptbox(promptbox: HTMLTextAreaElement) {
  const styles = getComputedStyle(promptbox);
  const baseHeight = parsePixel(styles.getPropertyValue("--promptbox-base-height")) || promptbox.clientHeight || 48;
  promptbox.style.height = `${baseHeight}px`;
  promptbox.dataset.overflowing = "false";
  promptbox.dataset.expanded = "false";
}

async function sendComposer(sessionId: string) {
  const textarea = document.getElementById("stdin") as HTMLTextAreaElement;
  const text = textarea.value;
  setPromptboxValue(textarea, "");
  await clientApi.sessions.send({ sessionId, text, submit: true });
  clearComposerAttachments();
  scheduleTerminalResize(sessionId);
}

async function archiveSession(sessionId: string) {
  try {
    await clientApi.sessions.archive({ sessionId });
    closeSessionMenu();
    history.pushState({}, "", "/");
    await renderRoute();
  } catch (error) {
    showRequestErrorToast("Archive session failed", error, "archive-session-error-toast");
  }
}

async function sendKey(sessionId: string, key: string) {
  await clientApi.sessions.key({ sessionId, key });
}

async function sendChordSequence(sessionId: string, sequence: string, chordId: string) {
  const steps = parseChordSteps(sequence);
  for (const step of steps) {
    await clientApi.sessions.send({ sessionId, text: step.text, submit: step.submit });
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
  idleNotifications.observeOne(sessionPayloadIdleNotification(payload));
  scheduleSessionIdleRefresh(payload);

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
    destroyIdeFileTree();
    destroyDataEditor();
    renderTerminalScreen(screen, payload);
  } else if (renderer === "sdk") {
    destroyIdeFileTree();
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

  const nextPayload = await clientApi.sessions.get({ sessionId: payload.id });
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

function changeTerminalFontSize(sessionId: string, direction: number) {
  if (!direction) {
    return;
  }
  const currentIndex = terminalFontSizeSteps.indexOf(terminalFontSize);
  const index = currentIndex === -1 ? terminalFontSizeSteps.indexOf(defaultTerminalFontSize()) : currentIndex;
  const nextIndex = Math.max(0, Math.min(terminalFontSizeSteps.length - 1, index + direction));
  const nextFontSize = terminalFontSizeSteps[nextIndex]!;
  if (nextFontSize === terminalFontSize) {
    updateTerminalZoomControls();
    return;
  }

  terminalFontSize = nextFontSize;
  storeTerminalFontSize(nextFontSize);
  applyTerminalFontSize();
  updateTerminalZoomControls();
  lastTerminalResizeKey = "";
  if (!activeSession || renderer !== "terminal") {
    return;
  }
  destroyXterm();
  renderSessionPayload(activeSession);
  scheduleTerminalResize(sessionId);
}

function updateTerminalZoomControls() {
  document.querySelectorAll<HTMLOutputElement>("[data-terminal-zoom-value]").forEach((output) => {
    output.textContent = `${terminalFontSize}px`;
  });
  const currentIndex = terminalFontSizeSteps.indexOf(terminalFontSize);
  document.querySelectorAll<HTMLButtonElement>("[data-terminal-zoom]").forEach((button) => {
    const direction = Number(button.dataset.terminalZoom || 0);
    button.disabled = direction < 0
      ? currentIndex <= 0
      : currentIndex >= terminalFontSizeSteps.length - 1;
  });
}

function applyTerminalFontSize() {
  document.documentElement.style.setProperty("--terminal-font-size", `${terminalFontSize}px`);
}

function readTerminalFontSize() {
  try {
    const stored = Number(localStorage.getItem(terminalFontSizeStorageKey) || "");
    if (terminalFontSizeSteps.includes(stored)) {
      return stored;
    }
  } catch {
  }
  return defaultTerminalFontSize();
}

function defaultTerminalFontSize() {
  return window.matchMedia("(max-width: 640px)").matches ? 11 : 12;
}

function storeTerminalFontSize(fontSize: number) {
  try {
    localStorage.setItem(terminalFontSizeStorageKey, String(fontSize));
  } catch {
  }
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

function renderIdeScreenForCwd(screen: HTMLElement, cwd: string) {
  screen.className = "screen ide-screen";
  const existingLayout = screen.querySelector(".ide-layout");
  if (existingLayout && ideFileTreeCwd === cwd) {
    return;
  }

  destroyDataEditor();
  destroyIdeFileTree();
  ideFileTreeCwd = cwd;
  ideSelectedFilePath = "";
  const displayCwd = formatPathForDisplay(cwd, homeDirsForDisplay({ cwd }));
  screen.innerHTML = `
    <section class="ide-layout" data-testid="ide-view">
      <aside class="ide-sidebar" aria-label="Files under current working directory">
        <header>
          <div class="ide-sidebar-title-row">
            <strong>Files</strong>
            <button
              type="button"
              class="ide-files-toggle"
              data-action="toggle-ide-files"
              aria-expanded="true"
              aria-label="Collapse file tree"
              title="Collapse file tree"
            >▾</button>
          </div>
          <code title="${escapeAttr(cwd)}" data-ide-cwd>${escapeHtml(displayCwd)}</code>
        </header>
        <div id="ide-file-tree" class="ide-tree-mount" data-testid="ide-file-tree">
          <p class="empty">Loading files</p>
        </div>
      </aside>
      <section class="ide-editor-pane" aria-label="File preview">
        <header>
          <strong data-ide-file-title>No file selected</strong>
          <span data-ide-file-meta></span>
        </header>
        <p class="ide-file-message" data-ide-file-message>Select a file from the tree.</p>
        <div id="ide-file-editor" class="ide-file-editor" data-testid="ide-file-editor"></div>
      </section>
    </section>
  `;
  bindIdeFilesToggle();
  mountFileTextEditor("");
  void loadIdeFileTree(cwd);
}

function bindIdeFilesToggle() {
  const button = document.querySelector<HTMLButtonElement>("[data-action='toggle-ide-files']");
  button?.addEventListener("click", () => {
    const layout = document.querySelector<HTMLElement>(".ide-layout");
    if (!layout) {
      return;
    }
    setIdeFilesCollapsed(layout.dataset.filesCollapsed !== "true");
  });
}

function setIdeFilesCollapsed(collapsed: boolean) {
  const layout = document.querySelector<HTMLElement>(".ide-layout");
  const button = document.querySelector<HTMLButtonElement>("[data-action='toggle-ide-files']");
  if (!layout || !button) {
    return;
  }
  layout.dataset.filesCollapsed = String(collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? "Expand file tree" : "Collapse file tree");
  button.setAttribute("title", collapsed ? "Expand file tree" : "Collapse file tree");
  button.textContent = collapsed ? "▸" : "▾";
}

async function loadIdeFileTree(cwd: string) {
  if (ideFileTreeLoadingCwd === cwd) {
    return;
  }
  ideFileTreeLoadingCwd = cwd;
  try {
    const tree = await clientApi.files.fileTree({ cwd });
    if (!isCurrentIdeCwd(cwd)) {
      return;
    }
    renderIdeFileTree(cwd, tree);
  } catch (error) {
    if (isCurrentIdeCwd(cwd)) {
      renderIdeTreeError(error);
    }
  } finally {
    if (ideFileTreeLoadingCwd === cwd) {
      ideFileTreeLoadingCwd = "";
    }
  }
}

function renderIdeFileTree(cwd: string, payload: SessionFileTreePayload) {
  const host = document.getElementById("ide-file-tree");
  if (!host) {
    return;
  }
  destroyIdeFileTree();
  ideFileTreeCwd = cwd;
  host.textContent = "";
  setIdeCwdChrome(payload.cwd);

  if (!payload.paths.length) {
    host.innerHTML = `<p class="empty">No files</p>`;
    setIdeFileMessage("No previewable files were found under this cwd.");
    return;
  }

  const firstFilePath = firstPreviewFilePath(payload.paths);
  ideFileTree = new FileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: firstFilePath ? [firstFilePath] : [],
    paths: payload.paths,
    search: true,
    unsafeCSS: ideFileTreeCss(),
    onSelectionChange(selectedPaths) {
      const selectedPath = selectedPaths[0] || "";
      if (!selectedPath) {
        return;
      }
      const item = ideFileTree?.getItem(selectedPath);
      if (!item || item.isDirectory()) {
        return;
      }
      void selectIdeFile(cwd, selectedPath);
    },
  });
  ideFileTree.render({ containerWrapper: host });
  if (payload.truncated) {
    host.insertAdjacentHTML("beforeend", `
      <p class="ide-tree-note">Showing first ${payload.entryCount} entries of ${payload.maxEntries}.</p>
    `);
  }
  if (firstFilePath) {
    void selectIdeFile(cwd, firstFilePath);
  } else {
    setIdeFileMessage("No previewable files were found under this cwd.");
  }
}

function renderIdeTreeError(error: unknown) {
  const host = document.getElementById("ide-file-tree");
  if (!host) {
    return;
  }
  destroyIdeFileTree();
  host.innerHTML = `<p class="ide-file-message">${escapeHtml(String(error instanceof Error ? error.message : error))}</p>`;
  setIdeFileMessage("File tree unavailable.");
}

async function selectIdeFile(cwd: string, filePath: string) {
  if (ideSelectedFilePath === filePath && dataEditorKind === "file-text") {
    return;
  }
  ideSelectedFilePath = filePath;
  setIdeFileChrome(filePath, "Loading");
  setIdeFileMessage("");
  mountFileTextEditor("", filePath);
  try {
    const file = await clientApi.files.fileContent({ cwd, path: filePath });
    if (!isCurrentIdeCwd(cwd) || ideSelectedFilePath !== filePath) {
      return;
    }
    renderIdeFileContent(file);
  } catch (error) {
    if (isCurrentIdeCwd(cwd) && ideSelectedFilePath === filePath) {
      setIdeFileChrome(filePath, "Unavailable");
      mountFileTextEditor("");
      setIdeFileMessage(String(error instanceof Error ? error.message : error));
    }
  }
}

function isCurrentIdeCwd(cwd: string) {
  return location.pathname === "/ide" && ideFileTreeCwd === cwd;
}

function renderIdeFileContent(file: SessionFileContentPayload) {
  setIdeFileChrome(file.path, `${formatFileSize(file.size)} · ${file.kind}`);
  if (file.kind !== "text") {
    mountFileTextEditor("");
    setIdeFileMessage(file.message);
    return;
  }
  mountFileTextEditor(file.content, file.path);
  setIdeFileMessage("");
  requestAnimationFrame(() => dataEditorView?.requestMeasure());
}

function mountFileTextEditor(doc: string, filePath = "") {
  const host = document.getElementById("ide-file-editor");
  if (!host) {
    return;
  }
  const languageKey = fileLanguageKey(filePath);
  if (!dataEditorView || dataEditorKind !== "file-text" || fileEditorLanguageKey !== languageKey) {
    destroyDataEditor();
    const languageExtensions = fileLanguageExtensions(languageKey);
    dataEditorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          githubDark,
          ...languageExtensions,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "IDE file content" }),
          fileEditorTheme(),
        ],
      }),
    });
    dataEditorKind = "file-text";
    dataEditorDoc = doc;
    fileEditorLanguageKey = languageKey;
    return;
  }
  updateDataEditorDoc(doc);
}

function fileLanguageKey(filePath: string) {
  const fileName = filePath.split("/").pop()?.toLowerCase() || "";
  if (!fileName) {
    return "";
  }
  if (fileName === "dockerfile") {
    return "";
  }
  const extension = fileName.includes(".") ? fileName.split(".").pop() || "" : "";
  if (["ts", "mts", "cts"].includes(extension)) {
    return "typescript";
  }
  if (extension === "tsx") {
    return "tsx";
  }
  if (["js", "mjs", "cjs"].includes(extension)) {
    return "javascript";
  }
  if (extension === "jsx") {
    return "jsx";
  }
  if (extension === "json") {
    return "json";
  }
  if (["yaml", "yml"].includes(extension)) {
    return "yaml";
  }
  if (["html", "htm"].includes(extension)) {
    return "html";
  }
  if (["css", "scss", "less"].includes(extension)) {
    return "css";
  }
  if (["md", "markdown", "mdx"].includes(extension)) {
    return "markdown";
  }
  if (["py", "pyw"].includes(extension)) {
    return "python";
  }
  if (["sql", "psql"].includes(extension)) {
    return "sql";
  }
  if (["xml", "svg"].includes(extension)) {
    return "xml";
  }
  return "";
}

function fileLanguageExtensions(languageKey: string): Extension[] {
  switch (languageKey) {
    case "typescript":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "javascript":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "json":
      return [json()];
    case "yaml":
      return [yaml()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "markdown":
      return [markdown()];
    case "python":
      return [python()];
    case "sql":
      return [sql()];
    case "xml":
      return [xml()];
    default:
      return [];
  }
}

function firstPreviewFilePath(paths: string[]) {
  return paths.find((candidate) => !candidate.endsWith("/")) || "";
}

function setIdeFileChrome(title: string, meta: string) {
  const titleElement = document.querySelector<HTMLElement>("[data-ide-file-title]");
  const metaElement = document.querySelector<HTMLElement>("[data-ide-file-meta]");
  if (titleElement) {
    titleElement.textContent = title || "No file selected";
    titleElement.title = title;
  }
  if (metaElement) {
    metaElement.textContent = meta;
  }
}

function setIdeFileMessage(message: string) {
  const element = document.querySelector<HTMLElement>("[data-ide-file-message]");
  if (!element) {
    return;
  }
  element.textContent = message;
  element.hidden = !message;
}

function setIdeCwdChrome(cwd: string) {
  const elements = document.querySelectorAll<HTMLElement>("[data-ide-cwd]");
  const displayCwd = formatPathForDisplay(cwd, homeDirsForDisplay({ cwd }));
  elements.forEach((element) => {
    element.textContent = displayCwd;
    element.title = cwd;
  });
}

function destroyIdeFileTree() {
  ideFileTree?.cleanUp();
  ideFileTree = null;
  ideFileTreeCwd = "";
  ideFileTreeLoadingCwd = "";
  ideSelectedFilePath = "";
}

function ideFileTreeCss() {
  return `
    :host {
      --trees-bg-override: #10151b;
      --trees-fg-override: #dce5ef;
      --trees-muted-fg-override: #8d99a8;
      --trees-border-color-override: #29313b;
      --trees-selected-bg-override: #64d2c8;
      --trees-selected-fg-override: #071112;
      color: #dce5ef;
      font: 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    * {
      font-size: inherit;
      line-height: inherit;
    }
  `;
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) {
    return `${Math.round(size / (1024 * 1024))} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} bytes`;
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
      fontSize: terminalFontSize,
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
        .then(() => clientApi.sessions.send({ sessionId, text, submit: false }))
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
  return await clientApi.sessions.stdout({ sessionId, after });
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
  await clientApi.sessions.resize({ sessionId, ...grid });
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
  return await clientApi.sessions.sdkRefresh({ sessionId });
}

async function summarizeSdk(sessionId: string) {
  const payload = await clientApi.sessions.sdkSummarize({ sessionId });
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
  return createEditorTheme({
    fontSize: "10px",
    lineHeight: "1.35",
    contentPadding: "6px 0",
    linePadding: "0 8px",
    lineNumberMinWidth: "32px",
  });
}

function fileEditorTheme() {
  return createEditorTheme({
    fontSize: "7px",
    lineHeight: "1.32",
    contentPadding: "5px 0",
    linePadding: "0 6px",
    lineNumberMinWidth: "22px",
  });
}

function createEditorTheme(input: {
  fontSize: string;
  lineHeight: string;
  contentPadding: string;
  linePadding: string;
  lineNumberMinWidth: string;
}) {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "#0d1014",
      color: "#eef2f7",
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
    },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
    },
    ".cm-content": {
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
      padding: input.contentPadding,
    },
    ".cm-line": {
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
      padding: input.linePadding,
    },
    ".cm-gutters": {
      backgroundColor: "#11161d",
      color: "#748293",
      borderRightColor: "#2c333d",
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
    },
    ".cm-gutterElement": {
      fontSize: input.fontSize,
      lineHeight: input.lineHeight,
      paddingTop: "0 !important",
      paddingBottom: "0 !important",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      minWidth: input.lineNumberMinWidth,
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
      height: `${input.lineHeight}em`,
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
  fileEditorLanguageKey = "";
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

function expandDisplayPath(value: string, homeDirs: string[]) {
  if (value === "~" || value.startsWith("~/")) {
    const home = homeDirs[0]?.replace(/\/+$/g, "") || "";
    if (home) {
      return `${home}${value.slice(1)}`;
    }
  }
  return value;
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

function usesTextareaReturnForNewline() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function renderVoiceToggleButton(className: string) {
  return `
    <button
      type="button"
      class="${escapeAttr(`${className} voice-talk`)}"
      data-action="voice-toggle"
      data-voice-status="idle"
      aria-label="Start voice input"
      title="Start voice input"
    >${renderMicIcon()}</button>
  `;
}

function renderMicIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  `;
}

function renderVoiceCancelIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  `;
}

function renderAttachIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M8.5 12.5 14 7a3.2 3.2 0 0 1 4.5 4.5l-7.2 7.2a5 5 0 0 1-7.1-7.1l8.1-8.1a6.8 6.8 0 0 1 9.6 9.6l-8.4 8.4" />
    </svg>
  `;
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
