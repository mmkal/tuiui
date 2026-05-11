import type { AgentSessionSummary } from "./opencode-sdk.ts";

export type StructuredSessionBrief = {
  format: "tuiui.sessionBrief.v1";
  executiveSummary: string;
  initialUserRequest: string;
  currentState: string;
  completedWork: string[];
  filesChanged: Array<{
    path: string;
    summary: string;
  }>;
  risksBlockers: string[];
  suggestedNextActions: string[];
  raw: string;
  parseErrors: string[];
};

export function createStructuredSessionBriefPrompt(providerName: string, summary: AgentSessionSummary) {
  return [
    `Create a structured Session brief for this ${providerName} TUI session.`,
    "",
    "Return only this XML-style contract, with every tag present even when the value is empty:",
    "",
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "  <executive_summary>One or two sentences for a human supervising this session.</executive_summary>",
    "  <initial_user_request>The original or main user request.</initial_user_request>",
    "  <current_state>What is true right now, including whether the task is done or in progress.</current_state>",
    "  <completed_work>",
    "    <item>A concrete completed change or investigation.</item>",
    "  </completed_work>",
    "  <files_changed>",
    "    <file path=\"relative/or/absolute/path\">What changed in this file.</file>",
    "  </files_changed>",
    "  <risks_blockers>",
    "    <item>A risk, blocker, uncertainty, or missing verification.</item>",
    "  </risks_blockers>",
    "  <suggested_next_actions>",
    "    <item>The next action a supervising human or agent should take.</item>",
    "  </suggested_next_actions>",
    "</session_brief>",
    "",
    "Do not wrap the XML in markdown fences. Do not inspect or edit the repository. Use only the transcript below.",
    "Use concise text. Prefer empty tags over invented facts.",
    "",
    `Title: ${summary.title}`,
    `Latest user message: ${summary.latestUserText}`,
    `Latest assistant message: ${summary.latestAssistantText}`,
    "",
    "Transcript:",
    ...summary.transcript.map((message) => {
      const label = [message.createdAt, message.role].filter(Boolean).join(" ");
      return `\n[${label}]\n${message.text}`;
    }),
  ].join("\n");
}

export function parseStructuredSessionBrief(raw: string): StructuredSessionBrief {
  const text = raw.trim();
  const parseErrors: string[] = [];
  if (!text) {
    parseErrors.push("empty brief");
  }
  if (!/<session_brief\b[\s\S]*<\/session_brief>/i.test(text)) {
    parseErrors.push("missing session_brief root");
  }

  const brief = {
    format: "tuiui.sessionBrief.v1" as const,
    executiveSummary: tagText(text, "executive_summary", parseErrors),
    initialUserRequest: tagText(text, "initial_user_request", parseErrors),
    currentState: tagText(text, "current_state", parseErrors),
    completedWork: itemTexts(tagBody(text, "completed_work", parseErrors)),
    filesChanged: fileEntries(tagBody(text, "files_changed", parseErrors)),
    risksBlockers: itemTexts(tagBody(text, "risks_blockers", parseErrors)),
    suggestedNextActions: itemTexts(tagBody(text, "suggested_next_actions", parseErrors)),
    raw: text,
    parseErrors,
  };
  return brief;
}

function tagText(raw: string, tag: string, parseErrors: string[]) {
  return decodeXmlEntities(tagBody(raw, tag, parseErrors)).trim();
}

function tagBody(raw: string, tag: string, parseErrors: string[]) {
  const match = raw.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) {
    parseErrors.push(`missing ${tag}`);
    return "";
  }
  return match[1] || "";
}

function itemTexts(raw: string) {
  return [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
    .map((match) => decodeXmlEntities(match[1] || "").trim())
    .filter(Boolean);
}

function fileEntries(raw: string) {
  return [...raw.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/gi)]
    .map((match) => {
      return {
        path: decodeXmlEntities(attributeValue(match[1] || "", "path")).trim(),
        summary: decodeXmlEntities(match[2] || "").trim(),
      };
    })
    .filter((entry) => entry.path || entry.summary);
}

function attributeValue(raw: string, name: string) {
  const quoted = raw.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (quoted) {
    return quoted[1] || "";
  }
  const singleQuoted = raw.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return singleQuoted ? singleQuoted[1] || "" : "";
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
