import { expect, test } from "bun:test";
import {
  buildCoordinatorAgents,
  buildCoordinatorBriefing,
  emptyGitMetadata,
  findCoordinatorClashes,
  findExplicitPromptAgentTargets,
  type CoordinatorAgentSource,
  type CoordinatorGitMetadata,
} from "../src/coordinator-tools.ts";

test("builds augmented coordinator agents from deterministic git metadata", () => {
  const agents = buildCoordinatorAgents([
    source({ id: "session-a", cwd: "/repo-a", title: "Codex A" }),
    source({ id: "session-b", cwd: "/repo-b", title: "Codex B" }),
  ], {
    resolveGitMetadata(cwd) {
      return gitByCwd[cwd] || emptyGitMetadata();
    },
  });

  expect(agents).toMatchObject([
    {
      id: "session-a",
      title: "Codex A",
      gitRoot: "/repo",
      branch: "bedtime/meta-agent",
      dirtyFiles: ["src/coordinator-tools.ts"],
      prNumber: 13,
      promptable: true,
    },
    {
      id: "session-b",
      title: "Codex B",
      gitRoot: "/repo",
      branch: "bedtime/meta-agent",
      dirtyFiles: ["src/coordinator-tools.ts", "client/app.ts"],
      prNumber: 13,
      promptable: true,
    },
  ]);
});

test("finds deterministic dirty-file, branch, and PR clashes", () => {
  const agents = buildCoordinatorAgents([
    source({ id: "session-a", cwd: "/repo-a", title: "Codex A" }),
    source({ id: "session-b", cwd: "/repo-b", title: "Codex B" }),
    source({ id: "session-c", cwd: "/repo-c", title: "Codex C", status: "idle" }),
  ], {
    resolveGitMetadata(cwd) {
      return gitByCwd[cwd] || emptyGitMetadata();
    },
  });

  expect(findCoordinatorClashes(agents)).toMatchObject([
    {
      kind: "dirty-file",
      gitRoot: "/repo",
      file: "src/coordinator-tools.ts",
      agents: [{ id: "session-a" }, { id: "session-b" }],
    },
    {
      kind: "same-branch",
      gitRoot: "/repo",
      branch: "bedtime/meta-agent",
      agents: [{ id: "session-a" }, { id: "session-b" }],
    },
    {
      kind: "same-pr",
      gitRoot: "/repo",
      prNumber: 13,
      agents: [{ id: "session-a" }, { id: "session-b" }],
    },
  ]);
});

test("does not report dirty-file clashes for exited sessions", () => {
  const agents = buildCoordinatorAgents([
    source({ id: "session-a", cwd: "/repo-a", title: "Running Codex" }),
    source({ id: "session-b", cwd: "/repo-b", title: "Exited Codex", status: "exited", lifecycle: "exited" }),
  ], {
    resolveGitMetadata(cwd) {
      return gitByCwd[cwd] || emptyGitMetadata();
    },
  });

  expect(findCoordinatorClashes(agents)).toEqual([]);
});

test("finds explicit promptAgent targets only from human-directed prompts", () => {
  const agents = buildCoordinatorAgents([
    source({ id: "tuiui_alpha", cwd: "/repo-a", title: "Docs Agent" }),
    source({ id: "tuiui_beta", cwd: "/repo-b", title: "Review Agent" }),
  ], {
    resolveGitMetadata() {
      return emptyGitMetadata();
    },
  });

  expect(findExplicitPromptAgentTargets(agents, "what are the clashes?")).toEqual([]);
  expect(findExplicitPromptAgentTargets(agents, "tell Docs Agent to check the MCP docs")).toEqual(["tuiui_alpha"]);
  expect(findExplicitPromptAgentTargets(agents, "ask tuiui_beta to review the coordinator gate")).toEqual(["tuiui_beta"]);
});

test("briefing prefers a current structured session brief", () => {
  const agent = buildCoordinatorAgents([sourceWithBrief()], {
    resolveGitMetadata() {
      return emptyGitMetadata();
    },
  })[0]!;

  expect(buildCoordinatorBriefing(sourceWithBrief(), agent)).toMatchObject({
    state: "briefed",
    source: "session-brief",
    executiveSummary: "Coordinator tools are implemented.",
    currentState: "Tests are being added.",
    completedWork: ["Added deterministic listAgents."],
    filesChanged: [{ path: "src/coordinator-tools.ts", summary: "Added coordination helpers." }],
    risksBlockers: ["Need MCP coverage."],
    suggestedNextActions: ["Run typecheck."],
  });
});

const gitByCwd: Record<string, CoordinatorGitMetadata> = {
  "/repo-a": {
    gitRoot: "/repo",
    branch: "bedtime/meta-agent",
    dirtyFiles: ["src/coordinator-tools.ts"],
    prNumber: 13,
  },
  "/repo-b": {
    gitRoot: "/repo",
    branch: "bedtime/meta-agent",
    dirtyFiles: ["src/coordinator-tools.ts", "client/app.ts"],
    prNumber: 13,
  },
  "/repo-c": {
    gitRoot: "/repo",
    branch: "other-branch",
    dirtyFiles: ["README.md"],
    prNumber: 22,
  },
};

function source(input: {
  id: string;
  cwd: string;
  title: string;
  status?: "busy" | "idle" | "exited";
  lifecycle?: "running" | "exited" | "external";
}): CoordinatorAgentSource {
  return {
    id: input.id,
    source: "managed",
    provider: "codex",
    title: input.title,
    command: "codex",
    args: [],
    cwd: input.cwd,
    status: input.status || "busy",
    lifecycle: input.lifecycle || "running",
    updatedAt: "2026-05-14T07:00:00.000Z",
    lastOutputAt: "2026-05-14T07:00:00.000Z",
    routePath: `/sessions/${input.id}`,
    promptable: true,
    latestUserText: "implement coordinator tools",
    latestAssistantText: "working on it",
    task: "implement coordinator tools",
    sdk: null,
  };
}

function sourceWithBrief(): CoordinatorAgentSource {
  return {
    ...source({ id: "session-briefed", cwd: "/repo-a", title: "Briefed Codex" }),
    sdk: {
      provider: "codex",
      state: "connected",
      baseUrl: "/tmp/codex/state_5.sqlite",
      externalSessionId: "thread-a",
      status: "gpt-5.2-codex",
      updatedAt: "2026-05-14T07:00:00.000Z",
      error: "",
      sidecarSummary: {
        implemented: true,
        status: "completed",
        method: "codex.startThread+summary",
        sourceSessionId: "thread-a",
        forkSessionId: "thread-brief",
        forkPoint: "fork-point-a",
        updatedAt: "2026-05-14T07:05:00.000Z",
        result: true,
        error: "",
        note: "Brief complete.",
      },
      forks: [{
        provider: "codex",
        purpose: "sidecarSummary",
        sourceSessionId: "thread-a",
        forkSessionId: "thread-brief",
        forkPoint: "fork-point-a",
        createdAt: "2026-05-14T07:01:00.000Z",
        updatedAt: "2026-05-14T07:05:00.000Z",
        status: "summarized",
        result: true,
        error: "",
        summary: {
          provider: "codex",
          title: "Coordinator tools",
          forkPoint: "thread-brief-summary",
          messageCount: 1,
          diffCount: 0,
          additions: 0,
          deletions: 0,
          latestUserText: "",
          latestAssistantText: "",
          sessionBrief: {
            format: "tuiui.sessionBrief.v1",
            executiveSummary: "Coordinator tools are implemented.",
            initialUserRequest: "Build a meta-agent with tools.",
            currentState: "Tests are being added.",
            completedWork: ["Added deterministic listAgents."],
            filesChanged: [{ path: "src/coordinator-tools.ts", summary: "Added coordination helpers." }],
            risksBlockers: ["Need MCP coverage."],
            suggestedNextActions: ["Run typecheck."],
            raw: "<session_brief />",
            parseErrors: [],
          },
          transcript: [],
          diffs: [],
        },
      }],
      summary: {
        provider: "codex",
        title: "Coordinator tools",
        forkPoint: "fork-point-a",
        messageCount: 2,
        diffCount: 0,
        additions: 0,
        deletions: 0,
        latestUserText: "Build a meta-agent with tools.",
        latestAssistantText: "Working on coordinator tools.",
        sessionBrief: null,
        transcript: [],
        diffs: [],
      },
    },
  };
}
