// Inspired by Isomux's isometric office overview (`ui/office/*`), but reworked
// for TUI UI as a factory floor: generated bitmap room/station/technician art
// with accessible HTML overlays bound to real TUI sessions and provider recents.

export type FactoryFloorSession = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  updatedAt: string;
  lifecycle: "running" | "exited";
  status: "busy" | "idle" | "exited";
};

export type FactoryFloorRecentSession = {
  provider: "opencode" | "codex" | "claude";
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessageText: string;
  initialUserText: string;
  latestUserText: string;
  userMessageCount: number;
  latestAssistantText: string;
  messageCount: number;
  status: "busy" | "idle";
  command: string;
  args: string[];
};

export type FactoryFloorState =
  | "busy"
  | "idle"
  | "waiting"
  | "reviewing"
  | "recent"
  | "stale"
  | "exited"
  | "errored";

type FactoryFloorStation =
  | {
    kind: "active";
    key: string;
    title: string;
    topic: string;
    cwd: string;
    meta: string;
    provider: string;
    state: FactoryFloorState;
    session: FactoryFloorSession;
  }
  | {
    kind: "recent";
    key: string;
    title: string;
    topic: string;
    cwd: string;
    meta: string;
    provider: string;
    state: FactoryFloorState;
    session: FactoryFloorRecentSession;
  };

type FactoryFloorSlot = {
  x: number;
  y: number;
  z: number;
  anchor: "top" | "bottom";
};

type RenderFactoryFloorInput = {
  sessions: FactoryFloorSession[];
  recentAgentSessions: FactoryFloorRecentSession[] | null;
  displayHomeDirs: string[];
  nowMs: number;
};

const slots: FactoryFloorSlot[] = [
  { x: 22, y: 34, z: 20, anchor: "top" },
  { x: 39, y: 32, z: 24, anchor: "top" },
  { x: 56, y: 32, z: 28, anchor: "top" },
  { x: 73, y: 34, z: 32, anchor: "top" },
  { x: 22, y: 68, z: 44, anchor: "bottom" },
  { x: 39, y: 67, z: 48, anchor: "bottom" },
  { x: 56, y: 67, z: 52, anchor: "bottom" },
  { x: 73, y: 68, z: 56, anchor: "bottom" },
];

const legendStates: FactoryFloorState[] = [
  "busy",
  "idle",
  "waiting",
  "reviewing",
  "recent",
  "stale",
  "exited",
  "errored",
];

export function renderFactoryFloorOverview(input: RenderFactoryFloorInput) {
  const stations = buildFactoryFloorStations(input);
  const visibleStations = stations.slice(0, slots.length);
  const overflowStations = stations.slice(slots.length);
  const loadingRecents = input.recentAgentSessions === null;

  return `
    <section class="factory-floor-overview" aria-label="Factory floor overview" data-testid="factory-floor-root">
      <header class="factory-floor-summary">
        <div>
          <strong>Factory floor</strong>
          <span data-testid="factory-station-count">${visibleStations.length} stations${overflowStations.length ? `, ${overflowStations.length} queued` : ""}</span>
        </div>
        <div class="factory-state-legend" aria-label="Factory floor state legend">
          ${legendStates.map(renderFactoryStateLegendItem).join("")}
        </div>
      </header>
      <div class="factory-floor-stage" data-testid="factory-floor-stage">
        ${visibleStations.map((station, index) => renderFactoryStation(station, slots[index]!, index)).join("")}
        ${loadingRecents ? `
          <div class="factory-loading-plaque" data-testid="factory-recent-loading">Loading provider recents</div>
        ` : ""}
      </div>
      ${overflowStations.length ? renderFactoryOverflow(overflowStations) : ""}
      ${!stations.length && !loadingRecents ? `<p class="empty">No active or recent stations</p>` : ""}
    </section>
  `;
}

export function factoryRecentSessionKey(session: FactoryFloorRecentSession) {
  return `${session.provider}:${session.id}`;
}

function buildFactoryFloorStations(input: RenderFactoryFloorInput): FactoryFloorStation[] {
  const activeStations = input.sessions.map((session): FactoryFloorStation => ({
    kind: "active",
    key: `active:${session.id}`,
    title: session.title || session.command,
    topic: [session.command, ...session.args].join(" "),
    cwd: formatPathForDisplay(session.cwd, input.displayHomeDirs),
    meta: new Date(session.updatedAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    provider: providerLabelForCommand(session.command),
    state: stateForActiveSession(session),
    session,
  }));
  const recentStations = (input.recentAgentSessions || []).map((session): FactoryFloorStation => ({
    kind: "recent",
    key: `recent:${factoryRecentSessionKey(session)}`,
    title: session.title || session.id,
    topic: formatTopicSnippet(session.latestUserText || session.initialUserText || session.lastMessageText, "No prompt recorded"),
    cwd: formatPathForDisplay(session.cwd, input.displayHomeDirs),
    meta: `${new Date(session.lastMessageAt || session.updatedAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })} - ${session.messageCount} messages`,
    provider: providerLabel(session.provider),
    state: stateForRecentSession(session, input.nowMs),
    session,
  }));
  return [...activeStations, ...recentStations];
}

function renderFactoryStation(station: FactoryFloorStation, slot: FactoryFloorSlot, index: number) {
  const stationNumber = index + 1;
  const title = `${stationNumber} - ${station.title}`;
  const actionHtml = station.kind === "active"
    ? renderActiveStationActions(station, stationNumber)
    : renderRecentStationActions(station);
  return `
    <article
      class="factory-station"
      style="--station-x: ${slot.x}%; --station-y: ${slot.y}%; --station-z: ${slot.z};"
      data-anchor="${slot.anchor}"
      data-state="${escapeAttr(station.state)}"
      data-kind="${escapeAttr(station.kind)}"
      data-testid="factory-station"
      aria-label="${escapeAttr(`${title}, ${stateLabel(station.state)}`)}"
    >
      <div class="factory-station-art" aria-hidden="true">
        <span class="factory-machine"></span>
        <span class="factory-agent"></span>
      </div>
      <div class="factory-station-card">
        <div class="factory-station-name">
          <span class="factory-status-light" data-state="${escapeAttr(station.state)}" aria-hidden="true"></span>
          <strong title="${escapeAttr(title)}">${escapeHtml(title)}</strong>
          <span class="provider-pill" data-provider="${escapeAttr(providerKey(station.provider))}">${escapeHtml(station.provider)}</span>
        </div>
        <p class="factory-topic" title="${escapeAttr(station.topic)}">${escapeHtml(formatTopicSnippet(station.topic, "No current topic"))}</p>
        <div class="factory-station-meta">
          <code title="${escapeAttr(station.cwd)}">${escapeHtml(station.cwd)}</code>
          <span data-testid="factory-station-state">${escapeHtml(stateLabel(station.state))}</span>
        </div>
        <div class="factory-station-detail">
          <span>${escapeHtml(station.meta)}</span>
        </div>
        ${actionHtml}
      </div>
    </article>
  `;
}

function renderActiveStationActions(station: Extract<FactoryFloorStation, { kind: "active" }>, stationNumber: number) {
  const stopButton = station.session.lifecycle === "running"
    ? `<button type="button" class="secondary-button" data-action="factory-archive-session" data-session-id="${escapeAttr(station.session.id)}">Stop</button>`
    : "";
  return `
    <div class="factory-station-actions">
      <a class="primary-button factory-open-link" href="/sessions/${escapeAttr(station.session.id)}" aria-label="${escapeAttr(`Open terminal for ${station.title}`)}">Open terminal</a>
      ${stopButton}
    </div>
    <form class="factory-prompt-form" data-action="factory-prompt-form" data-session-id="${escapeAttr(station.session.id)}">
      <input name="text" aria-label="${escapeAttr(`Prompt station ${stationNumber}`)}" autocomplete="off" placeholder="Prompt" />
      <button type="submit">Send</button>
    </form>
  `;
}

function renderRecentStationActions(station: Extract<FactoryFloorStation, { kind: "recent" }>) {
  return `
    <div class="factory-station-actions">
      <button
        type="button"
        class="primary-button"
        data-action="factory-resume-agent-session"
        data-agent-session-id="${escapeAttr(factoryRecentSessionKey(station.session))}"
        aria-label="${escapeAttr(`Resume ${station.provider} session ${station.title}`)}"
      >Resume</button>
    </div>
  `;
}

function renderFactoryStateLegendItem(state: FactoryFloorState) {
  return `
    <span class="factory-state-key" data-state="${escapeAttr(state)}" data-testid="factory-state-${escapeAttr(state)}">
      <span class="factory-status-light" data-state="${escapeAttr(state)}" aria-hidden="true"></span>
      ${escapeHtml(stateLabel(state))}
    </span>
  `;
}

function renderFactoryOverflow(stations: FactoryFloorStation[]) {
  return `
    <section class="factory-overflow" aria-label="Queued factory stations">
      <strong>Queued</strong>
      <div>
        ${stations.map((station) => `
          <span class="factory-overflow-item" data-state="${escapeAttr(station.state)}">
            <span class="factory-status-light" data-state="${escapeAttr(station.state)}" aria-hidden="true"></span>
            ${escapeHtml(station.title)}
          </span>
        `).join("")}
      </div>
    </section>
  `;
}

function stateForActiveSession(session: FactoryFloorSession): FactoryFloorState {
  const text = [session.title, session.command, ...session.args].join(" ");
  if (looksErrored(text)) {
    return "errored";
  }
  if (session.lifecycle === "exited" || session.status === "exited") {
    return "exited";
  }
  if (session.status === "busy") {
    return "busy";
  }
  return "idle";
}

function stateForRecentSession(session: FactoryFloorRecentSession, nowMs: number): FactoryFloorState {
  const text = [
    session.title,
    session.lastMessageText,
    session.initialUserText,
    session.latestUserText,
    session.latestAssistantText,
  ].join(" ");
  if (looksErrored(text)) {
    return "errored";
  }
  if (/\b(waiting|blocked|needs? input|needs? approval|please confirm|human attention)\b/i.test(text)) {
    return "waiting";
  }
  if (/\b(review|reviewing|inspect|inspection|qa|quality|pull request|pr)\b/i.test(text)) {
    return "reviewing";
  }
  if (session.status === "busy") {
    return "busy";
  }
  if (nowMs - new Date(session.lastMessageAt || session.updatedAt).getTime() > 6 * 60 * 60 * 1000) {
    return "stale";
  }
  return "recent";
}

function looksErrored(text: string) {
  return /\b(error|errored|failed|failure|exception|crash|crashed)\b/i.test(text);
}

function providerLabel(provider: FactoryFloorRecentSession["provider"]) {
  if (provider === "opencode") {
    return "OpenCode";
  }
  if (provider === "codex") {
    return "Codex";
  }
  return "Claude";
}

function providerLabelForCommand(command: string) {
  const value = command.toLowerCase();
  if (value.includes("opencode")) {
    return "OpenCode";
  }
  if (value.includes("claude")) {
    return "Claude";
  }
  if (value.includes("codex")) {
    return "Codex";
  }
  return "Agent";
}

function providerKey(provider: string) {
  return provider.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function stateLabel(state: FactoryFloorState) {
  const labels: Record<FactoryFloorState, string> = {
    busy: "busy",
    idle: "idle",
    waiting: "waiting for user",
    reviewing: "reviewing",
    recent: "recent",
    stale: "stale",
    exited: "exited",
    errored: "errored",
  };
  return labels[state];
}

function formatPathForDisplay(value: string, homeDirs: string[]) {
  const path = value || "/";
  for (const candidate of homeDirs) {
    const home = candidate.replace(/\/+$/g, "");
    if (path === home) {
      return "~";
    }
    if (path.startsWith(`${home}/`)) {
      return `~${path.slice(home.length)}`;
    }
  }
  return path;
}

function formatTopicSnippet(text: string, empty: string) {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean) || "";
  const line = normalized
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!line) {
    return empty;
  }
  return line.length > 118 ? `${line.slice(0, 115)}...` : line;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string) {
  return escapeHtml(value);
}
