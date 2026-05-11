import { expect, test } from "bun:test";
import { parseStructuredSessionBrief } from "../src/session-brief.ts";

test("parses the provider-independent session brief contract", () => {
  const brief = parseStructuredSessionBrief([
    "<session_brief format=\"tuiui.sessionBrief.v1\">",
    "  <executive_summary>Summary for the supervisor.</executive_summary>",
    "  <initial_user_request>Build structured briefs.</initial_user_request>",
    "  <current_state>Implementation is in progress.</current_state>",
    "  <completed_work>",
    "    <item>Added a shared parser.</item>",
    "  </completed_work>",
    "  <files_changed>",
    "    <file path=\"src/session-brief.ts\">New parser and prompt contract.</file>",
    "  </files_changed>",
    "  <risks_blockers>",
    "    <item>Needs provider tests.</item>",
    "  </risks_blockers>",
    "  <suggested_next_actions>",
    "    <item>Run typecheck.</item>",
    "  </suggested_next_actions>",
    "</session_brief>",
  ].join("\n"));

  expect(brief).toMatchObject({
    format: "tuiui.sessionBrief.v1",
    executiveSummary: "Summary for the supervisor.",
    initialUserRequest: "Build structured briefs.",
    currentState: "Implementation is in progress.",
    completedWork: ["Added a shared parser."],
    filesChanged: [{ path: "src/session-brief.ts", summary: "New parser and prompt contract." }],
    risksBlockers: ["Needs provider tests."],
    suggestedNextActions: ["Run typecheck."],
    parseErrors: [],
  });
});

test("keeps raw text and parse errors when a provider returns malformed output", () => {
  const brief = parseStructuredSessionBrief("plain markdown summary");

  expect(brief).toMatchObject({
    raw: "plain markdown summary",
    parseErrors: expect.arrayContaining(["missing session_brief root", "missing executive_summary"]),
  });
});
