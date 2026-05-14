// Inspired by ../xyz's Bun browser-session CLI, but this project deliberately
// uses Bun's PTY support directly instead of tmux. xyz remains the reference
// for the session browser and command/chord interaction ideas.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { ORPCError, os as orpc } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Codex } from "@openai/codex-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createFakeAgent, parseRequest, type AgentName, type FakeAgent } from "fakeagent";
import { z } from "zod";
import homepage from "./public/index.html";
import {
  buildCodexSidecarSummary,
  buildCodexSummary,
  codexHomeDirFromStateDatabasePath,
  createCodexSummaryPrompt,
  discardCodexThreadFromDatabasePath,
  readRecentCodexSessionsFromDatabasePath,
  readCodexThreadsFromDatabasePath,
  resolveCodexStateDatabasePathForEnv,
  resolveCodexThread,
} from "./src/codex-sdk.ts";
import {
  buildClaudeSidecarSummary,
  buildClaudeSummary,
  claudeConfigDirForEnv,
  createClaudeSummaryPrompt,
  discardClaudeSessionTranscripts,
  readClaudeSessionMessages,
  readClaudeSessions,
  readRecentClaudeSessions,
  resolveClaudeSession,
  runClaudeSidecarSummary,
} from "./src/claude-sdk.ts";
import { formatFakeAgentFallback } from "./src/fakeagent-response.ts";
import {
  buildOpenCodeSummary,
  buildOpenCodeSidecarSummary,
  createOpenCodeSummaryPrompt,
  openCodeDatabasePathForEnv,
  pickOpenCodeModel,
  readRecentOpenCodeSessionsFromDatabasePath,
  recentSessionPreviewFromMessages,
  recentSessionPreviewText,
  resolveOpenCodeSession,
  type AgentProvider,
  type AgentSessionSummary,
  type RecentAgentSession,
  type SessionSdkPayload,
} from "./src/opencode-sdk.ts";
import { createSessionId } from "./src/session-id.ts";
import { resolveNamedKeySequence } from "./src/chords.ts";
import { analyzeTerminalScreen, type SemanticScreen } from "./src/semantic-screen.ts";
import { analyzeTerminalBlocks, type TerminalBlockModel } from "./src/terminal-blocks.ts";
import { composerSubmitChunks, usesLfCrSubmit } from "./src/terminal-input.ts";
import { formatCommandLine, parseCommandLine } from "./src/command-line.ts";
import {
  createTmuxBackend,
  reconnectTmuxBackend,
  resolveSessionBackend,
  tmuxHasSession,
  type SessionBackendName,
  type TmuxBackendHandle,
} from "./src/tmux-backend.ts";
import { renderTerminalShotSvg } from "./src/tuishot.ts";
import { createSessionStoreForEnv, type SessionStore } from "./src/session-store.ts";
import {
  buildCoordinatorAgents,
  buildCoordinatorBriefing,
  findCoordinatorClashes,
  findExplicitPromptAgentTargets,
  managedCoordinatorAgentSource,
  recentCodexCoordinatorAgentSource,
  type CoordinatorAgent,
  type CoordinatorAgentSource,
} from "./src/coordinator-tools.ts";
import { handleCoordinatorMcpRequest, type CoordinatorMcpHandlers } from "./src/coordinator-mcp.ts";

if (typeof Bun === "undefined") {
  throw new Error("tuiui requires the Bun runtime. Run `bun run cli.ts ...`.");
}

type SessionLifecycle = "running" | "exited";
type SessionStatus = "busy" | "idle" | "exited";

type StdoutEvent = {
  id: number;
  chunk: string;
  displayText: string;
  createdAt: string;
};

type StdinEvent = {
  id: number;
  text: string;
  createdAt: string;
};

type SessionPayload = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  archivedAtMs: number | null;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string;
  lifecycle: SessionLifecycle;
  status: SessionStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  renderedText: string;
  renderedHtml: string;
  renderedAnsi: string;
  screenVersion: number;
  snapshotEventId: number;
  redrawActive: boolean;
  blocks: TerminalBlockModel;
  semantic: SemanticScreen;
  sdk: SessionSdkPayload;
  stdinEvents: StdinEvent[];
  stdoutEvents: StdoutEvent[];
};

type RuntimeSession = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  archivedAtMs: number | null;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string;
  lifecycle: SessionLifecycle;
  exitCode: number | null;
  cols: number;
  rows: number;
  terminal: HeadlessTerminal;
  serializer: SerializeAddon;
  outputDecoder: StringDecoder;
  backend: SessionBackendHandle;
  writeQueue: Promise<void>;
  renderedText: string;
  renderedHtml: string;
  renderedAnsi: string;
  screenVersion: number;
  snapshotEventId: number;
  blocks: TerminalBlockModel;
  semantic: SemanticScreen;
  sdk: SessionSdkPayload;
  sdkSummaryJob: Promise<void> | null;
  stdinEvents: StdinEvent[];
  stdoutEvents: StdoutEvent[];
  redrawGate: RedrawGate;
  idleStatusTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<(payload: SessionPayload) => void>;
  fakeAgent: FakeAgent | null;
};

type RedrawGate = {
  active: boolean;
  startedAfterEventId: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
};

type BunPtyBackendHandle = {
  name: "bun";
  process: any;
  exited: Promise<number | null>;
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  dispose(): Promise<void>;
};

type SessionBackendHandle = BunPtyBackendHandle | TmuxBackendHandle;

type CreateSessionInput = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  fakeAgent: AgentName | "";
  backend: SessionBackendName;
  launchCommand: string;
  coordinator: boolean;
};

type ServerState = {
  sessions: Map<string, RuntimeSession>;
  nextStdoutEventId: number;
  nextStdinEventId: number;
  sessionStore: SessionStore;
  coordinator: CoordinatorState;
};

type CoordinatorState = {
  sessionId: string;
  mcpToken: string;
  subscriptions: Map<string, CoordinatorSubscription>;
  lastAgentStatuses: Map<string, SessionStatus>;
  consumedPromptAgentGrants: Set<string>;
};

type CoordinatorSubscription = {
  agentId: string;
  createdAt: string;
};

const loopbackHost = "127.0.0.1";
const defaultBindHost = "0.0.0.0";
const defaultPort = 7373;
const defaultCols = 120;
const defaultRows = 42;
const idleThresholdMs = 1_000;
const redrawQuietMs = 600;
const redrawMaxMs = 10_000;
const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-attachments-"));
const terminalScrollbackSnapshotRows = 500;

const createSessionBodySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  fakeAgent: z.string().optional(),
  backend: z.string().optional(),
  coordinator: z.boolean().optional(),
});
const sessionIdInputSchema = z.object({ sessionId: z.string() });
const sendSessionInputSchema = sessionIdInputSchema.extend({
  text: z.string().optional(),
  submit: z.boolean().optional(),
});
const keySessionInputSchema = sessionIdInputSchema.extend({ key: z.string().optional() });
const resizeSessionInputSchema = sessionIdInputSchema.extend({
  cols: z.number().optional(),
  rows: z.number().optional(),
});
const stdoutSessionInputSchema = sessionIdInputSchema.extend({ after: z.number().optional() });

type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
type SessionIdInput = z.infer<typeof sessionIdInputSchema>;
type SendSessionInput = z.infer<typeof sendSessionInputSchema>;
type KeySessionInput = z.infer<typeof keySessionInputSchema>;
type ResizeSessionInput = z.infer<typeof resizeSessionInputSchema>;
type StdoutSessionInput = z.infer<typeof stdoutSessionInputSchema>;

type CommandPresetPayload = {
  id: string;
  label: string;
  command: string;
  args: string[];
  fakeAgent: string;
  coordinator?: boolean;
};

const cli = parseCliArgs(process.argv.slice(2));
const state: ServerState = {
  sessions: new Map(),
  nextStdoutEventId: 1,
  nextStdinEventId: 1,
  sessionStore: createSessionStoreForEnv(process.env),
  coordinator: createCoordinatorState(),
};
const server: ReturnType<typeof Bun.serve> = startServer({ host: cli.host, port: cli.port, state });
const serverPort = Number(server.port || cli.port);
const baseUrl = `http://${formatHostForUrl(localAccessHost(cli.host))}:${serverPort}`;
const accessBaseUrls = getAccessBaseUrls(serverPort, cli.host, baseUrl);

if (cli.rest.length > 0) {
  const [command, ...args] = cli.rest;
  const session = await createSession({
    id: createSessionId(),
    command: command || "",
    args,
    cwd: process.cwd(),
    env: {},
    cols: defaultCols,
    rows: defaultRows,
    fakeAgent: cli.fakeAgent,
    backend: cli.backend,
    launchCommand: formatCommandLine(command || "", args),
    coordinator: false,
  });
  const sessionUrls = accessBaseUrls.map((url) => `${url}/sessions/${session.id}`);
  process.stdout.write(`${sessionUrls.join("\n")}\n`);
  if (cli.open) {
    openUrl(sessionUrls[0] || `${baseUrl}/sessions/${session.id}`);
  }
} else {
  process.stdout.write(`${accessBaseUrls.join("\n")}\n`);
  if (cli.open) {
    openUrl(baseUrl);
  }
}

process.on("SIGTERM", () => void shutdown(server, state));
process.on("SIGINT", () => void shutdown(server, state));

await new Promise(() => {});

function startServer(options: { host: string; port: number; state: ServerState }): ReturnType<typeof Bun.serve> {
  const rpcHandler = new RPCHandler(createAppRouter(options.state));
  return Bun.serve({
    port: options.port,
    hostname: options.host,
    development: true,
    idleTimeout: 255,
    routes: {
      "/": homepage,
      "/sessions": homepage,
      "/sessions/:id": homepage,
      "/health": {
        GET: () => Response.json({ ok: true }),
      },
    },
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/mcp/coordinator") {
        if (!authorizedCoordinatorMcpRequest(options.state, request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return await handleCoordinatorMcpRequest(request, createCoordinatorMcpHandlers(options.state));
      }
      const rpc = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context: {},
      });
      if (rpc.matched) {
        return rpc.response;
      }
      if (!url.pathname.startsWith("/api/")) {
        return new Response("not found", { status: 404 });
      }
      try {
        return await handleApiRequest(options.state, request, url);
      } catch (error) {
        return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 500 });
      }
    },
  });
}

function createAppRouter(state: ServerState) {
  return orpc.router({
    config: orpc.handler(() => configPayload()),
    cwd: orpc.handler(() => cwdPayload()),
    commands: orpc.handler(() => commandPresetsPayload()),
    agentSessions: {
      recent: orpc.handler(() => readRecentAgentSessions()),
    },
    codexSessions: {
      recent: orpc.handler(() => readRecentCodexSessions()),
    },
    sessions: {
      list: orpc.handler(() => sessionsListPayload(state)),
      create: orpc.input(createSessionBodySchema).handler(({ input }) => createSessionPayload(input)),
      get: orpc.input(sessionIdInputSchema).handler(({ input }) => sessionPayloadById(state, input.sessionId)),
      stdout: orpc.input(stdoutSessionInputSchema).handler(({ input }) => stdoutSessionPayload(state, input)),
      recovery: orpc.input(sessionIdInputSchema).handler(({ input }) => sessionRecoveryPayload(state, input.sessionId)),
      recover: orpc.input(sessionIdInputSchema).handler(({ input }) => recoverStoredSessionPayload(state, input.sessionId)),
      archive: orpc.input(sessionIdInputSchema).handler(({ input }) => archiveSessionPayload(state, input.sessionId)),
      send: orpc.input(sendSessionInputSchema).handler(({ input }) => sendSessionPayload(state, input)),
      key: orpc.input(keySessionInputSchema).handler(({ input }) => keySessionPayload(state, input)),
      resize: orpc.input(resizeSessionInputSchema).handler(({ input }) => resizeSessionPayload(state, input)),
      kill: orpc.input(sessionIdInputSchema).handler(({ input }) => killSessionPayload(state, input.sessionId)),
      sdkRefresh: orpc.input(sessionIdInputSchema).handler(({ input }) => refreshSessionSdkPayload(state, input.sessionId)),
      sdkSummarize: orpc.input(sessionIdInputSchema).handler(({ input }) => summarizeSessionSdkPayload(state, input.sessionId)),
    },
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

async function handleApiRequest(state: ServerState, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return Response.json(configPayload());
  }

  if (request.method === "GET" && url.pathname === "/api/cwd") {
    return Response.json(cwdPayload());
  }

  if (request.method === "GET" && url.pathname === "/api/commands") {
    return Response.json(commandPresetsPayload());
  }

  if (request.method === "GET" && url.pathname === "/api/agent-sessions/recent") {
    return Response.json(await readRecentAgentSessions());
  }

  if (request.method === "GET" && url.pathname === "/api/codex-sessions/recent") {
    return Response.json(readRecentCodexSessions());
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return Response.json(sessionsListPayload(state));
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    return Response.json(await createSessionPayload(await request.json() as CreateSessionBody));
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return new Response("not found", { status: 404 });
  }

  const sessionId = match[1] || "";
  const action = match[2] || "";

  if (request.method === "GET" && action === "recovery") {
    return jsonOrRpcError(() => sessionRecoveryPayload(state, sessionId));
  }

  if (request.method === "POST" && action === "recover") {
    return await jsonOrRpcErrorAsync(() => recoverStoredSessionPayload(state, sessionId));
  }

  if (request.method === "POST" && action === "archive") {
    return await jsonOrRpcErrorAsync(() => archiveSessionPayload(state, sessionId));
  }

  const session = state.sessions.get(sessionId) || await reconnectSession(state, sessionId);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (request.method === "GET" && !action) {
    return Response.json(getSessionPayload(session));
  }

  if (request.method === "GET" && action === "events") {
    return streamSessionEvents(session);
  }

  if (request.method === "GET" && action === "stdout") {
    const after = Number(url.searchParams.get("after") || 0);
    return Response.json(await stdoutSessionPayload(state, { sessionId, after }));
  }

  if (request.method === "GET" && (action === "tuishot" || action === "tuishot.svg")) {
    return createTuishotResponse(session);
  }

  if (request.method === "POST" && action === "send") {
    return Response.json(await sendSessionPayload(state, {
      sessionId,
      ...await request.json() as Omit<SendSessionInput, "sessionId">,
    }));
  }

  if (request.method === "POST" && action === "attachments") {
    return await saveSessionAttachment(session, request, url);
  }

  if (request.method === "POST" && action === "sdk-refresh") {
    return Response.json(await refreshSessionSdkPayload(state, sessionId));
  }

  if (request.method === "POST" && action === "sdk-summarize") {
    return Response.json(await summarizeSessionSdkPayload(state, sessionId));
  }

  if (request.method === "POST" && action === "key") {
    return Response.json(await keySessionPayload(state, {
      sessionId,
      ...await request.json() as Omit<KeySessionInput, "sessionId">,
    }));
  }

  if (request.method === "POST" && action === "resize") {
    return Response.json(await resizeSessionPayload(state, {
      sessionId,
      ...await request.json() as Omit<ResizeSessionInput, "sessionId">,
    }));
  }

  if (request.method === "POST" && action === "kill") {
    return Response.json(await killSessionPayload(state, sessionId));
  }

  return new Response("not found", { status: 404 });
}

function configPayload() {
  return {
    pageLoadToasts: process.env.TUIUI_PAGE_LOAD_TOASTS === "1",
  };
}

function cwdPayload() {
  return {
    cwd: fs.realpathSync(process.cwd()),
    homeDir: os.homedir(),
    homeDirs: [os.homedir(), realpathIfPossible(os.homedir())],
  };
}

function commandPresetsPayload(): CommandPresetPayload[] {
  return [
    { id: "custom", label: "Custom", command: "", args: [], fakeAgent: "" },
    { id: "coordinator", label: "Coordinator", command: "codex", args: coordinatorCodexArgs(), fakeAgent: "", coordinator: true },
    { id: "opencode", label: "OpenCode", command: "opencode", args: [], fakeAgent: "" },
    { id: "codex", label: "Codex", command: "codex", args: [], fakeAgent: "" },
    { id: "claude", label: "Claude", command: "claude", args: [], fakeAgent: "" },
    { id: "fake-opencode", label: "Fake OpenCode", command: "opencode", args: [], fakeAgent: "opencode" },
    { id: "fake-codex", label: "Fake Codex", command: "codex", args: [], fakeAgent: "codex" },
    { id: "fake-claude", label: "Fake Claude", command: "claude", args: [], fakeAgent: "claude" },
    { id: "ghui", label: "ghui", command: "ghui", args: [], fakeAgent: "" },
  ];
}

function createCoordinatorState(): CoordinatorState {
  return {
    sessionId: "",
    mcpToken: process.env.TUIUI_COORDINATOR_MCP_TOKEN || randomBytes(32).toString("hex"),
    subscriptions: new Map(),
    lastAgentStatuses: new Map(),
    consumedPromptAgentGrants: new Set(),
  };
}

function createCoordinatorMcpHandlers(state: ServerState): CoordinatorMcpHandlers {
  return {
    listAgents: () => listCoordinatorAgents(state),
    getBriefing: (agentId) => coordinatorBriefingById(state, agentId),
    promptAgent: async (agentId, prompt) => await coordinatorPromptAgent(state, agentId, prompt),
    subscribe: (agentId) => coordinatorSubscribeAgent(state, agentId),
    findClashes: () => findCoordinatorClashes(listCoordinatorAgents(state)),
  };
}

function authorizedCoordinatorMcpRequest(state: ServerState, request: Request) {
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${state.coordinator.mcpToken}`;
}

function coordinatorCodexArgs() {
  return [
    "-c",
    `mcp_servers.tuiui_coordinator.url="${baseUrl}/mcp/coordinator"`,
    "-c",
    `mcp_servers.tuiui_coordinator.bearer_token_env_var="TUIUI_COORDINATOR_MCP_TOKEN"`,
    "-c",
    `mcp_servers.tuiui_coordinator.enabled_tools=["listAgents","getBriefing","promptAgent","subscribe","findClashes"]`,
    "-c",
    "mcp_servers.tuiui_coordinator.tool_timeout_sec=20",
    "-c",
    "mcp_servers.tuiui_coordinator.required=true",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "on-request",
    createCoordinatorInitialPrompt(),
  ];
}

function createCoordinatorInitialPrompt() {
  return [
    "You are TUI UI's coordinator agent. You are a normal Codex session rendered in TUI UI, but you have extra MCP tools for supervising other agents.",
    "Use listAgents and findClashes before answering broad status or clash questions. Use getBriefing when an agent needs more detail.",
    "Only call promptAgent when the human explicitly asks you to tell, ask, prompt, message, or send something to a specific agent. The server will reject promptAgent if the latest human prompt did not authorize that target.",
    "Subscribe to an agent when the human wants you to monitor it. When TUI UI sends you an idle-event prompt, update your situational awareness; do not prompt worker agents just because an idle event arrived.",
    "You may inspect, brief, subscribe, and forward user-visible prompts. Do not kill, archive, rebase, merge, push, close PRs, rewrite history, or perform destructive coordination.",
  ].join("\n\n");
}

function listCoordinatorAgents(state: ServerState): CoordinatorAgent[] {
  return buildCoordinatorAgents(listCoordinatorAgentSources(state));
}

function listCoordinatorAgentSources(state: ServerState): CoordinatorAgentSource[] {
  const managedSources = [...state.sessions.values()]
    .filter((session) =>
      session.id !== state.coordinator.sessionId &&
      !session.archivedAtMs &&
      !state.sessionStore.getSession(session.id)?.archivedAtMs
    )
    .map((session) => managedCoordinatorAgentSource({
      id: session.id,
      title: sessionDisplayTitle(session),
      command: session.command,
      args: session.args,
      cwd: session.cwd,
      status: runtimeSessionStatus(session),
      lifecycle: session.lifecycle,
      updatedAt: session.updatedAt,
      lastOutputAt: session.lastOutputAt,
      routePath: `/sessions/${session.id}`,
      sdk: session.sdk,
      semanticPrompt: session.semantic.prompt,
    }));
  const managedCodexIds = new Set(managedSources
    .map((source) => source.sdk?.externalSessionId || "")
    .filter(Boolean));
  return [
    ...managedSources,
    ...safeRecentCodexSessions()
      .filter((session) => !managedCodexIds.has(session.id))
      .map(recentCodexCoordinatorAgentSource),
  ].sort((left, right) => Date.parse(right.lastOutputAt || right.updatedAt) - Date.parse(left.lastOutputAt || left.updatedAt));
}

function coordinatorBriefingById(state: ServerState, agentId: string) {
  const source = coordinatorSourceById(state, agentId);
  const agent = listCoordinatorAgents(state).find((candidate) => candidate.id === agentId);
  if (!source || !agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  return buildCoordinatorBriefing(source, agent);
}

async function coordinatorPromptAgent(state: ServerState, agentId: string, prompt: string) {
  const session = state.sessions.get(agentId);
  if (!session || session.archivedAtMs || session.lifecycle !== "running") {
    throw new Error(`Agent is not a live managed session: ${agentId}`);
  }
  if (agentId === state.coordinator.sessionId) {
    throw new Error("The coordinator cannot prompt itself");
  }
  const authorization = coordinatorLatestPromptAgentAuthorization(state, agentId);
  if (!authorization) {
    throw new Error(`promptAgent is not authorized for ${agentId} by the coordinator session's latest human prompt`);
  }
  if (state.coordinator.consumedPromptAgentGrants.has(authorization.grantKey)) {
    throw new Error(`promptAgent authorization for ${agentId} has already been used for the coordinator session's latest human prompt`);
  }
  const text = String(prompt || "").trim();
  if (!text) {
    throw new Error("prompt is required");
  }
  await sendToSession(state, session, text, true);
  state.coordinator.consumedPromptAgentGrants.add(authorization.grantKey);
  const createdAt = new Date().toISOString();
  return {
    ok: true,
    agentId,
    prompt: text,
    message: `Prompt sent to ${sessionDisplayTitle(session)}.`,
    createdAt,
  };
}

function coordinatorSubscribeAgent(state: ServerState, agentId: string) {
  const source = coordinatorSourceById(state, agentId);
  if (!source) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  if (agentId === state.coordinator.sessionId) {
    throw new Error("The coordinator cannot subscribe to itself");
  }
  const session = state.sessions.get(agentId);
  if (!session || session.archivedAtMs || session.lifecycle !== "running") {
    throw new Error(`Agent is not a running managed session and cannot emit idle events: ${agentId}`);
  }
  const createdAt = new Date().toISOString();
  state.coordinator.subscriptions.set(agentId, { agentId, createdAt });
  state.coordinator.lastAgentStatuses.set(agentId, runtimeSessionStatus(session));
  scheduleCoordinatorIdleCheck(state, session);
  return {
    ok: true,
    agentId,
    message: `Subscribed to ${agentId}.`,
    createdAt,
  };
}

function coordinatorSourceById(state: ServerState, agentId: string) {
  return listCoordinatorAgentSources(state).find((source) => source.id === agentId) || null;
}

function safeRecentCodexSessions() {
  try {
    return readRecentCodexSessions();
  } catch {
    return [];
  }
}

function runtimeSessionStatus(session: RuntimeSession): SessionStatus {
  if (session.lifecycle === "exited") {
    return "exited";
  }
  return Date.now() - new Date(session.lastOutputAt).getTime() < idleThresholdMs ? "busy" : "idle";
}

async function queueCoordinatorEventPrompt(state: ServerState, prompt: string) {
  const coordinator = state.sessions.get(state.coordinator.sessionId);
  if (!coordinator || coordinator.archivedAtMs || coordinator.lifecycle !== "running") {
    return;
  }
  await sendToSession(state, coordinator, createCoordinatorEventPrompt(prompt), true);
}

function createCoordinatorEventPrompt(prompt: string) {
  return [
    "[tuiui coordinator event]",
    prompt,
    "Use getBriefing for this agent if you need details. Do not call promptAgent unless the latest human prompt explicitly asked you to forward a message to that exact agent.",
  ].join("\n\n");
}

function coordinatorLatestPromptAgentAuthorization(state: ServerState, agentId: string) {
  const coordinator = state.sessions.get(state.coordinator.sessionId);
  if (!coordinator) {
    return null;
  }
  const latestPrompt = [...coordinator.stdinEvents].reverse().find((event) => Boolean(event.text.trim()));
  if (!latestPrompt) {
    return null;
  }
  if (!findExplicitPromptAgentTargets(listCoordinatorAgents(state), latestPrompt.text).includes(agentId)) {
    return null;
  }
  return { grantKey: `${latestPrompt.id}:${agentId}` };
}

function sessionsListPayload(state: ServerState) {
  return [...state.sessions.values()]
    .filter((session) => !session.archivedAtMs && !state.sessionStore.getSession(session.id)?.archivedAtMs)
    .map(toSessionListItem);
}

async function createSessionPayload(body: CreateSessionBody) {
  const coordinator = body.coordinator === true;
  const command = coordinator ? "codex" : body.command || "";
  const args = coordinator ? coordinatorCodexArgs() : Array.isArray(body.args) ? body.args.map(String) : [];
  const env = body.env || {};
  if (coordinator) {
    env.TUIUI_COORDINATOR_MCP_TOKEN = state.coordinator.mcpToken;
  }
  const session = await createSession({
    id: createSessionId(),
    command,
    args,
    cwd: body.cwd || process.cwd(),
    env,
    cols: Number(body.cols || defaultCols),
    rows: Number(body.rows || defaultRows),
    fakeAgent: isAgentName(body.fakeAgent) ? body.fakeAgent : "",
    backend: resolveBackendForLaunch(body.backend),
    launchCommand: formatCommandLine(command, args),
    coordinator,
  });
  return { id: session.id, url: `${baseUrl}/sessions/${session.id}` };
}

async function sessionPayloadById(state: ServerState, sessionId: string) {
  return getSessionPayload(await liveSessionById(state, sessionId));
}

async function stdoutSessionPayload(state: ServerState, input: StdoutSessionInput) {
  const session = await liveSessionById(state, input.sessionId);
  const after = Number(input.after || 0);
  return {
    events: session.stdoutEvents.filter((event) => event.id > after),
  };
}

function sessionRecoveryPayload(state: ServerState, sessionId: string) {
  const session = state.sessionStore.getSession(sessionId);
  if (!session) {
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }
  return {
    id: session.id,
    cwd: session.cwd,
    launchCommand: session.launchCommand,
    createdAtMs: session.createdAtMs,
    archivedAtMs: session.archivedAtMs,
    recoveryCommand: session.recoveryCommand,
    recoveryCreatedAtMs: session.recoveryCreatedAtMs,
    recoverable: Boolean(session.recoveryCommand),
  };
}

async function recoverStoredSessionPayload(state: ServerState, sessionId: string) {
  const liveSession = state.sessions.get(sessionId) || await reconnectSession(state, sessionId);
  if (liveSession) {
    return { id: liveSession.id, url: `${baseUrl}/sessions/${liveSession.id}` };
  }

  const storedSession = state.sessionStore.getSession(sessionId);
  if (!storedSession) {
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }
  if (storedSession.archivedAtMs) {
    throw new ORPCError("CONFLICT", { message: "session is archived" });
  }
  if (!storedSession.recoveryCommand) {
    throw new ORPCError("CONFLICT", { message: "session is known, but no recovery command is available yet" });
  }

  const recovery = parseCommandLine(storedSession.recoveryCommand);
  if (!recovery.command) {
    throw new ORPCError("CONFLICT", { message: "stored recovery command is empty" });
  }

  const session = await createSession({
    id: storedSession.id,
    command: recovery.command,
    args: recovery.args,
    cwd: storedSession.cwd,
    env: {},
    cols: defaultCols,
    rows: defaultRows,
    fakeAgent: "",
    backend: resolveBackendForLaunch(""),
    launchCommand: storedSession.launchCommand,
    coordinator: false,
  });
  return { id: session.id, url: `${baseUrl}/sessions/${session.id}` };
}

async function archiveSessionPayload(state: ServerState, sessionId: string) {
  const session = state.sessions.get(sessionId) || await reconnectSession(state, sessionId);
  const storedSession = state.sessionStore.getSession(sessionId);
  if (!session && !storedSession) {
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }

  const archivedAtMs = Date.now();
  state.sessionStore.archiveSession({ sessionId, archivedAtMs });
  if (session) {
    session.archivedAtMs = archivedAtMs;
    clearIdleStatusTimer(session);
    publishSession(session);
    state.sessions.delete(session.id);
    await killSession(session);
  }
  return { ok: true, archivedAtMs };
}

async function sendSessionPayload(state: ServerState, input: SendSessionInput) {
  const session = await liveSessionById(state, input.sessionId);
  await sendToSession(state, session, String(input.text || ""), input.submit !== false);
  return { ok: true };
}

async function keySessionPayload(state: ServerState, input: KeySessionInput) {
  const session = await liveSessionById(state, input.sessionId);
  await sendToSession(state, session, resolveKeySequence(String(input.key || "")), false);
  return { ok: true };
}

async function resizeSessionPayload(state: ServerState, input: ResizeSessionInput) {
  const session = await liveSessionById(state, input.sessionId);
  await resizeSession(session, Number(input.cols || session.cols), Number(input.rows || session.rows));
  return { ok: true };
}

async function killSessionPayload(state: ServerState, sessionId: string) {
  await killSession(await liveSessionById(state, sessionId));
  return { ok: true };
}

async function refreshSessionSdkPayload(state: ServerState, sessionId: string) {
  const session = await liveSessionById(state, sessionId);
  await refreshSessionSdk(session);
  return getSessionPayload(session);
}

async function summarizeSessionSdkPayload(state: ServerState, sessionId: string) {
  const session = await liveSessionById(state, sessionId);
  startSessionBriefJob(session);
  return getSessionPayload(session);
}

async function liveSessionById(state: ServerState, sessionId: string) {
  const storedSession = state.sessionStore.getSession(sessionId);
  if (storedSession?.archivedAtMs) {
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }
  const session = state.sessions.get(sessionId) || await reconnectSession(state, sessionId);
  if (!session) {
    throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  }
  return session;
}

function jsonOrRpcError(fn: () => unknown) {
  try {
    return Response.json(fn());
  } catch (error) {
    return jsonRpcErrorResponse(error);
  }
}

async function jsonOrRpcErrorAsync(fn: () => Promise<unknown>) {
  try {
    return Response.json(await fn());
  } catch (error) {
    return jsonRpcErrorResponse(error);
  }
}

function jsonRpcErrorResponse(error: unknown) {
  if (error instanceof ORPCError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

async function saveSessionAttachment(session: RuntimeSession, request: Request, url: URL) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file" }, { status: 400 });
  }

  const requestedName = url.searchParams.get("filename") || "";
  const fallbackName = `attachment-${new Date().toISOString().replaceAll(":", "-")}`;
  const safeName = safeAttachmentName(requestedName || file.name || fallbackName);
  const extension = path.extname(file.name || "");
  const fileName = safeName.includes(".") || !extension ? safeName : `${safeName}${extension}`;
  const attachmentDir = path.join(attachmentRoot, session.id);
  fs.mkdirSync(attachmentDir, { recursive: true });

  const filePath = nextAvailableAttachmentPath(attachmentDir, fileName);
  await Bun.write(filePath, file);

  return Response.json({
    path: filePath,
    name: path.basename(filePath),
    originalName: file.name || "",
    type: file.type || "",
    size: file.size,
  });
}

function safeAttachmentName(name: string) {
  const cleaned = path.basename(name)
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll("\0", "")
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `attachment-${Date.now()}`;
  }

  return cleaned;
}

function nextAvailableAttachmentPath(directory: string, fileName: string) {
  let candidate = path.join(directory, fileName);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension) || "attachment";
  for (let index = 2; ; index += 1) {
    candidate = path.join(directory, `${stem}-${index}${extension}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

async function createSession(input: CreateSessionInput) {
  if (!input.command.trim()) {
    throw new Error("command is required");
  }
  const cwd = path.resolve(input.cwd);
  const cwdStats = fs.statSync(cwd);
  if (!cwdStats.isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }

  const id = input.id;
  const createdAtMs = Date.now();
  const now = new Date(createdAtMs).toISOString();
  const cols = Math.max(40, Math.min(240, Math.round(input.cols)));
  const rows = Math.max(12, Math.min(80, Math.round(input.rows)));
  const terminal = new HeadlessTerminal({ cols, rows, scrollback: 2_000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  let command = input.command;
  let args = input.args;
  const inheritedEnv = terminalBaseEnv(process.env, input.env);
  let env: Record<string, string> = {
    ...inheritedEnv,
    ...input.env,
    TERM: input.env.TERM || "xterm-256color",
    COLORTERM: input.env.COLORTERM || "truecolor",
  };
  let fakeAgent: FakeAgent | null = null;

  if (input.fakeAgent) {
    fakeAgent = await createTestingFakeAgent();
    prepareFakeAgentWorkspace(cwd);
    const fakeSpawn = fakeAgent.getSpawnArgs(input.fakeAgent);
    command = fakeSpawn.command;
    args = [...fakeSpawn.args, ...input.args];
    const fakeAgentRoot = path.join("/tmp", "tuiui-fakeagent", id);
    env = {
      ...env,
      ...fakeSpawn.env,
      XDG_CONFIG_HOME: path.join(fakeAgentRoot, "config"),
      XDG_DATA_HOME: path.join(fakeAgentRoot, "data"),
      CLAUDE_CONFIG_DIR: path.join(fakeAgentRoot, "claude"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    };
  }

  const sdk = await prepareSessionSdk(command, args, env);
  command = sdk.command;
  args = sdk.args;

  const session: RuntimeSession = {
    id,
    title: input.coordinator ? "coordinator" : path.basename(command),
    command,
    args,
    cwd,
    env,
    archivedAtMs: null,
    createdAt: now,
    updatedAt: now,
    lastOutputAt: now,
    lifecycle: "running",
    exitCode: null,
    cols,
    rows,
    terminal,
    serializer,
    outputDecoder: new StringDecoder("utf8"),
    backend: createPendingBackend(),
    writeQueue: Promise.resolve(),
    renderedText: "",
    renderedHtml: "",
    renderedAnsi: "",
    screenVersion: 0,
    snapshotEventId: 0,
    blocks: analyzeTerminalBlocks(terminal),
    semantic: analyzeTerminalScreen("", { cols, rows }),
    sdk: sdk.payload,
    sdkSummaryJob: null,
    stdinEvents: [],
    stdoutEvents: [],
    redrawGate: createRedrawGate(true),
    idleStatusTimer: null,
    subscribers: new Set(),
    fakeAgent,
  };

  state.sessions.set(id, session);
  if (input.coordinator) {
    state.coordinator.sessionId = id;
  }
  state.sessionStore.recordSession({
    id,
    cwd,
    launchCommand: input.launchCommand,
    createdAtMs,
  });
  scheduleRedrawGateFlush(session);

  session.backend = await createSessionBackend(input.backend, {
    id,
    command,
    args,
    cwd,
    env,
    createdAt: now,
    cols,
    rows,
    onData(chunk) {
      const text = typeof chunk === "string" ? chunk : session.outputDecoder.write(Buffer.from(chunk));
      session.writeQueue = session.writeQueue.then(() => appendOutput(state, session, text));
    },
  });

  session.backend.exited.then((exitCode: number | null) => {
    session.writeQueue = session.writeQueue
      .then(async () => {
        const flushed = session.outputDecoder.end();
        if (flushed) {
          await appendOutput(state, session, flushed);
        }
        flushRedrawGate(session);
        session.lifecycle = "exited";
        session.exitCode = exitCode;
        session.updatedAt = new Date().toISOString();
        await session.fakeAgent?.[Symbol.asyncDispose]();
        publishSession(session);
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  });

  publishSession(session);
  scheduleSessionRecoveryDiscovery(session);
  return session;
}

async function reconnectSession(state: ServerState, id: string) {
  const storedSession = state.sessionStore.getSession(id);
  if (storedSession?.archivedAtMs) {
    return null;
  }
  if (!id || !tmuxHasSession(id)) {
    return null;
  }
  let session: RuntimeSession | null = null;
  const reconnected = await reconnectTmuxBackend({
    id,
    onData(chunk) {
      if (!session) {
        return;
      }
      session.writeQueue = session.writeQueue.then(() => appendOutput(state, session!, chunk));
    },
  });
  if (!reconnected) {
    return null;
  }

  const metadata = reconnected.metadata;
  const cols = Math.max(40, Math.min(240, Math.round(metadata.cols)));
  const rows = Math.max(12, Math.min(80, Math.round(metadata.rows)));
  const terminal = new HeadlessTerminal({ cols, rows, scrollback: 2_000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  const sdk = await prepareSessionSdk(metadata.command, metadata.args, minimalEnv(process.env));
  const now = new Date().toISOString();
  session = {
    id,
    title: path.basename(sdk.command),
    command: sdk.command,
    args: sdk.args,
    cwd: metadata.cwd,
    env: minimalEnv(process.env),
    archivedAtMs: null,
    createdAt: metadata.createdAt,
    updatedAt: now,
    lastOutputAt: now,
    lifecycle: "running",
    exitCode: null,
    cols,
    rows,
    terminal,
    serializer,
    outputDecoder: new StringDecoder("utf8"),
    backend: reconnected.handle,
    writeQueue: Promise.resolve(),
    renderedText: "",
    renderedHtml: "",
    renderedAnsi: "",
    screenVersion: 0,
    snapshotEventId: 0,
    blocks: analyzeTerminalBlocks(terminal),
    semantic: analyzeTerminalScreen("", { cols, rows }),
    sdk: sdk.payload,
    sdkSummaryJob: null,
    stdinEvents: [],
    stdoutEvents: [],
    redrawGate: createRedrawGate(true),
    idleStatusTimer: null,
    subscribers: new Set(),
    fakeAgent: null,
  };
  state.sessions.set(id, session);
  scheduleRedrawGateFlush(session);
  if (reconnected.handle.initialCapture) {
    await appendOutput(state, session, reconnected.handle.initialCapture);
  }
  reconnected.handle.exited.then((exitCode) => {
    session!.writeQueue = session!.writeQueue
      .then(async () => {
        const flushed = session!.outputDecoder.end();
        if (flushed) {
          await appendOutput(state, session!, flushed);
        }
        flushRedrawGate(session!);
        session!.lifecycle = "exited";
        session!.exitCode = exitCode;
        session!.updatedAt = new Date().toISOString();
        publishSession(session!);
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  });
  publishSession(session);
  return session;
}

async function createSessionBackend(inputBackend: SessionBackendName, input: {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  createdAt: string;
  cols: number;
  rows: number;
  onData(chunk: string | Uint8Array): void;
}): Promise<SessionBackendHandle> {
  if (inputBackend === "tmux") {
    return await createTmuxBackend({
      id: input.id,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      createdAt: input.createdAt,
      cols: input.cols,
      rows: input.rows,
      onData(chunk) {
        input.onData(chunk);
      },
    });
  }

  const child: any = Bun.spawn([input.command, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    terminal: {
      cols: input.cols,
      rows: input.rows,
      data(_term: unknown, chunk: string | Uint8Array) {
        input.onData(chunk);
      },
    },
  });
  return {
    name: "bun",
    process: child,
    exited: child.exited,
    write(text: string) {
      child.terminal.write(text);
    },
    resize(cols: number, rows: number) {
      child.terminal.resize(cols, rows);
    },
    kill(signal?: string) {
      child.kill((signal || "SIGTERM") as any);
    },
    async dispose() {},
  };
}

function createPendingBackend(): SessionBackendHandle {
  return {
    name: "bun",
    process: null,
    exited: Promise.resolve(null),
    write() {
      throw new Error("session backend is not ready");
    },
    resize() {
      throw new Error("session backend is not ready");
    },
    kill() {},
    async dispose() {},
  };
}

async function writeSessionBackend(session: RuntimeSession, text: string) {
  await session.backend.write(text);
}

async function appendOutput(state: ServerState, session: RuntimeSession, chunk: string) {
  if (!chunk) {
    return;
  }
  await writeToTerminal(session.terminal, chunk);
  const now = new Date().toISOString();
  const renderedText = renderTerminalText(session);
  session.renderedText = renderedText;
  session.renderedHtml = renderTerminalHtml(session);
  session.renderedAnsi = renderTerminalAnsi(session);
  session.blocks = analyzeTerminalBlocks(session.terminal);
  session.semantic = analyzeTerminalScreen(renderedText, { cols: session.cols, rows: session.rows });
  session.updatedAt = now;
  session.lastOutputAt = now;
  session.stdoutEvents.push({
    id: state.nextStdoutEventId,
    chunk,
    displayText: sanitizeTerminalChunk(chunk),
    createdAt: now,
  });
  state.nextStdoutEventId += 1;
  scheduleCoordinatorIdleCheck(state, session);
  if (session.redrawGate.active) {
    scheduleRedrawGateFlush(session);
    return;
  }
  publishSession(session);
}

function createRedrawGate(active: boolean): RedrawGate {
  return {
    active,
    startedAfterEventId: 0,
    quietTimer: null,
    maxTimer: null,
  };
}

function beginRedrawGate(session: RuntimeSession) {
  session.redrawGate.active = true;
  session.redrawGate.startedAfterEventId = latestStdoutEventId(session);
  scheduleRedrawGateFlush(session);
  publishSession(session);
}

function scheduleRedrawGateFlush(session: RuntimeSession) {
  const gate = session.redrawGate;
  if (!gate.active) {
    return;
  }
  if (gate.quietTimer) {
    clearTimeout(gate.quietTimer);
  }
  gate.quietTimer = setTimeout(() => {
    flushRedrawGate(session);
  }, redrawQuietMs);
  if (!gate.maxTimer) {
    gate.maxTimer = setTimeout(() => {
      flushRedrawGate(session);
    }, redrawMaxMs);
  }
}

function flushRedrawGate(session: RuntimeSession) {
  const gate = session.redrawGate;
  if (!gate.active) {
    return;
  }
  gate.active = false;
  if (gate.quietTimer) {
    clearTimeout(gate.quietTimer);
    gate.quietTimer = null;
  }
  if (gate.maxTimer) {
    clearTimeout(gate.maxTimer);
    gate.maxTimer = null;
  }
  session.screenVersion += 1;
  session.snapshotEventId = latestStdoutEventId(session);
  session.renderedAnsi = renderTerminalAnsi(session);
  publishSession(session);
}

function latestStdoutEventId(session: RuntimeSession) {
  return session.stdoutEvents[session.stdoutEvents.length - 1]?.id || 0;
}

async function writeToTerminal(terminal: HeadlessTerminal, chunk: string) {
  await new Promise<void>((resolve) => {
    terminal.write(chunk, () => resolve());
  });
}

function renderTerminalText(session: RuntimeSession) {
  const buffer = session.terminal.buffer.active;
  const start = Math.max(0, buffer.length - session.rows);
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) || "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function renderTerminalHtml(session: RuntimeSession) {
  return session.serializer.serializeAsHTML({ includeGlobalBackground: true, scrollback: 0 });
}

function renderTerminalAnsi(session: RuntimeSession) {
  return session.serializer.serialize({
    scrollback: Math.min(terminalScrollbackSnapshotRows, session.terminal.buffer.active.baseY),
  });
}

async function sendToSession(state: ServerState, session: RuntimeSession, text: string, submit: boolean) {
  if (session.lifecycle !== "running") {
    throw new Error("session is not running");
  }
  flushRedrawGate(session);
  const now = new Date().toISOString();
  session.stdinEvents.push({
    id: state.nextStdinEventId,
    text,
    createdAt: now,
  });
  state.nextStdinEventId += 1;
  session.updatedAt = now;
  if (submit && text.trim()) {
    updateSessionTitleFromUserPrompt(session, text);
  }

  if (submit) {
    await writeSessionSubmitChunks(session, composerSubmitChunks(session.command, text));
    publishSession(session);
    return;
  }

  if (!submit && usesLfCrSubmit(session.command) && text === "\r") {
    await writeLfCrSubmit(session);
    publishSession(session);
    return;
  }

  await writeSessionBackend(session, text);
  publishSession(session);
}

async function writeSessionSubmitChunks(session: RuntimeSession, chunks: string[]) {
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) {
      await delay(80);
    }
    await writeSessionBackend(session, chunks[index] || "");
  }
}

async function writeLfCrSubmit(session: RuntimeSession) {
  await delay(80);
  await writeSessionBackend(session, "\n");
  await delay(80);
  await writeSessionBackend(session, "\r");
}

async function resizeSession(session: RuntimeSession, cols: number, rows: number) {
  beginRedrawGate(session);
  session.cols = Math.max(40, Math.min(240, Math.round(cols)));
  session.rows = Math.max(12, Math.min(80, Math.round(rows)));
  session.terminal.resize(session.cols, session.rows);
  await session.backend.resize(session.cols, session.rows);
  session.renderedText = renderTerminalText(session);
  session.renderedHtml = renderTerminalHtml(session);
  session.renderedAnsi = renderTerminalAnsi(session);
  session.blocks = analyzeTerminalBlocks(session.terminal);
  session.semantic = analyzeTerminalScreen(session.renderedText, { cols: session.cols, rows: session.rows });
  session.updatedAt = new Date().toISOString();
}

async function killSession(session: RuntimeSession) {
  if (session.lifecycle === "exited") {
    return;
  }
  try {
    await writeSessionBackend(session, "\x03");
  } catch {
  }
  await delay(150);
  try {
    await session.backend.kill("SIGTERM");
  } catch {
  }
}

function publishSession(session: RuntimeSession) {
  const payload = getSessionPayload(session);
  observeCoordinatorSessionStatus(state, session, payload);
  scheduleIdleStatusPublish(session, payload);
  for (const subscriber of session.subscribers) {
    subscriber(payload);
  }
}

function scheduleCoordinatorIdleCheck(state: ServerState, session: RuntimeSession) {
  if (!state.coordinator.subscriptions.has(session.id)) {
    return;
  }
  setTimeout(() => {
    if (!state.sessions.has(session.id) || session.lifecycle !== "running") {
      return;
    }
    const payload = getSessionPayload(session);
    observeCoordinatorSessionStatus(state, session, payload);
  }, idleThresholdMs + 100);
}

function observeCoordinatorSessionStatus(state: ServerState, session: RuntimeSession, payload: SessionPayload) {
  const previous = state.coordinator.lastAgentStatuses.get(session.id);
  state.coordinator.lastAgentStatuses.set(session.id, payload.status);
  if (
    previous !== "busy" ||
    payload.status !== "idle" ||
    !state.coordinator.subscriptions.has(session.id)
  ) {
    return;
  }
  const text = `Agent ${payload.id} (${payload.title}) went idle. Latest task: ${payload.sdk.summary?.latestUserText || payload.semantic.prompt || payload.command}`;
  void queueCoordinatorEventPrompt(state, text);
}

function scheduleIdleStatusPublish(session: RuntimeSession, payload: SessionPayload) {
  clearIdleStatusTimer(session);
  if (payload.archivedAtMs || payload.lifecycle !== "running" || payload.status !== "busy") {
    return;
  }
  scheduleIdleStatusTimer(session);
}

function scheduleIdleStatusTimer(session: RuntimeSession) {
  const lastOutputAtMs = new Date(session.lastOutputAt).getTime();
  const delayMs = Math.max(0, lastOutputAtMs + idleThresholdMs - Date.now()) + 25;
  session.idleStatusTimer = setTimeout(() => {
    session.idleStatusTimer = null;
    if (session.archivedAtMs || session.lifecycle !== "running") {
      return;
    }
    if (Date.now() - new Date(session.lastOutputAt).getTime() < idleThresholdMs) {
      scheduleIdleStatusTimer(session);
      return;
    }
    publishSession(session);
  }, delayMs);
}

function clearIdleStatusTimer(session: RuntimeSession) {
  if (!session.idleStatusTimer) {
    return;
  }
  clearTimeout(session.idleStatusTimer);
  session.idleStatusTimer = null;
}

function streamSessionEvents(session: RuntimeSession) {
  const encoder = new TextEncoder();
  let send = (_payload: SessionPayload) => {};
  const stream = new ReadableStream({
    start(controller) {
      send = (payload: SessionPayload) => {
        controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      session.subscribers.add(send);
      send(getSessionPayload(session));
    },
    cancel() {
      session.subscribers.delete(send);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function getSessionPayload(session: RuntimeSession): SessionPayload {
  const status = runtimeSessionStatus(session);
  const latestEventId = latestStdoutEventId(session);
  const suppressRedrawOutput = session.redrawGate.active;
  const emptyTerminal = suppressRedrawOutput
    ? new HeadlessTerminal({ cols: session.cols, rows: session.rows, allowProposedApi: true })
    : null;
  return {
    id: session.id,
    title: sessionDisplayTitle(session),
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    archivedAtMs: session.archivedAtMs,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOutputAt: session.lastOutputAt,
    lifecycle: session.lifecycle,
    status,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
    renderedText: suppressRedrawOutput ? "" : session.renderedText,
    renderedHtml: suppressRedrawOutput ? "" : session.renderedHtml,
    renderedAnsi: suppressRedrawOutput ? "" : session.renderedAnsi,
    screenVersion: session.screenVersion,
    snapshotEventId: suppressRedrawOutput ? session.snapshotEventId : latestEventId,
    redrawActive: session.redrawGate.active,
    blocks: suppressRedrawOutput ? analyzeTerminalBlocks(emptyTerminal!) : session.blocks,
    semantic: suppressRedrawOutput ? analyzeTerminalScreen("", { cols: session.cols, rows: session.rows }) : session.semantic,
    sdk: session.sdk,
    stdinEvents: session.stdinEvents.slice(-100),
    stdoutEvents: suppressRedrawOutput ? [] : session.stdoutEvents.slice(-200),
  };
}

function sessionDisplayTitle(session: RuntimeSession) {
  const snapshotTitle = snapshotTitleForSession(session.sdk.summary);
  if (snapshotTitle) {
    return promptTitleForSession(session, snapshotTitle);
  }
  return recentSessionPreviewText(session.title || "") || launchCommandTitle(session);
}

function snapshotTitleForSession(summary: AgentSessionSummary | null) {
  if (!summary) {
    return "";
  }
  const preview = recentSessionPreviewFromMessages(summary.transcript);
  const initialUserText = preview.initialUserText;
  const latestUserText = preview.latestUserText || recentSessionPreviewText(summary.latestUserText);
  const title = recentSessionPreviewText(summary.title);
  if (title && !isGenericSnapshotTitle(title) && !isInternalSnapshotTitle(title)) {
    return textIsBasicallySame(title, initialUserText) ? initialUserText : title;
  }
  return initialUserText || latestUserText;
}

function isGenericSnapshotTitle(title: string) {
  return /^(opencode session|codex thread|claude session)$/i.test(title.trim());
}

function isInternalSnapshotTitle(title: string) {
  return title.startsWith("# AGENTS.md instructions") || title.startsWith("<environment_context>");
}

function textIsBasicallySame(left: string, right: string) {
  const leftText = normalizeComparableText(left);
  const rightText = normalizeComparableText(right);
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

function updateSessionTitleFromUserPrompt(session: RuntimeSession, text: string) {
  if (!usesAgentPromptTitle(session) || !isLaunchCommandTitle(session.title, session.command)) {
    return;
  }
  session.title = promptTitleForSession(session, text);
}

function promptTitleForSession(session: RuntimeSession, text: string) {
  const prompt = abbreviatedTitlePrompt(text);
  if (!prompt) {
    return launchCommandTitle(session);
  }
  return usesAgentPromptTitle(session)
    ? `${launchCommandTitle(session)} "${prompt}"`
    : prompt;
}

function abbreviatedTitlePrompt(text: string) {
  const prompt = recentSessionPreviewText(stripVTControlCharacters(text))
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/"/g, "'");
  if (!/[A-Za-z0-9]/.test(prompt)) {
    return "";
  }
  if (prompt.length <= 80) {
    return prompt;
  }
  return `${prompt.slice(0, 77).trimEnd()}...`;
}

function isLaunchCommandTitle(title: string, command: string) {
  return recentSessionPreviewText(title || "") === launchCommandTitle({ command });
}

function launchCommandTitle(session: { command: string }) {
  return path.basename(session.command);
}

function usesAgentPromptTitle(session: RuntimeSession) {
  return (
    session.sdk.provider === "codex" ||
    session.sdk.provider === "claude" ||
    session.sdk.provider === "opencode" ||
    isCodexCommand(session.command) ||
    isClaudeCommand(session.command) ||
    isOpenCodeCommand(session.command)
  );
}

function normalizeComparableText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toSessionListItem(session: RuntimeSession) {
  return {
    id: session.id,
    title: sessionDisplayTitle(session),
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    status: getSessionPayload(session).status,
    lifecycle: session.lifecycle,
    updatedAt: session.updatedAt,
  };
}

function createTuishotResponse(session: RuntimeSession) {
  const svg = renderTerminalShotSvg(session.terminal, {
    title: `${sessionDisplayTitle(session) || session.command} tuishot`,
    fontSize: 12,
    cellWidth: 7.25,
    lineHeight: 14.2,
    padding: 10,
  });
  const filename = `${session.id}-tuishot.svg`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml;charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function createTestingFakeAgent() {
  return await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request);
      const text = parsed.lastMessage || "";
      if (/title generator/i.test(parsed.systemPrompt)) {
        return parsed.respond.text("TUI UI test");
      }
      if (/<session_brief/i.test(text)) {
        return parsed.respond.text([
          "<session_brief format=\"tuiui.sessionBrief.v1\">",
          "  <executive_summary>The session is being summarized for supervision.</executive_summary>",
          "  <initial_user_request>Answer the user's terminal prompt.</initial_user_request>",
          "  <current_state>The sidecar brief was generated from the captured transcript.</current_state>",
          "  <completed_work>",
          "    <item>Reviewed the latest user and assistant messages.</item>",
          "  </completed_work>",
          "  <files_changed>",
          "  </files_changed>",
          "  <risks_blockers>",
          "  </risks_blockers>",
          "  <suggested_next_actions>",
          "    <item>Continue from the source session if more work is needed.</item>",
          "  </suggested_next_actions>",
          "</session_brief>",
        ].join("\n"));
      }
      if (parsed.body.messages?.some((message: any) => message.role === "tool")) {
        return parsed.respond.text("the file says hi");
      }
      if (/one plus two/i.test(text)) {
        return parsed.respond.text("three");
      }
      if (/four plus five/i.test(text)) {
        return parsed.respond.text("nine");
      }
      if (/read .*hello/i.test(text)) {
        return parsed.respond.toolCall("read", { filePath: path.join("/tmp/fakeagent-test", "hello.txt") });
      }
      return parsed.respond.text(formatFakeAgentFallback(text));
    },
  });
}

function prepareFakeAgentWorkspace(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync("/tmp/fakeagent-test", { recursive: true });
  fs.writeFileSync("/tmp/fakeagent-test/hello.txt", "hi\n");
}

function readRecentCodexSessions() {
  const databasePath = resolveCodexStateDatabasePathForEnv(process.env);
  try {
    return readRecentCodexSessionsFromDatabasePath(databasePath, Date.now());
  } catch (error) {
    if (isUnavailableRecentProviderStoreError(String(error instanceof Error ? error.message : error))) {
      return [];
    }
    throw error;
  }
}

async function readRecentAgentSessions(): Promise<RecentAgentSession[]> {
  const nowMs = Date.now();
  const codexDatabasePath = resolveCodexStateDatabasePathForEnv(process.env);
  const openCodeDatabasePath = openCodeDatabasePathForEnv(process.env);
  const claudeConfigDir = claudeConfigDirForEnv(process.env);
  const claudeSessions = readRecentProviderSessions(async () => await readRecentClaudeSessions(claudeConfigDir, nowMs));
  // Let the async Claude SDK scan start before the synchronous SQLite readers block the event loop.
  await Promise.resolve();
  const results = await Promise.all([
    readRecentProviderSessions(() => readRecentCodexSessionsFromDatabasePath(codexDatabasePath, nowMs)),
    readRecentProviderSessions(() => readRecentOpenCodeSessionsFromDatabasePath(openCodeDatabasePath, nowMs)),
    claudeSessions,
  ]);
  return results
    .flat()
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt))
    .slice(0, 24);
}

function realpathIfPossible(value: string) {
  if (!value) {
    return "";
  }
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

async function readRecentProviderSessions(read: () => RecentAgentSession[] | Promise<RecentAgentSession[]>) {
  try {
    return await read();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (isUnavailableRecentProviderStoreError(message)) {
      return [];
    }
    throw error;
  }
}

function isUnavailableRecentProviderStoreError(message: string) {
  return (
    message.startsWith("Codex state database not found at ") ||
    message.startsWith("OpenCode database not found at ") ||
    message === "unable to open database file" ||
    message.includes("SQLITE_CANTOPEN")
  );
}

async function prepareSessionSdk(command: string, args: string[], env: Record<string, string>) {
  if (isCodexCommand(command)) {
    const now = new Date().toISOString();
    return {
      command,
      args,
      payload: {
        provider: "codex" as const,
        state: "ready" as const,
        baseUrl: resolveCodexStateDatabasePathForEnv(env),
        externalSessionId: "",
        status: "",
        updatedAt: now,
        error: "",
        sidecarSummary: createIdleSidecarSummary(now),
        forks: [],
        summary: null,
      },
    };
  }

  if (isClaudeCommand(command)) {
    const now = new Date().toISOString();
    return {
      command,
      args,
      payload: {
        provider: "claude" as const,
        state: "ready" as const,
        baseUrl: claudeConfigDirForEnv(env),
        externalSessionId: "",
        status: "",
        updatedAt: now,
        error: "",
        sidecarSummary: createIdleSidecarSummary(now),
        forks: [],
        summary: null,
      },
    };
  }

  if (!isOpenCodeCommand(command)) {
    return {
      command,
      args,
      payload: createUnavailableSdkPayload(),
    };
  }

  const prepared = [...args];
  const port = await ensureCliOption(prepared, "--port", async (current) => {
    const parsed = Number(current || 0);
    return parsed > 0 ? String(parsed) : String(await getFreePort());
  });
  await ensureCliOption(prepared, "--hostname", async (current) => current || loopbackHost);
  const now = new Date().toISOString();

  return {
    command,
    args: prepared,
    payload: {
      provider: "opencode" as const,
      state: "ready" as const,
      baseUrl: `http://${loopbackHost}:${port}`,
      externalSessionId: "",
      status: "",
      updatedAt: now,
      error: "",
      sidecarSummary: createIdleSidecarSummary(now),
      forks: [],
      summary: null,
    },
  };
}

function createUnavailableSdkPayload(): SessionSdkPayload {
  return {
    provider: "",
    state: "unavailable",
    baseUrl: "",
    externalSessionId: "",
    status: "",
    updatedAt: "",
    error: "",
    sidecarSummary: createIdleSidecarSummary(""),
    forks: [],
    summary: null,
  };
}

function createIdleSidecarSummary(updatedAt: string): SessionSdkPayload["sidecarSummary"] {
  return {
    implemented: false,
    status: "idle",
    method: "",
    sourceSessionId: "",
    forkSessionId: "",
    forkPoint: "",
    updatedAt,
    result: null,
    error: "",
    note: "No sidecar summary has been requested for this session.",
  };
}

async function ensureCliOption(args: string[], name: string, resolveValue: (current: string) => Promise<string>) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === name) {
      const value = await resolveValue(args[index + 1] || "");
      args[index + 1] = value;
      return value;
    }
    if (arg.startsWith(prefix)) {
      const value = await resolveValue(arg.slice(prefix.length));
      args[index] = `${name}=${value}`;
      return value;
    }
  }
  const value = await resolveValue("");
  args.push(name, value);
  return value;
}

function isOpenCodeCommand(command: string) {
  return path.basename(command).toLowerCase() === "opencode";
}

function isCodexCommand(command: string) {
  return path.basename(command).toLowerCase() === "codex";
}

function isClaudeCommand(command: string) {
  return path.basename(command).toLowerCase() === "claude";
}

async function refreshSessionSdk(session: RuntimeSession) {
  if (session.sdk.provider === "codex") {
    await refreshCodexSessionSdk(session);
    return;
  }

  if (session.sdk.provider === "claude") {
    await refreshClaudeSessionSdk(session);
    return;
  }

  if (session.sdk.provider !== "opencode") {
    session.sdk = createUnavailableSdkPayload();
    return;
  }

  try {
    const client = createOpenCodeClient(session);
    const sessions = responseData<any[]>(await client.session.list({ responseStyle: "data", throwOnError: true }));
    const target = resolveOpenCodeSession({
      sessions,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      session.sdk = {
        ...session.sdk,
        state: "not-found",
        status: "",
        updatedAt: new Date().toISOString(),
        error: "OpenCode server is reachable, but no matching session is visible yet.",
        summary: null,
      };
      publishSession(session);
      return;
    }

    session.sdk.externalSessionId = String(target.id || "");
    const [statusBySession, messages, diffs] = await Promise.all([
      client.session.status({ responseStyle: "data", throwOnError: true }).then(responseData<Record<string, any>>).catch(() => ({} as Record<string, any>)),
      client.session.messages({
        path: { id: session.sdk.externalSessionId },
        responseStyle: "data",
        throwOnError: true,
      }).then(responseData<any[]>).catch(() => []),
      client.session.diff({
        path: { id: session.sdk.externalSessionId },
        responseStyle: "data",
        throwOnError: true,
      }).then(responseData<any[]>).catch(() => []),
    ]);

    const status = statusBySession[session.sdk.externalSessionId]?.type || "";
    session.sdk = {
      ...session.sdk,
      state: "connected",
      status,
      updatedAt: new Date().toISOString(),
      error: "",
      summary: buildOpenCodeSummary(target, messages, diffs),
    };
    if (!session.title || session.title === path.basename(session.command)) {
      session.title = session.sdk.summary?.title || session.title;
    }
    storeSessionRecoveryCommand(session, ["--session", String(target.id || "")]);
  } catch (error) {
    session.sdk = {
      ...session.sdk,
      state: "error",
      updatedAt: new Date().toISOString(),
      error: String(error instanceof Error ? error.message : error),
    };
  }
  publishSession(session);
}

function scheduleSessionRecoveryDiscovery(session: RuntimeSession) {
  if (!session.sdk.provider) {
    return;
  }
  const deadline = Date.now() + 60_000;
  void (async () => {
    while (Date.now() < deadline) {
      if (state.sessionStore.getSession(session.id)?.recoveryCommand) {
        return;
      }
      await refreshSessionSdk(session);
      if (state.sessionStore.getSession(session.id)?.recoveryCommand) {
        return;
      }
      await delay(1_000);
    }
  })().catch((error) => {
    console.error(error);
  });
}

function storeSessionRecoveryCommand(session: RuntimeSession, args: string[]) {
  state.sessionStore.setSessionRecovery({
    sessionId: session.id,
    recoveryCommand: formatCommandLine(session.command, args),
    createdAtMs: Date.now(),
  });
}

async function refreshCodexSessionSdk(session: RuntimeSession) {
  try {
    const threads = readCodexThreadsFromDatabasePath(session.sdk.baseUrl);
    const target = resolveCodexThread({
      threads,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      session.sdk = {
        ...session.sdk,
        state: "not-found",
        status: "",
        updatedAt: new Date().toISOString(),
        error: "Codex state is readable, but no matching thread is visible yet.",
        summary: null,
      };
      publishSession(session);
      return;
    }

    const summary = buildCodexSummary(target);
    session.sdk = {
      ...session.sdk,
      state: "connected",
      status: target.model || target.model_provider || "",
      externalSessionId: String(target.id || ""),
      updatedAt: new Date().toISOString(),
      error: "",
      summary,
    };
    if (!session.title || session.title === path.basename(session.command)) {
      session.title = summary.title || session.title;
    }
    storeSessionRecoveryCommand(session, ["resume", String(target.id || "")]);
  } catch (error) {
    session.sdk = {
      ...session.sdk,
      state: "error",
      updatedAt: new Date().toISOString(),
      error: String(error instanceof Error ? error.message : error),
    };
  }
  publishSession(session);
}

async function refreshClaudeSessionSdk(session: RuntimeSession) {
  try {
    const sessions = await readClaudeSessions(session.sdk.baseUrl, session.cwd);
    const target = resolveClaudeSession({
      sessions,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      session.sdk = {
        ...session.sdk,
        state: "not-found",
        status: "",
        updatedAt: new Date().toISOString(),
        error: "Claude session storage is readable, but no matching session is visible yet.",
        summary: null,
      };
      publishSession(session);
      return;
    }

    const messages = await readClaudeSessionMessages(session.sdk.baseUrl, target.sessionId, session.cwd);
    const summary = buildClaudeSummary(target, messages);
    session.sdk = {
      ...session.sdk,
      state: "connected",
      status: target.gitBranch || "",
      externalSessionId: String(target.sessionId || ""),
      updatedAt: new Date().toISOString(),
      error: "",
      summary,
    };
    if (!session.title || session.title === path.basename(session.command)) {
      session.title = summary.title || session.title;
    }
    storeSessionRecoveryCommand(session, ["--resume", String(target.sessionId || "")]);
  } catch (error) {
    session.sdk = {
      ...session.sdk,
      state: "error",
      updatedAt: new Date().toISOString(),
      error: String(error instanceof Error ? error.message : error),
    };
  }
  publishSession(session);
}

async function summarizeSessionWithSdk(session: RuntimeSession) {
  const provider = session.sdk.provider;
  if (!provider) {
    session.sdk = createUnavailableSdkPayload();
    publishSession(session);
    return;
  }

  if (provider === "codex") {
    await summarizeCodexSessionWithSdk(session);
    return;
  }

  if (provider === "claude") {
    await summarizeClaudeSessionWithSdk(session);
    return;
  }

  if (provider !== "opencode") {
    session.sdk = createUnavailableSdkPayload();
    publishSession(session);
    return;
  }

  session.sdk = {
    ...session.sdk,
    sidecarSummary: {
      implemented: true,
      status: "running",
      method: "opencode.session.fork+prompt",
      sourceSessionId: session.sdk.externalSessionId,
      forkSessionId: "",
      forkPoint: "",
      updatedAt: new Date().toISOString(),
      result: null,
      error: "",
      note: "Resolving the OpenCode source session before creating a sidecar summary fork.",
    },
  };
  publishSession(session);

  let sourceSessionId = session.sdk.externalSessionId;
  let forkSessionId = "";
  let sourceForkPoint = "";
  try {
    const client = createOpenCodeClient(session);
    const sessions = responseData<any[]>(await client.session.list({ responseStyle: "data", throwOnError: true }));
    const target = resolveOpenCodeSession({
      sessions,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      throw new Error("OpenCode server is reachable, but no matching session is visible yet.");
    }

    sourceSessionId = String(target.id || "");
    session.sdk.externalSessionId = sourceSessionId;
    const sourceMessages = responseData<any[]>(await client.session.messages({
      path: { id: sourceSessionId },
      responseStyle: "data",
      throwOnError: true,
    }));
    const sourceSummary = buildOpenCodeSummary(target, sourceMessages, []);
    sourceForkPoint = forkPointForSummary(sourceSummary);
    const reusableBrief = findReusableSessionBrief(session, "opencode", sourceSessionId, sourceForkPoint);
    if (reusableBrief) {
      reuseSessionBrief(session, {
        method: "opencode.session.fork+prompt",
        sourceSessionId,
        sourceForkPoint,
        sourceSummary,
        reusableBrief,
      });
      return;
    }
    const model = pickOpenCodeModel(sourceMessages);
    if (!model) {
      throw new Error("OpenCode session has no model metadata yet; send a prompt before summarizing.");
    }

    const forked = responseData<any>(await client.session.fork({
      path: { id: sourceSessionId },
      body: {},
      responseStyle: "data",
      throwOnError: true,
    }));
    forkSessionId = String(forked.id || "");
    if (!forkSessionId) {
      throw new Error("OpenCode created a fork without returning a session id.");
    }

    const forkCreatedAt = new Date().toISOString();
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceSessionId,
      forks: upsertSidecarFork(session.sdk.forks, {
        provider: "opencode",
        purpose: "sidecarSummary",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        createdAt: forkCreatedAt,
        updatedAt: forkCreatedAt,
        status: "created",
        result: null,
        error: "",
        summary: null,
      }),
      sidecarSummary: {
        implemented: true,
        status: "running",
        method: "opencode.session.fork+prompt",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        updatedAt: forkCreatedAt,
        result: null,
        error: "",
        note: "Fork created; asking OpenCode for the structured brief on the fork so the live TUI session is left untouched.",
      },
    };
    publishSession(session);

    const prompted = responseData<any>(await client.session.prompt({
      path: { id: forkSessionId },
      body: {
        model,
        tools: {},
        parts: [{
          type: "text",
          text: createOpenCodeSummaryPrompt(sourceSummary),
        }],
      },
      responseStyle: "data",
      throwOnError: true,
    }));
    const finalResponse = openCodeResponseText(prompted);
    const forkDiffs = await client.session.diff({
      path: { id: forkSessionId },
      responseStyle: "data",
      throwOnError: true,
    }).then(responseData<any[]>).catch(() => []);
    const summarizedAt = new Date().toISOString();
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceSessionId,
      forks: upsertSidecarFork(session.sdk.forks, {
        provider: "opencode",
        purpose: "sidecarSummary",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        createdAt: forkCreatedAt,
        updatedAt: summarizedAt,
        status: "summarized",
        result: true,
        error: "",
        summary: {
          ...buildOpenCodeSidecarSummary(forked, finalResponse),
          diffCount: forkDiffs.length,
          additions: forkDiffs.reduce((total, diff) => total + Number(diff.additions || 0), 0),
          deletions: forkDiffs.reduce((total, diff) => total + Number(diff.deletions || 0), 0),
          diffs: forkDiffs.map((diff) => ({
            file: String(diff.file || ""),
            additions: Number(diff.additions || 0),
            deletions: Number(diff.deletions || 0),
          })),
        },
      }),
      sidecarSummary: {
        implemented: true,
        status: "completed",
        method: "opencode.session.fork+prompt",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        updatedAt: summarizedAt,
        result: true,
        error: "",
        note: "OpenCode produced the structured brief in a disposable sidecar fork. The live provider session remains the source session.",
      },
    };
    if (forkSessionId !== sourceSessionId) {
      await discardOpenCodeSidecarSession(client, forkSessionId);
    }
    await refreshSessionSdk(session);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const existingFork = session.sdk.forks.find((candidate) => candidate.forkSessionId === forkSessionId);
    session.sdk = {
      ...session.sdk,
      forks: forkSessionId ? upsertSidecarFork(session.sdk.forks, {
        provider: "opencode",
        purpose: "sidecarSummary",
        sourceSessionId,
        forkSessionId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        createdAt: existingFork ? existingFork.createdAt : failedAt,
        updatedAt: failedAt,
        status: "error",
        result: null,
        error: String(error instanceof Error ? error.message : error),
        summary: existingFork ? existingFork.summary : null,
      }) : session.sdk.forks,
      sidecarSummary: {
        implemented: true,
        status: "error",
        method: "opencode.session.fork+prompt",
        sourceSessionId,
        forkSessionId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        updatedAt: failedAt,
        result: null,
        error: String(error instanceof Error ? error.message : error),
        note: "OpenCode forked sidecar summary failed before producing a result.",
      },
    };
    publishSession(session);
    if (forkSessionId !== sourceSessionId) {
      await discardOpenCodeSidecarSession(createOpenCodeClient(session), forkSessionId);
    }
  }
}

function startSessionBriefJob(session: RuntimeSession) {
  if (reuseCurrentSessionBrief(session)) {
    return;
  }

  if (session.sdkSummaryJob) {
    return;
  }

  const method = sidecarSummaryMethodForProvider(session.sdk.provider);
  if (method) {
    const startedAt = new Date().toISOString();
    session.sdk = {
      ...session.sdk,
      sidecarSummary: {
        implemented: true,
        status: "running",
        method,
        sourceSessionId: session.sdk.externalSessionId,
        forkSessionId: "",
        forkPoint: session.sdk.summary ? forkPointForSummary(session.sdk.summary) : "",
        updatedAt: startedAt,
        result: null,
        error: "",
        note: "Getting session brief in the background.",
      },
    };
    publishSession(session);
  }

  session.sdkSummaryJob = summarizeSessionWithSdk(session)
    .catch((error) => {
      const failedAt = new Date().toISOString();
      session.sdk = {
        ...session.sdk,
        sidecarSummary: {
          implemented: Boolean(method),
          status: "error",
          method,
          sourceSessionId: session.sdk.externalSessionId,
          forkSessionId: "",
          forkPoint: session.sdk.summary ? forkPointForSummary(session.sdk.summary) : "",
          updatedAt: failedAt,
          result: null,
          error: String(error instanceof Error ? error.message : error),
          note: "Session brief failed before the provider adapter could report an error.",
        },
      };
      publishSession(session);
    })
    .finally(() => {
      session.sdkSummaryJob = null;
    });
}

function reuseCurrentSessionBrief(session: RuntimeSession) {
  const provider = session.sdk.provider;
  const sourceSummary = session.sdk.summary;
  const sourceSessionId = session.sdk.externalSessionId;
  const method = sidecarSummaryMethodForProvider(provider);
  if (!provider || !sourceSummary || !sourceSessionId || !method) {
    return false;
  }

  const sourceForkPoint = forkPointForSummary(sourceSummary);
  const reusableBrief = findReusableSessionBrief(session, provider, sourceSessionId, sourceForkPoint);
  if (!reusableBrief) {
    return false;
  }

  reuseSessionBrief(session, {
    method,
    sourceSessionId,
    sourceForkPoint,
    sourceSummary,
    reusableBrief,
  });
  return true;
}

function sidecarSummaryMethodForProvider(provider: SessionSdkPayload["provider"]): SessionSdkPayload["sidecarSummary"]["method"] {
  if (provider === "opencode") {
    return "opencode.session.fork+prompt";
  }
  if (provider === "codex") {
    return "codex.startThread+summary";
  }
  if (provider === "claude") {
    return "claude.query+forkSession";
  }
  return "";
}

async function summarizeCodexSessionWithSdk(session: RuntimeSession) {
  session.sdk = {
    ...session.sdk,
    sidecarSummary: {
      implemented: true,
      status: "running",
      method: "codex.startThread+summary",
      sourceSessionId: session.sdk.externalSessionId,
      forkSessionId: "",
      forkPoint: "",
      updatedAt: new Date().toISOString(),
      result: null,
      error: "",
      note: "Resolving the Codex source thread before creating a sidecar summary thread.",
    },
  };
  publishSession(session);

  let sourceThreadId = session.sdk.externalSessionId;
  let sidecarThreadId = "";
  let sidecarCreatedAt = new Date().toISOString();
  let sourceForkPoint = "";
  try {
    const threads = readCodexThreadsFromDatabasePath(session.sdk.baseUrl);
    const target = resolveCodexThread({
      threads,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      throw new Error("Codex state is readable, but no matching thread is visible yet.");
    }

    sourceThreadId = String(target.id || "");
    const sourceSummary = buildCodexSummary(target);
    sourceForkPoint = forkPointForSummary(sourceSummary);
    const reusableBrief = findReusableSessionBrief(session, "codex", sourceThreadId, sourceForkPoint);
    if (reusableBrief) {
      reuseSessionBrief(session, {
        method: "codex.startThread+summary",
        sourceSessionId: sourceThreadId,
        sourceForkPoint,
        sourceSummary,
        reusableBrief,
      });
      return;
    }
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceThreadId,
      state: "connected",
      status: target.model || target.model_provider || "",
      summary: sourceSummary,
      sidecarSummary: {
        implemented: true,
        status: "running",
        method: "codex.startThread+summary",
        sourceSessionId: sourceThreadId,
        forkSessionId: "",
        forkPoint: sourceForkPoint,
        updatedAt: new Date().toISOString(),
        result: null,
        error: "",
        note: "Creating a separate Codex thread for the summary so the live TUI thread is left untouched.",
      },
    };
    publishSession(session);

    const codex = new Codex({
      env: {
        ...minimalEnv(process.env),
        CODEX_HOME: codexHomeDirFromStateDatabasePath(session.sdk.baseUrl),
      },
    });
    const thread = codex.startThread({
      workingDirectory: session.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    });
    const result = await thread.run(createCodexSummaryPrompt(sourceSummary));
    sidecarThreadId = thread.id || "";
    if (!sidecarThreadId) {
      throw new Error("Codex summary thread completed without exposing a thread id.");
    }

    const summarizedAt = new Date().toISOString();
    if (sidecarThreadId !== sourceThreadId) {
      await discardCodexSidecarThread(session.sdk.baseUrl, sidecarThreadId);
    }
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceThreadId,
      forks: upsertSidecarFork(session.sdk.forks, {
        provider: "codex",
        purpose: "sidecarSummary",
        sourceSessionId: sourceThreadId,
        forkSessionId: sidecarThreadId,
        forkPoint: sourceForkPoint,
        createdAt: sidecarCreatedAt,
        updatedAt: summarizedAt,
        status: "summarized",
        result: true,
        error: "",
        summary: buildCodexSidecarSummary(sidecarThreadId, result.finalResponse),
      }),
      sidecarSummary: {
        implemented: true,
        status: "completed",
        method: "codex.startThread+summary",
        sourceSessionId: sourceThreadId,
        forkSessionId: sidecarThreadId,
        forkPoint: sourceForkPoint,
        updatedAt: summarizedAt,
        result: true,
        error: "",
        note: "Codex summarized the source transcript in a disposable sidecar thread. The live TUI thread remains untouched.",
      },
    };
    await refreshCodexSessionSdk(session);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const existingFork = session.sdk.forks.find((candidate) => candidate.forkSessionId === sidecarThreadId);
    session.sdk = {
      ...session.sdk,
      forks: sidecarThreadId ? upsertSidecarFork(session.sdk.forks, {
        provider: "codex",
        purpose: "sidecarSummary",
        sourceSessionId: sourceThreadId,
        forkSessionId: sidecarThreadId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        createdAt: existingFork ? existingFork.createdAt : sidecarCreatedAt,
        updatedAt: failedAt,
        status: "error",
        result: null,
        error: String(error instanceof Error ? error.message : error),
        summary: existingFork ? existingFork.summary : null,
      }) : session.sdk.forks,
      sidecarSummary: {
        implemented: true,
        status: "error",
        method: "codex.startThread+summary",
        sourceSessionId: sourceThreadId,
        forkSessionId: sidecarThreadId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        updatedAt: failedAt,
        result: null,
        error: String(error instanceof Error ? error.message : error),
        note: "Codex sidecar summary failed before producing a result.",
      },
    };
    publishSession(session);
    if (sidecarThreadId !== sourceThreadId) {
      await discardCodexSidecarThread(session.sdk.baseUrl, sidecarThreadId);
    }
  }
}

async function summarizeClaudeSessionWithSdk(session: RuntimeSession) {
  session.sdk = {
    ...session.sdk,
    sidecarSummary: {
      implemented: true,
      status: "running",
      method: "claude.query+forkSession",
      sourceSessionId: session.sdk.externalSessionId,
      forkSessionId: "",
      forkPoint: "",
      updatedAt: new Date().toISOString(),
      result: null,
      error: "",
      note: "Resolving the Claude source session before creating a sidecar summary fork.",
    },
  };
  publishSession(session);

  let sourceSessionId = session.sdk.externalSessionId;
  let forkSessionId = "";
  let forkCreatedAt = new Date().toISOString();
  let sourceForkPoint = "";
  try {
    const sessions = await readClaudeSessions(session.sdk.baseUrl, session.cwd);
    const target = resolveClaudeSession({
      sessions,
      cwd: session.cwd,
      tuiCreatedAt: session.createdAt,
      currentExternalSessionId: session.sdk.externalSessionId,
      args: session.args,
    });
    if (!target) {
      throw new Error("Claude session storage is readable, but no matching session is visible yet.");
    }

    sourceSessionId = String(target.sessionId || "");
    const sourceMessages = await readClaudeSessionMessages(session.sdk.baseUrl, sourceSessionId, session.cwd);
    const sourceSummary = buildClaudeSummary(target, sourceMessages);
    sourceForkPoint = forkPointForSummary(sourceSummary);
    const reusableBrief = findReusableSessionBrief(session, "claude", sourceSessionId, sourceForkPoint);
    if (reusableBrief) {
      reuseSessionBrief(session, {
        method: "claude.query+forkSession",
        sourceSessionId,
        sourceForkPoint,
        sourceSummary,
        reusableBrief,
      });
      return;
    }
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceSessionId,
      state: "connected",
      status: target.gitBranch || "",
      summary: sourceSummary,
      sidecarSummary: {
        implemented: true,
        status: "running",
        method: "claude.query+forkSession",
        sourceSessionId,
        forkSessionId: "",
        forkPoint: sourceForkPoint,
        updatedAt: new Date().toISOString(),
        result: null,
        error: "",
        note: "Creating a separate Claude fork for the summary so the live TUI session is left untouched.",
      },
    };
    publishSession(session);

    const sidecar = await runClaudeSidecarSummary({
      sourceSessionId,
      cwd: session.cwd,
      configDir: session.sdk.baseUrl,
      env: minimalEnv(session.env),
      prompt: createClaudeSummaryPrompt(sourceSummary),
    });
    forkSessionId = sidecar.forkSessionId;
    const summarizedAt = new Date().toISOString();
    if (forkSessionId !== sourceSessionId) {
      await discardClaudeSidecarSession(session.sdk.baseUrl, forkSessionId);
    }
    session.sdk = {
      ...session.sdk,
      externalSessionId: sourceSessionId,
      forks: upsertSidecarFork(session.sdk.forks, {
        provider: "claude",
        purpose: "sidecarSummary",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        createdAt: forkCreatedAt,
        updatedAt: summarizedAt,
        status: "summarized",
        result: true,
        error: "",
        summary: buildClaudeSidecarSummary(forkSessionId, sidecar.finalResponse),
      }),
      sidecarSummary: {
        implemented: true,
        status: "completed",
        method: "claude.query+forkSession",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        updatedAt: summarizedAt,
        result: true,
        error: "",
        note: "Claude summarized the source transcript in a disposable fork. The live TUI session remains untouched.",
      },
    };
    await refreshClaudeSessionSdk(session);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const existingFork = session.sdk.forks.find((candidate) => candidate.forkSessionId === forkSessionId);
    session.sdk = {
      ...session.sdk,
      forks: forkSessionId ? upsertSidecarFork(session.sdk.forks, {
        provider: "claude",
        purpose: "sidecarSummary",
        sourceSessionId,
        forkSessionId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        createdAt: existingFork ? existingFork.createdAt : forkCreatedAt,
        updatedAt: failedAt,
        status: "error",
        result: null,
        error: String(error instanceof Error ? error.message : error),
        summary: existingFork ? existingFork.summary : null,
      }) : session.sdk.forks,
      sidecarSummary: {
        implemented: true,
        status: "error",
        method: "claude.query+forkSession",
        sourceSessionId,
        forkSessionId,
        forkPoint: existingFork ? existingFork.forkPoint : sourceForkPoint,
        updatedAt: failedAt,
        result: null,
        error: String(error instanceof Error ? error.message : error),
        note: "Claude sidecar summary failed before producing a result.",
      },
    };
    publishSession(session);
    if (forkSessionId !== sourceSessionId) {
      await discardClaudeSidecarSession(session.sdk.baseUrl, forkSessionId);
    }
  }
}

function upsertSidecarFork(
  forks: SessionSdkPayload["forks"],
  fork: SessionSdkPayload["forks"][number],
): SessionSdkPayload["forks"] {
  return [
    ...forks.filter((candidate) => candidate.forkSessionId !== fork.forkSessionId),
    fork,
  ];
}

function findReusableSessionBrief(
  session: RuntimeSession,
  provider: AgentProvider,
  sourceSessionId: string,
  forkPoint: string,
) {
  if (!forkPoint) {
    return null;
  }
  return session.sdk.forks
    .filter((fork) => {
      return fork.provider === provider &&
        fork.sourceSessionId === sourceSessionId &&
        fork.forkPoint === forkPoint &&
        fork.status === "summarized" &&
        Boolean(fork.summary?.latestAssistantText);
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null;
}

function reuseSessionBrief(session: RuntimeSession, input: {
  method: SessionSdkPayload["sidecarSummary"]["method"];
  sourceSessionId: string;
  sourceForkPoint: string;
  sourceSummary: AgentSessionSummary;
  reusableBrief: SessionSdkPayload["forks"][number];
}) {
  const reusedAt = new Date().toISOString();
  session.sdk = {
    ...session.sdk,
    externalSessionId: input.sourceSessionId,
    state: "connected",
    summary: input.sourceSummary,
    sidecarSummary: {
      implemented: true,
      status: "completed",
      method: input.method,
      sourceSessionId: input.sourceSessionId,
      forkSessionId: input.reusableBrief.forkSessionId,
      forkPoint: input.sourceForkPoint,
      updatedAt: reusedAt,
      result: input.reusableBrief.result,
      error: "",
      note: "Reused the completed session brief for the current fork point.",
    },
  };
  publishSession(session);
}

function forkPointForSummary(summary: AgentSessionSummary) {
  return summary.forkPoint || summary.transcript.at(-1)?.id || "";
}

function createOpenCodeClient(session: RuntimeSession) {
  return createOpencodeClient({
    baseUrl: session.sdk.baseUrl,
    directory: session.cwd,
  });
}

async function discardOpenCodeSidecarSession(client: ReturnType<typeof createOpencodeClient>, sessionId: string) {
  if (!sessionId) {
    return;
  }
  await client.session.delete({
    path: { id: sessionId },
    responseStyle: "data",
    throwOnError: true,
  }).catch(() => {});
}

async function discardCodexSidecarThread(databasePath: string, threadId: string) {
  if (!threadId) {
    return;
  }
  await Promise.resolve().then(() => discardCodexThreadFromDatabasePath(databasePath, threadId)).catch(() => {});
}

async function discardClaudeSidecarSession(configDir: string, sessionId: string) {
  if (!sessionId) {
    return;
  }
  await Promise.resolve().then(() => discardClaudeSessionTranscripts(configDir, sessionId)).catch(() => {});
}

function responseData<T>(value: any): T {
  return value && typeof value === "object" && "data" in value ? value.data as T : value as T;
}

function openCodeResponseText(message: any) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.map((part: any) => {
    if (part && typeof part === "object" && part.type === "text") {
      return String(part.text || "");
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, loopbackHost, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sanitizeTerminalChunk(chunk: string) {
  const stripped = stripVTControlCharacters(chunk.replace(/\x1b\[(\d+)C/g, (_match, amount) => " ".repeat(Number(amount))))
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return /\S/.test(stripped) ? stripped : "";
}

function resolveKeySequence(key: string) {
  return resolveNamedKeySequence(key);
}

function minimalEnv(env: NodeJS.ProcessEnv) {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function terminalBaseEnv(processEnv: NodeJS.ProcessEnv, explicitEnv: Record<string, string>) {
  const env = minimalEnv(processEnv);
  if (!("PATH" in explicitEnv) && env.PATH) {
    env.PATH = stripLeadingPackageBinPaths(env.PATH);
  }
  if (!("NO_COLOR" in explicitEnv)) {
    delete env.NO_COLOR;
  }
  if (!("FORCE_COLOR" in explicitEnv)) {
    delete env.FORCE_COLOR;
  }
  if (!("CLICOLOR_FORCE" in explicitEnv)) {
    delete env.CLICOLOR_FORCE;
  }
  return env;
}

function stripLeadingPackageBinPaths(value: string) {
  const entries = value.split(path.delimiter);
  while (entries.length > 0 && isPackageBinPath(entries[0] || "")) {
    entries.shift();
  }
  return entries.join(path.delimiter);
}

function isPackageBinPath(value: string) {
  const normalized = path.normalize(value);
  return path.basename(normalized) === ".bin" && path.basename(path.dirname(normalized)) === "node_modules";
}

function isAgentName(value: unknown): value is AgentName {
  return value === "opencode" || value === "claude" || value === "codex";
}

function resolveBackendForLaunch(value: unknown): SessionBackendName {
  if (typeof value === "string" && value.trim()) {
    return resolveSessionBackend(value);
  }
  return resolveSessionBackend(String(process.env.TUIUI_SESSION_BACKEND || ""));
}

function getAccessBaseUrls(port: number, bindHost: string, fallbackBaseUrl: string) {
  const urls = [fallbackBaseUrl];
  if (isWildcardHost(bindHost)) {
    for (const ip of getTailscaleIpAddresses()) {
      urls.push(`http://${formatHostForUrl(ip)}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function getTailscaleIpAddresses() {
  try {
    return execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function localAccessHost(bindHost: string) {
  return isWildcardHost(bindHost) ? loopbackHost : bindHost;
}

function isWildcardHost(bindHost: string) {
  return bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "";
}

function formatHostForUrl(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function parseCliArgs(argv: string[]) {
  let port = Number(process.env.TUIUI_PORT || defaultPort);
  let host = String(process.env.TUIUI_HOST || defaultBindHost);
  let open = false;
  let fakeAgent: AgentName | "" = "";
  let backend = resolveBackendForLaunch("");
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] || "";
    if (arg === "daemon") {
      continue;
    }
    if (arg === "--open") {
      open = true;
      continue;
    }
    if (arg === "--port") {
      port = Number(argv[index + 1] || port);
      index += 1;
      continue;
    }
    if (arg === "--host" || arg === "--hostname") {
      host = String(argv[index + 1] || host);
      index += 1;
      continue;
    }
    if (arg === "--fakeagent") {
      const candidate = argv[index + 1] || "";
      fakeAgent = isAgentName(candidate) ? candidate : "";
      index += 1;
      continue;
    }
    if (arg === "--backend") {
      backend = resolveSessionBackend(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    rest.push(arg);
  }

  return { port, host, open, fakeAgent, backend, rest };
}

function openUrl(url: string) {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  child.unref();
}

async function shutdown(runningServer: ReturnType<typeof Bun.serve>, state: ServerState) {
  for (const session of state.sessions.values()) {
    await killSession(session).catch(() => {});
    await session.backend.dispose().catch(() => {});
    if (session.fakeAgent) {
      await Promise.resolve(session.fakeAgent[Symbol.asyncDispose]()).catch(() => {});
    }
  }
  state.sessionStore.close();
  runningServer.stop(true);
  process.exit(0);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
