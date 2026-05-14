import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  buildCodexSummary,
  buildCodexSidecarSummary,
  createCodexSummaryPrompt,
  discardCodexThreadFromDatabasePath,
  readCodexThreadsFromDatabasePath,
  readRecentCodexSessionsFromDatabasePath,
  recentCodexSessionsFromThreads,
  resolveCodexStateDatabasePathForEnv,
  resolveCodexThread,
  type CodexThreadRow,
} from "../src/codex-sdk.ts";

test("prefers the Codex thread created for this TUI over stale threads in the same directory", () => {
  const thread = resolveCodexThread({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: [],
    threads: [
      codexThread("old-thread", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z", ""),
      codexThread("new-thread", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z", ""),
    ],
  });

  expect(thread).toMatchObject({ id: "new-thread" });
});

test("keeps the resolved Codex source thread when a newer sidecar exists", () => {
  const thread = resolveCodexThread({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "source-thread",
    args: [],
    threads: [
      codexThread("source-thread", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z", ""),
      codexThread("sidecar-summary", "/repo", "2026-05-08T14:29:00.000Z", "2026-05-08T14:29:30.000Z", ""),
    ],
  });

  expect(thread).toMatchObject({ id: "source-thread" });
});

test("does not resolve a stale supervising Codex thread before the launched TUI thread is visible", () => {
  const thread = resolveCodexThread({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: [],
    threads: [
      codexThread("this-session", "/repo", "2026-05-08T13:00:00.000Z", "2026-05-08T14:29:30.000Z", ""),
    ],
  });

  expect(thread).toBeNull();
});

test("does not keep a stale pinned Codex thread once the launched TUI thread appears", () => {
  const thread = resolveCodexThread({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "this-session",
    args: [],
    threads: [
      codexThread("this-session", "/repo", "2026-05-08T13:00:00.000Z", "2026-05-08T14:29:30.000Z", ""),
      codexThread("launched-tui", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z", ""),
    ],
  });

  expect(thread).toMatchObject({ id: "launched-tui" });
});

test("honors an explicit Codex resume thread id", () => {
  const thread = resolveCodexThread({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: ["resume", "chosen-thread"],
    threads: [
      codexThread("chosen-thread", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z", ""),
      codexThread("new-thread", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z", ""),
    ],
  });

  expect(thread).toMatchObject({ id: "chosen-thread" });
});

test("resolves an empty CODEX_HOME to the state database Codex will create there", () => {
  using workspace = createTempWorkspace();

  expect(resolveCodexStateDatabasePathForEnv({
    CODEX_HOME: workspace.path,
    HOME: path.join(workspace.path, "home"),
  })).toBe(path.join(workspace.path, "state_5.sqlite"));
});

test("repairs a stored CODEX_HOME .codex database path when Codex creates the sibling state database", () => {
  using workspace = createTempWorkspace();
  const codexHome = path.join(workspace.path, "codex-home");
  const actualDatabasePath = path.join(codexHome, "state_5.sqlite");
  createCodexThreadDatabase(actualDatabasePath, codexThread(
    "launched-tui",
    "/repo",
    "2026-05-08T14:28:05.000Z",
    "2026-05-08T14:28:10.000Z",
    "",
  ));

  const threads = readCodexThreadsFromDatabasePath(path.join(codexHome, ".codex", "state_5.sqlite"));

  expect(threads).toMatchObject([{ id: "launched-tui" }]);
});

test("lists recent Codex sessions by latest visible message", () => {
  using workspace = createTempWorkspace();
  const nowMs = Date.parse("2026-05-11T12:00:00.000Z");
  const newestRollout = path.join(workspace.path, "newest.jsonl");
  const olderRollout = path.join(workspace.path, "older.jsonl");
  const staleRollout = path.join(workspace.path, "stale.jsonl");
  const sidecarRollout = path.join(workspace.path, "sidecar.jsonl");
  fs.writeFileSync(newestRollout, [
    rolloutMessage("2026-05-11T11:58:00.000Z", "user", "# AGENTS.md instructions for /repo"),
    rolloutMessage("2026-05-11T11:58:30.000Z", "user", "build the phone launcher"),
    rolloutMessage("2026-05-11T11:59:00.000Z", "assistant", "working on the phone launcher"),
  ].join("\n"));
  fs.writeFileSync(olderRollout, rolloutMessage("2026-05-11T09:30:00.000Z", "user", "resume this on mobile"));
  fs.writeFileSync(staleRollout, rolloutMessage("2026-05-09T09:30:00.000Z", "user", "too old"));
  fs.writeFileSync(sidecarRollout, [
    rolloutMessage("2026-05-11T11:59:20.000Z", "user", structuredSessionBriefPrompt("Codex")),
    rolloutMessage("2026-05-11T11:59:30.000Z", "assistant", structuredBriefXml()),
  ].join("\n"));

  const sessions = recentCodexSessionsFromThreads([
    codexThread("older", "/repo", "2026-05-11T09:00:00.000Z", "2026-05-11T09:40:00.000Z", olderRollout),
    codexThread("stale", "/repo", "2026-05-09T09:00:00.000Z", "2026-05-11T11:55:00.000Z", staleRollout),
    codexThread("newest", "/repo", "2026-05-11T11:00:00.000Z", "2026-05-11T11:59:00.000Z", newestRollout),
    codexThread("sidecar-summary", "/repo", "2026-05-11T11:59:15.000Z", "2026-05-11T11:59:30.000Z", sidecarRollout),
  ], nowMs);

  expect(sessions).toMatchObject([
    {
      id: "newest",
      lastMessageAt: "2026-05-11T11:59:00.000Z",
      lastMessageText: "working on the phone launcher",
      initialUserText: "build the phone launcher",
      latestUserText: "build the phone launcher",
      userMessageCount: 1,
      latestAssistantText: "working on the phone launcher",
      messageCount: 2,
      status: "idle",
    },
    {
      id: "older",
      lastMessageAt: "2026-05-11T09:30:00.000Z",
      lastMessageText: "resume this on mobile",
      messageCount: 1,
      status: "busy",
    },
  ]);
});

test("skips stale Codex database rows before reading rollout transcripts", () => {
  using workspace = createTempWorkspace();
  const nowMs = Date.parse("2026-05-11T12:00:00.000Z");
  const databasePath = path.join(workspace.path, "state_5.sqlite");
  const recentRollout = path.join(workspace.path, "recent.jsonl");
  fs.writeFileSync(recentRollout, rolloutMessage("2026-05-11T11:59:00.000Z", "user", "recent ask"));
  createCodexThreadDatabase(
    databasePath,
    codexThread("stale-broken", "/repo", "2026-05-09T09:00:00.000Z", "2026-05-09T09:30:00.000Z", workspace.path),
    codexThread("recent", "/repo", "2026-05-11T11:00:00.000Z", "2026-05-11T11:59:00.000Z", recentRollout),
  );

  const sessions = readRecentCodexSessionsFromDatabasePath(databasePath, nowMs);

  expect(sessions).toMatchObject([
    {
      id: "recent",
      latestUserText: "recent ask",
    },
  ]);
});

test("discards Codex sidecar threads by archiving metadata and removing the rollout", () => {
  using workspace = createTempWorkspace();
  const databasePath = path.join(workspace.path, "state_5.sqlite");
  const rolloutPath = path.join(workspace.path, "sidecar.jsonl");
  fs.writeFileSync(rolloutPath, rolloutMessage("2026-05-11T11:59:20.000Z", "user", structuredSessionBriefPrompt("Codex")));
  createCodexThreadDatabase(databasePath, codexThread(
    "sidecar-summary",
    "/repo",
    "2026-05-11T11:59:15.000Z",
    "2026-05-11T11:59:30.000Z",
    rolloutPath,
  ));

  expect(discardCodexThreadFromDatabasePath(databasePath, "sidecar-summary")).toBe(true);

  expect(fs.existsSync(rolloutPath)).toBe(false);
  expect(readCodexThreadsFromDatabasePath(databasePath)).toEqual([]);
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = database.query("select archived from threads where id = 'sidecar-summary'").get() as { archived: number };
    expect(row).toMatchObject({ archived: 1 });
  } finally {
    database.close();
  }
});

test("builds a Codex summary from rollout messages without treating AGENTS as the latest user message", () => {
  using workspace = createTempWorkspace();
  const rolloutPath = path.join(workspace.path, "rollout.jsonl");
  fs.writeFileSync(rolloutPath, [
    rolloutMessage("2026-05-08T14:28:01.000Z", "user", "# AGENTS.md instructions\ninternal setup"),
    rolloutMessage("2026-05-08T14:28:02.000Z", "user", "ship codex summaries"),
    rolloutMessage("2026-05-08T14:28:03.000Z", "assistant", "working on it"),
    rolloutMessage("2026-05-08T14:28:04.000Z", "user", "make it sidecar"),
    rolloutMessage("2026-05-08T14:28:05.000Z", "assistant", "sidecar is wired"),
  ].join("\n"));

  const summary = buildCodexSummary(codexThread(
    "source-thread",
    "/repo",
    "2026-05-08T14:28:00.000Z",
    "2026-05-08T14:28:05.000Z",
    rolloutPath,
  ));

  expect(summary).toMatchObject({
    provider: "codex",
    title: "Codex test thread",
    messageCount: 5,
    latestUserText: "make it sidecar",
    latestAssistantText: "sidecar is wired",
    transcript: [
      { role: "user", text: "# AGENTS.md instructions\ninternal setup" },
      { role: "user", text: "ship codex summaries" },
      { role: "assistant", text: "working on it" },
      { role: "user", text: "make it sidecar" },
      { role: "assistant", text: "sidecar is wired" },
    ],
  });
});

test("asks Codex sidecars for the shared XML session brief contract", () => {
  const summary = buildCodexSummary(codexThread(
    "source-thread",
    "/repo",
    "2026-05-08T14:28:00.000Z",
    "2026-05-08T14:28:05.000Z",
    "",
  ));

  const prompt = createCodexSummaryPrompt(summary);

  expect(prompt).toContain("<session_brief format=\"tuiui.sessionBrief.v1\">");
  expect(prompt).toContain("<executive_summary>");
  expect(prompt).toContain("<suggested_next_actions>");
});

test("parses Codex sidecar output into a structured session brief", () => {
  const summary = buildCodexSidecarSummary("sidecar-thread", structuredBriefXml());

  expect(summary).toMatchObject({
    provider: "codex",
    latestAssistantText: expect.stringContaining("<session_brief"),
    sessionBrief: {
      executiveSummary: "Structured Codex brief.",
      completedWork: ["Added Codex parsing."],
      suggestedNextActions: ["Review the PR."],
      parseErrors: [],
    },
  });
});

function codexThread(id: string, cwd: string, createdAt: string, updatedAt: string, rolloutPath: string): CodexThreadRow {
  return {
    id,
    rollout_path: rolloutPath,
    created_at: Math.floor(new Date(createdAt).getTime() / 1000),
    updated_at: Math.floor(new Date(updatedAt).getTime() / 1000),
    source: "cli",
    model_provider: "openai",
    cwd,
    title: "Codex test thread",
    tokens_used: 0,
    first_user_message: "ship codex summaries",
    model: "gpt-5.5",
    reasoning_effort: "medium",
    created_at_ms: new Date(createdAt).getTime(),
    updated_at_ms: new Date(updatedAt).getTime(),
  };
}

function rolloutMessage(timestamp: string, role: string, text: string) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      }],
    },
  });
}

function structuredBriefXml() {
  return [
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "  <executive_summary>Structured Codex brief.</executive_summary>",
    "  <initial_user_request>Ship summaries.</initial_user_request>",
    "  <current_state>Ready for review.</current_state>",
    "  <completed_work><item>Added Codex parsing.</item></completed_work>",
    "  <files_changed><file path=\"src/codex-sdk.ts\">Prompt and parser wiring.</file></files_changed>",
    "  <risks_blockers></risks_blockers>",
    "  <suggested_next_actions><item>Review the PR.</item></suggested_next_actions>",
    "</session_brief>",
  ].join("\n");
}

function structuredSessionBriefPrompt(provider: string) {
  return [
    `Create a structured Session brief for this ${provider} TUI session.`,
    "",
    "Return only this XML-style contract, with every tag present even when the value is empty:",
    "",
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "</session_brief>",
    "",
    "Use only the transcript below.",
  ].join("\n");
}

function createCodexThreadDatabase(databasePath: string, ...threads: CodexThreadRow[]) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.exec(`
      create table threads (
        id text primary key,
        rollout_path text not null,
        created_at integer not null,
        updated_at integer not null,
        source text not null,
        model_provider text not null,
        cwd text not null,
        title text not null,
        tokens_used integer not null,
        first_user_message text not null,
        model text,
        reasoning_effort text,
        created_at_ms integer,
        updated_at_ms integer,
        archived integer not null default 0
      );
    `);
    const insert = database.query(`
      insert into threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        tokens_used, first_user_message, model, reasoning_effort, created_at_ms, updated_at_ms, archived
      ) values (
        $id,
        $rolloutPath,
        $createdAt,
        $updatedAt,
        $source,
        $modelProvider,
        $cwd,
        $title,
        $tokensUsed,
        $firstUserMessage,
        $model,
        $reasoningEffort,
        $createdAtMs,
        $updatedAtMs,
        0
      );
    `);
    for (const thread of threads) {
      insert.run({
        $id: thread.id,
        $rolloutPath: thread.rollout_path,
        $createdAt: thread.created_at,
        $updatedAt: thread.updated_at,
        $source: thread.source,
        $modelProvider: thread.model_provider,
        $cwd: thread.cwd,
        $title: thread.title,
        $tokensUsed: thread.tokens_used,
        $firstUserMessage: thread.first_user_message,
        $model: thread.model,
        $reasoningEffort: thread.reasoning_effort,
        $createdAtMs: thread.created_at_ms,
        $updatedAtMs: thread.updated_at_ms,
      });
    }
  } finally {
    database.close();
  }
}

function createTempWorkspace() {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-codex-sdk-"));
  return {
    path: tempPath,
    [Symbol.dispose]() {
      fs.rmSync(tempPath, { recursive: true, force: true });
    },
  };
}
