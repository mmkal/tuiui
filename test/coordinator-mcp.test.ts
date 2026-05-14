import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoordinatorMcpServer } from "../src/coordinator-mcp.ts";
import type { CoordinatorMcpHandlers } from "../src/coordinator-mcp.ts";

test("exposes coordinator tools over MCP", async () => {
  await using harness = await createMcpHarness();

  expect(await harness.client.listTools()).toMatchObject({
    tools: [
      { name: "listAgents" },
      { name: "getBriefing" },
      { name: "promptAgent" },
      { name: "subscribe" },
      { name: "findClashes" },
    ],
  });

  expect(await harness.client.callTool({ name: "listAgents", arguments: {} })).toMatchObject({
    structuredContent: {
      result: [{ id: "session-a", title: "Codex A" }],
    },
  });

  expect(await harness.client.callTool({
    name: "promptAgent",
    arguments: { agentId: "session-a", prompt: "please continue" },
  })).toMatchObject({
    structuredContent: {
      result: {
        ok: true,
        agentId: "session-a",
        prompt: "please continue",
      },
    },
  });
});

async function createMcpHarness() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCoordinatorMcpServer(handlers());
  const client = new Client({ name: "tuiui-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async [Symbol.asyncDispose]() {
      await client.close();
      await (server as McpServer).close();
    },
  };
}

function handlers(): CoordinatorMcpHandlers {
  const agent = {
    id: "session-a",
    source: "managed" as const,
    provider: "codex" as const,
    title: "Codex A",
    command: "codex",
    args: [],
    cwd: "/repo",
    status: "idle" as const,
    lifecycle: "running" as const,
    updatedAt: "2026-05-14T07:00:00.000Z",
    lastOutputAt: "2026-05-14T07:00:00.000Z",
    routePath: "/sessions/session-a",
    promptable: true,
    latestUserText: "build coordinator",
    latestAssistantText: "done",
    task: "build coordinator",
    gitRoot: "/repo",
    branch: "bedtime/meta-agent",
    dirtyFiles: [],
    prNumber: 13,
  };
  return {
    listAgents() {
      return [agent];
    },
    getBriefing(agentId) {
      return {
        agent,
        state: "snapshot",
        source: "provider-snapshot",
        executiveSummary: `Briefing for ${agentId}`,
        initialUserRequest: "build coordinator",
        currentState: "done",
        completedWork: [],
        filesChanged: [],
        risksBlockers: [],
        suggestedNextActions: [],
        latestUserText: "build coordinator",
        latestAssistantText: "done",
        updatedAt: "2026-05-14T07:00:00.000Z",
      };
    },
    promptAgent(agentId, prompt) {
      return {
        ok: true,
        agentId,
        prompt,
        message: "sent",
        createdAt: "2026-05-14T07:00:00.000Z",
      };
    },
    subscribe(agentId) {
      return {
        ok: true,
        agentId,
        message: "subscribed",
        createdAt: "2026-05-14T07:00:00.000Z",
      };
    },
    findClashes() {
      return [];
    },
  };
}
