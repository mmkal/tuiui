import { expect, test } from "bun:test";
import {
  createCoordinatorSummary,
  resolveCoordinatorTarget,
  type CoordinatorWorkspaceMetadata,
  type LiveCoordinatorSessionInput,
  type RecentCoordinatorSessionInput,
} from "../src/meta-agent-coordinator.ts";
import type { SessionSdkPayload } from "../src/opencode-sdk.ts";

test("summarizes live agents with freshness, confidence, task metadata, and authority boundaries", () => {
  const summary = createCoordinatorSummary({
    generatedAtMs: Date.parse("2026-05-13T12:00:00.000Z"),
    liveSessions: [
      liveSession({
        id: "tuiui_live",
        updatedAt: "2026-05-13T11:59:30.000Z",
        latestUserText: "Implement tasks/meta-agent-coordinator.md for PR #8",
        latestAssistantText: "Ready for review. Should I update PR #8?",
      }),
    ],
    recentSessions: [],
  });

  expect(summary).toMatchObject({
    format: "tuiui.coordinatorSummary.v1",
    counts: {
      agents: 1,
      live: 1,
      running: 1,
      forwardable: 1,
    },
    authority: {
      deterministic: true,
      autonomousProviderBehavior: false,
      requiresConfirmation: true,
    },
  });
  expect(summary.agents[0]).toMatchObject({
    id: "tuiui_live",
    kind: "live",
    currentTask: "The coordinator surface is implemented.",
    taskFiles: ["tasks/meta-agent-coordinator.md"],
    prLinks: ["PR #8"],
    pendingUserDecisions: ["Ready for review. Should I update PR #8?"],
    freshness: {
      level: "fresh",
      ageMs: 30_000,
    },
    confidence: {
      label: "high",
    },
    metadata: {
      source: "runtime",
      sdkState: "connected",
      messageCount: 2,
    },
  });
});

test("keeps recent provider sessions provider-neutral and dedupes provider history already represented by a live session", () => {
  const summary = createCoordinatorSummary({
    generatedAtMs: Date.parse("2026-05-13T12:00:00.000Z"),
    liveSessions: [
      liveSession({
        id: "tuiui_codex",
        externalSessionId: "codex-thread-1",
        updatedAt: "2026-05-13T11:58:00.000Z",
        latestUserText: "Ship the coordinator",
        latestAssistantText: "Working on it.",
      }),
    ],
    recentSessions: [
      recentSession({
        provider: "codex",
        id: "codex-thread-1",
        title: "Duplicate live Codex thread",
        lastMessageAt: "2026-05-13T11:58:10.000Z",
      }),
      recentSession({
        provider: "claude",
        id: "claude-session-2",
        title: "Review stacked PR",
        lastMessageAt: "2026-05-13T11:50:00.000Z",
        command: "claude",
        args: ["--resume", "claude-session-2"],
        recoveryCommand: "claude --resume claude-session-2",
      }),
    ],
  });

  expect(summary.counts).toMatchObject({
    agents: 2,
    live: 1,
    recent: 1,
  });
  expect(summary.agents.map((agent) => agent.stableId)).toEqual([
    "live:tuiui_codex",
    "recent:claude:claude-session-2",
  ]);
  expect(summary.agents[1]).toMatchObject({
    provider: "claude",
    lifecycle: "recent",
    forwardable: false,
    freshness: {
      level: "recent",
    },
    metadata: {
      source: "provider-history",
      recoverable: true,
    },
  });
});

test("resolves forwarding targets only among live running sessions", () => {
  const summary = createCoordinatorSummary({
    generatedAtMs: Date.parse("2026-05-13T12:00:00.000Z"),
    liveSessions: [
      liveSession({
        id: "tuiui_alpha",
        title: "codex coordinator task",
        updatedAt: "2026-05-13T11:59:00.000Z",
      }),
      liveSession({
        id: "tuiui_beta",
        title: "claude notifications task",
        updatedAt: "2026-05-13T11:58:00.000Z",
      }),
    ],
    recentSessions: [
      recentSession({
        provider: "opencode",
        id: "opencode-recent",
        title: "coordinator historical session",
        lastMessageAt: "2026-05-13T11:57:00.000Z",
      }),
    ],
  });

  expect(resolveCoordinatorTarget(summary.agents, "tuiui_alpha")).toMatchObject({
    status: "resolved",
    agent: {
      id: "tuiui_alpha",
    },
  });
  expect(resolveCoordinatorTarget(summary.agents, "notifications")).toMatchObject({
    status: "resolved",
    agent: {
      id: "tuiui_beta",
    },
  });
  expect(resolveCoordinatorTarget(summary.agents, "coordinator")).toMatchObject({
    status: "ambiguous",
    matches: [
      { id: "tuiui_alpha" },
      { id: "tuiui_beta" },
    ],
  });
  expect(resolveCoordinatorTarget(summary.agents, "opencode-recent")).toMatchObject({
    status: "missing",
    agent: null,
  });
});

function liveSession(overrides: Partial<{
  id: string;
  title: string;
  updatedAt: string;
  externalSessionId: string;
  latestUserText: string;
  latestAssistantText: string;
}>): LiveCoordinatorSessionInput {
  const updatedAt = overrides.updatedAt || "2026-05-13T11:59:30.000Z";
  const latestUserText = overrides.latestUserText || "Implement the coordinator";
  const latestAssistantText = overrides.latestAssistantText || "Working on tasks/meta-agent-coordinator.md for PR #8.";
  return {
    id: overrides.id || "tuiui_live",
    title: overrides.title || "codex coordinator task",
    command: "codex",
    args: [],
    cwd: "/repo",
    createdAt: "2026-05-13T11:30:00.000Z",
    updatedAt,
    lastOutputAt: updatedAt,
    lifecycle: "running",
    status: "idle",
    exitCode: null,
    sdk: sdkPayload({
      externalSessionId: overrides.externalSessionId || "provider-live",
      latestUserText,
      latestAssistantText,
    }),
    stdinEvents: [{ id: 1, text: latestUserText, createdAt: updatedAt }],
    stdoutEvents: [{ id: 1, displayText: latestAssistantText, createdAt: updatedAt }],
    semanticStatus: "idle",
    semanticPrompt: latestUserText,
    renderedText: `${latestUserText}\n${latestAssistantText}`,
    recoveryCommand: "codex resume provider-live",
    recoveryCreatedAt: "2026-05-13T11:59:31.000Z",
    workspace: workspace(),
  };
}

function recentSession(overrides: Partial<RecentCoordinatorSessionInput>): RecentCoordinatorSessionInput {
  return {
    provider: overrides.provider || "codex",
    id: overrides.id || "recent-thread",
    title: overrides.title || "Recent coordinator work",
    cwd: "/repo",
    updatedAt: overrides.updatedAt || overrides.lastMessageAt || "2026-05-13T11:50:00.000Z",
    lastMessageAt: overrides.lastMessageAt || "2026-05-13T11:50:00.000Z",
    lastMessageText: overrides.lastMessageText || "latest assistant update",
    initialUserText: overrides.initialUserText || "start the task",
    latestUserText: overrides.latestUserText || "continue the task",
    userMessageCount: overrides.userMessageCount || 2,
    latestAssistantText: overrides.latestAssistantText || "latest assistant update",
    messageCount: overrides.messageCount || 3,
    status: overrides.status || "idle",
    command: overrides.command || "codex",
    args: overrides.args || ["resume", overrides.id || "recent-thread"],
    recoveryCommand: overrides.recoveryCommand || "codex resume recent-thread",
    recoveryCreatedAt: overrides.recoveryCreatedAt || "2026-05-13T11:51:00.000Z",
    workspace: overrides.workspace || workspace(),
  };
}

function sdkPayload(input: {
  externalSessionId: string;
  latestUserText: string;
  latestAssistantText: string;
}): SessionSdkPayload {
  return {
    provider: "codex",
    state: "connected",
    baseUrl: "/tmp/codex/state_5.sqlite",
    externalSessionId: input.externalSessionId,
    status: "gpt-5",
    updatedAt: "2026-05-13T11:59:30.000Z",
    error: "",
    sidecarSummary: {
      implemented: true,
      status: "completed",
      method: "codex.startThread+summary",
      sourceSessionId: input.externalSessionId,
      forkSessionId: "summary-fork",
      forkPoint: "assistant-1",
      updatedAt: "2026-05-13T11:59:30.000Z",
      result: true,
      error: "",
      note: "done",
    },
    forks: [],
    summary: {
      provider: "codex",
      title: "Coordinator summary",
      forkPoint: "assistant-1",
      messageCount: 2,
      diffCount: 0,
      additions: 0,
      deletions: 0,
      latestUserText: input.latestUserText,
      latestAssistantText: input.latestAssistantText,
      sessionBrief: {
        format: "tuiui.sessionBrief.v1",
        executiveSummary: "The coordinator surface is implemented.",
        initialUserRequest: "Implement the coordinator.",
        currentState: "The coordinator surface is implemented.",
        completedWork: ["Added the deterministic summary model."],
        filesChanged: [{ path: "src/meta-agent-coordinator.ts", summary: "Summary model." }],
        risksBlockers: [],
        suggestedNextActions: ["Review PR #8."],
        raw: "<session_brief></session_brief>",
        parseErrors: [],
      },
      transcript: [
        { id: "user-1", role: "user", createdAt: "2026-05-13T11:58:00.000Z", text: input.latestUserText },
        { id: "assistant-1", role: "assistant", createdAt: "2026-05-13T11:59:00.000Z", text: input.latestAssistantText },
      ],
      diffs: [],
    },
  };
}

function workspace(): CoordinatorWorkspaceMetadata {
  return {
    gitRoot: "/repo",
    branch: "bedtime/meta-agent-coordinator",
    gitHead: "abc1234",
    worktree: "/repo",
  };
}
