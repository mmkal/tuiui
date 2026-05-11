import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { AgentSessionSummary, RecentAgentSession } from "./opencode-sdk.ts";
import { createStructuredSessionBriefPrompt, parseStructuredSessionBrief } from "./session-brief.ts";

export type CodexThreadRow = {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  tokens_used: number;
  first_user_message: string;
  model: string;
  reasoning_effort: string;
  created_at_ms: number | null;
  updated_at_ms: number | null;
};

type ResolveCodexThreadInput = {
  threads: CodexThreadRow[];
  cwd: string;
  tuiCreatedAt: string;
  currentExternalSessionId: string;
  args: string[];
};

export function codexStateDatabasePath(homeDir: string) {
  return path.join(homeDir, ".codex", "state_5.sqlite");
}

export function resolveCodexStateDatabasePath(homeDir: string) {
  return resolveCodexStateDatabasePathForUserHome(homeDir);
}

export function resolveCodexStateDatabasePathForEnv(env: NodeJS.ProcessEnv) {
  const codexHome = String(env.CODEX_HOME || "");
  if (codexHome) {
    return resolveCodexStateDatabasePathForCodexHome(codexHome);
  }
  return resolveCodexStateDatabasePathForUserHome(String(env.HOME || os.homedir()));
}

function resolveCodexStateDatabasePathForUserHome(homeDir: string) {
  const candidates = [
    path.join(homeDir, "state_5.sqlite"),
    codexStateDatabasePath(homeDir),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1]!;
}

function resolveCodexStateDatabasePathForCodexHome(codexHome: string) {
  const candidates = [
    path.join(codexHome, "state_5.sqlite"),
    path.join(codexHome, ".codex", "state_5.sqlite"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]!;
}

export function codexHomeDirFromStateDatabasePath(databasePath: string) {
  return path.dirname(path.resolve(databasePath));
}

export function readCodexThreads(homeDir: string): CodexThreadRow[] {
  const databasePath = resolveCodexStateDatabasePath(homeDir);
  return readCodexThreadsFromDatabasePath(databasePath);
}

export function readCodexThreadsFromDatabasePath(databasePath: string): CodexThreadRow[] {
  const resolvedPath = resolveStoredCodexStateDatabasePath(databasePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Codex state database not found at ${resolvedPath}`);
  }
  const database = new Database(resolvedPath, { readonly: true, strict: true });
  try {
    return database.query(`
      select
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        tokens_used,
        first_user_message,
        model,
        reasoning_effort,
        created_at_ms,
        updated_at_ms
      from threads
      where archived = 0
      order by coalesce(updated_at_ms, updated_at * 1000) desc
      limit 500
    `).all() as CodexThreadRow[];
  } finally {
    database.close();
  }
}

function resolveStoredCodexStateDatabasePath(databasePath: string) {
  const direct = path.resolve(databasePath);
  const parent = path.dirname(direct);
  const candidates = path.basename(parent) === ".codex"
    ? [direct, path.join(path.dirname(parent), "state_5.sqlite")]
    : [direct, path.join(parent, ".codex", "state_5.sqlite")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || direct;
}

export function readRecentCodexSessionsFromDatabasePath(databasePath: string, nowMs: number) {
  return recentCodexSessionsFromThreads(readCodexThreadsFromDatabasePath(databasePath), nowMs);
}

export function recentCodexSessionsFromThreads(threads: CodexThreadRow[], nowMs: number) {
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  return threads
    .map((thread): RecentAgentSession | null => {
      const messages = visibleCodexMessages(thread);
      const lastMessage = messages
        .slice()
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
      const lastMessageMs = lastMessage ? Date.parse(lastMessage.createdAt) : 0;
      if (!lastMessage || !Number.isFinite(lastMessageMs) || lastMessageMs < cutoffMs) {
        return null;
      }
      return {
        provider: "codex",
        id: thread.id,
        title: String(thread.title || thread.first_user_message || "Codex session").slice(0, 120),
        cwd: String(thread.cwd || ""),
        updatedAt: new Date(codexUpdatedAt(thread)).toISOString(),
        lastMessageAt: new Date(lastMessageMs).toISOString(),
        lastMessageText: lastMessage.text.slice(0, 240),
        messageCount: messages.length,
        command: "codex",
        args: ["resume", thread.id],
      };
    })
    .filter((session): session is RecentAgentSession => Boolean(session))
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
}

export function resolveCodexThread(input: ResolveCodexThreadInput) {
  const explicitThreadId = getExplicitCodexThreadId(input.args);
  if (explicitThreadId) {
    return input.threads.find((candidate) => candidate.id === explicitThreadId) || null;
  }

  const matchingDirectory = input.threads.filter((candidate) => samePath(candidate.cwd, input.cwd));
  const candidates = matchingDirectory.length ? matchingDirectory : input.threads;
  const tuiStartedAt = new Date(input.tuiCreatedAt).getTime();
  const createdAfterLaunch = candidates.filter((candidate) => codexCreatedAt(candidate) >= tuiStartedAt - 10_000);

  if (input.currentExternalSessionId) {
    const existing = createdAfterLaunch.find((candidate) => candidate.id === input.currentExternalSessionId);
    if (existing) {
      return existing;
    }
  }

  return createdAfterLaunch
    .slice()
    .sort((left, right) => codexUpdatedAt(right) - codexUpdatedAt(left))[0] || null;
}

export function buildCodexSummary(thread: CodexThreadRow): AgentSessionSummary {
  const transcript = readCodexTranscript(thread.rollout_path);
  const userMessages = transcript.filter((message) => message.role === "user" && message.text && !isCodexInternalUserText(message.text));
  const assistantMessages = transcript.filter((message) => message.role === "assistant" && message.text);
  const latestUserText = userMessages.at(-1)?.text || String(thread.first_user_message || "");
  const latestAssistantText = assistantMessages.at(-1)?.text || "";

  return {
    provider: "codex",
    title: String(thread.title || thread.first_user_message || "Codex thread").slice(0, 200),
    forkPoint: transcript.at(-1)?.id || "",
    messageCount: transcript.length,
    diffCount: 0,
    additions: 0,
    deletions: 0,
    latestUserText: latestUserText.slice(0, 20_000),
    latestAssistantText: latestAssistantText.slice(0, 20_000),
    sessionBrief: null,
    transcript: transcript.slice(-80),
    diffs: [],
  };
}

export function buildCodexSidecarSummary(threadId: string, finalResponse: string): AgentSessionSummary {
  const now = new Date().toISOString();
  const text = finalResponse.trim();
  return {
    provider: "codex",
    title: "Codex sidecar summary",
    forkPoint: text ? `${threadId}-summary` : "",
    messageCount: text ? 1 : 0,
    diffCount: 0,
    additions: 0,
    deletions: 0,
    latestUserText: "",
    latestAssistantText: text,
    sessionBrief: text ? parseStructuredSessionBrief(text) : null,
    transcript: text ? [{
      id: `${threadId}-summary`,
      role: "assistant",
      createdAt: now,
      text,
    }] : [],
    diffs: [],
  };
}

export function createCodexSummaryPrompt(summary: AgentSessionSummary) {
  return createStructuredSessionBriefPrompt("Codex", summary);
}

export function getCodexHomeDir(env: NodeJS.ProcessEnv) {
  return String(env.CODEX_HOME || env.HOME || os.homedir());
}

function readCodexTranscript(rolloutPath: string) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return [];
  }
  const lines = fs.readFileSync(rolloutPath, "utf8").split("\n");
  const transcript: AgentSessionSummary["transcript"] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const event = parseJsonLine(line);
    if (event?.type !== "response_item" || event.payload?.type !== "message") {
      continue;
    }
    const role = String(event.payload.role || "");
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractCodexMessageText(event.payload.content).trim();
    if (!text) {
      continue;
    }
    transcript.push({
      id: `${rolloutPath}:${transcript.length}`,
      role,
      createdAt: String(event.timestamp || ""),
      text: text.slice(0, 20_000),
    });
  }
  return transcript;
}

function visibleCodexMessages(thread: CodexThreadRow) {
  return readCodexTranscript(thread.rollout_path)
    .filter((message) => {
      if (message.role === "assistant") {
        return true;
      }
      return message.role === "user" && !isCodexInternalUserText(message.text);
    });
}

function extractCodexMessageText(content: unknown) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      const type = String(record.type || "");
      if (type === "input_text" || type === "output_text") {
        return String(record.text || "");
      }
      if (type) {
        return `[${type}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function getExplicitCodexThreadId(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === "resume" || arg === "fork") {
      for (let candidateIndex = index + 1; candidateIndex < args.length; candidateIndex += 1) {
        const candidate = args[candidateIndex] || "";
        if (!candidate.startsWith("-")) {
          return candidate;
        }
      }
    }
  }
  return "";
}

function isCodexInternalUserText(text: string) {
  return text.startsWith("# AGENTS.md instructions") || text.startsWith("<environment_context>");
}

function codexCreatedAt(thread: CodexThreadRow) {
  return Number(thread.created_at_ms || thread.created_at * 1000 || 0);
}

function codexUpdatedAt(thread: CodexThreadRow) {
  return Number(thread.updated_at_ms || thread.updated_at * 1000 || codexCreatedAt(thread));
}

function samePath(left: unknown, right: string) {
  if (!left) {
    return false;
  }
  return path.resolve(String(left)) === path.resolve(right);
}
