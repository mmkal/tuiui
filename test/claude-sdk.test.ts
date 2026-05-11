import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import {
  buildClaudeSummary,
  buildClaudeSidecarSummary,
  claudeConfigDirForEnv,
  createClaudeSummaryPrompt,
  readRecentClaudeSessions,
  resolveClaudeSession,
} from "../src/claude-sdk.ts";

test("resolves Claude config from CLAUDE_CONFIG_DIR before HOME", () => {
  expect(claudeConfigDirForEnv({
    CLAUDE_CONFIG_DIR: "/tmp/claude-config",
    HOME: "/tmp/home",
  })).toBe("/tmp/claude-config");
});

test("prefers the Claude session created for this TUI over stale sessions in the same directory", () => {
  const session = resolveClaudeSession({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: [],
    sessions: [
      claudeSession("old-session", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z"),
      claudeSession("new-session", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z"),
    ],
  });

  expect(session).toMatchObject({ sessionId: "new-session" });
});

test("honors an explicit Claude --resume session id", () => {
  const session = resolveClaudeSession({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: ["--resume", "chosen-session"],
    sessions: [
      claudeSession("chosen-session", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z"),
      claudeSession("new-session", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z"),
    ],
  });

  expect(session).toMatchObject({ sessionId: "chosen-session" });
});

test("builds a Claude summary from SDK session messages", () => {
  const summary = buildClaudeSummary(
    claudeSession("source-session", "/repo", "2026-05-08T14:28:00.000Z", "2026-05-08T14:28:05.000Z"),
    [
      claudeMessage("user", "ship claude summaries", "2026-05-08T14:28:01.000Z"),
      claudeMessage("assistant", "claude summary is wired", "2026-05-08T14:28:02.000Z"),
      claudeMessage("user", "make it sidecar", "2026-05-08T14:28:03.000Z"),
    ],
  );

  expect(summary).toMatchObject({
    provider: "claude",
    title: "Claude test session",
    messageCount: 3,
    latestUserText: "make it sidecar",
    latestAssistantText: "claude summary is wired",
  });
});

test("asks Claude sidecars for the shared XML session brief contract", () => {
  const summary = buildClaudeSummary(
    claudeSession("source-session", "/repo", "2026-05-08T14:28:00.000Z", "2026-05-08T14:28:05.000Z"),
    [claudeMessage("user", "ship claude summaries", "2026-05-08T14:28:01.000Z")],
  );

  const prompt = createClaudeSummaryPrompt(summary);

  expect(prompt).toContain("<session_brief format=\"tuiui.sessionBrief.v1\">");
  expect(prompt).toContain("<current_state>");
  expect(prompt).toContain("<files_changed>");
});

test("parses Claude sidecar output into a structured session brief", () => {
  const summary = buildClaudeSidecarSummary("fork-session", structuredBriefXml());

  expect(summary).toMatchObject({
    provider: "claude",
    sessionBrief: {
      executiveSummary: "Structured Claude brief.",
      completedWork: ["Added Claude parsing."],
      suggestedNextActions: ["Run the tests."],
      parseErrors: [],
    },
  });
});

test("lists recent Claude sessions from the SDK transcript store", async () => {
  using workspace = createTempWorkspace();
  const cwd = path.join(workspace.path, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  writeClaudeJsonlSession(workspace.path, cwd, {
    sessionId: "00000000-0000-4000-8000-000000000123",
    userText: "resume claude on mobile",
    assistantText: "claude is in recent sessions",
    messageAt: "2026-05-11T11:59:00.000Z",
  });

  const sessions = await readRecentClaudeSessions(workspace.path, Date.parse("2026-05-11T12:00:00.000Z"));

  expect(sessions).toMatchObject([
    {
      provider: "claude",
      id: "00000000-0000-4000-8000-000000000123",
      lastMessageAt: "2026-05-11T11:59:00.000Z",
      lastMessageText: "claude is in recent sessions",
      command: "claude",
      args: ["--resume", "00000000-0000-4000-8000-000000000123"],
    },
  ]);
});

function claudeSession(sessionId: string, cwd: string, createdAt: string, updatedAt: string) {
  return {
    sessionId,
    summary: "Claude test session",
    firstPrompt: "ship claude summaries",
    cwd,
    createdAt: Date.parse(createdAt),
    lastModified: Date.parse(updatedAt),
  };
}

function claudeMessage(role: "user" | "assistant", text: string, timestamp: string): any {
  return {
    type: role,
    uuid: `${role}-${timestamp}`,
    session_id: "source-session",
    message: {
      role,
      content: role === "user" ? text : [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    timestamp,
  };
}

function writeClaudeJsonlSession(
  configDir: string,
  cwd: string,
  options: { sessionId: string; userText: string; assistantText: string; messageAt: string },
) {
  const sessionDir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(sessionDir, { recursive: true });
  const userAt = new Date(Date.parse(options.messageAt) - 1_000).toISOString();
  fs.writeFileSync(path.join(sessionDir, `${options.sessionId}.jsonl`), [
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000001",
      sessionId: options.sessionId,
      cwd,
      timestamp: userAt,
      message: { role: "user", content: options.userText },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000002",
      sessionId: options.sessionId,
      cwd,
      timestamp: options.messageAt,
      message: {
        role: "assistant",
        content: [{ type: "text", text: options.assistantText }],
      },
    }),
  ].join("\n"));
}

function structuredBriefXml() {
  return [
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "  <executive_summary>Structured Claude brief.</executive_summary>",
    "  <initial_user_request>Ship summaries.</initial_user_request>",
    "  <current_state>Ready for review.</current_state>",
    "  <completed_work><item>Added Claude parsing.</item></completed_work>",
    "  <files_changed><file path=\"src/claude-sdk.ts\">Prompt and parser wiring.</file></files_changed>",
    "  <risks_blockers></risks_blockers>",
    "  <suggested_next_actions><item>Run the tests.</item></suggested_next_actions>",
    "</session_brief>",
  ].join("\n");
}

function createTempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-claude-sdk-test-"));
  return {
    path: workspace,
    [Symbol.dispose]() {
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}
