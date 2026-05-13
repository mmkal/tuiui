import { recentSessionPreviewText, type AgentProvider, type RecentAgentSession, type SessionSdkPayload } from "./opencode-sdk.ts";

export type CoordinatorAgentKind = "live" | "recent";
export type CoordinatorAgentLifecycle = "running" | "exited" | "recent";
export type CoordinatorAgentStatus = "busy" | "idle" | "exited";
export type CoordinatorFreshnessLevel = "fresh" | "recent" | "stale" | "unknown";
export type CoordinatorConfidenceLabel = "high" | "medium" | "low";
export type CoordinatorObservationSeverity = "info" | "warn";

export type CoordinatorWorkspaceMetadata = {
  gitRoot: string;
  branch: string;
  gitHead: string;
  worktree: string;
};

export type LiveCoordinatorSessionInput = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string;
  lifecycle: "running" | "exited";
  status: CoordinatorAgentStatus;
  exitCode: number | null;
  sdk: SessionSdkPayload;
  stdinEvents: Array<{ id: number; text: string; createdAt: string }>;
  stdoutEvents: Array<{ id: number; displayText: string; createdAt: string }>;
  semanticStatus: string;
  semanticPrompt: string;
  renderedText: string;
  recoveryCommand: string;
  recoveryCreatedAt: string;
  workspace: CoordinatorWorkspaceMetadata;
};

export type RecentCoordinatorSessionInput = RecentAgentSession & {
  recoveryCommand: string;
  recoveryCreatedAt: string;
  workspace: CoordinatorWorkspaceMetadata;
};

export type CoordinatorFreshness = {
  level: CoordinatorFreshnessLevel;
  observedAt: string;
  sourceUpdatedAt: string;
  ageMs: number | null;
};

export type CoordinatorConfidence = {
  label: CoordinatorConfidenceLabel;
  score: number;
  reasons: string[];
};

export type CoordinatorAgentSummary = {
  id: string;
  stableId: string;
  kind: CoordinatorAgentKind;
  provider: AgentProvider | "";
  providerSessionId: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  branch: string;
  worktree: string;
  gitHead: string;
  lifecycle: CoordinatorAgentLifecycle;
  status: CoordinatorAgentStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  currentTask: string;
  blockers: string[];
  pendingUserDecisions: string[];
  taskFiles: string[];
  prLinks: string[];
  latestUserText: string;
  latestAssistantText: string;
  recoveryCommand: string;
  recoveryCreatedAt: string;
  freshness: CoordinatorFreshness;
  confidence: CoordinatorConfidence;
  forwardable: boolean;
  metadata: {
    source: "runtime" | "provider-history";
    sdkState: string;
    sdkUpdatedAt: string;
    providerStatus: string;
    sidecarSummaryStatus: string;
    messageCount: number;
    stdinEventCount: number;
    stdoutEventCount: number;
    exitCode: number | null;
    recoverable: boolean;
  };
};

export type CoordinatorObservation = {
  id: string;
  severity: CoordinatorObservationSeverity;
  text: string;
  agentId: string;
  createdAt: string;
};

export type CoordinatorAreaSummary = {
  id: string;
  cwd: string;
  label: string;
  agentIds: string[];
  counts: {
    agents: number;
    live: number;
    recent: number;
    running: number;
    busy: number;
    idle: number;
    exited: number;
    stale: number;
    forwardable: number;
  };
};

export type CoordinatorSummary = {
  format: "tuiui.coordinatorSummary.v1";
  generatedAt: string;
  counts: {
    agents: number;
    live: number;
    recent: number;
    running: number;
    busy: number;
    idle: number;
    exited: number;
    stale: number;
    forwardable: number;
  };
  areas: CoordinatorAreaSummary[];
  agents: CoordinatorAgentSummary[];
  authority: {
    deterministic: true;
    autonomousProviderBehavior: false;
    canForwardPrompts: true;
    requiresConfirmation: true;
    notes: string[];
  };
  observations: CoordinatorObservation[];
};

export type CoordinatorTargetResolution = {
  status: "resolved" | "missing" | "ambiguous";
  reason: string;
  target: string;
  agent: CoordinatorAgentSummary | null;
  matches: CoordinatorAgentSummary[];
};

export function createCoordinatorSummary(input: {
  generatedAtMs: number;
  liveSessions: LiveCoordinatorSessionInput[];
  recentSessions: RecentCoordinatorSessionInput[];
}): CoordinatorSummary {
  const generatedAt = new Date(input.generatedAtMs).toISOString();
  const liveAgents = input.liveSessions
    .map((session) => liveAgentSummary(session, generatedAt, input.generatedAtMs))
    .sort(compareAgentsByActivity);
  const liveProviderKeys = new Set(liveAgents
    .filter((agent) => agent.provider && agent.providerSessionId)
    .map((agent) => providerKey(agent.provider, agent.providerSessionId)));
  const recentAgents = input.recentSessions
    .filter((session) => !liveProviderKeys.has(providerKey(session.provider, session.id)))
    .map((session) => recentAgentSummary(session, generatedAt, input.generatedAtMs))
    .sort(compareAgentsByActivity);
  const agents = [...liveAgents, ...recentAgents];
  const counts = {
    agents: agents.length,
    live: liveAgents.length,
    recent: recentAgents.length,
    running: liveAgents.filter((agent) => agent.lifecycle === "running").length,
    busy: agents.filter((agent) => agent.status === "busy").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    exited: agents.filter((agent) => agent.status === "exited").length,
    stale: agents.filter((agent) => agent.freshness.level === "stale").length,
    forwardable: agents.filter((agent) => agent.forwardable).length,
  };
  const areas = createCoordinatorAreas(agents);

  return {
    format: "tuiui.coordinatorSummary.v1",
    generatedAt,
    counts,
    areas,
    agents,
    authority: {
      deterministic: true,
      autonomousProviderBehavior: false,
      canForwardPrompts: true,
      requiresConfirmation: true,
      notes: [
        "The coordinator summarizes data TUI UI already has; it does not call an LLM or provider autonomously.",
        "Prompt forwarding is limited to exact live TUI session ids and requires an explicit confirmation.",
      ],
    },
    observations: createObservations(agents, counts, generatedAt),
  };
}

function createCoordinatorAreas(agents: CoordinatorAgentSummary[]): CoordinatorAreaSummary[] {
  const groups = new Map<string, CoordinatorAgentSummary[]>();
  for (const agent of agents) {
    const cwd = normalizeAreaCwd(agent.cwd);
    groups.set(cwd, [...groups.get(cwd) || [], agent]);
  }
  return [...groups.entries()]
    .map(([cwd, areaAgents]) => {
      const sortedAgents = [...areaAgents].sort(compareAgentsByActivity);
      return {
        id: `cwd:${stableSlug(cwd)}`,
        cwd,
        label: areaLabel(cwd),
        agentIds: sortedAgents.map((agent) => agent.stableId),
        counts: {
          agents: sortedAgents.length,
          live: sortedAgents.filter((agent) => agent.kind === "live").length,
          recent: sortedAgents.filter((agent) => agent.kind === "recent").length,
          running: sortedAgents.filter((agent) => agent.lifecycle === "running").length,
          busy: sortedAgents.filter((agent) => agent.status === "busy").length,
          idle: sortedAgents.filter((agent) => agent.status === "idle").length,
          exited: sortedAgents.filter((agent) => agent.status === "exited").length,
          stale: sortedAgents.filter((agent) => agent.freshness.level === "stale").length,
          forwardable: sortedAgents.filter((agent) => agent.forwardable).length,
        },
      };
    })
    .sort((left, right) => right.counts.live - left.counts.live || right.counts.agents - left.counts.agents || left.label.localeCompare(right.label));
}

function normalizeAreaCwd(cwd: string) {
  const trimmed = cwd.trim().replace(/\/+$/g, "");
  return trimmed || "/";
}

function areaLabel(cwd: string) {
  if (cwd === "/") {
    return "/";
  }
  return cwd.split("/").filter(Boolean).at(-1) || cwd;
}

function stableSlug(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  const readable = value
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .at(-1) || "root";
  return `${readable.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area"}-${(hash >>> 0).toString(36)}`;
}

export function resolveCoordinatorTarget(
  agents: CoordinatorAgentSummary[],
  target: string,
): CoordinatorTargetResolution {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return {
      status: "missing",
      reason: "Choose a live target session.",
      target: normalizedTarget,
      agent: null,
      matches: [],
    };
  }

  const forwardable = agents.filter((agent) => agent.forwardable);
  const exact = forwardable.filter((agent) => {
    return agent.id === normalizedTarget ||
      agent.stableId === normalizedTarget ||
      agent.providerSessionId === normalizedTarget;
  });
  if (exact.length === 1) {
    return resolvedTarget(normalizedTarget, exact[0]!);
  }
  if (exact.length > 1) {
    return ambiguousTarget(normalizedTarget, exact, "More than one live session matched that exact target.");
  }

  const query = normalizeSearchText(normalizedTarget);
  const fuzzy = forwardable.filter((agent) => {
    const haystack = normalizeSearchText([
      agent.title,
      agent.command,
      agent.cwd,
      agent.branch,
      agent.currentTask,
    ].join("\n"));
    return query && haystack.includes(query);
  });
  if (fuzzy.length === 1) {
    return resolvedTarget(normalizedTarget, fuzzy[0]!);
  }
  if (fuzzy.length > 1) {
    return ambiguousTarget(normalizedTarget, fuzzy, "More than one live session matched that target text.");
  }

  return {
    status: "missing",
    reason: "No live running session matched that target.",
    target: normalizedTarget,
    agent: null,
    matches: [],
  };
}

function liveAgentSummary(
  session: LiveCoordinatorSessionInput,
  generatedAt: string,
  generatedAtMs: number,
): CoordinatorAgentSummary {
  const sdkSummary = session.sdk.summary;
  const brief = sdkSummary?.sessionBrief || null;
  const latestStdin = session.stdinEvents.at(-1);
  const latestStdout = session.stdoutEvents.at(-1);
  const latestUserText = recentSessionPreviewText(sdkSummary?.latestUserText || latestStdin?.text || "");
  const latestAssistantText = recentSessionPreviewText(sdkSummary?.latestAssistantText || latestStdout?.displayText || "");
  const textCorpus = [
    session.title,
    latestUserText,
    latestAssistantText,
    brief?.executiveSummary || "",
    brief?.currentState || "",
    session.renderedText,
  ].join("\n");
  const lastActivityAt = newestIsoDate([
    session.updatedAt,
    session.lastOutputAt,
    latestStdin?.createdAt || "",
    latestStdout?.createdAt || "",
    session.sdk.updatedAt,
  ]);
  const confidence = liveConfidence(session, latestUserText, latestAssistantText);

  return {
    id: session.id,
    stableId: `live:${session.id}`,
    kind: "live",
    provider: session.sdk.provider,
    providerSessionId: session.sdk.externalSessionId,
    title: session.title,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    branch: session.workspace.branch,
    worktree: session.workspace.worktree,
    gitHead: session.workspace.gitHead,
    lifecycle: session.lifecycle,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt,
    currentTask: currentTaskFromParts([
      brief?.currentState || "",
      brief?.executiveSummary || "",
      latestUserText,
      session.semanticPrompt,
      session.semanticStatus,
      session.title,
    ]),
    blockers: uniqueStrings([...(brief?.risksBlockers || []), ...extractBlockers(latestAssistantText)]).slice(0, 5),
    pendingUserDecisions: extractPendingUserDecisions(latestAssistantText).slice(0, 5),
    taskFiles: extractTaskFiles(textCorpus),
    prLinks: extractPullRequestLinks(textCorpus),
    latestUserText,
    latestAssistantText,
    recoveryCommand: session.recoveryCommand,
    recoveryCreatedAt: session.recoveryCreatedAt,
    freshness: freshnessFor(lastActivityAt, generatedAt, generatedAtMs),
    confidence,
    forwardable: session.lifecycle === "running",
    metadata: {
      source: "runtime",
      sdkState: session.sdk.state,
      sdkUpdatedAt: session.sdk.updatedAt,
      providerStatus: session.sdk.status,
      sidecarSummaryStatus: session.sdk.sidecarSummary.status,
      messageCount: sdkSummary?.messageCount || 0,
      stdinEventCount: session.stdinEvents.length,
      stdoutEventCount: session.stdoutEvents.length,
      exitCode: session.exitCode,
      recoverable: Boolean(session.recoveryCommand),
    },
  };
}

function recentAgentSummary(
  session: RecentCoordinatorSessionInput,
  generatedAt: string,
  generatedAtMs: number,
): CoordinatorAgentSummary {
  const latestUserText = recentSessionPreviewText(session.latestUserText || session.initialUserText);
  const latestAssistantText = recentSessionPreviewText(session.latestAssistantText);
  const textCorpus = [
    session.title,
    latestUserText,
    latestAssistantText,
    session.lastMessageText,
  ].join("\n");

  return {
    id: `recent:${session.provider}:${session.id}`,
    stableId: `recent:${session.provider}:${session.id}`,
    kind: "recent",
    provider: session.provider,
    providerSessionId: session.id,
    title: session.title,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    branch: session.workspace.branch,
    worktree: session.workspace.worktree,
    gitHead: session.workspace.gitHead,
    lifecycle: "recent",
    status: session.status,
    createdAt: "",
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastMessageAt || session.updatedAt,
    currentTask: currentTaskFromParts([latestUserText, session.initialUserText, session.title]),
    blockers: extractBlockers(latestAssistantText).slice(0, 5),
    pendingUserDecisions: extractPendingUserDecisions(latestAssistantText).slice(0, 5),
    taskFiles: extractTaskFiles(textCorpus),
    prLinks: extractPullRequestLinks(textCorpus),
    latestUserText,
    latestAssistantText,
    recoveryCommand: session.recoveryCommand,
    recoveryCreatedAt: session.recoveryCreatedAt,
    freshness: freshnessFor(session.lastMessageAt || session.updatedAt, generatedAt, generatedAtMs),
    confidence: recentConfidence(session, latestUserText, latestAssistantText),
    forwardable: false,
    metadata: {
      source: "provider-history",
      sdkState: "",
      sdkUpdatedAt: "",
      providerStatus: "",
      sidecarSummaryStatus: "",
      messageCount: session.messageCount,
      stdinEventCount: 0,
      stdoutEventCount: 0,
      exitCode: null,
      recoverable: Boolean(session.recoveryCommand),
    },
  };
}

function freshnessFor(sourceUpdatedAt: string, observedAt: string, observedAtMs: number): CoordinatorFreshness {
  const sourceMs = Date.parse(sourceUpdatedAt);
  if (!sourceUpdatedAt || !Number.isFinite(sourceMs)) {
    return {
      level: "unknown",
      observedAt,
      sourceUpdatedAt: "",
      ageMs: null,
    };
  }

  const ageMs = Math.max(0, observedAtMs - sourceMs);
  return {
    level: freshnessLevel(ageMs),
    observedAt,
    sourceUpdatedAt,
    ageMs,
  };
}

function freshnessLevel(ageMs: number): CoordinatorFreshnessLevel {
  if (ageMs <= 90_000) {
    return "fresh";
  }
  if (ageMs <= 15 * 60_000) {
    return "recent";
  }
  return "stale";
}

function liveConfidence(
  session: LiveCoordinatorSessionInput,
  latestUserText: string,
  latestAssistantText: string,
): CoordinatorConfidence {
  const reasons: string[] = ["live runtime session"];
  let score = 0.45;
  if (session.sdk.summary) {
    score += 0.22;
    reasons.push("provider snapshot available");
  }
  if (session.sdk.summary?.sessionBrief && !session.sdk.summary.sessionBrief.parseErrors.length) {
    score += 0.18;
    reasons.push("structured session brief available");
  }
  if (latestUserText || latestAssistantText) {
    score += 0.1;
    reasons.push("recent prompt or response text available");
  }
  if (session.workspace.branch || session.workspace.worktree) {
    score += 0.05;
    reasons.push("git workspace metadata available");
  }
  return confidence(score, reasons);
}

function recentConfidence(
  session: RecentCoordinatorSessionInput,
  latestUserText: string,
  latestAssistantText: string,
): CoordinatorConfidence {
  const reasons: string[] = ["provider history"];
  let score = 0.42;
  if (latestUserText) {
    score += 0.18;
    reasons.push("latest user prompt available");
  }
  if (latestAssistantText) {
    score += 0.14;
    reasons.push("latest assistant response available");
  }
  if (session.cwd) {
    score += 0.08;
    reasons.push("working directory available");
  }
  if (session.workspace.branch || session.workspace.worktree) {
    score += 0.05;
    reasons.push("git workspace metadata available");
  }
  return confidence(score, reasons);
}

function confidence(score: number, reasons: string[]): CoordinatorConfidence {
  const normalized = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  return {
    score: normalized,
    label: normalized >= 0.75 ? "high" : normalized >= 0.5 ? "medium" : "low",
    reasons,
  };
}

function currentTaskFromParts(parts: string[]) {
  return parts
    .map((part) => recentSessionPreviewText(part))
    .find((part) => part && !isGenericAgentTitle(part)) || "";
}

function isGenericAgentTitle(text: string) {
  return /^(codex|claude|opencode|opencode session|codex thread|claude session)$/i.test(text.trim());
}

function extractBlockers(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /\b(blocked|blocker|risk|failed|cannot|can't|unable|missing|needs user)\b/i.test(line));
}

function extractPendingUserDecisions(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?") || /\b(choose|confirm|approve|decide|which|should i)\b/i.test(line));
}

function extractTaskFiles(text: string) {
  return uniqueStrings([...text.matchAll(/\btasks\/[A-Za-z0-9._/-]+\.md\b/g)].map((match) => match[0] || "")).slice(0, 8);
}

function extractPullRequestLinks(text: string) {
  const links = [...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g)]
    .map((match) => match[0] || "");
  const shorthand = [...text.matchAll(/\bPR\s+#(\d+)\b/gi)].map((match) => `PR #${match[1] || ""}`);
  return uniqueStrings([...links, ...shorthand]).slice(0, 8);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function newestIsoDate(values: string[]) {
  const newest = values
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((candidate) => candidate.value && Number.isFinite(candidate.ms))
    .sort((left, right) => right.ms - left.ms)[0];
  return newest?.value || "";
}

function compareAgentsByActivity(left: CoordinatorAgentSummary, right: CoordinatorAgentSummary) {
  return Date.parse(right.lastActivityAt || right.updatedAt) - Date.parse(left.lastActivityAt || left.updatedAt);
}

function createObservations(
  agents: CoordinatorAgentSummary[],
  counts: CoordinatorSummary["counts"],
  generatedAt: string,
): CoordinatorObservation[] {
  const observations: CoordinatorObservation[] = [{
    id: "coordinator-observation-counts",
    severity: "info",
    text: `${counts.live} live sessions, ${counts.recent} recent sessions, ${counts.forwardable} prompt-forwarding targets.`,
    agentId: "",
    createdAt: generatedAt,
  }];

  const stale = agents.filter((agent) => agent.freshness.level === "stale");
  if (stale.length) {
    observations.push({
      id: "coordinator-observation-stale",
      severity: "warn",
      text: `${stale.length} sessions have stale activity metadata.`,
      agentId: stale[0]?.id || "",
      createdAt: generatedAt,
    });
  }

  const blockers = agents.filter((agent) => agent.blockers.length || agent.pendingUserDecisions.length);
  if (blockers.length) {
    observations.push({
      id: "coordinator-observation-blockers",
      severity: "warn",
      text: `${blockers.length} sessions mention blockers or pending user decisions.`,
      agentId: blockers[0]?.id || "",
      createdAt: generatedAt,
    });
  }

  return observations;
}

function resolvedTarget(target: string, agent: CoordinatorAgentSummary): CoordinatorTargetResolution {
  return {
    status: "resolved",
    reason: "Resolved to one live running session.",
    target,
    agent,
    matches: [agent],
  };
}

function ambiguousTarget(
  target: string,
  matches: CoordinatorAgentSummary[],
  reason: string,
): CoordinatorTargetResolution {
  return {
    status: "ambiguous",
    reason,
    target,
    agent: null,
    matches,
  };
}

function normalizeSearchText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function providerKey(provider: string, sessionId: string) {
  return `${provider}:${sessionId}`;
}
