import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RouterClient } from "@orpc/server";
import { expect, test } from "bun:test";
import type { AppRouter } from "../cli.ts";

const mcpToken = "test-coordinator-token";

test("coordinator tools are attached to a normal managed session", async () => {
  using workspace = createWorkspace();
  await using server = await startTuiuiServer(workspace.path);
  const client: RouterClient<AppRouter> = createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));

  const coordinator = await client.sessions.create({
    coordinator: true,
    cwd: workspace.path,
    cols: 80,
    rows: 24,
    env: {},
    fakeAgent: "codex",
  });
  const first = await client.sessions.create({
    command: "coord-agent",
    args: [],
    cwd: workspace.path,
    cols: 80,
    rows: 24,
    env: {},
  });
  const second = await client.sessions.create({
    command: "coord-agent",
    args: [],
    cwd: workspace.path,
    cols: 80,
    rows: 24,
    env: {},
  });
  await poll(async () => {
    const payload = await client.sessions.get({ sessionId: first.id });
    return payload.renderedText;
  }, (text) => text.includes("coord ready"));

  const unauthorized = await fetch(`${server.url}/mcp/coordinator`, { method: "POST" });
  expect(unauthorized).toMatchObject({ status: 401 });

  await using mcp = await createMcpClient(server.url);
  await expect(await mcp.client.callTool({ name: "listAgents", arguments: {} })).toMatchObject({
    structuredContent: {
      result: expect.arrayContaining([
        expect.objectContaining({ id: first.id, branch: "bedtime/meta-agent", dirtyFiles: ["src/shared.ts"] }),
        expect.objectContaining({ id: second.id, branch: "bedtime/meta-agent", dirtyFiles: ["src/shared.ts"] }),
      ]),
    },
  });
  const listed = await mcp.client.callTool({ name: "listAgents", arguments: {} }) as any;
  expect(listed.structuredContent.result.some((agent: any) => agent.id === coordinator.id)).toBe(false);

  await expect(await mcp.client.callTool({ name: "findClashes", arguments: {} })).toMatchObject({
    structuredContent: {
      result: expect.arrayContaining([
        expect.objectContaining({ kind: "dirty-file", file: "src/shared.ts" }),
        expect.objectContaining({ kind: "same-branch", branch: "bedtime/meta-agent" }),
      ]),
    },
  });

  await expect(await mcp.client.callTool({
    name: "promptAgent",
    arguments: { agentId: second.id, prompt: "review the auth gate" },
  })).toMatchObject({
    isError: true,
    content: [expect.objectContaining({ text: expect.stringContaining("not authorized") })],
  });

  await client.sessions.send({
    sessionId: coordinator.id,
    text: `tell ${second.id} to review the auth gate`,
    submit: true,
  });
  await expect(await mcp.client.callTool({
    name: "promptAgent",
    arguments: { agentId: second.id, prompt: "review the auth gate" },
  })).toMatchObject({
    structuredContent: {
      result: { ok: true, agentId: second.id, prompt: "review the auth gate" },
    },
  });
  await poll(async () => {
    const payload = await client.sessions.get({ sessionId: second.id });
    return payload.stdinEvents.map((event) => event.text).join("\n");
  }, (text) => text.includes("review the auth gate"));
  await expect(await mcp.client.callTool({
    name: "promptAgent",
    arguments: { agentId: second.id, prompt: "send a second message" },
  })).toMatchObject({
    isError: true,
    content: [expect.objectContaining({ text: expect.stringContaining("already been used") })],
  });

  await expect(await mcp.client.callTool({
    name: "subscribe",
    arguments: { agentId: first.id },
  })).toMatchObject({
    structuredContent: {
      result: { ok: true, agentId: first.id },
    },
  });

  await client.sessions.send({ sessionId: first.id, text: "work", submit: true });
  const coordinatorPayload = await poll(async () => {
    return await client.sessions.get({ sessionId: coordinator.id });
  }, (payload) => {
    return payload.stdinEvents.some((event) =>
      event.text.includes("[tuiui coordinator event]") &&
      event.text.includes(first.id) &&
      event.text.includes("went idle")
    );
  });
  expect(coordinatorPayload.stdinEvents.at(-1)).toMatchObject({
    text: expect.stringContaining("[tuiui coordinator event]"),
  });
});

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tuiui-coordinator-runtime-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(binDir, "coord-agent"), coordinatorAgentSource(), { mode: 0o755 });
  fs.writeFileSync(path.join(workspace, "README.md"), "coordinator runtime test\n");
  fs.writeFileSync(path.join(workspace, ".gitignore"), "bin/\nhome/\nstate/\n");
  git(workspace, ["init", "-b", "bedtime/meta-agent"]);
  git(workspace, ["config", "user.email", "tuiui-test@local.invalid"]);
  git(workspace, ["config", "user.name", "TUI UI Test"]);
  git(workspace, ["add", "README.md", ".gitignore"]);
  git(workspace, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(workspace, "src", "shared.ts"), "export const shared = 1;\n");
  return {
    path: workspace,
    [Symbol.dispose]() {
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

async function startTuiuiServer(workspace: string) {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const port = await getFreePort();
  const child = spawn("bun", ["run", path.join(rootDir, "cli.ts"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: [path.join(workspace, "bin"), process.env.PATH || ""].join(path.delimiter),
      HOME: path.join(workspace, "home"),
      TUIUI_STATE_DB: path.join(workspace, "state", "tuiui.sqlite"),
      TUIUI_COORDINATOR_MCP_TOKEN: mcpToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return {
          url,
          async [Symbol.asyncDispose]() {
            child.kill("SIGTERM");
            await waitForExit(child);
          },
        };
      }
    } catch {
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await delay(50);
  }
  child.kill("SIGTERM");
  throw new Error(`timed out waiting for server\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function createMcpClient(serverUrl: string) {
  const client = new Client({ name: "tuiui-coordinator-runtime-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp/coordinator`), {
    requestInit: {
      headers: { Authorization: `Bearer ${mcpToken}` },
    },
  });
  await client.connect(transport);
  return {
    client,
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };
}

async function poll<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 7_000;
  let value = await read();
  while (Date.now() < deadline) {
    if (predicate(value)) {
      return value;
    }
    await delay(50);
    value = await read();
  }
  return value;
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    delay(1_500),
  ]);
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coordinatorAgentSource() {
  return `#!/usr/bin/env node
process.stdout.write("coord ready\\r\\n");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  process.stdout.write("coord working:" + text + "\\r\\n");
  setTimeout(() => process.stdout.write("coord done:" + text + "\\r\\n"), 150);
});
setInterval(() => {}, 1_000);
`;
}
