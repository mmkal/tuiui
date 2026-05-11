import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { createStructuredSessionBriefPrompt, parseStructuredSessionBrief, type StructuredSessionBrief } from "./session-brief.ts";

export type AgentProvider = "opencode" | "codex" | "claude";

export type SessionSdkPayload = {
  provider: "" | AgentProvider;
  state: "unavailable" | "ready" | "connected" | "not-found" | "error";
  baseUrl: string;
  externalSessionId: string;
  status: string;
  updatedAt: string;
  error: string;
  sidecarSummary: SidecarSummaryState;
  forks: SidecarSummaryFork[];
  summary: AgentSessionSummary | null;
};

export type SidecarSummaryState = {
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

export type SidecarSummaryFork = {
  provider: AgentProvider;
  purpose: "sidecarSummary";
  sourceSessionId: string;
  forkSessionId: string;
  forkPoint: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "summarized" | "error";
  result: boolean | null;
  error: string;
  summary: AgentSessionSummary | null;
};

export type AgentSessionSummary = {
  provider: AgentProvider;
  title: string;
  forkPoint: string;
  messageCount: number;
  diffCount: number;
  additions: number;
  deletions: number;
  latestUserText: string;
  latestAssistantText: string;
  sessionBrief: StructuredSessionBrief | null;
  transcript: Array<{
    id: string;
    role: string;
    createdAt: string;
    text: string;
  }>;
  diffs: Array<{
    file: string;
    additions: number;
    deletions: number;
  }>;
};

export type RecentAgentSession = {
  provider: AgentProvider;
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

type ResolveOpenCodeSessionInput = {
  sessions: any[];
  cwd: string;
  tuiCreatedAt: string;
  currentExternalSessionId: string;
  args: string[];
};

export function resolveOpenCodeSession(input: ResolveOpenCodeSessionInput) {
  const explicitSessionId = getExplicitOpenCodeSessionId(input.args);
  if (explicitSessionId) {
    return input.sessions.find((candidate) => candidate.id === explicitSessionId) || null;
  }

  const matchingDirectory = input.sessions.filter((candidate) => samePath(candidate.directory, input.cwd));
  const candidates = matchingDirectory.length ? matchingDirectory : input.sessions;
  const tuiStartedAt = new Date(input.tuiCreatedAt).getTime();
  const createdAfterLaunch = candidates.filter((candidate) => Number(candidate.time?.created || 0) >= tuiStartedAt - 10_000);

  if (input.currentExternalSessionId) {
    const existing = createdAfterLaunch.find((candidate) => candidate.id === input.currentExternalSessionId);
    if (existing) {
      return existing;
    }
  }

  const freshCandidates = createdAfterLaunch.length ? createdAfterLaunch : candidates;
  return freshCandidates
    .slice()
    .sort((left, right) => Number(right.time?.updated || right.time?.created || 0) - Number(left.time?.updated || left.time?.created || 0))[0] || null;
}

export function buildOpenCodeSummary(session: any, messages: any[], diffs: any[]): AgentSessionSummary {
  const transcript = messages.map((message) => {
    const info = message.info || {};
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return {
      id: String(info.id || ""),
      role: String(info.role || ""),
      createdAt: info.time?.created ? new Date(Number(info.time.created)).toISOString() : "",
      text: parts.map(extractOpenCodePartText).filter(Boolean).join("\n").trim().slice(0, 20_000),
    };
  });
  const userMessages = transcript.filter((message) => message.role === "user" && message.text && message.text !== "[compaction]");
  const assistantMessages = transcript.filter((message) => message.role === "assistant" && message.text);
  const latestUserText = userMessages.at(-1)?.text || "";
  const latestAssistantText = assistantMessages.at(-1)?.text || "";
  const forkPoint = transcript.at(-1)?.id || "";
  const normalizedDiffs = diffs.map((diff) => ({
    file: String(diff.file || ""),
    additions: Number(diff.additions || 0),
    deletions: Number(diff.deletions || 0),
  }));

  return {
    provider: "opencode",
    title: String(session.title || "OpenCode session"),
    forkPoint,
    messageCount: messages.length,
    diffCount: normalizedDiffs.length,
    additions: normalizedDiffs.reduce((total, diff) => total + diff.additions, 0),
    deletions: normalizedDiffs.reduce((total, diff) => total + diff.deletions, 0),
    latestUserText,
    latestAssistantText,
    sessionBrief: null,
    transcript,
    diffs: normalizedDiffs,
  };
}

export function buildOpenCodeSidecarSummary(session: any, finalResponse: string): AgentSessionSummary {
  const now = new Date().toISOString();
  const text = finalResponse.trim();
  return {
    provider: "opencode",
    title: String(session.title || "OpenCode sidecar summary"),
    forkPoint: text ? String(session.id || "opencode-sidecar-summary") : "",
    messageCount: text ? 1 : 0,
    diffCount: 0,
    additions: 0,
    deletions: 0,
    latestUserText: "",
    latestAssistantText: text,
    sessionBrief: text ? parseStructuredSessionBrief(text) : null,
    transcript: text ? [{
      id: `${String(session.id || "opencode")}-summary`,
      role: "assistant",
      createdAt: now,
      text,
    }] : [],
    diffs: [],
  };
}

export function createOpenCodeSummaryPrompt(summary: AgentSessionSummary) {
  return createStructuredSessionBriefPrompt("OpenCode", summary);
}

export function openCodeDatabasePathForEnv(env: NodeJS.ProcessEnv) {
  const explicitPath = String(env.OPENCODE_DB_PATH || "");
  if (explicitPath) {
    return explicitPath;
  }
  const dataHome = String(env.XDG_DATA_HOME || path.join(String(env.HOME || os.homedir()), ".local", "share"));
  return path.join(dataHome, "opencode", "opencode.db");
}

export function readRecentOpenCodeSessionsFromDatabasePath(databasePath: string, nowMs: number): RecentAgentSession[] {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`OpenCode database not found at ${databasePath}`);
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const sessions = database.query(`
      select
        id,
        directory,
        title,
        time_created,
        time_updated
      from session
      where time_archived is null
      order by time_updated desc
      limit 500
    `).all() as Array<{
      id: string;
      directory: string;
      title: string;
      time_created: number;
      time_updated: number;
    }>;
    return recentOpenCodeSessionsFromRows(sessions.map((session) => {
      return {
        session,
        messages: readOpenCodeMessagesFromDatabase(database, session.id),
      };
    }), nowMs);
  } finally {
    database.close();
  }
}

export function recentOpenCodeSessionsFromRows(
  rows: Array<{ session: any; messages: any[] }>,
  nowMs: number,
): RecentAgentSession[] {
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  return rows
    .map((row): RecentAgentSession | null => {
      const summary = buildOpenCodeSummary(row.session, row.messages, []);
      const visibleMessages = summary.transcript.filter((message) => {
        return (message.role === "user" || message.role === "assistant") && message.text && message.text !== "[compaction]";
      });
      const lastMessage = visibleMessages
        .slice()
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
      const lastMessageMs = lastMessage ? Date.parse(lastMessage.createdAt) : 0;
      if (!lastMessage || !Number.isFinite(lastMessageMs) || lastMessageMs < cutoffMs) {
        return null;
      }
      return {
        provider: "opencode",
        id: String(row.session.id || ""),
        title: summary.title.slice(0, 120),
        cwd: String(row.session.directory || ""),
        updatedAt: new Date(Number(row.session.time_updated || lastMessageMs)).toISOString(),
        lastMessageAt: new Date(lastMessageMs).toISOString(),
        lastMessageText: lastMessage.text.slice(0, 240),
        messageCount: visibleMessages.length,
        command: "opencode",
        args: ["--session", String(row.session.id || "")],
      };
    })
    .filter((session): session is RecentAgentSession => Boolean(session))
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
}

export function pickOpenCodeModel(messages: any[]) {
  for (const message of [...messages].reverse()) {
    const info = message.info || {};
    if (info.model?.providerID && info.model?.modelID) {
      return {
        providerID: String(info.model.providerID),
        modelID: String(info.model.modelID),
      };
    }
    if (info.providerID && info.modelID) {
      return {
        providerID: String(info.providerID),
        modelID: String(info.modelID),
      };
    }
  }
  return null;
}

function extractOpenCodePartText(part: any) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "text") {
    return String(part.text || "");
  }
  if (part.type === "tool") {
    return `[tool ${String(part.tool || part.callID || "")}]`;
  }
  if (part.type === "file") {
    return `[file ${String(part.url || part.filename || "")}]`;
  }
  if (part.type) {
    return `[${String(part.type)}]`;
  }
  return "";
}

function readOpenCodeMessagesFromDatabase(database: Database, sessionId: string) {
  const messages = database.query(`
    select
      id,
      session_id,
      time_created,
      time_updated,
      data
    from message
    where session_id = $sessionId
    order by time_created asc, id asc
  `).all({ sessionId }) as Array<{
    id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
  const parts = database.query(`
    select
      id,
      message_id,
      session_id,
      time_created,
      time_updated,
      data
    from part
    where session_id = $sessionId
    order by time_created asc, id asc
  `).all({ sessionId }) as Array<{
    id: string;
    message_id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
  }>;
  const partsByMessage = new Map<string, any[]>();
  for (const part of parts) {
    const data = parseJson(part.data) || {};
    const enriched = {
      id: part.id,
      messageID: part.message_id,
      sessionID: part.session_id,
      time: {
        created: part.time_created,
        updated: part.time_updated,
      },
      ...data,
    };
    partsByMessage.set(part.message_id, [...(partsByMessage.get(part.message_id) || []), enriched]);
  }
  return messages.map((message) => {
    const data = parseJson(message.data) || {};
    return {
      info: {
        id: message.id,
        sessionID: message.session_id,
        time: {
          created: message.time_created,
          updated: message.time_updated,
        },
        ...data,
      },
      parts: partsByMessage.get(message.id) || [],
    };
  });
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getExplicitOpenCodeSessionId(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === "--session" || arg === "-s") {
      return args[index + 1] || "";
    }
    if (arg.startsWith("--session=")) {
      return arg.slice("--session=".length);
    }
  }
  return "";
}

function samePath(left: unknown, right: string) {
  if (!left) {
    return false;
  }
  return path.resolve(String(left)) === path.resolve(right);
}
