// Inspired by ../xyz's Bun browser-session CLI, but this project deliberately
// uses Bun's PTY support directly instead of tmux. xyz remains the reference
// for the session browser and command/chord interaction ideas.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { Codex } from "@openai/codex-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createFakeAgent, parseRequest, type AgentName, type FakeAgent } from "fakeagent";
import homepage from "./public/index.html";
import {
  buildCodexSidecarSummary,
  buildCodexSummary,
  codexHomeDirFromStateDatabasePath,
  createCodexSummaryPrompt,
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
  readClaudeSessionMessages,
  readClaudeSessions,
  readRecentClaudeSessions,
  resolveClaudeSession,
  runClaudeSidecarSummary,
} from "./src/claude-sdk.ts";
import { formatFakeAgentFallback } from "./src/fakeagent-response.ts";
import {
  buildOpenCodeSummary,
  openCodeDatabasePathForEnv,
  pickOpenCodeModel,
  readRecentOpenCodeSessionsFromDatabasePath,
  resolveOpenCodeSession,
  type AgentProvider,
  type AgentSessionSummary,
  type RecentAgentSession,
  type SessionSdkPayload,
} from "./src/opencode-sdk.ts";
import { createSessionId } from "./src/session-id.ts";
import { analyzeTerminalScreen, type SemanticScreen } from "./src/semantic-screen.ts";
import { analyzeTerminalBlocks, type TerminalBlockModel } from "./src/terminal-blocks.ts";
import { renderTerminalShotSvg } from "./src/tuishot.ts";

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
  process: any;
  writeQueue: Promise<void>;
  renderedText: string;
  renderedHtml: string;
  renderedAnsi: string;
  blocks: TerminalBlockModel;
  semantic: SemanticScreen;
  sdk: SessionSdkPayload;
  sdkSummaryJob: Promise<void> | null;
  stdinEvents: StdinEvent[];
  stdoutEvents: StdoutEvent[];
  subscribers: Set<(payload: SessionPayload) => void>;
  fakeAgent: FakeAgent | null;
};

type CreateSessionInput = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  fakeAgent: AgentName | "";
};

type ServerState = {
  sessions: Map<string, RuntimeSession>;
  nextStdoutEventId: number;
  nextStdinEventId: number;
};

const loopbackHost = "127.0.0.1";
const defaultBindHost = "0.0.0.0";
const defaultPort = 7373;
const defaultCols = 120;
const defaultRows = 42;
const idleThresholdMs = 1_000;

const cli = parseCliArgs(process.argv.slice(2));
const state: ServerState = {
  sessions: new Map(),
  nextStdoutEventId: 1,
  nextStdinEventId: 1,
};
const server: ReturnType<typeof Bun.serve> = startServer({ host: cli.host, port: cli.port, state });
const serverPort = Number(server.port || cli.port);
const baseUrl = `http://${formatHostForUrl(localAccessHost(cli.host))}:${serverPort}`;
const accessBaseUrls = getAccessBaseUrls(serverPort, cli.host, baseUrl);

if (cli.rest.length > 0) {
  const [command, ...args] = cli.rest;
  const session = await createSession({
    command: command || "",
    args,
    cwd: process.cwd(),
    env: {},
    cols: defaultCols,
    rows: defaultRows,
    fakeAgent: cli.fakeAgent,
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

async function handleApiRequest(state: ServerState, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return Response.json({
      pageLoadToasts: process.env.TUIUI_PAGE_LOAD_TOASTS === "1",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/cwd") {
    return Response.json({ cwd: fs.realpathSync(process.cwd()) });
  }

  if (request.method === "GET" && url.pathname === "/api/commands") {
    return Response.json([
      { id: "custom", label: "Custom", command: "", args: [], fakeAgent: "" },
      { id: "opencode", label: "OpenCode", command: "opencode", args: [], fakeAgent: "" },
      { id: "codex", label: "Codex", command: "codex", args: [], fakeAgent: "" },
      { id: "claude", label: "Claude", command: "claude", args: [], fakeAgent: "" },
      { id: "fake-opencode", label: "Fake OpenCode", command: "opencode", args: [], fakeAgent: "opencode" },
      { id: "fake-codex", label: "Fake Codex", command: "codex", args: [], fakeAgent: "codex" },
      { id: "fake-claude", label: "Fake Claude", command: "claude", args: [], fakeAgent: "claude" },
      { id: "ghui", label: "ghui", command: "ghui", args: [], fakeAgent: "" },
    ]);
  }

  if (request.method === "GET" && url.pathname === "/api/agent-sessions/recent") {
    return Response.json(await readRecentAgentSessions());
  }

  if (request.method === "GET" && url.pathname === "/api/codex-sessions/recent") {
    return Response.json(readRecentCodexSessions());
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return Response.json([...state.sessions.values()].map(toSessionListItem));
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await request.json() as Partial<CreateSessionInput>;
    const session = await createSession({
      command: body.command || "",
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      cwd: body.cwd || process.cwd(),
      env: body.env || {},
      cols: Number(body.cols || defaultCols),
      rows: Number(body.rows || defaultRows),
      fakeAgent: isAgentName(body.fakeAgent) ? body.fakeAgent : "",
    });
    return Response.json({ id: session.id, url: `${baseUrl}/sessions/${session.id}` });
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    return new Response("not found", { status: 404 });
  }

  const session = state.sessions.get(match[1] || "");
  if (!session) {
    return Response.json({ error: "unknown session" }, { status: 404 });
  }

  const action = match[2] || "";

  if (request.method === "GET" && !action) {
    return Response.json(getSessionPayload(session));
  }

  if (request.method === "GET" && action === "events") {
    return streamSessionEvents(session);
  }

  if (request.method === "GET" && action === "stdout") {
    const after = Number(url.searchParams.get("after") || 0);
    return Response.json({
      events: session.stdoutEvents.filter((event) => event.id > after),
    });
  }

  if (request.method === "GET" && (action === "tuishot" || action === "tuishot.svg")) {
    return createTuishotResponse(session);
  }

  if (request.method === "POST" && action === "send") {
    const body = await request.json() as { text?: string; submit?: boolean };
    await sendToSession(state, session, String(body.text || ""), body.submit !== false);
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && action === "sdk-refresh") {
    await refreshSessionSdk(session);
    return Response.json(getSessionPayload(session));
  }

  if (request.method === "POST" && action === "sdk-summarize") {
    startSessionBriefJob(session);
    return Response.json(getSessionPayload(session));
  }

  if (request.method === "POST" && action === "key") {
    const body = await request.json() as { key?: string };
    await sendToSession(state, session, resolveKeySequence(String(body.key || "")), false);
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && action === "resize") {
    const body = await request.json() as { cols?: number; rows?: number };
    await resizeSession(session, Number(body.cols || session.cols), Number(body.rows || session.rows));
    publishSession(session);
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && action === "kill") {
    await killSession(session);
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
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

  const id = createSessionId();
  const now = new Date().toISOString();
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
    FORCE_COLOR: input.env.FORCE_COLOR || inheritedEnv.FORCE_COLOR || "1",
    CLICOLOR_FORCE: input.env.CLICOLOR_FORCE || inheritedEnv.CLICOLOR_FORCE || "1",
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
    title: path.basename(command),
    command,
    args,
    cwd,
    env,
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
    process: null,
    writeQueue: Promise.resolve(),
    renderedText: "",
    renderedHtml: "",
    renderedAnsi: "",
    blocks: analyzeTerminalBlocks(terminal),
    semantic: analyzeTerminalScreen("", { cols, rows }),
    sdk: sdk.payload,
    sdkSummaryJob: null,
    stdinEvents: [],
    stdoutEvents: [],
    subscribers: new Set(),
    fakeAgent,
  };

  state.sessions.set(id, session);

  session.process = Bun.spawn([command, ...args], {
    cwd,
    env,
    terminal: {
      cols,
      rows,
      data(_term: unknown, chunk: string | Uint8Array) {
        const text = typeof chunk === "string" ? chunk : session.outputDecoder.write(Buffer.from(chunk));
        session.writeQueue = session.writeQueue.then(() => appendOutput(state, session, text));
      },
    },
  });

  session.process.exited.then((exitCode: number) => {
    session.writeQueue = session.writeQueue
      .then(async () => {
        const flushed = session.outputDecoder.end();
        if (flushed) {
          await appendOutput(state, session, flushed);
        }
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
  return session;
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
  session.renderedAnsi = session.serializer.serialize({ scrollback: 1000 });
  session.blocks = analyzeTerminalBlocks(session.terminal);
  session.semantic = analyzeTerminalScreen(renderedText, { cols: session.cols, rows: session.rows });
  session.title = inferSessionTitle(session, chunk);
  session.updatedAt = now;
  session.lastOutputAt = now;
  session.stdoutEvents.push({
    id: state.nextStdoutEventId,
    chunk,
    displayText: sanitizeTerminalChunk(chunk),
    createdAt: now,
  });
  state.nextStdoutEventId += 1;
  publishSession(session);
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

async function sendToSession(state: ServerState, session: RuntimeSession, text: string, submit: boolean) {
  if (session.lifecycle !== "running") {
    throw new Error("session is not running");
  }
  const now = new Date().toISOString();
  session.stdinEvents.push({
    id: state.nextStdinEventId,
    text,
    createdAt: now,
  });
  state.nextStdinEventId += 1;
  session.updatedAt = now;
  if (text.trim()) {
    session.title = session.title === path.basename(session.command) ? text.trim().slice(0, 100) : session.title;
  }

  if (submit && usesLfCrSubmit(session.command) && text) {
    session.process.terminal.write(text);
    await delay(80);
    session.process.terminal.write("\n");
    await delay(80);
    session.process.terminal.write("\r");
    publishSession(session);
    return;
  }

  session.process.terminal.write(submit ? normalizeInput(text) : text);
  publishSession(session);
}

function normalizeInput(text: string) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n$/g, "");
  return `${normalized.replaceAll("\n", "\r")}\r`;
}

async function resizeSession(session: RuntimeSession, cols: number, rows: number) {
  session.cols = Math.max(40, Math.min(240, Math.round(cols)));
  session.rows = Math.max(12, Math.min(80, Math.round(rows)));
  session.terminal.resize(session.cols, session.rows);
  session.process.terminal.resize(session.cols, session.rows);
  session.renderedText = renderTerminalText(session);
  session.renderedHtml = renderTerminalHtml(session);
  session.renderedAnsi = session.serializer.serialize({ scrollback: 1000 });
  session.blocks = analyzeTerminalBlocks(session.terminal);
  session.semantic = analyzeTerminalScreen(session.renderedText, { cols: session.cols, rows: session.rows });
  session.updatedAt = new Date().toISOString();
}

async function killSession(session: RuntimeSession) {
  if (session.lifecycle === "exited") {
    return;
  }
  try {
    session.process.terminal.write("\x03");
  } catch {
  }
  await delay(150);
  try {
    session.process.kill("SIGTERM");
  } catch {
  }
}

function publishSession(session: RuntimeSession) {
  const payload = getSessionPayload(session);
  for (const subscriber of session.subscribers) {
    subscriber(payload);
  }
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
  const status = session.lifecycle === "exited"
    ? "exited"
    : Date.now() - new Date(session.lastOutputAt).getTime() < idleThresholdMs
      ? "busy"
      : "idle";
  return {
    id: session.id,
    title: session.semantic.title || session.title,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOutputAt: session.lastOutputAt,
    lifecycle: session.lifecycle,
    status,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
    renderedText: session.renderedText,
    renderedHtml: session.renderedHtml,
    renderedAnsi: session.renderedAnsi,
    blocks: session.blocks,
    semantic: session.semantic,
    sdk: session.sdk,
    stdinEvents: session.stdinEvents.slice(-100),
    stdoutEvents: session.stdoutEvents.slice(-200),
  };
}

function toSessionListItem(session: RuntimeSession) {
  return {
    id: session.id,
    title: session.semantic.title || session.title,
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
    title: `${session.title || session.command} tuishot`,
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
    if (error instanceof Error && error.message.startsWith("Codex state database not found at ")) {
      return [];
    }
    throw error;
  }
}

async function readRecentAgentSessions(): Promise<RecentAgentSession[]> {
  const nowMs = Date.now();
  const results = await Promise.all([
    readRecentProviderSessions(() => readRecentCodexSessionsFromDatabasePath(resolveCodexStateDatabasePathForEnv(process.env), nowMs)),
    readRecentProviderSessions(() => readRecentOpenCodeSessionsFromDatabasePath(openCodeDatabasePathForEnv(process.env), nowMs)),
    readRecentProviderSessions(async () => await readRecentClaudeSessions(claudeConfigDirForEnv(process.env), nowMs)),
  ]);
  return results
    .flat()
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt))
    .slice(0, 24);
}

async function readRecentProviderSessions(read: () => RecentAgentSession[] | Promise<RecentAgentSession[]>) {
  try {
    return await read();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (
      message.startsWith("Codex state database not found at ") ||
      message.startsWith("OpenCode database not found at ")
    ) {
      return [];
    }
    throw error;
  }
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

function usesLfCrSubmit(command: string) {
  const name = path.basename(command).toLowerCase();
  return name === "opencode" || name === "codex";
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
      method: "opencode.session.fork+summarize",
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
        method: "opencode.session.fork+summarize",
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
        method: "opencode.session.fork+summarize",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        updatedAt: forkCreatedAt,
        result: null,
        error: "",
        note: "Fork created; running OpenCode session.summarize on the fork so the live TUI session is left untouched.",
      },
    };
    publishSession(session);

    const result = responseData<boolean>(await client.session.summarize({
      path: { id: forkSessionId },
      body: model,
      responseStyle: "data",
      throwOnError: true,
    }));
    const [forkMessages, forkDiffs] = await Promise.all([
      client.session.messages({
        path: { id: forkSessionId },
        responseStyle: "data",
        throwOnError: true,
      }).then(responseData<any[]>).catch(() => []),
      client.session.diff({
        path: { id: forkSessionId },
        responseStyle: "data",
        throwOnError: true,
      }).then(responseData<any[]>).catch(() => []),
    ]);
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
        result,
        error: "",
        summary: buildOpenCodeSummary(forked, forkMessages, forkDiffs),
      }),
      sidecarSummary: {
        implemented: true,
        status: "completed",
        method: "opencode.session.fork+summarize",
        sourceSessionId,
        forkSessionId,
        forkPoint: sourceForkPoint,
        updatedAt: summarizedAt,
        result,
        error: "",
        note: "OpenCode session.summarize compacted the fork. The live provider session remains the source session.",
      },
    };
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
        method: "opencode.session.fork+summarize",
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
    return "opencode.session.fork+summarize";
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
        note: "Codex summarized the source transcript in a separate sidecar thread. The live TUI thread remains untouched.",
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
        note: "Claude summarized the source transcript in a separate fork. The live TUI session remains untouched.",
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

function responseData<T>(value: any): T {
  return value && typeof value === "object" && "data" in value ? value.data as T : value as T;
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

function inferSessionTitle(session: RuntimeSession, chunk: string) {
  const oscTitle = parseOscTitle(chunk);
  if (oscTitle) {
    return oscTitle;
  }
  return session.semantic.title || session.title;
}

function parseOscTitle(chunk: string) {
  const match = chunk.match(/\x1b\][02];([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
  return match ? match[1]!.trim() : "";
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
  switch (key.toLowerCase()) {
    case "esc":
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "enter":
    case "return":
      return "\r";
    case "backspace":
      return "\x7f";
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "left":
      return "\x1b[D";
    case "right":
      return "\x1b[C";
    case "ctrl+c":
      return "\x03";
    case "ctrl+d":
      return "\x04";
    default:
      return key;
  }
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
    rest.push(arg);
  }

  return { port, host, open, fakeAgent, rest };
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
    if (session.fakeAgent) {
      await Promise.resolve(session.fakeAgent[Symbol.asyncDispose]()).catch(() => {});
    }
  }
  runningServer.stop(true);
  process.exit(0);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
