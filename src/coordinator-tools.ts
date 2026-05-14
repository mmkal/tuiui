import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { AgentProvider, AgentSessionSummary, RecentAgentSession, SessionSdkPayload } from "./opencode-sdk.ts";

export type CoordinatorAgentStatus = "busy" | "idle" | "exited";
export type CoordinatorAgentLifecycle = "running" | "exited" | "external";

export type CoordinatorAgentSource = {
  id: string;
  source: "managed" | "recent-codex";
  provider: AgentProvider | "";
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: CoordinatorAgentStatus;
  lifecycle: CoordinatorAgentLifecycle;
  updatedAt: string;
  lastOutputAt: string;
  routePath: string;
  promptable: boolean;
  latestUserText: string;
  latestAssistantText: string;
  task: string;
  sdk: SessionSdkPayload | null;
};

export type CoordinatorGitMetadata = {
  gitRoot: string;
  branch: string;
  dirtyFiles: string[];
  prNumber: number | null;
};

export type CoordinatorAgent = {
  id: string;
  source: "managed" | "recent-codex";
  provider: AgentProvider | "";
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: CoordinatorAgentStatus;
  lifecycle: CoordinatorAgentLifecycle;
  updatedAt: string;
  lastOutputAt: string;
  routePath: string;
  promptable: boolean;
  latestUserText: string;
  latestAssistantText: string;
  task: string;
  gitRoot: string;
  branch: string;
  dirtyFiles: string[];
  prNumber: number | null;
};

export type CoordinatorBriefing = {
  agent: CoordinatorAgent;
  state: "briefed" | "snapshot" | "unavailable";
  source: "session-brief" | "provider-snapshot" | "terminal";
  executiveSummary: string;
  initialUserRequest: string;
  currentState: string;
  completedWork: string[];
  filesChanged: Array<{ path: string; summary: string }>;
  risksBlockers: string[];
  suggestedNextActions: string[];
  latestUserText: string;
  latestAssistantText: string;
  updatedAt: string;
};

export type CoordinatorClash = {
  kind: "dirty-file" | "same-branch" | "same-pr";
  gitRoot: string;
  branch: string;
  file: string;
  prNumber: number | null;
  agents: Array<Pick<CoordinatorAgent, "id" | "title" | "status" | "routePath">>;
};

export type CoordinatorPromptResult = {
  ok: boolean;
  agentId: string;
  prompt: string;
  message: string;
  createdAt: string;
};

export type CoordinatorSubscriptionResult = {
  ok: boolean;
  agentId: string;
  message: string;
  createdAt: string;
};

export type BuildCoordinatorAgentsOptions = {
  resolveGitMetadata: (cwd: string) => CoordinatorGitMetadata;
};

const gitMetadataCache = new Map<string, { expiresAtMs: number; metadata: CoordinatorGitMetadata }>();
const gitMetadataCacheMs = 30_000;

export function buildCoordinatorAgents(
  sources: CoordinatorAgentSource[],
  options: BuildCoordinatorAgentsOptions = { resolveGitMetadata },
): CoordinatorAgent[] {
  const gitByCwd = new Map<string, CoordinatorGitMetadata>();
  return sources
    .filter((source) => Boolean(source.id))
    .map((source) => {
      let git = gitByCwd.get(source.cwd);
      if (!git) {
        git = options.resolveGitMetadata(source.cwd);
        gitByCwd.set(source.cwd, git);
      }
      return {
        id: source.id,
        source: source.source,
        provider: source.provider,
        title: source.title,
        command: source.command,
        args: source.args,
        cwd: source.cwd,
        status: source.status,
        lifecycle: source.lifecycle,
        updatedAt: source.updatedAt,
        lastOutputAt: source.lastOutputAt,
        routePath: source.routePath,
        promptable: source.promptable,
        latestUserText: source.latestUserText,
        latestAssistantText: source.latestAssistantText,
        task: source.task,
        gitRoot: git.gitRoot,
        branch: git.branch,
        dirtyFiles: git.dirtyFiles,
        prNumber: git.prNumber,
      };
    });
}

export function managedCoordinatorAgentSource(input: {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: CoordinatorAgentStatus;
  lifecycle: "running" | "exited";
  updatedAt: string;
  lastOutputAt: string;
  routePath: string;
  sdk: SessionSdkPayload;
  semanticPrompt: string;
}): CoordinatorAgentSource {
  const summary = input.sdk.summary;
  const latestUserText = summary ? summary.latestUserText : "";
  const latestAssistantText = summary ? summary.latestAssistantText : "";
  return {
    id: input.id,
    source: "managed",
    provider: input.sdk.provider,
    title: input.title,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    status: input.status,
    lifecycle: input.lifecycle,
    updatedAt: input.updatedAt,
    lastOutputAt: input.lastOutputAt,
    routePath: input.routePath,
    promptable: input.lifecycle === "running",
    latestUserText,
    latestAssistantText,
    task: latestUserText || input.semanticPrompt || [input.command, ...input.args].join(" "),
    sdk: input.sdk,
  };
}

export function recentCodexCoordinatorAgentSource(session: RecentAgentSession): CoordinatorAgentSource {
  return {
    id: `codex:${session.id}`,
    source: "recent-codex",
    provider: "codex",
    title: session.title,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    status: session.status,
    lifecycle: "external",
    updatedAt: session.updatedAt,
    lastOutputAt: session.lastMessageAt,
    routePath: "",
    promptable: false,
    latestUserText: session.latestUserText,
    latestAssistantText: session.latestAssistantText,
    task: session.latestUserText || session.initialUserText || session.lastMessageText,
    sdk: null,
  };
}

export function findCoordinatorClashes(agents: CoordinatorAgent[]): CoordinatorClash[] {
  return [
    ...findDirtyFileClashes(agents),
    ...findSameBranchClashes(agents),
    ...findSamePrClashes(agents),
  ];
}

export function buildCoordinatorBriefing(source: CoordinatorAgentSource, agent: CoordinatorAgent): CoordinatorBriefing {
  const sdk = source.sdk;
  const brief = sdk ? currentStructuredBrief(sdk) : null;
  if (brief) {
    return {
      agent,
      state: "briefed",
      source: "session-brief",
      executiveSummary: brief.executiveSummary,
      initialUserRequest: brief.initialUserRequest,
      currentState: brief.currentState,
      completedWork: brief.completedWork,
      filesChanged: brief.filesChanged,
      risksBlockers: brief.risksBlockers,
      suggestedNextActions: brief.suggestedNextActions,
      latestUserText: source.latestUserText,
      latestAssistantText: source.latestAssistantText,
      updatedAt: sdk ? sdk.sidecarSummary.updatedAt || source.updatedAt : source.updatedAt,
    };
  }

  const summary = sdk ? sdk.summary : null;
  if (summary) {
    return snapshotBriefing(source, agent, summary);
  }

  return {
    agent,
    state: source.latestUserText || source.latestAssistantText || source.task ? "snapshot" : "unavailable",
    source: source.latestUserText || source.latestAssistantText ? "provider-snapshot" : "terminal",
    executiveSummary: source.task || "No briefing is available yet.",
    initialUserRequest: source.latestUserText,
    currentState: source.latestAssistantText || source.task || "No provider snapshot is available yet.",
    completedWork: [],
    filesChanged: [],
    risksBlockers: [],
    suggestedNextActions: [],
    latestUserText: source.latestUserText,
    latestAssistantText: source.latestAssistantText,
    updatedAt: source.updatedAt,
  };
}

export function resolveGitMetadata(cwd: string): CoordinatorGitMetadata {
  const gitRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    return emptyGitMetadata();
  }
  const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const cacheKey = `${gitRoot}\0${branch}`;
  const cached = gitMetadataCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.metadata;
  }

  const metadata = {
    gitRoot,
    branch,
    dirtyFiles: gitDirtyFiles(cwd),
    prNumber: currentPullRequestNumber(cwd),
  };
  gitMetadataCache.set(cacheKey, { expiresAtMs: Date.now() + gitMetadataCacheMs, metadata });
  return metadata;
}

export function emptyGitMetadata(): CoordinatorGitMetadata {
  return {
    gitRoot: "",
    branch: "",
    dirtyFiles: [],
    prNumber: null,
  };
}

export function findExplicitPromptAgentTargets(
  agents: Array<Pick<CoordinatorAgent, "id" | "title" | "promptable">>,
  prompt: string,
) {
  if (!/\b(?:tell|ask|prompt|message|send)\b/i.test(prompt)) {
    return [];
  }
  const normalizedPrompt = normalizeAgentReference(prompt);
  return uniqueStrings(agents
    .filter((agent) => agent.promptable)
    .filter((agent) => {
      return agentReferenceMatches(normalizedPrompt, agent.id) ||
        agentReferenceMatches(normalizedPrompt, agent.title);
    })
    .map((agent) => agent.id));
}

function findDirtyFileClashes(agents: CoordinatorAgent[]): CoordinatorClash[] {
  const groups = new Map<string, { gitRoot: string; file: string; agents: CoordinatorAgent[] }>();
  for (const agent of agents) {
    if (!agent.gitRoot || agent.lifecycle === "exited") {
      continue;
    }
    for (const file of agent.dirtyFiles) {
      const key = `${agent.gitRoot}\0${file}`;
      const group = groups.get(key) || { gitRoot: agent.gitRoot, file, agents: [] };
      group.agents.push(agent);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => uniqueAgentIds(group.agents).length > 1)
    .map((group) => ({
      kind: "dirty-file",
      gitRoot: group.gitRoot,
      branch: "",
      file: group.file,
      prNumber: null,
      agents: summarizeClashAgents(group.agents),
    }));
}

function findSameBranchClashes(agents: CoordinatorAgent[]): CoordinatorClash[] {
  const groups = new Map<string, { gitRoot: string; branch: string; agents: CoordinatorAgent[] }>();
  for (const agent of agents) {
    if (!agent.gitRoot || !agent.branch || agent.branch === "HEAD" || agent.lifecycle === "exited") {
      continue;
    }
    const key = `${agent.gitRoot}\0${agent.branch}`;
    const group = groups.get(key) || { gitRoot: agent.gitRoot, branch: agent.branch, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => uniqueAgentIds(group.agents).length > 1)
    .map((group) => ({
      kind: "same-branch",
      gitRoot: group.gitRoot,
      branch: group.branch,
      file: "",
      prNumber: null,
      agents: summarizeClashAgents(group.agents),
    }));
}

function findSamePrClashes(agents: CoordinatorAgent[]): CoordinatorClash[] {
  const groups = new Map<string, { gitRoot: string; prNumber: number; agents: CoordinatorAgent[] }>();
  for (const agent of agents) {
    if (!agent.gitRoot || !agent.prNumber || agent.lifecycle === "exited") {
      continue;
    }
    const key = `${agent.gitRoot}\0${agent.prNumber}`;
    const group = groups.get(key) || { gitRoot: agent.gitRoot, prNumber: agent.prNumber, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => uniqueAgentIds(group.agents).length > 1)
    .map((group) => ({
      kind: "same-pr",
      gitRoot: group.gitRoot,
      branch: "",
      file: "",
      prNumber: group.prNumber,
      agents: summarizeClashAgents(group.agents),
    }));
}

function summarizeClashAgents(agents: CoordinatorAgent[]) {
  const seen = new Set<string>();
  const result: CoordinatorClash["agents"] = [];
  for (const agent of agents) {
    if (seen.has(agent.id)) {
      continue;
    }
    seen.add(agent.id);
    result.push({
      id: agent.id,
      title: agent.title,
      status: agent.status,
      routePath: agent.routePath,
    });
  }
  return result;
}

function uniqueAgentIds(agents: CoordinatorAgent[]) {
  return uniqueStrings(agents.map((agent) => agent.id));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function currentStructuredBrief(sdk: SessionSdkPayload) {
  const sourceSummary = sdk.summary;
  const sourceForkPoint = sourceSummary ? sourceSummary.forkPoint : "";
  const sourceSessionId = sdk.externalSessionId;
  const matchingFork = sdk.forks
    .filter((fork) => {
      return fork.purpose === "sidecarSummary" &&
        fork.status === "summarized" &&
        fork.sourceSessionId === sourceSessionId &&
        fork.forkPoint === sourceForkPoint &&
        Boolean(fork.summary?.sessionBrief);
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return matchingFork?.summary?.sessionBrief || sourceSummary?.sessionBrief || null;
}

function snapshotBriefing(
  source: CoordinatorAgentSource,
  agent: CoordinatorAgent,
  summary: AgentSessionSummary,
): CoordinatorBriefing {
  return {
    agent,
    state: "snapshot",
    source: "provider-snapshot",
    executiveSummary: summary.title || source.task || "Provider snapshot available.",
    initialUserRequest: summary.transcript.find((message) => message.role === "user")?.text || summary.latestUserText,
    currentState: summary.latestAssistantText || summary.latestUserText || source.task,
    completedWork: summary.latestAssistantText ? [summary.latestAssistantText] : [],
    filesChanged: summary.diffs.map((diff) => ({ path: diff.file, summary: `${diff.additions} additions, ${diff.deletions} deletions` })),
    risksBlockers: [],
    suggestedNextActions: [],
    latestUserText: summary.latestUserText,
    latestAssistantText: summary.latestAssistantText,
    updatedAt: source.updatedAt,
  };
}

function gitDirtyFiles(cwd: string) {
  const output = gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => dirtyPathFromPorcelainLine(line))
    .filter((file): file is string => Boolean(file))
    .slice(0, 100);
}

function dirtyPathFromPorcelainLine(line: string) {
  const rawPath = line.slice(3).trim();
  const renameIndex = rawPath.indexOf(" -> ");
  const file = renameIndex >= 0 ? rawPath.slice(renameIndex + 4) : rawPath;
  return file.replace(/^"|"$/g, "");
}

function currentPullRequestNumber(cwd: string) {
  const raw = commandOutput("gh", ["pr", "view", "--json", "number", "--jq", ".number"], cwd, 250);
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeAgentReference(value: string) {
  return ` ${value.toLowerCase().replace(/[^a-z0-9_]+/g, " ")} `;
}

function agentReferenceMatches(normalizedPrompt: string, value: string) {
  const normalizedValue = normalizeAgentReference(value).trim();
  if (normalizedValue.length < 3) {
    return false;
  }
  return normalizedPrompt.includes(` ${normalizedValue} `);
}

function gitOutput(cwd: string, args: string[]) {
  return commandOutput("git", ["-C", cwd, ...args], cwd, 800);
}

function commandOutput(command: string, args: string[], cwd: string, timeout: number) {
  if (!cwd) {
    return "";
  }
  try {
    return execFileSync(command, args, {
      cwd: path.resolve(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return "";
  }
}
