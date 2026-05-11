import { expect, test } from "bun:test";
import {
  buildOpenCodeSidecarSummary,
  buildOpenCodeSummary,
  createOpenCodeSummaryPrompt,
  recentOpenCodeSessionsFromRows,
  resolveOpenCodeSession,
} from "../src/opencode-sdk.ts";

test("prefers the OpenCode session created for this TUI over stale sessions in the same directory", () => {
  const session = resolveOpenCodeSession({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "old-session",
    args: [],
    sessions: [
      providerSession("old-session", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z"),
      providerSession("new-session", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z"),
    ],
  });

  expect(session).toMatchObject({ id: "new-session" });
});

test("honors an explicit OpenCode --session argument", () => {
  const session = resolveOpenCodeSession({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "",
    args: ["--session", "chosen-session"],
    sessions: [
      providerSession("chosen-session", "/repo", "2026-05-06T19:19:08.000Z", "2026-05-08T14:28:30.000Z"),
      providerSession("new-session", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z"),
    ],
  });

  expect(session).toMatchObject({ id: "chosen-session" });
});

test("keeps the resolved OpenCode source session when a newer fork exists", () => {
  const session = resolveOpenCodeSession({
    cwd: "/repo",
    tuiCreatedAt: "2026-05-08T14:28:00.000Z",
    currentExternalSessionId: "source-session",
    args: [],
    sessions: [
      providerSession("source-session", "/repo", "2026-05-08T14:28:05.000Z", "2026-05-08T14:28:10.000Z"),
      providerSession("summary-fork", "/repo", "2026-05-08T14:29:00.000Z", "2026-05-08T14:29:30.000Z"),
    ],
  });

  expect(session).toMatchObject({ id: "source-session" });
});

test("does not treat compaction as the latest user message", () => {
  const summary = buildOpenCodeSummary(
    { title: "TUI UI test" },
    [
      message("user", "first real prompt"),
      message("assistant", "first answer"),
      message("user", "[compaction]"),
      message("assistant", "summary internals"),
    ],
    [],
  );

  expect(summary).toMatchObject({
    latestUserText: "first real prompt",
    latestAssistantText: "summary internals",
  });
});

test("asks OpenCode sidecars for the shared XML session brief contract", () => {
  const summary = buildOpenCodeSummary(
    { title: "TUI UI test" },
    [message("user", "ship opencode summaries")],
    [],
  );

  const prompt = createOpenCodeSummaryPrompt(summary);

  expect(prompt).toContain("<session_brief format=\"tuiui.sessionBrief.v1\">");
  expect(prompt).toContain("<completed_work>");
  expect(prompt).toContain("<risks_blockers>");
});

test("parses OpenCode sidecar output into a structured session brief", () => {
  const summary = buildOpenCodeSidecarSummary({ id: "fork-session", title: "OpenCode fork" }, structuredBriefXml());

  expect(summary).toMatchObject({
    provider: "opencode",
    title: "OpenCode fork",
    sessionBrief: {
      executiveSummary: "Structured OpenCode brief.",
      filesChanged: [{ path: "src/opencode-sdk.ts", summary: "Prompt and parser wiring." }],
      parseErrors: [],
    },
  });
});

test("lists recent OpenCode sessions by latest visible message", () => {
  const sessions = recentOpenCodeSessionsFromRows([
    {
      session: { id: "older", directory: "/repo", title: "Older OpenCode", time_updated: Date.parse("2026-05-11T09:45:00.000Z") },
      messages: [messageAt("user", "resume opencode on mobile", "2026-05-11T09:30:00.000Z")],
    },
    {
      session: { id: "stale", directory: "/repo", title: "Stale OpenCode", time_updated: Date.parse("2026-05-09T09:45:00.000Z") },
      messages: [messageAt("user", "too old", "2026-05-09T09:30:00.000Z")],
    },
    {
      session: { id: "newest", directory: "/repo", title: "Newest OpenCode", time_updated: Date.parse("2026-05-11T11:59:00.000Z") },
      messages: [
        messageAt("user", "[compaction]", "2026-05-11T11:58:00.000Z"),
        messageAt("assistant", "opencode is now in the launcher", "2026-05-11T11:59:00.000Z"),
      ],
    },
  ], Date.parse("2026-05-11T12:00:00.000Z"));

  expect(sessions).toMatchObject([
    {
      provider: "opencode",
      id: "newest",
      lastMessageAt: "2026-05-11T11:59:00.000Z",
      lastMessageText: "opencode is now in the launcher",
      command: "opencode",
      args: ["--session", "newest"],
    },
    {
      provider: "opencode",
      id: "older",
      lastMessageAt: "2026-05-11T09:30:00.000Z",
      lastMessageText: "resume opencode on mobile",
    },
  ]);
});

function providerSession(id: string, directory: string, createdAt: string, updatedAt: string) {
  return {
    id,
    directory,
    time: {
      created: new Date(createdAt).getTime(),
      updated: new Date(updatedAt).getTime(),
    },
  };
}

function message(role: string, text: string) {
  return {
    info: {
      id: `${role}-${text}`,
      role,
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  };
}

function messageAt(role: string, text: string, createdAt: string) {
  return {
    info: {
      id: `${role}-${text}`,
      role,
      time: { created: new Date(createdAt).getTime() },
    },
    parts: [{ type: "text", text }],
  };
}

function structuredBriefXml() {
  return [
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "  <executive_summary>Structured OpenCode brief.</executive_summary>",
    "  <initial_user_request>Ship summaries.</initial_user_request>",
    "  <current_state>Ready for review.</current_state>",
    "  <completed_work><item>Added OpenCode parsing.</item></completed_work>",
    "  <files_changed><file path=\"src/opencode-sdk.ts\">Prompt and parser wiring.</file></files_changed>",
    "  <risks_blockers></risks_blockers>",
    "  <suggested_next_actions><item>Run the tests.</item></suggested_next_actions>",
    "</session_brief>",
  ].join("\n");
}
