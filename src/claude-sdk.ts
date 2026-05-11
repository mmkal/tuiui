import * as os from "node:os";
import * as path from "node:path";
import {
  getSessionMessages,
  listSessions,
  query,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionSummary, RecentAgentSession } from "./opencode-sdk.ts";
import { createStructuredSessionBriefPrompt, parseStructuredSessionBrief } from "./session-brief.ts";

type ResolveClaudeSessionInput = {
  sessions: SDKSessionInfo[];
  cwd: string;
  tuiCreatedAt: string;
  currentExternalSessionId: string;
  args: string[];
};

let claudeConfigDirQueue = Promise.resolve();

export function claudeConfigDirForEnv(env: NodeJS.ProcessEnv) {
  return String(env.CLAUDE_CONFIG_DIR || path.join(String(env.HOME || os.homedir()), ".claude"));
}

export async function readClaudeSessions(configDir: string, cwd: string) {
  return await withClaudeConfigDir(configDir, async () => {
    const scoped = await listSessions({ dir: cwd, limit: 500 });
    if (scoped.length) {
      return scoped;
    }
    return await listSessions({ limit: 500 });
  });
}

export async function readClaudeSessionMessages(configDir: string, sessionId: string, cwd: string) {
  return await withClaudeConfigDir(configDir, async () => await getClaudeMessagesBySession(sessionId, cwd));
}

export async function readRecentClaudeSessions(configDir: string, nowMs: number): Promise<RecentAgentSession[]> {
  const sessions = await withClaudeConfigDir(configDir, async () => await listSessions({ limit: 500 }));
  return await recentClaudeSessionsFromSdkSessions(configDir, sessions, nowMs);
}

export async function recentClaudeSessionsFromSdkSessions(
  configDir: string,
  sessions: SDKSessionInfo[],
  nowMs: number,
): Promise<RecentAgentSession[]> {
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  const recent = sessions.filter((session) => Number(session.lastModified || 0) >= cutoffMs);
  const results = await Promise.all(recent.map(async (session): Promise<RecentAgentSession | null> => {
    const cwd = String(session.cwd || "");
    const messages = await withClaudeConfigDir(configDir, async () => await getClaudeMessagesBySession(session.sessionId, cwd))
      .catch(() => [] as SessionMessage[]);
    const transcript = buildClaudeTranscript(messages);
    const visibleMessages = transcript.filter((message) => message.text && (message.role === "user" || message.role === "assistant"));
    const lastMessage = visibleMessages
      .slice()
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
    const lastMessageMs = lastMessage ? Date.parse(lastMessage.createdAt) : Number(session.lastModified || 0);
    if (!lastMessage || !Number.isFinite(lastMessageMs) || lastMessageMs < cutoffMs) {
      return null;
    }
    return {
      provider: "claude",
      id: session.sessionId,
      title: String(session.summary || session.firstPrompt || "Claude session").slice(0, 120),
      cwd,
      updatedAt: new Date(Number(session.lastModified || lastMessageMs)).toISOString(),
      lastMessageAt: new Date(lastMessageMs).toISOString(),
      lastMessageText: lastMessage.text.slice(0, 240),
      messageCount: visibleMessages.length,
      command: "claude",
      args: ["--resume", session.sessionId],
    };
  }));
  return results
    .filter((session): session is RecentAgentSession => Boolean(session))
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
}

export function resolveClaudeSession(input: ResolveClaudeSessionInput) {
  const explicitSessionId = getExplicitClaudeSessionId(input.args);
  if (explicitSessionId) {
    const exact = input.sessions.find((candidate) => candidate.sessionId === explicitSessionId);
    if (exact) {
      return exact;
    }
    const matchingSearch = input.sessions
      .filter((candidate) => {
        const haystack = [candidate.summary, candidate.firstPrompt, candidate.customTitle].filter(Boolean).join("\n").toLowerCase();
        return haystack.includes(explicitSessionId.toLowerCase());
      })
      .sort((left, right) => Number(right.lastModified || 0) - Number(left.lastModified || 0))[0];
    if (matchingSearch) {
      return matchingSearch;
    }
  }

  const matchingDirectory = input.sessions.filter((candidate) => samePath(candidate.cwd, input.cwd));
  const candidates = matchingDirectory.length ? matchingDirectory : input.sessions;
  const tuiStartedAt = new Date(input.tuiCreatedAt).getTime();
  const createdAfterLaunch = candidates.filter((candidate) => Number(candidate.createdAt || candidate.lastModified || 0) >= tuiStartedAt - 10_000);

  if (input.currentExternalSessionId) {
    const existing = createdAfterLaunch.find((candidate) => candidate.sessionId === input.currentExternalSessionId);
    if (existing) {
      return existing;
    }
  }

  const freshCandidates = createdAfterLaunch.length ? createdAfterLaunch : candidates;
  return freshCandidates
    .slice()
    .sort((left, right) => Number(right.lastModified || right.createdAt || 0) - Number(left.lastModified || left.createdAt || 0))[0] || null;
}

export function buildClaudeSummary(session: SDKSessionInfo, messages: SessionMessage[]): AgentSessionSummary {
  const transcript = buildClaudeTranscript(messages);
  const userMessages = transcript.filter((message) => message.role === "user" && message.text);
  const assistantMessages = transcript.filter((message) => message.role === "assistant" && message.text);
  const latestUserText = userMessages.at(-1)?.text || String(session.firstPrompt || "");
  const latestAssistantText = assistantMessages.at(-1)?.text || "";
  return {
    provider: "claude",
    title: String(session.summary || session.firstPrompt || "Claude session").slice(0, 200),
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

export function buildClaudeSidecarSummary(sessionId: string, finalResponse: string): AgentSessionSummary {
  const now = new Date().toISOString();
  const text = finalResponse.trim();
  return {
    provider: "claude",
    title: "Claude sidecar summary",
    forkPoint: text ? `${sessionId}-summary` : "",
    messageCount: text ? 1 : 0,
    diffCount: 0,
    additions: 0,
    deletions: 0,
    latestUserText: "",
    latestAssistantText: text,
    sessionBrief: text ? parseStructuredSessionBrief(text) : null,
    transcript: text ? [{
      id: `${sessionId}-summary`,
      role: "assistant",
      createdAt: now,
      text,
    }] : [],
    diffs: [],
  };
}

export function createClaudeSummaryPrompt(summary: AgentSessionSummary) {
  return createStructuredSessionBriefPrompt("Claude", summary);
}

export async function runClaudeSidecarSummary(input: {
  sourceSessionId: string;
  cwd: string;
  configDir: string;
  env: Record<string, string>;
  prompt: string;
}) {
  let forkSessionId = "";
  let finalResponse = "";
  const messages: SDKMessage[] = [];
  for await (const message of query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      resume: input.sourceSessionId,
      forkSession: true,
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      maxTurns: 1,
      env: {
        ...input.env,
        CLAUDE_CONFIG_DIR: input.configDir,
        CLAUDE_AGENT_SDK_CLIENT_APP: "tuiui/claude-summary",
      },
    },
  })) {
    messages.push(message);
    if ("session_id" in message && message.session_id) {
      forkSessionId = message.session_id;
    }
    if (message.type === "result") {
      if (message.subtype !== "success") {
        throw new Error(message.errors.join("\n") || message.subtype);
      }
      finalResponse = message.result;
      forkSessionId = message.session_id || forkSessionId;
    }
  }
  if (!forkSessionId) {
    throw new Error("Claude summary query completed without exposing a fork session id.");
  }
  return {
    forkSessionId,
    finalResponse,
    messages,
  };
}

function buildClaudeTranscript(messages: SessionMessage[]): AgentSessionSummary["transcript"] {
  return messages
    .map((message, index) => {
      return {
        id: String(message.uuid || `${message.session_id}:${index}`),
        role: String(message.type || ""),
        createdAt: String((message as any).timestamp || ""),
        text: extractClaudeMessageText((message as any).message).trim().slice(0, 20_000),
      };
    })
    .filter((message) => message.text);
}

function extractClaudeMessageText(message: any): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => extractClaudeContentPartText(part))
    .filter(Boolean)
    .join("\n");
}

function extractClaudeContentPartText(part: any) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "text") {
    return String(part.text || "");
  }
  if (part.type === "tool_use") {
    return `[tool ${String(part.name || part.id || "")}]`;
  }
  if (part.type === "tool_result") {
    return `[tool_result ${String(part.tool_use_id || "")}]`;
  }
  if (part.type) {
    return `[${String(part.type)}]`;
  }
  return "";
}

function getExplicitClaudeSessionId(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || "";
    if (arg === "--session-id") {
      return args[index + 1] || "";
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length);
    }
    if (arg === "--resume" || arg === "-r") {
      const next = args[index + 1] || "";
      return next && !next.startsWith("-") ? next : "";
    }
    if (arg.startsWith("--resume=")) {
      return arg.slice("--resume=".length);
    }
  }
  return "";
}

async function withClaudeConfigDir<T>(configDir: string, run: () => Promise<T>) {
  const queued = claudeConfigDirQueue.then(async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });
  claudeConfigDirQueue = queued.then(() => undefined, () => undefined);
  return await queued;
}

async function getClaudeMessagesBySession(sessionId: string, cwd: string) {
  const scoped = cwd ? await getSessionMessages(sessionId, { dir: cwd, limit: 500 }) : [];
  if (scoped.length || !cwd) {
    return scoped;
  }
  return await getSessionMessages(sessionId, { limit: 500 });
}

function samePath(left: unknown, right: string) {
  if (!left) {
    return false;
  }
  return path.resolve(String(left)) === path.resolve(right);
}
