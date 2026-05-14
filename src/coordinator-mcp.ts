import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z as z4 } from "zod/v4";
import type {
  CoordinatorAgent,
  CoordinatorBriefing,
  CoordinatorClash,
  CoordinatorPromptResult,
  CoordinatorSubscriptionResult,
} from "./coordinator-tools.ts";

export type CoordinatorMcpHandlers = {
  listAgents(): Promise<CoordinatorAgent[]> | CoordinatorAgent[];
  getBriefing(agentId: string): Promise<CoordinatorBriefing> | CoordinatorBriefing;
  promptAgent(agentId: string, prompt: string): Promise<CoordinatorPromptResult> | CoordinatorPromptResult;
  subscribe(agentId: string): Promise<CoordinatorSubscriptionResult> | CoordinatorSubscriptionResult;
  findClashes(): Promise<CoordinatorClash[]> | CoordinatorClash[];
};

export function createCoordinatorMcpServer(handlers: CoordinatorMcpHandlers) {
  const server = new McpServer({
    name: "tuiui-coordinator",
    version: "0.1.0",
  });

  server.registerTool("listAgents", {
    title: "List agents",
    description: "List the active and recent TUI UI agents with status, task previews, git metadata, and promptability.",
    inputSchema: {},
  }, async () => jsonToolResult(await handlers.listAgents()));

  server.registerTool("getBriefing", {
    title: "Get agent briefing",
    description: "Get the best available supervisory briefing for one agent. Use the agent id returned by listAgents.",
    inputSchema: {
      agentId: z4.string().describe("Agent id returned by listAgents."),
    },
  }, async ({ agentId }) => jsonToolResult(await handlers.getBriefing(agentId)));

  server.registerTool("promptAgent", {
    title: "Prompt agent",
    description: "Forward a user-visible prompt to a managed TUI UI agent. Use only when the human explicitly asks you to tell an agent something.",
    inputSchema: {
      agentId: z4.string().describe("Managed TUI UI agent id returned by listAgents."),
      prompt: z4.string().min(1).describe("Prompt text to send to the target agent."),
    },
  }, async ({ agentId, prompt }) => jsonToolResult(await handlers.promptAgent(agentId, prompt)));

  server.registerTool("subscribe", {
    title: "Subscribe to agent idle",
    description: "Subscribe the coordinator to one agent. TUI UI will wake the coordinator when the agent transitions to idle.",
    inputSchema: {
      agentId: z4.string().describe("Agent id returned by listAgents."),
    },
  }, async ({ agentId }) => jsonToolResult(await handlers.subscribe(agentId)));

  server.registerTool("findClashes", {
    title: "Find clashes",
    description: "Return deterministic dirty-file, branch, and pull-request overlaps between agents.",
    inputSchema: {},
  }, async () => jsonToolResult(await handlers.findClashes()));

  return server;
}

export async function handleCoordinatorMcpRequest(request: Request, handlers: CoordinatorMcpHandlers) {
  const server = createCoordinatorMcpServer(handlers);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

function jsonToolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { result: value } as Record<string, unknown>,
  };
}
